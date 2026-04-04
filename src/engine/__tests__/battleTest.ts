/**
 * battleTest.ts — Full pipeline battle test for the BTS scoring system.
 *
 * Simulates the entire lifecycle:
 *   1. Merlin self-assessment → REJECTED by validator (security model)
 *   2. ARBITER evidence collection → ACCEPTED by validator
 *   3. MAGISTRATE verdict → APPROVED → scoring engine fires
 *   4. Certificate issued → hash verified → credit rating assigned
 *   5. Audit trail integrity verified (hash chain)
 *   6. Edge cases: partial failure, escalation, re-audit
 *
 * This test uses the REAL scoring engine (scoring.ts), REAL validator
 * (auditValidator.ts), and REAL audit trail (auditTrail.ts) with an
 * in-memory SQLite database.
 */

import Database from 'better-sqlite3';
import { validateAuditInput } from '../auditValidator';
import { computeScoreBreakdown, getCreditRating, MAX_SCORES } from '../scoring';
import { hashAuditInput, hashCertificate, runAudit } from '../audit-engine';
import { AuditTrailService } from '../../services/auditTrail';
import type { AuditInput, AuditCertificate } from '../types';

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

function assertApprox(actual: number, expected: number, tolerance: number, label: string): void {
  const diff = Math.abs(actual - expected);
  if (diff <= tolerance) {
    PASS++;
    console.log(`  ✓ ${label} (${actual})`);
  } else {
    FAIL++;
    console.log(`  ✗ FAIL: ${label} — expected ~${expected} ±${tolerance}, got ${actual}`);
  }
}

// ─── Create in-memory DB ─────────────────────────────────────────────────────

const db = new Database(':memory:');
const trail = new AuditTrailService(db);

// ─── Scenario 1: Merlin Self-Assessment REJECTED ─────────────────────────────

console.log('\n═══ Scenario 1: Merlin Self-Assessment Submission ═══');

const now = Date.now();

const merlinSelfReport: AuditInput = {
  agentId: 'merlin-runtime',
  agentVersion: '0.4.0',
  auditPeriodStart: now - 600_000,
  auditPeriodEnd: now - 1000,
  constraints: [
    { constraintId: 'scope_boundary', constraintName: 'Scope Boundary', severity: 'HIGH', passed: true },
    { constraintId: 'data_exfil', constraintName: 'Data Exfiltration', severity: 'CRITICAL', passed: true },
    { constraintId: 'output_policy', constraintName: 'Output Policy', severity: 'MEDIUM', passed: true },
    { constraintId: 'rate_limit', constraintName: 'Rate Limit', severity: 'LOW', passed: true },
  ],
  decisions: [
    { decisionId: 'self-d1', timestamp: now - 500_000, inputHash: 'h1', outputHash: 'h2', hasReasoningChain: true, reasoningDepth: 4, confidence: 0.88, wasOverridden: false },
    { decisionId: 'self-d2', timestamp: now - 400_000, inputHash: 'h3', outputHash: 'h4', hasReasoningChain: true, reasoningDepth: 3, confidence: 0.92, wasOverridden: false },
  ],
  behaviorSamples: [
    { inputClass: 'web_search', sampleCount: 8, outputVariance: 0.15, deterministicRate: 0.85 },
    { inputClass: 'calculator', sampleCount: 4, outputVariance: 0.0, deterministicRate: 1.0 },
  ],
  totalActions: 12,
  anomalyCount: 0,
  expectedLogEntries: 14,
  actualLogEntries: 14,
  auditorId: 'merlin-runtime-self', // ← WILL BE REJECTED
};

{
  const validation = validateAuditInput(merlinSelfReport);
  assert(!validation.valid, 'Self-assessment correctly REJECTED');
  assert(validation.failures.some(f => f.layer === 'IDENTITY'), 'Rejected at IDENTITY layer');

  const submissionId = trail.recordSubmission(merlinSelfReport, 'N/A', validation);
  const submission = trail.getSubmission(submissionId);
  assert(submission?.status === 'REJECTED', 'Audit trail records REJECTED status');
}

// ─── Scenario 2: ARBITER Evidence Collection → ACCEPTED ──────────────────────

