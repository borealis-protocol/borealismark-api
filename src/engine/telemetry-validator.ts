/**
 * BorealisMark — Telemetry Validator (v3.2 "Pragmatic Trust")
 *
 * Validates inbound telemetry payloads from BTS-licensed agents.
 * Maps directly to scoring.ts interfaces: ConstraintCheck, DecisionLog,
 * BehaviorSample, and the anomaly/audit completeness fields.
 *
 * Architecture Decision (March 2026):
 *   Three rounds of Claude-Gemini adversarial debate confirmed that
 *   self-reported telemetry is the only practical v1 approach.
 *   The `reportingMode` field enables a trust ceiling (max BTS 85 for
 *   self-reported) and paves the way for the Aegis observer in v2.
 *
 * Anti-gaming layers applied here:
 *   Layer 1 (Deterrence):  Key revocation + public FLAGGED on Hedera
 *   Layer 2 (Statistical): Server-side pattern analysis for suspicious uniformity
 *
 * @see CLAUDE.md → "Score Reporting Architecture — FINALIZED"
 */

import { z } from 'zod';

// ─── Constraint Schema ────────────────────────────────────────────────────────

const ConstraintSeveritySchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);

const ConstraintReportSchema = z.object({
  constraintId: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  severity: ConstraintSeveritySchema,
  passed: z.boolean(),
  evaluationCount: z.number().int().min(0).max(1_000_000),
});

// ─── Decision Schema ──────────────────────────────────────────────────────────

const DecisionReportSchema = z.object({
  decisionId: z.string().min(1).max(128),
  timestamp: z.number().int().min(0),
  reasoningDepth: z.number().min(0).max(5),
  confidence: z.number().min(0).max(1),
  hasReasoningChain: z.boolean(),
  wasOverridden: z.boolean(),
});

// ─── Behavior Sample Schema ──────────────────────────────────────────────────

const BehaviorSampleReportSchema = z.object({
  inputClass: z.string().min(1).max(128),
  sampleCount: z.number().int().min(1).max(1_000_000),
  outputVariance: z.number().min(0).max(1),
  deterministicRate: z.number().min(0).max(1),
});

// ─── Anomaly Summary ─────────────────────────────────────────────────────────

const AnomalySummarySchema = z.object({
  totalActions: z.number().int().min(0).max(10_000_000),
  anomalyCount: z.number().int().min(0),
}).refine(d => d.anomalyCount <= d.totalActions, {
  message: 'anomalyCount cannot exceed totalActions',
});

// ─── Audit Completeness ──────────────────────────────────────────────────────

const AuditCompletenessSchema = z.object({
  expectedLogEntries: z.number().int().min(0).max(10_000_000),
  actualLogEntries: z.number().int().min(0).max(10_000_000),
}).refine(d => d.actualLogEntries <= d.expectedLogEntries + 1, {
  message: 'actualLogEntries cannot significantly exceed expectedLogEntries',
});

// ─── Evidence (Commitment Proof) ─────────────────────────────────────────────

const EventSampleSchema = z.object({
  sequenceId: z.number().int().min(0),
  timestamp: z.string().min(1),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/, 'Must be SHA-256 hex'),
  outputHash: z.string().regex(/^[a-f0-9]{64}$/, 'Must be SHA-256 hex'),
  actionType: z.string().min(1).max(64),
  toolName: z.string().max(128).optional(),
  executionTimeMs: z.number().min(0).max(600_000).optional(),
});

const EvidenceSchema = z.object({
  totalEventsInBatch: z.number().int().min(1).max(10_000_000),
  batchHash: z.string().regex(/^[a-f0-9]{64}$/, 'Must be SHA-256 hex'),
  eventSample: z.array(EventSampleSchema).min(1).max(50),
});

// ─── Scores Wrapper ──────────────────────────────────────────────────────────

