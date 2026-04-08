/**
 * BorealisMark — Admin Console Routes
 *
 * Authenticated admin-only endpoints for platform oversight.
 *
 *   GET  /v1/admin/dashboard         — Platform overview stats
 *   GET  /v1/admin/users             — List/search users
 *   GET  /v1/admin/users/:id         — User detail
 *   PATCH /v1/admin/users/:id        — Update user (tier, role, active)
 *   DELETE /v1/admin/users/:id       — Delete user + all associated data
 *   GET  /v1/admin/support           — List support threads (inbox)
 *   GET  /v1/admin/support/:id       — Thread detail + messages
 *   PATCH /v1/admin/support/:id      — Update thread (status, assign)
 *   POST /v1/admin/support/:id/reply — Admin reply to thread
 *   GET  /v1/admin/support/stats     — Support statistics
 *   GET  /v1/admin/events            — Platform event log
 *   GET  /v1/admin/events/stats      — Event statistics
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import path from 'path';
import { execSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { requireAuth } from './auth';
import { requireMasterKey } from '../middleware/auth';
import { logger } from '../middleware/logger';
import {
  getDb,
  getUserById,
  getAllUsers,
  getAdminDashboardStats,
  updateUserTier,
  updateUserRole,
  getSupportThreads,
  getSupportMessages,
  updateSupportThreadStatus,
  assignSupportThread,
  escalateSupportThread,
  addSupportMessage,
  getSupportStats,
  getPlatformEvents,
  getEventStats,
  setEmailVerified,
  computeAndStoreTrustScore,
} from '../db/database';
import { handleSupportChat } from '../services/aiSupport';
import { sendAccountDeletionEmail } from '../services/email';
import { uploadDatabaseBackup, isR2Enabled, getR2Status } from '../services/r2Storage';

const router = Router();

// ─── Admin Gating Middleware ────────────────────────────────────────────────

function requireAdmin(req: Request, res: Response, next: Function): void {
  const userId = (req as any).user?.sub;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }
  const user = getUserById(userId);
  if (!user || user.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Admin access required' });
    return;
  }
  next();
}

// ─── GET /dashboard — Platform Overview ─────────────────────────────────────

router.get('/dashboard', requireAuth, requireAdmin, (_req: Request, res: Response) => {
  try {
    const stats = getAdminDashboardStats();
    const supportStats = getSupportStats();
    res.json({
      success: true,
      data: { ...stats, support: supportStats, generatedAt: new Date().toISOString() },
    });
  } catch (err: any) {
    logger.error('Admin dashboard error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load dashboard' });
  }
});

// ─── GET /users — List/Search Users ─────────────────────────────────────────

router.get('/users', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const tier = req.query.tier as string | undefined;
    const role = req.query.role as string | undefined;
    const search = req.query.search as string | undefined;

    const { users, total } = getAllUsers({ limit, offset, tier, role, search });
    res.json({ success: true, data: { users, total, limit, offset } });
  } catch (err: any) {
    logger.error('Admin list users error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to list users' });
  }
});

// ─── GET /users/:id — User Detail ──────────────────────────────────────────

router.get('/users/:id', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const user = getUserById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const db = getDb();
    // Get user's bots
    const bots = db.prepare('SELECT id, name, type, status, tier, ap_points, star_rating, jobs_completed FROM bots WHERE owner_id = ?').all(req.params.id);
    // Get user's orders
    const orders = db.prepare("SELECT id, status, total_usdc, created_at FROM marketplace_orders WHERE buyer_id = ? OR seller_id = ? ORDER BY created_at DESC LIMIT 20").all(req.params.id, req.params.id);
    // Get support threads for this user
    const threads = db.prepare("SELECT id, session_id, channel, status, escalated, message_count, created_at FROM support_threads WHERE customer_email = ? ORDER BY updated_at DESC LIMIT 10").all(user.email);

    res.json({
      success: true,
      data: { user, bots, orders, supportThreads: threads },
    });
  } catch (err: any) {
    logger.error('Admin user detail error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load user' });
  }
});

// ─── PATCH /users/:id — Update User ────────────────────────────────────────

const updateUserSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  tier: z.enum(['standard', 'pro', 'elite']).optional(),
  role: z.enum(['user', 'admin']).optional(),
  active: z.boolean().optional(),
});

router.patch('/users/:id', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten() });
    }

    const user = getUserById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const adminId = (req as any).user.sub;
    const { name, tier, role, active } = parsed.data;

    if (name) getDb().prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.params.id);
    if (tier) updateUserTier(req.params.id, tier);
    if (role) updateUserRole(req.params.id, role);
    if (active !== undefined) {
      getDb().prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
    }

    // Recompute trust score when tier or verification status changes
    // This ensures listing badges, trust levels, and all derived data stay in sync
    if (tier) {
      const trustScore = computeAndStoreTrustScore(req.params.id);
      logger.info('Trust score recomputed after tier change', { userId: req.params.id, newTier: tier, trustLevel: trustScore.trustLevel, totalScore: trustScore.totalScore });
    }

    logger.info('Admin updated user', { adminId, userId: req.params.id, changes: parsed.data });
    const updatedUser = getUserById(req.params.id);
    res.json({ success: true, message: 'User updated', user: updatedUser ? { id: updatedUser.id, tier: updatedUser.tier, role: updatedUser.role, active: updatedUser.active, emailVerified: updatedUser.emailVerified } : undefined });
  } catch (err: any) {
    logger.error('Admin update user error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to update user' });
  }
});

// ─── DELETE /users/:id — Delete User + All Associated Data ──────────────────

router.delete('/users/:id', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const user = getUserById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const adminId = (req as any).user.sub;
    const userId = req.params.id;

    // Prevent self-deletion
    if (userId === adminId) {
      return res.status(400).json({ success: false, error: 'Cannot delete your own admin account' });
    }

    const db = getDb();

    // Temporarily disable FK enforcement so we can delete without enumerating every referencing table
    db.pragma('foreign_keys = OFF');

    const deletions: Record<string, number> = {};

    try {
      // Clean up known relational data for audit trail
      const tables = [
        ['listing_likes', 'user_id'],
        ['user_watchlist', 'user_id'],
        ['marketplace_listings', 'user_id'],
        ['user_trust_scores', 'user_id'],
        ['bots', 'owner_id'],
        ['user_badges', 'user_id'],
        ['xp_transactions', 'user_id'],
        ['ap_transactions', 'user_id'],
        ['spark_progress', 'user_id'],
        ['spark_purchases', 'user_id'],
        ['user_progression', 'user_id'],
        ['user_login_days', 'user_id'],
        ['user_notifications', 'user_id'],
        ['notification_preferences', 'user_id'],
        ['daily_activity_log', 'user_id'],
        ['user_violations', 'user_id'],
        ['user_sanctions', 'user_id'],
        ['user_verifications', 'user_id'],
        ['api_keys', 'user_id'],
        ['webhooks', 'user_id'],
        ['api_usage', 'user_id'],
        ['seller_storefronts', 'user_id'],
        ['marketplace_carts', 'user_id'],
        ['audit_requests', 'user_id'],
        ['password_reset_tokens', 'user_id'],
        ['agents', 'owner_user_id'],
      ];

      for (const [table, col] of tables) {
        try {
          deletions[table] = db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(userId).changes;
        } catch (e) {
          // Table may not exist - non-fatal
        }
      }

      // Messages - delete via thread participation
      try {
        deletions.messages = db.prepare(
          'DELETE FROM messages WHERE thread_id IN (SELECT id FROM message_threads WHERE participant_a = ? OR participant_b = ?)'
        ).run(userId, userId).changes;
        deletions.messageThreads = db.prepare('DELETE FROM message_threads WHERE participant_a = ? OR participant_b = ?').run(userId, userId).changes;
      } catch (e) { /* non-fatal */ }

      // Orders (as buyer or seller)
      try {
        deletions.orders = db.prepare('DELETE FROM marketplace_orders WHERE buyer_id = ? OR seller_id = ?').run(userId, userId).changes;
      } catch (e) { /* non-fatal */ }

      // Bot sub-tables
      try {
        db.prepare('DELETE FROM bot_reviews WHERE bot_id IN (SELECT id FROM bots WHERE owner_id = ?)').run(userId);
        db.prepare('DELETE FROM bot_jobs WHERE bot_id IN (SELECT id FROM bots WHERE owner_id = ?)').run(userId);
      } catch (e) { /* non-fatal */ }

      // Support threads
      try {
        deletions.supportMessages = db.prepare(
          "DELETE FROM support_messages WHERE thread_id IN (SELECT id FROM support_threads WHERE customer_email = ?)"
        ).run(user.email).changes;
        deletions.supportThreads = db.prepare("DELETE FROM support_threads WHERE customer_email = ?").run(user.email).changes;
      } catch (e) { /* non-fatal */ }

      // License data
      try {
        db.prepare('DELETE FROM license_audit_log WHERE license_id IN (SELECT id FROM licenses WHERE user_id = ?)').run(userId);
        deletions.licenses = db.prepare('DELETE FROM licenses WHERE user_id = ?').run(userId).changes;
      } catch (e) { /* non-fatal */ }

      // Finally, delete the user
      deletions.user = db.prepare('DELETE FROM users WHERE id = ?').run(userId).changes;
    } finally {
      // Always re-enable FK enforcement
      db.pragma('foreign_keys = ON');
    }

    logger.info('Admin deleted user and all associated data', {
      adminId,
      deletedUserId: userId,
      deletedUsername: user.name,
      deletions,
    });

    // Fire-and-forget account deletion notification
    if (user.email) {
      sendAccountDeletionEmail(user.email, user.name ?? '').catch(
        (e: Error) => logger.warn('Account deletion email failed', { error: e.message }),
      );
    }

    res.json({
      success: true,
      message: `User "${user.name}" and all associated data deleted`,
      deletions,
    });
  } catch (err: any) {
    logger.error('Admin delete user error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to delete user' });
  }
});

