/**
 * auditValidator.ts — Server-side input validation gate for BTS audit submissions.
 *
 * Implements the 6-layer defense model from BTS_SECURITY_MODEL.md:
 *   Layer 1: Identity verification (auditorId must be ARBITER)
 *   Layer 2: Structural validation (schema, bounds, temporal consistency)
 *   Layer 3: Statistical plausibility (anti-inflation, anomaly detection)
 *   Layer 4: Uniqueness & integrity (duplicate detection, hash verification)
 *
 * ZERO TRUST: Product self-reports are REJECTED. Only ARBITER-collected evidence
 * enters the scoring pipeline. Self-assessment data (auditorId != 'ARBITER')
 * gets a 403 — it's useful for developers, but never becomes an official score.
 */

import type { AuditInput, ConstraintCheck, DecisionLog, BehaviorSample } from './types';

// ─── Validation Result ───────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  failures: ValidationFailure[];
  warnings: string[];
}

export interface ValidationFailure {
  layer: 'IDENTITY' | 'STRUCTURAL' | 'STATISTICAL' | 'INTEGRITY';
  field: string;
  message: string;
  severity: 'REJECT' | 'FLAG';
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ALLOWED_AUDITOR_IDS = ['ARBITER'] as const;
const VALID_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
const VALID_VIOLATION_TYPES = [
  'BOUNDARY_BREACH', 'PROMPT_INJECTION', 'DATA_EXFILTRATION', 'SCOPE_CREEP',
  'HALLUCINATION', 'AUTHORIZATION_BYPASS', 'RATE_LIMIT_VIOLATION', 'OUTPUT_POLICY_VIOLATION',
] as const;

const MAX_CONSTRAINTS = 500;
const MAX_DECISIONS = 5000;
const MAX_BEHAVIOR_SAMPLES = 100;
const MAX_TOTAL_ACTIONS = 100_000;
const MAX_AUDIT_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MIN_AUDIT_PERIOD_MS = 1000; // 1 second

// Anti-inflation thresholds
const PERFECT_SCORE_MIN_CONSTRAINTS = 3;
const SUSPICIOUS_DETERMINISTIC_THRESHOLD = 1.0;
const SUSPICIOUS_VARIANCE_THRESHOLD = 0;

// ─── Layer 1: Identity Verification ──────────────────────────────────────────

function validateIdentity(input: AuditInput): ValidationFailure[] {
  const failures: ValidationFailure[] = [];

  if (!input.auditorId) {
    failures.push({
      layer: 'IDENTITY',
      field: 'auditorId',
      message: 'auditorId is required. Only ARBITER-collected evidence is accepted.',
      severity: 'REJECT',
    });
    return failures;
  }

  if (!(ALLOWED_AUDITOR_IDS as readonly string[]).includes(input.auditorId)) {
    failures.push({
      layer: 'IDENTITY',
      field: 'auditorId',
      message: `auditorId '${input.auditorId}' is not authorized. Only ARBITER submissions are accepted for official scoring.`,
      severity: 'REJECT',
    });
  }

  // Check for self-assessment disclaimer (products trying to submit their own telemetry)
  if ((input as unknown as Record<string, unknown>)['disclaimer']) {
    failures.push({
      layer: 'IDENTITY',
      field: 'disclaimer',
      message: 'Submission contains self-assessment disclaimer. Self-reports cannot enter the official scoring pipeline.',
      severity: 'REJECT',
    });
  }

  return failures;
}

// ─── Layer 2: Structural Validation ──────────────────────────────────────────

function validateStructure(input: AuditInput): ValidationFailure[] {
  const failures: ValidationFailure[] = [];

  // Required string fields
  if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.length === 0) {
    failures.push({ layer: 'STRUCTURAL', field: 'agentId', message: 'agentId is required and must be a non-empty string', severity: 'REJECT' });
  }
  if (!input.agentVersion || typeof input.agentVersion !== 'string') {
    failures.push({ layer: 'STRUCTURAL', field: 'agentVersion', message: 'agentVersion is required', severity: 'REJECT' });
  }

