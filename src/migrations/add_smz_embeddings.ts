/**
 * Migration: SMZ Phase 1 - Embedding Foundation
 *
 * Adds vector embedding columns to brain_notes for Semantic Magnetism.
 * Every note becomes a point in 1536-dimensional space. Proximity = meaning.
 * Distance = difference. The Zettelkasten links itself.
 *
 * Run via: npx ts-node src/migrations/add_smz_embeddings.ts
 * Or on Render Shell: node -e "require('./dist/migrations/add_smz_embeddings.js')"
 */

import Database from 'better-sqlite3';
import path from 'path';

const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'borealismark.db');

console.log(`[SMZ Migration] Opening database at: ${dbPath}`);
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const migrate = db.transaction(() => {
  // Check which columns already exist to make migration idempotent
  const tableInfo = db.prepare("PRAGMA table_info(brain_notes)").all() as any[];
  const existingColumns = new Set(tableInfo.map((col: any) => col.name));

  if (!existingColumns.has('embedding')) {
    db.exec(`ALTER TABLE brain_notes ADD COLUMN embedding BLOB`);
    console.log('[SMZ Migration] Added embedding BLOB column');
  } else {
    console.log('[SMZ Migration] embedding column already exists - skipping');
  }

  if (!existingColumns.has('embedding_model')) {
    db.exec(`ALTER TABLE brain_notes ADD COLUMN embedding_model TEXT`);
    console.log('[SMZ Migration] Added embedding_model TEXT column');
  } else {
    console.log('[SMZ Migration] embedding_model column already exists - skipping');
  }

  if (!existingColumns.has('embedded_at')) {
    db.exec(`ALTER TABLE brain_notes ADD COLUMN embedded_at DATETIME`);
    console.log('[SMZ Migration] Added embedded_at DATETIME column');
  } else {
    console.log('[SMZ Migration] embedded_at column already exists - skipping');
  }

  // Index for finding un-embedded notes (batch processing)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_brain_notes_embedded
    ON brain_notes(embedded_at)
    WHERE embedded_at IS NULL;
  `);
  console.log('[SMZ Migration] Created partial index for un-embedded notes');

  // SMZ similarity cache - precomputed pairwise similarities
  // Avoids recomputing cosine similarity on every query
  db.exec(`
    CREATE TABLE IF NOT EXISTS smz_similarities (
      note_a_id TEXT NOT NULL,
      note_b_id TEXT NOT NULL,
      similarity REAL NOT NULL,
      tier TEXT NOT NULL CHECK(tier IN ('primary', 'secondary', 'ambient')),
      computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (note_a_id, note_b_id),
      FOREIGN KEY (note_a_id) REFERENCES brain_notes(id) ON DELETE CASCADE,
      FOREIGN KEY (note_b_id) REFERENCES brain_notes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_smz_sim_note_a ON smz_similarities(note_a_id, tier);
    CREATE INDEX IF NOT EXISTS idx_smz_sim_note_b ON smz_similarities(note_b_id, tier);
    CREATE INDEX IF NOT EXISTS idx_smz_sim_tier ON smz_similarities(tier);
  `);
  console.log('[SMZ Migration] Created smz_similarities cache table');
});

try {
  migrate();
  console.log('[SMZ Migration] Phase 1 embedding foundation complete.');
} catch (err) {
  console.error('[SMZ Migration] FAILED:', err);
  process.exit(1);
} finally {
  db.close();
}