// ─── POST /users/:id/verify-email — Admin: force-verify user email ─────────

router.post('/users/:id/verify-email', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const user = getUserById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    setEmailVerified(req.params.id, true);
    const trustScore = computeAndStoreTrustScore(req.params.id);
    logger.info('Admin force-verified email', { adminId: (req as any).user.sub, userId: req.params.id });
    res.json({ success: true, message: 'Email verified', trustScore: trustScore.totalScore, trustLevel: trustScore.trustLevel });
  } catch (err: any) {
    logger.error('Admin verify email error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to verify email' });
  }
});

// ─── GET /support — Support Inbox (List Threads) ───────────────────────────

router.get('/support', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const status = req.query.status as string | undefined;
    const channel = req.query.channel as string | undefined;
    const escalated = req.query.escalated === 'true' ? true : req.query.escalated === 'false' ? false : undefined;

    const { threads, total } = getSupportThreads({ status, channel, escalated, limit, offset });
    res.json({ success: true, data: { threads, total, limit, offset } });
  } catch (err: any) {
    logger.error('Admin support inbox error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load support inbox' });
  }
});

// ─── GET /support/stats — Support Statistics ────────────────────────────────

router.get('/support/stats', requireAuth, requireAdmin, (_req: Request, res: Response) => {
  try {
    const stats = getSupportStats();
    res.json({ success: true, data: stats });
  } catch (err: any) {
    logger.error('Admin support stats error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load support stats' });
  }
});

