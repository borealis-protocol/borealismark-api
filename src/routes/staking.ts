import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { requireApiKey, requireScope } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { slashLimiter } from '../middleware/rateLimiter';
import { logger, auditLog } from '../middleware/logger';
import { allocateStake, getActiveStake, recordSlash } from '../db/database';
import { createHederaClient, submitSlashEventToHCS } from '../hedera/hcs';
import { emit } from '../engine/webhook-dispatcher';
import type { SlashEvent, StakeTier } from '../engine/types';
import type { AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// BMT → USDC coverage ratio: 1 BMT = 100 USDC coverage
const BMT_TO_USDC_RATIO = 100;

// Severity-based caps on slash amounts to prevent excessive slashing for minor violations
const SEVERITY_CAPS: Record<string, number> = {
  'RATE_LIMIT_VIOLATION': 0.10,
  'HALLUCINATION': 0.25,
  'SCOPE_CREEP': 0.25,
  'OUTPUT_POLICY_VIOLATION': 0.25,
  'PROMPT_INJECTION': 0.50,
  'BOUNDARY_BREACH': 0.50,
  'AUTHORIZATION_BYPASS': 0.75,
  'DATA_EXFILTRATION': 1.00,
};

// Stake amount → protection tier mapping
function getTier(bmtAmount: number): StakeTier {
  if (bmtAmount <= 0)          return 'NO_COVERAGE';
  if (bmtAmount < 5_000)       return 'STARTUP_SHIELD';
  if (bmtAmount < 25_000)      return 'STARTUP_SHIELD';
  if (bmtAmount < 100_000)     return 'GROWTH_VAULT';
  if (bmtAmount < 500_000)     return 'ENTERPRISE_FORTRESS';
  if (bmtAmount < 1_000_000)   return 'INSTITUTIONAL_CITADEL';
  return 'SOVEREIGN_RESERVE';
}

// ─── POST /v1/staking/allocate ────────────────────────────────────────────────

const AllocateSchema = z.object({
  agentId: z.string().min(1),
  bmtAmount: z.number().positive().max(1_000_000),
});

router.post('/allocate', requireApiKey, requireScope('audit'), validateBody(AllocateSchema), (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const { agentId, bmtAmount } = req.body as z.infer<typeof AllocateSchema>;

  const usdcCoverage = bmtAmount * BMT_TO_USDC_RATIO;
  const tier = getTier(bmtAmount);
  const stakeId = uuidv4();

  try {
    allocateStake(stakeId, agentId, bmtAmount, usdcCoverage, tier);

    auditLog('stake.allocated', authReq.apiKey.id, {
      stakeId, agentId, bmtAmount, usdcCoverage, tier,
      requestId: authReq.requestId,
    });

    // Fire webhook
    emit.stakeAllocated({ agentId, stakeId, bmtAmount, usdcCoverage, tier });

    res.status(201).json({
      success: true,
      data: {
        stakeId,
        agentId,
        bmtAmount,
        usdcCoverage,
        tier,
        ratio: `1 BMT = ${BMT_TO_USDC_RATIO} USDC`,
        allocatedAt: Date.now(),
      },
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error('Stake allocation error', { error: String(err), agentId, requestId: authReq.requestId });
    res.status(500).json({ success: false, error: 'Failed to allocate stake', timestamp: Date.now() });
  }
});

// ─── POST /v1/staking/slash ───────────────────────────────────────────────────

const SlashSchema = z.object({
  agentId: z.string().min(1),
  violationType: z.enum([
    'BOUNDARY_BREACH',
    'PROMPT_INJECTION',
    'DATA_EXFILTRATION',
    'SCOPE_CREEP',
    'HALLUCINATION',
    'AUTHORIZATION_BYPASS',
    'RATE_LIMIT_VIOLATION',
    'OUTPUT_POLICY_VIOLATION',
  ]),
  amountSlashed: z.number().positive(),
  claimantAddress: z.string().min(5),
});

router.post('/slash', requireApiKey, requireScope('audit'), slashLimiter, validateBody(SlashSchema), async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const { agentId, violationType, amountSlashed, claimantAddress } = req.body as z.infer<typeof SlashSchema>;

  // Validate claimant_address format (Hedera account: 0.0.XXXXX)
  const hederaAccountRegex = /^0\.0\.\d+$/;
  if (!hederaAccountRegex.test(claimantAddress)) {
    res.status(400).json({
      success: false,
      error: `Invalid claimant address format: "${claimantAddress}" should be "0.0.XXXXX" (shard.realm.account)`,
      timestamp: Date.now(),
    });
    return;
  }

  const stake = getActiveStake(agentId);
  if (!stake) {
    res.status(404).json({
      success: false,
      error: 'No active stake found for this agent',
      timestamp: Date.now(),
    });
    return;
  }

  const stakeAmount = stake.bmt_amount as number;
  if (amountSlashed > stakeAmount) {
    res.status(400).json({
      success: false,
      error: `Cannot slash ${amountSlashed} BMT — only ${stakeAmount} BMT staked`,
      timestamp: Date.now(),
    });
    return;
  }

  // Verify stake has sufficient balance remaining after slash
  const remainingBalance = stakeAmount - amountSlashed;
  if (remainingBalance < 0) {
    res.status(400).json({
      success: false,
      error: `Slash amount exceeds available balance. ${stakeAmount} BMT staked, cannot slash ${amountSlashed} BMT`,
      timestamp: Date.now(),
    });
    return;
  }

  // Cooldown: prevent multiple slashes within 24 hours on same agent
  // TODO: Query slash_events table for agent_id with executed_at > now - 24h
  // For now, this is documented but requires database query implementation

  // Enforce severity-based slash caps to prevent excessive penalties
  const maxSlashRatio = SEVERITY_CAPS[violationType] ?? 0.50;
  const maxSlashAmount = stakeAmount * maxSlashRatio;
  if (amountSlashed > maxSlashAmount) {
    res.status(400).json({
      success: false,
      error: `Slash amount exceeds severity cap. ${violationType} allows max ${(maxSlashRatio * 100)}% slash (${maxSlashAmount} BMT)`,
      timestamp: Date.now(),
    });
    return;
  }

  // Track total slashed: don't allow total slashed to exceed original stake amount
  // This prevents infinite slashing and ensures proportional penalties
  // TODO: Query slash_events table for agent_id and sum amount_slashed
  // Validate: sum(amount_slashed) + amountSlashed <= stakeAmount

  const slashId = uuidv4();
  let hcsTxId: string | undefined;

  // Submit slash event to Hedera if configured
  const accountId = process.env.HEDERA_ACCOUNT_ID;
  const privateKey = process.env.HEDERA_PRIVATE_KEY;
  const topicId = process.env.HEDERA_AUDIT_TOPIC_ID;

  if (accountId && privateKey && topicId) {
    try {
      const slashEvent: SlashEvent = {
        slashId,
        stakeId: stake.id as string,
        agentId,
        violationType: violationType as SlashEvent['violationType'],
        amountSlashed,
        claimantAddress,
        executedAt: Date.now(),
      };

      const networkEnv = process.env.HEDERA_NETWORK;
      if (!networkEnv || !['testnet', 'mainnet'].includes(networkEnv)) {
        throw new Error(`HEDERA_NETWORK must be 'testnet' or 'mainnet', got: ${networkEnv}`);
      }

      const hederaClient = await createHederaClient({
        accountId,
        privateKey,
        network: networkEnv as 'testnet' | 'mainnet',
      });

      const hcsResult = await submitSlashEventToHCS(hederaClient, topicId, slashEvent);
      hcsTxId = hcsResult.transactionId;

      logger.info('Slash event anchored on Hedera HCS', {
        slashId, agentId, hcsTransactionId: hcsTxId,
      });
    } catch (hcsErr) {
      logger.warn('Slash HCS submission failed', {
        error: String(hcsErr), slashId, agentId,
      });
    }
  }

  try {
    recordSlash(slashId, stake.id as string, agentId, violationType, amountSlashed, claimantAddress, hcsTxId);

    auditLog('slash.executed', authReq.apiKey.id, {
      slashId, agentId, violationType, amountSlashed, claimantAddress,
      hcsTransactionId: hcsTxId, requestId: authReq.requestId,
    });

    // Fire webhook
    emit.slashExecuted({
      agentId,
      slashId,
      violationType,
      amountSlashed,
      claimantAddress,
      hcsTransactionId: hcsTxId,
    });

    res.status(200).json({
      success: true,
      data: {
        slashId,
        agentId,
        violationType,
        amountSlashed,
        remainingStake: stakeAmount - amountSlashed,
        claimantAddress,
        hcsTransactionId: hcsTxId ?? null,
        executedAt: Date.now(),
        message: 'Slashing protocol executed. Stake redistributed to claimant.',
      },
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error('Slash execution error', { error: String(err), slashId, requestId: authReq.requestId });
    res.status(500).json({ success: false, error: 'Failed to execute slash', timestamp: Date.now() });
  }
});

// ─── GET /v1/staking/:agentId ─────────────────────────────────────────────────

router.get('/:agentId', requireApiKey, requireScope('read'), (req, res) => {
  const stake = getActiveStake(req.params.agentId);
  if (!stake) {
    res.status(404).json({
      success: false,
      error: 'No active stake for this agent',
      timestamp: Date.now(),
    });
    return;
  }

  res.json({
    success: true,
    data: {
      stakeId: stake.id,
      agentId: stake.agent_id,
      bmtAmount: stake.bmt_amount,
      usdcCoverage: stake.usdc_coverage,
      tier: stake.tier,
      allocatedAt: stake.allocated_at,
    },
    timestamp: Date.now(),
  });
});

export default router;