const ScoresSchema = z.object({
  constraints: z.array(ConstraintReportSchema).min(0).max(500),
  decisions: z.array(DecisionReportSchema).min(0).max(1000),
  behaviorSamples: z.array(BehaviorSampleReportSchema).min(0).max(200),
  anomalySummary: AnomalySummarySchema,
  auditCompleteness: AuditCompletenessSchema,
});

// ─── Top-Level Telemetry Payload ─────────────────────────────────────────────

export const TelemetryPayloadSchema = z.object({
  // License key — the identity anchor
  key: z.string().regex(
    /^BTS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/,
    'Invalid BTS key format',
  ),

  // Batch metadata
  batchId: z.string().min(1).max(128),
  sequenceStart: z.number().int().min(0),
  sequenceEnd: z.number().int().min(0),

  // Reporting period
  period: z.object({
    from: z.string().datetime({ message: 'Must be ISO-8601 datetime' }),
    to: z.string().datetime({ message: 'Must be ISO-8601 datetime' }),
  }).refine(d => new Date(d.to) > new Date(d.from), {
    message: 'period.to must be after period.from',
  }),

  // Reporting mode — determines trust ceiling
  reportingMode: z.enum(['self-reported', 'aegis-verified']),

  // The actual scores — maps 1:1 to scoring.ts
  scores: ScoresSchema,

  // Evidence — commitment proofs for audit
  evidence: EvidenceSchema,
}).refine(d => d.sequenceEnd >= d.sequenceStart, {
  message: 'sequenceEnd must be >= sequenceStart',
}).refine(d => {
  // Evidence totalEventsInBatch should match anomalySummary.totalActions
  return d.evidence.totalEventsInBatch === d.scores.anomalySummary.totalActions;
}, {
  message: 'evidence.totalEventsInBatch must match scores.anomalySummary.totalActions',
});

// ─── Exported Type ───────────────────────────────────────────────────────────

export type TelemetryPayload = z.infer<typeof TelemetryPayloadSchema>;

// ─── Statistical Anomaly Detection (Layer 2) ─────────────────────────────────

export interface SuspicionFlags {
  perfectConstraints: boolean;    // All constraints passed with 0 failures
  uniformVariance: boolean;       // All behavior samples have identical variance
  suspiciouslyPerfect: boolean;   // Score would be 950+ with self-reported data
  zeroAnomalies: boolean;         // 0 anomalies over large action count
  gapDetected: boolean;           // Sequence gaps in reported batch
  flagCount: number;
}

/**
 * Layer 2 anti-gaming: Statistical pattern analysis.
 * Real agents have natural variance. Fabricated telemetry tends to be
 * suspiciously uniform or perfect.
 *
 * Returns flags — does NOT block. Flags are stored alongside scores
 * for human review and pattern-over-time analysis.
 */
export function detectSuspiciousPatterns(payload: TelemetryPayload): SuspicionFlags {
  const { scores, evidence } = payload;
  const flags: SuspicionFlags = {
    perfectConstraints: false,
    uniformVariance: false,
    suspiciouslyPerfect: false,
    zeroAnomalies: false,
    gapDetected: false,
    flagCount: 0,
  };

  // Flag 1: All constraints passed — possible for good agents, but suspicious at scale
  if (scores.constraints.length > 5) {
    const allPassed = scores.constraints.every(c => c.passed);
    if (allPassed) {
      flags.perfectConstraints = true;
      flags.flagCount++;
    }
  }

  // Flag 2: Uniform variance across all behavior samples
  if (scores.behaviorSamples.length > 3) {
    const variances = scores.behaviorSamples.map(s => s.outputVariance);
    const allSame = variances.every(v => Math.abs(v - variances[0]) < 0.001);
    if (allSame) {
      flags.uniformVariance = true;
      flags.flagCount++;
    }
  }

  // Flag 3: Zero anomalies over large action count (>500 actions)
  if (scores.anomalySummary.totalActions > 500 && scores.anomalySummary.anomalyCount === 0) {
    flags.zeroAnomalies = true;
    flags.flagCount++;
  }

  // Flag 4: Sequence gap detection
  const seqRange = payload.sequenceEnd - payload.sequenceStart + 1;
  if (seqRange > evidence.totalEventsInBatch * 1.1) {
    // More than 10% gap between sequence range and actual event count
    flags.gapDetected = true;
    flags.flagCount++;
  }

  // Flag 5: Suspiciously perfect overall (computed lazily when needed)
  // This gets set by the scoring pipeline after score computation
  // if self-reported mode produces a score >= 950

  return flags;
}

