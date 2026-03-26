/**
 * Borealis Protocol - Contact Form Route
 *
 * POST /v1/contact  — Contact form submission from borealisterminal.com
 */

import { Router, Request, Response } from 'express';
import { Resend } from 'resend';
import { logger } from '../middleware/logger';

const router = Router();

const FROM_ADDRESS = process.env.EMAIL_FROM ?? 'Borealis Terminal <support@borealismark.com>';
const NOTIFY_ADDRESS = 'support@borealismark.com';

// ─── Rate limiting (simple in-memory) ────────────────────────────────────────

const contactRateLimit = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = contactRateLimit.get(ip);
  if (!entry || entry.resetAt < now) {
    contactRateLimit.set(ip, { count: 1, resetAt: now + 60_000 * 15 }); // 15 min window
    return false;
  }
  entry.count++;
  return entry.count > 3; // max 3 submissions per 15 minutes
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of contactRateLimit) {
    if (entry.resetAt < now) contactRateLimit.delete(ip);
  }
}, 15 * 60 * 1000);

// ─── Input validation ─────────────────────────────────────────────────────────

const VALID_SUBJECTS = [
  'General Inquiry',
  'Merlin Support',
  'Partnership',
  'Bug Report',
];

function sanitize(str: string): string {
  return str.replace(/[<>"']/g, '').trim();
}

// ─── POST /v1/contact ─────────────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response) => {
  try {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';

    if (isRateLimited(ip)) {
      return res.status(429).json({
        success: false,
        error: 'Too many messages. Please wait before sending another.',
      });
    }

    const { name, email, subject, message } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ success: false, error: 'Name is required (min 2 characters).' });
    }
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ success: false, error: 'A valid email address is required.' });
    }
    if (!subject || !VALID_SUBJECTS.includes(subject)) {
      return res.status(400).json({ success: false, error: 'Please select a valid subject.' });
    }
    if (!message || typeof message !== 'string' || message.trim().length < 10) {
      return res.status(400).json({ success: false, error: 'Message is required (min 10 characters).' });
    }
    if (message.length > 5000) {
      return res.status(400).json({ success: false, error: 'Message is too long (max 5000 characters).' });
    }

    const safeName = sanitize(name);
    const safeEmail = email.trim().toLowerCase();
    const safeSubject = subject;
    const safeMessage = sanitize(message);

    const apiKey = process.env.RESEND_API_KEY;
    if (apiKey) {
      try {
        const resend = new Resend(apiKey);
        await resend.emails.send({
          from: FROM_ADDRESS,
          to: [NOTIFY_ADDRESS],
          replyTo: safeEmail,
          subject: `[Contact] ${safeSubject} - from ${safeName}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #d4a853; border-bottom: 1px solid #d4a853; padding-bottom: 12px;">
                New Contact Form Submission
              </h2>
              <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                <tr>
                  <td style="padding: 8px; font-weight: bold; color: #555; width: 100px;">Name</td>
                  <td style="padding: 8px;">${safeName}</td>
                </tr>
                <tr style="background: #f9f9f9;">
                  <td style="padding: 8px; font-weight: bold; color: #555;">Email</td>
                  <td style="padding: 8px;"><a href="mailto:${safeEmail}">${safeEmail}</a></td>
                </tr>
                <tr>
                  <td style="padding: 8px; font-weight: bold; color: #555;">Subject</td>
                  <td style="padding: 8px;">${safeSubject}</td>
                </tr>
              </table>
              <div style="background: #f5f5f5; border-left: 3px solid #d4a853; padding: 16px; border-radius: 4px;">
                <p style="margin: 0; white-space: pre-wrap;">${safeMessage}</p>
              </div>
              <p style="color: #999; font-size: 12px; margin-top: 20px;">
                Submitted from borealisterminal.com/contact
              </p>
            </div>
          `,
        });
      } catch (emailErr) {
        logger.warn('Contact form email delivery failed', { error: emailErr });
        // Still return success - we received the message, email is best-effort
      }
    } else {
      logger.warn('Contact form submission received but RESEND_API_KEY not set', {
        name: safeName, email: safeEmail, subject: safeSubject,
      });
    }

    logger.info('Contact form submission', { name: safeName, subject: safeSubject, ip });

    return res.status(200).json({
      success: true,
      message: 'Message received. We typically respond within 24 hours.',
    });
  } catch (err) {
    logger.error('Contact form error', { error: err });
    return res.status(500).json({
      success: false,
      error: 'Something went wrong. Please email us directly at support@borealismark.com',
    });
  }
});

export default router;