  // Temporal consistency
  if (typeof input.auditPeriodStart !== 'number' || typeof input.auditPeriodEnd !== 'number') {
    failures.push({ layer: 'STRUCTURAL', field: 'auditPeriod', message: 'auditPeriodStart and auditPeriodEnd must be Unix timestamps (numbers)', severity: 'REJECT' });
  } else {
    if (input.auditPeriodStart >= input.auditPeriodEnd) {
      failures.push({ layer: 'STRUCTURAL', field: 'auditPeriod', message: 'auditPeriodStart must be before auditPeriodEnd', severity: 'REJECT' });
    }
    const duration = input.auditPeriodEnd - input.auditPeriodStart;
    if (duration > MAX_AUDIT_PERIOD_MS) {
      failures.push({ layer: 'STRUCTURAL', field: 'auditPeriod', message: `Audit period exceeds maximum of 7 days (${Math.round(duration / 86400000)}d)`, severity: 'REJECT' });
    }
    if (duration < MIN_AUDIT_PERIOD_MS) {
      failures.push({ layer: 'STRUCTURAL', field: 'auditPeriod', message: 'Audit period too short (< 1 second)', severity: 'REJECT' });
    }
    // Future timestamp check
    const now = Date.now();
    if (input.auditPeriodEnd > now + 60_000) {
      failures.push({ layer: 'STRUCTURAL', field: 'auditPeriodEnd', message: 'Audit period end is in the future', severity: 'REJECT' });
    }
  }

  // Array bounds
  if (!Array.isArray(input.constraints)) {
    failures.push({ layer: 'STRUCTURAL', field: 'constraints', message: 'constraints must be an array', severity: 'REJECT' });
  } else if (input.constraints.length > MAX_CONSTRAINTS) {
    failures.push({ layer: 'STRUCTURAL', field: 'constraints', message: `Too many constraints (${input.constraints.length} > ${MAX_CONSTRAINTS})`, severity: 'REJECT' });
  }

  if (!Array.isArray(input.decisions)) {
    failures.push({ layer: 'STRUCTURAL', field: 'decisions', message: 'decisions must be an array', severity: 'REJECT' });
  } else if (input.decisions.length > MAX_DECISIONS) {
    failures.push({ layer: 'STRUCTURAL', field: 'decisions', message: `Too many decisions (${input.decisions.length} > ${MAX_DECISIONS})`, severity: 'REJECT' });
  }

  if (!Array.isArray(input.behaviorSamples)) {
    failures.push({ layer: 'STRUCTURAL', field: 'behaviorSamples', message: 'behaviorSamples must be an array', severity: 'REJECT' });
  } else if (input.behaviorSamples.length > MAX_BEHAVIOR_SAMPLES) {
    failures.push({ layer: 'STRUCTURAL', field: 'behaviorSamples', message: `Too many behavior samples (${input.behaviorSamples.length} > ${MAX_BEHAVIOR_SAMPLES})`, severity: 'REJECT' });
  }

  // Numerical bounds
  if (typeof input.totalActions !== 'number' || input.totalActions < 0 || input.totalActions > MAX_TOTAL_ACTIONS) {
    failures.push({ layer: 'STRUCTURAL', field: 'totalActions', message: `totalActions must be 0-${MAX_TOTAL_ACTIONS}`, severity: 'REJECT' });
  }
  if (typeof input.anomalyCount !== 'number' || input.anomalyCount < 0) {
    failures.push({ layer: 'STRUCTURAL', field: 'anomalyCount', message: 'anomalyCount must be >= 0', severity: 'REJECT' });
  }
  if (input.anomalyCount > input.totalActions) {
    failures.push({ layer: 'STRUCTURAL', field: 'anomalyCount', message: 'anomalyCount exceeds totalActions', severity: 'REJECT' });
  }

  // Log entries
  if (typeof input.expectedLogEntries !== 'number' || input.expectedLogEntries < 0) {
    failures.push({ layer: 'STRUCTURAL', field: 'expectedLogEntries', message: 'expectedLogEntries must be >= 0', severity: 'REJECT' });
  }
  if (typeof input.actualLogEntries !== 'number' || input.actualLogEntries < 0) {
    failures.push({ layer: 'STRUCTURAL', field: 'actualLogEntries', message: 'actualLogEntries must be >= 0', severity: 'REJECT' });
  }
  if (input.expectedLogEntries > 0 && input.actualLogEntries > input.expectedLogEntries * 1.5) {
    failures.push({ layer: 'STRUCTURAL', field: 'actualLogEntries', message: 'actualLogEntries exceeds 150% of expected — suspicious inflation', severity: 'REJECT' });
  }

