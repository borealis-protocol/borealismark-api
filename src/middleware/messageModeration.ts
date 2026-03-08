/**
 * Message-Level Content Moderation Enforcement
 *
 * Server-side enforcement of content policies on user messages in marketplace threads.
 * This is the real moderation layer (client-side moderation is just UX feedback).
 *
 * Features:
 *   - Pattern matching for profanity, slurs, off-platform offers, spam
 *   - Violation tracking and progressive sanctions
 *   - User mute/suspension/ban enforcement
 *   - Automatic violation escalation based on severity and count
 */

import { logger } from './logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ViolationType = 'profanity' | 'off_platform' | 'spam' | 'harassment' | 'scam' | 'slurs';
export type SeverityLevel = 'warning' | 'minor' | 'major' | 'critical';
export type SanctionStatus = 'active' | 'muted' | 'suspended' | 'banned';
export type SanctionAction = 'warning' | 'mute_24h' | 'suspend_7d' | 'permanent_ban';

export interface ModerationResult {
  clean: boolean;                    // true if no violations
  blocked: boolean;                  // true if message should not be sent
  violationType: ViolationType | null;
  severity: SeverityLevel;
  matchedPatterns: string[];         // what triggered the violation
  filteredText: string;              // text with profanity replaced
  reason?: string;                   // human-readable reason
}

// ─── Banned Patterns Database ───────────────────────────────────────────────

const BANNED_PATTERNS = {
  profanity: [
    'damn', 'hell', 'crap', 'piss', 'shit', 'fuck', 'asshole', 'bitch',
    'bastard', 'dammit', 'goddamn', 'godfuckingdamn', 'motherfucker',
  ],
  slurs: [
    // Racial slurs (CRITICAL severity)
    'n-word', 'niger', 'nigga',
    // Religious slurs
    'kike', 'heeb', 'towelhead', 'raghead',
    // Gender/sexual slurs
    'tranny', 'faggot', 'dyke', 'twat',
    // Other discrimination
    'spic', 'wetback', 'chink', 'gook',
  ],
  off_platform: [
    // Payment methods (trying to move transaction off-platform)
    'venmo', 'paypal', 'cash ?app', 'cashapp', 'zelle',
    'wire ?transfer', 'western ?union', 'gift ?card',
    'itunes ?card', 'google ?play',
    // Messaging apps
    'whatsapp', 'telegram', 'signal', 'viber',
    // Bank/financial (phishing/scam indicators)
    'bank ?account', 'routing ?number', 'swift ?code',
    'account ?number', 'send ?your ?password', 'verify ?your ?account',
    'update ?payment', 'confirm ?card',
  ],
  harassment: [
    'kill yourself', 'kys', 'go die', 'drop dead',
    'you deserve to die', 'should commit suicide',
    'threats', 'gonna hurt', 'watch your back',
  ],
  scam_patterns: [
    // Obvious patterns
    /\.+/,                           // spam dots
    /!{3,}/,                         // multiple exclamation marks 3+
    /\?{3,}/,                         // multiple question marks 3+
    /([a-z])\1{4,}/i,               // character repetition 5+ times
    /^[A-Z\s!]{20,}$/,              // all caps 20+ characters
  ],
};

// Create regex patterns for efficient matching
const COMPILED_PATTERNS = {
  profanity: BANNED_PATTERNS.profanity.map(word => ({
    pattern: new RegExp(`\\b${word}s?(?:es|ed|ing|er|ers)?\\b`, 'i'),
    word,
    severity: 'minor' as SeverityLevel,
  })),
  slurs: BANNED_PATTERNS.slurs.map(word => ({
    pattern: new RegExp(`\\b${word}s?(?:es)?\\b`, 'i'),
    word,
    severity: 'critical' as SeverityLevel,
  })),
  off_platform: BANNED_PATTERNS.off_platform.map(word => ({
    pattern: new RegExp(word, 'i'),
    word,
    severity: 'major' as SeverityLevel,
  })),
  harassment: BANNED_PATTERNS.harassment.map(word => ({
    pattern: new RegExp(`\\b${word}\\b`, 'i'),
    word,
    severity: 'major' as SeverityLevel,
  })),
};

// Regex patterns for spam detection
const SPAM_PATTERNS: Array<{ pattern: RegExp; severity: SeverityLevel }> = [
  { pattern: /(.)\1{5,}/,           severity: 'minor' },   // 6+ repeated chars
  { pattern: /^[A-Z\s!]{20,}$/,     severity: 'minor' },   // 20+ all-caps
  { pattern: /!{4,}/,               severity: 'minor' },   // 4+ exclamation marks
  { pattern: /\?{4,}/,              severity: 'minor' },   // 4+ question marks
];

// ─── Core Moderation Function ───────────────────────────────────────────────

/**
 * Server-side content moderation for messages.
 * Returns verdict on whether message should be blocked/filtered.
 */
