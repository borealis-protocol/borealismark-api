/**
 * auditTrail.ts — Append-only SQLite audit trail for BTS scoring pipeline.
 *
 * Implements the 4-table schema from AUDIT_TRAIL_SYSTEM.md:
 *   1. audit_submissions  — raw AuditInput from ARBITER
 *   2. audit_verdicts     — MAGISTRATE validation verdicts
 *   3. audit_certificates — issued certificates with Hedera anchoring fields
 *   4. audit_events       — granular event log for hash-chain tamper detection
 *
 * IMMUTABILITY: SQL triggers block UPDATE/DELETE on all tables.
 * Corrections are appended as new rows with `corrects_id` references.
 *
 * Hash chain: Each event row includes prev_hash for tamper detection.
 */

import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { AuditInput, AuditCertificate } from '../engine/types';
import type { ValidationResult } from '../engine/auditValidator';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AuditSubmissionRow {
  id: string;
  agent_id: string;
  agent_version: string;
  auditor_id: string;
  input_hash: string;
  raw_input: string; // JSON
  validation_result: string; // JSON
  status: 'PENDING' | 'VALIDATED' | 'REJECTED' | 'SCORED';
  submitted_at: number;
  corrects_id?: string;
}

export interface AuditVerdictRow {
  id: string;
  submission_id: string;
  validator_id: string;
  verdict: 'APPROVED' | 'REJECTED' | 'ESCALATED';
  spot_check_count: number;
  discrepancies: string; // JSON
  integrity_score: number;
  verdict_timestamp: number;
}

export interface AuditCertificateRow {
  id: string;
  submission_id: string;
  verdict_id: string;
  certificate_id: string;
  agent_id: string;
  score_total: number;
  credit_rating: string;
  certificate_hash: string;
  raw_certificate: string; // JSON
  issued_at: number;
  hcs_topic_id?: string;
  hcs_transaction_id?: string;
  hcs_sequence_number?: number;
  hcs_consensus_timestamp?: string;
  anchored_at?: number;
}

export interface AuditEventRow {
  id: string;
  event_type: string;
  entity_id: string;
  entity_type: 'SUBMISSION' | 'VERDICT' | 'CERTIFICATE';
  details: string; // JSON
  event_hash: string;
  prev_hash: string;
  created_at: number;
}

// ─── Schema Initialization ───────────────────────────────────────────────────

