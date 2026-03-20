/**
 * BorealisMark — PUBLIC Agent Verification API (No Auth Required)
 *
 * This module provides public-facing agent verification endpoints and embeddable badges.
 * No authentication required — agents can be verified and displayed anywhere.
 *
 * GET  /v1/verify/:agentId        — Get agent verification status and metadata
 * GET  /v1/verify/:agentId/badge.svg  — Get SVG badge for embedding
 * GET  /v1/verify/:agentId/badge.js   — Get JavaScript embed snippet
 */

import { Router, Request, Response } from 'express';
import { logger } from '../middleware/logger';
import { getAgent, getLatestCertificate } from '../db/database';

const router = Router();

/**
 * Determine tier based on BorealisMark Score (bmScore)
 * Tier logic:
 * - 90+: "platinum"
 * - 75-89: "gold"
 * - 60-74: "silver"
 * - 40-59: "bronze"
 * - Below 40 or no score: "unverified"
 */
function getTierFromScore(bmScore: number): string {
  if (bmScore >= 90) return 'platinum';
  if (bmScore >= 75) return 'gold';
  if (bmScore >= 60) return 'silver';
  if (bmScore >= 40) return 'bronze';
  return 'unverified';
}

/**
 * Get tier color for SVG badge (hex codes)
 */
function getTierColor(tier: string): string {
  const colors: Record<string, string> = {
    platinum: '#E5E4E2',  // Light silver-gray for platinum
    gold: '#FFD700',      // Gold
    silver: '#C0C0C0',    // Silver
    bronze: '#CD7F32',    // Bronze
  };
  return colors[tier] || '#9CA3AF'; // Default gray for unverified
}

/**
 * Generate unverified/error badge SVG
 */
function generateUnverifiedBadge(): string {
  const width = 200;
  const height = 36;
  const radius = 6;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="background-color: transparent;">
  <rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" fill="#f3f4f6" stroke="#9CA3AF" stroke-width="1"/>
  <text x="10" y="24" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="600" fill="#374151">
    Not Verified
  </text>
  <text x="140" y="24" font-family="system-ui, -apple-system, sans-serif" font-size="10" font-weight="500" fill="#6B7280" text-anchor="end">
    0/100
  </text>
</svg>`;
}

/**
 * Generate verified badge SVG with tier and score
 */
function generateVerifiedBadge(tier: string, bmScore: number): string {
  const width = 220;
  const height = 40;
  const radius = 6;
  const leftWidth = 140;
  const rightWidth = width - leftWidth;

  const tierColor = getTierColor(tier);
  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="background-color: transparent;">
  <!-- DISCLAIMER: This badge represents an independent algorithmic assessment by Borealis Protocol. It does not constitute regulatory certification, EU AI Act conformity assessment, or any government-recognized endorsement. See https://borealisprotocol.ai/terms for full terms. -->
  <!-- Left section (Borealis Certified) -->
  <rect x="0" y="0" width="${leftWidth}" height="${height}" rx="${radius}" fill="#001f3f" stroke="#e5e7eb" stroke-width="1"/>

  <!-- Shield icon / checkmark -->
  <g transform="translate(14, 10)">
    <circle cx="0" cy="0" r="8" fill="#10b981" stroke="white" stroke-width="1"/>
    <path d="M -2 0 L 0 2 L 3 -1" stroke="white" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </g>

  <!-- Left text -->
  <text x="30" y="27" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="700" fill="white">
    Borealis
  </text>

  <!-- Right section (Tier) -->
  <rect x="${leftWidth}" y="0" width="${rightWidth}" height="${height}" rx="${radius}" fill="${tierColor}" stroke="#e5e7eb" stroke-width="1"/>

  <!-- Tier text -->
  <text x="${leftWidth + rightWidth/2}" y="27" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="700" fill="#000" text-anchor="middle">
    ${tierLabel}
  </text>

  <!-- Score display (bottom right) -->
  <text x="${width - 8}" y="37" font-family="system-ui, -apple-system, sans-serif" font-size="9" font-weight="600" fill="#000" text-anchor="end" opacity="0.8">
    ${Math.round(bmScore)}/100
  </text>
</svg>`;
}

/**
 * GET /v1/verify/:agentId
 * PUBLIC verification endpoint — no auth required
 * Returns agent verification status, certification, and badge URLs
 */
