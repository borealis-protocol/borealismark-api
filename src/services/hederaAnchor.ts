/**
 * BorealisMark - Hedera Event Anchoring Service
 *
 * Batches unanchored platform events and submits Merkle root hashes
 * to Hedera Consensus Service for immutable proof.
 *
 * Architecture:
 *   1. EventBus collects events - persisted to SQLite with anchored=0
 *   2. This service runs on a 15-minute interval
 *   3. Fetches unanchored events, computes a Merkle root of their hashes
 *   4. Submits the Merkle root to HCS data topic
 *   5. Marks events as anchored with the HCS transaction ID
 *
 * This ensures every significant platform action has an immutable
 * on-chain proof without incurring per-event Hedera fees.
 *
 * SAFETY RULES (instituted after March 2026 wallet drain incident):
 *   - emit() is intentionally NOT called anywhere in this file.
 *     Emitting events inside anchor functions creates a self-referencing
 *     loop: emit -> insertPlatformEvent (anchored=0) -> next interval picks
 *     it up -> anchors it -> emits again -> forever. This was burning 288+
 *     HCS transactions per day with zero users.
 *   - ALL HCS submissions check HBAR balance before proceeding.
 *     If balance drops below HBAR_MINIMUM_BALANCE, anchoring pauses.
 *   - A hard daily cap (MAX_DAILY_HCS_TX) prevents runaway loops even if
 *     another bug slips through in the future.
 *   - Interval raised from 5 min to 15 min to reduce baseline tx rate.
 */

import { createHash } from 'crypto';
import { logger } from '../middleware/logger';
import {
  getUnanchoredEvents,
  markEventsAnchored,
  incrementEventRetryCount,
  getFailedEventsForRetry,
} from '../db/database';

// NOTE: emit is intentionally NOT imported here. See SAFETY RULES above.

// Lazy-load Hedera SDK to avoid blocking server startup (SDK takes ~20s to load)
let _hederaLoaded = false;
let _TopicMessageSubmitTransaction: any;
let _TopicId: any;
let _AccountBalanceQuery: any;
let _AccountId: any;
let _createHederaClient: any;

async function loadHedera(): Promise<boolean> {
  if (_hederaLoaded) return true;
  try {
    const sdk = await import('@hashgraph/sdk');
    _TopicMessageSubmitTransaction = sdk.TopicMessageSubmitTransaction;
    _TopicId = sdk.TopicId;
    _AccountBalanceQuery = sdk.AccountBalanceQuery;
    _AccountId = sdk.AccountId;
    const hcs = await import('../hedera/hcs');
    _createHederaClient = hcs.createHederaClient;
    _hederaLoaded = true;
    logger.info('Hedera SDK loaded for event anchoring');
    return true;
  } catch (err: any) {
    logger.error('Failed to load Hedera SDK', { error: err.message });
    return false;
  }
}

// ─── Config ──────────────────────────────────────────────────────────────────

const ANCHOR_BATCH_SIZE = 200;

// Raised from 5 min to 15 min - reduces baseline HCS tx rate by 3x.
const ANCHOR_INTERVAL_MS = 15 * 60 * 1000;

// Pause anchoring if HBAR balance drops below this threshold (in HBAR).
// At ~0.0001 HBAR per HCS submit, 5 HBAR = ~50,000 transactions of runway.
const HBAR_MINIMUM_BALANCE = 5;

// Hard cap: abort all HCS submissions if this daily limit is hit.
// Prevents any future runaway loop from draining the wallet in a single day.
const MAX_DAILY_HCS_TX = 500;

let anchorInterval: NodeJS.Timeout | null = null;

// ─── Daily Transaction Cap ────────────────────────────────────────────────────

let _dailyTxCount = 0;
let _dailyTxDate = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

function resetDailyCounterIfNeeded(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _dailyTxDate) {
    logger.info('Hedera daily HCS tx counter reset', {
      previousCount: _dailyTxCount,
      previousDate: _dailyTxDate,
      newDate: today,
    });
    _dailyTxDate = today;
    _dailyTxCount = 0;
  }
}

function isDailyCapExceeded(): boolean {
  resetDailyCounterIfNeeded();
  if (_dailyTxCount >= MAX_DAILY_HCS_TX) {
    logger.warn('Hedera daily HCS tx cap exceeded - anchoring paused until midnight', {
      count: _dailyTxCount,
      cap: MAX_DAILY_HCS_TX,
      date: _dailyTxDate,
    });
    return true;
  }
  return false;
}