export function initAuditTrailSchema(db: Database.Database): void {
  db.exec(`
    -- ─── Audit Submissions ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS audit_submissions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_version TEXT NOT NULL,
      auditor_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      raw_input TEXT NOT NULL,
      validation_result TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      submitted_at INTEGER NOT NULL,
      corrects_id TEXT,
      FOREIGN KEY (corrects_id) REFERENCES audit_submissions(id)
    );

    -- ─── Audit Verdicts ────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS audit_verdicts (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      validator_id TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('APPROVED', 'REJECTED', 'ESCALATED')),
      spot_check_count INTEGER NOT NULL DEFAULT 0,
      discrepancies TEXT NOT NULL DEFAULT '[]',
      integrity_score REAL NOT NULL DEFAULT 1.0,
      verdict_timestamp INTEGER NOT NULL,
      FOREIGN KEY (submission_id) REFERENCES audit_submissions(id)
    );

    -- ─── Audit Certificates ───────────────────────────────────
    CREATE TABLE IF NOT EXISTS audit_certificates (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      verdict_id TEXT NOT NULL,
      certificate_id TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL,
      score_total INTEGER NOT NULL,
      credit_rating TEXT NOT NULL,
      certificate_hash TEXT NOT NULL,
      raw_certificate TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      hcs_topic_id TEXT,
      hcs_transaction_id TEXT,
      hcs_sequence_number INTEGER,
      hcs_consensus_timestamp TEXT,
      anchored_at INTEGER,
      FOREIGN KEY (submission_id) REFERENCES audit_submissions(id),
      FOREIGN KEY (verdict_id) REFERENCES audit_verdicts(id)
    );

    -- ─── Audit Events (hash chain) ────────────────────────────
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('SUBMISSION', 'VERDICT', 'CERTIFICATE')),
      details TEXT NOT NULL DEFAULT '{}',
      event_hash TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- ─── Indexes ──────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_submissions_agent ON audit_submissions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_status ON audit_submissions(status);
    CREATE INDEX IF NOT EXISTS idx_verdicts_submission ON audit_verdicts(submission_id);
    CREATE INDEX IF NOT EXISTS idx_certificates_agent ON audit_certificates(agent_id);
    CREATE INDEX IF NOT EXISTS idx_certificates_cert_id ON audit_certificates(certificate_id);
    CREATE INDEX IF NOT EXISTS idx_events_entity ON audit_events(entity_id, entity_type);
    CREATE INDEX IF NOT EXISTS idx_events_created ON audit_events(created_at);

    -- ─── Immutability Triggers ────────────────────────────────
    -- Block UPDATE on submissions (corrections use new rows with corrects_id)
    CREATE TRIGGER IF NOT EXISTS no_update_submissions
      BEFORE UPDATE ON audit_submissions
      WHEN OLD.status = NEW.status
      BEGIN
        SELECT RAISE(ABORT, 'audit_submissions is append-only. Use corrects_id for corrections.');
      END;

    -- Allow status transitions only: PENDING→VALIDATED, PENDING→REJECTED, VALIDATED→SCORED
    CREATE TRIGGER IF NOT EXISTS valid_status_transition
      BEFORE UPDATE OF status ON audit_submissions
      BEGIN
        SELECT CASE
          WHEN OLD.status = 'PENDING' AND NEW.status IN ('VALIDATED', 'REJECTED') THEN NULL
          WHEN OLD.status = 'VALIDATED' AND NEW.status = 'SCORED' THEN NULL
          ELSE RAISE(ABORT, 'Invalid status transition')
        END;
      END;

    -- Block DELETE on all audit tables
    CREATE TRIGGER IF NOT EXISTS no_delete_submissions
      BEFORE DELETE ON audit_submissions
      BEGIN SELECT RAISE(ABORT, 'audit_submissions is append-only'); END;

    CREATE TRIGGER IF NOT EXISTS no_delete_verdicts
      BEFORE DELETE ON audit_verdicts
      BEGIN SELECT RAISE(ABORT, 'audit_verdicts is append-only'); END;

    CREATE TRIGGER IF NOT EXISTS no_delete_certificates
      BEFORE DELETE ON audit_certificates
      BEGIN SELECT RAISE(ABORT, 'audit_certificates is append-only'); END;

    CREATE TRIGGER IF NOT EXISTS no_delete_events
      BEFORE DELETE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
  `);
}

// ─── Hash Chain ──────────────────────────────────────────────────────────────

function computeEventHash(
  eventType: string,
  entityId: string,
  details: string,
  prevHash: string,
  createdAt: number,
): string {
  const payload = JSON.stringify({ eventType, entityId, details, prevHash, createdAt });
  return createHash('sha256').update(payload).digest('hex');
}

// ─── Audit Trail Service ─────────────────────────────────────────────────────

export class AuditTrailService {
  private db: Database.Database;
  private lastEventHash: string = '0'.repeat(64); // Genesis hash

  constructor(db: Database.Database) {
    this.db = db;
    initAuditTrailSchema(db);

    // Recover last hash from existing events
    const lastEvent = this.db
      .prepare('SELECT event_hash FROM audit_events ORDER BY created_at DESC LIMIT 1')
      .get() as { event_hash: string } | undefined;
    if (lastEvent) {
      this.lastEventHash = lastEvent.event_hash;
    }
  }

  // ─── Event Logging ─────────────────────────────────────────