// ─── GET /support/:id — Thread Detail + Messages ───────────────────────────

router.get('/support/:id', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const thread = getDb().prepare('SELECT * FROM support_threads WHERE id = ?').get(req.params.id) as Record<string, any> | undefined;
    if (!thread) {
      return res.status(404).json({ success: false, error: 'Thread not found' });
    }

    const messages = getSupportMessages(req.params.id);
    res.json({ success: true, data: { thread, messages } });
  } catch (err: any) {
    logger.error('Admin thread detail error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load thread' });
  }
});

// ─── PATCH /support/:id — Update Thread Status ─────────────────────────────

const updateThreadSchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'escalated']).optional(),
  assignTo: z.string().optional(),
});

router.patch('/support/:id', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const parsed = updateThreadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten() });
    }

    const thread = getDb().prepare('SELECT * FROM support_threads WHERE id = ?').get(req.params.id);
    if (!thread) {
      return res.status(404).json({ success: false, error: 'Thread not found' });
    }

    const adminId = (req as any).user.sub;
    const { status, assignTo } = parsed.data;

    if (status) updateSupportThreadStatus(req.params.id, status);
    if (assignTo) assignSupportThread(req.params.id, assignTo);

    logger.info('Admin updated support thread', { adminId, threadId: req.params.id, changes: parsed.data });
    res.json({ success: true, message: 'Thread updated' });
  } catch (err: any) {
    logger.error('Admin update thread error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to update thread' });
  }
});

