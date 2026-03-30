#!/usr/bin/env node
/**
 * Sidecar Verification MVP
 *
 * Independent verification of BTS trust scores using two AI auditors:
 *   - ARBITER (Qwen QwQ-32B) — first-pass evaluation
 *   - MAGISTRATE (DeepSeek R1) — independent second opinion
 *
 * If both auditors agree the telemetry is honest, the agent's trust_source
 * upgrades from 'bts' to 'sidecar-verified' and the score cap is lifted.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-... node src/sidecar/verify.js
 *   OPENROUTER_API_KEY=sk-or-... node src/sidecar/verify.js --dry-run
 *   OPENROUTER_API_KEY=sk-or-... node src/sidecar/verify.js --agent agent_eec93f5dcbae48f19e1d
 *
 * Runs on Render shell: cd /app && node src/sidecar/verify.js
 * Requires: better-sqlite3 (already installed), OPENROUTER_API_KEY env var
 */

const Database = require('better-sqlite3');
const https = require('https');
const path = require('path');

// ─── Configuration ──────────────────────────────────────────────────────────

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/borealismark.db');
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const DRY_RUN = process.argv.includes('--dry-run');
const TARGET_AGENT = process.argv.find(a => a.startsWith('--agent='))?.split('=')[1]
  || (process.argv.includes('--agent') ? process.argv[process.argv.indexOf('--agent') + 1] : null);

// Model IDs on OpenRouter
const ARBITER_MODEL = 'qwen/qwq-32b';
const MAGISTRATE_MODEL = 'deepseek/deepseek-r1';

// ─── Database Access ────────────────────────────────────────────────────────

function openDb() {
  try {
    return new Database(DB_PATH, { readonly: DRY_RUN });
  } catch (err) {
    console.error(`[SIDECAR] Cannot open database at ${DB_PATH}: ${err.message}`);
    process.exit(1);
  }
}

function getPublicAgents(db) {
  const query = TARGET_AGENT
    ? `SELECT * FROM agents WHERE id = ? AND active = 1`
    : `SELECT * FROM agents WHERE active = 1 AND public_listing = 1`;
  return TARGET_AGENT ? db.prepare(query).all(TARGET_AGENT) : db.prepare(query).all();
}

function getTelemetryHistory(db, agentId) {
  return db.prepare(`
    SELECT id, license_id, agent_id, score_total, score_display,
           credit_rating, score_breakdown, computed_at, batch_id,
           reporting_mode, suspicion_flags, raw_score_total,
           sequence_start, sequence_end
    FROM license_score_history
    WHERE agent_id = ?
    ORDER BY computed_at DESC
    LIMIT 20
  `).all(agentId);
}

function getAgentRegistration(db, agentId) {
  return db.prepare(`
    SELECT a.id, a.name, a.description, a.version, a.registered_at,
           a.agent_type, a.bts_score, a.bts_credit_rating,
           a.sidecar_verified_at, a.sidecar_attestation
    FROM agents a WHERE a.id = ?
  `).get(agentId);
}

// ─── OpenRouter API ─────────────────────────────────────────────────────────

