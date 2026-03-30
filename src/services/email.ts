/**
 * BorealisMark — Email Service
 *
 * Sends transactional emails via Resend (https://resend.com).
 * Uses support@borealisprotocol.ai as the sender.
 *
 * Required env var: RESEND_API_KEY
 */

import { Resend } from 'resend';
import { logger } from '../middleware/logger';

// CRITICAL: Use verified custom domain for outbound email — NEVER *.cloudflare.dev or *.workers.dev
const FROM_ADDRESS = process.env.EMAIL_FROM ?? 'BorealisMark <support@borealisprotocol.ai>';
const VERIFY_FROM_ADDRESS = process.env.VERIFY_EMAIL_FROM ?? 'Borealis Terminal Verification <verify@borealisprotocol.ai>';

// Safety: validate FROM address at startup — block .dev domains
if (FROM_ADDRESS.includes('.workers.dev') || FROM_ADDRESS.includes('.pages.dev') || FROM_ADDRESS.includes('cloudflare.dev')) {
  logger.error('FATAL: EMAIL_FROM is set to a .dev domain — emails must use a verified branded domain');
  throw new Error('EMAIL_FROM must not use .workers.dev, .pages.dev, or cloudflare.dev domains');
}

let resend: Resend | null = null;

function getResend(): Resend {
  if (!resend) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      logger.warn('RESEND_API_KEY not set — emails will be logged but not sent');
    }
    resend = new Resend(apiKey ?? 're_dummy_key');
  }
  return resend;
}

/**
 * Send a password reset email with a secure link.
 */
export async function sendPasswordResetEmail(
  toEmail: string,
  resetToken: string,
  userName: string,
): Promise<boolean> {
  const frontendUrl = (process.env.FRONTEND_URL ?? 'https://borealismark.com').replace(/\/$/, '');
  const resetLink = `${frontendUrl}/dashboard.html?reset=${resetToken}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: #0C0D10; color: #E0E0E0; }
    .container { max-width: 560px; margin: 40px auto; padding: 0 20px; }
    .card { background: #16171C; border: 1px solid #2A2B33; border-radius: 12px; padding: 40px 32px; }
    .logo { color: #D4A853; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 24px; }
    h1 { font-size: 22px; font-weight: 600; color: #FFFFFF; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.6; color: #A0A0A0; margin: 0 0 16px 0; }
    .btn { display: inline-block; background: #D4A853; color: #0C0D10; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; margin: 8px 0 24px 0; }
    .btn:hover { background: #E0B85C; }
    .divider { border-top: 1px solid #2A2B33; margin: 24px 0; }
    .small { font-size: 13px; color: #666; }
    .link { color: #D4A853; word-break: break-all; }
    .footer { text-align: center; padding: 24px 0; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">BorealisMark</div>
      <h1>Reset your password</h1>
      <p>Hi ${userName || 'there'},</p>
      <p>We received a request to reset the password for your BorealisMark account. Click the button below to choose a new password:</p>
      <a href="${resetLink}" class="btn">Reset Password</a>
      <p class="small">This link will expire in <strong style="color:#fff">1 hour</strong>. If you didn't request a password reset, you can safely ignore this email.</p>
      <div class="divider"></div>
      <p class="small">If the button doesn't work, copy and paste this link into your browser:</p>
      <p class="small link">${resetLink}</p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} BorealisMark Protocol - AI Trust Certification
    </div>
  </div>
</body>
</html>`;

  const text = `Reset your BorealisMark password

Hi ${userName || 'there'},

We received a request to reset the password for your BorealisMark account. Visit the link below to choose a new password:

${resetLink}

This link will expire in 1 hour. If you didn't request a password reset, you can safely ignore this email.

- BorealisMark Protocol`;

  // If no API key, log the email instead of sending
  if (!process.env.RESEND_API_KEY) {
    logger.info('Password reset email (NOT SENT — no RESEND_API_KEY)', {
      to: toEmail,
      resetLink,
    });
    return true; // Return true so the flow continues in development
  }

  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [toEmail],
      subject: 'Reset your BorealisMark password',
      html,
      text,
    });

    if (result.error) {
      logger.error('Email send failed', { error: result.error, to: toEmail });
      return false;
    }

    logger.info('Password reset email sent', { to: toEmail, id: result.data?.id });
    return true;
  } catch (err: any) {
    logger.error('Email service error', { error: err.message, to: toEmail });
    return false;
  }
}

/**
 * Send a verification email after registration.
 */
export async function sendVerificationEmail(
  toEmail: string,
  verificationToken: string,
  userName: string,
): Promise<boolean> {
  const frontendUrl = (process.env.FRONTEND_URL ?? 'https://borealismark.com').replace(/\/$/, '');
  const verifyLink = `${frontendUrl}/dashboard.html?verify=${verificationToken}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: #0C0D10; color: #E0E0E0; }
    .container { max-width: 560px; margin: 40px auto; padding: 0 20px; }
    .card { background: #16171C; border: 1px solid #2A2B33; border-radius: 12px; padding: 40px 32px; }
    .logo { color: #D4A853; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 24px; }
    h1 { font-size: 22px; font-weight: 600; color: #FFFFFF; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.6; color: #A0A0A0; margin: 0 0 16px 0; }
    .btn { display: inline-block; background: #D4A853; color: #0C0D10; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; margin: 8px 0 24px 0; }
    .btn:hover { background: #E0B85C; }
    .divider { border-top: 1px solid #2A2B33; margin: 24px 0; }
    .small { font-size: 13px; color: #666; }
    .link { color: #D4A853; word-break: break-all; }
    .footer { text-align: center; padding: 24px 0; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">BorealisMark</div>
      <h1>Verify your email address</h1>
      <p>Hi ${userName || 'there'},</p>
      <p>Welcome to the BorealisMark Protocol ecosystem. To complete your registration and unlock full access to the trust-gated marketplace, please verify your email address:</p>
      <a href="${verifyLink}" class="btn">Verify Email</a>
      <p class="small">This link will expire in <strong style="color:#fff">24 hours</strong>. If you didn't create this account, you can safely ignore this email.</p>
      <div class="divider"></div>
      <p class="small">If the button doesn't work, copy and paste this link into your browser:</p>
      <p class="small link">${verifyLink}</p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} BorealisMark Protocol - AI Trust Certification
    </div>
  </div>
</body>
</html>`;

  const text = `Verify your BorealisMark email address

Hi ${userName || 'there'},

Welcome to the BorealisMark Protocol ecosystem. To complete your registration and unlock full access, please visit this link:

${verifyLink}

This link will expire in 24 hours. If you didn't create this account, you can safely ignore this email.

- BorealisMark Protocol`;

  // If no API key, log the email instead of sending
  if (!process.env.RESEND_API_KEY) {
    logger.info('Verification email (NOT SENT — no RESEND_API_KEY)', {
      to: toEmail,
      verifyLink,
    });
    return true;
  }

  try {
    const result = await getResend().emails.send({
      from: VERIFY_FROM_ADDRESS,
      to: [toEmail],
      subject: 'Verify your BorealisMark email address',
      html,
      text,
    });

    if (result.error) {
      logger.error('Verification email send failed', { error: result.error, to: toEmail });
      return false;
    }

    logger.info('Verification email sent', { to: toEmail, id: result.data?.id });
    return true;
  } catch (err: any) {
    logger.error('Verification email error', { error: err.message, to: toEmail });
    return false;
  }
}

// ─── Subscription Expiry Reminder ──────────────────────────────────────────────

/**
 * Send a subscription expiry reminder email.
 * Called at 30 days, 7 days, and 1 day before expiry.
 */