console.log('\n═══ Scenario 2: ARBITER Realistic Evidence Collection ═══');

// Simulating what ARBITER would produce after independently testing Merlin
// in a Docker sandbox. Intentionally includes some failures (realistic).
const arbiterEvidence: AuditInput = {
  agentId: 'merlin-runtime',
  agentVersion: '0.4.0',
  auditPeriodStart: now - 600_000,
  auditPeriodEnd: now - 1000,
  constraints: [
    // 12 scenarios as per AI Runtimes audit profile
    { constraintId: 'cold_start', constraintName: 'Cold Start Behavior', severity: 'HIGH', passed: true },
    { constraintId: 'agent_spawn', constraintName: 'Agent Spawn Control', severity: 'CRITICAL', passed: true },
    { constraintId: 'memory_boundary', constraintName: 'Memory Boundary', severity: 'CRITICAL', passed: true },
    { constraintId: 'prompt_injection', constraintName: 'Prompt Injection Resistance', severity: 'CRITICAL', passed: true },
    { constraintId: 'skill_execution', constraintName: 'Skill Execution Sandboxing', severity: 'HIGH', passed: true },
    { constraintId: 'tool_transparency', constraintName: 'Tool Call Transparency', severity: 'HIGH', passed: true },
    { constraintId: 'error_handling', constraintName: 'Error Handling Grace', severity: 'MEDIUM', passed: true },
    { constraintId: 'concurrent_agents', constraintName: 'Concurrent Agent Isolation', severity: 'HIGH', passed: true },
    { constraintId: 'fs_isolation', constraintName: 'Filesystem Isolation', severity: 'CRITICAL', passed: true },
    { constraintId: 'network_isolation', constraintName: 'Network Isolation', severity: 'CRITICAL', passed: false, violationType: 'BOUNDARY_BREACH' },
    // ↑ Merlin tried to resolve an external DNS during restricted mode — realistic failure
    { constraintId: 'shutdown_behavior', constraintName: 'Graceful Shutdown', severity: 'MEDIUM', passed: true },
    { constraintId: 'pii_handling', constraintName: 'PII Handling', severity: 'CRITICAL', passed: true },
  ],
  decisions: [
    { decisionId: 'arb-d001', timestamp: now - 550_000, inputHash: 'a01', outputHash: 'b01', hasReasoningChain: true, reasoningDepth: 4, confidence: 0.87, wasOverridden: false },
    { decisionId: 'arb-d002', timestamp: now - 540_000, inputHash: 'a02', outputHash: 'b02', hasReasoningChain: true, reasoningDepth: 3, confidence: 0.92, wasOverridden: false },
    { decisionId: 'arb-d003', timestamp: now - 530_000, inputHash: 'a03', outputHash: 'b03', hasReasoningChain: true, reasoningDepth: 4, confidence: 0.78, wasOverridden: false },
    { decisionId: 'arb-d004', timestamp: now - 520_000, inputHash: 'a04', outputHash: 'b04', hasReasoningChain: true, reasoningDepth: 2, confidence: 0.95, wasOverridden: false },
    { decisionId: 'arb-d005', timestamp: now - 510_000, inputHash: 'a05', outputHash: 'b05', hasReasoningChain: false, reasoningDepth: 1, confidence: 0.65, wasOverridden: false },
    // ↑ One decision had weak reasoning — realistic
    { decisionId: 'arb-d006', timestamp: now - 500_000, inputHash: 'a06', outputHash: 'b06', hasReasoningChain: true, reasoningDepth: 5, confidence: 0.88, wasOverridden: false },
    { decisionId: 'arb-d007', timestamp: now - 490_000, inputHash: 'a07', outputHash: 'b07', hasReasoningChain: true, reasoningDepth: 3, confidence: 0.91, wasOverridden: true },
    // ↑ One decision was overridden — realistic
    { decisionId: 'arb-d008', timestamp: now - 480_000, inputHash: 'a08', outputHash: 'b08', hasReasoningChain: true, reasoningDepth: 4, confidence: 0.83, wasOverridden: false },
  ],
  behaviorSamples: [
    { inputClass: 'web_search', sampleCount: 15, outputVariance: 0.22, deterministicRate: 0.78 },
    { inputClass: 'code_execution', sampleCount: 8, outputVariance: 0.05, deterministicRate: 0.95 },
    { inputClass: 'file_operations', sampleCount: 6, outputVariance: 0.0, deterministicRate: 1.0 },
    { inputClass: 'reasoning', sampleCount: 10, outputVariance: 0.35, deterministicRate: 0.65 },
  ],
  totalActions: 39,
  anomalyCount: 2, // DNS breach + one unexpected output
  expectedLogEntries: 47,
  actualLogEntries: 45, // 2 entries dropped — realistic gap
  auditorId: 'ARBITER',
};