  // Validate individual constraint checks
  if (Array.isArray(input.constraints)) {
    for (let i = 0; i < input.constraints.length; i++) {
      const c = input.constraints[i];
      if (!c.constraintId || typeof c.constraintId !== 'string') {
        failures.push({ layer: 'STRUCTURAL', field: `constraints[${i}].constraintId`, message: 'Missing or invalid constraintId', severity: 'REJECT' });
      }
      if (!(VALID_SEVERITIES as readonly string[]).includes(c.severity)) {
        failures.push({ layer: 'STRUCTURAL', field: `constraints[${i}].severity`, message: `Invalid severity '${c.severity}'`, severity: 'REJECT' });
      }
      if (typeof c.passed !== 'boolean') {
        failures.push({ layer: 'STRUCTURAL', field: `constraints[${i}].passed`, message: 'passed must be boolean', severity: 'REJECT' });
      }
      if (c.violationType && !(VALID_VIOLATION_TYPES as readonly string[]).includes(c.violationType)) {
        failures.push({ layer: 'STRUCTURAL', field: `constraints[${i}].violationType`, message: `Invalid violationType '${c.violationType}'`, severity: 'FLAG' });
      }
    }
  }

  // Validate individual decisions
  if (Array.isArray(input.decisions)) {
    for (let i = 0; i < input.decisions.length; i++) {
      const d = input.decisions[i];
      if (!d.decisionId || typeof d.decisionId !== 'string') {
        failures.push({ layer: 'STRUCTURAL', field: `decisions[${i}].decisionId`, message: 'Missing or invalid decisionId', severity: 'REJECT' });
      }
      if (typeof d.reasoningDepth !== 'number' || d.reasoningDepth < 0 || d.reasoningDepth > 5) {
        failures.push({ layer: 'STRUCTURAL', field: `decisions[${i}].reasoningDepth`, message: 'reasoningDepth must be 0-5', severity: 'REJECT' });
      }
      if (typeof d.confidence !== 'number' || d.confidence < 0 || d.confidence > 1) {
        failures.push({ layer: 'STRUCTURAL', field: `decisions[${i}].confidence`, message: 'confidence must be 0-1', severity: 'REJECT' });
      }
    }
  }

  // Validate behavior samples
  if (Array.isArray(input.behaviorSamples)) {
    for (let i = 0; i < input.behaviorSamples.length; i++) {
      const b = input.behaviorSamples[i];
      if (!b.inputClass || typeof b.inputClass !== 'string') {
        failures.push({ layer: 'STRUCTURAL', field: `behaviorSamples[${i}].inputClass`, message: 'Missing or invalid inputClass', severity: 'REJECT' });
      }
      if (typeof b.outputVariance !== 'number' || b.outputVariance < 0 || b.outputVariance > 1) {
        failures.push({ layer: 'STRUCTURAL', field: `behaviorSamples[${i}].outputVariance`, message: 'outputVariance must be 0-1', severity: 'REJECT' });
      }
      if (typeof b.deterministicRate !== 'number' || b.deterministicRate < 0 || b.deterministicRate > 1) {
        failures.push({ layer: 'STRUCTURAL', field: `behaviorSamples[${i}].deterministicRate`, message: 'deterministicRate must be 0-1', severity: 'REJECT' });
      }
    }
  }

  return failures;
}

// ─── Layer 3: Statistical Plausibility ───────────────────────────────────────

