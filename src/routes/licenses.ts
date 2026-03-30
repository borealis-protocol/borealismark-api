/**
 * BorealisMark — Merlin License Key Engine
 *
 * The BTS License Key IS the product. The runtime is the delivery vehicle.
 * Each purchase generates a unique cryptographic key that connects one AI agent
 * to the Borealis Trust Network for scoring, Hedera anchoring, and verification.
 *
 * Revoke the key → the runtime becomes inert. No score, no verification, no proof.
 *
 * PERMANENT BINDING RULES:
 *   - 1 key = 1 agent. Permanent. No swapping.
 *   - If a user needs a new key, the old key AND its bound agent are TERMINATED.
 *   - Terminated agents and keys stay in the database with full history preserved.
 *   - All future lookups for terminated agents return "terminated" with dated history.
 *   - AGENT SLOT cap is TIER-BASED: standard=3, pro=10, elite=20. Each agent needs its own key.
 *   - Users can purchase UNLIMITED keys — the cap is on agent slots, not keys.
 *   - An unbound key is just a key waiting to be activated.
 *   - No exceptions. Trust is not transferable.
 *
 * Endpoints:
 *   POST   /v1/licenses/generate          — Generate key on purchase (admin/internal)
 *   POST   /v1/licenses/activate           — Bind key to agent (auto-registers if needed)
 *   POST   /v1/licenses/verify             — Runtime heartbeat + score check
 *   GET    /v1/licenses/public/:agentId    — Public verification lookup
 *   GET    /v1/licenses/my                 — User's license(s)
 *   POST   /v1/licenses/:id/replace       — User: terminate old key+agent, issue new key
 *   POST   /v1/licenses/:id/revoke        — Admin: revoke key (terminates agent)
 *   POST   /v1/licenses/:id/suspend       — Admin: suspend key
 *   POST   /v1/licenses/:id/restore       — Admin: restore key
 *   GET    /v1/licenses/audit              — Admin: audit dashboard
 */

import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import rateLimit from 'express-rate-limit';
import { getDb } from '../db/database';
import { requireApiKey, requireScope } from '../middleware/auth';
import { requireAuth, type AuthRequest, type JwtPayload } from './auth';
import { auditLog, logger } from '../middleware/logger';
import {
  sendBTSKeyEmail,
  sendKeyRevocationEmail,
  sendKeySuspensionEmail,
  sendKeyRestorationEmail,
  sendAdminFreeKeyNotification,
} from '../services/email';
import type { AuthenticatedRequest } from '../middleware/auth';
import type { Request, Response } from 'express';

const publicBtsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      success: false,
      error: 'Rate limit exceeded. Max 30 requests per minute.',
      code: 'RATE_LIMIT_EXCEEDED',
      timestamp: Date.now(),
    });
  },
});

const router = Router();

// ─── Constants ────────────────────────────────────────────────────────────────

const KEY_PREFIX = 'BTS';
const KEY_SEGMENTS = 4;
const SEGMENT_LENGTH = 4;
const VALID_STATUSES = ['active', 'suspended', 'revoked', 'terminated', 'inactive'] as const;
const RATE_LIMIT_PER_KEY_PER_HOUR = 100;
const INACTIVITY_THRESHOLD_DAYS = 90;

// Agent caps per user tier — users must upgrade to unlock more agent slots
const TIER_AGENT_LIMITS: Record<string, number> = {
  free: 1,       // Free tier: 1 agent (score capped at 65)
  standard: 3,   // Standard tier: 3 agents
  pro: 10,       // Pro tier ($149/yr): 10 agents
  elite: 20,     // Elite tier ($349/yr): 20 agents
};

// BTS License Key tier — determines trust score ceiling at telemetry time
// free  = no payment, max BM Score 65, hard cap of 1 active free key per email
// pro   = $39.99 one-time, max BM Score 85 (self-reported) / 100 (sidecar)
const LICENSE_TIER_SCORE_CEILING: Record<string, number> = {
  free: 65,
  pro: 85,   // Self-reported ceiling; sidecar-verified is uncapped at 100
};

// ─── Key Generation ───────────────────────────────────────────────────────────

/**
 * Generate a cryptographically secure BTS License Key.
 * Format: BTS-XXXX-XXXX-XXXX-XXXX (alphanumeric uppercase)
 * Returns { rawKey, keyHash, keyPrefix }
 *
 * The raw key is shown ONCE to the customer. Only the SHA-256 hash is stored.
 */
function generateBTSKey(): { rawKey: string; keyHash: string; keyPrefix: string } {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No 0/O/1/I confusion
  const segments: string[] = [];

  for (let s = 0; s < KEY_SEGMENTS; s++) {
    let segment = '';
    const bytes = crypto.randomBytes(SEGMENT_LENGTH);
    for (let i = 0; i < SEGMENT_LENGTH; i++) {
      segment += charset[bytes[i] % charset.length];
    }
    segments.push(segment);
  }

  const rawKey = `${KEY_PREFIX}-${segments.join('-')}`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = `${KEY_PREFIX}-${segments[0]}`;

  return { rawKey, keyHash, keyPrefix };
}

/**
 * Hash a raw key for lookup.
 */
function hashKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Generate a BTS license key for a user and persist it to the database.
 * Called internally by the Stripe webhook handler on purchase completion.
 * Returns the raw key (shown ONCE — caller is responsible for delivering it).
 */
