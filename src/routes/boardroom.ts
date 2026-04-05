import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/database';
import { AuthRequest, getUserFromToken } from '../middleware/auth';
import { logger } from '../middleware/logger';

const router = Router();

const boardSchema = z.object({
  title: z.string().optional(),
  data: z.any().optional(),
  isPublic: z.boolean().optional()
});

const updateBoardSchema = z.object({
  title: z.string().optional(),
  data: z.any().optional(),
  isPublic: z.boolean().optional()
});

function generateShareToken(): string {
  return Math.random().toString(16).substr(2, 8);
}

function getUserIdFromReq(req: AuthRequest): string | null {
  if (req.userId) return req.userId;

  const token = req.headers.authorization?.replace('Bearer ', '');
  return getUserFromToken(token) || null;
}

router.post('/', (req: AuthRequest, res) => {
  try {
    const validated = boardSchema.parse(req.body);
    const db = getDb();
    const id = uuid();
    const shareToken = generateShareToken();
    const now = Date.now();

    const userId = getUserIdFromReq(req);

    const data = validated.data ? JSON.stringify(validated.data) : '{}';

    const stmt = db.prepare(`
      INSERT INTO boardroom_boards (id, user_id, title, data, is_public, share_token, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      userId || null,
      validated.title || 'Untitled Board',
      data,
      validated.isPublic ? 1 : 0,
      shareToken,
      now,
      now
    );

    logger.info(`Created board ${id}${userId ? ` for user ${userId}` : ' (guest)'}`);

    res.status(201).json({
      success: true,
      board: {
        id,
        userId: userId || null,
        title: validated.title || 'Untitled Board',
        data: validated.data || {},
        isPublic: validated.isPublic || false,
        shareToken,
        createdAt: now,
        updatedAt: now
      }
    });
  } catch (err) {
    logger.error('POST / error', err);

    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: 'Invalid request', details: err.errors });
    }

    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.get('/', (req: AuthRequest, res) => {
  try {
    const userId = getUserIdFromReq(req);

    const db = getDb();

    if (!userId) {
      logger.info('Returning empty boards list for unauthenticated user');
      return res.json({
        success: true,
        boards: []
      });
    }

    const stmt = db.prepare(`
      SELECT id, user_id, title, data, is_public, share_token, created_at, updated_at
      FROM boardroom_boards
      WHERE user_id = ?
      ORDER BY updated_at DESC
    `);

    const boards = stmt.all(userId) as any[];

    logger.info(`Retrieved ${boards.length} boards for user ${userId}`);

    res.json({
      success: true,
      boards: boards.map(b => ({
        id: b.id,
        userId: b.user_id,
        title: b.title,
        data: JSON.parse(b.data || '{}'),
        isPublic: b.is_public === 1,
        shareToken: b.share_token,
        createdAt: b.created_at,
        updatedAt: b.updated_at
      }))
    });
  } catch (err) {
    logger.error('GET / error', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.get('/:id', (req: AuthRequest, res) => {
  try {
    const db = getDb();
    const userId = getUserIdFromReq(req);

    let board;

    const stmt = db.prepare(`
      SELECT id, user_id, title, data, is_public, share_token, created_at, updated_at
      FROM boardroom_boards
      WHERE id = ? OR share_token = ?
    `);

    board = stmt.get(req.params.id, req.params.id) as any;

    if (!board) {
      return res.status(404).json({ success: false, error: 'Board not found' });
    }

    if (board.is_public === 0 && board.user_id !== userId) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    logger.info(`Retrieved board ${req.params.id}`);

    res.json({
      success: true,
      board: {
        id: board.id,
        userId: board.user_id,
        title: board.title,
        data: JSON.parse(board.data || '{}'),
        isPublic: board.is_public === 1,
        shareToken: board.share_token,
        createdAt: board.created_at,
        updatedAt: board.updated_at
      }
    });
  } catch (err) {
    logger.error('GET /:id error', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.put('/:id', (req: AuthRequest, res) => {
  try {
    const validated = updateBoardSchema.parse(req.body);
    const db = getDb();
    const userId = getUserIdFromReq(req);

    const getStmt = db.prepare('SELECT user_id FROM boardroom_boards WHERE id = ?');
    const board = getStmt.get(req.params.id) as any;

    if (!board) {
      return res.status(404).json({ success: false, error: 'Board not found' });
    }

    if (board.user_id !== userId) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const now = Date.now();
    const updates: string[] = [];
    const params: any[] = [];

    if (validated.title !== undefined) {
      updates.push('title = ?');
      params.push(validated.title);
    }

    if (validated.data !== undefined) {
      updates.push('data = ?');
      params.push(JSON.stringify(validated.data));
    }

    if (validated.isPublic !== undefined) {
      updates.push('is_public = ?');
      params.push(validated.isPublic ? 1 : 0);
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No updates provided' });
    }

    updates.push('updated_at = ?');
    params.push(now);
    params.push(req.params.id);

    const updateStmt = db.prepare(`
      UPDATE boardroom_boards
      SET ${updates.join(', ')}
      WHERE id = ?
    `);

    updateStmt.run(...params);

    const refreshStmt = db.prepare(`
      SELECT id, user_id, title, data, is_public, share_token, created_at, updated_at
      FROM boardroom_boards
      WHERE id = ?
    `);

    const updatedBoard = refreshStmt.get(req.params.id) as any;

    logger.info(`Updated board ${req.params.id}`);

    res.json({
      success: true,
      board: {
        id: updatedBoard.id,
        userId: updatedBoard.user_id,
        title: updatedBoard.title,
        data: JSON.parse(updatedBoard.data || '{}'),
        isPublic: updatedBoard.is_public === 1,
        shareToken: updatedBoard.share_token,
        createdAt: updatedBoard.created_at,
        updatedAt: updatedBoard.updated_at
      }
    });
  } catch (err) {
    logger.error('PUT /:id error', err);

    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: 'Invalid request', details: err.errors });
    }

    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
