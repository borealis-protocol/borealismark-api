/**
 * Direct database verification (for dev instance)
 */
import Database from 'better-sqlite3';

const dbPath = './borealismark.db';
const db = new Database(dbPath);

console.log('\n📊 Database Verification (Development Instance)\n');

// Count agents
const agentCount = db.prepare('SELECT COUNT(*) as count FROM agents WHERE public_listing = 1').get();
console.log(`✅ Public Agents: ${agentCount.count}`);

// Count certificates
const certCount = db.prepare('SELECT COUNT(*) as count FROM audit_certificates').get();
console.log(`✅ Certificates: ${certCount.count}\n`);

// List agents
console.log('Agents Table:');
const agents = db.prepare(`
  SELECT a.id, a.name, a.public_listing, ac.score_total, ac.credit_rating
  FROM agents a
  LEFT JOIN audit_certificates ac ON a.id = ac.agent_id
  ORDER BY ac.score_total DESC
`).all();

agents.forEach((a, i) => {
  console.log(`  ${i + 1}. ${a.name}`);
  console.log(`     ID: ${a.id}`);
  console.log(`     Public: ${a.public_listing === 1 ? '✓' : '✗'}`);
  console.log(`     Score: ${a.score_total || 'N/A'}/1000`);
  console.log(`     Rating: ${a.credit_rating || 'N/A'}\n`);
});

db.close();