router.get('/:agentId', (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;

    // Look up agent
    const agent = getAgent(agentId);
    if (!agent) {
      return res.status(404).json({ verified: false, error: 'Agent not found' });
    }

    // Get latest certificate
    const cert = getLatestCertificate(agentId);
    if (!cert) {
      return res.status(404).json({ verified: false, error: 'Agent not certified' });
    }

    // Parse score from certificate (raw is 0-1000, normalize to 0-100 for BM Score)
    const rawScore = (cert.score_total as number) || 0;
    const bmScore = Math.round((rawScore / 10) * 10) / 10; // One decimal place
    const tier = getTierFromScore(bmScore);

    const apiBaseUrl = process.env.API_BASE_URL || 'https://borealismark-api.onrender.com';

    const response = {
      verified: true,
      agentId,
      agentName: agent.name as string || 'Unknown',
      certificationStatus: 'certified',
      bmScore,
      tier,
      certifiedAt: new Date((cert.issued_at as number) || Date.now()).toISOString(),
      lastAuditAt: new Date((cert.issued_at as number) || Date.now()).toISOString(),
      badge: {
        imageUrl: `${apiBaseUrl}/v1/verify/${agentId}/badge.svg`,
        embedSnippet: `<script src="${apiBaseUrl}/v1/verify/${agentId}/badge.js"><\/script>`,
      },
      disclaimer: 'This is an independent algorithmic assessment. It does not constitute regulatory certification, EU AI Act conformity assessment, or any government-recognized endorsement. See https://borealisprotocol.ai/terms for full terms.',
    };

    res.json(response);
  } catch (err: any) {
    logger.error('Verification endpoint error', { error: err.message });
    res.status(500).json({ verified: false, error: 'Internal server error' });
  }
});

/**
 * GET /v1/verify/:agentId/badge.svg
 * PUBLIC SVG badge endpoint — returns inline SVG badge image
 * No auth required
 */
router.get('/:agentId/badge.svg', (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;

    // Look up agent and certificate
    const agent = getAgent(agentId);
    if (!agent) {
      // Return unverified badge
      return res.header('Content-Type', 'image/svg+xml').send(generateUnverifiedBadge());
    }

    const cert = getLatestCertificate(agentId);
    if (!cert) {
      return res.header('Content-Type', 'image/svg+xml').send(generateUnverifiedBadge());
    }

    // Generate verified badge with tier (normalize 0-1000 → 0-100)
    const rawScore = (cert.score_total as number) || 0;
    const bmScore = Math.round((rawScore / 10) * 10) / 10;
    const tier = getTierFromScore(bmScore);
    const svg = generateVerifiedBadge(tier, bmScore);

    res.header('Content-Type', 'image/svg+xml');
    res.header('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
    res.send(svg);
  } catch (err: any) {
    logger.error('Badge SVG error', { error: err.message });
    // Return error badge
    res.header('Content-Type', 'image/svg+xml').send(generateUnverifiedBadge());
  }
});

/**
 * GET /v1/verify/:agentId/badge.js
 * PUBLIC JavaScript embed snippet — returns JS that embeds the badge
 * No auth required
 */
router.get('/:agentId/badge.js', (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;
    const apiBaseUrl = process.env.API_BASE_URL || 'https://borealismark-api.onrender.com';

    // Generate JavaScript embed snippet
    const script = `(function() {
  var a = document.createElement('a');
  a.href = 'https://borealismark.com/verify/${agentId}';
  a.target = '_blank';
  a.style.display = 'inline-block';
  a.title = 'Borealis Certified';
  var img = document.createElement('img');
  img.src = '${apiBaseUrl}/v1/verify/${agentId}/badge.svg';
  img.alt = 'Borealis Certified';
  img.style.height = '36px';
  img.style.border = 'none';
  img.style.verticalAlign = 'middle';
  a.appendChild(img);
  var script = document.currentScript;
  if (script && script.parentNode) {
    script.parentNode.insertBefore(a, script);
  }
})();`;

    res.header('Content-Type', 'application/javascript');
    res.header('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
    res.header('Access-Control-Allow-Origin', '*'); // Allow cross-origin
    res.send(script);
  } catch (err: any) {
    logger.error('Badge JS error', { error: err.message });
    res.status(500).json({ error: 'Failed to generate badge script' });
  }
});

export default router;
