import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/database';
import { requireMasterKey } from '../middleware/auth';
import { logger } from '../middleware/logger';

const router = Router();

const waitlistSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  company: z.string().optional(),
  useCase: z.string().optional(),
  agentCount: z.string().optional()
});

router.post('/', (req, res) => {
  try {
    const validated = waitlistSchema.parse(req.body);
    const db = getDb();
    const id = uuid();
    const now = Date.now();

    const source = req.query.source as string | undefined || 'website';

    const stmt = db.prepare(`
      INSERT OR IGNORE INTO waitlist (id, email, name, company, use_case, agent_count, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      id,
      validated.email,
      validated.name || null,
      validated.company || null,
      validated.useCase || null,
      validated.agentCount || null,
      source,
      now
    );

    if (result.changes === 0) {
      logger.info(`Waitlist signup (duplicate): ${validated.email}`);
      return res.json({
        success: true,
        message: 'Already registered',
        isNew: false
      });
    }

    logger.info(`Waitlist signup: ${validated.email}`);

    res.status(201).json({
      success: true,
      message: 'You\'re on the list',
      isNew: true
    });
  } catch (err) {
    logger.error('POST / error', { error: String(err) });

    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: 'Invalid request', details: err.errors });
    }

    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.get('/', requireMasterKey, (req, res) => {
  try {
    const db = getDb();

    const countStmt = db.prepare('SELECT COUNT(*) as count FROM waitlist');
    const countResult = countStmt.get() as any;

    const stmt = db.prepare(`
      SELECT id, email, name, company, use_case, agent_count, source, created_at
      FROM waitlist
      ORDER BY created_at DESC
    `);

    const entries = stmt.all() as any[];

    logger.info(`Admin retrieved ${entries.length} waitlist entries`);

    res.json({
      success: true,
      count: countResult.count,
      entries: entries.map(e => ({
        id: e.id,
        email: e.email,
        name: e.name,
        company: e.company,
        useCase: e.use_case,
        agentCount: e.agent_count,
        source: e.source,
        createdAt: e.created_at
      }))
    });
  } catch (err) {
    logger.error('GET / error', { error: String(err) });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
