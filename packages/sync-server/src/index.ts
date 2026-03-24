import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';

const DATA_DIR = process.env['SYNC_DATA_DIR'] ?? resolve(homedir(), '.0agent', 'sync-server');
const PORT = parseInt(process.env['SYNC_PORT'] ?? '4201', 10);

mkdirSync(DATA_DIR, { recursive: true });

// ─── SQLite setup ─────────────────────────────────────────────────────────────
const db = new Database(resolve(DATA_DIR, 'teams.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    team_id TEXT NOT NULL REFERENCES teams(id),
    entity_node_id TEXT NOT NULL,
    name TEXT NOT NULL,
    device_id TEXT,
    joined_at INTEGER NOT NULL,
    last_synced_at INTEGER,
    PRIMARY KEY (team_id, entity_node_id)
  );
  CREATE TABLE IF NOT EXISTS deltas (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id),
    member_entity_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_deltas_team_time ON deltas(team_id, created_at);
`);

// ─── Invite code generation ───────────────────────────────────────────────────
function generateInviteCode(): string {
  // Format: ABC-1234 (memorable 8 chars)
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, O (confusing)
  const digits  = '23456789';                  // no 0, 1
  const alpha = Array.from({ length: 3 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  const nums  = Array.from({ length: 4 }, () => digits[Math.floor(Math.random() * digits.length)]).join('');
  return `${alpha}-${nums}`;
}

// ─── App ──────────────────────────────────────────────────────────────────────
const app = new Hono();

// Health
app.get('/', c => c.json({ service: '0agent-sync', version: '1.0.0', teams: db.prepare('SELECT COUNT(*) as n FROM teams').get() }));

// ─── Teams ────────────────────────────────────────────────────────────────────

// Create a team
app.post('/api/teams', async c => {
  const body = await c.req.json() as { name: string; creator_entity_id: string; creator_name: string };
  if (!body.name || !body.creator_entity_id) return c.json({ error: 'name and creator_entity_id required' }, 400);

  const id = crypto.randomUUID();
  let invite_code = generateInviteCode();
  // Retry if collision (very rare)
  while (db.prepare('SELECT id FROM teams WHERE invite_code = ?').get(invite_code)) {
    invite_code = generateInviteCode();
  }

  db.transaction(() => {
    db.prepare('INSERT INTO teams (id, name, invite_code, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(id, body.name, invite_code, Date.now(), body.creator_entity_id);
    db.prepare('INSERT INTO members (team_id, entity_node_id, name, device_id, joined_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, body.creator_entity_id, body.creator_name ?? 'Unknown', null, Date.now());
  })();

  return c.json({ id, name: body.name, invite_code }, 201);
});

// Get team info by invite code (for joining)
app.get('/api/teams/by-code/:code', c => {
  const code = c.req.param('code').toUpperCase();
  const team = db.prepare('SELECT * FROM teams WHERE invite_code = ?').get(code) as any;
  if (!team) return c.json({ error: 'Invalid invite code' }, 404);
  const members = db.prepare('SELECT * FROM members WHERE team_id = ?').all(team.id) as any[];
  return c.json({ ...team, members });
});

// Join a team
app.post('/api/teams/:id/join', async c => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(c.req.param('id')) as any;
  if (!team) return c.json({ error: 'Team not found' }, 404);

  const body = await c.req.json() as { entity_node_id: string; name: string; device_id?: string };
  if (!body.entity_node_id) return c.json({ error: 'entity_node_id required' }, 400);

  const existing = db.prepare('SELECT * FROM members WHERE team_id = ? AND entity_node_id = ?')
    .get(team.id, body.entity_node_id);
  if (!existing) {
    db.prepare('INSERT INTO members (team_id, entity_node_id, name, device_id, joined_at) VALUES (?, ?, ?, ?, ?)')
      .run(team.id, body.entity_node_id, body.name ?? 'Unknown', body.device_id ?? null, Date.now());
  }

  return c.json({ joined: true, team_id: team.id, team_name: team.name });
});

// List teams (for a member)
app.get('/api/teams', c => {
  const entity_id = c.req.query('entity_id');
  if (!entity_id) return c.json({ error: 'entity_id required' }, 400);
  const teams = db.prepare(`
    SELECT t.*, m.joined_at, m.last_synced_at,
      (SELECT COUNT(*) FROM members m2 WHERE m2.team_id = t.id) as member_count
    FROM teams t JOIN members m ON t.id = m.team_id
    WHERE m.entity_node_id = ?
  `).all(entity_id) as any[];
  return c.json(teams);
});

// ─── Sync (delta push/pull) ───────────────────────────────────────────────────

// Push deltas to team (weight events + signal nodes)
app.post('/api/teams/:id/push', async c => {
  const team_id = c.req.param('id');
  const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(team_id);
  if (!team) return c.json({ error: 'Team not found' }, 404);

  const body = await c.req.json() as {
    member_entity_id: string;
    deltas: Array<{ type: string; payload: unknown }>;
  };

  const insert = db.prepare(
    'INSERT INTO deltas (id, team_id, member_entity_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertMany = db.transaction((deltas: typeof body.deltas) => {
    for (const d of deltas) {
      insert.run(crypto.randomUUID(), team_id, body.member_entity_id, d.type, JSON.stringify(d.payload), Date.now());
    }
  });
  insertMany(body.deltas);

  // Update last_synced_at
  db.prepare('UPDATE members SET last_synced_at = ? WHERE team_id = ? AND entity_node_id = ?')
    .run(Date.now(), team_id, body.member_entity_id);

  return c.json({ pushed: body.deltas.length });
});

// Pull deltas since timestamp (excluding own)
app.get('/api/teams/:id/pull', c => {
  const team_id = c.req.param('id');
  const since = parseInt(c.req.query('since') ?? '0', 10);
  const exclude_member = c.req.query('exclude_member') ?? '';

  const deltas = db.prepare(`
    SELECT * FROM deltas
    WHERE team_id = ? AND created_at > ? AND member_entity_id != ?
    ORDER BY created_at ASC LIMIT 500
  `).all(team_id, since, exclude_member) as any[];

  return c.json({
    deltas: deltas.map(d => ({ ...d, payload: JSON.parse(d.payload) })),
    latest_timestamp: deltas.length > 0 ? deltas[deltas.length - 1].created_at : since,
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const host = process.env['SYNC_HOST'] ?? '0.0.0.0';  // bind to all interfaces
serve({ fetch: app.fetch, port: PORT, hostname: host }, () => {
  console.log(`[0agent-sync] Running on ${host}:${PORT}`);
  console.log(`[0agent-sync] Data: ${DATA_DIR}`);
});
