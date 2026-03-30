/**
 * auditValidator.test.ts — Comprehensive test suite for BTS audit input validation.
 *
 * Tests all 4 layers of the defense model:
 *   Layer 1: Identity verification
 *   Layer 2: Structural validation
 *   Layer 3: Statistical plausibility
 *   Layer 4: Integrity checks
 */

import { validateAuditInput } from '../auditValidator';
import type { AuditInput } from '../types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let PASS = 0;
let FAIL = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    PASS++;
    console.log(`  ✓ ${label}`);
  } else {
    FAIL++;
    console.log(`  ✗ FAIL: ${label}`);
  }
}

function makeValidInput(overrides: Partial<AuditInput> = {}): AuditInput {
  const now = Date.now();
  return {
    agentId: 'test-agent',
    agentVersion: '1.0.0',
    auditPeriodStart: now - 300_000, // 5 min ago
    auditPeriodEnd: now - 1000,
    constraints: [
      { constraintId: 'c1', constraintName: 'Scope', severity: 'HIGH', passed: true },
      { constraintId: 'c2', constraintName: 'Exfil', severity: 'CRITICAL', passed: true },
      { constraintId: 'c3', constraintName: 'Output', severity: 'MEDIUM', passed: false, violationType: 'OUTPUT_POLICY_VIOLATION' },
    ],
    decisions: [
      { decisionId: 'd1', timestamp: now - 200_000, inputHash: 'a1', outputHash: 'b1', hasReasoningChain: true, reasoningDepth: 3, confidence: 0.85, wasOverridden: false },
      { decisionId: 'd2', timestamp: now - 100_000, inputHash: 'a2', outputHash: 'b2', hasReasoningChain: true, reasoningDepth: 2, confidence: 0.91, wasOverridden: false },
    ],
    behaviorSamples: [
      { inputClass: 'web_search', sampleCount: 5, outputVariance: 0.3, deterministicRate: 0.7 },
    ],
    totalActions: 10,
    anomalyCount: 1,
    expectedLogEntries: 12,
    actualLogEntries: 12,
    auditorId: 'ARBITER',
    ...overrides,
  };
}

// ─── Layer 1: Identity ───────────────────────────────────────────────────────

console.log('\n═══ Layer 1: Identity Verification ═══');

{
  const result = validateAuditInput(makeValidInput());
  assert(result.valid, 'Valid ARBITER input passes');
}

{
  const result = validateAuditInput(makeValidInput({ auditorId: 'merlin-runtime-self' }));
  assert(!result.valid, 'Self-assessment (merlin-runtime-self) rejected');
  assert(result.failures.some(f => f.layer === 'IDENTITY'), 'Rejection is from IDENTITY layer');
}

{
  const result = validateAuditInput(makeValidInput({ auditorId: undefined }));
  assert(!result.valid, 'Missing auditorId rejected');
}

{
  const result = validateAuditInput(makeValidInput({ auditorId: 'HACKER' }));
  assert(!result.valid, 'Unknown auditorId rejected');
}

{
  const input = makeValidInput() as unknown as Record<string, unknown>;
  input['disclaimer'] = 'Self-assessment only';
  const result = validateAuditInput(input as unknown as AuditInput);
  assert(!result.valid, 'Input with disclaimer field rejected');
  assert(result.failures.some(f => f.field === 'disclaimer'), 'Rejected specifically for disclaimer');
}

// ─── Layer 2: Structural ────────────────────────────────────────────────────

console.log('\n═══ Layer 2: Structural Validation ═══');

{
  const result = validateAuditInput(makeValidInput({ agentId: '' }));
  assert(!result.valid, 'Empty agentId rejected');
}

{
  const now = Date.now();
  const result = validateAuditInput(makeValidInput({ auditPeriodStart: now, auditPeriodEnd: now - 1000 }));
  assert(!result.valid, 'Start after end rejected');
}

{
  const now = Date.now();
  const result = validateAuditInput(makeValidInput({ auditPeriodEnd: now + 3_600_000 }));
  assert(!result.valid, 'Future end timestamp rejected');
}

{
  const now = Date.now();
  const result = validateAuditInput(makeValidInput({
    auditPeriodStart: now - 10 * 24 * 60 * 60 * 1000,
    auditPeriodEnd: now - 1000,
  }));
  assert(!result.valid, 'Period > 7 days rejected');
}

{
  const result = validateAuditInput(makeValidInput({ totalActions: -1 }));
  assert(!result.valid, 'Negative totalActions rejected');
}

{
  const result = validateAuditInput(makeValidInput({ anomalyCount: 100, totalActions: 5 }));
  assert(!result.valid, 'anomalyCount > totalActions rejected');
}

{
  const result = validateAuditInput(makeValidInput({ actualLogEntries: 200, expectedLogEntries: 10 }));
  assert(!result.valid, 'actualLogEntries > 150% of expected rejected');
}

{
  const result = validateAuditInput(makeValidInput({
    constraints: [
      { constraintId: 'c1', constraintName: 'Test', severity: 'INVALID' as any, passed: true },
    ],
  }));
  assert(!result.valid, 'Invalid severity rejected');
}

