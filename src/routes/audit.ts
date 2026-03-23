/**
 * audit.ts — API routes for BTS audit submission pipeline.
 *
 * Endpoints:
 *   POST   /v1/audit/submit         Submit AuditInput from ARBITER → validate → store
 *   POST   /v1/audit/verdict        Record MAGISTRATE verdict → trigger scoring if APPROVED
 *   GET    /v1/audit/submission/:id  Retrieve submission details
 *   GET    /v1/audit/agent/:agentId  Retrieve audit history for an agent
 *   GET    /v1/audit/certificate/:id Retrieve certificate by agent
 *   GET    /v1/audit/stats           Audit trail statistics
 *   GET    /v1/audit/chain/verify    Verify hash chain integrity
 *
 * Security:
 *   - All routes require API key with 'audit' scope
 *   - Submit endpoint runs full 4-layer validation (auditValidator.ts)
 *   - Self-assessment submissions (auditorId != ARBITER) are rejected at Layer 1
 *   - All operations are recorded in append-only audit trail with hash chain
 */

import { Router, type Request, type Response } from 'express';
import { requireApiKey, requireScope } from '../middleware/auth';
import { validateAuditInput } from '../engine/auditValidator';
import { hashAuditInput, runAudit } from '../engine/audit-engine';
import { AuditTrailService } from '../services/auditTrail';
import { events as eventBus, emit as emitEvent } from '../services/eventBus';
import { getDb } from '../db/database';
import { logger } from '../middleware/logger';
import type { AuditInput } from '../engine/types';

const router = Router();

// ─── Lazy-init audit trail service ───────────────────────────────────────────

let _auditTrail: AuditTrailService | null = null;

function getAuditTrail(): AuditTrailService {
  if (!_auditTrail) {
    _auditTrail = new AuditTrailService(getDb());
  }
  return _auditTrail;
}

// ─── POST /submit — ARBITER submits audit evidence ──────────────────────────

router.post(
  '/submit',
  requireApiKey,
  requireScope('audit'),
  (req: Request, res: Response): void => {
    try {
      const input = req.body as AuditInput;
      const trail = getAuditTrail();

      // Run 4-layer validation
      const validation = validateAuditInput(input);

      if (!validation.valid) {
        // Record rejection in audit trail (for forensics)
        const submissionId = trail.recordSubmission(input, 'REJECTED_BEFORE_HASH', validation);

        logger.warn('Audit submission rejected', {
          submissionId,
          agentId: input.agentId,
          auditorId: input.auditorId,
          failures: validation.failures,
        });

        res.status(422).json({
          success: false,
          error: 'Audit input validation failed',
          submissionId,
          failures: validation.failures,
          timestamp: Date.now(),
        });
        return;
      }

      // Compute input hash
      const inputHash = hashAuditInput(input);

      // Record valid submission
      const submissionId = trail.recordSubmission(input, inputHash, validation);

      logger.info('Audit submission accepted', {
        submissionId,
        agentId: input.agentId,
        inputHash,
        warningCount: validation.warnings.length,
      });

      res.status(201).json({
        success: true,
        data: {
          submissionId,
          inputHash,
          status: 'PENDING',
          warnings: validation.warnings,
          message: 'Submission accepted. Awaiting MAGISTRATE verdict.',
        },
        timestamp: Date.now(),
      });
    } catch (err) {
      logger.error('Audit submission error', { error: (err as Error).message });
      res.status(500).json({
        success: false,
        error: 'Internal error processing audit submission',
        timestamp: Date.now(),
      });
    }
  },
);

// ─── POST /verdict — MAGISTRATE submits validation verdict ──────────────────