// ─── POST /support/:id/reply — Admin Reply to Thread ────────────────────────

const replySchema = z.object({
  message: z.string().min(1).max(5000),
  sendEmail: z.boolean().optional().default(false),
});

router.post('/support/:id/reply', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const parsed = replySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten() });
    }

    const thread = getDb().prepare('SELECT * FROM support_threads WHERE id = ?').get(req.params.id) as Record<string, any> | undefined;
    if (!thread) {
      return res.status(404).json({ success: false, error: 'Thread not found' });
    }

    const adminId = (req as any).user.sub;
    const { message, sendEmail } = parsed.data;

    // Save admin reply as assistant message
    addSupportMessage({
      id: uuid(),
      threadId: req.params.id,
      role: 'assistant',
      content: `[ADMIN REPLY] ${message}`,
    });

    // Update thread status to in_progress if it was open
    if (thread.status === 'open' || thread.status === 'escalated') {
      updateSupportThreadStatus(req.params.id, 'in_progress');
      assignSupportThread(req.params.id, adminId);
    }

    // Optionally send email reply
    if (sendEmail && thread.customer_email) {
      try {
        const { Resend } = await import('resend');
        const apiKey = process.env.RESEND_API_KEY;
        if (apiKey) {
          const resend = new Resend(apiKey);
          await resend.emails.send({
            from: process.env.EMAIL_FROM ?? 'BorealisMark Support <support@borealisprotocol.ai>',
            to: [thread.customer_email],
            subject: thread.subject ? `Re: ${thread.subject}` : 'BorealisMark Support Follow-up',
            text: `Hi ${thread.customer_name || 'there'},\n\n${message}\n\n---\nBorealisMark Support Team\nsupport@borealisprotocol.ai`,
          });
          logger.info('Admin email reply sent', { threadId: req.params.id, to: thread.customer_email });
        }
      } catch (emailErr: any) {
        logger.error('Failed to send admin email reply', { error: emailErr.message });
      }
    }

    logger.info('Admin replied to support thread', { adminId, threadId: req.params.id, sendEmail });
    res.json({ success: true, message: 'Reply sent' });
  } catch (err: any) {
    logger.error('Admin reply error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to send reply' });
  }
});

// ─── GET /events — Platform Event Log ──────────────────────────────────────

router.get('/events', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    const category = req.query.category as string | undefined;
    const eventType = req.query.type as string | undefined;
    const actorId = req.query.actor as string | undefined;
    const since = req.query.since ? parseInt(req.query.since as string) : undefined;

    const { events, total } = getPlatformEvents({ category, eventType, actorId, since, limit, offset });
    res.json({ success: true, data: { events, total, limit, offset } });
  } catch (err: any) {
    logger.error('Admin events error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load events' });
  }
});

