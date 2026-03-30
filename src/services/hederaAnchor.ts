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
  getHcsDailyTxCount,
  incrementHcsDailyTxCount,
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

// ACTUAL COST: ~0.01 HBAR per HCS submit (network fee) + ~0.94 HBAR node fees
// = ~0.95 HBAR total per transaction on mainnet. Previous comment said 0.0001 -
// that was wrong by ~10,000x and caused the wallet to drain from 84 to 8 HBAR.
// At 0.95 HBAR/tx, 20 HBAR gives ~21 transactions of runway.
const HBAR_MINIMUM_BALANCE = 20;

// Hard cap: reduced from 500 to 10. With ~0.95 HBAR per tx, 500 tx/day would
// burn ~475 HBAR/day. 10 tx/day = ~9.5 HBAR/day max, which is manageable.
const MAX_DAILY_HCS_TX = 10;

// MINIMUM BATCH SIZE: Don't waste HBAR anchoring 1-2 trivial events.
// Only submit to HCS when we have enough events to justify the ~0.95 HBAR cost.
const MIN_BATCH_SIZE = 10;

// EVENT CATEGORIES WORTH ANCHORING: Only these categories get written to Hedera.
// Routine events (auth, system, health) are NOT worth blockchain proof.
// They get marked as locally anchored so they don't pile up forever.
const ANCHORABLE_CATEGORIES = new Set([
  'audit',        // Trust score audits
  'score',        // BTS score computations
  'certificate',  // Audit certificates issued
  'penalty',      // Trust deposit penalties
  'license',      // License activation/revocation (identity events)
  'agent',        // Agent registration/termination (identity events)
]);

// ─── MASTER SWITCH: Automatic anchoring is DISABLED until first real BTS key ─
// Simon directive: "we don't even have BTS keys active - that is when we should
// start the pings. right now we are still in building phase."
//
// Set this to true when the first real external BTS key is activated.
// Or set env var HEDERA_ANCHORING_ENABLED=true on Render to enable remotely.
const ANCHORING_ENABLED = process.env.HEDERA_ANCHORING_ENABLED === 'true';

let anchorInterval: NodeJS.Timeout | null = null;

// ─── Daily Transaction Cap (SQLite-persisted, survives restarts) ──────────────

function isDailyCapExceeded(): boolean {
  const count = getHcsDailyTxCount();
  if (count >= MAX_DAILY_HCS_TX) {
    logger.warn('Hedera daily HCS tx cap exceeded - anchoring paused until midnight', {
      count,
      cap: MAX_DAILY_HCS_TX,
      date: new Date().toISOString().slice(0, 10),
    });
    return true;
  }
  return false;
}

// Exported for health endpoint and tests
export function getDailyTxStats(): { count: number; cap: number; date: string } {
  return { count: getHcsDailyTxCount(), cap: MAX_DAILY_HCS_TX, date: new Date().toISOString().slice(0, 10) };
}

// ─── HBAR Balance Guard ───────────────────────────────────────────────────────

/**
 * Check the HBAR balance of the gas wallet.
 * Returns the balance in HBAR, or null if the check fails.
 *
 * SAFETY: Fail-CLOSED policy. If the balance check fails (SDK error,
 * network timeout), we return false to prevent spending HBAR we can't
 * verify we have. The daily cap provides a backstop, but fail-closed
 * is the correct default for financial operations.
 *
 * Consecutive failures are tracked. After 3 consecutive balance check
 * failures, we allow one anchoring attempt through (fail-open) to avoid
 * permanent deadlock when Hedera mirror nodes are degraded but consensus
 * nodes are healthy. The counter resets on any successful check.
 */
let _consecutiveBalanceFailures = 0;
const MAX_CONSECUTIVE_BALANCE_FAILURES = 3;