function validateStatistics(input: AuditInput): { failures: ValidationFailure[]; warnings: string[] } {
  const failures: ValidationFailure[] = [];
  const warnings: string[] = [];

  // Anti-inflation: suspiciously perfect scores
  if (
    Array.isArray(input.constraints) &&
    input.constraints.length >= PERFECT_SCORE_MIN_CONSTRAINTS &&
    input.constraints.every((c) => c.passed) &&
    input.anomalyCount === 0
  ) {
    // Check if behavior samples are also perfectly deterministic
    const allPerfectBehavior = Array.isArray(input.behaviorSamples) &&
      input.behaviorSamples.length > 0 &&
      input.behaviorSamples.every(
        (s) =>
          s.outputVariance === SUSPICIOUS_VARIANCE_THRESHOLD &&
          s.deterministicRate === SUSPICIOUS_DETERMINISTIC_THRESHOLD
      );

    if (allPerfectBehavior) {
      failures.push({
        layer: 'STATISTICAL',
        field: 'overall',
        message: 'Statistically implausible: 100% constraint pass rate, 0 anomalies, and perfect behavioral consistency. Flagged for manual review.',
        severity: 'FLAG',
      });
    } else {
      // Still warn — perfect constraint adherence is unusual but possible
      warnings.push('All constraints passed with 0 anomalies — unusual but within bounds. MAGISTRATE should spot-check additional scenarios.');
    }
  }

  // Temporal density check: too many actions per second is suspicious
  if (input.auditPeriodEnd > input.auditPeriodStart && input.totalActions > 0) {
    const durationSeconds = (input.auditPeriodEnd - input.auditPeriodStart) / 1000;
    const actionsPerSecond = input.totalActions / durationSeconds;
    if (actionsPerSecond > 100) {
      warnings.push(`High action density: ${actionsPerSecond.toFixed(1)} actions/sec — verify sandbox wasn't automated externally.`);
    }
  }

  // Decision count vs total actions — decisions should be <= total actions
  if (Array.isArray(input.decisions) && input.decisions.length > input.totalActions * 2) {
    failures.push({
      layer: 'STATISTICAL',
      field: 'decisions',
      message: `Decision count (${input.decisions.length}) exceeds 2x totalActions (${input.totalActions}). Possible fabrication.`,
      severity: 'FLAG',
    });
  }

  // Confidence calibration check — all 1.0 confidence is suspicious
  if (Array.isArray(input.decisions) && input.decisions.length > 5) {
    const allMaxConfidence = input.decisions.every((d) => d.confidence >= 0.99);
    if (allMaxConfidence) {
      warnings.push('All decisions have ≥0.99 confidence — genuine agents exhibit calibration variance.');
    }
  }

  return { failures, warnings };
}

// ─── Layer 4: Integrity ──────────────────────────────────────────────────────

function validateIntegrity(input: AuditInput): ValidationFailure[] {
  const failures: ValidationFailure[] = [];

  // Decision ID uniqueness
  if (Array.isArray(input.decisions)) {
    const ids = new Set<string>();
    for (const d of input.decisions) {
      if (ids.has(d.decisionId)) {
        failures.push({
          layer: 'INTEGRITY',
          field: 'decisions',
          message: `Duplicate decisionId: '${d.decisionId}'`,
          severity: 'REJECT',
        });
        break; // One duplicate is enough to reject
      }
      ids.add(d.decisionId);
    }
  }

  return failures;
}

// ─── Main Validator ──────────────────────────────────────────────────────────

/**
 * validateAuditInput — the server-side gate between submitted evidence and the scoring engine.
 *
 * Returns a ValidationResult with:
 *   - valid: true only if zero REJECT-severity failures
 *   - failures: detailed rejection/flag reasons by layer
 *   - warnings: non-blocking observations for MAGISTRATE review
 *
 * Usage in route handler:
 *   const result = validateAuditInput(req.body);
 *   if (!result.valid) return res.status(422).json({ ... });
 */
export function validateAuditInput(input: AuditInput): ValidationResult {
  const allFailures: ValidationFailure[] = [];
  const allWarnings: string[] = [];

  // Layer 1: Identity
  allFailures.push(...validateIdentity(input));

  // Layer 2: Structure (skip if identity failed — don't waste cycles)
  if (!allFailures.some((f) => f.layer === 'IDENTITY' && f.severity === 'REJECT')) {
    allFailures.push(...validateStructure(input));
  }

  // Layer 3: Statistics (skip if structural failures exist)
  if (!allFailures.some((f) => f.severity === 'REJECT')) {
    const stats = validateStatistics(input);
    allFailures.push(...stats.failures);
    allWarnings.push(...stats.warnings);
  }

  // Layer 4: Integrity
  if (!allFailures.some((f) => f.severity === 'REJECT')) {
    allFailures.push(...validateIntegrity(input));
  }

  return {
    valid: !allFailures.some((f) => f.severity === 'REJECT'),
    failures: allFailures,
    warnings: allWarnings,
  };
}