export function generateLicenseInternal(params: {
  userId: string;
  orderId?: string;
  purchasePrice?: number;
  purchaseCurrency?: string;
  paymentMethod?: 'stripe' | 'usdc';
}): { licenseId: string; rawKey: string; keyPrefix: string } {
  const db = getDb();
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(params.userId) as any;
  if (!user) {
    throw new Error(`User not found: ${params.userId}`);
  }

  const { rawKey, keyHash, keyPrefix } = generateBTSKey();
  const licenseId = uuid();
  const now = Date.now();

  db.prepare(`
    INSERT INTO merlin_licenses (
      id, key_hash, key_prefix, user_id, status, order_id,
      purchase_price, purchase_currency, payment_method, created_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
  `).run(
    licenseId,
    keyHash,
    keyPrefix,
    params.userId,
    params.orderId ?? null,
    params.purchasePrice ?? 39.99,
    params.purchaseCurrency ?? 'USD',
    params.paymentMethod ?? 'stripe',
    now,
  );

  logLicenseEvent(licenseId, 'license.generated', {
    userId: params.userId,
    orderId: params.orderId,
    purchasePrice: params.purchasePrice,
    paymentMethod: params.paymentMethod,
    keyPrefix,
    source: 'stripe-webhook',
  }, 'stripe-webhook');

  return { licenseId, rawKey, keyPrefix };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function logLicenseEvent(
  licenseId: string,
  eventType: string,
  eventData: Record<string, any> | null,
  actor: string,
  ipAddress?: string,
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO license_audit_log (id, license_id, event_type, event_data, actor, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(uuid(), licenseId, eventType, eventData ? JSON.stringify(eventData) : null, actor, ipAddress || null, Date.now());
}

function getClientIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
}

/**
 * Terminate an agent — marks it as terminated with a reason.
 * The agent record stays in the database with full history preserved.
 * All future BTS score lookups return "terminated" with dated history.
 */
function terminateAgent(
  agentId: string,
  reason: string,
  terminatedBy: string,
): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    UPDATE agents
    SET active = 0, status = 'terminated', public_listing = 0, terminated_at = ?, termination_reason = ?, terminated_by = ?
    WHERE id = ?
  `).run(now, reason, terminatedBy, agentId);
}

/**
 * Terminate a license — marks it with a terminal status and reason.
 * The license record stays in the database with full audit trail.
 */
function terminateLicense(
  licenseId: string,
  status: 'revoked' | 'terminated',
  reason: string,
  actor: string,
  ip?: string,
): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    UPDATE merlin_licenses
    SET status = ?, status_reason = ?, revoked_at = ?
    WHERE id = ?
  `).run(status, reason, now, licenseId);

  logLicenseEvent(licenseId, `license.${status}`, { reason }, actor, ip);
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const GenerateSchema = z.object({
  userId: z.string().min(1),
  orderId: z.string().optional(),
  purchasePrice: z.number().default(39.99),
  purchaseCurrency: z.string().default('USD'),
  paymentMethod: z.enum(['stripe', 'usdc']).default('stripe'),
});

const ActivateSchema = z.object({
  key: z.string().regex(/^BTS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/, 'Invalid BTS key format'),
  // Either provide an existing agentId OR provide agent details for auto-registration
  agentId: z.string().min(1).optional(),
  agentName: z.string().min(2).max(100).optional(),
  agentDescription: z.string().max(500).optional(),
  agentVersion: z.string().default('1.0.0'),
  // User MUST acknowledge permanent binding — this is not optional
  confirmPermanentBinding: z.literal(true, {
    errorMap: () => ({
      message: 'You must set confirmPermanentBinding to true. Binding a BTS key to an agent is PERMANENT and cannot be undone. If you later need a new key, both this key AND the bound agent will be terminated.',
    }),
  }),
}).refine(
  (data) => data.agentId || data.agentName,
  { message: 'Either agentId (existing agent) or agentName (auto-register) is required' }
);

const ReplaceSchema = z.object({
  reason: z.string().min(1).max(500),
  newAgentName: z.string().min(2).max(100).optional(),
  newAgentDescription: z.string().max(500).optional(),
  // User MUST acknowledge that replacement kills both key AND agent
  confirmTermination: z.literal(true, {
    errorMap: () => ({
      message: 'You must set confirmTermination to true. Replacing a key will PERMANENTLY TERMINATE both the current key AND its bound agent. All trust scores for the terminated agent will be marked as terminated on the public record. This action cannot be undone.',
    }),
  }),
});

const VerifySchema = z.object({
  key: z.string().regex(/^BTS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/, 'Invalid BTS key format'),
});

const AdminActionSchema = z.object({
  reason: z.string().min(1).max(500),
});