function incrementDailyTxCount(): void {
  _dailyTxCount++;
}

// Exported for health endpoint and tests
export function getDailyTxStats(): { count: number; cap: number; date: string } {
  resetDailyCounterIfNeeded();
  return { count: _dailyTxCount, cap: MAX_DAILY_HCS_TX, date: _dailyTxDate };
}

// ─── HBAR Balance Guard ───────────────────────────────────────────────────────

/**
 * Check the HBAR balance of the gas wallet.
 * Returns the balance in HBAR, or null if the check fails.
 * A failed check is treated as "balance sufficient" (fail-open)
 * to avoid blocking legitimate anchoring due to transient network issues.
 */
async function getHbarBalance(
  accountId: string,
  config: { accountId: string; privateKey: string; network: 'testnet' | 'mainnet' },
): Promise<number | null> {
  try {
    const client = await _createHederaClient(config);
    const balance = await new _AccountBalanceQuery()
      .setAccountId(_AccountId.fromString(accountId))
      .execute(client);
    client.close();
    // Hbar.toBigNumber() returns the HBAR value (not tinybars)
    return balance.hbars.toBigNumber().toNumber();
  } catch (err: any) {
    logger.error('HBAR balance check failed', { accountId, error: err.message });
    return null;
  }
}

async function isBalanceSufficient(
  accountId: string,
  privateKey: string,
  network: 'testnet' | 'mainnet',
): Promise<boolean> {
  const balance = await getHbarBalance(accountId, { accountId, privateKey, network });
  if (balance === null) {
    // Check failed due to SDK/network error - do not block anchoring
    return true;
  }
  if (balance < HBAR_MINIMUM_BALANCE) {
    logger.warn('HBAR balance below minimum threshold - anchoring paused', {
      balanceHbar: balance,
      minimumHbar: HBAR_MINIMUM_BALANCE,
      accountId,
      action: 'Fund the gas wallet to resume HCS anchoring',
    });
    return false;
  }
  return true;
}

// ─── Merkle Root Computation ─────────────────────────────────────────────────

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compute a simple Merkle root from an array of event hashes.
 * For small batches (<200), this is efficient enough.
 */
function computeMerkleRoot(events: Record<string, any>[]): string {
  if (events.length === 0) return sha256('empty');

  // Leaf hashes: SHA256 of each event's core data
  let hashes = events.map(e =>
    sha256(`${e.id}|${e.event_type}|${e.category}|${e.actor_id ?? ''}|${e.target_id ?? ''}|${e.created_at}`)
  );

  // Build the tree
  while (hashes.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < hashes.length; i += 2) {
      if (i + 1 < hashes.length) {
        nextLevel.push(sha256(hashes[i] + hashes[i + 1]));
      } else {
        // Odd number: promote the last hash
        nextLevel.push(hashes[i]);
      }
    }
    hashes = nextLevel;
  }

  return hashes[0];
}

// ─── Anchor Batch ─────────────────────────────────────────────────────────────

