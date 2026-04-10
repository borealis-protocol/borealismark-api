/**
 * BorealisMark — Authentication Routes
 *
 * JWT-based user authentication for the platform dashboard.
 *
 *   POST /v1/auth/register  — Create account (email + password)
 *   POST /v1/auth/login     — Authenticate → JWT
 *   GET  /v1/auth/me        — Get current user profile (requires JWT)
 *   POST /v1/auth/refresh   — Refresh an expiring token
 */

import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import {
  createUser,
  getDb,
  getUserByEmail,
  getUserById,
  updateUserLogin,
  updateUserRole,
  createPasswordResetToken,
  getValidPasswordResetToken,
  markPasswordResetTokenUsed,
  updateUserPassword,
  getUserSanction,
  setEmailVerified,
  createEmailVerificationToken,
  getValidEmailVerificationToken,
} from '../db/database';
import { sendAccountDeletionEmail } from '../services/email';
import { logger } from '../middleware/logger';
import { authLimiter, passwordResetLimiter } from '../middleware/rateLimiter';
import { events as eventBus } from '../services/eventBus';
import { sendPasswordResetEmail, sendVerificationEmail } from '../services/email';
import { computeAndStoreTrustScore, getTrustScore } from '../db/database';

const router = Router();

// ─── Config ──────────────────────────────────────────────────────────────────

const JWT_SECRET = (() => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    logger.error('FATAL: JWT_SECRET environment variable is not set. Server cannot start without it.');
    process.exit(1);
  }
  if (secret.length < 32) {
    logger.error('FATAL: JWT_SECRET must be at least 32 characters for security.');
    process.exit(1);
  }
  return secret;
})();
const JWT_EXPIRES_IN = '24h';
const JWT_REFRESH_WINDOW = 2 * 60 * 60 * 1000; // last 2 hours — eligible for refresh
const BCRYPT_ROUNDS = 12;

// ─── Schemas ─────────────────────────────────────────────────────────────────

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password too long')
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
      'Password must contain uppercase, lowercase, and a number',
    ),
  name: z.string().min(1, 'Name is required').max(100).trim(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  newPassword: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password too long')
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
      'Password must contain uppercase, lowercase, and a number',
    ),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function signToken(userId: string, email: string, tier: string, role: string = 'user'): string {
  return jwt.sign(
    { sub: userId, email, tier, role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );
}

/**
 * JWT payload shape decoded from the Bearer token.
 */
export interface JwtPayload {
  sub: string;
  email: string;
  tier: string;
  role: string;
  iat: number;
  exp: number;
}

/**
 * Request with authenticated user attached.
 */
export interface AuthRequest extends Request {
  user?: JwtPayload;
}

/**
 * Middleware: extract and verify JWT from Authorization header or HttpOnly cookie.
 * Attaches decoded payload to req.user.
 * Supports both Bearer token (Authorization header) and HttpOnly cookie (bm_token).
 */
export function requireAuth(req: Request, res: Response, next: Function): void {
  const header = req.headers.authorization;
  // Try Authorization header first, then fall back to HttpOnly cookie
  const token = header?.startsWith('Bearer ') ? header.slice(7) : (req as any).cookies?.bm_token;

  if (!token) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    (req as any).user = decoded;
    next();
  } catch (err: any) {
    const message = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
    res.status(401).json({ success: false, error: message });
  }
}

// ─── POST /register ──────────────────────────────────────────────────────────