// ─── GET /events/stats — Event Statistics ──────────────────────────────────

router.get('/events/stats', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const since = req.query.since ? parseInt(req.query.since as string) : undefined;
    const stats = getEventStats(since);
    res.json({ success: true, data: stats });
  } catch (err: any) {
    logger.error('Admin event stats error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load event stats' });
  }
});

// ─── POST /backup — Create database backup and upload to R2 ─────────────────

router.post('/backup', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    if (!isR2Enabled()) {
      return res.status(503).json({
        success: false,
        error: 'R2 storage is not configured. Set R2_* environment variables to enable backups.',
        r2Status: getR2Status(),
      });
    }

    const db = getDb();
    const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), 'borealismark.db');

    if (!existsSync(dbPath)) {
      return res.status(500).json({
        success: false,
        error: 'Database file not found at expected path.',
      });
    }

    // Create a backup copy using SQLite's backup API (safe for WAL mode)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const backupPath = path.join('/tmp', `borealismark-backup-${timestamp}.db`);

    // Use SQLite VACUUM INTO for a clean, consistent backup
    db.exec(`VACUUM INTO '${backupPath}'`);

    // Compress the backup
    const compressedPath = `${backupPath}.gz`;
    execSync(`gzip -c "${backupPath}" > "${compressedPath}"`);

    const backupStats = statSync(compressedPath);
    logger.info('Database backup created', {
      originalSize: statSync(backupPath).size,
      compressedSize: backupStats.size,
      path: compressedPath,
    });

    // Upload to R2
    const result = await uploadDatabaseBackup(compressedPath, `borealismark-${timestamp}.db.gz`);

    // Clean up temp files
    try {
      execSync(`rm -f "${backupPath}" "${compressedPath}"`);
    } catch { /* best effort cleanup */ }

    logger.info('Database backup uploaded to R2', {
      key: result.key,
      size: result.size,
      url: result.url,
    });

    res.json({
      success: true,
      data: {
        key: result.key,
        size: result.size,
        sizeHuman: `${(result.size / 1024 / 1024).toFixed(2)} MB`,
        url: result.url,
        createdAt: Date.now(),
      },
    });
  } catch (err: any) {
    logger.error('Database backup failed', { error: err.message });
    res.status(500).json({
      success: false,
      error: 'Database backup failed',
      details: err.message,
    });
  }
});

// ─── GET /r2-status — Check R2 storage configuration ────────────────────────

router.get('/r2-status', requireAuth, requireAdmin, (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: getR2Status(),
  });
});

// ── Database Backup ─────────────────────────────────────────────────────────
// Downloads a live copy of the SQLite database.
// Uses SQLite's backup API (via VACUUM INTO) for crash-safe snapshots.
// Admin-only. KAEL mandate: "No deploy without a backup."
router.get('/backup/db', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const backupDir = process.env.BACKUP_DIR ?? '/tmp';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `borealis-backup-${timestamp}.db`);

    // VACUUM INTO creates an atomic snapshot — safe even under concurrent writes
    db.exec(`VACUUM INTO '${backupPath}'`);

    const stats = statSync(backupPath);
    logger.info('Database backup created', {
      path: backupPath,
      sizeBytes: stats.size,
      timestamp,
      requestedBy: (req as any).user?.email,
    });

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="borealis-backup-${timestamp}.db"`);
    res.setHeader('Content-Length', stats.size.toString());

    const { createReadStream } = require('fs');
    const stream = createReadStream(backupPath);
    stream.pipe(res);

    // Clean up temp file after download
    stream.on('end', () => {
      try { require('fs').unlinkSync(backupPath); } catch {}
    });
  } catch (err: any) {
    logger.error('Database backup failed', { error: err.message });
    res.status(500).json({
      success: false,
      error: 'Backup failed: ' + err.message,
      timestamp: Date.now(),
    });
  }
});

// ── Database Download via Master Key (for automated backup scripts) ──────────
// Authenticates with X-Master-Key header only — no JWT required.
// Use this endpoint in cron jobs / backup scripts.
router.get('/backup/db-download', requireMasterKey, (req: Request, res: Response) => {
  try {
    const { createReadStream } = require('fs');
    const db = getDb();
    const backupDir = process.env.BACKUP_DIR ?? '/tmp';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `borealis-backup-${timestamp}.db`);

    db.exec(`VACUUM INTO '${backupPath}'`);

    const stats = statSync(backupPath);
    logger.info('Database backup downloaded via master key', {
      path: backupPath,
      sizeBytes: stats.size,
      timestamp,
    });

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="borealis-backup-${timestamp}.db"`);
    res.setHeader('Content-Length', stats.size.toString());

    const stream = createReadStream(backupPath);
    stream.pipe(res);
    stream.on('end', () => {
      try { require('fs').unlinkSync(backupPath); } catch {}
    });
  } catch (err: any) {
    logger.error('Database backup failed', { error: err.message });
    res.status(500).json({ success: false, error: 'Backup failed: ' + err.message });
  }
});

