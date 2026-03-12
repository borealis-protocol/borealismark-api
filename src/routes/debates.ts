/**
 * Debates API Routes
 *
 * Public:
 *   GET  /v1/debates/latest     — Get the current featured debate
 *   GET  /v1/debates/:id        — Get a specific debate by ID
 *   GET  /v1/debates            — List recent debates
 *
 * Admin (requires API master key):
 *   POST /v1/debates/ingest     — Trigger RSS feed ingestion
 *   POST /v1/debates/generate   — Trigger debate generation from sources
 *   POST /v1/debates/seed       — Directly insert a pre-generated debate
 *   GET  /v1/debates/sources    — List ingested source articles
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  getLatestDebate,
  getDebateById,
  listDebates,
  listDebateSources,
  insertDebate,
  clearFeaturedDebates,
  getUnusedSources,
  markSourceUsed,
} from '../db/database';
import { ingestRSSFeeds, generateDebate } from '../services/debateEngine';

const router = Router();

// ─── Admin Auth Middleware ────────────────────────────────────────────────────

function requireMasterKey(req: Request, res: Response, next: Function) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key || key !== process.env.API_MASTER_KEY) {
    return res.status(401).json({ error: 'Unauthorized — master key required' });
  }
  next();
}

// ─── Public Endpoints ────────────────────────────────────────────────────────

/**
 * GET /v1/debates/latest
 * Returns the current featured debate for the Academy frontend
 */
router.get('/latest', (_req: Request, res: Response) => {
  try {
    const debate = getLatestDebate();
    if (!debate) {
      return res.json({
        ok: true,
        debate: null,
        message: 'No featured debate available yet',
      });
    }

    res.json({
      ok: true,
      debate: {
        id: debate.id,
        topic: debate.topic,
        question: debate.question,
        summary: debate.summary,
        source: {
          url: debate.source_url,
          name: debate.source_name,
          title: debate.source_title,
        },
        exchanges: debate.exchanges,
        published_at: debate.published_at,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch debate', detail: err.message });
  }
});

/**
 * GET /v1/debates/sources
 * List ingested source articles (admin view)
 * NOTE: Must be registered BEFORE /:id to avoid route conflict
 */
router.get('/sources', requireMasterKey as any, (_req: Request, res: Response) => {
  try {
    const sources = listDebateSources(20);
    res.json({ ok: true, sources, count: sources.length });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list sources', detail: err.message });
  }
});

/**
 * GET /v1/debates/:id
 * Returns a specific debate by ID
 */
router.get('/:id', (req: Request, res: Response) => {
  try {
    const debate = getDebateById(req.params.id);
    if (!debate) {
      return res.status(404).json({ error: 'Debate not found' });
    }

    res.json({
      ok: true,
      debate: {
        id: debate.id,
        topic: debate.topic,
        question: debate.question,
        summary: debate.summary,
        source: {
          url: debate.source_url,
          name: debate.source_name,
          title: debate.source_title,
        },
        exchanges: debate.exchanges,
        published_at: debate.published_at,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch debate', detail: err.message });
  }
});

/**
 * GET /v1/debates
 * List recent debates (paginated)
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const offset = parseInt(req.query.offset as string) || 0;
    const debates = listDebates(limit, offset);

    res.json({ ok: true, debates, count: debates.length });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list debates', detail: err.message });
  }
});

// ─── Admin Endpoints ─────────────────────────────────────────────────────────

/**
 * POST /v1/debates/ingest
 * Triggers RSS feed ingestion from all configured sources
 */
router.post('/ingest', requireMasterKey, async (_req: Request, res: Response) => {
  try {
    const result = await ingestRSSFeeds();
    res.json({
      ok: true,
      message: `Ingested ${result.new_articles} new articles from ${result.total} total`,
      ...result,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'RSS ingestion failed', detail: err.message });
  }
});

/**
 * POST /v1/debates/generate
 * Generates a new debate from the most recent unused source article
 */
router.post('/generate', requireMasterKey, async (req: Request, res: Response) => {
  try {
    const sourceId = req.body?.source_id;
    const result = await generateDebate(sourceId);

    if (!result.success) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    res.json({
      ok: true,
      message: 'Debate generated successfully',
      debate_id: result.debate_id,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Debate generation failed', detail: err.message });
  }
});

/**
 * POST /v1/debates/seed
 * Directly insert a pre-generated debate (bypasses Claude API)
 * Useful when API credits are unavailable or for manual curation
 *
 * Body: {
 *   source_id?: string,         — Optional: link to an ingested source article
 *   source_url: string,
 *   source_name: string,
 *   source_title: string,
 *   question: string,
 *   topic: string,
 *   summary: string,
 *   exchanges: Array<{team, name, argument, citation}>
 * }
 */
router.post('/seed', requireMasterKey, (req: Request, res: Response) => {
  try {
    const { source_id, source_url, source_name, source_title, question, topic, summary, exchanges } = req.body;

    if (!question || !exchanges || !Array.isArray(exchanges) || exchanges.length === 0) {
      return res.status(400).json({ ok: false, error: 'Missing required fields: question, exchanges[]' });
    }

    if (!source_url || !source_name || !source_title) {
      return res.status(400).json({ ok: false, error: 'Missing required fields: source_url, source_name, source_title' });
    }

    const debateId = uuidv4();

    // Clear previous featured debate and set new one
    clearFeaturedDebates();

    insertDebate({
      id: debateId,
      topic: topic || 'AI',
      question,
      summary: summary || null,
      source_article_id: source_id || null,
      source_url,
      source_name,
      source_title,
      exchanges,
      status: 'published',
      published: 1,
      featured: 1,
    });

    // If a source_id was provided, mark it as used
    if (source_id) {
      try { markSourceUsed(source_id); } catch (_e) { /* ignore if source doesn't exist */ }
    }

    res.json({
      ok: true,
      message: 'Debate seeded successfully',
      debate_id: debateId,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to seed debate', detail: err.message });
  }
});

export default router;