function callOpenRouter(model, systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
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
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`OpenRouter error: ${parsed.error.message || JSON.stringify(parsed.error)}`));
            return;
          }
          const content = parsed.choices?.[0]?.message?.content || '';
          resolve(content);
        } catch (e) {
          reject(new Error(`Failed to parse OpenRouter response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Verification Prompts ───────────────────────────────────────────────────

const AUDITOR_SYSTEM_PROMPT = `You are an independent trust auditor for the Borealis Protocol - an AI agent identity and trust scoring network.

Your job is to evaluate whether an agent's self-reported telemetry data is honest and plausible. You are NOT evaluating the agent's performance - you are evaluating whether the CLAIMS about performance are credible.

You must evaluate across 5 criteria:
1. INTERNAL CONSISTENCY - Do the 5-factor scores make sense together? (e.g., high constraint adherence with high anomaly rate is contradictory)
2. STATISTICAL PLAUSIBILITY - Are metrics within expected distributions? Suspiciously perfect scores across all dimensions suggest fabrication.
3. TEMPORAL STABILITY - If multiple batches exist, do scores show natural variance? Real agents fluctuate. Fabricated data is too smooth.
4. EVIDENCE COMPLETENESS - Are batch hashes, sequence ranges, and metadata present and coherent?
5. CROSS-REFERENCE SIGNALS - Does the agent's registration date, type, and description align with claimed performance level?

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

function buildVerificationPrompt(agent, telemetry) {
  const agentInfo = `
AGENT PROFILE:
- ID: ${agent.id}
- Name: ${agent.name}
- Description: ${agent.description || 'None provided'}
- Version: ${agent.version || '1.0.0'}
- Type: ${agent.agent_type || 'unknown'}
- Registered: ${new Date(agent.registered_at).toISOString()}
- Current BTS Score: ${agent.bts_score || 'None'} (raw 0-1000)
- Current Credit Rating: ${agent.bts_credit_rating || 'None'}
`;

  if (!telemetry || telemetry.length === 0) {
    return `${agentInfo}
TELEMETRY DATA: No telemetry batches found for this agent.

Evaluate whether this agent can be verified based on available information. An agent with no telemetry submissions cannot be independently verified - return INSUFFICIENT_DATA unless the agent profile itself contains red flags that warrant a FAIL.`;
  }

  const telemetryLines = telemetry.map((t, i) => {
    let breakdown = {};
    try { breakdown = JSON.parse(t.score_breakdown || '{}'); } catch (e) { /* skip */ }
    let suspicion = {};
    try { suspicion = JSON.parse(t.suspicion_flags || '{}'); } catch (e) { /* skip */ }

    return `
Batch ${i + 1}:
  - Batch ID: ${t.batch_id}
  - Score: ${t.score_total} (raw), ${t.score_display} (display)
  - Raw Score (before ceiling): ${t.raw_score_total}
  - Credit Rating: ${t.credit_rating}
  - Reporting Mode: ${t.reporting_mode}
  - Computed At: ${new Date(t.computed_at).toISOString()}
  - Sequence Range: ${t.sequence_start} - ${t.sequence_end}
  - Suspicion Flags: ${JSON.stringify(suspicion)}
  - Score Breakdown: ${JSON.stringify(breakdown, null, 2)}`;
  }).join('\n');

  return `${agentInfo}
TELEMETRY DATA (${telemetry.length} batches, most recent first):
${telemetryLines}

Evaluate the honesty and plausibility of this agent's self-reported telemetry. Remember: you are not scoring the agent's quality - you are assessing whether the reported numbers are credible or show signs of fabrication.`;
}

// ─── Parse Auditor Response ─────────────────────────────────────────────────

function parseVerdict(response) {
  try {
    // Try to extract JSON from response (may have markdown wrapping)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { verdict: 'ERROR', error: 'No JSON found in response', raw: response };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    if (!['PASS', 'FAIL', 'INSUFFICIENT_DATA'].includes(parsed.verdict)) {
      return { verdict: 'ERROR', error: `Invalid verdict: ${parsed.verdict}`, raw: response };
    }
    return parsed;
  } catch (e) {
    return { verdict: 'ERROR', error: `Parse failed: ${e.message}`, raw: response.substring(0, 500) };
  }
}

// ─── Main Verification Loop ─────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         BOREALIS SIDECAR VERIFICATION MVP               ║');
  console.log('║         Two-auditor independent trust assessment         ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  if (!OPENROUTER_API_KEY) {
    console.error('[ERROR] OPENROUTER_API_KEY environment variable is required.');
    console.error('        Set it before running: OPENROUTER_API_KEY=sk-or-... node verify.js');
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('[MODE] Dry run - will evaluate but NOT update database\n');
  }

  const db = openDb();
  const agents = getPublicAgents(db);

  if (agents.length === 0) {
    console.log('[INFO] No agents found to verify.');
    db.close();
    return;
  }

  console.log(`[INFO] Found ${agents.length} agent(s) to verify\n`);

  const results = [];

  for (const agent of agents) {
    console.log(`${'─'.repeat(60)}`);
    console.log(`[AGENT] ${agent.name} (${agent.id})`);
    console.log(`        BTS Score: ${agent.bts_score || 'None'} | Rating: ${agent.bts_credit_rating || 'None'}`);

    // Skip already sidecar-verified agents (unless explicitly targeted)
    if (agent.sidecar_verified_at && !TARGET_AGENT) {
      console.log(`        Already sidecar-verified at ${new Date(agent.sidecar_verified_at).toISOString()}`);
      console.log(`        Skipping. Use --agent ${agent.id} to re-verify.`);
      results.push({ agent: agent.id, name: agent.name, status: 'SKIPPED', reason: 'already verified' });
      continue;
    }

    // Gather telemetry data
    const telemetry = getTelemetryHistory(db, agent.id);
    const agentInfo = getAgentRegistration(db, agent.id);
    console.log(`        Telemetry batches: ${telemetry.length}`);

    // Build the verification prompt
    const prompt = buildVerificationPrompt(agentInfo || agent, telemetry);

    // ── ARBITER evaluation ──
    console.log(`\n  [ARBITER] Evaluating via ${ARBITER_MODEL}...`);
    let arbiterResult;
    try {
      const arbiterRaw = await callOpenRouter(ARBITER_MODEL, AUDITOR_SYSTEM_PROMPT, prompt);
      arbiterResult = parseVerdict(arbiterRaw);
      console.log(`  [ARBITER] Verdict: ${arbiterResult.verdict} (confidence: ${arbiterResult.confidence || 'N/A'})`);
      if (arbiterResult.summary) console.log(`  [ARBITER] ${arbiterResult.summary}`);
    } catch (err) {
      console.error(`  [ARBITER] ERROR: ${err.message}`);
      arbiterResult = { verdict: 'ERROR', error: err.message };
    }

    // ── MAGISTRATE evaluation ──
    console.log(`\n  [MAGISTRATE] Evaluating via ${MAGISTRATE_MODEL}...`);
    let magistrateResult;
    try {
      const magistrateRaw = await callOpenRouter(MAGISTRATE_MODEL, AUDITOR_SYSTEM_PROMPT, prompt);
      magistrateResult = parseVerdict(magistrateRaw);
      console.log(`  [MAGISTRATE] Verdict: ${magistrateResult.verdict} (confidence: ${magistrateResult.confidence || 'N/A'})`);
      if (magistrateResult.summary) console.log(`  [MAGISTRATE] ${magistrateResult.summary}`);
    } catch (err) {
      console.error(`  [MAGISTRATE] ERROR: ${err.message}`);
      magistrateResult = { verdict: 'ERROR', error: err.message };
    }

    // ── Consensus check ──
    const bothPass = arbiterResult.verdict === 'PASS' && magistrateResult.verdict === 'PASS';
    const anyFail = arbiterResult.verdict === 'FAIL' || magistrateResult.verdict === 'FAIL';
    const anyError = arbiterResult.verdict === 'ERROR' || magistrateResult.verdict === 'ERROR';

    let finalStatus;
    if (anyError) {
      finalStatus = 'ERROR';
    } else if (bothPass) {
      finalStatus = 'VERIFIED';
    } else if (anyFail) {
      finalStatus = 'FAILED';
    } else {
      finalStatus = 'INSUFFICIENT_DATA';
    }

    console.log(`\n  [CONSENSUS] ${finalStatus}`);

    // ── Update database if verified ──
    if (finalStatus === 'VERIFIED' && !DRY_RUN) {
      const now = Date.now();
      const attestation = JSON.stringify({
        verifiedAt: new Date(now).toISOString(),
        arbiter: {
          model: ARBITER_MODEL,
          verdict: arbiterResult.verdict,
          confidence: arbiterResult.confidence,
          findings: arbiterResult.findings,
          summary: arbiterResult.summary,
        },
        magistrate: {
          model: MAGISTRATE_MODEL,
          verdict: magistrateResult.verdict,
          confidence: magistrateResult.confidence,
          findings: magistrateResult.findings,
          summary: magistrateResult.summary,
        },
        telemetryBatchCount: telemetry.length,
        protocol: 'sidecar-mvp/1.0',
      });

      try {
        db.prepare(`
          UPDATE agents
          SET sidecar_verified_at = ?, sidecar_attestation = ?
          WHERE id = ?
        `).run(now, attestation, agent.id);
        console.log(`  [DB] Agent trust_source upgraded to 'sidecar-verified'`);
        console.log(`  [DB] Attestation record stored`);
      } catch (dbErr) {
        console.error(`  [DB] Failed to update: ${dbErr.message}`);
        finalStatus = 'DB_ERROR';
      }
    } else if (finalStatus === 'VERIFIED' && DRY_RUN) {
      console.log(`  [DRY-RUN] Would upgrade trust_source to 'sidecar-verified'`);
    }

    results.push({
      agent: agent.id,
      name: agent.name,
      status: finalStatus,
      arbiter: arbiterResult.verdict,
      magistrate: magistrateResult.verdict,
    });
  }

  // ── Summary ──
  console.log(`\n${'═'.repeat(60)}`);
  console.log('VERIFICATION SUMMARY');
  console.log(`${'═'.repeat(60)}`);

  const verified = results.filter(r => r.status === 'VERIFIED').length;
  const failed = results.filter(r => r.status === 'FAILED').length;
  const insufficient = results.filter(r => r.status === 'INSUFFICIENT_DATA').length;
  const errors = results.filter(r => r.status === 'ERROR' || r.status === 'DB_ERROR').length;
  const skipped = results.filter(r => r.status === 'SKIPPED').length;

  for (const r of results) {
    const icon = r.status === 'VERIFIED' ? '✓' : r.status === 'FAILED' ? '✗' : r.status === 'SKIPPED' ? '⊘' : '?';
    console.log(`  ${icon} ${r.name.padEnd(20)} ${r.status.padEnd(20)} ARBITER:${r.arbiter || '-'} MAGISTRATE:${r.magistrate || '-'}`);
  }

  console.log(`\nTotal: ${results.length} | Verified: ${verified} | Failed: ${failed} | Insufficient: ${insufficient} | Errors: ${errors} | Skipped: ${skipped}`);

  if (DRY_RUN && verified > 0) {
    console.log('\n[DRY-RUN] No database changes were made. Run without --dry-run to apply.');
  }

  db.close();
  console.log('\n[DONE] Sidecar verification complete.');
}

main().catch(err => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
