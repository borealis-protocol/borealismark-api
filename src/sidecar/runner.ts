/**
 * Sidecar Verification Queue Runner
 *
 * Polls the sidecar_requests table every 60 seconds. For each queued request,
 * runs the two-auditor verification flow (ARBITER + MAGISTRATE via OpenRouter)
 * and updates the agent's trust_source accordingly.
 *
 * Designed to run as a setInterval inside the main server process - not a
 * separate service. Keeps things simple until scale demands otherwise.
 */

import https from 'https';
import { logger } from '../middleware/logger';
import {
  getQueuedSidecarRequests,
  updateSidecarRequest,
  setSidecarVerified,
  getDb,
} from '../db/database';
import { sendSidecarVerifiedEmail, sendSidecarFailedEmail } from '../services/email';

// ─── Configuration ──────────────────────────────────────────────────────────

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ARBITER_MODEL = 'qwen/qwq-32b';
const MAGISTRATE_MODEL = 'deepseek/deepseek-r1';
const POLL_INTERVAL_MS = 60 * 1000; // 60 seconds

let isProcessing = false;

// ─── OpenRouter API ─────────────────────────────────────────────────────────

function callOpenRouter(model: string, systemPrompt: string, userPrompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!OPENROUTER_API_KEY) {
      reject(new Error('OPENROUTER_API_KEY not configured'));
      return;
    }

    const payload = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 2000,
    });

    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://borealisprotocol.ai',
        'X-Title': 'Borealis Sidecar Verification',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`OpenRouter: ${parsed.error.message || JSON.stringify(parsed.error)}`));
            return;
          }
          resolve(parsed.choices?.[0]?.message?.content || '');
        } catch (e: any) {
          reject(new Error(`Parse failed: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy();
      reject(new Error('OpenRouter request timed out (120s)'));
    });
    req.write(payload);
    req.end();
  });
}

// ─── Auditor Prompt ─────────────────────────────────────────────────────────

const AUDITOR_SYSTEM_PROMPT = `You are an independent trust auditor for the Borealis Protocol - an AI agent identity and trust scoring network.

Your job is to evaluate whether an agent's self-reported telemetry data is honest and plausible. You are NOT evaluating the agent's performance - you are evaluating whether the CLAIMS about performance are credible.

Evaluate across 5 criteria:
1. INTERNAL CONSISTENCY - Do the 5-factor scores make sense together?
2. STATISTICAL PLAUSIBILITY - Are metrics within expected distributions? Suspiciously perfect scores suggest fabrication.
3. TEMPORAL STABILITY - Do scores show natural variance across batches? Real agents fluctuate.
4. EVIDENCE COMPLETENESS - Are batch hashes, sequence ranges, and metadata present and coherent?
5. CROSS-REFERENCE SIGNALS - Does registration date, type, and description align with claimed performance?

Respond with EXACTLY this JSON format (no markdown, no explanation outside the JSON):
{
  "verdict": "PASS" | "FAIL" | "INSUFFICIENT_DATA",
  "confidence": 0.0-1.0,
  "findings": {
    "internalConsistency": { "pass": true/false, "note": "brief explanation" },
    "statisticalPlausibility": { "pass": true/false, "note": "brief explanation" },
    "temporalStability": { "pass": true/false, "note": "brief explanation" },
    "evidenceCompleteness": { "pass": true/false, "note": "brief explanation" },
    "crossReferenceSignals": { "pass": true/false, "note": "brief explanation" }
  },
  "summary": "1-2 sentence overall assessment"
}`;

function buildVerificationPrompt(agent: Record<string, unknown>, telemetry: Record<string, unknown>[]): string {
  const agentInfo = `
AGENT PROFILE:
- ID: ${agent.id}
- Name: ${agent.name}
- Description: ${agent.description || 'None provided'}
- Version: ${agent.version || '1.0.0'}
- Type: ${agent.agent_type || 'unknown'}
- Registered: ${new Date(agent.registered_at as number).toISOString()}
- Current BTS Score: ${agent.bts_score || 'None'} (raw 0-1000)
- Current Credit Rating: ${agent.bts_credit_rating || 'None'}
`;

  if (!telemetry || telemetry.length === 0) {
    return `${agentInfo}\nTELEMETRY DATA: No telemetry batches found. Return INSUFFICIENT_DATA.`;
  }

  const lines = telemetry.map((t: any, i: number) => {
    let breakdown = {};
    try { breakdown = JSON.parse(t.score_breakdown || '{}'); } catch (_e) { /* skip */ }
    let suspicion = {};
    try { suspicion = JSON.parse(t.suspicion_flags || '{}'); } catch (_e) { /* skip */ }

    return `
Batch ${i + 1}:
  - Score: ${t.score_total} (raw), ${t.score_display} (display)
  - Raw Score (before ceiling): ${t.raw_score_total}
  - Credit Rating: ${t.credit_rating}
  - Reporting Mode: ${t.reporting_mode}
  - Computed At: ${new Date(t.computed_at).toISOString()}
  - Sequence Range: ${t.sequence_start} - ${t.sequence_end}
  - Suspicion Flags: ${JSON.stringify(suspicion)}
  - Score Breakdown: ${JSON.stringify(breakdown, null, 2)}`;
  }).join('\n');

  return `${agentInfo}\nTELEMETRY DATA (${telemetry.length} batches, most recent first):\n${lines}\n\nEvaluate the honesty and plausibility of this agent's self-reported telemetry.`;
}

function parseVerdict(response: string): { verdict: string; confidence?: number; findings?: any; summary?: string; error?: string } {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { verdict: 'ERROR', error: 'No JSON in response' };
    const parsed = JSON.parse(jsonMatch[0]);
    if (!['PASS', 'FAIL', 'INSUFFICIENT_DATA'].includes(parsed.verdict)) {
      return { verdict: 'ERROR', error: `Invalid verdict: ${parsed.verdict}` };
    }
    return parsed;
  } catch (e: any) {
    return { verdict: 'ERROR', error: `Parse failed: ${e.message}` };
  }
}

// ─── Process a Single Request ───────────────────────────────────────────────

async function processRequest(request: Record<string, unknown>): Promise<void> {
  const agentId = request.agent_id as string;
  const requestId = request.id as string;
  const agentName = request.agent_name as string;
  const userEmail = request.user_email as string;
  const userName = request.user_name as string;

  logger.info('Sidecar: processing verification', { requestId, agentId, agentName });

  // Mark as processing
  updateSidecarRequest(requestId, 'processing');

  try {
    const db = getDb();

    // Get agent details
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Record<string, unknown>;
    if (!agent) {
      updateSidecarRequest(requestId, 'failed', undefined, 'Agent not found');
      return;
    }

    // Get telemetry history
    const telemetry = db.prepare(`
      SELECT id, license_id, agent_id, score_total, score_display,
             credit_rating, score_breakdown, computed_at, batch_id,
             reporting_mode, suspicion_flags, raw_score_total,
             sequence_start, sequence_end
      FROM license_score_history
      WHERE agent_id = ?
      ORDER BY computed_at DESC
      LIMIT 20
    `).all(agentId) as Record<string, unknown>[];

    const prompt = buildVerificationPrompt(agent, telemetry);

    // Run ARBITER
    logger.info('Sidecar: calling ARBITER', { requestId, model: ARBITER_MODEL });
    let arbiterResult: any;
    try {
      const raw = await callOpenRouter(ARBITER_MODEL, AUDITOR_SYSTEM_PROMPT, prompt);
      arbiterResult = parseVerdict(raw);
    } catch (err: any) {
      arbiterResult = { verdict: 'ERROR', error: err.message };
    }

    // Run MAGISTRATE
    logger.info('Sidecar: calling MAGISTRATE', { requestId, model: MAGISTRATE_MODEL });
    let magistrateResult: any;
    try {
      const raw = await callOpenRouter(MAGISTRATE_MODEL, AUDITOR_SYSTEM_PROMPT, prompt);
      magistrateResult = parseVerdict(raw);
    } catch (err: any) {
      magistrateResult = { verdict: 'ERROR', error: err.message };
    }

    // Consensus
    const bothPass = arbiterResult.verdict === 'PASS' && magistrateResult.verdict === 'PASS';
    const anyError = arbiterResult.verdict === 'ERROR' || magistrateResult.verdict === 'ERROR';

    const attestation = JSON.stringify({
      verifiedAt: new Date().toISOString(),
      arbiter: { model: ARBITER_MODEL, verdict: arbiterResult.verdict, confidence: arbiterResult.confidence, findings: arbiterResult.findings, summary: arbiterResult.summary },
      magistrate: { model: MAGISTRATE_MODEL, verdict: magistrateResult.verdict, confidence: magistrateResult.confidence, findings: magistrateResult.findings, summary: magistrateResult.summary },
      telemetryBatchCount: telemetry.length,
      protocol: 'sidecar-mvp/1.0',
    });

    if (anyError) {
      // System error - allow retry sooner
      updateSidecarRequest(requestId, 'failed', attestation, 'Auditor system error');
      logger.error('Sidecar: auditor error', { requestId, arbiter: arbiterResult.verdict, magistrate: magistrateResult.verdict });

      // Send failure email
      sendSidecarFailedEmail(userEmail, userName, agentName).catch((e: any) =>
        logger.warn('Sidecar: failed email send error', { error: e.message })
      );
      return;
    }

    if (bothPass) {
      // Upgrade trust source
      setSidecarVerified(agentId, attestation);
      updateSidecarRequest(requestId, 'completed', attestation);
      logger.info('Sidecar: VERIFIED', { requestId, agentId, agentName });

      // Send success email
      sendSidecarVerifiedEmail(userEmail, userName, agentName, agentId).catch((e: any) =>
        logger.warn('Sidecar: verified email send error', { error: e.message })
      );
    } else {
      // Failed consensus
      updateSidecarRequest(requestId, 'completed', attestation);
      logger.info('Sidecar: failed consensus', {
        requestId, agentId,
        arbiter: arbiterResult.verdict,
        magistrate: magistrateResult.verdict,
      });

      // Send failure email
      sendSidecarFailedEmail(userEmail, userName, agentName).catch((e: any) =>
        logger.warn('Sidecar: failed email send error', { error: e.message })
      );
    }
  } catch (err: any) {
    updateSidecarRequest(requestId, 'failed', undefined, err.message);
    logger.error('Sidecar: processing error', { requestId, error: err.message });
  }
}

// ─── Queue Runner ───────────────────────────────────────────────────────────

async function pollQueue(): Promise<void> {
  if (isProcessing) return;
  if (!OPENROUTER_API_KEY) return; // Silently skip if not configured

  isProcessing = true;
  try {
    const requests = getQueuedSidecarRequests(1); // Process one at a time
    for (const request of requests) {
      await processRequest(request);
    }
  } catch (err: any) {
    logger.error('Sidecar queue poll error', { error: err.message });
  } finally {
    isProcessing = false;
  }
}

/**
 * Start the sidecar verification queue runner.
 * Call once from server.ts at startup.
 */
export function startSidecarRunner(): void {
  if (!OPENROUTER_API_KEY) {
    logger.info('Sidecar runner: OPENROUTER_API_KEY not set - queue processing disabled');
    return;
  }

  logger.info('Sidecar runner: started (polling every 60s)');
  setInterval(pollQueue, POLL_INTERVAL_MS);

  // Run once immediately to process any stale queued requests from before restart
  setTimeout(pollQueue, 5000);
}