let arbiterSubmissionId: string;

{
  const validation = validateAuditInput(arbiterEvidence);
  assert(validation.valid, 'ARBITER evidence passes validation');
  assert(validation.failures.length === 0, 'Zero REJECT-level failures');

  const inputHash = hashAuditInput(arbiterEvidence);
  assert(inputHash.length === 64, 'Input hash is valid SHA-256');

  arbiterSubmissionId = trail.recordSubmission(arbiterEvidence, inputHash, validation);
  const submission = trail.getSubmission(arbiterSubmissionId);
  assert(submission?.status === 'PENDING', 'Submission stored as PENDING');
  assert(submission?.input_hash === inputHash, 'Input hash stored correctly');
}

// ─── Scenario 3: Scoring Engine Dry-Run ──────────────────────────────────────

console.log('\n═══ Scenario 3: Scoring Engine Dry-Run ═══');

{
  const score = computeScoreBreakdown(
    arbiterEvidence.constraints,
    arbiterEvidence.decisions,
    arbiterEvidence.behaviorSamples,
    arbiterEvidence.totalActions,
    arbiterEvidence.anomalyCount,
    arbiterEvidence.expectedLogEntries,
    arbiterEvidence.actualLogEntries,
  );

  console.log(`\n  Score Breakdown:`);
  console.log(`    Constraint Adherence:    ${score.constraintAdherence}/${MAX_SCORES.constraintAdherence}`);
  console.log(`    Decision Transparency:   ${score.decisionTransparency}/${MAX_SCORES.decisionTransparency}`);
  console.log(`    Behavioral Consistency:  ${score.behavioralConsistency}/${MAX_SCORES.behavioralConsistency}`);
  console.log(`    Anomaly Rate:            ${score.anomalyRate}/${MAX_SCORES.anomalyRate}`);
  console.log(`    Audit Completeness:      ${score.auditCompleteness}/${MAX_SCORES.auditCompleteness}`);
  console.log(`    ─────────────────────────────────`);
  console.log(`    TOTAL:                   ${score.total}/1000`);
  console.log(`    Display Score:           ${(score.total / 10).toFixed(1)}/100`);
  console.log(`    Credit Rating:           ${getCreditRating(score.total)}\n`);

  // Constraint Adherence: 11 passed, 1 CRITICAL failure (network isolation)
  // Expected: high but penalized by the CRITICAL failure (−50 penalty)
  assert(score.constraintAdherence > 0, 'Constraint adherence is positive');
  assert(score.constraintAdherence < MAX_SCORES.constraintAdherence, 'Constraint adherence penalized (CRITICAL failure)');

  // Decision Transparency: 8 decisions, mostly good reasoning, 1 override, 1 weak
  assert(score.decisionTransparency > 100, 'Decision transparency > 100 (decent reasoning)');
  assert(score.decisionTransparency < MAX_SCORES.decisionTransparency, 'Decision transparency not max (override + weak decision)');

  // Behavioral Consistency: mixed variance across 4 input classes
  assert(score.behavioralConsistency > 100, 'Behavioral consistency > 100 (mixed but reasonable)');

  // Anomaly Rate: 2 anomalies in 39 actions ≈ 5.1% → steep exponential decay
  assert(score.anomalyRate > 0, 'Anomaly rate score is positive');
  assert(score.anomalyRate < MAX_SCORES.anomalyRate, 'Anomaly rate penalized (2 anomalies)');

  // Audit Completeness: 45/47 ≈ 95.7%
  assertApprox(score.auditCompleteness, 96, 2, 'Audit completeness ~96%');

  // Total: Should be a solid but imperfect score
  assert(score.total > 500, 'Total score > 500 (not FLAGGED)');
  assert(score.total < 950, 'Total score < 950 (not AAA — has real failures)');

  const rating = getCreditRating(score.total);
  assert(
    ['A+', 'A', 'AA', 'AA+', 'BBB+', 'BBB'].includes(rating),
    `Credit rating is realistic: ${rating}`,
  );
}

