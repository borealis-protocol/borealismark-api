/**
 * BorealisMark — Telemetry Scoring Pipeline
 *
 * Orchestrates the full flow:
 *   1. Validate payload (Zod)
 *   2. Transform to scoring engine input
 *   3. Compute BM Score via existing engine (zero changes)
 *   4. Apply trust ceiling based on reportingMode
 *   5. Run statistical anomaly detection (Layer 2)
 *   6. Persist to license_score_history
 *   7. Anchor to Hedera HCS Data Topic
 *   8. Return BTS score + credit rating + Hedera TX ID
 *
 * This module is the single entry point for telemetry processing.
 * The licenses route calls `processTelemetry()` and returns the result.
 */

import { createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/database';
import { logger } from '../middleware/logger';
import {
  TelemetryPayloadSchema,
  transformToScoringInput,
  detectSuspiciousPatterns,
  applyTrustCeiling,
  TRUST_CEILING,
  FREE_TIER_CEILING,
  type TelemetryPayload,
  type SuspicionFlags,
} from './telemetry-validator';
import {
  computeScoreBreakdown,
  getCreditRating,
} from './scoring';
import type { ScoreBreakdown, CreditRating } from './types';

// ─── Result Types ────────────────────────────────────────────────────────────

export interface TelemetryResult {
  success: true;
  scoreId: string;
  licenseId: string;
  agentId: string;
  btsScore: {
    total: number;
    display: number;           // 0-100 scale
    rawTotal: number;          // Before trust ceiling
    creditRating: CreditRating;
    breakdown: ScoreBreakdown;
    trustCeiling: number;
    reportingMode: string;
    licenseTier: string;
  };
  suspicionFlags: SuspicionFlags;
  hedera: {
    topicId: string | null;
    transactionId: string | null;
    sequenceNumber: number | null;
    consensusTimestamp: string | null;
  } | null;
  batchId: string;
  computedAt: number;
}

export interface TelemetryError {
  success: false;
  error: string;
  details?: Record<string, any>;
}

// ─── Score Anchoring to HCS ──────────────────────────────────────────────────

async function anchorScoreToHCS(
  scoreId: string,
  agentId: string,
  score: number,
  creditRating: CreditRating,
  batchHash: string,
  reportingMode: string,
): Promise<{
  topicId: string;
  transactionId: string;
  sequenceNumber: number;
  consensusTimestamp: string;
} | null> {
  const accountId = process.env.HEDERA_GAS_ACCOUNT_ID ?? process.env.HEDERA_ACCOUNT_ID;
  const privateKey = process.env.HEDERA_GAS_PRIVATE_KEY ?? process.env.HEDERA_PRIVATE_KEY;
  const dataTopicId = process.env.HEDERA_DATA_TOPIC_ID;
  const network = process.env.HEDERA_NETWORK;

  if (!accountId || !privateKey || !dataTopicId || !network) {
    logger.warn('Hedera not configured — score anchoring skipped', { scoreId });
    return null;
  }

  try {
    const { createHederaClient } = await import('../hedera/hcs');
    const { TopicMessageSubmitTransaction, TopicId, AccountBalanceQuery, AccountId } = await import('@hashgraph/sdk');

    const client = await createHederaClient({
      accountId,
      privateKey,
      network: network as 'testnet' | 'mainnet',
    });

    try {
      // Balance check before spending HBAR (fail-closed)
      const balance = await new AccountBalanceQuery()
        .setAccountId(AccountId.fromString(accountId))
        .execute(client);
      const hbarBalance = balance.hbars.toBigNumber().toNumber();
      if (hbarBalance < 5) {
        logger.warn('HBAR balance too low for score anchoring - skipping', {
          scoreId, balanceHbar: hbarBalance,
        });
        return null;
      }

      const message = JSON.stringify({
        protocol: 'BorealisMark/1.0',
        type: 'BTS_SCORE',
        scoreId,
        agentId,
        score,
        creditRating,
        batchHash,
        reportingMode,
        timestamp: Date.now(),
      });

      // Message size guard (HCS limit: 1024 bytes)
      const messageBytes = Buffer.byteLength(message, 'utf8');
      if (messageBytes > 1024) {
        logger.warn('HCS message exceeds 1KB limit - skipping anchoring', {
          scoreId, messageBytes,
        });
        return null;
      }

      const tx = await new TopicMessageSubmitTransaction()
        .setTopicId(TopicId.fromString(dataTopicId))
        .setMessage(message)
        .execute(client);

      const receipt = await tx.getReceipt(client);
      const record = await tx.getRecord(client);

      return {
        topicId: dataTopicId,
        transactionId: tx.transactionId.toString(),
        sequenceNumber: receipt.topicSequenceNumber?.toNumber() ?? 0,
        consensusTimestamp: record.consensusTimestamp?.toDate().toISOString() ?? null,
      };
    } finally {
      client.close();
    }
  } catch (err: any) {
    logger.error('HCS score anchoring failed', { scoreId, error: err.message });
    return null;
  }
}

// ─── Duplicate Batch Detection ───────────────────────────────────────────────

function isDuplicateBatch(licenseId: string, batchId: string): boolean {
  const db = getDb();
  const existing = db.prepare(
    'SELECT id FROM license_score_history WHERE license_id = ? AND batch_id = ?'
  ).get(licenseId, batchId) as any;
  return !!existing;
}

// ─── Main Pipeline ───────────────────────────────────────────────────────────

export async function processTelemetry(
  rawPayload: unknown,
  licenseId: string,
  agentId: string,
  licenseStatus: string,
): Promise<TelemetryResult | TelemetryError> {
  // Step 1: Zod validation
  const parsed = TelemetryPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return {
      success: false,
      error: 'TELEMETRY_VALIDATION_FAILED',
      details: parsed.error.flatten(),
    };
  }

  const payload = parsed.data;

  // Step 1.5: Duplicate batch detection
  if (isDuplicateBatch(licenseId, payload.batchId)) {
    return {
      success: false,
      error: 'DUPLICATE_BATCH',
      details: { batchId: payload.batchId, message: 'This batch has already been processed' },
    };
  }

  // Step 2: Transform to scoring engine input
  const scoringInput = transformToScoringInput(payload);

  // Step 3: Compute BM Score via existing engine (ZERO changes to scoring.ts)
  const breakdown = computeScoreBreakdown(
    scoringInput.constraints,
    scoringInput.decisions,
    scoringInput.behaviorSamples,
    scoringInput.totalActions,
    scoringInput.anomalyCount,
    scoringInput.expectedLogEntries,
    scoringInput.actualLogEntries,
  );

  const rawTotal = breakdown.total;

  // Step 4: Apply trust ceiling (tier-based + reporting mode)
  // Free-tier keys are hard-capped at 650 (BTS 65) regardless of reporting mode
  const licenseRow = getDb().prepare('SELECT license_tier FROM merlin_licenses WHERE id = ?').get(licenseId) as any;
  const licenseTier: string = licenseRow?.license_tier ?? 'pro';
  const cappedTotal = applyTrustCeiling(rawTotal, payload.reportingMode, licenseTier);
  const creditRating = getCreditRating(cappedTotal);
  const display = Math.round(cappedTotal / 10); // 0-100 display scale

  // Step 5: Statistical anomaly detection (Layer 2)
  const suspicionFlags = detectSuspiciousPatterns(payload);

  // Check if suspiciously perfect with self-reported data
  if (payload.reportingMode === 'self-reported' && rawTotal >= 950) {
    suspicionFlags.suspiciouslyPerfect = true;
    suspicionFlags.flagCount++;
  }

  // Step 6: Persist to license_score_history
  const scoreId = uuid();
  const now = Date.now();
  const payloadHash = createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');

  const db = getDb();

  try {
    db.prepare(`
      INSERT INTO license_score_history (
        id, license_id, agent_id, score_total, score_display,
        credit_rating, score_breakdown, license_status_at_scoring,
        computed_at, batch_id, reporting_mode, payload_hash,
        suspicion_flags, raw_score_total, sequence_start, sequence_end
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scoreId,
      licenseId,
      agentId,
      cappedTotal,
      display,
      creditRating,
      JSON.stringify(breakdown),
      licenseStatus,
      now,
      payload.batchId,
      payload.reportingMode,
      payloadHash,
      JSON.stringify(suspicionFlags),
      rawTotal,
      payload.sequenceStart,
      payload.sequenceEnd,
    );
  } catch (dbErr: any) {
    logger.error('Failed to persist score', { scoreId, error: dbErr.message });
    return {
      success: false,
      error: 'SCORE_PERSISTENCE_FAILED',
      details: { message: dbErr.message },
    };
  }

  // Step 7: Anchor to Hedera HCS
  const hedera = await anchorScoreToHCS(
    scoreId,
    agentId,
    cappedTotal,
    creditRating,
    payload.evidence.batchHash,
    payload.reportingMode,
  );

  // Update score record with Hedera proof if available
  if (hedera) {
    try {
      db.prepare(`
        UPDATE license_score_history
        SET hcs_topic_id = ?, hcs_transaction_id = ?,
            hcs_sequence_number = ?, hcs_consensus_timestamp = ?
        WHERE id = ?
      `).run(
        hedera.topicId,
        hedera.transactionId,
        hedera.sequenceNumber,
        hedera.consensusTimestamp,
        scoreId,
      );
    } catch (hcsUpdateErr: any) {
      logger.error('Failed to update HCS proof on score', { scoreId, error: hcsUpdateErr.message });
      // Non-fatal — score is still persisted
    }
  }

  // Update license last_audit_at
  db.prepare('UPDATE merlin_licenses SET last_audit_at = ? WHERE id = ?').run(now, licenseId);

  // Step 7.5: Sync BTS score to agents table + publish to public registry.
  // When an agent submits telemetry and receives a verified score, it earns
  // its place in the public trust registry automatically. This is the bridge
  // between the BTS license pipeline and the BorealisMark public search.
  try {
    db.prepare(
      `UPDATE agents
       SET bts_score = ?, bts_credit_rating = ?, public_listing = 1
       WHERE id = ?`
    ).run(cappedTotal, creditRating, agentId);
    logger.info('Agent synced to public registry', { agentId, btsScore: cappedTotal, creditRating });
  } catch (syncErr: any) {
    // Non-fatal — score pipeline succeeded, registry sync failed
    logger.warn('Failed to sync agent to public registry', { agentId, error: syncErr.message });
  }

  logger.info('Telemetry processed', {
    scoreId,
    licenseId,
    agentId,
    score: cappedTotal,
    display,
    creditRating,
    reportingMode: payload.reportingMode,
    flagCount: suspicionFlags.flagCount,
    hcsAnchored: !!hedera,
  });

  // Step 8: Return result
  return {
    success: true,
    scoreId,
    licenseId,
    agentId,
    btsScore: {
      total: cappedTotal,
      display,
      rawTotal,
      creditRating,
      breakdown,
      trustCeiling: licenseTier === 'free' ? FREE_TIER_CEILING : TRUST_CEILING[payload.reportingMode],
      reportingMode: payload.reportingMode,
      licenseTier,
    },
    suspicionFlags,
    hedera,
    batchId: payload.batchId,
    computedAt: now,
  };
}
