import { Router } from 'express';
import { getDb } from '../db/database';
import { requireAuth, AuthRequest, getUserFromToken } from '../middleware/auth';
import { logger } from '../middleware/logger';

const router = Router();

function getUserIdFromReq(req: AuthRequest): string | null {
  if (req.userId) return req.userId;

  const token = req.headers.authorization?.replace('Bearer ', '');
  return getUserFromToken(token) || null;
}

router.get('/summary', requireAuth, (req: AuthRequest, res) => {
  try {
    const userId = getUserIdFromReq(req);

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const db = getDb();

    const agentsStmt = db.prepare(`
      SELECT COUNT(*) as count FROM agents WHERE user_id = ?
    `);
    const agentsResult = agentsStmt.get(userId) as any;

    const avgScoreStmt = db.prepare(`
      SELECT AVG(bts_score) as avg_score FROM agents WHERE user_id = ? AND bts_score IS NOT NULL
    `);
    const avgScoreResult = avgScoreStmt.get(userId) as any;

    const certificationsStmt = db.prepare(`
      SELECT COUNT(*) as count FROM audit_certificates WHERE user_id = ?
    `);
    const certificationsResult = certificationsStmt.get(userId) as any;

    const lastAuditStmt = db.prepare(`
      SELECT MAX(created_at) as last_audit FROM audit_certificates WHERE user_id = ?
    `);
    const lastAuditResult = lastAuditStmt.get(userId) as any;

    const statusStmt = db.prepare(`
      SELECT status, COUNT(*) as count FROM agents WHERE user_id = ? GROUP BY status
    `);
    const statusResults = statusStmt.all(userId) as any[];

    const statusBreakdown: Record<string, number> = {};
    statusResults.forEach((row: any) => {
      statusBreakdown[row.status || 'unknown'] = row.count;
    });

    logger.info(`Dashboard summary for user ${userId}: ${agentsResult.count} agents`);

    res.json({
      success: true,
      summary: {
        totalAgents: agentsResult.count,
        averageBtsScore: avgScoreResult.avg_score ? Math.round(avgScoreResult.avg_score * 10) / 10 : null,
        certificationCount: certificationsResult.count,
        lastAuditDate: lastAuditResult.last_audit ? new Date(lastAuditResult.last_audit).toISOString() : null,
        statusBreakdown
      }
    });
  } catch (err) {
    logger.error('GET /summary error', { error: String(err) });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.get('/activity', requireAuth, (req: AuthRequest, res) => {
  try {
    const userId = getUserIdFromReq(req);

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const db = getDb();

    const agentRegistrationsStmt = db.prepare(`
      SELECT id, name, created_at FROM agents WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
    `);
    const agentRegistrations = agentRegistrationsStmt.all(userId) as any[];

    const auditCompletionsStmt = db.prepare(`
      SELECT agent_id, created_at FROM audit_certificates WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
    `);
    const auditCompletions = auditCompletionsStmt.all(userId) as any[];

    const activities: Array<{
      type: string;
      description: string;
      timestamp: string;
      agentId?: string;
      agentName?: string;
    }> = [];

    agentRegistrations.forEach((reg: any) => {
      activities.push({
        type: 'agent_registered',
        description: `Registered agent "${reg.name}"`,
        timestamp: new Date(reg.created_at).toISOString(),
        agentId: reg.id,
        agentName: reg.name
      });
    });

    auditCompletions.forEach((audit: any) => {
      activities.push({
        type: 'audit_completed',
        description: `Completed audit for agent`,
        timestamp: new Date(audit.created_at).toISOString(),
        agentId: audit.agent_id
      });
    });

    activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const limitedActivities = activities.slice(0, 20);

    logger.info(`Dashboard activity for user ${userId}: ${limitedActivities.length} events`);

    res.json({
      success: true,
      activities: limitedActivities
    });
  } catch (err) {
    logger.error('GET /activity error', { error: String(err) });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
