/**
 * Claude Command Bridge - Cloud API
 *
 * Lightweight message bridge between Mission Control and Claude Cowork sessions.
 * Messages stored in SQLite so both MC (browser) and Cowork (filesystem) can access.
 *
 *   GET   /v1/claude/messages     - Retrieve all messages
 *   POST  /v1/claude/messages     - Send a message (from MC or Claude)
 *   DELETE /v1/claude/messages     - Clear all messages
 *   GET   /v1/claude/permissions  - Get current permissions
 *   POST  /v1/claude/permissions  - Update permissions
 */

import { Router, type Request, type Response } from 'express';
import { getDb } from '../middleware/database';

const router = Router();

// Ensure table exists on first use
let tableReady = false;
function ensureTable() {
  if (tableReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS claude_messages (
      id TEXT PRIMARY KEY,
      sender TEXT NOT NULL DEFAULT 'simon',
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS claude_permissions (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  tableReady = true;
}

// GET /messages - retrieve all messages
router.get('/messages', (_req: Request, res: Response) => {
  try {
    ensureTable();
    const db = getDb();
    const messages = db.prepare('SELECT * FROM claude_messages ORDER BY created_at ASC').all();
    const permsRows = db.prepare('SELECT key, value FROM claude_permissions').all() as Array<{key: string, value: number}>;
    const permissions: Record<string, boolean> = {};
    for (const row of permsRows) {
      permissions[row.key] = row.value === 1;
    }
    res.json({ messages, permissions });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /messages - send a message
router.post('/messages', (req: Request, res: Response) => {
  try {
    ensureTable();
    const db = getDb();
    const { id, content, from, status } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });

    const msgId = id || 'msg-' + Date.now();
    const sender = from || 'simon';
    const msgStatus = status || 'pending';

    db.prepare(
      'INSERT OR REPLACE INTO claude_messages (id, sender, content, status, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))'
    ).run(msgId, sender, content, msgStatus);

    // If Claude is responding, mark pending simon messages as read
    if (sender === 'claude') {
      db.prepare("UPDATE claude_messages SET status = 'read' WHERE sender = 'simon' AND status = 'pending'").run();
    }

    res.json({ ok: true, id: msgId });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /messages - clear all messages
router.delete('/messages', (_req: Request, res: Response) => {
  try {
    ensureTable();
    const db = getDb();
    db.prepare('DELETE FROM claude_messages').run();
    res.json({ ok: true, cleared: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /permissions - get permissions
router.get('/permissions', (_req: Request, res: Response) => {
  try {
    ensureTable();
    const db = getDb();
    const rows = db.prepare('SELECT key, value FROM claude_permissions').all() as Array<{key: string, value: number}>;
    const permissions: Record<string, boolean> = {};
    for (const row of rows) {
      permissions[row.key] = row.value === 1;
    }
    res.json(permissions);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /permissions - update permissions
router.post('/permissions', (req: Request, res: Response) => {
  try {
    ensureTable();
    const db = getDb();
    const perms = req.body;
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO claude_permissions (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))'
    );
    for (const [key, val] of Object.entries(perms)) {
      if (typeof val === 'boolean') {
        stmt.run(key, val ? 1 : 0);
      }
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