router.post('/register', authLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { email, password, name } = parsed.data;

    // Check if email already exists
    const existing = getUserByEmail(email);
    if (existing) {
      res.status(409).json({
        success: false,
        error: 'An account with this email already exists',
      });
      return;
    }

    // Hash password and create user
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const userId = uuid();

    try {
      createUser(userId, email, passwordHash, name);
    } catch (dbErr: any) {
      logger.error('User creation failed', { email, error: dbErr.message });
      res.status(500).json({ success: false, error: 'Failed to create user account' });
      return;
    }

    // Generate JWT (user can log in but will see verification gate)
    const token = signToken(userId, email, 'standard');

    // Send verification email (non-blocking — don't fail registration if email fails)
    let emailSent = false;
    try {
      const verifyToken = createEmailVerificationToken(userId, email);
      emailSent = await sendVerificationEmail(email, verifyToken, name);
    } catch (emailErr: any) {
      logger.error('Verification email failed', { userId, email, error: emailErr.message });
      // Continue anyway — user can request resend later
    }

    logger.info('User registered', { userId, email, verificationEmailSent: emailSent });
    eventBus.userRegistered(userId, email, name);

    // Set HttpOnly cookie for seamless auth
    res.cookie('bm_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'none',
      maxAge: 24 * 60 * 60 * 1000, // 24h
      path: '/',
    });

    res.status(201).json({
      success: true,
      data: {
        token,
        user: {
          id: userId,
          email: email.toLowerCase().trim(),
          name: name.trim(),
          tier: 'standard',
          emailVerified: false,
          createdAt: Date.now(),
        },
        verificationEmailSent: emailSent,
      },
    });
  } catch (err: any) {
    logger.error('Registration error', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

// ─── POST /login ─────────────────────────────────────────────────────────────

router.post('/login', authLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid credentials format' });
      return;
    }

    const { email, password } = parsed.data;
    const user = getUserByEmail(email);

    if (!user) {
      // Timing-safe: still hash even on miss to prevent timing attacks
      await bcrypt.hash(password, BCRYPT_ROUNDS);
      res.status(401).json({ success: false, error: 'Invalid email or password' });
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ success: false, error: 'Invalid email or password' });
      return;
    }

    // ─── Check if user is banned/suspended ────────────────────────────────
    const sanction = getUserSanction(user.id);
    if (sanction) {
      const now = Date.now();

      if (sanction.status === 'banned') {
        logger.warn('Login attempt by banned user', { userId: user.id, email });
        return res.status(403).json({
          success: false,
          error: 'Your account has been permanently suspended for policy violations.',
          banned: true,
        });
      }

      if (sanction.status === 'suspended' && sanction.suspended_until && sanction.suspended_until > now) {
        const date = new Date(sanction.suspended_until).toLocaleString();
        logger.warn('Login attempt by suspended user', { userId: user.id, email, suspendedUntil: sanction.suspended_until });
        return res.status(403).json({
          success: false,
          error: `Your account is suspended until ${date} for policy violations.`,
          suspended: true,
          suspendedUntil: sanction.suspended_until,
        });
      }
    }

    // Update last login
    updateUserLogin(user.id);

    const token = signToken(user.id, user.email, user.tier, user.role);

    logger.info('User logged in', { userId: user.id, email, role: user.role });
    eventBus.userLogin(user.id);

    // Include mute status in response if applicable
    const muted = sanction?.status === 'muted' && sanction.muted_until && sanction.muted_until > Date.now();

    // Set HttpOnly cookie for seamless auth
    res.cookie('bm_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'none',
      maxAge: 24 * 60 * 60 * 1000, // 24h
      path: '/',
    });

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          tier: user.tier,
          role: user.role,
          emailVerified: user.emailVerified,
          createdAt: user.createdAt,
          lastLoginAt: Date.now(),
        },
        ...(muted && {
          muted: true,
          mutedUntil: sanction?.muted_until,
        }),
      },
    });
  } catch (err: any) {
    logger.error('Login error', { error: err.message });
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// ─── GET /me ─────────────────────────────────────────────────────────────────

router.get('/me', requireAuth, (req: Request, res: Response) => {
  const { sub: userId } = (req as any).user;
  const user = getUserById(userId);

  if (!user) {
    res.status(404).json({ success: false, error: 'User not found' });
    return;
  }

  // Determine user badge from tier
  const TIER_BADGES: Record<string, string | null> = {
    standard: null, pro: 'pro', elite: 'elite', platinum: 'trusted-seller', sovereign: 'sovereign',
  };

  // Compute trust score on profile fetch
  const trustScore = computeAndStoreTrustScore(user.id);

  // Include Academy progression data if exists
  let progression: any = null;
  try {
    const { getUserProgression, getUserBadges } = require('../db/database');
    const prog = getUserProgression(user.id);
    const badges = getUserBadges(user.id);
    progression = {
      level: prog.level,
      title: prog.title,
      tier: prog.tier,
      tierColor: prog.tierColor,
      xpTotal: prog.xpTotal,
      xpProgress: prog.xpProgress,
      xpNeededForNext: prog.xpNeededForNext,
      apTotal: prog.apTotal,
      apRank: prog.apRank,
      currentStreak: prog.currentStreak,
      badgeCount: badges.length,
      featuredBadgeId: prog.featuredBadgeId,
    };
  } catch { /* progression tables may not exist yet */ }

  res.json({
    success: true,
    data: {
      id: user.id,
      email: user.email,
      name: user.name,
      tier: user.tier,
      role: user.role,
      badge: TIER_BADGES[user.tier] ?? null,
      stripeCustomerId: user.stripeCustomerId,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      emailVerified: user.emailVerified,
      trustScore: trustScore.totalScore,
      trustLevel: trustScore.trustLevel,
      progression,
    },
  });
});

// ─── POST /refresh ───────────────────────────────────────────────────────────

router.post('/refresh', requireAuth, (req: Request, res: Response) => {
  const { sub: userId, exp } = (req as any).user;
  const user = getUserById(userId);

  if (!user) {
    res.status(404).json({ success: false, error: 'User not found' });
    return;
  }

  // Only refresh if within the last 2 hours of the token's life
  const now = Math.floor(Date.now() / 1000);
  const remaining = (exp - now) * 1000;
  if (remaining > JWT_REFRESH_WINDOW) {
    res.json({ success: true, data: { message: 'Token still valid, no refresh needed' } });
    return;
  }

  const token = signToken(user.id, user.email, user.tier, user.role);

  // Set HttpOnly cookie with new token
  res.cookie('bm_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'none',
    maxAge: 24 * 60 * 60 * 1000, // 24h
    path: '/',
  });

  res.json({ success: true, data: { token } });
});

