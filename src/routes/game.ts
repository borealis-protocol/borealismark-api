/**
 * Game Room API Routes — Borealis Academy Multiplayer
 *
 * Lightweight in-memory room system for live competitive play.
 * Rooms expire after 30 minutes of inactivity.
 *
 * Public (no auth required):
 *   POST  /v1/game/room/create        — Create a new room, returns 4-letter code
 *   GET   /v1/game/room/:code         — Poll room state
 *   POST  /v1/game/room/:code/join    — Join an existing room
 *   POST  /v1/game/room/:code/update  — Update room state (scores, events)
 *   POST  /v1/game/room/:code/leave   — Leave / dissolve room
 */

import { Router, Request, Response } from 'express';

const router = Router();

// ─── Types ────────────────────────────────────────────────────────────────────

interface Player {
  id: string;          // random uuid generated client-side
  name: string;        // display name
  score: number;
  ready: boolean;
  lastSeen: number;    // epoch ms
}

interface GameRoom {
  code: string;
  gameId: string;      // 'ai-or-not' | 'data-sort' | etc.
  hostId: string;
  players: Record<string, Player>;
  state: 'lobby' | 'playing' | 'finished';
  round: number;
  events: RoomEvent[];  // recent events log (capped at 50)
  createdAt: number;
  updatedAt: number;
}

interface RoomEvent {
  playerId: string;
  playerName: string;
  type: string;         // 'score' | 'answer' | 'ready' | 'chat'
  payload: any;
  ts: number;
}

// ─── In-Memory Store ──────────────────────────────────────────────────────────

const rooms = new Map<string, GameRoom>();
const ROOM_TTL_MS = 30 * 60 * 1000;   // 30 minutes
const PLAYER_IDLE_MS = 60 * 1000;     // 1 minute idle = player gone

// Cleanup expired rooms every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.updatedAt > ROOM_TTL_MS) {
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += letters[Math.floor(Math.random() * letters.length)];
  }
  return code;
}

function makeUniqueCode(): string {
  let code = generateCode();
  let attempts = 0;
  while (rooms.has(code) && attempts < 50) {
    code = generateCode();
    attempts++;
  }
  return code;
}

function pruneIdlePlayers(room: GameRoom): void {
  const now = Date.now();
  for (const [pid, player] of Object.entries(room.players)) {
    if (now - player.lastSeen > PLAYER_IDLE_MS && pid !== room.hostId) {
      delete room.players[pid];
    }
  }
}

function roomView(room: GameRoom) {
  pruneIdlePlayers(room);
  return {
    code: room.code,
    gameId: room.gameId,
    hostId: room.hostId,
    state: room.state,
    round: room.round,
    players: Object.values(room.players).map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      ready: p.ready,
      active: Date.now() - p.lastSeen < PLAYER_IDLE_MS,
    })),
    events: room.events.slice(-20),  // last 20 events
    playerCount: Object.keys(room.players).length,
    updatedAt: room.updatedAt,
  };
}

// ─── POST /v1/game/room/create ────────────────────────────────────────────────

router.post('/room/create', (req: Request, res: Response) => {
  const { gameId, playerId, playerName } = req.body;

  if (!gameId || typeof gameId !== 'string') {
    return res.status(400).json({ error: 'gameId required' });
  }
  if (!playerId || typeof playerId !== 'string') {
    return res.status(400).json({ error: 'playerId required' });
  }

  const name = typeof playerName === 'string' && playerName.trim()
    ? playerName.trim().slice(0, 24)
    : 'Player';

  const code = makeUniqueCode();
  const now = Date.now();

  const room: GameRoom = {
    code,
    gameId,
    hostId: playerId,
    state: 'lobby',
    round: 0,
    players: {
      [playerId]: { id: playerId, name, score: 0, ready: false, lastSeen: now },
    },
    events: [{
      playerId,
      playerName: name,
      type: 'joined',
      payload: { host: true },
      ts: now,
    }],
    createdAt: now,
    updatedAt: now,
  };

  rooms.set(code, room);
  return res.status(201).json({ code, room: roomView(room) });
});

// ─── GET /v1/game/room/:code ──────────────────────────────────────────────────

router.get('/room/:code', (req: Request, res: Response) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  // Heartbeat: if playerId provided in query, refresh lastSeen
  const pid = typeof req.query.playerId === 'string' ? req.query.playerId : null;
  if (pid && room.players[pid]) {
    room.players[pid].lastSeen = Date.now();
    room.updatedAt = Date.now();
  }

  return res.json({ room: roomView(room) });
});

