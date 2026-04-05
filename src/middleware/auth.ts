import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { validateApiKey } from '../db/database';
import { logger } from './logger';

// ─── Extended Request Types ────────────────────────────────────────────────────

export interface AuthenticatedRequest extends Request {
  apiKey: {
    id: string;
    name: string;
    scopes: string[];
  };
  requestId: string;
}

export interface AuthRequest extends Request {
  userId?: string;
}

// ─── JWT Helpers (for user-facing OS endpoints) ───────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key';

export function getUserFromToken(token?: string): string | null {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    return decoded.userId || decoded.id || decoded.sub;
  } catch {
    return null;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    res.status(401).json({ success: false, error: 'Missing authorization token' });
    return;
  }
  const userId = getUserFromToken(token);
  if (!userId) {
    res.status(401).json({ success: false, error: 'Invalid authorization token' });
    return;
  }
  (req as AuthRequest).userId = userId;
  next();
}

export function requireMasterKey(req: Request, res: Response, next: NextFunction): void {
  const masterKey = req.headers['x-master-key'] as string;
  const expectedKey = process.env.API_MASTER_KEY || 'bm-master-x9k2m5p7q1r4s8t6v3w0y5z2a4b6c8d0';
  if (masterKey !== expectedKey) {
    res.status(403).json({ success: false, error: 'Forbidden' });
    return;
  }
  next();
}

// ─── Authentication Middleware ─────────────────────────────────────────────────

/**
 * requireApiKey — validates X-Api-Key or Authorization: Bearer header.
 * On success, attaches apiKey metadata to req for downstream scope checks.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const rawKey =
    (req.headers['x-api-key'] as string) ??
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : undefined);

  if (!rawKey) {
    res.status(401).json({
      success: false,
      error: 'Missing API key. Provide via X-Api-Key header or Authorization: Bearer <key>',
      timestamp: Date.now(),
    });
    return;
  }

  const keyInfo = validateApiKey(rawKey);

  if (!keyInfo) {
    res.status(403).json({
      success: false,
      error: 'Invalid, expired, or revoked API key',
      timestamp: Date.now(),
    });
    return;
  }

  // Attach to request for downstream handlers
  (req as AuthenticatedRequest).apiKey = keyInfo;
  next();
}

// ─── Scope Guard ──────────────────────────────────────────────────────────────

/**
 * requireScope — ensures the authenticated key has the required permission.
 * Must be used AFTER requireApiKey.
 *
 * Scope hierarchy:
 *   admin  → can do everything (create/revoke keys, manage webhooks, run audits, write, read)
 *   audit  → can register agents and run audits
 *   write  → can upload images and modify resources
 *   webhook → can manage webhooks
 *   read   → can retrieve certificates and scores
 */
export function requireScope(scope: 'audit' | 'read' | 'write' | 'webhook' | 'admin') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authReq = req as AuthenticatedRequest;
    const { scopes } = authReq.apiKey;

    // admin scope grants all permissions
    if (scopes.includes('admin') || scopes.includes(scope)) {
      next();
      return;
    }

    res.status(403).json({
      success: false,
      error: `Insufficient permissions. Required scope: '${scope}'.`,
      timestamp: Date.now(),
    });
  };
}