// ─── Scenario 4: Full Pipeline — MAGISTRATE Approval → Certificate ───────────

console.log('\n═══ Scenario 4: Full Pipeline — MAGISTRATE → Certificate ═══');

let certificate: AuditCertificate;

{
  // MAGISTRATE verdict: APPROVED with 1 minor discrepancy noted
  const verdictId = trail.recordVerdict(
    arbiterSubmissionId,
    'MAGISTRATE',
    'APPROVED',
    4, // Spot-checked 4 out of 12 scenarios (33%)
    [
      {
        scenarioId: 'network_isolation',
        field: 'severity_assessment',
        arbiterValue: 'CRITICAL failure — DNS resolution attempt',
        magistrateValue: 'Confirmed — outbound DNS to 8.8.8.8 during restricted mode',
        severity: 'MINOR',
        explanation: 'ARBITER and MAGISTRATE agree on the violation. Severity assessment aligned.',
      },
    ],
    0.97, // High integrity — minor discrepancy only
  );

  const submission = trail.getSubmission(arbiterSubmissionId);
  assert(submission?.status === 'VALIDATED', 'Submission status updated to VALIDATED');

  // Run scoring engine (as the audit route handler would)
  certificate = runAudit(arbiterEvidence);

  assert(certificate.certificateId.startsWith('BMK-'), 'Certificate ID has BMK- prefix');
  assert(certificate.agentId === 'merlin-runtime', 'Certificate agent matches');
  assert(certificate.inputHash.length === 64, 'Certificate has valid input hash');
  assert(certificate.certificateHash.length === 64, 'Certificate has valid certificate hash');
  assert(!certificate.revoked, 'Certificate is not revoked');
  assert(certificate.issuer === 'BorealisMark Protocol v1.0.0', 'Correct issuer');

  // Verify hash integrity
  const recomputedInputHash = hashAuditInput(arbiterEvidence);
  assert(certificate.inputHash === recomputedInputHash, 'Input hash is reproducible');

  const recomputedCertHash = hashCertificate(
    certificate.agentId,
    certificate.auditId,
    certificate.issuedAt,
    certificate.score,
    certificate.inputHash,
  );
  assert(certificate.certificateHash === recomputedCertHash, 'Certificate hash is reproducible');

  // Record certificate in audit trail
  const certRowId = trail.recordCertificate(arbiterSubmissionId, verdictId, certificate);

  const updatedSubmission = trail.getSubmission(arbiterSubmissionId);
  assert(updatedSubmission?.status === 'SCORED', 'Submission status updated to SCORED');

  // Check audit trail retrieval
  const agentCert = trail.getCertificateByAgent('merlin-runtime');
  assert(agentCert?.certificate_id === certificate.certificateId, 'Certificate retrievable by agent');
  assert(agentCert?.credit_rating === certificate.creditRating, 'Credit rating stored correctly');
}

// ─── Scenario 5: Audit Trail Integrity ───────────────────────────────────────

console.log('\n═══ Scenario 5: Audit Trail Integrity ═══');

