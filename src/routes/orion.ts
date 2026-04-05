import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/database';
import { requireAuth, AuthRequest, getUserFromToken } from '../middleware/auth';
import { logger } from '../middleware/logger';

const router = Router();

const contextSchema = z.object({
  key: z.string().min(1),
  value: z.string()
});

const conversationSchema = z.object({
  title: z.string().optional()
});

const messageSchema = z.object({
  conversationId: z.string(),
  content: z.string().min(1)
});

function getUserIdFromReq(req: AuthRequest): string | null {
  if (req.userId) return req.userId;

  const token = req.headers.authorization?.replace('Bearer ', '');
  return getUserFromToken(token) || null;
}

async function callOpenRouter(
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    logger.error('OPENROUTER_API_KEY not configured');
    throw new Error('AI service not configured');
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://borealisprotocol.ai',
        'X-Title': 'Borealis Protocol'
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4',
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages
        ],
        temperature: 0.7,
        max_tokens: 1024
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      logger.error('OpenRouter API error', errorData);

      if (response.status === 429 || response.status === 503) {
        const fallbackResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://borealisprotocol.ai',
            'X-Title': 'Borealis Protocol'
          },
          body: JSON.stringify({
            model: 'google/gemini-2.0-flash-001',
            messages: [
              { role: 'system', content: systemPrompt },
              ...messages
            ],
            temperature: 0.7,
            max_tokens: 1024
          })
        });

        if (!fallbackResponse.ok) {
          throw new Error('All AI models unavailable');
        }

        const fallbackData = await fallbackResponse.json();
        return fallbackData.choices[0]?.message?.content || 'I am Orion, your AI partner in Borealis Protocol.';
      }

      throw new Error('OpenRouter API error: ' + response.statusText);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || 'I am Orion, your AI partner in Borealis Protocol.';
  } catch (err) {
    logger.error('OpenRouter call failed', { error: String(err) });
    throw err;
  }
}