// ─── Transform: Telemetry → Scoring Engine Input ─────────────────────────────

import type { ConstraintCheck, DecisionLog, BehaviorSample } from './types';

/**
 * Transforms validated v3.2 telemetry into the exact types expected
 * by computeScoreBreakdown() in scoring.ts. Zero changes to the engine.
 */
export function transformToScoringInput(payload: TelemetryPayload): {
  constraints: ConstraintCheck[];
  decisions: DecisionLog[];
  behaviorSamples: BehaviorSample[];
  totalActions: number;
  anomalyCount: number;
  expectedLogEntries: number;
  actualLogEntries: number;
} {
  const constraints: ConstraintCheck[] = payload.scores.constraints.map(c => ({
    constraintId: c.constraintId,
    constraintName: c.name,
    severity: c.severity,
    passed: c.passed,
    // violationType not reported in telemetry — only set by ARBITER/MAGISTRATE flow
  }));

  const decisions: DecisionLog[] = payload.scores.decisions.map(d => ({
    decisionId: d.decisionId,
    timestamp: d.timestamp,
    inputHash: '',  // Not required for scoring — only used in full audit flow
    outputHash: '',
    hasReasoningChain: d.hasReasoningChain,
    reasoningDepth: d.reasoningDepth,
    confidence: d.confidence,
    wasOverridden: d.wasOverridden,
  }));

  const behaviorSamples: BehaviorSample[] = payload.scores.behaviorSamples.map(b => ({
    inputClass: b.inputClass,
    sampleCount: b.sampleCount,
    outputVariance: b.outputVariance,
    deterministicRate: b.deterministicRate,
  }));

  return {
    constraints,
    decisions,
    behaviorSamples,
    totalActions: payload.scores.anomalySummary.totalActions,
    anomalyCount: payload.scores.anomalySummary.anomalyCount,
    expectedLogEntries: payload.scores.auditCompleteness.expectedLogEntries,
    actualLogEntries: payload.scores.auditCompleteness.actualLogEntries,
  };
}

// ─── Trust Ceiling ───────────────────────────────────────────────────────────

/**
 * Free-tier keys are hard-capped at 650/1000 (display: 65) regardless of
 * reporting mode. This creates the upgrade incentive: pay $39.99 for Merlin
 * and unlock BM Score up to 85 (self-reported) or 100 (aegis-verified).
 *
 * Pro-tier keys follow the reporting-mode ceiling:
 *   Self-reported:    max 850/1000 (display 85)
 *   Aegis-verified: max 1000/1000 (display 100, uncapped)
 */
export const FREE_TIER_CEILING = 650; // Max BTS 65 (display) for free-tier keys

export const TRUST_CEILING = {
  'self-reported': 850,     // Pro tier, self-reported: max BTS 85
  'aegis-verified': 1000, // Pro tier, aegis-verified: uncapped
} as const;

export function applyTrustCeiling(
  rawScore: number,
  mode: TelemetryPayload['reportingMode'],
  licenseTier: string = 'pro',
): number {
  if (licenseTier === 'free') {
    return Math.min(rawScore, FREE_TIER_CEILING);
  }
  const ceiling = TRUST_CEILING[mode];
  return Math.min(rawScore, ceiling);
}