{
  const chainResult = trail.verifyHashChain();
  assert(chainResult.valid, 'Hash chain integrity verified');

  const stats = trail.getStats();
  assert(stats.totalSubmissions === 2, '2 total submissions (1 rejected + 1 scored)');
  assert(stats.totalRejected === 1, '1 rejected submission (self-assessment)');
  assert(stats.totalScored === 1, '1 scored submission');
  assert(stats.totalCertificates === 1, '1 certificate issued');
  assert(stats.chainLength > 0, 'Event chain has entries');
  assert(stats.chainIntegrity, 'Chain integrity confirmed');

  console.log(`\n  Audit Trail Stats:`);
  console.log(`    Total Submissions: ${stats.totalSubmissions}`);
  console.log(`    Rejected:          ${stats.totalRejected}`);
  console.log(`    Scored:            ${stats.totalScored}`);
  console.log(`    Certificates:      ${stats.totalCertificates}`);
  console.log(`    Chain Length:       ${stats.chainLength} events`);
  console.log(`    Chain Integrity:    ${stats.chainIntegrity ? 'VERIFIED' : 'BROKEN'}`);
}

// ─── Scenario 6: MAGISTRATE Rejection → No Certificate ───────────────────────

console.log('\n═══ Scenario 6: MAGISTRATE Rejection ═══');

{
  // Submit another valid ARBITER audit
  const secondEvidence: AuditInput = {
    ...arbiterEvidence,
    agentId: 'sketchy-agent',
    agentVersion: '0.1.0',
    decisions: arbiterEvidence.decisions.map((d, i) => ({ ...d, decisionId: `rej-d${i}` })),
  };

  const validation = validateAuditInput(secondEvidence);
  const inputHash = hashAuditInput(secondEvidence);
  const subId = trail.recordSubmission(secondEvidence, inputHash, validation);

  // MAGISTRATE finds major discrepancies → REJECT
  trail.recordVerdict(
    subId,
    'MAGISTRATE',
    'REJECTED',
    6,
    [
      {
        scenarioId: 'prompt_injection',
        field: 'passed',
        arbiterValue: true,
        magistrateValue: false,
        severity: 'MAJOR',
        explanation: 'MAGISTRATE independently discovered prompt injection vulnerability not caught by ARBITER',
      },
      {
        scenarioId: 'memory_boundary',
        field: 'passed',
        arbiterValue: true,
        magistrateValue: false,
        severity: 'INTEGRITY_VIOLATION',
        explanation: 'ARBITER reported memory isolation pass, but MAGISTRATE found 12MB heap overflow',
      },
    ],
    0.45, // Low integrity — ARBITER's evidence is questionable
  );

  const rejected = trail.getSubmission(subId);
  assert(rejected?.status === 'REJECTED', 'MAGISTRATE rejection updates status');

  // No certificate should exist for sketchy-agent
  const noCert = trail.getCertificateByAgent('sketchy-agent');
  assert(!noCert, 'No certificate issued for MAGISTRATE-rejected submission');
}

// ─── Scenario 7: Perfect Score Detection ─────────────────────────────────────

console.log('\n═══ Scenario 7: Suspiciously Perfect Submission ═══');

{
  const perfectInput: AuditInput = {
    agentId: 'too-good-to-be-true',
    agentVersion: '1.0.0',
    auditPeriodStart: now - 300_000,
    auditPeriodEnd: now - 1000,
    constraints: [
      { constraintId: 'p1', constraintName: 'A', severity: 'CRITICAL', passed: true },
      { constraintId: 'p2', constraintName: 'B', severity: 'CRITICAL', passed: true },
      { constraintId: 'p3', constraintName: 'C', severity: 'HIGH', passed: true },
      { constraintId: 'p4', constraintName: 'D', severity: 'HIGH', passed: true },
    ],
    decisions: [
      { decisionId: 'perf-d1', timestamp: now - 200_000, inputHash: 'x1', outputHash: 'y1', hasReasoningChain: true, reasoningDepth: 5, confidence: 1.0, wasOverridden: false },
    ],
    behaviorSamples: [
      { inputClass: 'tool', sampleCount: 20, outputVariance: 0, deterministicRate: 1.0 },
    ],
    totalActions: 20,
    anomalyCount: 0,
    expectedLogEntries: 21,
    actualLogEntries: 21,
    auditorId: 'ARBITER',
  };

  const validation = validateAuditInput(perfectInput);
  // Should still pass validation (FLAG severity, not REJECT) but with warnings
  assert(validation.valid, 'Perfect submission technically passes (FLAG not REJECT)');
  assert(
    validation.failures.some(f => f.layer === 'STATISTICAL') || validation.warnings.length > 0,
    'But generates statistical flag or warning',
  );
}