// ── Database Stats (for monitoring) ─────────────────────────────────────────
router.get('/backup/stats', requireAuth, requireAdmin, (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const tables = db.prepare(`
      SELECT name, (SELECT COUNT(*) FROM pragma_table_info(name)) as columns
      FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as any[];

    const counts: Record<string, number> = {};
    for (const t of tables) {
      try {
        const row = db.prepare(`SELECT COUNT(*) as count FROM "${t.name}"`).get() as any;
        counts[t.name] = row.count;
      } catch { counts[t.name] = -1; }
    }

    const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), 'borealismark.db');
    const dbSize = existsSync(dbPath) ? statSync(dbPath).size : 0;

    res.json({
      success: true,
      data: {
        databaseSizeBytes: dbSize,
        databaseSizeMB: (dbSize / 1024 / 1024).toFixed(2),
        tableCount: tables.length,
        tables: counts,
      },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message, timestamp: Date.now() });
  }
});

// ─── LICENSE MANAGEMENT (JWT-authenticated for Mission Control) ──────────────

// GET /admin/licenses — Full license audit dashboard
router.get('/licenses', requireAuth, requireAdmin, (_req: Request, res: Response) => {
  try {
    const db = getDb();

    // Stats
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status='suspended' THEN 1 ELSE 0 END) as suspended,
        SUM(CASE WHEN status='revoked' THEN 1 ELSE 0 END) as revoked,
        SUM(CASE WHEN status='terminated' THEN 1 ELSE 0 END) as terminated,
        SUM(CASE WHEN agent_id IS NOT NULL THEN 1 ELSE 0 END) as activated,
        SUM(CASE WHEN agent_id IS NULL THEN 1 ELSE 0 END) as unactivated
      FROM licenses
    `).get() as any;

    const revenue = db.prepare(`
      SELECT
        COALESCE(SUM(purchase_price), 0) as totalRevenue,
        COUNT(CASE WHEN purchase_price > 0 THEN 1 END) as totalPurchases,
        COALESCE(AVG(CASE WHEN purchase_price > 0 THEN purchase_price END), 0) as averagePrice
      FROM licenses
    `).get() as any;

    // All licenses with user and agent info
    const licenses = db.prepare(`
      SELECT
        l.id, l.key_prefix, l.key_hash, l.user_id, l.agent_id, l.agent_name,
        l.status, l.status_reason, l.license_tier, l.slot_cap, l.slots_used,
        l.score_ceiling, l.purchase_price, l.payment_method, l.order_id,
        l.created_at, l.activated_at, l.last_verified_at, l.verify_count,
        l.hedera_tx_id, l.ip_address,
        u.name as user_name, u.email as user_email,
        a.bts_score, a.credit_rating
      FROM licenses l
      LEFT JOIN users u ON l.user_id = u.id
      LEFT JOIN agents a ON l.agent_id = a.id
      ORDER BY l.created_at DESC
    `).all();

    // Recent audit events
    const recentEvents = db.prepare(`
      SELECT id, license_id, key_prefix, user_id, event_type, event_data, actor, ip_address, created_at
      FROM license_audit_log
      ORDER BY created_at DESC
      LIMIT 50
    `).all();

    res.json({
      success: true,
      stats,
      revenue,
      licenses,
      recentEvents,
      timestamp: Date.now(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message, timestamp: Date.now() });
  }
});