  private appendEvent(
    eventType: string,
    entityId: string,
    entityType: 'SUBMISSION' | 'VERDICT' | 'CERTIFICATE',
    details: Record<string, unknown> = {},
  ): string {
    const id = uuidv4();
    const createdAt = Date.now();
    const detailsJson = JSON.stringify(details);
    const eventHash = computeEventHash(eventType, entityId, detailsJson, this.lastEventHash, createdAt);

    this.db
      .prepare(
        `INSERT INTO audit_events (id, event_type, entity_id, entity_type, details, event_hash, prev_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, eventType, entityId, entityType, detailsJson, eventHash, this.lastEventHash, createdAt);

    this.lastEventHash = eventHash;
    return id;
  }

  // ─── Submissions ───────────────────────────────────────────

  recordSubmission(
    input: AuditInput,
    inputHash: string,
    validationResult: ValidationResult,
  ): string {
    const id = uuidv4();
    const now = Date.now();
    const status = validationResult.valid ? 'PENDING' : 'REJECTED';

    this.db
      .prepare(
        `INSERT INTO audit_submissions (id, agent_id, agent_version, auditor_id, input_hash, raw_input, validation_result, status, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.agentId,
        input.agentVersion,
        input.auditorId ?? 'UNKNOWN',
        inputHash,
        JSON.stringify(input),
        JSON.stringify(validationResult),
        status,
        now,
      );

    this.appendEvent(
      status === 'REJECTED' ? 'SUBMISSION_REJECTED' : 'SUBMISSION_RECEIVED',
      id,
      'SUBMISSION',
      { agentId: input.agentId, inputHash, status, failureCount: validationResult.failures.length },
    );

    return id;
  }

  // ─── Verdicts ──────────────────────────────────────────────

  recordVerdict(
    submissionId: string,
    validatorId: string,
    verdict: 'APPROVED' | 'REJECTED' | 'ESCALATED',
    spotCheckCount: number,
    discrepancies: unknown[],
    integrityScore: number,
  ): string {
    const id = uuidv4();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO audit_verdicts (id, submission_id, validator_id, verdict, spot_check_count, discrepancies, integrity_score, verdict_timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, submissionId, validatorId, verdict, spotCheckCount, JSON.stringify(discrepancies), integrityScore, now);

    // Update submission status
    const newStatus = verdict === 'APPROVED' ? 'VALIDATED' : 'REJECTED';
    this.db
      .prepare('UPDATE audit_submissions SET status = ? WHERE id = ?')
      .run(newStatus, submissionId);

    this.appendEvent('VERDICT_ISSUED', id, 'VERDICT', { submissionId, verdict, integrityScore });

    return id;
  }

  // ─── Certificates ──────────────────────────────────────────

  recordCertificate(
    submissionId: string,
    verdictId: string,
    certificate: AuditCertificate,
  ): string {
    const id = uuidv4();

    this.db
      .prepare(
        `INSERT INTO audit_certificates (id, submission_id, verdict_id, certificate_id, agent_id, score_total, credit_rating, certificate_hash, raw_certificate, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        submissionId,
        verdictId,
        certificate.certificateId,
        certificate.agentId,
        certificate.score.total,
        certificate.creditRating,
        certificate.certificateHash,
        JSON.stringify(certificate),
        certificate.issuedAt,
      );

    // Update submission status to SCORED
    this.db
      .prepare('UPDATE audit_submissions SET status = ? WHERE id = ?')
      .run('SCORED', submissionId);

    this.appendEvent('CERTIFICATE_ISSUED', id, 'CERTIFICATE', {
      certificateId: certificate.certificateId,
      agentId: certificate.agentId,
      scoreTotal: certificate.score.total,
      creditRating: certificate.creditRating,
    });

    return id;
  }

  recordHederaAnchoring(
    certificateRowId: string,
    hcsTopicId: string,
    hcsTransactionId: string,
    hcsSequenceNumber: number,
    hcsConsensusTimestamp: string,
  ): void {
    // This is a legitimate UPDATE — adding Hedera proof to an existing certificate
    this.db
      .prepare(
        `UPDATE audit_certificates
         SET hcs_topic_id = ?, hcs_transaction_id = ?, hcs_sequence_number = ?, hcs_consensus_timestamp = ?, anchored_at = ?
         WHERE id = ?`,
      )
      .run(hcsTopicId, hcsTransactionId, hcsSequenceNumber, hcsConsensusTimestamp, Date.now(), certificateRowId);

    this.appendEvent('HEDERA_ANCHORED', certificateRowId, 'CERTIFICATE', {
      hcsTopicId,
      hcsTransactionId,
      hcsSequenceNumber,
    });
  }

  // ─── Queries ───────────────────────────────────────────────

  getSubmission(id: string): AuditSubmissionRow | undefined {
    return this.db
      .prepare('SELECT * FROM audit_submissions WHERE id = ?')
      .get(id) as AuditSubmissionRow | undefined;
  }

  getSubmissionsByAgent(agentId: string, limit = 20): AuditSubmissionRow[] {
    return this.db
      .prepare('SELECT * FROM audit_submissions WHERE agent_id = ? ORDER BY submitted_at DESC LIMIT ?')
      .all(agentId, limit) as AuditSubmissionRow[];
  }

  getCertificateByAgent(agentId: string): AuditCertificateRow | undefined {
    return this.db
      .prepare('SELECT * FROM audit_certificates WHERE agent_id = ? ORDER BY issued_at DESC LIMIT 1')
      .get(agentId) as AuditCertificateRow | undefined;
  }

  getEventChain(entityId: string, limit = 50): AuditEventRow[] {
    return this.db
      .prepare('SELECT * FROM audit_events WHERE entity_id = ? ORDER BY created_at ASC LIMIT ?')
      .all(entityId, limit) as AuditEventRow[];
  }

  // ─── Integrity Verification ────────────────────────────────

  verifyHashChain(limit = 1000): { valid: boolean; brokenAt?: string } {
    const events = this.db
      .prepare('SELECT * FROM audit_events ORDER BY created_at ASC LIMIT ?')
      .all(limit) as AuditEventRow[];

    let prevHash = '0'.repeat(64);

    for (const event of events) {
      if (event.prev_hash !== prevHash) {
        return { valid: false, brokenAt: event.id };
      }
      const expectedHash = computeEventHash(
        event.event_type,
        event.entity_id,
        event.details,
        event.prev_hash,
        event.created_at,
      );
      if (event.event_hash !== expectedHash) {
        return { valid: false, brokenAt: event.id };
      }
      prevHash = event.event_hash;
    }

    return { valid: true };
  }

  // ─── Stats ─────────────────────────────────────────────────

  getStats(): {
    totalSubmissions: number;
    totalRejected: number;
    totalScored: number;
    totalCertificates: number;
    chainLength: number;
    chainIntegrity: boolean;
  } {
    const submissions = this.db.prepare('SELECT COUNT(*) as count FROM audit_submissions').get() as { count: number };
    const rejected = this.db.prepare("SELECT COUNT(*) as count FROM audit_submissions WHERE status = 'REJECTED'").get() as { count: number };
    const scored = this.db.prepare("SELECT COUNT(*) as count FROM audit_submissions WHERE status = 'SCORED'").get() as { count: number };
    const certificates = this.db.prepare('SELECT COUNT(*) as count FROM audit_certificates').get() as { count: number };
    const events = this.db.prepare('SELECT COUNT(*) as count FROM audit_events').get() as { count: number };
    const chainCheck = this.verifyHashChain();

    return {
      totalSubmissions: submissions.count,
      totalRejected: rejected.count,
      totalScored: scored.count,
      totalCertificates: certificates.count,
      chainLength: events.count,
      chainIntegrity: chainCheck.valid,
    };
  }
}