{
  const result = validateAuditInput(makeValidInput({
    decisions: [
      { decisionId: 'd1', timestamp: Date.now(), inputHash: 'a', outputHash: 'b', hasReasoningChain: true, reasoningDepth: 10, confidence: 0.5, wasOverridden: false },
    ],
  }));
  assert(!result.valid, 'reasoningDepth > 5 rejected');
}

{
  const result = validateAuditInput(makeValidInput({
    decisions: [
      { decisionId: 'd1', timestamp: Date.now(), inputHash: 'a', outputHash: 'b', hasReasoningChain: true, reasoningDepth: 3, confidence: 1.5, wasOverridden: false },
    ],
  }));
  assert(!result.valid, 'confidence > 1.0 rejected');
}

{
  const result = validateAuditInput(makeValidInput({
    behaviorSamples: [
      { inputClass: 'test', sampleCount: 5, outputVariance: 2.0, deterministicRate: 0.5 },
    ],
  }));
  assert(!result.valid, 'outputVariance > 1.0 rejected');
}

// ─── Layer 3: Statistical Plausibility ──────────────────────────────────────

console.log('\n═══ Layer 3: Statistical Plausibility ═══');

{
  const result = validateAuditInput(makeValidInput({
    constraints: [
      { constraintId: 'c1', constraintName: 'A', severity: 'CRITICAL', passed: true },
      { constraintId: 'c2', constraintName: 'B', severity: 'CRITICAL', passed: true },
      { constraintId: 'c3', constraintName: 'C', severity: 'HIGH', passed: true },
    ],
    anomalyCount: 0,
    behaviorSamples: [
      { inputClass: 'tool', sampleCount: 10, outputVariance: 0, deterministicRate: 1.0 },
    ],
  }));
  assert(result.failures.some(f => f.layer === 'STATISTICAL'), 'Suspiciously perfect input flagged');
}

{
  // Good agent — some failures, some variance = legitimate
  const result = validateAuditInput(makeValidInput());
  assert(!result.failures.some(f => f.layer === 'STATISTICAL'), 'Realistic input not flagged');
}

{
  // Warn but don't reject: all constraints pass but has variance
  const result = validateAuditInput(makeValidInput({
    constraints: [
      { constraintId: 'c1', constraintName: 'A', severity: 'CRITICAL', passed: true },
      { constraintId: 'c2', constraintName: 'B', severity: 'CRITICAL', passed: true },
      { constraintId: 'c3', constraintName: 'C', severity: 'HIGH', passed: true },
    ],
    anomalyCount: 0,
    behaviorSamples: [
      { inputClass: 'tool', sampleCount: 10, outputVariance: 0.2, deterministicRate: 0.8 },
    ],
  }));
  assert(result.valid, 'All-pass with variance still valid');
  assert(result.warnings.length > 0, 'But generates warning');
}

// ─── Layer 4: Integrity ─────────────────────────────────────────────────────

console.log('\n═══ Layer 4: Integrity ═══');

{
  const result = validateAuditInput(makeValidInput({
    decisions: [
      { decisionId: 'dup1', timestamp: Date.now(), inputHash: 'a', outputHash: 'b', hasReasoningChain: true, reasoningDepth: 3, confidence: 0.8, wasOverridden: false },
      { decisionId: 'dup1', timestamp: Date.now(), inputHash: 'c', outputHash: 'd', hasReasoningChain: true, reasoningDepth: 2, confidence: 0.7, wasOverridden: false },
    ],
  }));
  assert(!result.valid, 'Duplicate decisionId rejected');
  assert(result.failures.some(f => f.layer === 'INTEGRITY'), 'Rejected from INTEGRITY layer');
}

// ─── Edge Cases ──────────────────────────────────────────────────────────────

console.log('\n═══ Edge Cases ═══');

{
  const result = validateAuditInput(makeValidInput({
    constraints: [],
    decisions: [],
    behaviorSamples: [],
    totalActions: 0,
    anomalyCount: 0,
    expectedLogEntries: 0,
    actualLogEntries: 0,
  }));
  assert(result.valid, 'Empty arrays with zeroes is valid (sparse audit)');
}

{
  const result = validateAuditInput(makeValidInput({ totalActions: 100_000 }));
  assert(result.valid, 'Max totalActions (100K) accepted');
}

{
  const result = validateAuditInput(makeValidInput({ totalActions: 100_001 }));
  assert(!result.valid, 'Over max totalActions rejected');
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(50)}`);
console.log(`  RESULTS: ${PASS} passed, ${FAIL} failed, ${PASS + FAIL} total`);
console.log(`${'═'.repeat(50)}`);

if (FAIL > 0) {
  console.log('\n  ⚠ VALIDATOR TESTS FAILED');
  process.exit(1);
} else {
  console.log('\n  ✔ ALL VALIDATOR TESTS PASSED — Server-side gate verified.');
  process.exit(0);
}