async function getHbarBalance(
  accountId: string,
  config: { accountId: string; privateKey: string; network: 'testnet' | 'mainnet' },
): Promise<number | null> {
  try {
    const client = await _createHederaClient(config);
    try {
      const balance = await new _AccountBalanceQuery()
        .setAccountId(_AccountId.fromString(accountId))
        .execute(client);
      // Hbar.toBigNumber() returns the HBAR value (not tinybars)
      _consecutiveBalanceFailures = 0; // Reset on success
      return balance.hbars.toBigNumber().toNumber();
    } finally {
      client.close();
    }
  } catch (err: any) {
    _consecutiveBalanceFailures++;
    logger.error('HBAR balance check failed', {
      accountId,
      error: err.message,
      consecutiveFailures: _consecutiveBalanceFailures,
    });
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
    // Fail-closed: block anchoring when balance is unknown.
    // Exception: after MAX_CONSECUTIVE_BALANCE_FAILURES, allow one attempt
    // through to prevent permanent deadlock during mirror node outages.
    if (_consecutiveBalanceFailures >= MAX_CONSECUTIVE_BALANCE_FAILURES) {
      logger.warn('Balance check failed repeatedly - allowing one anchoring attempt to prevent deadlock', {
        consecutiveFailures: _consecutiveBalanceFailures,
        maxBeforeOverride: MAX_CONSECUTIVE_BALANCE_FAILURES,
      });
      return true;
    }
    logger.warn('HBAR balance unknown - anchoring paused (fail-closed policy)', {
      accountId,
      consecutiveFailures: _consecutiveBalanceFailures,
      action: 'Will retry next interval. Override after ' + MAX_CONSECUTIVE_BALANCE_FAILURES + ' consecutive failures.',
    });
    return false;
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

// Re-entrancy guard for anchorEventBatch(). If this flag is already set when
// the function is entered, emit() was called inside an anchoring operation,
// recreating the HCS loop that caused the March 2026 wallet drain.
// emit() is intentionally not imported in this module (see NOTE at line 39),
// but this guard catches any future regression where that import is added.
let _anchoringInProgress = false;

export async function anchorEventBatch(): Promise<{
  anchored: number;
  merkleRoot: string | null;
  hcsTxId: string | null;
}> {
  // Invariant: anchorEventBatch() must never be called re-entrantly. If this
  // fires, the event bus was triggered inside an anchoring call - abort to
  // prevent a runaway HCS transaction loop draining the gas wallet.
  if (_anchoringInProgress) {
    logger.error('INVARIANT VIOLATION: anchorEventBatch() re-entered - aborting to prevent HCS loop', {
      cause: 'emit() must not be called inside anchorEventBatch() or its callees',
    });
    return { anchored: 0, merkleRoot: null, hcsTxId: null };
  }
  _anchoringInProgress = true;
  try {
  // Safety guard 0: MASTER SWITCH - anchoring disabled until first real BTS key
  if (!ANCHORING_ENABLED) {
    // Mark all unanchored events as locally handled so they don't pile up
    const pendingEvents = getUnanchoredEvents(ANCHOR_BATCH_SIZE);
    if (pendingEvents.length > 0) {
      const ids = pendingEvents.map(e => e.id);
      markEventsAnchored(ids, `disabled:${Date.now()}`);
      logger.debug('Anchoring disabled - marked events as locally handled', { count: pendingEvents.length });
    }
    return { anchored: 0, merkleRoot: null, hcsTxId: null };
  }

  // Safety guard 1: daily cap
  if (isDailyCapExceeded()) {
    return { anchored: 0, merkleRoot: null, hcsTxId: null };
  }

  const allEvents = getUnanchoredEvents(ANCHOR_BATCH_SIZE);
  if (allEvents.length === 0) {
    return { anchored: 0, merkleRoot: null, hcsTxId: null };
  }

  // Safety guard: Category filter - only anchor events worth blockchain proof
  const anchorableEvents = allEvents.filter(e => ANCHORABLE_CATEGORIES.has(e.category));
  const noiseEvents = allEvents.filter(e => !ANCHORABLE_CATEGORIES.has(e.category));

  // Mark noise events as locally anchored so they don't accumulate
  if (noiseEvents.length > 0) {
    const noiseIds = noiseEvents.map(e => e.id);
    markEventsAnchored(noiseIds, `local-noise:${Date.now()}`);
    logger.debug('Noise events marked locally (not worth HCS cost)', {
      count: noiseEvents.length,
      categories: [...new Set(noiseEvents.map(e => e.category))],
    });
  }

  // Nothing worth anchoring on-chain
  if (anchorableEvents.length === 0) {
    return { anchored: noiseEvents.length, merkleRoot: null, hcsTxId: null };
  }

  // Safety guard: Minimum batch size - don't burn ~0.95 HBAR for a handful of events
  if (anchorableEvents.length < MIN_BATCH_SIZE) {
    logger.debug('Anchorable events below minimum batch size - deferring to next interval', {
      count: anchorableEvents.length,
      minBatchSize: MIN_BATCH_SIZE,
    });
    return { anchored: noiseEvents.length, merkleRoot: null, hcsTxId: null };
  }

  const events = anchorableEvents;
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
      categories: [...new Set(events.map(e => e.category))].slice(0, 20), // Cap categories to prevent oversized messages
      timestamp: Date.now(),
    });

    // HCS message size guard (limit: 1024 bytes)
    const messageBytes = Buffer.byteLength(message, 'utf8');
    if (messageBytes > 1024) {
      logger.error('HCS DATA_ANCHOR message exceeds 1KB limit - stripping categories', {
        messageBytes,
        eventCount: events.length,
        categoryCount: [...new Set(events.map(e => e.category))].length,
      });
      // Fallback: strip categories to stay under limit
      const fallbackMessage = JSON.stringify({
        protocol: 'BorealisMark/1.0',
        type: 'DATA_ANCHOR',
        merkleRoot,
        eventCount: events.length,
        firstEventId: eventIds[0],
        lastEventId: eventIds[eventIds.length - 1],
        timestamp: Date.now(),
      });
      if (Buffer.byteLength(fallbackMessage, 'utf8') > 1024) {
        logger.error('HCS message still exceeds limit after fallback - aborting', { messageBytes: Buffer.byteLength(fallbackMessage, 'utf8') });
        return { anchored: 0, merkleRoot, hcsTxId: null };
      }
    }

    const tx = await new _TopicMessageSubmitTransaction()
      .setTopicId(_TopicId.fromString(dataTopicId))
      .setMessage(message)
      .execute(client);

    const receipt = await tx.getReceipt(client);
    const hcsTxId = tx.transactionId?.toString() ?? `hcs:${Date.now()}`;

    // Mark all events as anchored
    markEventsAnchored(eventIds, hcsTxId);
    incrementHcsDailyTxCount();

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
      dailyTxCount: getHcsDailyTxCount(),
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
  } finally {
    _anchoringInProgress = false;
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
  // Master switch: no Hedera calls during building phase
  if (!ANCHORING_ENABLED) {
    return { retried: 0, succeeded: 0, stillFailed: 0 };
  }

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
    incrementHcsDailyTxCount();

    logger.info('Retry batch anchored to Hedera', {
      count: failedEvents.length,
      merkleRoot,
      hcsTxId,
      topicId: dataTopicId,
      dailyTxCount: getHcsDailyTxCount(),
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
  if (!ANCHORING_ENABLED) {
    logger.info('Hedera anchoring is DISABLED (building phase - no active BTS keys). Set HEDERA_ANCHORING_ENABLED=true to activate.', {
      reason: 'No external BTS keys active yet. Anchoring wastes HBAR on noise events.',
      howToEnable: 'Set HEDERA_ANCHORING_ENABLED=true in Render env vars when first real key activates',
    });
    // Still run the batch cleanup to mark noise events as locally handled
    // so they don't pile up in the database forever, but NO Hedera calls.
    setTimeout(() => anchorEventBatch().catch(err =>
      logger.error('Initial cleanup batch failed', { error: err.message })
    ), 10_000);
    anchorInterval = setInterval(async () => {
      try { await anchorEventBatch(); } catch (err: any) {
        logger.error('Cleanup batch error', { error: err.message });
      }
    }, ANCHOR_INTERVAL_MS);
    return;
  }

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

  // Retry failed submissions every 5 minutes (raised from 30s to reduce
  // resource churn during prolonged network outages - each retry creates a
  // new Hedera client connection and balance query even on failure)
  retryInterval = setInterval(async () => {
    try {
      const result = await retryFailedAnchoring();
      if (result.retried > 0) {
        logger.info('Retry batch processed', result);
      }
    } catch (err: any) {
      logger.error('Retry batch error', { error: err.message });
    }
  }, 5 * 60 * 1000); // 5 minutes

  logger.info('Hedera anchoring schedule started', {
    anchorIntervalMs: ANCHOR_INTERVAL_MS,
    retryIntervalMs: 300000,
    maxDailyTx: MAX_DAILY_HCS_TX,
    hbarMinimumBalance: HBAR_MINIMUM_BALANCE,
    balanceCheckPolicy: 'fail-closed (override after 3 consecutive failures)',
    dailyCounterPersistence: 'SQLite (survives restarts)',
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