// ─── POST /forgot-password ───────────────────────────────────────────────────
// Initiate password reset — sends email with secure reset link.
// Always returns success to prevent email enumeration.

router.post('/forgot-password', passwordResetLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Please provide a valid email address',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { email } = parsed.data;
    const user = getUserByEmail(email);

    if (user) {
      // Generate reset token and send email
      const rawToken = createPasswordResetToken(user.id, user.email);
      const sent = await sendPasswordResetEmail(user.email, rawToken, user.name);

      if (!sent) {
        logger.error('Failed to send password reset email', { userId: user.id, email });
      } else {
        logger.info('Password reset requested', { userId: user.id, email });
      }
    } else {
      // Timing-safe: still spend time even if user not found
      await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200));
      logger.info('Password reset attempted for unknown email', { email });
    }

    // Always return success to prevent email enumeration
    res.json({
      success: true,
      data: {
        message: 'If an account with that email exists, a password reset link has been sent.',
      },
    });
  } catch (err: any) {
    logger.error('Forgot password error', { error: err.message });
    res.status(500).json({ success: false, error: 'Password reset request failed' });
  }
});

// ─── POST /reset-password ───────────────────────────────────────────────────
// Complete password reset — validates token and sets new password.

router.post('/reset-password', passwordResetLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { token, newPassword } = parsed.data;

    // Look up the token
    const resetRecord = getValidPasswordResetToken(token);
    if (!resetRecord) {
      res.status(400).json({
        success: false,
        error: 'Invalid or expired reset link. Please request a new one.',
      });
      return;
    }

    // Verify user still exists and is active
    const user = getUserById(resetRecord.userId);
    if (!user) {
      res.status(400).json({
        success: false,
        error: 'Account not found',
      });
      return;
    }

    // Hash new password and update
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    updateUserPassword(user.id, passwordHash);

    // Mark token as used (one-time)
    markPasswordResetTokenUsed(resetRecord.id);

    logger.info('Password reset completed', { userId: user.id, email: user.email });

    // Issue a fresh JWT so the user is immediately logged in
    const jwtToken = signToken(user.id, user.email, user.tier, user.role);

    res.json({
      success: true,
      data: {
        message: 'Password has been reset successfully',
        token: jwtToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          tier: user.tier,
          role: user.role,
        },
      },
    });
  } catch (err: any) {
    logger.error('Reset password error', { error: err.message });
    res.status(500).json({ success: false, error: 'Password reset failed' });
  }
});

// ─── POST /verify-email ─────────────────────────────────────────────────────
// Validate email verification token and mark user as verified.

router.post('/verify-email', async (req: Request, res: Response) => {
  try {
    const { token } = req.body;
    if (!token || typeof token !== 'string') {
      res.status(400).json({ success: false, error: 'Verification token is required' });
      return;
    }

    const record = getValidEmailVerificationToken(token);
    if (!record) {
      res.status(400).json({
        success: false,
        error: 'Invalid or expired verification link. Please request a new one.',
      });
      return;
    }

    const user = getUserById(record.userId);
    if (!user) {
      res.status(400).json({ success: false, error: 'Account not found' });
      return;
    }

    // Mark email as verified
    setEmailVerified(user.id, true);

    // Mark token as used (one-time)
    markPasswordResetTokenUsed(record.id);

    // Recompute trust score with email now verified
    const trustScore = computeAndStoreTrustScore(user.id);

    logger.info('Email verified', { userId: user.id, email: user.email, trustScore: trustScore.totalScore });

    // Issue a fresh JWT so the frontend can update immediately
    const jwtToken = signToken(user.id, user.email, user.tier, user.role);

    res.json({
      success: true,
      data: {
        message: 'Email verified successfully',
        token: jwtToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          tier: user.tier,
          role: user.role,
          emailVerified: true,
          trustScore: trustScore.totalScore,
          trustLevel: trustScore.trustLevel,
        },
      },
    });
  } catch (err: any) {
    logger.error('Email verification error', { error: err.message });
    res.status(500).json({ success: false, error: 'Email verification failed' });
  }
});

// ─── POST /resend-verification ──────────────────────────────────────────────
// Resend verification email — requires JWT auth.

