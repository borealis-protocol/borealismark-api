/**
 * BorealisMark — Analytics, Fleet Management & Batch Operations
 *
 * Delivers on Agent Plan promises:
 *   Pro:    Enhanced analytics dashboard
 *   Elite:  Fleet management tools + Dedicated audit pipeline
 *   Business API: Batch operations
 *
 * Routes:
 *   GET  /v1/analytics/dashboard      — Enhanced analytics (Pro+)
 *   GET  /v1/analytics/bots/:id/trend — Bot score trend over time (Pro+)
 *   GET  /v1/analytics/fleet          — Fleet overview (Elite only)
 *   POST /v1/analytics/fleet/action   — Fleet batch actions (Elite only)
 *   POST /v1/analytics/batch/audit    — Batch audit (Business API+)
 *   POST /v1/analytics/batch/bots     — Batch bot operations (Business API+)
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthRequest } from './auth';
import { logger } from '../middleware/logger';
import {
  getDb,
  getUserById,
  getBotsByOwnerId,
  getBotById,
  updateBot,
  countBotsByOwnerId,
} from '../db/database';

const router = Router();

// ─── Tier Gating Middleware ──────────────────────────────────────────────────

function requireTier(...allowedTiers: string[]) {
  return (req: Request, res: Response, next: Function) => {
    const userId = (req as any).user?.sub;
    if (!userId) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    const user = getUserById(userId);
    if (!user || !allowedTiers.includes(user.tier)) {
      res.status(403).json({
        success: false,
        error: `This feature requires ${allowedTiers.join(' or ')} tier`,
        currentTier: user?.tier ?? 'unknown',
        requiredTier: allowedTiers,
      });
      return;
    }
    next();
  };
}

// ─── GET /dashboard — Enhanced Analytics (Pro+) ─────────────────────────────

router.get('/dashboard', requireAuth, requireTier('pro', 'elite'), (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.sub;
    const db = getDb();

    // Bot overview
    const bots = getBotsByOwnerId(userId);
    const activeBots = bots.filter((b: any) => b.status === 'active');
    const totalAP = bots.reduce((sum: number, b: any) => sum + (b.ap_points || 0), 0);
    const avgRating = bots.length > 0
      ? bots.reduce((sum: number, b: any) => sum + (b.star_rating || 0), 0) / bots.length
      : 0;
    const totalJobs = bots.reduce((sum: number, b: any) => sum + (b.jobs_completed || 0), 0);
    const totalFailed = bots.reduce((sum: number, b: any) => sum + (b.jobs_failed || 0), 0);

    // Audit history (last 30 days)
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const auditHistory = db.prepare(`
      SELECT a.score, a.credit_rating, a.created_at, ag.name as agent_name
      FROM audit_results a
      JOIN agents ag ON a.agent_id = ag.id
      WHERE ag.owner_id = ? AND a.created_at > ?
      ORDER BY a.created_at DESC
      LIMIT 100
    `).all(userId, thirtyDaysAgo) as any[];

    // AP trend (weekly for last 12 weeks)
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const apTrend = [];
    for (let i = 11; i >= 0; i--) {
      const weekStart = Date.now() - (i + 1) * weekMs;
      const weekEnd = Date.now() - i * weekMs;
      const weekJobs = db.prepare(`
        SELECT SUM(ap_earned) as total_ap, COUNT(*) as job_count
        FROM bot_jobs
        WHERE bot_id IN (SELECT id FROM bots WHERE owner_id = ?)
        AND completed_at BETWEEN ? AND ?
        AND status = 'completed'
      `).get(userId, weekStart, weekEnd) as any;
      apTrend.push({
        weekStart: new Date(weekStart).toISOString().split('T')[0],
        totalAP: weekJobs?.total_ap || 0,
        jobCount: weekJobs?.job_count || 0,
      });
    }

    // Top performing bots
    const topBots = [...bots]
      .sort((a: any, b: any) => (b.ap_points || 0) - (a.ap_points || 0))
      .slice(0, 5)
      .map((b: any) => ({
        id: b.id,
        name: b.name,
        apPoints: b.ap_points,
        starRating: b.star_rating,
        jobsCompleted: b.jobs_completed,
        tier: b.tier,
      }));

    // Score distribution
    const scoreDistribution = db.prepare(`
      SELECT
        CASE
          WHEN score >= 90 THEN 'A (90-100)'
          WHEN score >= 80 THEN 'B (80-89)'
          WHEN score >= 70 THEN 'C (70-79)'
          WHEN score >= 60 THEN 'D (60-69)'
          ELSE 'F (0-59)'
        END as grade,
        COUNT(*) as count
      FROM audit_results
      WHERE agent_id IN (SELECT id FROM agents WHERE owner_id = ?)
      GROUP BY grade
      ORDER BY MIN(score) DESC
    `).all(userId) as any[];

    res.json({
      success: true,
      data: {
        overview: {
          totalBots: bots.length,
          activeBots: activeBots.length,
          totalAP,
          averageRating: Math.round(avgRating * 100) / 100,
          totalJobsCompleted: totalJobs,
          totalJobsFailed: totalFailed,
          successRate: totalJobs + totalFailed > 0
            ? Math.round((totalJobs / (totalJobs + totalFailed)) * 10000) / 100
            : 0,
        },
        apTrend,
        topBots,
        recentAudits: auditHistory.map((a: any) => ({
          agentName: a.agent_name,
          score: a.score,
          creditRating: a.credit_rating,
          date: new Date(a.created_at).toISOString(),
        })),
        scoreDistribution,
      },
    });
  } catch (err: any) {
    logger.error('Analytics dashboard error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load analytics' });
  }
});

// ─── GET /bots/:id/trend — Bot Score Trend (Pro+) ──────────────────────────

router.get('/bots/:id/trend', requireAuth, requireTier('pro', 'elite'), (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.sub;
    const { id } = req.params;
    const bot = getBotById(id);

    if (!bot || bot.owner_id !== userId) {
      res.status(404).json({ success: false, error: 'Bot not found' });
      return;
    }

    const db = getDb();

    // Job history with AP earned
    const jobHistory = db.prepare(`
      SELECT status, rating, ap_earned, completed_at, created_at, title
      FROM bot_jobs
      WHERE bot_id = ?
      ORDER BY created_at DESC
      LIMIT 50
    `).all(id) as any[];

    // AP accumulation over time
    let cumulativeAP = 0;
    const apAccumulation = jobHistory
      .filter((j: any) => j.status === 'completed')
      .reverse()
      .map((j: any) => {
        cumulativeAP += j.ap_earned || 0;
        return {
          date: new Date(j.completed_at || j.created_at).toISOString(),
          apEarned: j.ap_earned,
          cumulativeAP,
          rating: j.rating,
        };
      });

    res.json({
      success: true,
      data: {
        botId: id,
        botName: bot.name,
        currentAP: bot.ap_points,
        currentRating: bot.star_rating,
        tier: bot.tier,
        jobHistory: jobHistory.map((j: any) => ({
          title: j.title,
          status: j.status,
          rating: j.rating,
          apEarned: j.ap_earned,
          completedAt: j.completed_at ? new Date(j.completed_at).toISOString() : null,
        })),
        apAccumulation,
      },
    });
  } catch (err: any) {
    logger.error('Bot trend error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load bot trend' });
  }
});

// ─── GET /fleet — Fleet Overview (Elite only) ──────────────────────────────

router.get('/fleet', requireAuth, requireTier('elite'), (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.sub;
    const db = getDb();
    const bots = getBotsByOwnerId(userId);

    // Fleet health summary
    const statusCounts: Record<string, number> = {};
    const tierCounts: Record<string, number> = {};
    let totalJobs = 0;
    let totalAP = 0;

    for (const bot of bots as any[]) {
      statusCounts[bot.status] = (statusCounts[bot.status] || 0) + 1;
      tierCounts[bot.tier] = (tierCounts[bot.tier] || 0) + 1;
      totalJobs += bot.jobs_completed || 0;
      totalAP += bot.ap_points || 0;
    }

    // Active jobs across fleet
    const activeJobs = db.prepare(`
      SELECT bj.id, bj.title, bj.status, bj.bot_id, b.name as bot_name, bj.created_at
      FROM bot_jobs bj
      JOIN bots b ON bj.bot_id = b.id
      WHERE b.owner_id = ? AND bj.status IN ('assigned', 'in_progress')
      ORDER BY bj.created_at DESC
      LIMIT 50
    `).all(userId) as any[];

    // Fleet performance ranking
    const fleetRanking = (bots as any[])
      .map((b: any) => ({
        id: b.id,
        name: b.name,
        status: b.status,
        tier: b.tier,
        apPoints: b.ap_points,
        starRating: b.star_rating,
        jobsCompleted: b.jobs_completed,
        jobsFailed: b.jobs_failed,
        successRate: (b.jobs_completed + b.jobs_failed) > 0
          ? Math.round((b.jobs_completed / (b.jobs_completed + b.jobs_failed)) * 10000) / 100
          : 0,
      }))
      .sort((a, b) => b.apPoints - a.apPoints);

    // Alerts (bots that need attention)
    const alerts = (bots as any[])
      .filter((b: any) => b.status === 'under_review' || b.star_rating < 3.0)
      .map((b: any) => ({
        botId: b.id,
        botName: b.name,
        issue: b.status === 'under_review' ? 'Under review — low rating' : `Low rating: ${b.star_rating.toFixed(1)}`,
        severity: b.star_rating < 2.0 ? 'critical' : 'warning',
      }));

    res.json({
      success: true,
      data: {
        fleet: {
          totalBots: bots.length,
          maxBots: 50,
          totalAP,
          totalJobsCompleted: totalJobs,
          statusBreakdown: statusCounts,
          tierBreakdown: tierCounts,
        },
        activeJobs: activeJobs.map((j: any) => ({
          jobId: j.id,
          title: j.title,
          status: j.status,
          botId: j.bot_id,
          botName: j.bot_name,
          assignedAt: new Date(j.created_at).toISOString(),
        })),
        ranking: fleetRanking,
        alerts,
      },
    });
  } catch (err: any) {
    logger.error('Fleet overview error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load fleet overview' });
  }
});

// ─── POST /fleet/action — Fleet Batch Action (Elite only) ──────────────────

const fleetActionSchema = z.object({
  action: z.enum(['pause_all', 'resume_all', 'pause_selected', 'resume_selected']),
  botIds: z.array(z.string()).optional(), // Required for 'selected' actions
});

router.post('/fleet/action', requireAuth, requireTier('elite'), (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.sub;
    const parsed = fleetActionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { action, botIds } = parsed.data;
    const bots = getBotsByOwnerId(userId) as any[];
    let affected = 0;

    const targetBots = (action.includes('selected') && botIds)
      ? bots.filter((b: any) => botIds.includes(b.id))
      : bots;

    for (const bot of targetBots) {
      if (action.includes('pause') && bot.status === 'active') {
        updateBot(bot.id, { status: 'paused' as any, updated_at: Date.now() } as any);
        affected++;
      } else if (action.includes('resume') && bot.status === 'paused') {
        updateBot(bot.id, { status: 'active' as any, updated_at: Date.now() } as any);
        affected++;
      }
    }

    logger.info('Fleet action executed', { userId, action, affected, total: targetBots.length });

    res.json({
      success: true,
      data: {
        action,
        botsAffected: affected,
        botsTotal: targetBots.length,
      },
    });
  } catch (err: any) {
    logger.error('Fleet action error', { error: err.message });
    res.status(500).json({ success: false, error: 'Fleet action failed' });
  }
});

// ─── POST /batch/audit — Batch Audit (Business API+) ───────────────────────

const batchAuditSchema = z.object({
  agentIds: z.array(z.string()).min(1).max(50),
});

router.post('/batch/audit', requireAuth, requireTier('pro', 'elite'), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.sub;
    const parsed = batchAuditSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const db = getDb();
    const { agentIds } = parsed.data;
    const results: any[] = [];
    const errors: any[] = [];

    for (const agentId of agentIds) {
      // Verify ownership
      const agent = db.prepare('SELECT * FROM agents WHERE id = ? AND owner_id = ?').get(agentId, userId) as any;
      if (!agent) {
        errors.push({ agentId, error: 'Not found or not owned by you' });
        continue;
      }

      // Get latest audit result
      const latest = db.prepare('SELECT * FROM audit_results WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1').get(agentId) as any;
      results.push({
        agentId,
        agentName: agent.name,
        latestScore: latest?.score ?? null,
        creditRating: latest?.credit_rating ?? null,
        lastAuditedAt: latest?.created_at ? new Date(latest.created_at).toISOString() : null,
      });
    }

    res.json({
      success: true,
      data: {
        results,
        errors,
        total: agentIds.length,
        succeeded: results.length,
        failed: errors.length,
      },
    });
  } catch (err: any) {
    logger.error('Batch audit error', { error: err.message });
    res.status(500).json({ success: false, error: 'Batch audit failed' });
  }
});

// ─── POST /batch/bots — Batch Bot Operations (Business API+) ───────────────

const batchBotSchema = z.object({
  action: z.enum(['status', 'update_description', 'export']),
  botIds: z.array(z.string()).min(1).max(100),
  description: z.string().max(2000).optional(), // For update_description
});

router.post('/batch/bots', requireAuth, requireTier('pro', 'elite'), (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.sub;
    const parsed = batchBotSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { action, botIds, description } = parsed.data;
    const results: any[] = [];
    const errors: any[] = [];

    for (const botId of botIds) {
      const bot = getBotById(botId) as any;
      if (!bot || bot.owner_id !== userId) {
        errors.push({ botId, error: 'Not found or not owned by you' });
        continue;
      }

      if (action === 'status') {
        results.push({
          botId,
          name: bot.name,
          status: bot.status,
          apPoints: bot.ap_points,
          starRating: bot.star_rating,
          tier: bot.tier,
          jobsCompleted: bot.jobs_completed,
        });
      } else if (action === 'update_description' && description) {
        updateBot(botId, { description, updated_at: Date.now() } as any);
        results.push({ botId, name: bot.name, updated: true });
      } else if (action === 'export') {
        results.push({
          botId,
          name: bot.name,
          type: bot.type,
          description: bot.description,
          status: bot.status,
          tier: bot.tier,
          apPoints: bot.ap_points,
          starRating: bot.star_rating,
          jobsCompleted: bot.jobs_completed,
          jobsFailed: bot.jobs_failed,
          totalRatings: bot.total_ratings,
          createdAt: new Date(bot.created_at).toISOString(),
        });
      }
    }

    logger.info('Batch bot operation', { userId, action, succeeded: results.length, failed: errors.length });

    res.json({
      success: true,
      data: {
        action,
        results,
        errors,
        total: botIds.length,
        succeeded: results.length,
        failed: errors.length,
      },
    });
  } catch (err: any) {
    logger.error('Batch bot error', { error: err.message });
    res.status(500).json({ success: false, error: 'Batch operation failed' });
  }
});

export default router;