// POST /admin/licenses/:id/suspend — Temporarily suspend a license
router.post('/licenses/:id/suspend', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { reason } = req.body;
    if (!reason) { res.status(400).json({ success: false, error: 'Reason required' }); return; }

    const license = db.prepare('SELECT * FROM licenses WHERE id = ?').get(id) as any;
    if (!license) { res.status(404).json({ success: false, error: 'License not found' }); return; }
    if (license.status !== 'active') { res.status(400).json({ success: false, error: `Cannot suspend: status is ${license.status}` }); return; }

    db.prepare('UPDATE licenses SET status = ?, status_reason = ? WHERE id = ?').run('suspended', reason, id);

    // Audit log
    db.prepare(`INSERT INTO license_audit_log (license_id, key_prefix, user_id, event_type, event_data, actor, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      id, license.key_prefix, license.user_id, 'suspended',
      JSON.stringify({ reason, previousStatus: 'active' }),
      'admin:mc', req.ip
    );

    res.json({ success: true, licenseId: id, status: 'suspended', reason, timestamp: Date.now() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message, timestamp: Date.now() });
  }
});

// POST /admin/licenses/:id/restore — Restore a suspended license
router.post('/licenses/:id/restore', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { reason } = req.body;
    if (!reason) { res.status(400).json({ success: false, error: 'Reason required' }); return; }

    const license = db.prepare('SELECT * FROM licenses WHERE id = ?').get(id) as any;
    if (!license) { res.status(404).json({ success: false, error: 'License not found' }); return; }
    if (license.status !== 'suspended') { res.status(400).json({ success: false, error: `Cannot restore: status is ${license.status}` }); return; }

    db.prepare('UPDATE licenses SET status = ?, status_reason = ? WHERE id = ?').run('active', reason, id);

    db.prepare(`INSERT INTO license_audit_log (license_id, key_prefix, user_id, event_type, event_data, actor, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      id, license.key_prefix, license.user_id, 'restored',
      JSON.stringify({ reason, previousStatus: 'suspended' }),
      'admin:mc', req.ip
    );

    res.json({ success: true, licenseId: id, status: 'active', reason, timestamp: Date.now() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message, timestamp: Date.now() });
  }
});

