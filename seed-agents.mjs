/**
 * Seed Script for BorealisMark Demo Agents
 * Uses ESM to load better-sqlite3
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, createHash } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, 'borealismark.db');

console.log('📍 Database path:', dbPath);

const db = new Database(dbPath);

// Tier mapping from display score to credit rating
const getTierAndRating = (displayScore) => {
  if (displayScore >= 90) return { tier: 'Platinum', rating: 'AAA' };
  if (displayScore >= 80) return { tier: 'Gold', rating: 'AA' };
  if (displayScore >= 70) return { tier: 'Silver', rating: 'A' };
  if (displayScore >= 60) return { tier: 'Bronze', rating: 'BBB' };
  if (displayScore >= 50) return { tier: 'Bronze', rating: 'BB' };
  return { tier: 'Unverified', rating: 'B' };
};

// Demo agents data from Session 60 Recovery Directive
const agents = [
  {
    name: 'SentinelGuard AI',
    description: 'Enterprise-grade AI security monitor',
    bmScore: 927,
    displayScore: 92.7,
  },
  {
    name: 'CodeReview Pro',
    description: 'Automated code quality and security analysis',
    bmScore: 873,
    displayScore: 87.3,
  },
  {
    name: 'DataFlow Assistant',
    description: 'Intelligent data pipeline orchestration',
    bmScore: 785,
    displayScore: 78.5,
  },
  {
    name: 'ComplianceBot',
    description: 'Regulatory compliance monitoring',
    bmScore: 712,
    displayScore: 71.2,
  },
  {
    name: 'ChatSupport AI',
    description: 'Customer service automation',
    bmScore: 658,
    displayScore: 65.8,
  },
  {
    name: 'TranslateEngine',
    description: 'Multi-language document translation',
    bmScore: 524,
    displayScore: 52.4,
  },
  {
    name: 'TaskRunner Beta',
    description: 'Experimental task automation (beta)',
    bmScore: 389,
    displayScore: 38.9,
  },
];

// Helper functions
function generateHash() {
  return randomBytes(32).toString('hex');
}

function generateAgentId() {
  return `agent_${randomBytes(10).toString('hex')}`;
}

function generateCertificateId() {
  return `BMK-${Date.now()}-${randomBytes(8).toString('hex').slice(0, 8)}`;
}

function generateAuditId() {
  return `audit_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

console.log('\n🌌 BorealisMark Demo Agent Seeder');
console.log('==================================\n');

try {
  const createdAgents = [];
  const now = Date.now();

  for (const agent of agents) {
    const agentId = generateAgentId();
    const certificateId = generateCertificateId();
    const auditId = generateAuditId();
    const { tier, rating } = getTierAndRating(agent.displayScore);

    console.log(`📦 Creating agent: ${agent.name}`);
    console.log(`   ID: ${agentId}`);
    console.log(`   Score: ${agent.displayScore}/100 (${agent.bmScore}/1000)`);
    console.log(`   Tier: ${tier} (${rating})`);

    // 1. Insert agent
    db.prepare(
      `INSERT INTO agents
       (id, name, description, version, registered_at, registrant_key_id, active, public_listing)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      agentId,
      agent.name,
      agent.description,
      '1.0.0',
      now,
      'admin-seed',
      1,
      1  // public_listing = true
    );

    // 2. Insert certificate with score
    const scoreJson = JSON.stringify({
      total: agent.bmScore,
      constraints: {
        boundary: Math.round(agent.bmScore * 0.95),
        injection: Math.round(agent.bmScore * 0.92),
        dataHandling: Math.round(agent.bmScore * 0.90),
        reasoning: Math.round(agent.bmScore * 0.88),
      },
      anomalies: Math.round(100 - agent.bmScore * 0.1),
    });

    db.prepare(
      `INSERT INTO audit_certificates
       (certificate_id, agent_id, agent_version, audit_id, issued_at,
        audit_period_start, audit_period_end, score_total, score_json,
        credit_rating, input_hash, certificate_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      certificateId,
      agentId,
      '1.0.0',
      auditId,
      now,
      now - 30 * 24 * 60 * 60 * 1000,  // 30 days ago
      now,
      agent.bmScore,
      scoreJson,
      rating,
      generateHash(),
      generateHash()
    );

    createdAgents.push({
      agentId,
      name: agent.name,
      score: agent.displayScore,
      tier,
      certificateId,
    });

    console.log(`   ✓ Created with certificate ${certificateId}\n`);
  }

  console.log('✅ All 7 agents seeded successfully!\n');
  console.log('Created Agents Summary:');
  console.log('=======================');
  createdAgents.forEach((a, i) => {
    console.log(`${i + 1}. ${a.name}`);
    console.log(`   Agent ID:     ${a.agentId}`);
    console.log(`   Score:        ${a.score}/100`);
    console.log(`   Tier:         ${a.tier}`);
    console.log(`   Certificate:  ${a.certificateId}\n`);
  });

  // Verify public agents
  const publicAgents = db.prepare(
    `SELECT a.id, a.name, ac.score_total, ac.credit_rating
     FROM agents a
     LEFT JOIN audit_certificates ac ON a.id = ac.agent_id
     WHERE a.public_listing = 1 AND a.active = 1
     ORDER BY ac.score_total DESC`
  ).all();

  console.log(`📊 Public Agents Verification: ${publicAgents.length} agents visible`);
  publicAgents.forEach((a) => {
    console.log(`   - ${a.name}: ${a.score_total}/1000 (${a.credit_rating})`);
  });

  console.log('\n✨ Database seeding complete! Ready for API verification.');
  console.log('\nNext steps:');
  console.log('  1. Verify with GET /v1/agents/public');
  console.log('  2. Check individual scores with GET /v1/agents/:id/score');
  console.log('  3. Get certificates with GET /v1/agents/:id/certificate\n');

} catch (err) {
  console.error('❌ Error during seeding:', err.message);
  console.error(err.stack);
  process.exit(1);
} finally {
  db.close();
}
