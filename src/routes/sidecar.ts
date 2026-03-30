/**
 * Sidecar Verification Routes
 *
 * POST /v1/sidecar/request  - Request independent verification for an agent
 * GET  /v1/sidecar/status/:agentId - Check verification status for an agent
 *
 * Requires JWT auth (Merlin pro license holder).
 */

import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth, type AuthRequest } from './auth';
import { logger } from '../middleware/logger';
import {
  getAgentByIdAndOwner,
  getTelemetryCountForAgent,
  getActiveMerlinLicenseForUser,
  createSidecarRequest,
  getSidecarRequestByAgent,
} from '../db/database';

const router = Router();

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_TELEMETRY_BATCHES = 5;

// ─── POST /v1/sidecar/request ─────────────────────────────────────────────────

router.post('/request', requireAuth, (req: Request, res: Response) => {
  const user = (req as AuthRequest).user!;
  const { agentId } = req.body;

  if (!agentId || typeof agentId !== 'string') {
    res.status(400).json({ success: false, error: 'agentId is required' });
    return;
  }

  try {
    // 1. Validate agent ownership
    const agent = getAgentByIdAndOwner(agentId, user.sub);
    if (!agent) {
      res.status(404).json({ success: false, error: 'Agent not found or not owned by you' });
      return;
    }

    // 2. Validate Merlin pro license
    const license = getActiveMerlinLicenseForUser(user.sub);
    if (!license) {
      res.status(403).json({
        success: false,
        error: 'Independent verification requires an active Merlin license',
        upgrade: 'https://borealisterminal.com',
      });
      return;
    }

    // 3. Check if already sidecar-verified within 30 days
    if (agent.sidecar_verified_at && (Date.now() - (agent.sidecar_verified_at as number)) < THIRTY_DAYS_MS) {
      res.json({
        success: true,
        status: 'already_verified',
        verifiedAt: agent.sidecar_verified_at,
      });
      return;
    }

    // 4. Check for existing request within 30-day window
    const existing = getSidecarRequestByAgent(agentId, THIRTY_DAYS_MS);
    if (existing) {
      const status = existing.status as string;
      if (status === 'queued' || status === 'processing') {
        res.json({
          success: true,
          status: status,
          requestedAt: existing.requested_at,
          estimatedMinutes: 5,
        });
        return;
      }
      if (status === 'failed') {
        // Allow re-request after 30 days only
        res.status(429).json({
          success: false,
          error: 'Verification was attempted recently. You can request again after 30 days.',
          retryAfter: (existing.requested_at as number) + THIRTY_DAYS_MS,
        });
        return;
      }
      if (status === 'completed') {
        // Completed but not verified (edge case - maybe failed consensus)
        res.status(429).json({
          success: false,
          error: 'A verification was completed recently. You can request again after 30 days.',
          retryAfter: (existing.requested_at as number) + THIRTY_DAYS_MS,
        });
        return;
      }
    }

    // 5. Validate minimum telemetry
    const telemetryCount = getTelemetryCountForAgent(agentId);
    if (telemetryCount < MIN_TELEMETRY_BATCHES) {
      res.status(400).json({
        success: false,
        error: `Your agent needs at least ${MIN_TELEMETRY_BATCHES} telemetry submissions before verification. Current: ${telemetryCount}.`,
      });
      return;
    }

    // 6. Create the request
    const requestId = uuidv4();
    createSidecarRequest(requestId, agentId, user.sub);

    logger.info('Sidecar verification requested', {
      requestId,
      agentId,
      userId: user.sub,
      telemetryCount,
    });

    res.status(201).json({
      success: true,
      status: 'queued',
      requestId,
      estimatedMinutes: 5,
    });
  } catch (err: any) {
    logger.error('Sidecar request failed', { error: err.message, agentId, userId: user.sub });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── GET /v1/sidecar/status/:agentId ──────────────────────────────────────────

router.get('/status/:agentId', requireAuth, (req: Request, res: Response) => {
  const user = (req as AuthRequest).user!;
  const { agentId } = req.params;

  try {
    // Validate ownership
    const agent = getAgentByIdAndOwner(agentId, user.sub);
    if (!agent) {
      res.status(404).json({ success: false, error: 'Agent not found or not owned by you' });
      return;
    }

    // Check for sidecar verification state
    if (agent.sidecar_verified_at) {
      res.json({
        success: true,
        status: 'verified',
        verifiedAt: agent.sidecar_verified_at,
        trustSource: 'sidecar-verified',
      });
      return;
    }

    // Check for pending/recent request
    const request = getSidecarRequestByAgent(agentId, THIRTY_DAYS_MS);
    if (request) {
      res.json({
        success: true,
        status: request.status,
        requestedAt: request.requested_at,
        completedAt: request.completed_at ?? null,
        ...(request.status === 'failed' ? { canRetryAfter: (request.requested_at as number) + THIRTY_DAYS_MS } : {}),
      });
      return;
    }

    // No verification ever requested
    const telemetryCount = getTelemetryCountForAgent(agentId);
    const license = getActiveMerlinLicenseForUser(user.sub);
    res.json({
      success: true,
      status: 'not_requested',
      eligible: !!license && telemetryCount >= MIN_TELEMETRY_BATCHES,
      telemetryCount,
      hasMerlinLicense: !!license,
      minTelemetry: MIN_TELEMETRY_BATCHES,
    });
  } catch (err: any) {
    logger.error('Sidecar status check failed', { error: err.message, agentId });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