router.post('/resend-verification', requireAuth, async (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user;
    const user = getUserById(userId);

    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    if (user.emailVerified) {
      res.json({ success: true, data: { message: 'Email is already verified' } });
      return;
    }

    // Generate new verification token (invalidates any previous ones)
    const verifyToken = createEmailVerificationToken(user.id, user.email);
    const sent = await sendVerificationEmail(user.email, verifyToken, user.name);

    if (!sent) {
      logger.error('Failed to resend verification email', { userId: user.id, email: user.email });
      res.status(500).json({ success: false, error: 'Failed to send verification email' });
      return;
    }

    logger.info('Verification email resent', { userId: user.id, email: user.email });

    res.json({
      success: true,
      data: { message: 'Verification email sent. Please check your inbox.' },
    });
  } catch (err: any) {
    logger.error('Resend verification error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to resend verification email' });
  }
});

// ─── POST /admin/create ─────────────────────────────────────────────────────
// Create admin account — requires API_MASTER_KEY in X-Master-Key header

router.post('/admin/create', async (req: Request, res: Response) => {
  try {
    const masterKey = process.env.API_MASTER_KEY;
    const providedKey = req.headers['x-master-key'] as string;

    if (!masterKey || !providedKey || providedKey !== masterKey) {
      res.status(403).json({ success: false, error: 'Invalid or missing master key' });
      return;
    }

    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { email, password, name } = parsed.data;
    const tier = (req.body.tier as string) || 'elite';

    // Check if email already exists
    const existing = getUserByEmail(email);
    if (existing) {
      // Promote existing user to admin
      updateUserRole(existing.id, 'admin');
      const token = signToken(existing.id, existing.email, tier, 'admin');
      logger.info('Existing user promoted to admin', { userId: existing.id, email });
      res.json({
        success: true,
        data: {
          token,
          user: { id: existing.id, email: existing.email, name: existing.name, tier, role: 'admin' },
          message: 'Existing user promoted to admin',
        },
      });
      return;
    }

    // Create new admin user
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const userId = uuid();
    createUser(userId, email, passwordHash, name, 'admin', tier as any);

    const token = signToken(userId, email, tier, 'admin');

    logger.info('Admin user created', { userId, email });

    res.status(201).json({
      success: true,
      data: {
        token,
        user: {
          id: userId,
          email: email.toLowerCase().trim(),
          name: name.trim(),
          tier,
          role: 'admin',
          createdAt: Date.now(),
        },
      },
    });
  } catch (err: any) {
    logger.error('Admin creation error', { error: err.message });
    res.status(500).json({ success: false, error: 'Admin creation failed' });
  }
});

// ─── DELETE /account ─────────────────────────────────────────────────────────
// Self-service account deletion. Requires password confirmation.
// Cascades through all user data (same logic as admin delete).

const deleteAccountSchema = z.object({
  password: z.string().min(1, 'Password is required for account deletion'),
});

router.delete('/account', requireAuth, async (req: Request, res: Response) => {
  try {
    const parsed = deleteAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Password confirmation required',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const userId = (req as any).user.sub;
    const user = getUserById(userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Prevent admin self-deletion via this route (use admin console)
    if (user.role === 'admin') {
      return res.status(403).json({ success: false, error: 'Admin accounts must be deleted through the admin console' });
    }

    // Verify password
    const dbUser = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as any;
    if (!dbUser) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const passwordValid = await bcrypt.compare(parsed.data.password, dbUser.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ success: false, error: 'Incorrect password' });
    }

    const db = getDb();
    db.pragma('foreign_keys = OFF');

    const deletions: Record<string, number> = {};

    try {
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
        ['email_verification_tokens', 'user_id'],
        ['agents', 'owner_user_id'],
        ['orion_conversations', 'user_id'],
        ['orion_messages', 'user_id'],
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
      db.pragma('foreign_keys = ON');
    }

    logger.info('User self-deleted account', {
      deletedUserId: userId,
      deletedEmail: user.email,
      deletions,
    });

    // Clear auth cookie
    res.clearCookie('bm_token', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'none',
      path: '/',
    });

    // Fire-and-forget deletion notification
    if (user.email) {
      sendAccountDeletionEmail(user.email, user.name ?? '').catch(
        (e: Error) => logger.warn('Account deletion email failed', { error: e.message }),
      );
    }

    res.json({
      success: true,
      message: 'Your account and all associated data have been deleted',
    });
  } catch (err: any) {
    logger.error('Self-delete account error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to delete account' });
  }
});

// ─── POST /logout ────────────────────────────────────────────────────────────
// Clear the HttpOnly authentication cookie.

router.post('/logout', (req: Request, res: Response) => {
  res.clearCookie('bm_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'none',
    path: '/',
  });

  res.json({
    success: true,
    data: { message: 'Logged out successfully' },
  });
});

export default router;