export async function anchorEventBatch(): Promise<{
  anchored: number;
  merkleRoot: string | null;
  hcsTxId: string | null;
}> {
  // Safety guard 1: daily cap
  if (isDailyCapExceeded()) {
    return { anchored: 0, merkleRoot: null, hcsTxId: null };
  }

  const events = getUnanchoredEvents(ANCHOR_BATCH_SIZE);
  if (events.length === 0) {
    return { anchored: 0, merkleRoot: null, hcsTxId: null };
  }

  const merkleRoot = computeMerkleRoot(events);
  const eventIds = events.map(e => e.id);

  // Use Gas wallet for HCS anchoring (falls back to legacy account)
  const accountId = process.env.HEDERA_GAS_ACCOUNT_ID ?? process.env.HEDERA_ACCOUNT_ID;
  const privateKey = process.env.HEDERA_GAS_PRIVATE_KEY ?? process.env.HEDERA_PRIVATE_KEY;
  const dataTopicId = process.env.HEDERA_DATA_TOPIC_ID ?? process.env.HEDERA_AUDIT_TOPIC_ID;

  if (!accountId || !privateKey || !dataTopicId) {
    // Hedera not configured - mark events as anchored locally with a local reference
    const localTxId = `local:${Date.now()}:${merkleRoot.slice(0, 16)}`;
    markEventsAnchored(eventIds, localTxId);

    logger.info('Events anchored locally (Hedera not configured)', {
      count: events.length,
      merkleRoot,
      localTxId,
    });

    return { anchored: events.length, merkleRoot, hcsTxId: localTxId };
  }

  try {
    // Lazy-load Hedera SDK
    const loaded = await loadHedera();
    if (!loaded) {
      const fallbackTxId = `sdk-unavailable:${Date.now()}:${merkleRoot.slice(0, 16)}`;
      markEventsAnchored(eventIds, fallbackTxId);
      return { anchored: events.length, merkleRoot, hcsTxId: null };
    }

    const networkEnv = process.env.HEDERA_NETWORK;
    if (!networkEnv || !['testnet', 'mainnet'].includes(networkEnv)) {
      throw new Error(`HEDERA_NETWORK must be 'testnet' or 'mainnet', got: ${networkEnv}`);
    }

    // Safety guard 2: balance check before spending HBAR
    const sufficient = await isBalanceSufficient(accountId, privateKey, networkEnv as 'testnet' | 'mainnet');
    if (!sufficient) {
      return { anchored: 0, merkleRoot: null, hcsTxId: null };
    }

    const config = {
      accountId,
      privateKey,
      network: networkEnv as 'testnet' | 'mainnet',
    };

    const client = await _createHederaClient(config);

    // Submit Merkle root to HCS
    const message = JSON.stringify({
      protocol: 'BorealisMark/1.0',
      type: 'DATA_ANCHOR',
      merkleRoot,
      eventCount: events.length,
      firstEventId: eventIds[0],
      lastEventId: eventIds[eventIds.length - 1],
      categories: [...new Set(events.map(e => e.category))],
      timestamp: Date.now(),
    });

    const tx = await new _TopicMessageSubmitTransaction()
      .setTopicId(_TopicId.fromString(dataTopicId))
      .setMessage(message)
      .execute(client);

    const receipt = await tx.getReceipt(client);
    const hcsTxId = tx.transactionId?.toString() ?? `hcs:${Date.now()}`;

    // Mark all events as anchored
    markEventsAnchored(eventIds, hcsTxId);
    incrementDailyTxCount();

    // CRITICAL: Do NOT call emit() here. Emitting an ANCHOR_BATCH_COMPLETED
    // event after a successful HCS submission inserts a new platform_events
    // row with anchored=0. The next scheduled run picks it up, submits it to
    // HCS, emits another event, and the cycle repeats indefinitely.
    // This was the root cause of the March 2026 wallet drain (288+ HCS tx/day
    // with zero active users). The logger.info below is sufficient.

    logger.info('Events anchored to Hedera', {
      count: events.length,
      merkleRoot,
      hcsTxId,
      topicId: dataTopicId,
      dailyTxCount: _dailyTxCount,
    });

    client.close();

    return { anchored: events.length, merkleRoot, hcsTxId };
  } catch (err: any) {
    logger.error('Hedera anchoring failed', {
      error: err.message,
      eventCount: events.length,
      merkleRoot,
    });

    // Increment retry count for each event so we can track retry attempts
    // Events will be picked up again by retryFailedAnchoring() when backoff delay has passed
    for (const eventId of eventIds) {
      incrementEventRetryCount(eventId);
    }

    return { anchored: 0, merkleRoot, hcsTxId: null };
  }
}

// ─── HCS Retry Queue ──────────────────────────────────────────────────────────

const MAX_RETRY_ATTEMPTS = 5;
let retryInterval: NodeJS.Timeout | null = null;

/**
 * Retry failed HCS submissions with exponential backoff.
 * Delay = min(2^retry_count * 1000, 60000) ms
 * Max 5 retry attempts per event.
 */