// ─── POST /v1/game/room/:code/join ────────────────────────────────────────────

router.post('/room/:code/join', (req: Request, res: Response) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  if (room.state === 'finished') {
    return res.status(410).json({ error: 'Game has already ended' });
  }

  const { playerId, playerName } = req.body;
  if (!playerId || typeof playerId !== 'string') {
    return res.status(400).json({ error: 'playerId required' });
  }

  const name = typeof playerName === 'string' && playerName.trim()
    ? playerName.trim().slice(0, 24)
    : `Player${Object.keys(room.players).length + 1}`;

  const now = Date.now();

  if (!room.players[playerId]) {
    // New player joining
    if (Object.keys(room.players).length >= 8) {
      return res.status(409).json({ error: 'Room is full (max 8 players)' });
    }
    room.players[playerId] = { id: playerId, name, score: 0, ready: false, lastSeen: now };
    room.events.push({ playerId, playerName: name, type: 'joined', payload: {}, ts: now });
    if (room.events.length > 50) room.events = room.events.slice(-50);
  } else {
    // Rejoin — just refresh lastSeen
    room.players[playerId].lastSeen = now;
  }

  room.updatedAt = now;
  return res.json({ room: roomView(room) });
});

// ─── POST /v1/game/room/:code/update ─────────────────────────────────────────

router.post('/room/:code/update', (req: Request, res: Response) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const { playerId, type, payload } = req.body;
  if (!playerId || typeof playerId !== 'string') {
    return res.status(400).json({ error: 'playerId required' });
  }
  if (!type || typeof type !== 'string') {
    return res.status(400).json({ error: 'event type required' });
  }

  const player = room.players[playerId];
  if (!player) {
    return res.status(403).json({ error: 'Player not in room — join first' });
  }

  const now = Date.now();
  player.lastSeen = now;

  // Handle known event types
  switch (type) {
    case 'score': {
      // payload: { delta: number }
      const delta = typeof payload?.delta === 'number' ? payload.delta : 0;
      player.score = Math.max(0, player.score + delta);
      break;
    }
    case 'set_score': {
      // payload: { score: number }
      if (typeof payload?.score === 'number') {
        player.score = Math.max(0, payload.score);
      }
      break;
    }
    case 'ready': {
      player.ready = true;
      // Auto-start if all players ready and host triggered this
      const allReady = Object.values(room.players).every(p => p.ready);
      if (allReady && room.state === 'lobby') {
        room.state = 'playing';
        room.round = 1;
        room.events.push({ playerId, playerName: player.name, type: 'game_start', payload: {}, ts: now });
      }
      break;
    }
    case 'next_round': {
      // Only host can advance rounds
      if (playerId !== room.hostId) {
        return res.status(403).json({ error: 'Only host can advance rounds' });
      }
      room.round = (room.round || 0) + 1;
      // Reset ready flags for next round
      for (const p of Object.values(room.players)) p.ready = false;
      break;
    }
    case 'start': {
      if (playerId !== room.hostId) {
        return res.status(403).json({ error: 'Only host can start' });
      }
      room.state = 'playing';
      room.round = 1;
      break;
    }
    case 'finish': {
      if (playerId !== room.hostId) {
        return res.status(403).json({ error: 'Only host can finish' });
      }
      room.state = 'finished';
      break;
    }
    // 'answer', 'chat', custom events — just log as event
  }

  room.events.push({ playerId, playerName: player.name, type, payload: payload || {}, ts: now });
  if (room.events.length > 50) room.events = room.events.slice(-50);
  room.updatedAt = now;

  return res.json({ room: roomView(room) });
});

// ─── POST /v1/game/room/:code/leave ──────────────────────────────────────────

router.post('/room/:code/leave', (req: Request, res: Response) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const { playerId } = req.body;
  if (!playerId || !room.players[playerId]) {
    return res.status(400).json({ error: 'playerId not in room' });
  }

  const player = room.players[playerId];
  const now = Date.now();

  // If host leaves, dissolve room
  if (playerId === room.hostId) {
    rooms.delete(code);
    return res.json({ dissolved: true });
  }

  delete room.players[playerId];
  room.events.push({ playerId, playerName: player.name, type: 'left', payload: {}, ts: now });
  if (room.events.length > 50) room.events = room.events.slice(-50);
  room.updatedAt = now;

  return res.json({ room: roomView(room) });
});

export default router;