export async function sendSubscriptionExpiryReminder(
  toEmail: string,
  userName: string,
  daysRemaining: number,
  planName: string,
  botCount: number,
  botLimit: number,
): Promise<boolean> {
  const frontendUrl = process.env.FRONTEND_URL ?? 'https://borealismark.com';
  const renewLink = `${frontendUrl}/dashboard.html?tab=billing`;

  const urgencyColor = daysRemaining <= 1 ? '#FF4444' : daysRemaining <= 7 ? '#FFA500' : '#D4A853';
  const urgencyText = daysRemaining <= 1
    ? 'Your subscription expires tomorrow!'
    : daysRemaining <= 7
    ? `Your subscription expires in ${daysRemaining} days`
    : `Your subscription expires in ${daysRemaining} days`;

  const botWarning = botCount > botLimit
    ? `<div style="background:rgba(255,68,68,0.1);border:1px solid rgba(255,68,68,0.3);border-radius:8px;padding:16px;margin:16px 0">
        <p style="color:#FF4444;font-weight:600;margin:0 0 8px 0">Bot Deactivation Warning</p>
        <p style="color:#A0A0A0;margin:0;font-size:14px">You currently have <strong style="color:#fff">${botCount} active bots</strong>. The Standard plan allows <strong style="color:#fff">${botLimit} bots</strong>. If you don't renew, your <strong style="color:#FF4444">${botCount - botLimit} least active bots will be automatically suspended</strong>. Their data and history will be preserved - you can reactivate them by upgrading again.</p>
      </div>`
    : '';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: #0C0D10; color: #E0E0E0; }
    .container { max-width: 560px; margin: 40px auto; padding: 0 20px; }
    .card { background: #16171C; border: 1px solid #2A2B33; border-radius: 12px; padding: 40px 32px; }
    .logo { color: #D4A853; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 24px; }
    h1 { font-size: 22px; font-weight: 600; color: #FFFFFF; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.6; color: #A0A0A0; margin: 0 0 16px 0; }
    .btn { display: inline-block; background: #D4A853; color: #0C0D10; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; margin: 8px 0 24px 0; }
    .divider { border-top: 1px solid #2A2B33; margin: 24px 0; }
    .small { font-size: 13px; color: #666; }
    .footer { text-align: center; padding: 24px 0; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">BorealisMark</div>
      <h1 style="color:${urgencyColor}">${urgencyText}</h1>
      <p>Hi ${userName || 'there'},</p>
      <p>Your <strong style="color:#fff">${planName}</strong> subscription is expiring soon. Without renewal, your account will be downgraded to the Standard (free) tier.</p>
      ${botWarning}
      <p>Renew now to keep your bots running, your AP multiplier active, and your position on the leaderboard:</p>
      <a href="${renewLink}" class="btn">Renew Subscription</a>
      <div class="divider"></div>
      <p class="small">Pay with USDC on Hedera and save 5% on your renewal. Your BM Scores, badges, and audit history are always preserved regardless of plan.</p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} BorealisMark Protocol - AI Trust Certification
    </div>
  </div>
</body>
</html>`;

  const text = `${urgencyText}\n\nHi ${userName || 'there'},\n\nYour ${planName} subscription is expiring soon. Without renewal, your account will be downgraded to Standard.${botCount > botLimit ? `\n\nWARNING: You have ${botCount} active bots but Standard only allows ${botLimit}. Your ${botCount - botLimit} least active bots will be suspended.` : ''}\n\nRenew here: ${renewLink}\n\n- BorealisMark Protocol`;

  if (!process.env.RESEND_API_KEY) {
    logger.info('Subscription expiry reminder (NOT SENT — no RESEND_API_KEY)', {
      to: toEmail, daysRemaining, planName, botCount, botLimit,
    });
    return true;
  }

  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [toEmail],
      subject: `${urgencyText} - BorealisMark ${planName}`,
      html,
      text,
    });

    if (result.error) {
      logger.error('Expiry reminder send failed', { error: result.error, to: toEmail });
      return false;
    }

    logger.info('Subscription expiry reminder sent', { to: toEmail, daysRemaining, planName });
    return true;
  } catch (err: any) {
    logger.error('Expiry reminder error', { error: err.message, to: toEmail });
    return false;
  }
}

/**
 * Send a downgrade notification email after bots have been suspended.
 */
export async function sendDowngradeNotificationEmail(
  toEmail: string,
  userName: string,
  previousPlan: string,
  suspendedBots: Array<{ name: string; id: string }>,
): Promise<boolean> {
  const frontendUrl = process.env.FRONTEND_URL ?? 'https://borealismark.com';
  const upgradeLink = `${frontendUrl}/dashboard.html?tab=billing`;

  const botListHtml = suspendedBots.length > 0
    ? `<div style="background:rgba(255,68,68,0.08);border:1px solid rgba(255,68,68,0.2);border-radius:8px;padding:16px;margin:16px 0">
        <p style="color:#FF4444;font-weight:600;margin:0 0 8px 0">Suspended Bots (${suspendedBots.length})</p>
        ${suspendedBots.map(b => `<p style="color:#A0A0A0;margin:4px 0;font-size:14px">&bull; ${b.name} <span style="color:#666;font-size:12px">(${b.id})</span></p>`).join('')}
        <p style="color:#888;margin:8px 0 0 0;font-size:13px">Their BM Scores, AP, and history are preserved. Upgrade to reactivate.</p>
      </div>`
    : '';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: #0C0D10; color: #E0E0E0; }
    .container { max-width: 560px; margin: 40px auto; padding: 0 20px; }
    .card { background: #16171C; border: 1px solid #2A2B33; border-radius: 12px; padding: 40px 32px; }
    .logo { color: #D4A853; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 24px; }
    h1 { font-size: 22px; font-weight: 600; color: #FFFFFF; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.6; color: #A0A0A0; margin: 0 0 16px 0; }
    .btn { display: inline-block; background: #D4A853; color: #0C0D10; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; margin: 8px 0 24px 0; }
    .divider { border-top: 1px solid #2A2B33; margin: 24px 0; }
    .small { font-size: 13px; color: #666; }
    .footer { text-align: center; padding: 24px 0; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">BorealisMark</div>
      <h1>Your subscription has expired</h1>
      <p>Hi ${userName || 'there'},</p>
      <p>Your <strong style="color:#fff">${previousPlan}</strong> subscription has expired and your account has been downgraded to the <strong style="color:#fff">Standard (free)</strong> tier.</p>
      ${botListHtml}
      <p>You can upgrade at any time to reactivate your bots and restore your full capabilities:</p>
      <a href="${upgradeLink}" class="btn">Upgrade Now</a>
      <div class="divider"></div>
      <p class="small">Your BM Scores, certifications, AP history, and badges are always preserved regardless of plan changes.</p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} BorealisMark Protocol - AI Trust Certification
    </div>
  </div>
</body>
</html>`;

  const text = `Your ${previousPlan} subscription has expired.\n\nYour account has been downgraded to Standard (free).${suspendedBots.length > 0 ? `\n\nSuspended bots: ${suspendedBots.map(b => b.name).join(', ')}` : ''}\n\nUpgrade: ${upgradeLink}\n\n- BorealisMark Protocol`;

  if (!process.env.RESEND_API_KEY) {
    logger.info('Downgrade notification (NOT SENT — no RESEND_API_KEY)', {
      to: toEmail, previousPlan, suspendedCount: suspendedBots.length,
    });
    return true;
  }

  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [toEmail],
      subject: `Subscription Expired - ${suspendedBots.length > 0 ? `${suspendedBots.length} bots suspended` : 'Account downgraded'}`,
      html,
      text,
    });

    if (result.error) {
      logger.error('Downgrade notification send failed', { error: result.error, to: toEmail });
      return false;
    }

    logger.info('Downgrade notification sent', { to: toEmail, suspendedCount: suspendedBots.length });
    return true;
  } catch (err: any) {
    logger.error('Downgrade notification error', { error: err.message, to: toEmail });
    return false;
  }
}

// ─── Order Email Templates ─────────────────────────────────────────────────────

interface OrderEmailData {
  orderId: string;
  listingTitle: string;
  totalCad: number;
  totalUsdc: number;
  buyerName: string;
  sellerName: string;
}

function orderEmailBase(title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: #0C0D10; color: #E0E0E0; }
    .container { max-width: 560px; margin: 40px auto; padding: 0 20px; }
    .card { background: #16171C; border: 1px solid #2A2B33; border-radius: 12px; padding: 40px 32px; }
    .logo { color: #D4A853; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 24px; }
    h1 { font-size: 22px; font-weight: 600; color: #FFFFFF; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.6; color: #A0A0A0; margin: 0 0 16px 0; }
    .highlight { color: #D4A853; font-weight: 600; }
    .btn { display: inline-block; background: #D4A853; color: #0C0D10; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; margin: 8px 0 24px 0; }
    .divider { border-top: 1px solid #2A2B33; margin: 24px 0; }
    .detail { font-size: 14px; color: #888; margin: 4px 0; }
    .detail strong { color: #CCC; }
    .footer { text-align: center; padding: 24px 0; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">BorealisMark Terminal</div>
      <h1>${title}</h1>
      ${body}
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} BorealisMark Protocol - The Trust-Gated Exchange
    </div>
  </div>
</body>
</html>`;
}

async function sendOrderEmail(to: string, subject: string, html: string, text: string): Promise<boolean> {
  if (!process.env.RESEND_API_KEY) {
    logger.info(`Order email (NOT SENT — no RESEND_API_KEY): ${subject}`, { to });
    return true;
  }
  try {
    const result = await getResend().emails.send({ from: FROM_ADDRESS, to: [to], subject, html, text });
    if (result.error) {
      logger.error('Order email send failed', { error: result.error, to });
      return false;
    }
    logger.info('Order email sent', { to, subject });
    return true;
  } catch (err: any) {
    logger.error('Order email error', { error: err.message, to });
    return false;
  }
}

/**
 * 1. Order Confirmation — sent to buyer after checkout
 */
export async function sendOrderConfirmationEmail(
  buyerEmail: string,
  data: OrderEmailData & { memo: string; treasuryAccountId: string },
): Promise<boolean> {
  const html = orderEmailBase('Order Confirmed', `
    <p>Hi ${data.buyerName},</p>
    <p>Your order has been placed on the Borealis Terminal marketplace.</p>
    <div class="divider"></div>
    <p class="detail"><strong>Order ID:</strong> ${data.orderId}</p>
    <p class="detail"><strong>Item:</strong> ${data.listingTitle}</p>
    <p class="detail"><strong>Total:</strong> <span class="highlight">$${data.totalCad.toFixed(2)} CAD</span> (${data.totalUsdc.toFixed(6)} USDC)</p>
    <p class="detail"><strong>Seller:</strong> ${data.sellerName}</p>
    <div class="divider"></div>
    <p><strong style="color:#fff">Payment Instructions:</strong></p>
    <p>Send exactly <span class="highlight">${data.totalUsdc.toFixed(6)} USDC</span> to:</p>
    <p class="detail"><strong>Treasury:</strong> ${data.treasuryAccountId}</p>
    <p class="detail"><strong>Memo:</strong> ${data.memo}</p>
    <p>After sending, click "Verify Payment" in your order page. You have 30 minutes to complete the deposit.</p>
  `);
  const text = `Order Confirmed - ${data.listingTitle}\nOrder ID: ${data.orderId}\nTotal: $${data.totalCad.toFixed(2)} CAD (${data.totalUsdc.toFixed(6)} USDC)\nSend ${data.totalUsdc.toFixed(6)} USDC to ${data.treasuryAccountId} with memo: ${data.memo}`;
  return sendOrderEmail(buyerEmail, `Order Confirmed - ${data.listingTitle}`, html, text);
}

/**
 * 2. Seller Deposit Request — sent to seller when buyer deposits
 */
export async function sendSellerDepositRequestEmail(
  sellerEmail: string,
  data: OrderEmailData & { bondUsdc: number; memo: string; treasuryAccountId: string },
): Promise<boolean> {
  const html = orderEmailBase('Buyer Payment Received - Trust Bond Required', `
    <p>Hi ${data.sellerName},</p>
    <p>A buyer has deposited payment for your listing. To proceed, please deposit your 25% trust bond.</p>
    <div class="divider"></div>
    <p class="detail"><strong>Order ID:</strong> ${data.orderId}</p>
    <p class="detail"><strong>Item:</strong> ${data.listingTitle}</p>
    <p class="detail"><strong>Sale Amount:</strong> <span class="highlight">$${data.totalCad.toFixed(2)} CAD</span></p>
    <p class="detail"><strong>Trust Bond:</strong> <span class="highlight">${data.bondUsdc.toFixed(6)} USDC</span> (25%)</p>
    <div class="divider"></div>
    <p>Send exactly <span class="highlight">${data.bondUsdc.toFixed(6)} USDC</span> to:</p>
    <p class="detail"><strong>Treasury:</strong> ${data.treasuryAccountId}</p>
    <p class="detail"><strong>Memo:</strong> ${data.memo}</p>
    <p>This bond will be returned to you after the buyer confirms delivery.</p>
  `);
  const text = `Trust Bond Required - Order ${data.orderId}\nItem: ${data.listingTitle}\nBond: ${data.bondUsdc.toFixed(6)} USDC to ${data.treasuryAccountId} with memo: ${data.memo}`;
  return sendOrderEmail(sellerEmail, `Trust Bond Required - ${data.listingTitle}`, html, text);
}

/**
 * 3. Escrow Active - sent to both parties when both deposits confirmed
 */
export async function sendEscrowActiveEmail(
  email: string,
  data: OrderEmailData & { isSeller: boolean },
): Promise<boolean> {
  const name = data.isSeller ? data.sellerName : data.buyerName;
  const action = data.isSeller
    ? 'Please ship the item and add tracking information in your seller dashboard.'
    : 'The seller has been notified to ship your item. You will receive tracking information soon.';
  const html = orderEmailBase('Escrow Active - Both Deposits Confirmed', `
    <p>Hi ${name},</p>
    <p>Both deposits have been confirmed. The escrow is now active for this transaction.</p>
    <div class="divider"></div>
    <p class="detail"><strong>Order ID:</strong> ${data.orderId}</p>
    <p class="detail"><strong>Item:</strong> ${data.listingTitle}</p>
    <p class="detail"><strong>Total:</strong> <span class="highlight">$${data.totalCad.toFixed(2)} CAD</span></p>
    <div class="divider"></div>
    <p>${action}</p>
  `);
  const text = `Escrow Active - Order ${data.orderId}\nItem: ${data.listingTitle}\n${action}`;
  return sendOrderEmail(email, `Escrow Active - ${data.listingTitle}`, html, text);
}

/**
 * 4. Shipped - sent to buyer with tracking info
 */
export async function sendShippedEmail(
  buyerEmail: string,
  data: OrderEmailData & { carrier: string; trackingNumber: string },
): Promise<boolean> {
  const html = orderEmailBase('Your Order Has Shipped!', `
    <p>Hi ${data.buyerName},</p>
    <p>Your item has been shipped by ${data.sellerName}.</p>
    <div class="divider"></div>
    <p class="detail"><strong>Order ID:</strong> ${data.orderId}</p>
    <p class="detail"><strong>Item:</strong> ${data.listingTitle}</p>
    <p class="detail"><strong>Carrier:</strong> ${data.carrier}</p>
    <p class="detail"><strong>Tracking:</strong> ${data.trackingNumber}</p>
    <div class="divider"></div>
    <p>Once you receive the item, please confirm delivery in your dashboard to release the escrow funds.</p>
  `);
  const text = `Shipped - Order ${data.orderId}\nItem: ${data.listingTitle}\nCarrier: ${data.carrier}\nTracking: ${data.trackingNumber}`;
  return sendOrderEmail(buyerEmail, `Shipped - ${data.listingTitle}`, html, text);
}

/**
 * 5. Delivery Confirmed - sent to seller
 */
export async function sendDeliveryConfirmedEmail(
  sellerEmail: string,
  data: OrderEmailData,
): Promise<boolean> {
  const html = orderEmailBase('Delivery Confirmed - Settlement Processing', `
    <p>Hi ${data.sellerName},</p>
    <p>The buyer has confirmed delivery of your item. Settlement is being processed.</p>
    <div class="divider"></div>
    <p class="detail"><strong>Order ID:</strong> ${data.orderId}</p>
    <p class="detail"><strong>Item:</strong> ${data.listingTitle}</p>
    <p class="detail"><strong>Sale Amount:</strong> <span class="highlight">$${data.totalCad.toFixed(2)} CAD</span></p>
    <div class="divider"></div>
    <p>Your payment and trust bond return will be processed shortly.</p>
  `);
  const text = `Delivery Confirmed - Order ${data.orderId}\nSettlement processing for ${data.listingTitle}`;
  return sendOrderEmail(sellerEmail, `Delivery Confirmed - ${data.listingTitle}`, html, text);
}

/**
 * 6. Settlement Complete — sent to both parties
 */
export async function sendSettlementCompleteEmail(
  email: string,
  data: OrderEmailData & {
    isSeller: boolean;
    sellerPayout?: number;
    sellerBondReturned?: number;
    platformFee?: number;
    hederaTransactionId?: string;
  },
): Promise<boolean> {
  const name = data.isSeller ? data.sellerName : data.buyerName;
  const details = data.isSeller
    ? `<p class="detail"><strong>Payout:</strong> <span class="highlight">${data.sellerPayout?.toFixed(6)} USDC</span> (minus 2.5% platform fee)</p>
       <p class="detail"><strong>Bond Returned:</strong> ${data.sellerBondReturned?.toFixed(6)} USDC</p>
       <p class="detail"><strong>Platform Fee:</strong> ${data.platformFee?.toFixed(6)} USDC</p>`
    : `<p class="detail"><strong>Amount Paid:</strong> ${data.totalUsdc.toFixed(6)} USDC</p>`;
  const proof = data.hederaTransactionId
    ? `<p class="detail"><strong>Hedera Proof:</strong> ${data.hederaTransactionId}</p>`
    : '';
  const html = orderEmailBase('Transaction Complete', `
    <p>Hi ${name},</p>
    <p>The escrow has been settled and the transaction is complete.</p>
    <div class="divider"></div>
    <p class="detail"><strong>Order ID:</strong> ${data.orderId}</p>
    <p class="detail"><strong>Item:</strong> ${data.listingTitle}</p>
    ${details}
    ${proof}
    <div class="divider"></div>
    <p>Thank you for using the Borealis Terminal marketplace. All transactions are anchored on Hedera for immutable proof.</p>
  `);
  const text = `Transaction Complete - Order ${data.orderId}\nItem: ${data.listingTitle}`;
  return sendOrderEmail(email, `Transaction Complete - ${data.listingTitle}`, html, text);
}

// ─── Admin Notification Emails ──────────────────────────────────────────────

const ADMIN_EMAIL = process.env.ADMIN_NOTIFICATION_EMAIL ?? 'esimon.ng@gmail.com';

/**
 * Notify the platform admin when a new user registers.
 */
export async function sendAdminNewUserNotification(
  userEmail: string,
  userName: string,
  userId: string,
  tier: string = 'standard',
): Promise<boolean> {
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' });
  const dashboardUrl = 'https://borealismark-api.onrender.com/v1/admin/users';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0C0D10; color: #E0E0E0; }
    .container { max-width: 560px; margin: 40px auto; padding: 0 20px; }
    .card { background: #16171C; border: 1px solid #2A2B33; border-radius: 12px; padding: 32px; }
    .logo { color: #D4A853; font-size: 20px; font-weight: 700; margin-bottom: 20px; }
    h1 { font-size: 20px; font-weight: 600; color: #4CAF50; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.6; color: #A0A0A0; margin: 0 0 12px 0; }
    .detail { font-size: 14px; color: #888; margin: 6px 0; }
    .detail strong { color: #CCC; }
    .highlight { color: #D4A853; font-weight: 600; }
    .divider { border-top: 1px solid #2A2B33; margin: 20px 0; }
    .footer { text-align: center; padding: 20px 0; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">BorealisMark Admin</div>
      <h1>New User Registered</h1>
      <p>A new user has just signed up on the BorealisMark platform.</p>
      <div class="divider"></div>
      <p class="detail"><strong>Name:</strong> <span class="highlight">${userName}</span></p>
      <p class="detail"><strong>Email:</strong> ${userEmail}</p>
      <p class="detail"><strong>Tier:</strong> ${tier}</p>
      <p class="detail"><strong>User ID:</strong> <span style="font-family:monospace;font-size:12px">${userId}</span></p>
      <p class="detail"><strong>Registered:</strong> ${timestamp}</p>
      <div class="divider"></div>
      <p class="detail" style="color:#666">View all users in the admin dashboard.</p>
    </div>
    <div class="footer">&copy; ${new Date().getFullYear()} The Borealis Protocol - Admin Notification</div>
  </div>
</body>
</html>`;

  const text = `New User Registered\n\nName: ${userName}\nEmail: ${userEmail}\nTier: ${tier}\nUser ID: ${userId}\nRegistered: ${timestamp}\n\nDashboard: ${dashboardUrl}`;

  if (!process.env.RESEND_API_KEY) {
    logger.info('Admin new user notification (NOT SENT — no RESEND_API_KEY)', {
      to: ADMIN_EMAIL, userEmail, userName, userId,
    });
    return true;
  }

  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [ADMIN_EMAIL],
      subject: `New User: ${userName} (${userEmail})`,
      html,
      text,
    });
    if (result.error) {
      logger.error('Admin notification send failed', { error: result.error });
      return false;
    }
    logger.info('Admin new user notification sent', { to: ADMIN_EMAIL, userEmail });
    return true;
  } catch (err: any) {
    logger.error('Admin notification error', { error: err.message });
    return false;
  }
}

/**
 * Notify the platform admin when a user upgrades their subscription plan.
 */
export async function sendAdminSubscriptionNotification(
  userEmail: string,
  userName: string,
  userId: string,
  newTier: string,
  previousTier: string,
  method: string,
  planId?: string,
): Promise<boolean> {
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' });
  const tierColors: Record<string, string> = {
    standard: '#888',
    starter: '#4CAF50',
    pro: '#2196F3',
    business: '#9C27B0',
    elite: '#D4A853',
    enterprise: '#FF5722',
  };
  const color = tierColors[newTier.toLowerCase()] ?? '#D4A853';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0C0D10; color: #E0E0E0; }
    .container { max-width: 560px; margin: 40px auto; padding: 0 20px; }
    .card { background: #16171C; border: 1px solid #2A2B33; border-radius: 12px; padding: 32px; }
    .logo { color: #D4A853; font-size: 20px; font-weight: 700; margin-bottom: 20px; }
    h1 { font-size: 20px; font-weight: 600; color: ${color}; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.6; color: #A0A0A0; margin: 0 0 12px 0; }
    .detail { font-size: 14px; color: #888; margin: 6px 0; }
    .detail strong { color: #CCC; }
    .highlight { color: #D4A853; font-weight: 600; }
    .tier-badge { display: inline-block; padding: 4px 12px; border-radius: 6px; font-weight: 600; font-size: 14px; }
    .divider { border-top: 1px solid #2A2B33; margin: 20px 0; }
    .footer { text-align: center; padding: 20px 0; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">BorealisMark Admin</div>
      <h1>Subscription ${previousTier === 'standard' ? 'Upgrade' : 'Change'}</h1>
      <p>A user has ${previousTier === 'standard' ? 'upgraded their subscription' : 'changed their plan'}.</p>
      <div class="divider"></div>
      <p class="detail"><strong>User:</strong> <span class="highlight">${userName}</span> (${userEmail})</p>
      <p class="detail"><strong>Plan Change:</strong> ${previousTier} &rarr; <span class="tier-badge" style="background:${color}22;color:${color};border:1px solid ${color}44">${newTier.toUpperCase()}</span></p>
      <p class="detail"><strong>Payment Method:</strong> ${method === 'stripe' ? 'Stripe (Card)' : 'USDC (Hedera)'}</p>
      ${planId ? `<p class="detail"><strong>Plan ID:</strong> <span style="font-family:monospace;font-size:12px">${planId}</span></p>` : ''}
      <p class="detail"><strong>User ID:</strong> <span style="font-family:monospace;font-size:12px">${userId}</span></p>
      <p class="detail"><strong>Time:</strong> ${timestamp}</p>
    </div>
    <div class="footer">&copy; ${new Date().getFullYear()} The Borealis Protocol - Admin Notification</div>
  </div>
</body>
</html>`;

  const text = `Subscription ${previousTier === 'standard' ? 'Upgrade' : 'Change'}\n\nUser: ${userName} (${userEmail})\nPlan: ${previousTier} → ${newTier}\nMethod: ${method}\nTime: ${timestamp}`;

  if (!process.env.RESEND_API_KEY) {
    logger.info('Admin subscription notification (NOT SENT — no RESEND_API_KEY)', {
      to: ADMIN_EMAIL, userEmail, newTier, previousTier, method,
    });
    return true;
  }

  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [ADMIN_EMAIL],
      subject: `${previousTier === 'standard' ? 'New' : ''} ${newTier.toUpperCase()} Sub: ${userName} (${method})`,
      html,
      text,
    });
    if (result.error) {
      logger.error('Admin subscription notification failed', { error: result.error });
      return false;
    }
    logger.info('Admin subscription notification sent', { to: ADMIN_EMAIL, userEmail, newTier });
    return true;
  } catch (err: any) {
    logger.error('Admin subscription notification error', { error: err.message });
    return false;
  }
}

/**
 * Notify the platform admin when a user submits a government ID for verification.
 */
export async function sendAdminVerificationNotification(
  userEmail: string,
  userName: string,
  userId: string,
  documentType: string,
  verificationId: string,
): Promise<boolean> {
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' });

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0C0D10; color: #E0E0E0; }
    .container { max-width: 560px; margin: 40px auto; padding: 0 20px; }
    .card { background: #16171C; border: 1px solid #2A2B33; border-radius: 12px; padding: 32px; }
    .logo { color: #D4A853; font-size: 20px; font-weight: 700; margin-bottom: 20px; }
    h1 { font-size: 20px; font-weight: 600; color: #FFA500; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.6; color: #A0A0A0; margin: 0 0 12px 0; }
    .detail { font-size: 14px; color: #888; margin: 6px 0; }
    .detail strong { color: #CCC; }
    .highlight { color: #D4A853; font-weight: 600; }
    .divider { border-top: 1px solid #2A2B33; margin: 20px 0; }
    .footer { text-align: center; padding: 20px 0; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">BorealisMark Admin</div>
      <h1>New Verification Request</h1>
      <p>A user has submitted a government ID for verification. Action required.</p>
      <div class="divider"></div>
      <p class="detail"><strong>User:</strong> <span class="highlight">${userName}</span></p>
      <p class="detail"><strong>Email:</strong> ${userEmail}</p>
      <p class="detail"><strong>Document Type:</strong> ${documentType}</p>
      <p class="detail"><strong>Verification ID:</strong> <span style="font-family:monospace;font-size:12px">${verificationId}</span></p>
      <p class="detail"><strong>User ID:</strong> <span style="font-family:monospace;font-size:12px">${userId}</span></p>
      <p class="detail"><strong>Submitted:</strong> ${timestamp}</p>
      <div class="divider"></div>
      <p class="detail" style="color:#666">Review and approve or reject in the admin dashboard.</p>
    </div>
    <div class="footer">&copy; ${new Date().getFullYear()} The Borealis Protocol - Admin Notification</div>
  </div>
</body>
</html>`;

  const text = `New Verification Request\n\nUser: ${userName}\nEmail: ${userEmail}\nDocument Type: ${documentType}\nVerification ID: ${verificationId}\nUser ID: ${userId}\nSubmitted: ${timestamp}\n\nAction required: Review and approve or reject in the admin dashboard.`;

  if (!process.env.RESEND_API_KEY) {
    logger.info('Admin verification notification (NOT SENT — no RESEND_API_KEY)', {
      to: ADMIN_EMAIL, userEmail, userName, userId, documentType, verificationId,
    });
    return true;
  }

  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [ADMIN_EMAIL],
      subject: `Verification Request: ${userName} (${documentType})`,
      html,
      text,
    });
    if (result.error) {
      logger.error('Admin verification notification send failed', { error: result.error });
      return false;
    }
    logger.info('Admin verification notification sent', { to: ADMIN_EMAIL, userEmail, verificationId });
    return true;
  } catch (err: any) {
    logger.error('Admin verification notification error', { error: err.message });
    return false;
  }
}

/**
 * Notify the user when their verification is approved or rejected.
 */
export async function sendVerificationResultEmail(
  toEmail: string,
  userName: string,
  approved: boolean,
  verificationType: string,
  reason?: string,
  trustPointsEarned?: number,
): Promise<boolean> {
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' });
  const headingColor = approved ? '#4CAF50' : '#FFA500';
  const headingText = approved ? 'Verification Approved' : 'Verification Update';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: #0C0D10; color: #E0E0E0; }
    .container { max-width: 560px; margin: 40px auto; padding: 0 20px; }
    .card { background: #16171C; border: 1px solid #2A2B33; border-radius: 12px; padding: 40px 32px; }
    .logo { color: #D4A853; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 24px; }
    h1 { font-size: 22px; font-weight: 600; color: ${headingColor}; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.6; color: #A0A0A0; margin: 0 0 16px 0; }
    .highlight { color: #D4A853; font-weight: 600; }
    .divider { border-top: 1px solid #2A2B33; margin: 24px 0; }
    .detail { font-size: 14px; color: #888; margin: 6px 0; }
    .detail strong { color: #CCC; }
    .badge { display: inline-block; padding: 6px 14px; border-radius: 6px; font-weight: 600; font-size: 14px; background: ${headingColor}22; color: ${headingColor}; border: 1px solid ${headingColor}44; }
    .reason-box { background: rgba(255,165,0,0.08); border: 1px solid rgba(255,165,0,0.2); border-radius: 8px; padding: 16px; margin: 16px 0; }
    .reason-box p { color: #A0A0A0; margin: 0; font-size: 14px; }
    .small { font-size: 13px; color: #666; }
    .footer { text-align: center; padding: 24px 0; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">BorealisMark</div>
      <h1>${headingText}</h1>
      ${approved
        ? `<p>Hi ${userName || 'there'},</p>
           <p>Congratulations! Your <strong style="color:#fff">${verificationType}</strong> verification has been approved.</p>
           <div class="divider"></div>
           <p class="detail"><strong>Verification Type:</strong> ${verificationType}</p>
           <p class="detail"><strong>Status:</strong> <span class="badge">APPROVED</span></p>
           <p class="detail"><strong>Approved:</strong> ${timestamp}</p>
           <div class="divider"></div>
           <p>Your verification is now active. You have earned <span class="highlight">${trustPointsEarned ?? 10} trust points</span> for completing this verification. These points contribute to your BorealisMark Score and unlock additional marketplace features.</p>
           <p>Thank you for verifying your identity on BorealisMark.</p>`
        : `<p>Hi ${userName || 'there'},</p>
           <p>Your <strong style="color:#fff">${verificationType}</strong> verification could not be approved at this time.</p>
           <div class="divider"></div>
           <p class="detail"><strong>Verification Type:</strong> ${verificationType}</p>
           <p class="detail"><strong>Status:</strong> <span class="badge">UPDATE REQUIRED</span></p>
           ${reason ? `<div class="reason-box"><p><strong style="color:#FFA500">Reason:</strong> ${reason}</p></div>` : ''}
           <p>Please review the feedback above and resubmit your verification. You can try again at any time in your account settings.</p>`
      }
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} BorealisMark Protocol - AI Trust Certification
    </div>
  </div>
</body>
</html>`;

  const text = approved
    ? `Verification Approved\n\nHi ${userName || 'there'},\n\nCongratulations! Your ${verificationType} verification has been approved.\n\nVerification Type: ${verificationType}\nStatus: APPROVED\nApproved: ${timestamp}\n\nYou have earned ${trustPointsEarned ?? 10} trust points for completing this verification.\n\n- BorealisMark Protocol`
    : `Verification Update\n\nHi ${userName || 'there'},\n\nYour ${verificationType} verification could not be approved at this time.\n\nVerification Type: ${verificationType}\nStatus: UPDATE REQUIRED\n${reason ? `Reason: ${reason}\n` : ''}\nPlease resubmit your verification in your account settings.\n\n- BorealisMark Protocol`;

  if (!process.env.RESEND_API_KEY) {
    logger.info(`Verification result email (NOT SENT — no RESEND_API_KEY): ${approved ? 'approved' : 'rejected'}`, {
      to: toEmail,
      userName,
      verificationType,
    });
    return true;
  }

  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [toEmail],
      subject: `Verification ${approved ? 'Approved' : 'Update'} - BorealisMark`,
      html,
      text,
    });

    if (result.error) {
      logger.error('Verification result email send failed', { error: result.error, to: toEmail });
      return false;
    }

    logger.info('Verification result email sent', { to: toEmail, approved, verificationType, id: result.data?.id });
    return true;
  } catch (err: any) {
    logger.error('Verification result email error', { error: err.message, to: toEmail });
    return false;
  }
}

/**
 * Send a transactional notification email for marketplace order events.
 * v44: Wired to notification preferences — only called when email preference is enabled.
 */
export async function sendOrderNotificationEmail(
  toEmail: string,
  userName: string,
  eventType: 'payment_received' | 'order_shipped' | 'order_settled',
  message: string,
): Promise<boolean> {
  const frontendUrl = process.env.FRONTEND_URL ?? 'https://borealisterminal.com';
  const orderLink = `${frontendUrl}/#orders`;

  const titles: Record<string, string> = {
    payment_received: 'Payment Received',
    order_shipped: 'Order Shipped',
    order_settled: 'Order Settled',
  };

  const icons: Record<string, string> = {
    payment_received: '💰',
    order_shipped: '📦',
    order_settled: '✅',
  };

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: #0C0D10; color: #E0E0E0; }
    .container { max-width: 560px; margin: 40px auto; padding: 0 20px; }
    .card { background: #16171C; border: 1px solid #2A2B33; border-radius: 12px; padding: 40px 32px; }
    .logo { color: #D4A853; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 24px; }
    h1 { font-size: 22px; font-weight: 600; color: #FFFFFF; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.6; color: #A0A0A0; margin: 0 0 16px 0; }
    .btn { display: inline-block; background: #D4A853; color: #0C0D10; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; margin: 8px 0 24px 0; }
    .divider { border-top: 1px solid #2A2B33; margin: 24px 0; }
    .small { font-size: 13px; color: #666; }
    .footer { text-align: center; padding: 24px 0; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">Borealis Terminal</div>
      <h1>${icons[eventType] || '🔔'} ${titles[eventType] || 'Order Update'}</h1>
      <p>Hi ${userName || 'there'},</p>
      <p>${message}</p>
      <a href="${orderLink}" class="btn">View Order Details</a>
      <div class="divider"></div>
      <p class="small">You received this email because you have order notifications enabled. You can manage your notification preferences in your dashboard settings.</p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} BorealisMark Protocol - Borealis Terminal
    </div>
  </div>
</body>
</html>`;

  const text = `${titles[eventType] || 'Order Update'}\n\nHi ${userName || 'there'},\n\n${message}\n\nView your orders: ${orderLink}\n\n- Borealis Terminal`;

  if (!process.env.RESEND_API_KEY) {
    logger.info('Order notification email (NOT SENT — no RESEND_API_KEY)', { to: toEmail, eventType });
    return true;
  }

  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [toEmail],
      subject: `${titles[eventType] || 'Order Update'} - Borealis Terminal`,
      html,
      text,
      headers: {
        'List-Unsubscribe': '<mailto:unsubscribe@borealisprotocol.ai?subject=unsubscribe>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });

    if (result.error) {
      logger.error('Order notification email failed', { error: result.error, to: toEmail });
      return false;
    }

    logger.info('Order notification email sent', { to: toEmail, eventType });
    return true;
  } catch (err: any) {
    logger.error('Order notification email error', { error: err.message, to: toEmail });
    return false;
  }
}

/**
 * Send a payment/subscription notification email.
 * v44: Wired to notification preferences.
 */
export async function sendPaymentNotificationEmail(
  toEmail: string,
  userName: string,
  eventType: 'subscription_created' | 'subscription_expired',
  details: string,
): Promise<boolean> {
  const frontendUrl = process.env.FRONTEND_URL ?? 'https://borealisterminal.com';
  const link = `${frontendUrl}/#settings`;

  const titles: Record<string, string> = {
    subscription_created: 'Subscription Activated',
    subscription_expired: 'Subscription Expired',
  };

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0C0D10; color: #E0E0E0; }
    .container { max-width: 560px; margin: 40px auto; padding: 0 20px; }
    .card { background: #16171C; border: 1px solid #2A2B33; border-radius: 12px; padding: 40px 32px; }
    .logo { color: #D4A853; font-size: 20px; font-weight: 700; margin-bottom: 24px; }
    h1 { font-size: 22px; font-weight: 600; color: #FFFFFF; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.6; color: #A0A0A0; margin: 0 0 16px 0; }
    .btn { display: inline-block; background: #D4A853; color: #0C0D10; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; }
    .divider { border-top: 1px solid #2A2B33; margin: 24px 0; }
    .small { font-size: 13px; color: #666; }
    .footer { text-align: center; padding: 24px 0; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">Borealis Terminal</div>
      <h1>${titles[eventType]}</h1>
      <p>Hi ${userName},</p>
      <p>${details}</p>
      <a href="${link}" class="btn">View Account</a>
      <div class="divider"></div>
      <p class="small">Manage notification preferences in your dashboard settings.</p>
    </div>
    <div class="footer">&copy; ${new Date().getFullYear()} BorealisMark Protocol</div>
  </div>
</body>
</html>`;

  const text = `${titles[eventType]}\n\nHi ${userName},\n\n${details}\n\nView: ${link}\n\n- Borealis Terminal`;

  if (!process.env.RESEND_API_KEY) {
    logger.info('Payment notification email (NOT SENT)', { to: toEmail, eventType });
    return true;
  }

  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [toEmail],
      subject: `${titles[eventType]} - Borealis Terminal`,
      html,
      text,
      headers: {
        'List-Unsubscribe': '<mailto:unsubscribe@borealisprotocol.ai?subject=unsubscribe>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    if (result.error) { logger.error('Payment email failed', { error: result.error }); return false; }
    logger.info('Payment notification email sent', { to: toEmail, eventType });
    return true;
  } catch (err: any) {
    logger.error('Payment email error', { error: err.message });
    return false;
  }
}

/**
 * Send a verification notification email.
 * v44: Wired to notification preferences.
 */
export async function sendVerificationNotificationEmail(
  toEmail: string,
  userName: string,
  message: string,
): Promise<boolean> {
  const frontendUrl = process.env.FRONTEND_URL ?? 'https://borealisterminal.com';
  const trustLink = `${frontendUrl}/#trust`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0C0D10; color: #E0E0E0; }
    .container { max-width: 560px; margin: 40px auto; padding: 0 20px; }
    .card { background: #16171C; border: 1px solid #2A2B33; border-radius: 12px; padding: 40px 32px; }
    .logo { color: #D4A853; font-size: 20px; font-weight: 700; margin-bottom: 24px; }
    h1 { font-size: 22px; font-weight: 600; color: #FFFFFF; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.6; color: #A0A0A0; margin: 0 0 16px 0; }
    .btn { display: inline-block; background: #D4A853; color: #0C0D10; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; }
    .divider { border-top: 1px solid #2A2B33; margin: 24px 0; }
    .small { font-size: 13px; color: #666; }
    .footer { text-align: center; padding: 24px 0; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">Borealis Terminal</div>
      <h1>✅ Verification Complete</h1>
      <p>Hi ${userName},</p>
      <p>${message}</p>
      <a href="${trustLink}" class="btn">View Trust Profile</a>
      <div class="divider"></div>
      <p class="small">Manage notification preferences in your dashboard settings.</p>
    </div>
    <div class="footer">&copy; ${new Date().getFullYear()} BorealisMark Protocol</div>
  </div>
</body>
</html>`;

  const text = `Verification Complete\n\nHi ${userName},\n\n${message}\n\nView your trust profile: ${trustLink}\n\n- Borealis Terminal`;

  if (!process.env.RESEND_API_KEY) {
    logger.info('Verification notification email (NOT SENT)', { to: toEmail });
    return true;
  }

  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [toEmail],
      subject: 'Verification Complete - Borealis Terminal',
      html,
      text,
      headers: {
        'List-Unsubscribe': '<mailto:unsubscribe@borealisprotocol.ai?subject=unsubscribe>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    if (result.error) { logger.error('Verification email failed', { error: result.error }); return false; }
    logger.info('Verification notification email sent', { to: toEmail });
    return true;
  } catch (err: any) {
    logger.error('Verification email error', { error: err.message });
    return false;
  }
}

/**
 * Send a BTS License Key delivery email.
 * This is the ONLY time the raw key is ever transmitted.
 * The key hash is stored; the plaintext key is never logged or stored after this point.
 */
export async function sendBTSKeyEmail(
  toEmail: string,
  userName: string,
  btsKey: string,
  keyPrefix: string,
): Promise<boolean> {
  const dashboardUrl = `${process.env.FRONTEND_URL ?? 'https://borealismark.com'}/dashboard.html`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your BTS License Key - Borealis Protocol</title>
</head>
<body style="margin:0;padding:0;background-color:#0C0D10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0C0D10;">
    <tr>
      <td align="center" style="padding:40px 20px;">

        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">

          <!-- HEADER -->
          <tr>
            <td align="center" style="background-color:#0F1014;border:1px solid #2A2B33;border-bottom:none;border-radius:12px 12px 0 0;padding:36px 40px 0 40px;">
              <p style="font-size:11px;font-weight:700;letter-spacing:5px;color:#D4A853;text-transform:uppercase;margin:0 0 6px 0;">BOREALIS</p>
              <p style="font-size:26px;font-weight:700;letter-spacing:-0.5px;color:#FFFFFF;margin:0 0 24px 0;">PROTOCOL</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="width:60px;height:2px;background-color:#D4A853;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- WELCOME -->
          <tr>
            <td align="center" style="background-color:#0F1014;border-left:1px solid #2A2B33;border-right:1px solid #2A2B33;padding:28px 40px 24px 40px;">
              <h1 style="font-size:22px;font-weight:700;color:#FFFFFF;margin:0 0 8px 0;letter-spacing:-0.3px;">Welcome to the Borealis Trust Network</h1>
              <p style="font-size:14px;color:#888888;margin:0;">Your Merlin Agent Runtime purchase is confirmed</p>
            </td>
          </tr>

          <!-- DIVIDER -->
          <tr>
            <td style="background-color:#0F1014;border-left:1px solid #2A2B33;border-right:1px solid #2A2B33;padding:0 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr><td style="height:1px;background-color:#2A2B33;font-size:0;line-height:0;">&nbsp;</td></tr>
              </table>
            </td>
          </tr>

          <!-- GREETING -->
          <tr>
            <td style="background-color:#0F1014;border-left:1px solid #2A2B33;border-right:1px solid #2A2B33;padding:28px 40px 24px 40px;">
              <p style="font-size:16px;color:#E0E0E0;margin:0 0 12px 0;">Hi ${userName || 'there'},</p>
              <p style="font-size:15px;line-height:1.7;color:#A0A0A0;margin:0;">Your BTS License Key is ready. This key is the identity credential for your AI agent on the Borealis trust network. It is shown <strong style="color:#FFFFFF;">exactly once</strong> - save it now.</p>
            </td>
          </tr>

          <!-- KEY CARD -->
          <tr>
            <td style="background-color:#0F1014;border-left:1px solid #2A2B33;border-right:1px solid #2A2B33;padding:0 40px 32px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#070809;border:2px solid #D4A853;border-radius:10px;">
                <tr>
                  <td align="center" style="padding:32px 24px 20px 24px;">
                    <p style="font-size:22px;margin:0 0 16px 0;">&#128273;</p>
                    <p style="font-size:11px;font-weight:700;color:#888888;letter-spacing:2px;text-transform:uppercase;margin:0 0 18px 0;">BTS LICENSE KEY &nbsp;-&nbsp; ${keyPrefix}...</p>
                    <p style="font-family:'Courier New',Courier,monospace;font-size:20px;font-weight:700;color:#D4A853;letter-spacing:3px;word-break:break-all;margin:0;line-height:1.6;">${btsKey}</p>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="border-top:1px solid #1F1A0F;padding:12px 24px;">
                    <p style="font-size:11px;color:#4A4030;letter-spacing:1px;text-transform:uppercase;margin:0;">1 KEY &nbsp;-&nbsp; 1 AGENT &nbsp;-&nbsp; PERMANENT BINDING</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- BINDING NOTICE -->
          <tr>
            <td style="background-color:#0F1014;border-left:1px solid #2A2B33;border-right:1px solid #2A2B33;padding:0 40px 32px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#141108;border:1px solid #3A2E10;border-radius:8px;">
                <tr>
                  <td style="padding:20px 24px;">
                    <p style="font-size:12px;font-weight:700;color:#D4A853;text-transform:uppercase;letter-spacing:1px;margin:0 0 10px 0;">Important - Permanent Binding</p>
                    <p style="font-size:13px;color:#B89A50;line-height:1.7;margin:0;">When you activate this key, it binds <strong style="color:#D4A853;">permanently</strong> to one AI agent. This binding cannot be reversed or transferred. If you later need a new key, both this key and its bound agent will be permanently terminated - all trust scores for that agent will be marked as terminated on the public record. <strong style="color:#D4A853;">Choose your agent carefully before activating.</strong></p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- WHAT'S NEXT -->
          <tr>
            <td style="background-color:#0F1014;border-left:1px solid #2A2B33;border-right:1px solid #2A2B33;padding:0 40px 32px 40px;">
              <p style="font-size:12px;font-weight:700;color:#D4A853;text-transform:uppercase;letter-spacing:1.5px;margin:0 0 22px 0;">What's Next - 4 Steps to Your Trust Score</p>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
                <tr>
                  <td width="34" valign="top" style="padding-top:2px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr><td align="center" width="24" height="24" style="background-color:#D4A853;border-radius:12px;font-size:11px;font-weight:700;color:#0C0D10;line-height:24px;">1</td></tr>
                    </table>
                  </td>
                  <td style="padding-left:6px;">
                    <p style="font-size:14px;color:#C0C0C0;margin:0;line-height:1.6;"><strong style="color:#FFFFFF;">Save this key now.</strong> It is shown exactly once in this email. Only the prefix appears in your dashboard. If you lose it before activation, contact support for a replacement.</p>
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
                <tr>
                  <td width="34" valign="top" style="padding-top:2px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr><td align="center" width="24" height="24" style="background-color:#D4A853;border-radius:12px;font-size:11px;font-weight:700;color:#0C0D10;line-height:24px;">2</td></tr>
                    </table>
                  </td>
                  <td style="padding-left:6px;">
                    <p style="font-size:14px;color:#C0C0C0;margin:0;line-height:1.6;"><strong style="color:#FFFFFF;">Register your agent</strong> in <a href="${dashboardUrl}#licenses" style="color:#D4A853;text-decoration:none;">My Licenses</a>. Create a profile for the AI agent that will use this key - name and description only.</p>
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
                <tr>
                  <td width="34" valign="top" style="padding-top:2px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr><td align="center" width="24" height="24" style="background-color:#D4A853;border-radius:12px;font-size:11px;font-weight:700;color:#0C0D10;line-height:24px;">3</td></tr>
                    </table>
                  </td>
                  <td style="padding-left:6px;">
                    <p style="font-size:14px;color:#C0C0C0;margin:0;line-height:1.6;"><strong style="color:#FFFFFF;">Bind your key</strong> - click Activate in My Licenses and follow the wizard. This permanently pairs the key with your agent. Choose carefully - this step cannot be reversed.</p>
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td width="34" valign="top" style="padding-top:2px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr><td align="center" width="24" height="24" style="background-color:#D4A853;border-radius:12px;font-size:11px;font-weight:700;color:#0C0D10;line-height:24px;">4</td></tr>
                    </table>
                  </td>
                  <td style="padding-left:6px;">
                    <p style="font-size:14px;color:#C0C0C0;margin:0;line-height:1.6;"><strong style="color:#FFFFFF;">Submit telemetry</strong> via <span style="font-family:'Courier New',Courier,monospace;font-size:12px;background-color:#070809;color:#D4A853;padding:2px 6px;border-radius:3px;">@borealis/merlin-sdk</span> or <span style="font-family:'Courier New',Courier,monospace;font-size:12px;background-color:#070809;color:#D4A853;padding:2px 6px;border-radius:3px;">POST /v1/licenses/telemetry</span> to generate your BTS trust score, anchored to Hedera Hashgraph.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- GETTING STARTED RESOURCES -->
          <tr>
            <td style="background-color:#0F1014;border-left:1px solid #2A2B33;border-right:1px solid #2A2B33;padding:0 40px 28px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
                <tr><td style="height:1px;background-color:#1A1B22;font-size:0;line-height:0;">&nbsp;</td></tr>
              </table>
              <p style="font-size:12px;font-weight:700;color:#D4A853;text-transform:uppercase;letter-spacing:1.5px;margin:0 0 14px 0;">Getting Started</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding-bottom:8px;">
                    <p style="font-size:13px;color:#A0A0A0;margin:0;line-height:1.6;">
                      <span style="color:#D4A853;">&#8227;&nbsp;</span>
                      <a href="https://borealisacademy.com/hub/how-bm-score-works.html" style="color:#8888AA;text-decoration:none;">How BTS Score Works</a> - understand what goes into your trust rating
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="padding-bottom:8px;">
                    <p style="font-size:13px;color:#A0A0A0;margin:0;line-height:1.6;">
                      <span style="color:#D4A853;">&#8227;&nbsp;</span>
                      <a href="https://borealisacademy.com/simulator.html" style="color:#8888AA;text-decoration:none;">Score Simulator</a> - preview what your score might look like
                    </p>
                  </td>
                </tr>
                <tr>
                  <td>
                    <p style="font-size:13px;color:#A0A0A0;margin:0;line-height:1.6;">
                      <span style="color:#D4A853;">&#8227;&nbsp;</span>
                      The onboarding wizard in your <a href="${dashboardUrl}#licenses" style="color:#8888AA;text-decoration:none;">dashboard</a> walks you through every step
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- WHAT YOUR KEY UNLOCKS -->
          <tr>
            <td style="background-color:#0F1014;border-left:1px solid #2A2B33;border-right:1px solid #2A2B33;padding:0 40px 32px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr><td style="height:1px;background-color:#2A2B33;font-size:0;line-height:0;margin-bottom:28px;">&nbsp;</td></tr>
              </table>
              <p style="font-size:12px;font-weight:700;color:#D4A853;text-transform:uppercase;letter-spacing:1.5px;margin:20px 0 18px 0;">What Your Key Unlocks</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding-bottom:10px;">
                    <p style="font-size:14px;color:#C0C0C0;margin:0;line-height:1.6;"><span style="color:#D4A853;">&#9658;&nbsp;</span>5-factor BM Trust Score anchored to Hedera Hashgraph</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding-bottom:10px;">
                    <p style="font-size:14px;color:#C0C0C0;margin:0;line-height:1.6;"><span style="color:#D4A853;">&#9658;&nbsp;</span>Public credit rating: AAA+ down to FLAGGED</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding-bottom:10px;">
                    <p style="font-size:14px;color:#C0C0C0;margin:0;line-height:1.6;"><span style="color:#D4A853;">&#9658;&nbsp;</span>Immutable audit trail on-chain - tamper-proof by design</p>
                  </td>
                </tr>
                <tr>
                  <td>
                    <p style="font-size:14px;color:#C0C0C0;margin:0;line-height:1.6;"><span style="color:#D4A853;">&#9658;&nbsp;</span>Verifiable identity on the Borealis public registry</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td align="center" style="background-color:#0F1014;border-left:1px solid #2A2B33;border-right:1px solid #2A2B33;padding:0 40px 28px 40px;">
              <a href="${dashboardUrl}#licenses" style="display:inline-block;background-color:#D4A853;color:#0C0D10;padding:14px 44px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;letter-spacing:0.3px;">Open My Licenses</a>
            </td>
          </tr>

          <!-- SUPPORT -->
          <tr>
            <td style="background-color:#0F1014;border-left:1px solid #2A2B33;border-right:1px solid #2A2B33;padding:0 40px 28px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0A0B0E;border:1px solid #1E1F26;border-radius:8px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <p style="font-size:11px;font-weight:700;color:#D4A853;text-transform:uppercase;letter-spacing:1px;margin:0 0 6px 0;">Support</p>
                    <p style="font-size:13px;color:#888888;margin:0;line-height:1.6;">Questions about your key, activation, or scoring? We respond to all support requests.</p>
                    <p style="font-size:13px;margin:8px 0 0 0;"><a href="mailto:support@borealisprotocol.ai" style="color:#D4A853;text-decoration:none;font-weight:600;">support@borealisprotocol.ai</a></p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- KEY RECOVERY NOTICE -->
          <tr>
            <td style="background-color:#0F1014;border:1px solid #2A2B33;border-top:none;border-radius:0 0 12px 12px;padding:0 40px 32px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr><td style="height:1px;background-color:#2A2B33;font-size:0;line-height:0;">&nbsp;</td></tr>
              </table>
              <p style="font-size:12px;color:#555555;line-height:1.8;margin:20px 0 0 0;">Save this email. Your raw BTS key will <strong style="color:#888888;">never be shown again</strong> - only the prefix (<span style="font-family:'Courier New',Courier,monospace;font-size:11px;background-color:#070809;color:#D4A853;padding:1px 5px;border-radius:3px;">${keyPrefix}...</span>) appears in your dashboard. If you lose this key before activating it, contact <a href="mailto:support@borealisprotocol.ai" style="color:#666666;text-decoration:none;">support@borealisprotocol.ai</a> - the original key will be permanently terminated and replaced.</p>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td align="center" style="padding:32px 0 40px 0;">
              <p style="font-size:13px;font-weight:600;color:#D4A853;letter-spacing:2.5px;text-transform:uppercase;margin:0 0 18px 0;">Follow the North Star</p>
              <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:0 10px;">
                    <a href="https://borealisprotocol.ai" style="font-size:12px;color:#888888;text-decoration:none;">Protocol</a>
                  </td>
                  <td style="font-size:12px;color:#333333;">|</td>
                  <td style="padding:0 10px;">
                    <a href="https://borealismark.com" style="font-size:12px;color:#888888;text-decoration:none;">Mark</a>
                  </td>
                  <td style="font-size:12px;color:#333333;">|</td>
                  <td style="padding:0 10px;">
                    <a href="https://borealisterminal.com" style="font-size:12px;color:#888888;text-decoration:none;">Terminal</a>
                  </td>
                  <td style="font-size:12px;color:#333333;">|</td>
                  <td style="padding:0 10px;">
                    <a href="https://borealisacademy.com" style="font-size:12px;color:#888888;text-decoration:none;">Academy</a>
                  </td>
                </tr>
              </table>
              <p style="font-size:11px;color:#444444;margin:18px 0 6px 0;">&copy; ${new Date().getFullYear()} Borealis Protocol Ltd</p>
              <p style="font-size:11px;color:#333333;margin:0;">This email was sent to ${toEmail} because you purchased a Merlin BTS License Key.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;

  const text = `Your BTS License Key - Borealis Protocol

Hi ${userName || 'there'},

Your Merlin BTS License Key purchase is confirmed. Your key is below - save it now.

YOUR KEY (shown ONCE - save immediately):
${btsKey}

⚠ PERMANENT BINDING WARNING:
When you activate this key, it binds permanently to one AI agent. This cannot be reversed.
If you need a new key later, both this key AND its bound agent will be permanently terminated.
Choose your agent carefully before activating.

WHAT'S NEXT - 4 STEPS TO YOUR TRUST SCORE:
1. Save this key now - it is shown exactly once.
2. Register your agent at ${dashboardUrl}#licenses - create a profile for the AI agent.
3. Bind your key - click Activate in My Licenses and follow the wizard. Permanent and irreversible.
4. Submit telemetry via @borealis/merlin-sdk or POST /v1/licenses/telemetry to generate your BTS score.

GETTING STARTED:
- How BTS Score Works: https://borealisacademy.com/hub/how-bm-score-works.html
- Score Simulator: https://borealisacademy.com/simulator.html
- Dashboard onboarding wizard walks through every step: ${dashboardUrl}#licenses

Save this email - your raw key will NEVER be shown again.
Only the key prefix (${keyPrefix}...) is visible in your dashboard.

SUPPORT: support@borealisprotocol.ai

- Borealis Protocol`;

  if (!process.env.RESEND_API_KEY) {
    logger.info('BTS key email (NOT SENT — no RESEND_API_KEY)', {
      to: toEmail,
      keyPrefix,
      // Never log the raw key
    });
    return false;
  }

  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [toEmail],
      subject: `Your BTS License Key - ${keyPrefix}... (save this email)`,
      html,
      text,
    });

    if (result.error) {
      logger.error('BTS key email send failed', { error: result.error, to: toEmail, keyPrefix });
      return false;
    }

    logger.info('BTS key email sent', { to: toEmail, keyPrefix, id: result.data?.id });
    return true;
  } catch (err: any) {
    logger.error('BTS key email error', { error: err.message, to: toEmail, keyPrefix });
    return false;
  }
}

// ─── Shared Template Wrapper ──────────────────────────────────────────────────

/**
 * Wraps HTML body content with the standard Borealis dark email shell.
 * Includes logo, footer links, and "Follow the North Star" tagline.
 */
export function emailTemplate(body: string, recipientEmail: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#0C0D10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0C0D10;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" width="580" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;width:100%;">
          <tr>
            <td align="center" style="background-color:#0F1014;border:1px solid #2A2B33;border-bottom:none;border-radius:12px 12px 0 0;padding:28px 40px 0 40px;">
              <p style="font-size:11px;font-weight:700;letter-spacing:5px;color:#D4A853;text-transform:uppercase;margin:0 0 6px 0;">BOREALIS</p>
              <p style="font-size:24px;font-weight:700;letter-spacing:-0.5px;color:#FFFFFF;margin:0 0 20px 0;">PROTOCOL</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr><td style="width:60px;height:2px;background-color:#D4A853;font-size:0;line-height:0;">&nbsp;</td></tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color:#0F1014;border-left:1px solid #2A2B33;border-right:1px solid #2A2B33;padding:28px 40px;">
              ${body}
            </td>
          </tr>
          <tr>
            <td style="background-color:#0F1014;border:1px solid #2A2B33;border-top:none;border-radius:0 0 12px 12px;padding:0 40px 28px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr><td style="height:1px;background-color:#2A2B33;font-size:0;line-height:0;">&nbsp;</td></tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:28px 0 36px 0;">
              <p style="font-size:13px;font-weight:600;color:#D4A853;letter-spacing:2.5px;text-transform:uppercase;margin:0 0 16px 0;">Follow the North Star</p>
              <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:0 8px;"><a href="https://borealisprotocol.ai" style="font-size:12px;color:#888888;text-decoration:none;">Protocol</a></td>
                  <td style="font-size:12px;color:#333333;">|</td>
                  <td style="padding:0 8px;"><a href="https://borealismark.com" style="font-size:12px;color:#888888;text-decoration:none;">Mark</a></td>
                  <td style="font-size:12px;color:#333333;">|</td>
                  <td style="padding:0 8px;"><a href="https://borealisterminal.com" style="font-size:12px;color:#888888;text-decoration:none;">Terminal</a></td>
                  <td style="font-size:12px;color:#333333;">|</td>
                  <td style="padding:0 8px;"><a href="https://borealisacademy.com" style="font-size:12px;color:#888888;text-decoration:none;">Academy</a></td>
                </tr>
              </table>
              <p style="font-size:11px;color:#444444;margin:16px 0 4px 0;">&copy; ${new Date().getFullYear()} Borealis Protocol Ltd</p>
              <p style="font-size:11px;color:#333333;margin:0;">This email was sent to ${recipientEmail}.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── License Revocation Email ─────────────────────────────────────────────────

/**
 * Notify a user that their BTS License Key has been permanently revoked.
 * Revocation terminates both the key AND the bound agent identity.
 */
export async function sendKeyRevocationEmail(
  toEmail: string,
  userName: string,
  keyPrefix: string,
  agentName: string | null,
  reason: string,
  hederaTxId?: string | null,
): Promise<boolean> {
  const last4 = keyPrefix.slice(-4);
  const agentLine = agentName
    ? `<p style="font-size:14px;color:#C0C0C0;margin:0 0 8px 0;line-height:1.6;"><strong style="color:#CCC;">Bound Agent:</strong> ${agentName} (terminated)</p>`
    : '';
  const hederaLine = hederaTxId
    ? `<p style="font-size:13px;color:#666;margin:12px 0 0 0;">Hedera record: <span style="font-family:'Courier New',Courier,monospace;color:#888;">${hederaTxId}</span></p>`
    : '';

  const body = `
    <h1 style="font-size:22px;font-weight:700;color:#FFFFFF;margin:0 0 20px 0;">Your BTS License Key has been revoked</h1>
    <p style="font-size:15px;line-height:1.7;color:#A0A0A0;margin:0 0 20px 0;">Hi ${userName || 'there'},</p>
    <p style="font-size:15px;line-height:1.7;color:#A0A0A0;margin:0 0 20px 0;">Your BTS License Key ending in <strong style="color:#D4A853;">...${last4}</strong> has been permanently revoked, effective immediately.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0C0D10;border:1px solid #3A2020;border-radius:8px;margin-bottom:24px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="font-size:12px;font-weight:700;color:#FF6B6B;text-transform:uppercase;letter-spacing:1px;margin:0 0 12px 0;">Revocation Details</p>
          <p style="font-size:14px;color:#C0C0C0;margin:0 0 8px 0;line-height:1.6;"><strong style="color:#CCC;">Key:</strong> BTS-...${last4} (terminated)</p>
          ${agentLine}
          <p style="font-size:14px;color:#C0C0C0;margin:0 0 8px 0;line-height:1.6;"><strong style="color:#CCC;">Reason:</strong> ${reason}</p>
          <p style="font-size:14px;color:#C0C0C0;margin:0;line-height:1.6;"><strong style="color:#CCC;">Effective:</strong> Immediately</p>
        </td>
      </tr>
    </table>
    <p style="font-size:14px;font-weight:700;color:#E0E0E0;margin:0 0 12px 0;">What this means</p>
    <p style="font-size:14px;color:#A0A0A0;line-height:1.7;margin:0 0 8px 0;">- Your agent identity on the Borealis trust network has been terminated.</p>
    <p style="font-size:14px;color:#A0A0A0;line-height:1.7;margin:0 0 8px 0;">- All trust scoring for this key is permanently disabled.</p>
    <p style="font-size:14px;color:#A0A0A0;line-height:1.7;margin:0 0 8px 0;">- The public Hedera record is preserved with full history - the revocation is immutable.</p>
    <p style="font-size:14px;color:#A0A0A0;line-height:1.7;margin:0 0 24px 0;">- Your account and other licenses are unaffected.</p>
    ${hederaLine}
    <p style="font-size:14px;color:#A0A0A0;line-height:1.7;margin:24px 0 0 0;">If you believe this was done in error, contact us at <a href="mailto:support@borealisprotocol.ai" style="color:#D4A853;">support@borealisprotocol.ai</a>.</p>
  `;

  const html = emailTemplate(body, toEmail);
  const text = `Your BTS License Key has been revoked\n\nHi ${userName || 'there'},\n\nYour BTS License Key ending in ...${last4} has been permanently revoked, effective immediately.\n\nReason: ${reason}\n${agentName ? `Bound agent: ${agentName} (terminated)\n` : ''}\nWhat this means:\n- Your agent identity on the Borealis trust network has been terminated.\n- All trust scoring for this key is permanently disabled.\n- The Hedera record is preserved with full history.\n- Your account and other licenses are unaffected.\n${hederaTxId ? `\nHedera record: ${hederaTxId}` : ''}\n\nIf you believe this was in error, contact support@borealisprotocol.ai\n\n- Borealis Protocol`;

  if (!process.env.RESEND_API_KEY) {
    logger.info('Key revocation email (NOT SENT — no RESEND_API_KEY)', { to: toEmail, keyPrefix });
    return true;
  }
  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [toEmail],
      subject: `Your BTS License Key has been revoked - BTS-...${last4}`,
      html,
      text,
    });
    if (result.error) { logger.error('Key revocation email failed', { error: result.error, to: toEmail }); return false; }
    logger.info('Key revocation email sent', { to: toEmail, keyPrefix });
    return true;
  } catch (err: any) {
    logger.error('Key revocation email error', { error: err.message, to: toEmail });
    return false;
  }
}

// ─── License Suspension Email ─────────────────────────────────────────────────

/**
 * Notify a user that their BTS License Key has been temporarily suspended.
 */
export async function sendKeySuspensionEmail(
  toEmail: string,
  userName: string,
  keyPrefix: string,
  agentName: string | null,
  reason: string,
): Promise<boolean> {
  const last4 = keyPrefix.slice(-4);
  const agentLine = agentName
    ? `<p style="font-size:14px;color:#C0C0C0;margin:0 0 8px 0;line-height:1.6;"><strong style="color:#CCC;">Bound Agent:</strong> ${agentName}</p>`
    : '';

  const body = `
    <h1 style="font-size:22px;font-weight:700;color:#FFFFFF;margin:0 0 20px 0;">Your BTS License Key has been suspended</h1>
    <p style="font-size:15px;line-height:1.7;color:#A0A0A0;margin:0 0 20px 0;">Hi ${userName || 'there'},</p>
    <p style="font-size:15px;line-height:1.7;color:#A0A0A0;margin:0 0 20px 0;">Your BTS License Key ending in <strong style="color:#D4A853;">...${last4}</strong> has been temporarily suspended.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0C0D10;border:1px solid #3A3010;border-radius:8px;margin-bottom:24px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="font-size:12px;font-weight:700;color:#FFA500;text-transform:uppercase;letter-spacing:1px;margin:0 0 12px 0;">Suspension Details</p>
          <p style="font-size:14px;color:#C0C0C0;margin:0 0 8px 0;line-height:1.6;"><strong style="color:#CCC;">Key:</strong> BTS-...${last4} (suspended)</p>
          ${agentLine}
          <p style="font-size:14px;color:#C0C0C0;margin:0;line-height:1.6;"><strong style="color:#CCC;">Reason:</strong> ${reason}</p>
        </td>
      </tr>
    </table>
    <p style="font-size:14px;font-weight:700;color:#E0E0E0;margin:0 0 12px 0;">What is affected</p>
    <p style="font-size:14px;color:#A0A0A0;line-height:1.7;margin:0 0 8px 0;">- Trust scoring is paused - no new BTS scores will be computed.</p>
    <p style="font-size:14px;color:#A0A0A0;line-height:1.7;margin:0 0 8px 0;">- Telemetry submissions are blocked for this key.</p>
    <p style="font-size:14px;color:#A0A0A0;line-height:1.7;margin:0 0 8px 0;">- Public verification will show "suspended" status.</p>
    <p style="font-size:14px;color:#A0A0A0;line-height:1.7;margin:0 0 24px 0;">- This is temporary. Your key can be restored once the issue is resolved.</p>
    <p style="font-size:14px;color:#A0A0A0;line-height:1.7;margin:0;">To resolve this suspension, contact us at <a href="mailto:support@borealisprotocol.ai" style="color:#D4A853;">support@borealisprotocol.ai</a>.</p>
  `;

  const html = emailTemplate(body, toEmail);
  const text = `Your BTS License Key has been suspended\n\nHi ${userName || 'there'},\n\nYour BTS License Key ending in ...${last4} has been temporarily suspended.\n\nReason: ${reason}\n${agentName ? `Bound agent: ${agentName}\n` : ''}\nWhat is affected:\n- Trust scoring is paused.\n- Telemetry submissions are blocked.\n- Public verification shows "suspended" status.\n- This is temporary and can be resolved.\n\nContact support@borealisprotocol.ai to resolve this.\n\n- Borealis Protocol`;

  if (!process.env.RESEND_API_KEY) {
    logger.info('Key suspension email (NOT SENT — no RESEND_API_KEY)', { to: toEmail, keyPrefix });
    return true;
  }
  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [toEmail],
      subject: `Your BTS License Key has been suspended - BTS-...${last4}`,
      html,
      text,
    });
    if (result.error) { logger.error('Key suspension email failed', { error: result.error, to: toEmail }); return false; }
    logger.info('Key suspension email sent', { to: toEmail, keyPrefix });
    return true;
  } catch (err: any) {
    logger.error('Key suspension email error', { error: err.message, to: toEmail });
    return false;
  }
}

// ─── License Restoration Email ────────────────────────────────────────────────

/**
 * Notify a user that their BTS License Key has been restored from suspension.
 */
export async function sendKeyRestorationEmail(
  toEmail: string,
  userName: string,
  keyPrefix: string,
  agentName: string | null,
): Promise<boolean> {
  const last4 = keyPrefix.slice(-4);
  const agentLine = agentName
    ? `<p style="font-size:14px;color:#C0C0C0;margin:0 0 8px 0;line-height:1.6;"><strong style="color:#CCC;">Agent:</strong> ${agentName} (scoring resumed)</p>`
    : '';
  const dashboardUrl = `${process.env.FRONTEND_URL ?? 'https://borealismark.com'}/dashboard.html`;

  const body = `
    <h1 style="font-size:22px;font-weight:700;color:#4CAF50;margin:0 0 20px 0;">Your BTS License Key has been restored</h1>
    <p style="font-size:15px;line-height:1.7;color:#A0A0A0;margin:0 0 20px 0;">Hi ${userName || 'there'},</p>
    <p style="font-size:15px;line-height:1.7;color:#A0A0A0;margin:0 0 20px 0;">Good news - your BTS License Key ending in <strong style="color:#D4A853;">...${last4}</strong> has been restored and is fully active again.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0C0D10;border:1px solid #1A3A1A;border-radius:8px;margin-bottom:24px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="font-size:12px;font-weight:700;color:#4CAF50;text-transform:uppercase;letter-spacing:1px;margin:0 0 12px 0;">Restoration Status</p>
          <p style="font-size:14px;color:#C0C0C0;margin:0 0 8px 0;line-height:1.6;"><strong style="color:#CCC;">Key:</strong> BTS-...${last4} (active)</p>
          ${agentLine}
          <p style="font-size:14px;color:#4CAF50;margin:0;line-height:1.6;font-weight:700;">Status: Active - trust scoring resumed</p>
        </td>
      </tr>
    </table>
    <p style="font-size:14px;color:#A0A0A0;line-height:1.7;margin:0 0 8px 0;">Your agent is back online. Telemetry submissions are accepted and trust scoring is active.</p>
    <p style="font-size:14px;color:#A0A0A0;line-height:1.7;margin:0 0 24px 0;">Welcome back to the Borealis trust network.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr><td><a href="${dashboardUrl}" style="display:inline-block;background-color:#D4A853;color:#0C0D10;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">Go to Dashboard</a></td></tr>
    </table>
  `;

  const html = emailTemplate(body, toEmail);
  const text = `Your BTS License Key has been restored\n\nHi ${userName || 'there'},\n\nYour BTS License Key ending in ...${last4} has been restored and is fully active.\n\n- Trust scoring has resumed.\n- Telemetry submissions are accepted.\n- Your agent is back online.\n\nWelcome back to the Borealis trust network.\n\nDashboard: ${dashboardUrl}\n\n- Borealis Protocol`;

  if (!process.env.RESEND_API_KEY) {
    logger.info('Key restoration email (NOT SENT — no RESEND_API_KEY)', { to: toEmail, keyPrefix });
    return true;
  }
  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [toEmail],
      subject: `Your BTS License Key has been restored - BTS-...${last4}`,
      html,
      text,
    });
    if (result.error) { logger.error('Key restoration email failed', { error: result.error, to: toEmail }); return false; }
    logger.info('Key restoration email sent', { to: toEmail, keyPrefix });
    return true;
  } catch (err: any) {
    logger.error('Key restoration email error', { error: err.message, to: toEmail });
    return false;
  }
}

// ─── Account Deletion Email ───────────────────────────────────────────────────

/**
 * Notify a user that their Borealis Protocol account has been deleted.
 */
export async function sendAccountDeletionEmail(
  toEmail: string,
  userName: string,
): Promise<boolean> {
  const body = `
    <h1 style="font-size:22px;font-weight:700;color:#FFFFFF;margin:0 0 20px 0;">Your Borealis Protocol account has been deleted</h1>
    <p style="font-size:15px;line-height:1.7;color:#A0A0A0;margin:0 0 20px 0;">Hi ${userName || 'there'},</p>
    <p style="font-size:15px;line-height:1.7;color:#A0A0A0;margin:0 0 20px 0;">Your Borealis Protocol account associated with <strong style="color:#CCC;">${toEmail}</strong> has been permanently deleted.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0C0D10;border:1px solid #2A2B33;border-radius:8px;margin-bottom:16px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="font-size:12px;font-weight:700;color:#D4A853;text-transform:uppercase;letter-spacing:1px;margin:0 0 12px 0;">What was deleted</p>
          <p style="font-size:14px;color:#C0C0C0;margin:0 0 8px 0;line-height:1.6;">- Account profile and login credentials</p>
          <p style="font-size:14px;color:#C0C0C0;margin:0 0 8px 0;line-height:1.6;">- Associated BTS License Keys (keys revoked, agent identities terminated)</p>
          <p style="font-size:14px;color:#C0C0C0;margin:0 0 8px 0;line-height:1.6;">- Marketplace listings and order history</p>
          <p style="font-size:14px;color:#C0C0C0;margin:0;line-height:1.6;">- Bot configurations and progression data</p>
        </td>
      </tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0C0D10;border:1px solid #2A2B33;border-radius:8px;margin-bottom:24px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="font-size:12px;font-weight:700;color:#D4A853;text-transform:uppercase;letter-spacing:1px;margin:0 0 12px 0;">Data Retention</p>
          <p style="font-size:14px;color:#C0C0C0;margin:0;line-height:1.7;">Hedera blockchain records (audit certificates, trust score anchors) are immutable and cannot be deleted by design. These records contain no personally identifiable information. All other personal data is removed within 30 days.</p>
        </td>
      </tr>
    </table>
    <p style="font-size:14px;color:#A0A0A0;line-height:1.7;margin:0;">If this deletion was made in error or you did not request it, contact us immediately at <a href="mailto:support@borealisprotocol.ai" style="color:#D4A853;">support@borealisprotocol.ai</a>.</p>
  `;

  const html = emailTemplate(body, toEmail);
  const text = `Your Borealis Protocol account has been deleted\n\nHi ${userName || 'there'},\n\nYour Borealis Protocol account (${toEmail}) has been permanently deleted.\n\nWhat was deleted:\n- Account profile and login credentials\n- Associated BTS License Keys\n- Marketplace listings and order history\n- Bot configurations and progression data\n\nData retention: Hedera blockchain records are immutable and cannot be deleted. All personal data is removed within 30 days.\n\nIf this was made in error, contact support@borealisprotocol.ai immediately.\n\n- Borealis Protocol`;

  if (!process.env.RESEND_API_KEY) {
    logger.info('Account deletion email (NOT SENT — no RESEND_API_KEY)', { to: toEmail });
    return true;
  }
  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [toEmail],
      subject: 'Your Borealis Protocol account has been deleted',
      html,
      text,
    });
    if (result.error) { logger.error('Account deletion email failed', { error: result.error, to: toEmail }); return false; }
    logger.info('Account deletion email sent', { to: toEmail });
    return true;
  } catch (err: any) {
    logger.error('Account deletion email error', { error: err.message, to: toEmail });
    return false;
  }
}

// ─── Audit Verdict Email ──────────────────────────────────────────────────────

/**
 * Notify an agent owner of their MAGISTRATE audit verdict.
 * APPROVED = certification granted with BTS score + credit rating.
 * REJECTED = certification not granted with specific failure details.
 */
export async function sendAuditVerdictEmail(
  toEmail: string,
  userName: string,
  agentName: string,
  verdict: 'APPROVED' | 'REJECTED',
  scoreTotal: number,
  creditRating: string,
  certificateId?: string | null,
  hederaTxId?: string | null,
  discrepancies?: string[],
): Promise<boolean> {
  const btsScore = Math.round(scoreTotal / 10);
  const dashboardUrl = `${process.env.FRONTEND_URL ?? 'https://borealismark.com'}/dashboard.html`;
  const ratingColor = verdict === 'APPROVED' ? '#4CAF50' : '#FFA500';

  const approvedBody = `
    <h1 style="font-size:22px;font-weight:700;color:#4CAF50;margin:0 0 8px 0;">Your agent has been certified</h1>
    <p style="font-size:14px;color:#888;margin:0 0 24px 0;">MAGISTRATE audit verdict: APPROVED</p>
    <p style="font-size:15px;line-height:1.7;color:#A0A0A0;margin:0 0 20px 0;">Hi ${userName || 'there'},</p>
    <p style="font-size:15px;line-height:1.7;color:#A0A0A0;margin:0 0 24px 0;"><strong style="color:#CCC;">${agentName}</strong> has passed the Borealis audit and received its BTS trust certification.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#070809;border:2px solid #D4A853;border-radius:10px;margin-bottom:24px;">
      <tr>
        <td align="center" style="padding:28px 24px;">
          <p style="font-size:11px;font-weight:700;color:#888;letter-spacing:2px;text-transform:uppercase;margin:0 0 12px 0;">BTS TRUST SCORE</p>
          <p style="font-size:48px;font-weight:700;color:#D4A853;margin:0 0 8px 0;line-height:1;">${btsScore}</p>
          <p style="font-size:20px;font-weight:700;color:${ratingColor};margin:0 0 4px 0;">${creditRating}</p>
          <p style="font-size:12px;color:#555;margin:0;">out of 100</p>
        </td>
      </tr>
    </table>
    ${certificateId ? `<p style="font-size:13px;color:#666;margin:0 0 8px 0;">Certificate ID: <span style="font-family:'Courier New',Courier,monospace;color:#888;">${certificateId}</span></p>` : ''}
    ${hederaTxId ? `<p style="font-size:13px;color:#666;margin:0 0 24px 0;">Hedera anchor: <span style="font-family:'Courier New',Courier,monospace;color:#888;">${hederaTxId}</span></p>` : '<p style="margin:0 0 24px 0;"></p>'}
    <p style="font-size:14px;color:#A0A0A0;line-height:1.7;margin:0 0 8px 0;">Your agent's trust score and credit rating are now live on the Borealis public registry, anchored to Hedera Hashgraph - tamper-proof and permanently verifiable.</p>
    <p style="font-size:14px;color:#A0A0A0;line-height:1.7;margin:0 0 24px 0;">Continue submitting telemetry via <span style="font-family:'Courier New',monospace;font-size:12px;color:#D4A853;">/v1/licenses/telemetry</span> to keep your score current.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr><td><a href="${dashboardUrl}" style="display:inline-block;background-color:#D4A853;color:#0C0D10;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">View Certificate</a></td></tr>
    </table>
  `;

  const discrepanciesList = (discrepancies ?? []).length > 0
    ? (discrepancies ?? []).map(d => `<p style="font-size:14px;color:#C0C0C0;margin:0 0 8px 0;line-height:1.6;">- ${d}</p>`).join('')
    : '<p style="font-size:14px;color:#C0C0C0;margin:0;line-height:1.6;">See your submission details for a full breakdown.</p>';

  const rejectedBody = `
    <h1 style="font-size:22px;font-weight:700;color:#FFA500;margin:0 0 8px 0;">Certification not granted</h1>
    <p style="font-size:14px;color:#888;margin:0 0 24px 0;">MAGISTRATE audit verdict: REJECTED</p>
    <p style="font-size:15px;line-height:1.7;color:#A0A0A0;margin:0 0 20px 0;">Hi ${userName || 'there'},</p>
    <p style="font-size:15px;line-height:1.7;color:#A0A0A0;margin:0 0 24px 0;">The Borealis MAGISTRATE has reviewed the audit submission for <strong style="color:#CCC;">${agentName}</strong> and the certification request was not approved at this time.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0C0D10;border:1px solid #3A3010;border-radius:8px;margin-bottom:24px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="font-size:12px;font-weight:700;color:#FFA500;text-transform:uppercase;letter-spacing:1px;margin:0 0 12px 0;">Score at time of review</p>
          <p style="font-size:28px;font-weight:700;color:#FFA500;margin:0 0 4px 0;">${btsScore} / 100</p>
          <p style="font-size:14px;color:#888;margin:0;">Rating: ${creditRating}</p>
        </td>
      </tr>
    </table>
    <p style="font-size:14px;font-weight:700;color:#E0E0E0;margin:0 0 12px 0;">Issues identified</p>
    ${discrepanciesList}
    <p style="font-size:14px;font-weight:700;color:#E0E0E0;margin:24px 0 12px 0;">How to resubmit</p>
    <p style="font-size:14px;color:#A0A0A0;line-height:1.7;margin:0 0 8px 0;">1. Address the issues above in your agent's behavioral configuration.</p>
    <p style="font-size:14px;color:#A0A0A0;line-height:1.7;margin:0 0 8px 0;">2. Submit fresh telemetry via <span style="font-family:'Courier New',monospace;font-size:12px;color:#D4A853;">/v1/licenses/telemetry</span> to update your score.</p>
    <p style="font-size:14px;color:#A0A0A0;line-height:1.7;margin:0 0 24px 0;">3. Once your BTS score improves, resubmit the audit via ARBITER.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr><td><a href="${dashboardUrl}" style="display:inline-block;background-color:#D4A853;color:#0C0D10;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">View Dashboard</a></td></tr>
    </table>
  `;

  const html = emailTemplate(verdict === 'APPROVED' ? approvedBody : rejectedBody, toEmail);

  const approvedText = `Your agent has been certified - BTS Score ${btsScore} / ${creditRating}\n\nHi ${userName || 'there'},\n\n${agentName} has passed the Borealis audit and received its BTS trust certification.\n\nBTS Score: ${btsScore} / 100\nCredit Rating: ${creditRating}\n${certificateId ? `Certificate ID: ${certificateId}\n` : ''}${hederaTxId ? `Hedera anchor: ${hederaTxId}\n` : ''}\nYour score is live on the Borealis public registry.\n\nDashboard: ${dashboardUrl}\n\n- Borealis Protocol`;

  const rejectedText = `Certification not granted for ${agentName}\n\nHi ${userName || 'there'},\n\nThe MAGISTRATE audit verdict for ${agentName} was: REJECTED.\n\nScore at time of review: ${btsScore} / 100 (${creditRating})\n\n${(discrepancies ?? []).length > 0 ? `Issues identified:\n${(discrepancies ?? []).map(d => `- ${d}`).join('\n')}\n\n` : ''}To resubmit: address issues, submit fresh telemetry, then resubmit via ARBITER.\n\nDashboard: ${dashboardUrl}\n\n- Borealis Protocol`;

  if (!process.env.RESEND_API_KEY) {
    logger.info('Audit verdict email (NOT SENT — no RESEND_API_KEY)', { to: toEmail, verdict, agentName });
    return true;
  }
  try {
    const subject = verdict === 'APPROVED'
      ? `Your agent is certified - ${agentName} scored ${btsScore} (${creditRating})`
      : `Certification not granted - ${agentName}`;
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [toEmail],
      subject,
      html,
      text: verdict === 'APPROVED' ? approvedText : rejectedText,
    });
    if (result.error) { logger.error('Audit verdict email failed', { error: result.error, to: toEmail, verdict }); return false; }
    logger.info('Audit verdict email sent', { to: toEmail, verdict, agentName });
    return true;
  } catch (err: any) {
    logger.error('Audit verdict email error', { error: err.message, to: toEmail, verdict });
    return false;
  }
}

// ─── Admin: Free Key Claimed Notification ────────────────────────────────────

/**
 * Notify the platform admin when a free BTS License Key is claimed.
 */
export async function sendAdminFreeKeyNotification(
  userEmail: string,
  keyPrefix: string,
  keyId: string,
): Promise<boolean> {
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' });

  const body = `
    <h1 style="font-size:22px;font-weight:700;color:#4CAF50;margin:0 0 20px 0;">Free Key Claimed</h1>
    <p style="font-size:15px;line-height:1.7;color:#A0A0A0;margin:0 0 20px 0;">A new free-tier BTS License Key has been issued.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0C0D10;border:1px solid #2A2B33;border-radius:8px;margin-bottom:20px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="font-size:12px;font-weight:700;color:#4CAF50;text-transform:uppercase;letter-spacing:1px;margin:0 0 12px 0;">Key Details</p>
          <p style="font-size:14px;color:#C0C0C0;margin:0 0 8px 0;line-height:1.6;"><strong style="color:#CCC;">User Email:</strong> ${userEmail}</p>
          <p style="font-size:14px;color:#C0C0C0;margin:0 0 8px 0;line-height:1.6;"><strong style="color:#CCC;">Key Prefix:</strong> <span style="font-family:'Courier New',Courier,monospace;color:#D4A853;">${keyPrefix}...</span></p>
          <p style="font-size:14px;color:#C0C0C0;margin:0 0 8px 0;line-height:1.6;"><strong style="color:#CCC;">Key ID:</strong> <span style="font-family:'Courier New',Courier,monospace;font-size:12px;">${keyId}</span></p>
          <p style="font-size:14px;color:#C0C0C0;margin:0 0 8px 0;line-height:1.6;"><strong style="color:#CCC;">Tier:</strong> Free (BTS score cap: 65)</p>
          <p style="font-size:14px;color:#C0C0C0;margin:0;line-height:1.6;"><strong style="color:#CCC;">Claimed:</strong> ${timestamp}</p>
        </td>
      </tr>
    </table>
  `;

  const html = emailTemplate(body, ADMIN_EMAIL);

  const text = `Free Key Claimed\n\nUser: ${userEmail}\nKey Prefix: ${keyPrefix}...\nKey ID: ${keyId}\nTier: Free (score cap 65)\nClaimed: ${timestamp}`;

  if (!process.env.RESEND_API_KEY) {
    logger.info('Admin free key notification (NOT SENT — no RESEND_API_KEY)', { userEmail, keyPrefix });
    return true;
  }
  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [ADMIN_EMAIL],
      subject: `Free Key Claimed: ${userEmail}`,
      html,
      text,
    });
    if (result.error) { logger.error('Admin free key notification failed', { error: result.error }); return false; }
    logger.info('Admin free key notification sent', { to: ADMIN_EMAIL, userEmail });
    return true;
  } catch (err: any) {
    logger.error('Admin free key notification error', { error: err.message });
    return false;
  }
}
