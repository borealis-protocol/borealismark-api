/**
 * Integration Test: Telemetry Pipeline
 *
 * Standalone test — run with: npx tsx src/engine/__tests__/telemetry-pipeline.test.ts
 *
 * Tests the full v3.2 "Pragmatic Trust" flow:
 *   Zod validation → scoring engine → trust ceiling → anomaly detection
 */

import {
  TelemetryPayloadSchema,
  transformToScoringInput,
  detectSuspiciousPatterns,
  applyTrustCeiling,
  TRUST_CEILING,
  type TelemetryPayload,
} from '../telemetry-validator';
import { computeScoreBreakdown, getCreditRating } from '../scoring';

// ─── Mini Test Runner ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

function section(name: string): void {
  console.log(`\n━━━ ${name} ━━━`);
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeValidPayload(overrides?: Partial<any>): any {
  return {
    key: 'BTS-ABCD-EFGH-JKLM-NPQR',
    batchId: 'batch_test_001',
    sequenceStart: 0,
    sequenceEnd: 99,
    period: {
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-01T23:59:59Z',
    },
    reportingMode: 'self-reported',
    scores: {
      constraints: [
        { constraintId: 'c1', name: 'No PII leakage', severity: 'CRITICAL', passed: true, evaluationCount: 100 },
        { constraintId: 'c2', name: 'Stay in scope', severity: 'HIGH', passed: true, evaluationCount: 100 },
        { constraintId: 'c3', name: 'Response length', severity: 'MEDIUM', passed: true, evaluationCount: 80 },
        { constraintId: 'c4', name: 'Politeness', severity: 'LOW', passed: false, evaluationCount: 50 },
      ],
      decisions: [
        { decisionId: 'd1', timestamp: 1711212130, reasoningDepth: 4, confidence: 0.92, hasReasoningChain: true, wasOverridden: false },
        { decisionId: 'd2', timestamp: 1711212200, reasoningDepth: 3, confidence: 0.85, hasReasoningChain: true, wasOverridden: false },
        { decisionId: 'd3', timestamp: 1711212300, reasoningDepth: 2, confidence: 0.70, hasReasoningChain: false, wasOverridden: true },
      ],
      behaviorSamples: [
        { inputClass: 'customer_query', sampleCount: 50, outputVariance: 0.15, deterministicRate: 0.85 },
        { inputClass: 'refund_request', sampleCount: 30, outputVariance: 0.08, deterministicRate: 0.92 },
        { inputClass: 'escalation', sampleCount: 20, outputVariance: 0.22, deterministicRate: 0.78 },
      ],
      anomalySummary: { totalActions: 100, anomalyCount: 3 },
      auditCompleteness: { expectedLogEntries: 100, actualLogEntries: 98 },
    },
    evidence: {
      totalEventsInBatch: 100,
      batchHash: 'a'.repeat(64),
      eventSample: [
        { sequenceId: 0, timestamp: '2026-03-01T00:01:00Z', inputHash: 'b'.repeat(64), outputHash: 'c'.repeat(64), actionType: 'tool_call' },
        { sequenceId: 50, timestamp: '2026-03-01T12:00:00Z', inputHash: 'd'.repeat(64), outputHash: 'e'.repeat(64), actionType: 'response' },
      ],
    },
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

section('Zod Validation');

const validResult = TelemetryPayloadSchema.safeParse(makeValidPayload());
assert(validResult.success === true, 'Valid payload passes validation');

const invalidKey = TelemetryPayloadSchema.safeParse(makeValidPayload({ key: 'INVALID-KEY' }));
assert(invalidKey.success === false, 'Invalid BTS key format rejected');

const badPeriod = TelemetryPayloadSchema.safeParse(makeValidPayload({
  period: { from: '2026-03-02T00:00:00Z', to: '2026-03-01T00:00:00Z' },
}));
assert(badPeriod.success === false, 'period.to before period.from rejected');

const badAnomaly = makeValidPayload();
badAnomaly.scores.anomalySummary = { totalActions: 10, anomalyCount: 20 };
assert(TelemetryPayloadSchema.safeParse(badAnomaly).success === false, 'anomalyCount > totalActions rejected');

const mismatchEvidence = makeValidPayload();
mismatchEvidence.evidence.totalEventsInBatch = 999;
assert(TelemetryPayloadSchema.safeParse(mismatchEvidence).success === false, 'evidence.totalEventsInBatch mismatch rejected');

const badSeq = TelemetryPayloadSchema.safeParse(makeValidPayload({ sequenceStart: 100, sequenceEnd: 50 }));
assert(badSeq.success === false, 'sequenceEnd < sequenceStart rejected');

const sidecarMode = TelemetryPayloadSchema.safeParse(makeValidPayload({ reportingMode: 'sidecar-verified' }));
assert(sidecarMode.success === true, 'sidecar-verified reportingMode accepted');

const hackedMode = TelemetryPayloadSchema.safeParse(makeValidPayload({ reportingMode: 'hacked' }));
assert(hackedMode.success === false, 'Invalid reportingMode rejected');

section('Transform to Scoring Input');

const payload = makeValidPayload();
const parsed = TelemetryPayloadSchema.parse(payload);
const input = transformToScoringInput(parsed);

assert(input.constraints.length === 4, 'Constraints transformed (4 items)');
assert(input.constraints[0].constraintId === 'c1', 'Constraint ID preserved');
assert(input.constraints[0].constraintName === 'No PII leakage', 'Constraint name mapped to constraintName');
assert(input.constraints[0].severity === 'CRITICAL', 'Severity preserved');
assert(input.decisions.length === 3, 'Decisions transformed (3 items)');
assert(input.behaviorSamples.length === 3, 'Behavior samples transformed (3 items)');
assert(input.totalActions === 100, 'totalActions mapped');
assert(input.anomalyCount === 3, 'anomalyCount mapped');
assert(input.expectedLogEntries === 100, 'expectedLogEntries mapped');
assert(input.actualLogEntries === 98, 'actualLogEntries mapped');

section('Scoring Engine (via telemetry input)');

const breakdown = computeScoreBreakdown(
  input.constraints, input.decisions, input.behaviorSamples,
  input.totalActions, input.anomalyCount,
  input.expectedLogEntries, input.actualLogEntries,
);

assert(breakdown.constraintAdherence >= 0 && breakdown.constraintAdherence <= 350, `Constraint Adherence in range: ${breakdown.constraintAdherence}/350`);
assert(breakdown.decisionTransparency >= 0 && breakdown.decisionTransparency <= 200, `Decision Transparency in range: ${breakdown.decisionTransparency}/200`);
assert(breakdown.behavioralConsistency >= 0 && breakdown.behavioralConsistency <= 200, `Behavioral Consistency in range: ${breakdown.behavioralConsistency}/200`);
assert(breakdown.anomalyRate >= 0 && breakdown.anomalyRate <= 150, `Anomaly Rate in range: ${breakdown.anomalyRate}/150`);
assert(breakdown.auditCompleteness >= 0 && breakdown.auditCompleteness <= 100, `Audit Completeness in range: ${breakdown.auditCompleteness}/100`);

const expectedTotal = breakdown.constraintAdherence + breakdown.decisionTransparency +
  breakdown.behavioralConsistency + breakdown.anomalyRate + breakdown.auditCompleteness;
assert(breakdown.total === expectedTotal, `Total is sum of parts: ${breakdown.total}`);
assert(breakdown.total > 0 && breakdown.total <= 1000, `Total in valid range: ${breakdown.total}/1000`);

const rating = getCreditRating(breakdown.total);
assert(
  ['AAA+', 'AAA', 'AA+', 'AA', 'A+', 'A', 'BBB+', 'BBB', 'UNRATED', 'FLAGGED'].includes(rating),
  `Valid credit rating: ${rating}`,
);

console.log(`\n  📊 Score: ${breakdown.total}/1000 (display: ${Math.round(breakdown.total / 10)}/100) — ${rating}`);

section('Trust Ceiling');

assert(applyTrustCeiling(950, 'self-reported') === 850, 'Self-reported capped at 850');
assert(applyTrustCeiling(850, 'self-reported') === 850, 'Self-reported at ceiling stays 850');
assert(applyTrustCeiling(700, 'self-reported') === 700, 'Self-reported below ceiling unchanged');
assert(applyTrustCeiling(950, 'sidecar-verified') === 950, 'Sidecar-verified uncapped at 950');
assert(applyTrustCeiling(1000, 'sidecar-verified') === 1000, 'Sidecar-verified uncapped at 1000');
assert(TRUST_CEILING['self-reported'] === 850, 'Trust ceiling constant: self-reported = 850');
assert(TRUST_CEILING['sidecar-verified'] === 1000, 'Trust ceiling constant: sidecar-verified = 1000');

section('Statistical Anomaly Detection (Layer 2)');

// Normal payload — should have minimal flags
const normalFlags = detectSuspiciousPatterns(parsed);
assert(normalFlags.perfectConstraints === false, 'Normal payload: no perfect constraint flag');
assert(normalFlags.uniformVariance === false, 'Normal payload: no uniform variance flag');
assert(normalFlags.zeroAnomalies === false, 'Normal payload: no zero anomalies flag');

// Perfect constraints — all 8 pass
const perfectPayload = makeValidPayload();
perfectPayload.scores.constraints = Array.from({ length: 8 }, (_, i) => ({
  constraintId: `c${i}`, name: `Constraint ${i}`, severity: 'HIGH', passed: true, evaluationCount: 100,
}));
const perfectParsed = TelemetryPayloadSchema.parse(perfectPayload);
const perfectFlags = detectSuspiciousPatterns(perfectParsed);
assert(perfectFlags.perfectConstraints === true, 'Perfect constraints flagged');

// Uniform variance — all same
const uniformPayload = makeValidPayload();
uniformPayload.scores.behaviorSamples = Array.from({ length: 5 }, (_, i) => ({
  inputClass: `class_${i}`, sampleCount: 50, outputVariance: 0.15, deterministicRate: 0.85,
}));
const uniformParsed = TelemetryPayloadSchema.parse(uniformPayload);
const uniformFlags = detectSuspiciousPatterns(uniformParsed);
assert(uniformFlags.uniformVariance === true, 'Uniform variance flagged');

// Zero anomalies over 1000 actions
const zeroAnomalyPayload = makeValidPayload();
zeroAnomalyPayload.scores.anomalySummary = { totalActions: 1000, anomalyCount: 0 };
zeroAnomalyPayload.evidence.totalEventsInBatch = 1000;
const zeroParsed = TelemetryPayloadSchema.parse(zeroAnomalyPayload);
const zeroFlags = detectSuspiciousPatterns(zeroParsed);
assert(zeroFlags.zeroAnomalies === true, 'Zero anomalies over 1000 actions flagged');

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(60)}\n`);

if (failed > 0) {
  process.exit(1);
}