export async function retryFailedAnchoring(): Promise<{
  retried: number;
  succeeded: number;
  stillFailed: number;
}> {
  // Safety guard 1: daily cap
  if (isDailyCapExceeded()) {
    return { retried: 0, succeeded: 0, stillFailed: 0 };
  }

  const failedEvents = getFailedEventsForRetry(MAX_RETRY_ATTEMPTS);
  if (failedEvents.length === 0) {
    return { retried: 0, succeeded: 0, stillFailed: 0 };
  }

  let succeeded = 0;
  let stillFailed = 0;

  const merkleRoot = computeMerkleRoot(failedEvents);
  const eventIds = failedEvents.map(e => e.id);

  // Use Gas wallet for HCS anchoring (falls back to legacy account)
  const accountId = process.env.HEDERA_GAS_ACCOUNT_ID ?? process.env.HEDERA_ACCOUNT_ID;
  const privateKey = process.env.HEDERA_GAS_PRIVATE_KEY ?? process.env.HEDERA_PRIVATE_KEY;
  const dataTopicId = process.env.HEDERA_DATA_TOPIC_ID ?? process.env.HEDERA_AUDIT_TOPIC_ID;

  if (!accountId || !privateKey || !dataTopicId) {
    logger.warn('HCS retry skipped - Hedera not configured', { eventCount: failedEvents.length });
    return { retried: failedEvents.length, succeeded: 0, stillFailed: failedEvents.length };
  }

  try {
    const loaded = await loadHedera();
    if (!loaded) {
      logger.warn('Hedera SDK unavailable for retry', { eventCount: failedEvents.length });
      return { retried: failedEvents.length, succeeded: 0, stillFailed: failedEvents.length };
    }

    const networkEnv = process.env.HEDERA_NETWORK;
    if (!networkEnv || !['testnet', 'mainnet'].includes(networkEnv)) {
      throw new Error(`HEDERA_NETWORK must be 'testnet' or 'mainnet', got: ${networkEnv}`);
    }

    // Safety guard 2: balance check before retrying
    const sufficient = await isBalanceSufficient(accountId, privateKey, networkEnv as 'testnet' | 'mainnet');
    if (!sufficient) {
      return { retried: 0, succeeded: 0, stillFailed: failedEvents.length };
    }

    const config = {
      accountId,
      privateKey,
      network: networkEnv as 'testnet' | 'mainnet',
    };

    const client = await _createHederaClient(config);

    const message = JSON.stringify({
      protocol: 'BorealisMark/1.0',
      type: 'DATA_ANCHOR_RETRY',
      merkleRoot,
      eventCount: failedEvents.length,
      retryAttempt: 1,
      timestamp: Date.now(),
    });

    const tx = await new _TopicMessageSubmitTransaction()
      .setTopicId(_TopicId.fromString(dataTopicId))
      .setMessage(message)
      .execute(client);

    const receipt = await tx.getReceipt(client);
    const hcsTxId = tx.transactionId?.toString() ?? `hcs:${Date.now()}`;

    // Mark all events as anchored
    markEventsAnchored(eventIds, hcsTxId);
    succeeded = failedEvents.length;
    incrementDailyTxCount();

    logger.info('Retry batch anchored to Hedera', {
      count: failedEvents.length,
      merkleRoot,
      hcsTxId,
      topicId: dataTopicId,
      dailyTxCount: _dailyTxCount,
    });

    client.close();
  } catch (err: any) {
    logger.error('HCS retry batch failed', {
      error: err.message,
      eventCount: failedEvents.length,
      merkleRoot,
    });
    stillFailed = failedEvents.length;
  }

  return { retried: failedEvents.length, succeeded, stillFailed };
}

// ─── Scheduled Anchoring ──────────────────────────────────────────────────────

export function startAnchoringSchedule(): void {
  // Run once on startup after a short delay, then every 15 minutes
  setTimeout(() => anchorEventBatch().catch(err =>
    logger.error('Initial anchor batch failed', { error: err.message })
  ), 10_000); // 10s delay on startup

  anchorInterval = setInterval(async () => {
    try {
      const result = await anchorEventBatch();
      if (result.anchored > 0) {
        logger.info('Scheduled anchor batch complete', result);
      }
    } catch (err: any) {
      logger.error('Scheduled anchoring error', { error: err.message });
    }
  }, ANCHOR_INTERVAL_MS);

  // Retry failed submissions every 30 seconds
  retryInterval = setInterval(async () => {
    try {
      const result = await retryFailedAnchoring();
      if (result.retried > 0) {
        logger.info('Retry batch processed', result);
      }
    } catch (err: any) {
      logger.error('Retry batch error', { error: err.message });
    }
  }, 30 * 1000); // 30 seconds

  logger.info('Hedera anchoring schedule started', {
    anchorIntervalMs: ANCHOR_INTERVAL_MS,
    retryIntervalMs: 30000,
    maxDailyTx: MAX_DAILY_HCS_TX,
    hbarMinimumBalance: HBAR_MINIMUM_BALANCE,
  });
}

export function stopAnchoringSchedule(): void {
  if (anchorInterval) {
    clearInterval(anchorInterval);
    anchorInterval = null;
  }
  if (retryInterval) {
    clearInterval(retryInterval);
    retryInterval = null;
  }
  logger.info('Hedera anchoring schedule stopped');
}
