/**
 * SMZ Embedding Utility
 *
 * Fire-and-forget embedding generation for brain notes.
 * Called from brain.ts on note creation. Silently fails - embedding
 * can always be retried via /v1/orion/embed or /v1/orion/embed/batch.
 */

import { getDb } from '../db/database';
import { logger } from '../middleware/logger';

const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const TIER_PRIMARY = 0.85;
const TIER_SECONDARY = 0.60;
const TIER_AMBIENT = 0.40;

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function bufferToEmbedding(buffer: Buffer): Float32Array {
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Float32Array(ab);
}

function classifyTier(similarity: number): string | null {
  if (similarity >= TIER_PRIMARY) return 'primary';
  if (similarity >= TIER_SECONDARY) return 'secondary';
  if (similarity >= TIER_AMBIENT) return 'ambient';
  return null;
}

async function generateEmbedding(text: string): Promise<Float32Array> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured');

  const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://borealisprotocol.ai',
      'X-Title': 'Borealis Protocol - SMZ'
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text.slice(0, 32000)
    })
  });

  if (!response.ok) {
    throw new Error(`Embedding API error: ${response.status}`);
  }

  const data = await response.json() as any;
  const arr = data?.data?.[0]?.embedding;
  if (!arr || !Array.isArray(arr)) throw new Error('Invalid embedding response');
  return new Float32Array(arr);
}

/**
 * Fire-and-forget: embed a note and compute similarities.
 * Call after note creation. Never throws to caller.
 */
export function embedNoteAsync(noteId: string, userId: string): void {
  // Intentionally not awaited - runs in background
  (async () => {
    try {
      const db = getDb();
      const note = db.prepare(
        'SELECT id, title, body FROM brain_notes WHERE id = ? AND user_id = ?'
      ).get(noteId, userId) as any;

      if (!note) return;

      const text = `${note.title}\n\n${note.body}`.trim();
      if (text.length < 3) return;

      const embedding = await generateEmbedding(text);
      const buffer = embeddingToBuffer(embedding);

      db.prepare(`
        UPDATE brain_notes
        SET embedding = ?, embedding_model = ?, embedded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(buffer, EMBEDDING_MODEL, noteId);

      // Compute pairwise similarities
      const others = db.prepare(`
        SELECT id, embedding FROM brain_notes
        WHERE user_id = ? AND id != ? AND embedding IS NOT NULL
      `).all(userId, noteId) as any[];

      if (others.length > 0) {
        const upsert = db.prepare(`
          INSERT INTO smz_similarities (note_a_id, note_b_id, similarity, tier, computed_at)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(note_a_id, note_b_id) DO UPDATE SET
            similarity = excluded.similarity, tier = excluded.tier, computed_at = excluded.computed_at
        `);

        const tx = db.transaction(() => {
          for (const other of others) {
            const otherEmb = bufferToEmbedding(other.embedding);
            const sim = cosineSimilarity(embedding, otherEmb);
            const tier = classifyTier(sim);
            if (tier) {
              upsert.run(noteId, other.id, sim, tier);
              upsert.run(other.id, noteId, sim, tier);
            }
          }
        });
        tx();
      }

      logger.info(`SMZ: Background embedded note ${noteId} (${text.length} chars)`);
    } catch (err: any) {
      logger.warn(`SMZ: Background embed failed for ${noteId}: ${err.message}`);
      // Silent failure - note can be re-embedded later via /v1/orion/embed
    }
  })();
}