// POST /admin/licenses/:id/revoke — Permanently revoke a license
router.post('/licenses/:id/revoke', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { reason } = req.body;
    if (!reason) { res.status(400).json({ success: false, error: 'Reason required' }); return; }

    const license = db.prepare('SELECT * FROM licenses WHERE id = ?').get(id) as any;
    if (!license) { res.status(404).json({ success: false, error: 'License not found' }); return; }
    if (license.status === 'revoked' || license.status === 'terminated') {
      res.status(400).json({ success: false, error: `Already ${license.status}` }); return;
    }

    db.prepare('UPDATE licenses SET status = ?, status_reason = ? WHERE id = ?').run('revoked', reason, id);

    // Also terminate bound agent if exists
    if (license.agent_id) {
      db.prepare('UPDATE agents SET status = ?, status_reason = ? WHERE id = ?').run('terminated', `License revoked: ${reason}`, license.agent_id);
    }

    db.prepare(`INSERT INTO license_audit_log (license_id, key_prefix, user_id, event_type, event_data, actor, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      id, license.key_prefix, license.user_id, 'revoked',
      JSON.stringify({ reason, previousStatus: license.status, agentTerminated: !!license.agent_id }),
      'admin:mc', req.ip
    );

    res.json({ success: true, licenseId: id, status: 'revoked', reason, agentTerminated: !!license.agent_id, timestamp: Date.now() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message, timestamp: Date.now() });
  }
});

// DELETE /admin/licenses/:id — Hard delete a license (test cleanup only)
router.delete('/licenses/:id', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { id } = req.params;

    const license = db.prepare('SELECT * FROM licenses WHERE id = ?').get(id) as any;
    if (!license) { res.status(404).json({ success: false, error: 'License not found' }); return; }

    // Delete audit log entries first
    db.prepare('DELETE FROM license_audit_log WHERE license_id = ?').run(id);
    // Delete score history
    try { db.prepare('DELETE FROM license_score_history WHERE license_id = ?').run(id); } catch {}
    // Delete the license
    db.prepare('DELETE FROM licenses WHERE id = ?').run(id);

    db.prepare(`INSERT INTO license_audit_log (license_id, key_prefix, user_id, event_type, event_data, actor, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      id, license.key_prefix, license.user_id, 'deleted',
      JSON.stringify({ reason: 'Admin hard delete', previousStatus: license.status }),
      'admin:mc', req.ip
    );

    res.json({ success: true, licenseId: id, deleted: true, timestamp: Date.now() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message, timestamp: Date.now() });
  }
});

// POST /admin/licenses/generate-free — Generate a free BTS key from MC
router.post('/licenses/generate-free', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { email, agent_name } = req.body;
    if (!email) { res.status(400).json({ success: false, error: 'Email required' }); return; }

    const crypto = require('crypto');

    // Check for existing free key for this email (warn, don't block - admin override)
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
    if (user) {
      const existingFree = db.prepare('SELECT id, key_prefix, status FROM licenses WHERE user_id = ? AND license_tier = ?').get(user.id, 'free') as any;
      if (existingFree && !req.body.force) {
        res.status(409).json({
          success: false,
          error: `This email already has a free key (${existingFree.key_prefix}••••, status: ${existingFree.status}). Send force: true to override.`,
          existingKeyPrefix: existingFree.key_prefix,
          existingStatus: existingFree.status,
        });
        return;
      }
    }

    // Create user if not exists
    if (!user) {
      const userId = crypto.randomUUID();
      db.prepare('INSERT INTO users (id, name, email, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
        userId, email.split('@')[0], email, 'user', new Date().toISOString()
      );
      user = { id: userId, email };
    }

    // Generate BTS key
    const rawKey = `BTS-${generateKeySegment()}-${generateKeySegment()}-${generateKeySegment()}-${generateKeySegment()}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.substring(0, 8);
    const licenseId = crypto.randomUUID();

    db.prepare(`INSERT INTO licenses (id, key_hash, key_prefix, user_id, license_tier, status, score_ceiling, slot_cap, slots_used, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      licenseId, keyHash, keyPrefix, user.id, 'free', 'active', 65, 1, 0, new Date().toISOString()
    );

    // Audit log
    db.prepare(`INSERT INTO license_audit_log (license_id, key_prefix, user_id, event_type, event_data, actor, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      licenseId, keyPrefix, user.id, 'generated',
      JSON.stringify({ tier: 'free', source: 'mission-control', agent_name: agent_name || null }),
      'admin:mc', req.ip
    );

    res.json({
      success: true,
      licenseId,
      keyPrefix,
      rawKey,
      tier: 'free',
      email,
      userId: user.id,
      timestamp: Date.now(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message, timestamp: Date.now() });
  }
});

function generateKeySegment(): string {
  const crypto = require('crypto');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(4);
  let segment = '';
  for (let i = 0; i < 4; i++) {
    segment += chars[bytes[i] % chars.length];
  }
  return segment;
}

export default router;
