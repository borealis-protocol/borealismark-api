/**
 * BorealisMark — Academy Progression Routes
 *
 * AP/XP leveling system, badges, leaderboard, and progression tracking.
 *
 *   GET  /v1/progression/me           — Current user's full progression state
 *   GET  /v1/progression/me/badges    — Current user's earned badges
 *   GET  /v1/progression/me/xp-history — XP transaction history
 *   GET  /v1/progression/me/ap-history — AP transaction history
 *   POST /v1/progression/me/featured-badge — Set featured badge
 *   POST /v1/progression/me/mark-seen — Mark badges as seen
 *   POST /v1/progression/award-xp     — Award XP (authenticated action)
 *   POST /v1/progression/award-ap     — Award AP (authenticated action)
 *   POST /v1/progression/game-played  — Record game played
 *   GET  /v1/progression/leaderboard  — Public leaderboard
 *   GET  /v1/progression/badges       — All badge definitions
 *   GET  /v1/progression/levels       — All level definitions
 *   GET  /v1/progression/user/:userId — Public profile progression
 */

import { Router, type Request, type Response } from 'express';
import { requireAuth, type AuthRequest, type JwtPayload } from './auth';
import {
  getUserProgression,
  getUserBadges,
  getAllBadgeDefinitions,
  getXpHistory,
  getApHistory,
  getLeaderboard,
  awardXp,
  awardAp,
  recordGamePlayed,
  setFeaturedBadge,
  markBadgesSeen,
  ensureUserProgression,
  xpForLevel,
  cumulativeXpForLevel,
  getDb,
} from '../db/database';
import { logger } from '../middleware/logger';

const router = Router();

// ─── GET /me — Full progression state ─────────────────────────────────────

router.get('/me', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user as JwtPayload;
    const progression = getUserProgression(userId);
    const badges = getUserBadges(userId);
    const unseenBadges = badges.filter((b: any) => !b.seen);

    res.json({
      success: true,
      data: {
        ...progression,
        badges,
        unseenBadgeCount: unseenBadges.length,
      },
    });
  } catch (err: any) {
    logger.error('Progression fetch error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch progression' });
  }
});

// ─── GET /me/badges — User's earned badges ────────────────────────────────

router.get('/me/badges', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user as JwtPayload;
    const badges = getUserBadges(userId);
    res.json({ success: true, data: badges });
  } catch (err: any) {
    logger.error('Badge fetch error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch badges' });
  }
});

// ─── GET /me/xp-history — XP transaction log ──────────────────────────────

router.get('/me/xp-history', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user as JwtPayload;
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
    const offset = parseInt(req.query.offset as string) || 0;
    const history = getXpHistory(userId, limit, offset);
    res.json({ success: true, data: history });
  } catch (err: any) {
    logger.error('XP history error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch XP history' });
  }
});

// ─── GET /me/ap-history — AP transaction log ──────────────────────────────

router.get('/me/ap-history', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user as JwtPayload;
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
    const offset = parseInt(req.query.offset as string) || 0;
    const history = getApHistory(userId, limit, offset);
    res.json({ success: true, data: history });
  } catch (err: any) {
    logger.error('AP history error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch AP history' });
  }
});

// ─── POST /me/featured-badge — Set featured badge ─────────────────────────

router.post('/me/featured-badge', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user as JwtPayload;
    const { badgeId } = req.body;
    setFeaturedBadge(userId, badgeId || null);
    res.json({ success: true, data: { message: 'Featured badge updated' } });
  } catch (err: any) {
    logger.error('Featured badge error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to set featured badge' });
  }
});

// ─── POST /me/mark-seen — Mark badges as seen ─────────────────────────────

router.post('/me/mark-seen', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user as JwtPayload;
    const { badgeIds } = req.body;
    if (!Array.isArray(badgeIds)) {
      res.status(400).json({ success: false, error: 'badgeIds must be an array' });
      return;
    }
    markBadgesSeen(userId, badgeIds);
    res.json({ success: true, data: { message: 'Badges marked as seen' } });
  } catch (err: any) {
    logger.error('Mark seen error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to mark badges' });
  }
});

// ─── POST /award-xp — Award XP to current user ───────────────────────────
// Used by frontend for client-triggered XP events (games, article reads, etc.)