export function moderateServerSide(text: string): ModerationResult {
  const matches: Array<{ pattern: string; type: ViolationType; severity: SeverityLevel }> = [];
  const matchedPatterns: string[] = [];
  let filteredText = text;
  let highestSeverity: SeverityLevel = 'warning';

  // Check profanity
  for (const { pattern, word, severity } of COMPILED_PATTERNS.profanity) {
    if (pattern.test(text)) {
      matches.push({ pattern: word, type: 'profanity', severity });
      matchedPatterns.push(word);
      highestSeverity = severity;
      // Replace profanity with asterisks
      filteredText = filteredText.replace(pattern, '*'.repeat(word.length));
    }
  }

  // Check slurs (CRITICAL — these block immediately)
  for (const { pattern, word, severity } of COMPILED_PATTERNS.slurs) {
    if (pattern.test(text)) {
      matches.push({ pattern: word, type: 'slurs', severity });
      matchedPatterns.push(word);
      highestSeverity = 'critical';
    }
  }

  // Check off-platform offers (MAJOR — these block immediately)
  for (const { pattern, word, severity } of COMPILED_PATTERNS.off_platform) {
    if (pattern.test(text)) {
      matches.push({ pattern: word, type: 'off_platform', severity });
      matchedPatterns.push(word);
      highestSeverity = 'major';
    }
  }

  // Check harassment
  for (const { pattern, word, severity } of COMPILED_PATTERNS.harassment) {
    if (pattern.test(text)) {
      matches.push({ pattern: word, type: 'harassment', severity });
      matchedPatterns.push(word);
      highestSeverity = 'major';
    }
  }

  // Check spam patterns
  for (const { pattern, severity } of SPAM_PATTERNS) {
    if (pattern.test(text)) {
      matches.push({ pattern: pattern.source, type: 'spam', severity });
      matchedPatterns.push(pattern.source);
      if (severity === 'major') {
        highestSeverity = 'major';
      }
    }
  }

  // Determine if message is blocked
  const blocked = highestSeverity === 'critical' || highestSeverity === 'major';
  const violationType = matches.length > 0 ? matches[0].type : null;

  return {
    clean: matches.length === 0,
    blocked,
    violationType,
    severity: highestSeverity,
    matchedPatterns: [...new Set(matchedPatterns)],
    filteredText,
    reason: matches.length > 0
      ? `Message contains ${highestSeverity} violation: ${matches[0].type}`
      : undefined,
  };
}

/**
 * Determine escalation action based on violation count and severity.
 * This implements the progressive enforcement policy.
 */
export function determineAction(
  violationCount: number,
  severity: SeverityLevel,
): SanctionAction {
  // Critical severity (slurs, certain scams): escalate faster
  if (severity === 'critical') {
    if (violationCount === 1) return 'mute_24h';
    if (violationCount === 2) return 'suspend_7d';
    if (violationCount >= 3) return 'permanent_ban';
  }

  // Major severity (off-platform, harassment): second-fastest escalation
  if (severity === 'major') {
    if (violationCount === 1) return 'warning';
    if (violationCount <= 3) return 'warning';
    if (violationCount === 4) return 'mute_24h';
    if (violationCount <= 6) return 'mute_24h';
    if (violationCount === 7) return 'suspend_7d';
    if (violationCount >= 8) return 'permanent_ban';
  }

  // Minor severity (profanity, spam): slowest escalation
  if (violationCount === 1) return 'warning';
  if (violationCount <= 3) return 'warning';
  if (violationCount === 4) return 'mute_24h';
  if (violationCount <= 6) return 'mute_24h';
  if (violationCount === 7) return 'suspend_7d';
  if (violationCount >= 8) return 'permanent_ban';

  return 'warning';
}

/**
 * Convert sanction action to enforcement parameters.
 */
export function actionToSanctionParams(action: SanctionAction): {
  status: SanctionStatus;
  mutedUntil: number | null;
  suspendedUntil: number | null;
} {
  const now = Date.now();

  switch (action) {
    case 'warning':
      return { status: 'active', mutedUntil: null, suspendedUntil: null };
    case 'mute_24h':
      return {
        status: 'muted',
        mutedUntil: now + 24 * 60 * 60 * 1000,
        suspendedUntil: null,
      };
    case 'suspend_7d':
      return {
        status: 'suspended',
        mutedUntil: null,
        suspendedUntil: now + 7 * 24 * 60 * 60 * 1000,
      };
    case 'permanent_ban':
      return {
        status: 'banned',
        mutedUntil: null,
        suspendedUntil: null,
      };
  }
}

// ─── Format Helpers ─────────────────────────────────────────────────────────

export function formatSanctionStatus(status: SanctionStatus, expiredAt?: number): string {
  if (status === 'muted' && expiredAt) {
    const date = new Date(expiredAt);
    return `muted until ${date.toLocaleString()}`;
  }
  if (status === 'suspended' && expiredAt) {
    const date = new Date(expiredAt);
    return `suspended until ${date.toLocaleString()}`;
  }
  if (status === 'banned') {
    return 'permanently banned';
  }
  return 'active';
}