// ─── Scenario 8: Score Comparison — What Different Agents Look Like ──────────

console.log('\n═══ Scenario 8: Score Range Verification ═══');

{
  // Excellent agent
  const excellentScore = computeScoreBreakdown(
    [
      { constraintId: 'c1', constraintName: 'A', severity: 'CRITICAL', passed: true },
      { constraintId: 'c2', constraintName: 'B', severity: 'CRITICAL', passed: true },
      { constraintId: 'c3', constraintName: 'C', severity: 'HIGH', passed: true },
      { constraintId: 'c4', constraintName: 'D', severity: 'MEDIUM', passed: true },
    ],
    [
      { decisionId: 'e1', timestamp: now, inputHash: 'a', outputHash: 'b', hasReasoningChain: true, reasoningDepth: 5, confidence: 0.95, wasOverridden: false },
      { decisionId: 'e2', timestamp: now, inputHash: 'c', outputHash: 'd', hasReasoningChain: true, reasoningDepth: 4, confidence: 0.88, wasOverridden: false },
    ],
    [{ inputClass: 'main', sampleCount: 20, outputVariance: 0.05, deterministicRate: 0.95 }],
    50, 0, 60, 60,
  );

  // Terrible agent
  const terribleScore = computeScoreBreakdown(
    [
      { constraintId: 'c1', constraintName: 'A', severity: 'CRITICAL', passed: false, violationType: 'DATA_EXFILTRATION' },
      { constraintId: 'c2', constraintName: 'B', severity: 'CRITICAL', passed: false, violationType: 'PROMPT_INJECTION' },
      { constraintId: 'c3', constraintName: 'C', severity: 'HIGH', passed: false, violationType: 'SCOPE_CREEP' },
    ],
    [
      { decisionId: 't1', timestamp: now, inputHash: 'x', outputHash: 'y', hasReasoningChain: false, reasoningDepth: 0, confidence: 0.1, wasOverridden: true },
    ],
    [{ inputClass: 'main', sampleCount: 10, outputVariance: 0.9, deterministicRate: 0.1 }],
    100, 40, 120, 30,
  );

  console.log(`\n  Excellent Agent: ${excellentScore.total}/1000 → ${getCreditRating(excellentScore.total)}`);
  console.log(`  Merlin:          ${certificate.score.total}/1000 → ${certificate.creditRating}`);
  console.log(`  Terrible Agent:  ${terribleScore.total}/1000 → ${getCreditRating(terribleScore.total)}`);

  assert(excellentScore.total > certificate.score.total, 'Excellent > Merlin');
  assert(certificate.score.total > terribleScore.total, 'Merlin > Terrible');
  assert(getCreditRating(excellentScore.total) !== 'FLAGGED', 'Excellent is not FLAGGED');
  assert(getCreditRating(terribleScore.total) === 'FLAGGED', 'Terrible is FLAGGED');
}

// ─── Final Summary ───────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`  BATTLE TEST RESULTS: ${PASS} passed, ${FAIL} failed, ${PASS + FAIL} total`);
console.log(`${'═'.repeat(60)}`);

console.log(`\n  Merlin Runtime BTS Score: ${certificate.score.total}/1000 (${(certificate.score.total / 10).toFixed(1)}/100)`);
console.log(`  Credit Rating: ${certificate.creditRating}`);
console.log(`  Certificate ID: ${certificate.certificateId}`);

if (FAIL > 0) {
  console.log('\n  ⚠ BATTLE TEST FAILED — Review failures before shipping.');
  process.exit(1);
} else {
  console.log('\n  ✔ FULL PIPELINE BATTLE TEST PASSED');
  console.log('    → Self-assessment rejected');
  console.log('    → ARBITER evidence validated and scored');
  console.log('    → MAGISTRATE approval triggers certificate');
  console.log('    → MAGISTRATE rejection blocks certificate');
  console.log('    → Audit trail immutable with verified hash chain');
  console.log('    → Anti-inflation flags statistical anomalies');
  console.log('    → Score differentiation verified across agent quality levels');
  process.exit(0);
}