router.post(
  '/verdict',
  requireApiKey,
  requireScope('audit'),
  (req: Request, res: Response): void => {
    try {
      const {
        submissionId,
        validatorId,
        verdict,
        spotCheckCount,
        discrepancies,
        integrityScore,
      } = req.body;

      const trail = getAuditTrail();

      // Verify submission exists and is PENDING
      const submission = trail.getSubmission(submissionId);
      if (!submission) {
        res.status(404).json({ success: false, error: 'Submission not found', timestamp: Date.now() });
        return;
      }
      if (submission.status !== 'PENDING') {
        res.status(409).json({
          success: false,
          error: `Submission is already ${submission.status}. Cannot re-verdict.`,
          timestamp: Date.now(),
        });
        return;
      }

      // Validate verdict values
      if (!['APPROVED', 'REJECTED', 'ESCALATED'].includes(verdict)) {
        res.status(400).json({ success: false, error: 'Invalid verdict. Must be APPROVED, REJECTED, or ESCALATED.', timestamp: Date.now() });
        return;
      }

      // Record verdict
      const verdictId = trail.recordVerdict(
        submissionId,
        validatorId || 'MAGISTRATE',
        verdict,
        spotCheckCount || 0,
        discrepancies || [],
        integrityScore ?? 1.0,
      );

      // If APPROVED → run scoring engine → issue certificate
      if (verdict === 'APPROVED') {
        const rawInput = JSON.parse(submission.raw_input) as AuditInput;
        const certificate = runAudit(rawInput);

        const certRowId = trail.recordCertificate(submissionId, verdictId, certificate);

        // Emit to event bus for Hedera anchoring
        emitEvent({
          eventType: 'audit.certificateIssued',
          category: 'audit',
          actorType: 'system',
          payload: { certificateRowId: certRowId, certificate },
        });

        logger.info('Audit certificate issued', {
          certificateId: certificate.certificateId,
          agentId: certificate.agentId,
          scoreTotal: certificate.score.total,
          creditRating: certificate.creditRating,
        });

        res.status(201).json({
          success: true,
          data: {
            verdictId,
            verdict: 'APPROVED',
            certificate: {
              certificateId: certificate.certificateId,
              agentId: certificate.agentId,
              score: certificate.score,
              creditRating: certificate.creditRating,
              certificateHash: certificate.certificateHash,
            },
          },
          timestamp: Date.now(),
        });
        return;
      }

      // REJECTED or ESCALATED
      logger.info('Audit verdict recorded', { verdictId, submissionId, verdict });

      res.status(200).json({
        success: true,
        data: {
          verdictId,
          verdict,
          submissionId,
          message: verdict === 'ESCALATED'
            ? 'Submission escalated for manual review.'
            : 'Submission rejected by MAGISTRATE.',
        },
        timestamp: Date.now(),
      });
    } catch (err) {
      logger.error('Verdict processing error', { error: (err as Error).message });
      res.status(500).json({
        success: false,
        error: 'Internal error processing verdict',
        timestamp: Date.now(),
      });
    }
  },
);

// ─── GET /submission/:id ────────────────────────────────────────────────────

router.get(
  '/submission/:id',
  requireApiKey,
  requireScope('audit'),
  (req: Request, res: Response): void => {
    const trail = getAuditTrail();
    const submission = trail.getSubmission(req.params.id);

    if (!submission) {
      res.status(404).json({ success: false, error: 'Submission not found', timestamp: Date.now() });
      return;
    }

    res.json({
      success: true,
      data: {
        ...submission,
        raw_input: JSON.parse(submission.raw_input),
        validation_result: JSON.parse(submission.validation_result),
      },
      timestamp: Date.now(),
    });
  },
);

// ─── GET /agent/:agentId — audit history ────────────────────────────────────

router.get(
  '/agent/:agentId',
  requireApiKey,
  requireScope('read'),
  (req: Request, res: Response): void => {
    const trail = getAuditTrail();
    const submissions = trail.getSubmissionsByAgent(req.params.agentId);
    const certificate = trail.getCertificateByAgent(req.params.agentId);

    res.json({
      success: true,
      data: {
        agentId: req.params.agentId,
        submissionCount: submissions.length,
        submissions: submissions.map((s) => ({
          id: s.id,
          status: s.status,
          inputHash: s.input_hash,
          submittedAt: s.submitted_at,
        })),
        latestCertificate: certificate
          ? {
              certificateId: certificate.certificate_id,
              scoreTotal: certificate.score_total,
              creditRating: certificate.credit_rating,
              issuedAt: certificate.issued_at,
              anchored: !!certificate.hcs_transaction_id,
            }
          : null,
      },
      timestamp: Date.now(),
    });
  },
);

// ─── GET /stats ─────────────────────────────────────────────────────────────

router.get(
  '/stats',
  requireApiKey,
  requireScope('audit'),
  (_req: Request, res: Response): void => {
    const trail = getAuditTrail();
    const stats = trail.getStats();

    res.json({
      success: true,
      data: stats,
      timestamp: Date.now(),
    });
  },
);

// ─── GET /chain/verify — hash chain integrity check ─────────────────────────

router.get(
  '/chain/verify',
  requireApiKey,
  requireScope('admin'),
  (_req: Request, res: Response): void => {
    const trail = getAuditTrail();
    const result = trail.verifyHashChain();

    res.json({
      success: true,
      data: {
        chainIntegrity: result.valid,
        brokenAt: result.brokenAt ?? null,
        verifiedAt: Date.now(),
      },
      timestamp: Date.now(),
    });
  },
);

export default router;