router.post('/award-xp', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user as JwtPayload;
    const { amount, source, description, sourceId } = req.body;

    if (!amount || !source || !description) {
      res.status(400).json({ success: false, error: 'amount, source, and description are required' });
      return;
    }

    // Cap per-request XP to prevent abuse (max 500 per action)
    const cappedAmount = Math.min(500, Math.max(1, parseInt(amount)));

    // Daily XP cap: 5000 per day
    const today = new Date().toISOString().slice(0, 10);
    const todayLog = getDb().prepare(
      'SELECT xp_earned_today FROM daily_activity_log WHERE user_id = ? AND activity_date = ?'
    ).get(userId, today) as { xp_earned_today: number } | undefined;

    if (todayLog && todayLog.xp_earned_today >= 5000) {
      res.json({
        success: true,
        data: { message: 'Daily XP cap reached', capped: true, dailyXpEarned: todayLog.xp_earned_today },
      });
      return;
    }

    const result = awardXp(userId, cappedAmount, source, description, sourceId);

    res.json({
      success: true,
      data: {
        ...result.transaction,
        leveledUp: result.leveledUp,
        newLevel: result.newLevel,
        newTitle: result.newTitle,
        newTier: result.newTier,
        badgesEarned: result.badgesEarned,
      },
    });
  } catch (err: any) {
    logger.error('Award XP error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to award XP' });
  }
});

// ─── POST /award-ap — Award AP to current user ───────────────────────────

router.post('/award-ap', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user as JwtPayload;
    const { amount, source, description, sourceId } = req.body;

    if (!amount || !source || !description) {
      res.status(400).json({ success: false, error: 'amount, source, and description are required' });
      return;
    }

    // Cap per-request AP
    const cappedAmount = Math.min(200, Math.max(1, parseInt(amount)));

    const result = awardAp(userId, cappedAmount, source, description, sourceId);

    res.json({
      success: true,
      data: {
        ...result.transaction,
        badgesEarned: result.badgesEarned,
      },
    });
  } catch (err: any) {
    logger.error('Award AP error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to award AP' });
  }
});

// ─── POST /game-played — Record game completion ──────────────────────────

router.post('/game-played', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user as JwtPayload;
    const { won, gameType } = req.body;

    recordGamePlayed(userId, !!won);

    // Award XP for playing
    const xpAmount = won ? 50 : 15;
    const result = awardXp(userId, xpAmount, 'game_complete', `${won ? 'Won' : 'Played'} ${gameType || 'a game'}`, gameType);

    res.json({
      success: true,
      data: {
        ...result.transaction,
        leveledUp: result.leveledUp,
        newLevel: result.newLevel,
        newTitle: result.newTitle,
        badgesEarned: result.badgesEarned,
      },
    });
  } catch (err: any) {
    logger.error('Game played error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to record game' });
  }
});

// ─── GET /leaderboard — Public leaderboard ────────────────────────────────

router.get('/leaderboard', (_req: Request, res: Response) => {
  try {
    const limit = Math.min(100, parseInt(_req.query.limit as string) || 25);
    const leaders = getLeaderboard(limit);
    // Mask emails for privacy
    const masked = leaders.map((l: any) => ({
      ...l,
      email: undefined,
      displayName: l.name || (l.email ? l.email.split('@')[0] : 'Anonymous'),
    }));
    res.json({ success: true, data: masked });
  } catch (err: any) {
    logger.error('Leaderboard error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch leaderboard' });
  }
});

// ─── GET /badges — All badge definitions ──────────────────────────────────

router.get('/badges', (_req: Request, res: Response) => {
  try {
    const badges = getAllBadgeDefinitions();
    res.json({ success: true, data: badges });
  } catch (err: any) {
    logger.error('Badge definitions error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch badges' });
  }
});

// ─── GET /levels — All level definitions ──────────────────────────────────

router.get('/levels', (_req: Request, res: Response) => {
  try {
    const levels = getDb().prepare(
      'SELECT * FROM level_definitions ORDER BY min_level ASC'
    ).all();

    // Enhance with XP thresholds
    const enhanced = (levels as any[]).map((l: any) => ({
      ...l,
      xpToReachMin: cumulativeXpForLevel(l.min_level),
      xpToReachMax: cumulativeXpForLevel(l.max_level),
      xpPerLevel: xpForLevel(l.min_level + 1),
    }));

    res.json({ success: true, data: enhanced });
  } catch (err: any) {
    logger.error('Level definitions error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch levels' });
  }
});

// ─── GET /user/:userId — Public profile progression ──────────────────────

router.get('/user/:userId', (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const progression = getUserProgression(userId);
    const badges = getUserBadges(userId);

    // Return public-safe data only
    res.json({
      success: true,
      data: {
        level: progression.level,
        title: progression.title,
        tier: progression.tier,
        tierColor: progression.tierColor,
        xpTotal: progression.xpTotal,
        apTotal: progression.apTotal,
        apRank: progression.apRank,
        currentStreak: progression.currentStreak,
        longestStreak: progression.longestStreak,
        gamesPlayed: progression.gamesPlayed,
        badges: badges.map((b: any) => ({
          name: b.name, description: b.description, category: b.category,
          rarity: b.rarity, earnedAt: b.earned_at,
        })),
        featuredBadgeId: progression.featuredBadgeId,
      },
    });
  } catch (err: any) {
    logger.error('Public progression error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch progression' });
  }
});

export default router;