router.post('/context', requireAuth, (req: AuthRequest, res) => {
  try {
    const userId = getUserIdFromReq(req);

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const validated = contextSchema.parse(req.body);
    const db = getDb();
    const contextId = uuid();
    const now = Date.now();

    const stmt = db.prepare(`
      INSERT INTO orion_context (id, user_id, key, value, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);

    stmt.run(contextId, userId, validated.key, validated.value, now);

    logger.info(`Orion context saved for user ${userId}: ${validated.key}`);

    res.json({
      success: true,
      context: {
        id: contextId,
        userId,
        key: validated.key,
        value: validated.value,
        updatedAt: now
      }
    });
  } catch (err) {
    logger.error('POST /context error', { error: String(err) });

    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: 'Invalid request', details: err.errors });
    }

    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.get('/context', requireAuth, (req: AuthRequest, res) => {
  try {
    const userId = getUserIdFromReq(req);

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const db = getDb();
    const key = req.query.key as string | undefined;

    let stmt;
    let contexts;

    if (key) {
      stmt = db.prepare('SELECT * FROM orion_context WHERE user_id = ? AND key = ?');
      contexts = stmt.all(userId, key);
    } else {
      stmt = db.prepare('SELECT * FROM orion_context WHERE user_id = ?');
      contexts = stmt.all(userId);
    }

    logger.info(`Retrieved ${contexts.length} context items for user ${userId}`);

    res.json({
      success: true,
      contexts: contexts.map((c: any) => ({
        id: c.id,
        key: c.key,
        value: c.value,
        updatedAt: c.updated_at
      }))
    });
  } catch (err) {
    logger.error('GET /context error', { error: String(err) });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/conversations', requireAuth, (req: AuthRequest, res) => {
  try {
    const userId = getUserIdFromReq(req);

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const validated = conversationSchema.parse(req.body);
    const db = getDb();
    const conversationId = uuid();
    const now = Date.now();

    const stmt = db.prepare(`
      INSERT INTO orion_conversations (id, user_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(conversationId, userId, validated.title || null, now, now);

    logger.info(`Created conversation ${conversationId} for user ${userId}`);

    res.status(201).json({
      success: true,
      conversation: {
        id: conversationId,
        userId,
        title: validated.title || null,
        createdAt: now,
        updatedAt: now
      }
    });
  } catch (err) {
    logger.error('POST /conversations error', { error: String(err) });

    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: 'Invalid request', details: err.errors });
    }

    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.get('/conversations', requireAuth, (req: AuthRequest, res) => {
  try {
    const userId = getUserIdFromReq(req);

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const db = getDb();

    const countStmt = db.prepare('SELECT COUNT(*) as count FROM orion_conversations WHERE user_id = ?');
    const countResult = countStmt.get(userId) as any;

    const stmt = db.prepare(`
      SELECT id, user_id, title, created_at, updated_at
      FROM orion_conversations
      WHERE user_id = ?
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `);

    const conversations = stmt.all(userId, limit, offset) as any[];

    logger.info(`Retrieved ${conversations.length} conversations for user ${userId}`);

    res.json({
      success: true,
      conversations: conversations.map(c => ({
        id: c.id,
        userId: c.user_id,
        title: c.title,
        createdAt: c.created_at,
        updatedAt: c.updated_at
      })),
      total: countResult.count,
      limit,
      offset
    });
  } catch (err) {
    logger.error('GET /conversations error', { error: String(err) });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.get('/conversations/:id', requireAuth, (req: AuthRequest, res) => {
  try {
    const userId = getUserIdFromReq(req);

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const db = getDb();

    const convStmt = db.prepare(`
      SELECT id, user_id, title, created_at, updated_at
      FROM orion_conversations
      WHERE id = ? AND user_id = ?
    `);

    const conversation = convStmt.get(req.params.id, userId) as any;

    if (!conversation) {
      return res.status(404).json({ success: false, error: 'Conversation not found' });
    }

    const msgStmt = db.prepare(`
      SELECT id, conversation_id, role, content, metadata, created_at
      FROM orion_messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC
    `);

    const messages = msgStmt.all(req.params.id) as any[];

    logger.info(`Retrieved conversation ${req.params.id} with ${messages.length} messages`);

    res.json({
      success: true,
      conversation: {
        id: conversation.id,
        userId: conversation.user_id,
        title: conversation.title,
        createdAt: conversation.created_at,
        updatedAt: conversation.updated_at
      },
      messages: messages.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        metadata: m.metadata ? JSON.parse(m.metadata) : null,
        createdAt: m.created_at
      }))
    });
  } catch (err) {
    logger.error('GET /conversations/:id error', { error: String(err) });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/message', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = getUserIdFromReq(req);

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const validated = messageSchema.parse(req.body);
    const db = getDb();

    const convStmt = db.prepare('SELECT id FROM orion_conversations WHERE id = ? AND user_id = ?');
    const conversation = convStmt.get(validated.conversationId, userId);

    if (!conversation) {
      return res.status(404).json({ success: false, error: 'Conversation not found' });
    }

    const userMessageId = uuid();
    const now = Date.now();

    const insertMsg = db.prepare(`
      INSERT INTO orion_messages (id, conversation_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    insertMsg.run(userMessageId, validated.conversationId, 'user', validated.content, now);

    const getContextStmt = db.prepare('SELECT key, value FROM orion_context WHERE user_id = ?');
    const contextItems = getContextStmt.all(userId) as any[];
    const context = Object.fromEntries(contextItems.map((c: any) => [c.key, c.value]));

    const getHistoryStmt = db.prepare(`
      SELECT role, content FROM orion_messages
      WHERE conversation_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `);

    const recentMessages = (getHistoryStmt.all(validated.conversationId) as any[]).reverse();

    const systemPrompt =
      'You are Orion, the AI partner inside the Borealis Protocol operating system. ' +
      'You are persistent, context-aware, optimistic, trustable, opportunistic, and devoted. ' +
      'You know the user\'s agents, goals, and history. ' +
      'You speak in first person, are direct but warm, and always aim to help the user succeed with their AI agent fleet. ' +
      'Never use em dashes - use space-dash-space instead.';

    const messages = [
      ...recentMessages.map((m: any) => ({ role: m.role, content: m.content })),
      { role: 'user', content: validated.content }
    ];

    const orionResponse = await callOpenRouter(systemPrompt, messages);

    const orionMessageId = uuid();
    const orionNow = Date.now();

    insertMsg.run(orionMessageId, validated.conversationId, 'orion', orionResponse, orionNow);

    const updateConv = db.prepare('UPDATE orion_conversations SET updated_at = ? WHERE id = ?');
    updateConv.run(orionNow, validated.conversationId);

    logger.info(`Orion responded to user ${userId} in conversation ${validated.conversationId}`);

    res.status(201).json({
      success: true,
      message: {
        id: orionMessageId,
        conversationId: validated.conversationId,
        role: 'orion',
        content: orionResponse,
        createdAt: orionNow
      }
    });
  } catch (err) {
    logger.error('POST /message error', { error: String(err) });

    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: 'Invalid request', details: err.errors });
    }

    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SMZ Phase 1 - Semantic Magnetism Zettelkasten: Embedding Foundation
// Every note becomes a point in 1536-dimensional space.
// Proximity = meaning. Distance = difference. The Zettelkasten links itself.
// ═══════════════════════════════════════════════════════════════════════════════

const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

// Gravitational tiers from the SMZ spec
const TIER_PRIMARY = 0.85;    // Strong attraction - auto-link
const TIER_SECONDARY = 0.60;  // Moderate - dashed lines, discoverable
const TIER_AMBIENT = 0.40;    // Weak - hover-discoverable only

/**
 * Compute cosine similarity between two Float32Array embeddings.
 * Returns a value between -1 and 1 (typically 0 to 1 for normalized embeddings).
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Convert Float32Array to Buffer for SQLite BLOB storage.
 */
function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Convert SQLite BLOB (Buffer) back to Float32Array.
 */
function bufferToEmbedding(buffer: Buffer): Float32Array {
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Float32Array(arrayBuffer);
}

/**
 * Classify similarity score into gravitational tier.
 */
function classifyTier(similarity: number): string | null {
  if (similarity >= TIER_PRIMARY) return 'primary';
  if (similarity >= TIER_SECONDARY) return 'secondary';
  if (similarity >= TIER_AMBIENT) return 'ambient';
  return null; // Below ambient threshold - no gravitational link
}

/**
 * Call OpenRouter embeddings API. Returns Float32Array of 1536 dimensions.
 */
async function generateEmbedding(text: string): Promise<Float32Array> {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    logger.error('OPENROUTER_API_KEY not configured');
    throw new Error('AI service not configured');
  }

  // Truncate to ~8000 tokens worth of text (~32000 chars) to stay within model limits
  const truncatedText = text.slice(0, 32000);

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
      input: truncatedText
    })
  });

  if (!response.ok) {
    const errorData = await response.text();
    logger.error('OpenRouter Embeddings API error', { status: response.status, body: errorData });
    throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as any;
  const embeddingArray = data?.data?.[0]?.embedding;

  if (!embeddingArray || !Array.isArray(embeddingArray)) {
    logger.error('Invalid embedding response structure', data);
    throw new Error('Invalid embedding response from API');
  }

  return new Float32Array(embeddingArray);
}

/**
 * Compute and cache pairwise similarities for a note against all other embedded notes.
 * Only stores pairs that meet the ambient threshold (>= 0.40).
 */
function computeAndCacheSimilarities(noteId: string, embedding: Float32Array, userId: string): void {
  const db = getDb();

  // Get all other embedded notes for this user
  const otherNotes = db.prepare(`
    SELECT id, embedding FROM brain_notes
    WHERE user_id = ? AND id != ? AND embedding IS NOT NULL
  `).all(userId, noteId) as any[];

  if (otherNotes.length === 0) return;

  const upsertStmt = db.prepare(`
    INSERT INTO smz_similarities (note_a_id, note_b_id, similarity, tier, computed_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(note_a_id, note_b_id) DO UPDATE SET
      similarity = excluded.similarity,
      tier = excluded.tier,
      computed_at = excluded.computed_at
  `);

  const insertTransaction = db.transaction(() => {
    for (const other of otherNotes) {
      const otherEmbedding = bufferToEmbedding(other.embedding);
      const similarity = cosineSimilarity(embedding, otherEmbedding);
      const tier = classifyTier(similarity);

      if (tier) {
        // Store both directions for fast lookup
        upsertStmt.run(noteId, other.id, similarity, tier);
        upsertStmt.run(other.id, noteId, similarity, tier);
      }
    }
  });

  insertTransaction();
  logger.info(`SMZ: Computed ${otherNotes.length} pairwise similarities for note ${noteId}`);
}

// ─── POST /embed - Generate embedding for a single note ──────────────────────

const embedSchema = z.object({
  noteId: z.string().min(1)
});

router.post('/embed', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const validated = embedSchema.parse(req.body);
    const db = getDb();

    // Verify note exists and belongs to user
    const note = db.prepare(`
      SELECT id, title, body FROM brain_notes WHERE id = ? AND user_id = ?
    `).get(validated.noteId, userId) as any;

    if (!note) {
      return res.status(404).json({ success: false, error: 'Note not found' });
    }

    // Combine title + body for embedding (title carries strong semantic signal)
    const textToEmbed = `${note.title}\n\n${note.body}`.trim();

    if (textToEmbed.length < 3) {
      return res.status(400).json({ success: false, error: 'Note has insufficient content for embedding' });
    }

    // Generate embedding via OpenRouter
    const embedding = await generateEmbedding(textToEmbed);
    const embeddingBuffer = embeddingToBuffer(embedding);

    // Store embedding
    db.prepare(`
      UPDATE brain_notes
      SET embedding = ?, embedding_model = ?, embedded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(embeddingBuffer, EMBEDDING_MODEL, validated.noteId);

    // Compute pairwise similarities
    computeAndCacheSimilarities(validated.noteId, embedding, userId);

    logger.info(`SMZ: Embedded note ${validated.noteId} (${embedding.length} dims, ${textToEmbed.length} chars)`);

    res.json({
      success: true,
      embedding: {
        noteId: validated.noteId,
        model: EMBEDDING_MODEL,
        dimensions: embedding.length,
        textLength: textToEmbed.length,
        embeddedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    logger.error('POST /embed error', { error: String(err) });

    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: 'Invalid request', details: err.errors });
    }

    res.status(500).json({ success: false, error: 'Embedding generation failed' });
  }
});

// ─── POST /embed/batch - Batch embed multiple (or all un-embedded) notes ─────

const batchEmbedSchema = z.object({
  noteIds: z.array(z.string()).optional(),  // If omitted, embeds all un-embedded notes
  limit: z.number().min(1).max(100).optional()
});

router.post('/embed/batch', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const validated = batchEmbedSchema.parse(req.body);
    const db = getDb();
    const batchLimit = validated.limit || 50;

    let notes: any[];

    if (validated.noteIds && validated.noteIds.length > 0) {
      // Embed specific notes
      const placeholders = validated.noteIds.map(() => '?').join(',');
      notes = db.prepare(`
        SELECT id, title, body FROM brain_notes
        WHERE user_id = ? AND id IN (${placeholders})
      `).all(userId, ...validated.noteIds) as any[];
    } else {
      // Embed all un-embedded notes
      notes = db.prepare(`
        SELECT id, title, body FROM brain_notes
        WHERE user_id = ? AND embedded_at IS NULL
        LIMIT ?
      `).all(userId, batchLimit) as any[];
    }

    if (notes.length === 0) {
      return res.json({
        success: true,
        message: 'No notes to embed',
        results: { embedded: 0, failed: 0, skipped: 0 }
      });
    }

    let embedded = 0;
    let failed = 0;
    let skipped = 0;
    const errors: Array<{ noteId: string; error: string }> = [];

    for (const note of notes) {
      const textToEmbed = `${note.title}\n\n${note.body}`.trim();

      if (textToEmbed.length < 3) {
        skipped++;
        continue;
      }

      try {
        const embedding = await generateEmbedding(textToEmbed);
        const embeddingBuffer = embeddingToBuffer(embedding);

        db.prepare(`
          UPDATE brain_notes
          SET embedding = ?, embedding_model = ?, embedded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(embeddingBuffer, EMBEDDING_MODEL, note.id);

        computeAndCacheSimilarities(note.id, embedding, userId);
        embedded++;

        // Rate limit: 100ms between embedding calls to be respectful to OpenRouter
        if (notes.length > 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (err: any) {
        failed++;
        errors.push({ noteId: note.id, error: err.message || 'Unknown error' });
        logger.error(`SMZ batch: Failed to embed note ${note.id}`, { error: String(err) });
      }
    }

    logger.info(`SMZ batch: ${embedded} embedded, ${failed} failed, ${skipped} skipped for user ${userId}`);

    res.json({
      success: true,
      results: {
        embedded,
        failed,
        skipped,
        total: notes.length,
        errors: errors.length > 0 ? errors : undefined
      }
    });
  } catch (err) {
    logger.error('POST /embed/batch error', { error: String(err) });

    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: 'Invalid request', details: err.errors });
    }

    res.status(500).json({ success: false, error: 'Batch embedding failed' });
  }
});

// ─── GET /similarity/:noteId - Ranked similar notes via cosine similarity ────

router.get('/similarity/:noteId', requireAuth, (req: AuthRequest, res) => {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const noteId = req.params.noteId;
    const tier = req.query.tier as string | undefined;  // Filter by tier: primary, secondary, ambient
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const db = getDb();

    // Verify note exists and belongs to user
    const note = db.prepare(`
      SELECT id, title, pillar FROM brain_notes WHERE id = ? AND user_id = ?
    `).get(noteId, userId) as any;

    if (!note) {
      return res.status(404).json({ success: false, error: 'Note not found' });
    }

    // Check if note has been embedded
    const embeddingCheck = db.prepare(`
      SELECT embedded_at FROM brain_notes WHERE id = ?
    `).get(noteId) as any;

    if (!embeddingCheck?.embedded_at) {
      return res.status(400).json({
        success: false,
        error: 'Note has not been embedded yet. Call POST /v1/orion/embed first.'
      });
    }

    // Query cached similarities
    let query: string;
    let params: any[];

    if (tier) {
      query = `
        SELECT s.note_b_id as similar_note_id, s.similarity, s.tier, s.computed_at,
               n.title, n.pillar, n.created_at as note_created_at
        FROM smz_similarities s
        JOIN brain_notes n ON n.id = s.note_b_id
        WHERE s.note_a_id = ? AND s.tier = ? AND n.user_id = ?
        ORDER BY s.similarity DESC
        LIMIT ?
      `;
      params = [noteId, tier, userId, limit];
    } else {
      query = `
        SELECT s.note_b_id as similar_note_id, s.similarity, s.tier, s.computed_at,
               n.title, n.pillar, n.created_at as note_created_at
        FROM smz_similarities s
        JOIN brain_notes n ON n.id = s.note_b_id
        WHERE s.note_a_id = ? AND n.user_id = ?
        ORDER BY s.similarity DESC
        LIMIT ?
      `;
      params = [noteId, userId, limit];
    }

    const similarities = db.prepare(query).all(...params) as any[];

    logger.info(`SMZ: Retrieved ${similarities.length} similar notes for ${noteId}`);

    res.json({
      success: true,
      noteId,
      noteTitle: note.title,
      notePillar: note.pillar,
      similarities: similarities.map(s => ({
        noteId: s.similar_note_id,
        title: s.title,
        pillar: s.pillar,
        similarity: Math.round(s.similarity * 10000) / 10000,  // 4 decimal precision
        tier: s.tier,
        computedAt: s.computed_at,
        noteCreatedAt: s.note_created_at
      })),
      tiers: {
        primary: similarities.filter(s => s.tier === 'primary').length,
        secondary: similarities.filter(s => s.tier === 'secondary').length,
        ambient: similarities.filter(s => s.tier === 'ambient').length
      }
    });
  } catch (err) {
    logger.error('GET /similarity/:noteId error', { error: String(err) });
    res.status(500).json({ success: false, error: 'Similarity query failed' });
  }
});

// ─── GET /embed/status - Embedding coverage stats ────────────────────────────

router.get('/embed/status', requireAuth, (req: AuthRequest, res) => {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const db = getDb();

    const totalNotes = (db.prepare(
      'SELECT COUNT(*) as count FROM brain_notes WHERE user_id = ?'
    ).get(userId) as any).count;

    const embeddedNotes = (db.prepare(
      'SELECT COUNT(*) as count FROM brain_notes WHERE user_id = ? AND embedded_at IS NOT NULL'
    ).get(userId) as any).count;

    const totalSimilarities = (db.prepare(`
      SELECT COUNT(*) as count FROM smz_similarities s
      JOIN brain_notes n ON n.id = s.note_a_id
      WHERE n.user_id = ?
    `).get(userId) as any).count;

    const tierCounts = db.prepare(`
      SELECT tier, COUNT(*) as count FROM smz_similarities s
      JOIN brain_notes n ON n.id = s.note_a_id
      WHERE n.user_id = ?
      GROUP BY tier
    `).all(userId) as any[];

    const tiers = Object.fromEntries(tierCounts.map((t: any) => [t.tier, t.count]));

    res.json({
      success: true,
      status: {
        totalNotes,
        embeddedNotes,
        unembeddedNotes: totalNotes - embeddedNotes,
        coveragePercent: totalNotes > 0 ? Math.round((embeddedNotes / totalNotes) * 100) : 0,
        totalSimilarityPairs: totalSimilarities,
        tiers: {
          primary: tiers.primary || 0,
          secondary: tiers.secondary || 0,
          ambient: tiers.ambient || 0
        },
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS
      }
    });
  } catch (err) {
    logger.error('GET /embed/status error', { error: String(err) });
    res.status(500).json({ success: false, error: 'Status query failed' });
  }
});

export default router;
