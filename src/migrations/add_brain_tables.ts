/**
 * Migration: Add Borealis Brain Tables
 *
 * Creates the 4 tables that power the Brain - the knowledge graph
 * inside Mission Control. Every note is a star. Every link is a
 * luminous thread. Every pillar is a point in Ursa Minor.
 *
 * Run via: npx ts-node src/migrations/add_brain_tables.ts
 * Or on Render Shell: node -e "require('./dist/migrations/add_brain_tables.js')"
 */

import Database from 'better-sqlite3';
import path from 'path';

const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'borealismark.db');

console.log(`[Brain Migration] Opening database at: ${dbPath}`);
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const migrate = db.transaction(() => {
  // Table 1: brain_notes - the stars
  db.exec(`
    CREATE TABLE IF NOT EXISTS brain_notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      pillar TEXT NOT NULL CHECK(pillar IN (
        'mission', 'intelligence', 'fleet',
        'projects', 'network', 'knowledge', 'directives'
      )),
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      created_by_type TEXT NOT NULL CHECK(created_by_type IN ('user', 'agent', 'system')),
      created_by_id TEXT NOT NULL,
      is_pillar_root INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_brain_notes_user ON brain_notes(user_id);
    CREATE INDEX IF NOT EXISTS idx_brain_notes_user_pillar ON brain_notes(user_id, pillar);
    CREATE INDEX IF NOT EXISTS idx_brain_notes_creator ON brain_notes(created_by_type, created_by_id);
  `);
  console.log('[Brain Migration] brain_notes table created');

  // Table 2: brain_links - the luminous threads
  db.exec(`
    CREATE TABLE IF NOT EXISTS brain_links (
      id TEXT PRIMARY KEY,
      source_note_id TEXT NOT NULL,
      target_note_id TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_note_id, target_note_id),
      FOREIGN KEY (source_note_id) REFERENCES brain_notes(id) ON DELETE CASCADE,
      FOREIGN KEY (target_note_id) REFERENCES brain_notes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_brain_links_source ON brain_links(source_note_id);
    CREATE INDEX IF NOT EXISTS idx_brain_links_target ON brain_links(target_note_id);
  `);
  console.log('[Brain Migration] brain_links table created');

  // Table 3: brain_tags - for search and auto-linking
  db.exec(`
    CREATE TABLE IF NOT EXISTS brain_tags (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      UNIQUE(note_id, tag),
      FOREIGN KEY (note_id) REFERENCES brain_notes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_brain_tags_note ON brain_tags(note_id);
    CREATE INDEX IF NOT EXISTS idx_brain_tags_tag ON brain_tags(tag);
  `);
  console.log('[Brain Migration] brain_tags table created');

  // Table 4: brain_shares - for Enterprise collaboration (schema only, not active yet)
  db.exec(`
    CREATE TABLE IF NOT EXISTS brain_shares (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      shared_by_user_id TEXT NOT NULL,
      shared_with_user_id TEXT NOT NULL,
      permission TEXT NOT NULL DEFAULT 'read' CHECK(permission IN ('read', 'write')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (note_id) REFERENCES brain_notes(id) ON DELETE CASCADE
    );
  `);
  console.log('[Brain Migration] brain_shares table created');
});

try {
  migrate();
  console.log('[Brain Migration] All 4 tables created successfully.');
} catch (err) {
  console.error('[Brain Migration] FAILED:', err);
  process.exit(1);
} finally {
  db.close();
}