const FreeKeySchema = z.object({
  email: z.string().email('Must be a valid email address').max(255),
  agent_name: z.string().min(1).max(100).optional(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /v1/licenses/free — Claim a free-tier BTS License Key
// No payment required. Requires only an email address.
// Rate limit: max 1 free key per email, ever.
// Free tier: 1 agent slot, BM Score capped at 65.
// Key is delivered by email. Account auto-created if email is new.
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/free', publicBtsLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = FreeKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
        timestamp: Date.now(),
      });
      return;
    }

    const { email, agent_name } = parsed.data;
    const db = getDb();

    // Optional admin bypass: if a valid JWT with role=admin is in the Authorization header,
    // skip the 1-per-email limit so admins can issue multiple free keys (e.g. for internal agents).
    let isAdmin = false;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET || '') as JwtPayload;
        if (decoded.role === 'admin') {
          isAdmin = true;
        }
      } catch {
        // Invalid/expired token — not an error, just not an admin request
      }
    }

    // Check if email already has a free key (1 per email, ever) — bypass for admins
    const existingFreeKey = !isAdmin && db.prepare(`
      SELECT ml.id FROM merlin_licenses ml
      JOIN users u ON ml.user_id = u.id
      WHERE u.email = ? COLLATE NOCASE
        AND ml.license_tier = 'free'
        AND ml.status NOT IN ('revoked', 'terminated')
    `).get(email) as any;

    if (existingFreeKey) {
      res.status(409).json({
        success: false,
        error: 'FREE_KEY_ALREADY_CLAIMED',
        message: 'A free BTS key has already been issued to this email address. Each email is limited to one free key.',
        timestamp: Date.now(),
      });
      return;
    }

    // Look up or auto-create user for this email
    let user = db.prepare('SELECT id, email, name FROM users WHERE email = ? COLLATE NOCASE').get(email) as any;

    if (!user) {
      const userId = uuid();
      const now = Date.now();
      // Auto-create account with random password hash - they can set a password via forgot-password flow
      const randomPasswordHash = crypto.randomBytes(32).toString('hex');
      const nameFromEmail = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, ' ').trim() || 'Borealis User';

      db.prepare(`
        INSERT INTO users (id, email, password_hash, name, tier, role, created_at, email_verified, active)
        VALUES (?, ?, ?, ?, 'standard', 'user', ?, 0, 1)
      `).run(userId, email.toLowerCase(), randomPasswordHash, nameFromEmail, now);

      user = { id: userId, email: email.toLowerCase(), name: nameFromEmail };
    }

    // Generate free-tier BTS key
    const { rawKey, keyHash, keyPrefix } = generateBTSKey();
    const licenseId = uuid();
    const now = Date.now();

    db.prepare(`
      INSERT INTO merlin_licenses (
        id, key_hash, key_prefix, user_id, status,
        purchase_price, purchase_currency, payment_method,
        license_tier, created_at
      ) VALUES (?, ?, ?, ?, 'active', 0, 'USD', 'free', 'free', ?)
    `).run(licenseId, keyHash, keyPrefix, user.id, now);

    logLicenseEvent(licenseId, 'license.generated', {
      userId: user.id,
      purchasePrice: 0,
      paymentMethod: 'free',
      licenseTier: 'free',
      keyPrefix,
      source: isAdmin ? 'admin-free-issue' : 'free-tier-claim',
      ...(agent_name ? { agentName: agent_name } : {}),
    }, isAdmin ? 'admin' : 'free-tier', getClientIp(req));

    // Email the key - raw key is transmitted exactly once
    const delivered = await sendBTSKeyEmail(email, user.name || 'there', rawKey, keyPrefix);

    if (!delivered) {
      // Key was created but email failed — log internally for support retrieval, never expose in response
      logger.warn('BTS free key email delivery failed — contact support with licenseId to retrieve key', {
        licenseId,
        keyPrefix,
        email,
        userId: user.id,
      });
      res.status(201).json({
        success: true,
        data: {
          licenseId,
          keyPrefix,
          licenseTier: 'free',
          scoreCeiling: 65,
          agentSlots: 1,
          status: 'active',
          emailDelivered: false,
        },
        message: 'Your key was generated but email delivery failed. Please contact support@borealisprotocol.ai to retrieve your key.',
        timestamp: Date.now(),
      });
      return;
    }

    // Admin notification (fire-and-forget)
    sendAdminFreeKeyNotification(email, keyPrefix, licenseId)
      .catch((e: Error) => logger.warn('Admin free key notification failed', { error: e.message }));

    res.status(201).json({
      success: true,
      data: {
        licenseId,
        keyPrefix,
        licenseTier: 'free',
        scoreCeiling: 65,
        agentSlots: 1,
        status: 'active',
        emailDelivered: true,
      },
      message: 'Free BTS key sent to ' + email + '. Check your inbox.',
      timestamp: Date.now(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to generate free license', timestamp: Date.now() });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /v1/licenses/generate — Create a new BTS License Key
// Called internally on purchase completion. Requires admin API key.
// Returns the raw key ONCE — it cannot be recovered after this response.
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/generate', requireApiKey, requireScope('admin'), (req: Request, res: Response) => {
  try {
    const parsed = GenerateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
        timestamp: Date.now(),
      });
      return;
    }

    const { userId, orderId, purchasePrice, purchaseCurrency, paymentMethod } = parsed.data;
    const db = getDb();

    // Verify user exists
    const user = db.prepare('SELECT id, email, tier FROM users WHERE id = ?').get(userId) as any;
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found', timestamp: Date.now() });
      return;
    }

    // No cap on key purchases — users can buy unlimited BTS keys.
    // The cap is on AGENT SLOTS (tier-based), enforced at activation time.
    // A key without an agent is just an unbound key waiting to be activated.

    // Generate the key
    const { rawKey, keyHash, keyPrefix } = generateBTSKey();
    const licenseId = uuid();
    const now = Date.now();

    db.prepare(`
      INSERT INTO merlin_licenses (
        id, key_hash, key_prefix, user_id, status, order_id,
        purchase_price, purchase_currency, payment_method, created_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `).run(licenseId, keyHash, keyPrefix, userId, orderId || null, purchasePrice, purchaseCurrency, paymentMethod, now);

    // Audit log
    logLicenseEvent(licenseId, 'license.generated', {
      userId,
      orderId,
      purchasePrice,
      purchaseCurrency,
      paymentMethod,
      keyPrefix,
    }, 'system', getClientIp(req));

    const authReq = req as AuthenticatedRequest;
    auditLog('license.generated', authReq.apiKey.id, { licenseId, userId, keyPrefix });

    res.status(201).json({
      success: true,
      data: {
        licenseId,
        key: rawKey,
        keyPrefix,
        status: 'active',
        userId,
        createdAt: now,
        warning: 'Store this BTS License Key securely. It will NOT be shown again.',
        importantNotice: 'When you activate this key by binding it to an agent, that binding is PERMANENT. The key cannot be transferred to a different agent. If you later need a new key, both the key and the bound agent will be permanently terminated. Choose your agent carefully.',
      },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to generate license', timestamp: Date.now() });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /v1/licenses/activate — Bind a key to an agent. PERMANENT.
// Called by the Merlin runtime on first launch. 1 key → 1 agent, forever.
// Supports two modes:
//   1. Provide agentId → binds to existing registered agent
//   2. Provide agentName → auto-registers a new agent and binds in one step
// Once bound, the key CANNOT be moved to another agent. No exceptions.
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/activate', (req: Request, res: Response) => {
  try {
    const parsed = ActivateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
        timestamp: Date.now(),
      });
      return;
    }

    const { key, agentId, agentName, agentDescription, agentVersion } = parsed.data;
    const db = getDb();
    const kHash = hashKey(key);
    const ip = getClientIp(req);

    // Find license by key hash
    const license = db.prepare(
      'SELECT * FROM merlin_licenses WHERE key_hash = ?'
    ).get(kHash) as any;

    if (!license) {
      res.status(404).json({ success: false, error: 'Invalid BTS License Key', timestamp: Date.now() });
      return;
    }

    if (license.status === 'revoked' || license.status === 'terminated') {
      res.status(403).json({
        success: false,
        error: `This license has been ${license.status}. ${license.status_reason || ''}`.trim(),
        timestamp: Date.now(),
      });
      return;
    }

    if (license.status === 'suspended') {
      res.status(403).json({ success: false, error: 'This license is suspended. Contact support.', timestamp: Date.now() });
      return;
    }

    if (license.status !== 'active') {
      res.status(403).json({ success: false, error: `License status: ${license.status}`, timestamp: Date.now() });
      return;
    }

    // Already activated — PERMANENT binding, no changes allowed
    if (license.agent_id) {
      if (license.agent_id === (agentId || '')) {
        res.status(200).json({
          success: true,
          data: {
            licenseId: license.id,
            agentId: license.agent_id,
            status: 'active',
            message: 'License already activated for this agent. Binding is permanent.',
            activatedAt: license.activated_at,
          },
          timestamp: Date.now(),
        });
        return;
      }
      // Different agent — HARD NO. Permanent binding.
      res.status(409).json({
        success: false,
        error: 'This license is permanently bound to another agent. One key, one agent, no exceptions. Use the replacement endpoint if you need a new key.',
        boundAgentId: license.agent_id,
        timestamp: Date.now(),
      });
      return;
    }

    // AGENT SLOT cap — users can hold unlimited keys, but can only BIND them
    // to as many agents as their tier allows. The cap is on agent slots, not keys.
    const user = db.prepare('SELECT tier, email_verified FROM users WHERE id = ?').get(license.user_id) as any;

    // Email must be verified before activating a license
    if (!user?.email_verified) {
      res.status(403).json({
        success: false,
        error: 'Email verification required. Please verify your email address before activating a license key.',
        code: 'EMAIL_NOT_VERIFIED',
        timestamp: Date.now(),
      });
      return;
    }

    const userTier = user?.tier || 'standard';
    const maxAgentSlots = TIER_AGENT_LIMITS[userTier] ?? TIER_AGENT_LIMITS.standard;

    const boundAgentCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM merlin_licenses WHERE user_id = ? AND status IN ('active', 'suspended') AND agent_id IS NOT NULL"
    ).get(license.user_id) as any).cnt;

    if (boundAgentCount >= maxAgentSlots) {
      res.status(403).json({
        success: false,
        error: `Your ${userTier} tier provides ${maxAgentSlots} agent slot${maxAgentSlots > 1 ? 's' : ''}. All slots are occupied. Upgrade your plan to unlock more agent slots, or terminate an existing agent to free a slot.`,
        currentTier: userTier,
        maxAgentSlots,
        boundAgents: boundAgentCount,
        timestamp: Date.now(),
      });
      return;
    }

    let finalAgentId: string;
    let finalAgentName: string;

    if (agentId) {
      // Mode 1: Bind to existing agent
      const agent = db.prepare(
        "SELECT id, name, status FROM agents WHERE id = ? AND active = 1"
      ).get(agentId) as any;
      if (!agent) {
        res.status(404).json({
          success: false,
          error: 'Agent not found or has been terminated.',
          timestamp: Date.now(),
        });
        return;
      }
      // Check agent isn't already bound to another key
      const existingBinding = db.prepare(
        "SELECT id FROM merlin_licenses WHERE agent_id = ? AND status IN ('active', 'suspended')"
      ).get(agentId) as any;
      if (existingBinding) {
        res.status(409).json({
          success: false,
          error: 'This agent is already bound to a different BTS key. One key, one agent.',
          timestamp: Date.now(),
        });
        return;
      }
      finalAgentId = agent.id;
      finalAgentName = agent.name;
    } else {
      // Mode 2: Auto-register new agent
      finalAgentId = uuid();
      finalAgentName = agentName!;
      const now = Date.now();

      db.prepare(`
        INSERT INTO agents (id, name, description, version, registered_at, registrant_key_id, active, status, owner_user_id, agent_type)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'active', ?, 'merlin')
      `).run(
        finalAgentId,
        agentName,
        agentDescription || `Merlin-powered agent: ${agentName}`,
        agentVersion || '1.0.0',
        now,
        'bts-license',  // Registered via BTS license activation, not an API key
        license.user_id,
      );

      logLicenseEvent(license.id, 'agent.auto_registered', {
        agentId: finalAgentId,
        agentName,
        agentDescription,
      }, license.user_id, ip);
    }

    // BIND — permanent, irreversible
    const now = Date.now();
    db.prepare(`
      UPDATE merlin_licenses
      SET agent_id = ?, activated_at = ?, activation_ip = ?, last_seen_ip = ?, last_verified_at = ?
      WHERE id = ?
    `).run(finalAgentId, now, ip, ip, now, license.id);

    logLicenseEvent(license.id, 'license.activated', {
      agentId: finalAgentId,
      agentName: finalAgentName,
      activationIp: ip,
      bindingType: agentId ? 'existing_agent' : 'auto_registered',
      permanent: true,
    }, license.user_id, ip);

    res.status(200).json({
      success: true,
      data: {
        licenseId: license.id,
        agentId: finalAgentId,
        agentName: finalAgentName,
        status: 'active',
        activatedAt: now,
        bindingType: agentId ? 'existing_agent' : 'auto_registered',
        message: 'BTS License Key activated and permanently bound to this agent. Your agent is now on the Borealis Trust Network.',
        permanentBinding: {
          warning: 'THIS BINDING IS PERMANENT AND IRREVERSIBLE.',
          consequences: [
            'This key is now locked to this agent forever.',
            'The key CANNOT be transferred to a different agent.',
            'If you need a new key, both this key AND this agent will be permanently terminated.',
            'All trust scores and history for a terminated agent remain on record as terminated.',
          ],
        },
      },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Activation failed', timestamp: Date.now() });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /v1/licenses/verify — Runtime heartbeat & score check
// Called periodically by the Merlin runtime. Returns current BTS score or
// signals that the key is invalid/revoked so the runtime can go dark.
// Anti-fraud: rate limiting, IP drift detection.
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/verify', (req: Request, res: Response) => {
  try {
    const parsed = VerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
        timestamp: Date.now(),
      });
      return;
    }

    const { key } = parsed.data;
    const db = getDb();
    const kHash = hashKey(key);
    const ip = getClientIp(req);

    const license = db.prepare(
      'SELECT * FROM merlin_licenses WHERE key_hash = ?'
    ).get(kHash) as any;

    if (!license) {
      res.status(404).json({
        success: false,
        error: 'INVALID_KEY',
        message: 'BTS License Key not recognized',
        scoring: false,
        timestamp: Date.now(),
      });
      return;
    }

    // Key is revoked, terminated, or suspended — runtime must go dark
    if (license.status === 'terminated') {
      res.status(403).json({
        success: false,
        error: 'KEY_TERMINATED',
        message: 'This BTS License Key has been terminated. The bound agent and key are permanently inactive.',
        reason: license.status_reason,
        scoring: false,
        timestamp: Date.now(),
      });
      return;
    }

    if (license.status === 'revoked') {
      res.status(403).json({
        success: false,
        error: 'KEY_REVOKED',
        message: 'This BTS License Key has been revoked. Trust scoring is disabled.',
        scoring: false,
        timestamp: Date.now(),
      });
      return;
    }

    if (license.status === 'suspended') {
      res.status(403).json({
        success: false,
        error: 'KEY_SUSPENDED',
        message: 'This BTS License Key is suspended. Contact support.',
        scoring: false,
        timestamp: Date.now(),
      });
      return;
    }

    if (!license.agent_id) {
      res.status(400).json({
        success: false,
        error: 'KEY_NOT_ACTIVATED',
        message: 'This key has not been activated. Bind it to an agent first.',
        scoring: false,
        timestamp: Date.now(),
      });
      return;
    }

    // Rate limiting per key (100 requests/hour)
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    const recentVerifications = db.prepare(
      "SELECT COUNT(*) as cnt FROM license_audit_log WHERE license_id = ? AND event_type = 'license.verified' AND created_at > ?"
    ).get(license.id, oneHourAgo) as any;

    if (recentVerifications.cnt >= RATE_LIMIT_PER_KEY_PER_HOUR) {
      res.status(429).json({
        success: false,
        error: 'RATE_LIMITED',
        message: 'Verification rate limit exceeded. Max 100 requests per hour per key.',
        scoring: false,
        timestamp: Date.now(),
      });
      return;
    }

    // IP drift detection — flag but don't block (v1 foundation)
    let ipDriftDetected = false;
    if (license.last_seen_ip && license.last_seen_ip !== ip) {
      ipDriftDetected = true;
      logLicenseEvent(license.id, 'license.ip_drift', {
        previousIp: license.last_seen_ip,
        currentIp: ip,
      }, 'system', ip);
    }

    // Update last seen
    const now = Date.now();
    db.prepare(`
      UPDATE merlin_licenses
      SET last_verified_at = ?, last_seen_ip = ?, verify_count = verify_count + 1
      WHERE id = ?
    `).run(now, ip, license.id);

    // Get latest BTS score for this agent
    const latestScore = db.prepare(`
      SELECT * FROM license_score_history
      WHERE license_id = ? AND agent_id = ?
      ORDER BY computed_at DESC LIMIT 1
    `).get(license.id, license.agent_id) as any;

    // Get agent info
    const agent = db.prepare('SELECT id, name FROM agents WHERE id = ?').get(license.agent_id) as any;

    logLicenseEvent(license.id, 'license.verified', {
      agentId: license.agent_id,
      ipDriftDetected,
      hasScore: !!latestScore,
    }, license.user_id, ip);

    res.status(200).json({
      success: true,
      data: {
        licenseId: license.id,
        status: 'active',
        agentId: license.agent_id,
        agentName: agent?.name || 'Unknown',
        scoring: true,
        ipDriftDetected,
        verifyCount: license.verify_count + 1,
        lastVerifiedAt: now,
        btsScore: latestScore ? {
          total: latestScore.score_total,
          display: latestScore.score_display,
          creditRating: latestScore.credit_rating,
          breakdown: JSON.parse(latestScore.score_breakdown),
          computedAt: latestScore.computed_at,
          hedera: latestScore.hcs_transaction_id ? {
            topicId: latestScore.hcs_topic_id,
            transactionId: latestScore.hcs_transaction_id,
            sequenceNumber: latestScore.hcs_sequence_number,
            consensusTimestamp: latestScore.hcs_consensus_timestamp,
          } : null,
        } : null,
      },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Verification failed', timestamp: Date.now() });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /v1/licenses/telemetry — Submit telemetry for BTS scoring
// The core v3.2 "Pragmatic Trust" endpoint. Accepts structured telemetry from
// BTS-licensed agents, validates via Zod, computes BM Score through the existing
// engine (zero changes), applies trust ceiling, runs Layer 2 anomaly detection,
// persists to license_score_history, and anchors to Hedera HCS.
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/telemetry', async (req: Request, res: Response) => {
  try {
    const { processTelemetry } = await import('../engine/telemetry-pipeline');
    const db = getDb();

    // Extract key from payload for license lookup
    const key = req.body?.key;
    if (!key || typeof key !== 'string') {
      res.status(400).json({
        success: false,
        error: 'MISSING_KEY',
        message: 'BTS License Key is required in payload',
        timestamp: Date.now(),
      });
      return;
    }

    // Validate key format before DB lookup
    if (!/^BTS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(key)) {
      res.status(400).json({
        success: false,
        error: 'INVALID_KEY_FORMAT',
        message: 'BTS key format: BTS-XXXX-XXXX-XXXX-XXXX',
        timestamp: Date.now(),
      });
      return;
    }

    const kHash = hashKey(key);
    const license = db.prepare('SELECT * FROM merlin_licenses WHERE key_hash = ?').get(kHash) as any;

    if (!license) {
      res.status(404).json({
        success: false,
        error: 'INVALID_KEY',
        message: 'BTS License Key not recognized',
        timestamp: Date.now(),
      });
      return;
    }

    // Only active, bound licenses can submit telemetry
    if (license.status !== 'active') {
      res.status(403).json({
        success: false,
        error: `KEY_${license.status.toUpperCase()}`,
        message: `This key is ${license.status}. Telemetry submission is disabled.`,
        timestamp: Date.now(),
      });
      return;
    }

    if (!license.agent_id) {
      res.status(400).json({
        success: false,
        error: 'KEY_NOT_ACTIVATED',
        message: 'Activate this key and bind it to an agent before submitting telemetry.',
        timestamp: Date.now(),
      });
      return;
    }

    // Rate limit: max 60 telemetry submissions per hour per license
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    const recentSubmissions = db.prepare(
      "SELECT COUNT(*) as cnt FROM license_audit_log WHERE license_id = ? AND event_type = 'telemetry.submitted' AND created_at > ?"
    ).get(license.id, oneHourAgo) as any;

    if (recentSubmissions.cnt >= 60) {
      res.status(429).json({
        success: false,
        error: 'RATE_LIMITED',
        message: 'Telemetry rate limit exceeded. Max 60 submissions per hour per key.',
        timestamp: Date.now(),
      });
      return;
    }

    // Process through the pipeline
    const result = await processTelemetry(req.body, license.id, license.agent_id, license.status);

    if (!result.success) {
      const errorResult = result as { success: false; error: string; details?: Record<string, any> };
      res.status(400).json({
        ...errorResult,
        timestamp: Date.now(),
      });
      return;
    }

    // Log the telemetry event
    const ip = getClientIp(req);
    logLicenseEvent(license.id, 'telemetry.submitted', {
      scoreId: result.scoreId,
      batchId: result.batchId,
      score: result.btsScore.total,
      creditRating: result.btsScore.creditRating,
      reportingMode: result.btsScore.reportingMode,
      flagCount: result.suspicionFlags.flagCount,
    }, license.user_id, ip);

    res.status(200).json({
      success: true,
      data: {
        scoreId: result.scoreId,
        agentId: result.agentId,
        btsScore: result.btsScore,
        suspicionFlags: {
          flagCount: result.suspicionFlags.flagCount,
          // Don't reveal specific flags to the reporter — prevents gaming
          message: result.suspicionFlags.flagCount > 0
            ? 'Some statistical patterns were flagged for review.'
            : 'No anomalous patterns detected.',
        },
        hedera: result.hedera,
        batchId: result.batchId,
        computedAt: result.computedAt,
      },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'TELEMETRY_PROCESSING_FAILED',
      message: 'Internal error processing telemetry',
      timestamp: Date.now(),
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /v1/licenses/public/:agentId — Public verification lookup
// Anyone can check if an agent has a valid BTS score. No key required.
// This is the public trust verification endpoint.
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/public/:agentId', publicBtsLimiter, (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;
    const db = getDb();

    // Find active license for this agent
    const license = db.prepare(
      "SELECT id, key_prefix, status, activated_at, verify_count, last_verified_at FROM merlin_licenses WHERE agent_id = ? AND status = 'active'"
    ).get(agentId) as any;

    // Also check if the agent itself is terminated
    const agentRecord = db.prepare('SELECT name, status, terminated_at, termination_reason FROM agents WHERE id = ?').get(agentId) as any;

    if (!license) {
      // Check if there's a revoked/suspended/terminated license
      const inactiveLicense = db.prepare(
        "SELECT status, status_reason, revoked_at, created_at FROM merlin_licenses WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1"
      ).get(agentId) as any;

      if (inactiveLicense) {
        // Get historical scores even for terminated agents — the record persists
        const lastScore = db.prepare(`
          SELECT score_display, credit_rating, computed_at
          FROM license_score_history WHERE agent_id = ? ORDER BY computed_at DESC LIMIT 1
        `).get(agentId) as any;

        res.status(200).json({
          success: true,
          data: {
            agentId,
            agentName: agentRecord?.name || 'Unknown Agent',
            verified: false,
            status: inactiveLicense.status,
            agentStatus: agentRecord?.status || 'unknown',
            terminatedAt: agentRecord?.terminated_at || inactiveLicense.revoked_at,
            terminationReason: agentRecord?.termination_reason || inactiveLicense.status_reason,
            message: `This agent's BTS License Key is ${inactiveLicense.status}. Trust scoring is not active. Historical records are preserved.`,
            lastKnownScore: lastScore ? {
              display: lastScore.score_display,
              creditRating: lastScore.credit_rating,
              computedAt: lastScore.computed_at,
              note: 'This was the last recorded BTS score before termination.',
            } : null,
          },
          timestamp: Date.now(),
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: {
          agentId,
          verified: false,
          status: 'unknown',
          message: 'No BTS License Key found for this agent. This agent is not on the Borealis Trust Network.',
          btsScore: null,
        },
        timestamp: Date.now(),
      });
      return;
    }

    // Get latest score
    const latestScore = db.prepare(`
      SELECT * FROM license_score_history
      WHERE license_id = ? AND agent_id = ?
      ORDER BY computed_at DESC LIMIT 1
    `).get(license.id, agentId) as any;

    // Get agent name
    const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as any;

    res.status(200).json({
      success: true,
      data: {
        agentId,
        agentName: agent?.name || 'Unknown Agent',
        verified: true,
        status: 'active',
        keyPrefix: license.key_prefix,
        activatedAt: license.activated_at,
        lastVerifiedAt: license.last_verified_at,
        verifyCount: license.verify_count,
        btsScore: latestScore ? {
          display: latestScore.score_display,
          creditRating: latestScore.credit_rating,
          breakdown: JSON.parse(latestScore.score_breakdown),
          computedAt: latestScore.computed_at,
          hedera: latestScore.hcs_transaction_id ? {
            topicId: latestScore.hcs_topic_id,
            transactionId: latestScore.hcs_transaction_id,
            sequenceNumber: latestScore.hcs_sequence_number,
            consensusTimestamp: latestScore.hcs_consensus_timestamp,
          } : null,
        } : {
          display: null,
          creditRating: 'PENDING',
          message: 'Trust scoring is active. First BTS score will be computed after sufficient telemetry.',
        },
      },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Public verification failed', timestamp: Date.now() });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /v1/licenses/my — User's license(s)
// Requires JWT auth. Returns all licenses for the authenticated user.
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/my', requireAuth, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user!.sub;
    const db = getDb();

    const licenses = db.prepare(`
      SELECT
        ml.id, ml.key_prefix, ml.agent_id, ml.status, ml.status_reason,
        ml.purchase_price, ml.purchase_currency, ml.payment_method,
        ml.created_at, ml.activated_at, ml.last_verified_at, ml.verify_count,
        a.name as agent_name
      FROM merlin_licenses ml
      LEFT JOIN agents a ON ml.agent_id = a.id
      WHERE ml.user_id = ?
      ORDER BY ml.created_at DESC
    `).all(userId) as any[];

    // For each license, get latest score
    const enriched = licenses.map((lic: any) => {
      let latestScore = null;
      if (lic.agent_id) {
        const score = db.prepare(`
          SELECT score_display, credit_rating, score_breakdown, computed_at,
                 hcs_transaction_id, hcs_topic_id
          FROM license_score_history
          WHERE license_id = ? ORDER BY computed_at DESC LIMIT 1
        `).get(lic.id) as any;

        if (score) {
          latestScore = {
            display: score.score_display,
            creditRating: score.credit_rating,
            breakdown: JSON.parse(score.score_breakdown),
            computedAt: score.computed_at,
            hederaAnchored: !!score.hcs_transaction_id,
          };
        }
      }

      return {
        id: lic.id,
        keyPrefix: lic.key_prefix,
        agentId: lic.agent_id,
        agentName: lic.agent_name,
        status: lic.status,
        statusReason: lic.status_reason,
        purchasePrice: lic.purchase_price,
        purchaseCurrency: lic.purchase_currency,
        paymentMethod: lic.payment_method,
        createdAt: lic.created_at,
        activatedAt: lic.activated_at,
        lastVerifiedAt: lic.last_verified_at,
        verifyCount: lic.verify_count,
        btsScore: latestScore,
      };
    });

    res.status(200).json({
      success: true,
      data: { licenses: enriched, total: enriched.length },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to fetch licenses', timestamp: Date.now() });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /v1/licenses/:id/replace — User: Terminate old key + agent, get new key
// This is the ONLY way to "move on" from a bound key. Both the old key and
// its bound agent are terminated permanently. A fresh key is generated.
// Historical records are preserved. Requires JWT auth (user must own the license).
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/:id/replace', requireAuth, (req: Request, res: Response) => {
  try {
    const parsed = ReplaceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
        timestamp: Date.now(),
      });
      return;
    }

    const authReq = req as AuthRequest;
    const userId = authReq.user!.sub;
    const { id } = req.params;
    const { reason } = parsed.data;
    const db = getDb();
    const ip = getClientIp(req);

    // Verify ownership
    const license = db.prepare(
      'SELECT * FROM merlin_licenses WHERE id = ? AND user_id = ?'
    ).get(id, userId) as any;

    if (!license) {
      res.status(404).json({ success: false, error: 'License not found or not owned by you', timestamp: Date.now() });
      return;
    }

    if (license.status === 'revoked' || license.status === 'terminated') {
      res.status(409).json({
        success: false,
        error: `This license is already ${license.status}. Cannot replace.`,
        timestamp: Date.now(),
      });
      return;
    }

    const now = Date.now();
    const terminationReason = `User-initiated replacement: ${reason}`;

    // Step 1: Terminate the bound agent (if activated)
    let terminatedAgentId: string | null = null;
    if (license.agent_id) {
      terminatedAgentId = license.agent_id;
      terminateAgent(license.agent_id, terminationReason, userId);

      logLicenseEvent(license.id, 'agent.terminated', {
        agentId: license.agent_id,
        reason: terminationReason,
        terminatedBy: userId,
      }, userId, ip);
    }

    // Step 2: Terminate the old license
    terminateLicense(license.id, 'terminated', terminationReason, userId, ip);

    // Step 3: Generate a fresh key
    const { rawKey, keyHash, keyPrefix } = generateBTSKey();
    const newLicenseId = uuid();

    db.prepare(`
      INSERT INTO merlin_licenses (
        id, key_hash, key_prefix, user_id, status, order_id,
        purchase_price, purchase_currency, payment_method, created_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `).run(
      newLicenseId, keyHash, keyPrefix, userId,
      license.order_id, license.purchase_price, license.purchase_currency, license.payment_method,
      now,
    );

    logLicenseEvent(newLicenseId, 'license.generated_replacement', {
      previousLicenseId: license.id,
      previousAgentId: terminatedAgentId,
      reason,
    }, userId, ip);

    res.status(201).json({
      success: true,
      data: {
        previousLicense: {
          id: license.id,
          status: 'terminated',
          agentId: terminatedAgentId,
          agentStatus: terminatedAgentId ? 'terminated' : null,
          reason: terminationReason,
        },
        newLicense: {
          licenseId: newLicenseId,
          key: rawKey,
          keyPrefix,
          status: 'active',
          createdAt: now,
        },
        message: 'Old license and agent have been permanently terminated. Historical records preserved. New BTS License Key generated.',
        warning: 'Store this new BTS License Key securely. It will NOT be shown again.',
        terminationRecord: {
          note: 'The terminated agent and key remain in the database permanently. Any future BTS score lookup for the old agent will return "terminated" with full dated history. This action cannot be undone.',
        },
      },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Replacement failed', timestamp: Date.now() });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /v1/licenses/:id/revoke — Admin: Revoke a key permanently
// Revocation = nuclear option. BOTH the key AND its bound agent are terminated.
// Agent record preserved with full history. All future lookups return "terminated".
// Used for: refunds, fraud, abuse, legal compliance.
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/:id/revoke', requireApiKey, requireScope('admin'), (req: Request, res: Response) => {
  try {
    const parsed = AdminActionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Reason required for revocation',
        details: parsed.error.flatten().fieldErrors,
        timestamp: Date.now(),
      });
      return;
    }

    const { id } = req.params;
    const { reason } = parsed.data;
    const db = getDb();
    const ip = getClientIp(req);

    const license = db.prepare('SELECT * FROM merlin_licenses WHERE id = ?').get(id) as any;
    if (!license) {
      res.status(404).json({ success: false, error: 'License not found', timestamp: Date.now() });
      return;
    }

    if (license.status === 'revoked' || license.status === 'terminated') {
      res.status(409).json({ success: false, error: `License is already ${license.status}`, timestamp: Date.now() });
      return;
    }

    const now = Date.now();

    // Terminate the bound agent alongside the key
    let agentTerminated = false;
    if (license.agent_id) {
      terminateAgent(license.agent_id, `License revoked: ${reason}`, 'admin');
      agentTerminated = true;

      logLicenseEvent(id, 'agent.terminated', {
        agentId: license.agent_id,
        reason: `License revoked: ${reason}`,
        terminatedBy: 'admin',
      }, 'admin', ip);
    }

    // Revoke the license
    db.prepare(`
      UPDATE merlin_licenses
      SET status = 'revoked', status_reason = ?, revoked_at = ?
      WHERE id = ?
    `).run(reason, now, id);

    logLicenseEvent(id, 'license.revoked', {
      previousStatus: license.status,
      reason,
      agentId: license.agent_id,
      agentTerminated,
    }, 'admin', ip);

    const authReq = req as AuthenticatedRequest;
    auditLog('license.revoked', authReq.apiKey.id, { licenseId: id, reason, agentTerminated });

    // Fire-and-forget revocation email
    const revokedUser = db.prepare('SELECT name, email FROM users WHERE id = ?').get(license.user_id) as any;
    const revokedAgent = license.agent_id
      ? (db.prepare('SELECT name FROM agents WHERE id = ?').get(license.agent_id) as any)
      : null;
    if (revokedUser?.email) {
      sendKeyRevocationEmail(
        revokedUser.email,
        revokedUser.name ?? '',
        license.key_prefix,
        revokedAgent?.name ?? null,
        reason,
        null,
      ).catch((e: Error) => logger.warn('Revocation email failed', { error: e.message }));
    }

    res.status(200).json({
      success: true,
      data: {
        licenseId: id,
        status: 'revoked',
        reason,
        revokedAt: now,
        agentId: license.agent_id,
        agentTerminated,
        message: agentTerminated
          ? 'License revoked and bound agent terminated. Both records preserved with full history. Trust scoring permanently disabled.'
          : 'License revoked. Trust scoring permanently disabled.',
      },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Revocation failed', timestamp: Date.now() });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /v1/licenses/:id/suspend — Admin: Suspend a key temporarily
// Suspension is a soft pause. Key can be restored.
// Used for: investigation, payment disputes, temporary compliance holds.
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/:id/suspend', requireApiKey, requireScope('admin'), (req: Request, res: Response) => {
  try {
    const parsed = AdminActionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Reason required for suspension',
        details: parsed.error.flatten().fieldErrors,
        timestamp: Date.now(),
      });
      return;
    }

    const { id } = req.params;
    const { reason } = parsed.data;
    const db = getDb();

    const license = db.prepare('SELECT * FROM merlin_licenses WHERE id = ?').get(id) as any;
    if (!license) {
      res.status(404).json({ success: false, error: 'License not found', timestamp: Date.now() });
      return;
    }

    if (license.status !== 'active') {
      res.status(409).json({
        success: false,
        error: `Cannot suspend a license with status: ${license.status}`,
        timestamp: Date.now(),
      });
      return;
    }

    const now = Date.now();
    db.prepare(`
      UPDATE merlin_licenses
      SET status = 'suspended', status_reason = ?, suspended_at = ?
      WHERE id = ?
    `).run(reason, now, id);

    logLicenseEvent(id, 'license.suspended', {
      reason,
      agentId: license.agent_id,
    }, 'admin', getClientIp(req));

    const authReq = req as AuthenticatedRequest;
    auditLog('license.suspended', authReq.apiKey.id, { licenseId: id, reason });

    // Fire-and-forget suspension email
    const suspendedUser = db.prepare('SELECT name, email FROM users WHERE id = ?').get(license.user_id) as any;
    const suspendedAgent = license.agent_id
      ? (db.prepare('SELECT name FROM agents WHERE id = ?').get(license.agent_id) as any)
      : null;
    if (suspendedUser?.email) {
      sendKeySuspensionEmail(
        suspendedUser.email,
        suspendedUser.name ?? '',
        license.key_prefix,
        suspendedAgent?.name ?? null,
        reason,
      ).catch((e: Error) => logger.warn('Suspension email failed', { error: e.message }));
    }

    res.status(200).json({
      success: true,
      data: {
        licenseId: id,
        status: 'suspended',
        reason,
        suspendedAt: now,
        message: 'License suspended. Agent trust scoring is paused.',
      },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Suspension failed', timestamp: Date.now() });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /v1/licenses/:id/restore — Admin: Restore a suspended key
// Only works on suspended licenses. Revoked = permanent.
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/:id/restore', requireApiKey, requireScope('admin'), (req: Request, res: Response) => {
  try {
    const parsed = AdminActionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Reason required for restoration',
        details: parsed.error.flatten().fieldErrors,
        timestamp: Date.now(),
      });
      return;
    }

    const { id } = req.params;
    const { reason } = parsed.data;
    const db = getDb();

    const license = db.prepare('SELECT * FROM merlin_licenses WHERE id = ?').get(id) as any;
    if (!license) {
      res.status(404).json({ success: false, error: 'License not found', timestamp: Date.now() });
      return;
    }

    if (license.status !== 'suspended') {
      const msg = license.status === 'revoked'
        ? 'Cannot restore a revoked license. Revocation is permanent.'
        : license.status === 'terminated'
          ? 'Cannot restore a terminated license. Termination is permanent. The bound agent has also been terminated.'
          : `License is not suspended (current status: ${license.status})`;
      res.status(409).json({
        success: false,
        error: msg,
        timestamp: Date.now(),
      });
      return;
    }

    const now = Date.now();
    db.prepare(`
      UPDATE merlin_licenses
      SET status = 'active', status_reason = ?, suspended_at = NULL
      WHERE id = ?
    `).run(`Restored: ${reason}`, id);

    logLicenseEvent(id, 'license.restored', {
      reason,
      agentId: license.agent_id,
      previouslySuspendedAt: license.suspended_at,
    }, 'admin', getClientIp(req));

    const authReq = req as AuthenticatedRequest;
    auditLog('license.restored', authReq.apiKey.id, { licenseId: id, reason });

    // Fire-and-forget restoration email
    const restoredUser = db.prepare('SELECT name, email FROM users WHERE id = ?').get(license.user_id) as any;
    const restoredAgent = license.agent_id
      ? (db.prepare('SELECT name FROM agents WHERE id = ?').get(license.agent_id) as any)
      : null;
    if (restoredUser?.email) {
      sendKeyRestorationEmail(
        restoredUser.email,
        restoredUser.name ?? '',
        license.key_prefix,
        restoredAgent?.name ?? null,
      ).catch((e: Error) => logger.warn('Restoration email failed', { error: e.message }));
    }

    res.status(200).json({
      success: true,
      data: {
        licenseId: id,
        status: 'active',
        reason,
        message: 'License restored. Agent trust scoring is active again.',
      },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Restoration failed', timestamp: Date.now() });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /v1/licenses/audit — Admin: Audit dashboard
// Returns license statistics, recent events, flagged keys.
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/audit', requireApiKey, requireScope('admin'), (req: Request, res: Response) => {
  try {
    const db = getDb();

    // Overall stats
    const stats = {
      total: (db.prepare('SELECT COUNT(*) as c FROM merlin_licenses').get() as any).c,
      active: (db.prepare("SELECT COUNT(*) as c FROM merlin_licenses WHERE status = 'active'").get() as any).c,
      suspended: (db.prepare("SELECT COUNT(*) as c FROM merlin_licenses WHERE status = 'suspended'").get() as any).c,
      revoked: (db.prepare("SELECT COUNT(*) as c FROM merlin_licenses WHERE status = 'revoked'").get() as any).c,
      terminated: (db.prepare("SELECT COUNT(*) as c FROM merlin_licenses WHERE status = 'terminated'").get() as any).c,
      activated: (db.prepare('SELECT COUNT(*) as c FROM merlin_licenses WHERE agent_id IS NOT NULL').get() as any).c,
      unactivated: (db.prepare('SELECT COUNT(*) as c FROM merlin_licenses WHERE agent_id IS NULL AND status = \'active\'').get() as any).c,
    };

    // Recent audit events (last 50)
    const recentEvents = db.prepare(`
      SELECT lal.*, ml.key_prefix, ml.user_id
      FROM license_audit_log lal
      JOIN merlin_licenses ml ON lal.license_id = ml.id
      ORDER BY lal.created_at DESC LIMIT 50
    `).all() as any[];

    // IP drift events (potential fraud signals)
    const ipDrifts = db.prepare(`
      SELECT lal.*, ml.key_prefix, ml.user_id, ml.agent_id
      FROM license_audit_log lal
      JOIN merlin_licenses ml ON lal.license_id = ml.id
      WHERE lal.event_type = 'license.ip_drift'
      ORDER BY lal.created_at DESC LIMIT 20
    `).all() as any[];

    // Inactive licenses (no verification in 90 days)
    const inactiveThreshold = Date.now() - (INACTIVITY_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
    const inactive = db.prepare(`
      SELECT id, key_prefix, user_id, agent_id, last_verified_at, verify_count
      FROM merlin_licenses
      WHERE status = 'active' AND agent_id IS NOT NULL
      AND (last_verified_at < ? OR last_verified_at IS NULL)
    `).all(inactiveThreshold) as any[];

    // Revenue
    const revenue = db.prepare(`
      SELECT
        SUM(purchase_price) as total_revenue,
        COUNT(*) as total_purchases,
        AVG(purchase_price) as avg_price
      FROM merlin_licenses
    `).get() as any;

    res.status(200).json({
      success: true,
      data: {
        stats,
        revenue: {
          totalRevenue: revenue.total_revenue || 0,
          totalPurchases: revenue.total_purchases || 0,
          averagePrice: revenue.avg_price || 0,
        },
        recentEvents: recentEvents.map((e: any) => ({
          id: e.id,
          licenseId: e.license_id,
          keyPrefix: e.key_prefix,
          userId: e.user_id,
          eventType: e.event_type,
          eventData: e.event_data ? JSON.parse(e.event_data) : null,
          actor: e.actor,
          ipAddress: e.ip_address,
          createdAt: e.created_at,
        })),
        ipDrifts: ipDrifts.map((d: any) => ({
          licenseId: d.license_id,
          keyPrefix: d.key_prefix,
          userId: d.user_id,
          agentId: d.agent_id,
          eventData: d.event_data ? JSON.parse(d.event_data) : null,
          detectedAt: d.created_at,
        })),
        inactiveLicenses: inactive,
      },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Audit dashboard failed', timestamp: Date.now() });
  }
});

export default router;
