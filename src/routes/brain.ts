/**
 * Borealis Brain - Route Module
 *
 * The knowledge graph that lives inside Mission Control.
 * 15 endpoints. 7 pillars. Every star in the constellation
 * passes through this file.
 *
 * Auth: JWT (user notes) or API key (agent notes).
 * Security: Every query scoped by user_id. No exceptions.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database';
import { requireAuth } from './auth';
import type { AuthRequest } from './auth';
import { requireApiKey, requireScope } from '../middleware/auth';
import type { AuthenticatedRequest } from '../middleware/auth';
import { logger } from '../middleware/logger';

const router = Router();

// ─── Constants ───────────────────────────────────────────────────────────────

const VALID_PILLARS = [
  'mission', 'intelligence', 'fleet',
  'projects', 'network', 'knowledge', 'directives',
] as const;

type Pillar = typeof VALID_PILLARS[number];

const SEED_PILLARS: { pillar: Pillar; title: string }[] = [
  { pillar: 'mission',      title: 'My Mission'   },
  { pillar: 'intelligence', title: 'Intelligence'  },
  { pillar: 'fleet',        title: 'Fleet'         },
  { pillar: 'projects',     title: 'Projects'      },
  { pillar: 'network',      title: 'Network'       },
  { pillar: 'knowledge',    title: 'Knowledge'     },
  { pillar: 'directives',   title: 'Directives'    },
];

const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 50000;
const MAX_TAG_LENGTH = 50;
const MAX_TAGS_PER_NOTE = 50;
const MAX_SEARCH_RESULTS = 50;
const MAX_IMPORT_NOTES = 500;
const AGENT_DAILY_LIMIT = 100;

// ─── Validation Schemas ──────────────────────────────────────────────────────

const CreateNoteSchema = z.object({
  pillar: z.enum(VALID_PILLARS),
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  body: z.string().max(MAX_BODY_LENGTH).optional().default(''),
  tags: z.array(z.string().max(MAX_TAG_LENGTH)).max(MAX_TAGS_PER_NOTE).optional().default([]),
  // Agent-only fields
  created_by_type: z.enum(['user', 'agent']).optional(),
  created_by_id: z.string().optional(),
});

const UpdateNoteSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
  body: z.string().max(MAX_BODY_LENGTH).optional(),
  pillar: z.enum(VALID_PILLARS).optional(),
  tags: z.array(z.string().max(MAX_TAG_LENGTH)).max(MAX_TAGS_PER_NOTE).optional(),
});

const CreateLinkSchema = z.object({
  source_note_id: z.string().uuid(),
  target_note_id: z.string().uuid(),
});

const AddTagsSchema = z.object({
  tags: z.array(z.string().max(MAX_TAG_LENGTH)).min(1).max(MAX_TAGS_PER_NOTE),
});

const ImportSchema = z.object({
  notes: z.array(z.object({
    pillar: z.enum(VALID_PILLARS).optional().default('knowledge'),
    title: z.string().min(1).max(MAX_TITLE_LENGTH),
    body: z.string().max(MAX_BODY_LENGTH).optional().default(''),
    tags: z.array(z.string().max(MAX_TAG_LENGTH)).optional().default([]),
    links_to: z.array(z.string()).optional().default([]),
  })).max(MAX_IMPORT_NOTES),
});

// ─── Rate Limit State (in-memory, per agent key) ────────────────────────────

const agentRateLimits = new Map<string, { count: number; resetAt: number }>();

function checkAgentRateLimit(agentKeyId: string): boolean {
  const now = Date.now();
  const entry = agentRateLimits.get(agentKeyId);

  if (!entry || now > entry.resetAt) {
    agentRateLimits.set(agentKeyId, { count: 1, resetAt: now + 86400000 }); // 24h window
    return true;
  }

  if (entry.count >= AGENT_DAILY_LIMIT) {
    return false;
  }

  entry.count++;
  return true;
}

// ─── Seed Behavior ───────────────────────────────────────────────────────────

function ensureBrainSeeded(userId: string): void {
  const db = getDb();
  const existing = db.prepare(
    'SELECT COUNT(*) as count FROM brain_notes WHERE user_id = ?'
  ).get(userId) as { count: number };

  if (existing.count > 0) return;

  const insert = db.prepare(`
    INSERT INTO brain_notes (id, user_id, pillar, title, body, created_by_type, created_by_id, is_pillar_root)
    VALUES (?, ?, ?, ?, '', 'system', 'borealis', 1)
  `);

  const seedAll = db.transaction(() => {
    for (const p of SEED_PILLARS) {
      insert.run(uuidv4(), userId, p.pillar, p.title);
    }
  });

  seedAll();
  logger.info('Brain seeded for user', { userId, pillars: 7 });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getUserId(req: Request): string {
  return (req as AuthRequest).user?.sub as string;
}

function getTagsForNote(db: ReturnType<typeof getDb>, noteId: string): string[] {
  const rows = db.prepare(
    'SELECT tag FROM brain_tags WHERE note_id = ?'
  ).all(noteId) as { tag: string }[];
  return rows.map(r => r.tag);
}

function getLinkCount(db: ReturnType<typeof getDb>, noteId: string): number {
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM brain_links WHERE source_note_id = ? OR target_note_id = ?'
  ).get(noteId, noteId) as { count: number };
  return row.count;
}

function insertTags(db: ReturnType<typeof getDb>, noteId: string, tags: string[]): void {
  const insertTag = db.prepare(
    'INSERT OR IGNORE INTO brain_tags (id, note_id, tag) VALUES (?, ?, ?)'
  );
  for (const tag of tags) {
    const cleaned = tag.toLowerCase().trim();
    if (cleaned.length > 0 && cleaned.length <= MAX_TAG_LENGTH) {
      insertTag.run(uuidv4(), noteId, cleaned);
    }
  }
}

function replaceTags(db: ReturnType<typeof getDb>, noteId: string, tags: string[]): void {
  db.prepare('DELETE FROM brain_tags WHERE note_id = ?').run(noteId);
  insertTags(db, noteId, tags);
}

function brainError(res: Response, code: string, message: string, status: number): void {
  res.status(status).json({
    success: false,
    error: message,
    code,
    timestamp: Date.now(),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOTES CRUD
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /notes - All notes for the authenticated user ──────────────────────

router.get('/notes', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    ensureBrainSeeded(userId);
    const db = getDb();

    const notes = db.prepare(`
      SELECT id, pillar, title, body, created_by_type, created_by_id,
             is_pillar_root, created_at, updated_at
      FROM brain_notes WHERE user_id = ?
      ORDER BY updated_at DESC
    `).all(userId) as any[];

    const enriched = notes.map(note => ({
      ...note,
      is_pillar_root: !!note.is_pillar_root,
      tags: getTagsForNote(db, note.id),
      link_count: getLinkCount(db, note.id),
    }));

    res.json({
      success: true,
      data: { notes: enriched, total: enriched.length },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    logger.error('Brain: failed to fetch notes', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch notes', timestamp: Date.now() });
  }
});

// ─── GET /notes/:id - Single note with links ───────────────────────────────

router.get('/notes/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const db = getDb();

    const note = db.prepare(
      'SELECT * FROM brain_notes WHERE id = ? AND user_id = ?'
    ).get(req.params.id, userId) as any;

    if (!note) {
      return brainError(res, 'BRAIN_NOTE_NOT_FOUND', 'Note not found', 404);
    }

    const outgoing = db.prepare(`
      SELECT bl.id as link_id, bn.id as note_id, bn.title, bn.pillar
      FROM brain_links bl
      JOIN brain_notes bn ON bl.target_note_id = bn.id
      WHERE bl.source_note_id = ?
    `).all(note.id) as any[];

    const incoming = db.prepare(`
      SELECT bl.id as link_id, bn.id as note_id, bn.title, bn.pillar
      FROM brain_links bl
      JOIN brain_notes bn ON bl.source_note_id = bn.id
      WHERE bl.target_note_id = ?
    `).all(note.id) as any[];

    res.json({
      success: true,
      data: {
        note: {
          ...note,
          is_pillar_root: !!note.is_pillar_root,
          tags: getTagsForNote(db, note.id),
        },
        links: { outgoing, incoming },
      },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    logger.error('Brain: failed to fetch note', { error: err.message, noteId: req.params.id });
    res.status(500).json({ success: false, error: 'Failed to fetch note', timestamp: Date.now() });
  }
});

// ─── GET /pillar/:pillar - Notes filtered by pillar ─────────────────────────

router.get('/pillar/:pillar', requireAuth, (req: Request, res: Response) => {
  try {
    const pillar = req.params.pillar as Pillar;
    if (!VALID_PILLARS.includes(pillar)) {
      return brainError(res, 'BRAIN_INVALID_PILLAR', `Invalid pillar: ${pillar}. Must be one of: ${VALID_PILLARS.join(', ')}`, 400);
    }

    const userId = getUserId(req);
    ensureBrainSeeded(userId);
    const db = getDb();

    const notes = db.prepare(`
      SELECT id, pillar, title, body, created_by_type, created_by_id,
             is_pillar_root, created_at, updated_at
      FROM brain_notes WHERE user_id = ? AND pillar = ?
      ORDER BY updated_at DESC
    `).all(userId, pillar) as any[];

    const enriched = notes.map(note => ({
      ...note,
      is_pillar_root: !!note.is_pillar_root,
      tags: getTagsForNote(db, note.id),
      link_count: getLinkCount(db, note.id),
    }));

    res.json({
      success: true,
      data: { notes: enriched, total: enriched.length, pillar },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    logger.error('Brain: failed to fetch pillar', { error: err.message, pillar: req.params.pillar });
    res.status(500).json({ success: false, error: 'Failed to fetch pillar notes', timestamp: Date.now() });
  }
});

// ─── POST /notes - Create a note ────────────────────────────────────────────

router.post('/notes', requireAuth, (req: Request, res: Response) => {
  try {
    const parsed = CreateNoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return brainError(res, 'BRAIN_VALIDATION_ERROR', parsed.error.errors.map(e => e.message).join(', '), 400);
    }

    const userId = getUserId(req);
    ensureBrainSeeded(userId);
    const db = getDb();

    const { pillar, title, body, tags } = parsed.data;
    const noteId = uuidv4();

    db.prepare(`
      INSERT INTO brain_notes (id, user_id, pillar, title, body, created_by_type, created_by_id, is_pillar_root)
      VALUES (?, ?, ?, ?, ?, 'user', ?, 0)
    `).run(noteId, userId, pillar, title, body, userId);

    if (tags.length > 0) {
      insertTags(db, noteId, tags);
    }

    const created = db.prepare('SELECT * FROM brain_notes WHERE id = ?').get(noteId) as any;

    res.status(201).json({
      success: true,
      data: {
        note: {
          ...created,
          is_pillar_root: false,
          tags: getTagsForNote(db, noteId),
        },
      },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    logger.error('Brain: failed to create note', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to create note', timestamp: Date.now() });
  }
});

// ─── POST /notes/agent - Agent creates a note (API key auth) ────────────────

router.post('/notes/agent', requireApiKey, requireScope('write'), (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;

    // Rate limit check
    if (!checkAgentRateLimit(authReq.apiKey.id)) {
      res.setHeader('Retry-After', '86400');
      return brainError(res, 'BRAIN_RATE_LIMIT', 'Agent rate limit exceeded - 100 notes per 24 hours', 429);
    }

    const parsed = CreateNoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return brainError(res, 'BRAIN_VALIDATION_ERROR', parsed.error.errors.map(e => e.message).join(', '), 400);
    }

    const { pillar, title, body, tags, created_by_type, created_by_id } = parsed.data;

    if (created_by_type !== 'agent' || !created_by_id) {
      return brainError(res, 'BRAIN_VALIDATION_ERROR', 'Agent notes require created_by_type: "agent" and created_by_id', 400);
    }

    // Look up the agent to verify ownership
    const db = getDb();
    const agent = db.prepare(
      'SELECT id, registrant_key_id, owner_user_id FROM agents WHERE id = ?'
    ).get(created_by_id) as any;

    if (!agent) {
      return brainError(res, 'BRAIN_AGENT_NOT_FOUND', 'Agent not found', 404);
    }

    // Verify the API key matches the agent's registrant key
    if (agent.registrant_key_id !== authReq.apiKey.id) {
      return brainError(res, 'BRAIN_UNAUTHORIZED', 'API key does not own this agent', 403);
    }

    if (!agent.owner_user_id) {
      return brainError(res, 'BRAIN_UNAUTHORIZED', 'Agent has no owner - cannot write to Brain', 403);
    }

    const userId = agent.owner_user_id as string;
    ensureBrainSeeded(userId);

    const noteId = uuidv4();
    db.prepare(`
      INSERT INTO brain_notes (id, user_id, pillar, title, body, created_by_type, created_by_id, is_pillar_root)
      VALUES (?, ?, ?, ?, ?, 'agent', ?, 0)
    `).run(noteId, userId, pillar, title, body, created_by_id);

    if (tags.length > 0) {
      insertTags(db, noteId, tags);
    }

    const created = db.prepare('SELECT * FROM brain_notes WHERE id = ?').get(noteId) as any;

    logger.info('Brain: agent created note', { noteId, agentId: created_by_id, pillar, userId });

    res.status(201).json({
      success: true,
      data: {
        note: {
          ...created,
          is_pillar_root: false,
          tags: getTagsForNote(db, noteId),
        },
      },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    logger.error('Brain: agent failed to create note', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to create agent note', timestamp: Date.now() });
  }
});

// ─── PUT /notes/:id - Update a note ────────────────────────────────────────

router.put('/notes/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const parsed = UpdateNoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return brainError(res, 'BRAIN_VALIDATION_ERROR', parsed.error.errors.map(e => e.message).join(', '), 400);
    }

    const userId = getUserId(req);
    const db = getDb();

    const note = db.prepare(
      'SELECT * FROM brain_notes WHERE id = ? AND user_id = ?'
    ).get(req.params.id, userId) as any;

    if (!note) {
      return brainError(res, 'BRAIN_NOTE_NOT_FOUND', 'Note not found', 404);
    }

    const { title, body, pillar, tags } = parsed.data;

    // Pillar roots: only body is editable
    if (note.is_pillar_root) {
      if (title || pillar) {
        return brainError(res, 'BRAIN_CANNOT_DELETE_ROOT', 'Pillar root notes can only have their body edited', 403);
      }
      if (body !== undefined) {
        db.prepare(
          'UPDATE brain_notes SET body = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(body, note.id);
      }
    } else {
      // Regular notes: update all provided fields
      const updates: string[] = [];
      const params: any[] = [];

      if (title !== undefined) { updates.push('title = ?'); params.push(title); }
      if (body !== undefined) { updates.push('body = ?'); params.push(body); }
      if (pillar !== undefined) { updates.push('pillar = ?'); params.push(pillar); }

      if (updates.length > 0) {
        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(note.id);
        db.prepare(`UPDATE brain_notes SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      }
    }

    // Handle tags replacement if provided
    if (tags !== undefined) {
      replaceTags(db, note.id, tags);
    }

    const updated = db.prepare('SELECT * FROM brain_notes WHERE id = ?').get(note.id) as any;

    res.json({
      success: true,
      data: {
        note: {
          ...updated,
          is_pillar_root: !!updated.is_pillar_root,
          tags: getTagsForNote(db, note.id),
        },
      },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    logger.error('Brain: failed to update note', { error: err.message, noteId: req.params.id });
    res.status(500).json({ success: false, error: 'Failed to update note', timestamp: Date.now() });
  }
});

// ─── DELETE /notes/:id - Delete a note ──────────────────────────────────────

router.delete('/notes/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const db = getDb();

    const note = db.prepare(
      'SELECT id, is_pillar_root FROM brain_notes WHERE id = ? AND user_id = ?'
    ).get(req.params.id, userId) as any;

    if (!note) {
      return brainError(res, 'BRAIN_NOTE_NOT_FOUND', 'Note not found', 404);
    }

    if (note.is_pillar_root) {
      return brainError(res, 'BRAIN_CANNOT_DELETE_ROOT', 'Pillar root notes cannot be deleted - the seven stars never go out', 403);
    }

    // CASCADE handles links and tags
    db.prepare('DELETE FROM brain_notes WHERE id = ?').run(note.id);

    res.status(204).send();
  } catch (err: any) {
    logger.error('Brain: failed to delete note', { error: err.message, noteId: req.params.id });
    res.status(500).json({ success: false, error: 'Failed to delete note', timestamp: Date.now() });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// LINKS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── POST /links - Create a connection ──────────────────────────────────────

router.post('/links', requireAuth, (req: Request, res: Response) => {
  try {
    const parsed = CreateLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      return brainError(res, 'BRAIN_VALIDATION_ERROR', parsed.error.errors.map(e => e.message).join(', '), 400);
    }

    const { source_note_id, target_note_id } = parsed.data;

    if (source_note_id === target_note_id) {
      return brainError(res, 'BRAIN_SELF_LINK', 'A note cannot link to itself', 400);
    }

    const userId = getUserId(req);
    const db = getDb();

    // Verify both notes belong to the user
    const sourceNote = db.prepare(
      'SELECT id FROM brain_notes WHERE id = ? AND user_id = ?'
    ).get(source_note_id, userId);
    const targetNote = db.prepare(
      'SELECT id FROM brain_notes WHERE id = ? AND user_id = ?'
    ).get(target_note_id, userId);

    if (!sourceNote || !targetNote) {
      return brainError(res, 'BRAIN_NOTE_NOT_FOUND', 'One or both notes not found', 404);
    }

    const linkId = uuidv4();
    try {
      db.prepare(
        'INSERT INTO brain_links (id, source_note_id, target_note_id, created_by) VALUES (?, ?, ?, ?)'
      ).run(linkId, source_note_id, target_note_id, 'user');
    } catch (e: any) {
      if (e.message?.includes('UNIQUE constraint failed')) {
        return brainError(res, 'BRAIN_DUPLICATE_LINK', 'This connection already exists', 409);
      }
      throw e;
    }

    res.status(201).json({
      success: true,
      data: { link: { id: linkId, source_note_id, target_note_id, created_by: 'user' } },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    logger.error('Brain: failed to create link', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to create link', timestamp: Date.now() });
  }
});

// ─── DELETE /links/:id - Delete a connection ────────────────────────────────

router.delete('/links/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const db = getDb();

    // Verify the link belongs to the user (through note ownership)
    const link = db.prepare(`
      SELECT bl.id FROM brain_links bl
      JOIN brain_notes bn ON bl.source_note_id = bn.id
      WHERE bl.id = ? AND bn.user_id = ?
    `).get(req.params.id, userId) as any;

    if (!link) {
      return brainError(res, 'BRAIN_NOTE_NOT_FOUND', 'Link not found', 404);
    }

    db.prepare('DELETE FROM brain_links WHERE id = ?').run(req.params.id);
    res.status(204).send();
  } catch (err: any) {
    logger.error('Brain: failed to delete link', { error: err.message, linkId: req.params.id });
    res.status(500).json({ success: false, error: 'Failed to delete link', timestamp: Date.now() });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TAGS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── POST /notes/:id/tags - Add tags to a note ─────────────────────────────

router.post('/notes/:id/tags', requireAuth, (req: Request, res: Response) => {
  try {
    const parsed = AddTagsSchema.safeParse(req.body);
    if (!parsed.success) {
      return brainError(res, 'BRAIN_VALIDATION_ERROR', parsed.error.errors.map(e => e.message).join(', '), 400);
    }

    const userId = getUserId(req);
    const db = getDb();

    const note = db.prepare(
      'SELECT id FROM brain_notes WHERE id = ? AND user_id = ?'
    ).get(req.params.id, userId);

    if (!note) {
      return brainError(res, 'BRAIN_NOTE_NOT_FOUND', 'Note not found', 404);
    }

    insertTags(db, req.params.id, parsed.data.tags);

    res.json({
      success: true,
      data: { tags: getTagsForNote(db, req.params.id) },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    logger.error('Brain: failed to add tags', { error: err.message, noteId: req.params.id });
    res.status(500).json({ success: false, error: 'Failed to add tags', timestamp: Date.now() });
  }
});

// ─── DELETE /tags/:id - Remove a tag ────────────────────────────────────────

router.delete('/tags/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const db = getDb();

    // Verify tag ownership through note
    const tag = db.prepare(`
      SELECT bt.id FROM brain_tags bt
      JOIN brain_notes bn ON bt.note_id = bn.id
      WHERE bt.id = ? AND bn.user_id = ?
    `).get(req.params.id, userId) as any;

    if (!tag) {
      return brainError(res, 'BRAIN_NOTE_NOT_FOUND', 'Tag not found', 404);
    }

    db.prepare('DELETE FROM brain_tags WHERE id = ?').run(req.params.id);
    res.status(204).send();
  } catch (err: any) {
    logger.error('Brain: failed to delete tag', { error: err.message, tagId: req.params.id });
    res.status(500).json({ success: false, error: 'Failed to delete tag', timestamp: Date.now() });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GRAPH - The constellation endpoint for D3.js
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/graph', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    ensureBrainSeeded(userId);
    const db = getDb();

    // Fetch all nodes with body_preview (first 100 chars)
    const notes = db.prepare(`
      SELECT id, pillar, title,
             SUBSTR(body, 1, 100) as body_preview,
             created_by_type, created_by_id,
             is_pillar_root, created_at, updated_at
      FROM brain_notes WHERE user_id = ?
    `).all(userId) as any[];

    // Build nodes with tags and link counts
    const nodes = notes.map(note => ({
      ...note,
      is_pillar_root: !!note.is_pillar_root,
      tags: getTagsForNote(db, note.id),
      link_count: getLinkCount(db, note.id),
    }));

    // Fetch all links between this user's notes
    // D3 expects "source" and "target" field names
    const links = db.prepare(`
      SELECT bl.id, bl.source_note_id as source, bl.target_note_id as target, bl.created_by
      FROM brain_links bl
      JOIN brain_notes bn ON bl.source_note_id = bn.id
      WHERE bn.user_id = ?
    `).all(userId) as any[];

    // Stats
    const byPillar: Record<string, number> = {};
    const byCreator: Record<string, number> = {};
    for (const n of notes) {
      byPillar[n.pillar] = (byPillar[n.pillar] || 0) + 1;
      byCreator[n.created_by_type] = (byCreator[n.created_by_type] || 0) + 1;
    }

    res.json({
      success: true,
      data: {
        nodes,
        links,
        stats: {
          total_notes: notes.length,
          total_links: links.length,
          by_pillar: byPillar,
          by_creator: byCreator,
        },
      },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    logger.error('Brain: failed to fetch graph', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch graph', timestamp: Date.now() });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/search', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const q = (req.query.q as string || '').trim();

    if (!q) {
      return res.json({ success: true, data: { notes: [], total: 0, query: '' }, timestamp: Date.now() });
    }

    const db = getDb();
    const pattern = `%${q}%`;

    // Search title, body, and tags - ranked by match location
    const titleMatches = db.prepare(`
      SELECT DISTINCT bn.id, bn.pillar, bn.title, SUBSTR(bn.body, 1, 100) as body_preview,
             bn.created_by_type, bn.created_by_id, bn.is_pillar_root, bn.created_at, bn.updated_at,
             1 as relevance
      FROM brain_notes bn
      WHERE bn.user_id = ? AND bn.title LIKE ?
    `).all(userId, pattern) as any[];

    const tagMatches = db.prepare(`
      SELECT DISTINCT bn.id, bn.pillar, bn.title, SUBSTR(bn.body, 1, 100) as body_preview,
             bn.created_by_type, bn.created_by_id, bn.is_pillar_root, bn.created_at, bn.updated_at,
             2 as relevance
      FROM brain_notes bn
      JOIN brain_tags bt ON bn.id = bt.note_id
      WHERE bn.user_id = ? AND bt.tag LIKE ?
    `).all(userId, pattern) as any[];

    const bodyMatches = db.prepare(`
      SELECT DISTINCT bn.id, bn.pillar, bn.title, SUBSTR(bn.body, 1, 100) as body_preview,
             bn.created_by_type, bn.created_by_id, bn.is_pillar_root, bn.created_at, bn.updated_at,
             3 as relevance
      FROM brain_notes bn
      WHERE bn.user_id = ? AND bn.body LIKE ?
    `).all(userId, pattern) as any[];

    // Merge and deduplicate, keeping best relevance
    const seen = new Map<string, any>();
    for (const matches of [titleMatches, tagMatches, bodyMatches]) {
      for (const m of matches) {
        if (!seen.has(m.id)) {
          seen.set(m.id, {
            ...m,
            is_pillar_root: !!m.is_pillar_root,
            tags: getTagsForNote(db, m.id),
            link_count: getLinkCount(db, m.id),
          });
        }
      }
    }

    const results = Array.from(seen.values()).slice(0, MAX_SEARCH_RESULTS);

    res.json({
      success: true,
      data: { notes: results, total: results.length, query: q },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    logger.error('Brain: search failed', { error: err.message });
    res.status(500).json({ success: false, error: 'Search failed', timestamp: Date.now() });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT / IMPORT
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /export - Full Brain as JSON ───────────────────────────────────────

router.get('/export', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const db = getDb();

    const notes = db.prepare(
      'SELECT * FROM brain_notes WHERE user_id = ? ORDER BY pillar, title'
    ).all(userId) as any[];

    const enriched = notes.map(note => {
      const tags = getTagsForNote(db, note.id);

      // Get linked note IDs
      const outLinks = db.prepare(
        'SELECT target_note_id FROM brain_links WHERE source_note_id = ?'
      ).all(note.id) as { target_note_id: string }[];
      const inLinks = db.prepare(
        'SELECT source_note_id FROM brain_links WHERE target_note_id = ?'
      ).all(note.id) as { source_note_id: string }[];

      const links_to = [
        ...outLinks.map(l => l.target_note_id),
        ...inLinks.map(l => l.source_note_id),
      ];

      return {
        id: note.id,
        pillar: note.pillar,
        title: note.title,
        body: note.body,
        created_by_type: note.created_by_type,
        created_by_id: note.created_by_id,
        is_pillar_root: !!note.is_pillar_root,
        tags,
        links_to: [...new Set(links_to)],
        created_at: note.created_at,
        updated_at: note.updated_at,
      };
    });

    res.json({
      success: true,
      data: {
        exported_at: new Date().toISOString(),
        user_id: userId,
        notes: enriched,
      },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    logger.error('Brain: export failed', { error: err.message });
    res.status(500).json({ success: false, error: 'Export failed', timestamp: Date.now() });
  }
});

// ─── POST /import - Import notes from JSON ──────────────────────────────────

router.post('/import', requireAuth, (req: Request, res: Response) => {
  try {
    const parsed = ImportSchema.safeParse(req.body);
    if (!parsed.success) {
      return brainError(res, 'BRAIN_IMPORT_TOO_LARGE', parsed.error.errors.map(e => e.message).join(', '), 400);
    }

    const userId = getUserId(req);
    ensureBrainSeeded(userId);
    const db = getDb();

    const { notes: importNotes } = parsed.data;
    const titleToId = new Map<string, string>();
    const createdIds: string[] = [];

    const doImport = db.transaction(() => {
      // Pass 1: create all notes
      for (const note of importNotes) {
        const noteId = uuidv4();
        db.prepare(`
          INSERT INTO brain_notes (id, user_id, pillar, title, body, created_by_type, created_by_id, is_pillar_root)
          VALUES (?, ?, ?, ?, ?, 'user', ?, 0)
        `).run(noteId, userId, note.pillar, note.title, note.body, userId);

        if (note.tags.length > 0) {
          insertTags(db, noteId, note.tags);
        }

        titleToId.set(note.title.toLowerCase(), noteId);
        createdIds.push(noteId);
      }

      // Pass 2: recreate links by matching titles
      for (const note of importNotes) {
        const sourceId = titleToId.get(note.title.toLowerCase());
        if (!sourceId) continue;

        for (const linkTitle of note.links_to) {
          const targetId = titleToId.get(linkTitle.toLowerCase());
          if (targetId && targetId !== sourceId) {
            try {
              db.prepare(
                'INSERT INTO brain_links (id, source_note_id, target_note_id, created_by) VALUES (?, ?, ?, ?)'
              ).run(uuidv4(), sourceId, targetId, 'user');
            } catch {
              // Duplicate link - skip silently
            }
          }
        }
      }
    });

    doImport();

    res.status(201).json({
      success: true,
      data: { imported: createdIds.length, note_ids: createdIds },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    logger.error('Brain: import failed', { error: err.message });
    res.status(500).json({ success: false, error: 'Import failed', timestamp: Date.now() });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/stats', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    ensureBrainSeeded(userId);
    const db = getDb();

    const totalNotes = (db.prepare(
      'SELECT COUNT(*) as count FROM brain_notes WHERE user_id = ?'
    ).get(userId) as { count: number }).count;

    const totalLinks = (db.prepare(`
      SELECT COUNT(*) as count FROM brain_links bl
      JOIN brain_notes bn ON bl.source_note_id = bn.id
      WHERE bn.user_id = ?
    `).get(userId) as { count: number }).count;

    const pillarCounts = db.prepare(`
      SELECT pillar, COUNT(*) as count FROM brain_notes WHERE user_id = ? GROUP BY pillar
    `).all(userId) as { pillar: string; count: number }[];

    const creatorCounts = db.prepare(`
      SELECT created_by_type, COUNT(*) as count FROM brain_notes WHERE user_id = ? GROUP BY created_by_type
    `).all(userId) as { created_by_type: string; count: number }[];

    const latestActivity = db.prepare(
      'SELECT MAX(updated_at) as latest FROM brain_notes WHERE user_id = ?'
    ).get(userId) as { latest: string | null };

    const byPillar: Record<string, number> = {};
    for (const p of pillarCounts) byPillar[p.pillar] = p.count;

    const byCreator: Record<string, number> = {};
    for (const c of creatorCounts) byCreator[c.created_by_type] = c.count;

    res.json({
      success: true,
      data: {
        total_notes: totalNotes,
        total_links: totalLinks,
        by_pillar: byPillar,
        by_creator: byCreator,
        latest_activity: latestActivity.latest,
      },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    logger.error('Brain: stats failed', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch stats', timestamp: Date.now() });
  }
});

export default router;
