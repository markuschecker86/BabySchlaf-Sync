const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// DB setup
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'babyschlaf.db');
require('fs').mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS families (
    code TEXT PRIMARY KEY,
    created_at INTEGER DEFAULT (unixepoch()),
    last_sync INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS sync_data (
    family_code TEXT NOT NULL,
    device_id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (family_code, device_id),
    FOREIGN KEY (family_code) REFERENCES families(code)
  );
  CREATE TABLE IF NOT EXISTS entries (
    family_code TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    data TEXT NOT NULL,
    deleted INTEGER DEFAULT 0,
    updated_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (family_code, entry_id)
  );
`);

// Middleware
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Generate unique 6-char family code
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1
  let code;
  const exists = db.prepare('SELECT 1 FROM families WHERE code = ?');
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
  } while (exists.get(code));
  return code;
}

// POST /api/family/create - Create a new family
app.post('/api/family/create', (req, res) => {
  const code = genCode();
  db.prepare('INSERT INTO families (code) VALUES (?)').run(code);
  res.json({ ok: true, code });
});

// POST /api/family/join - Join existing family
app.post('/api/family/join', (req, res) => {
  const { code } = req.body;
  if (!code || code.length !== 6) return res.status(400).json({ ok: false, error: 'Ungültiger Code' });
  const family = db.prepare('SELECT * FROM families WHERE code = ?').get(code.toUpperCase());
  if (!family) return res.status(404).json({ ok: false, error: 'Familie nicht gefunden' });
  res.json({ ok: true, code: family.code });
});

// POST /api/sync/push - Push local data to cloud
app.post('/api/sync/push', (req, res) => {
  const { code, device_id, babies, entries } = req.body;
  if (!code || !device_id) return res.status(400).json({ ok: false, error: 'Missing params' });

  const family = db.prepare('SELECT 1 FROM families WHERE code = ?').get(code);
  if (!family) return res.status(404).json({ ok: false, error: 'Familie nicht gefunden' });

  const now = Math.floor(Date.now() / 1000);

  // Save device state (baby profiles etc)
  db.prepare(`INSERT OR REPLACE INTO sync_data (family_code, device_id, data, updated_at) 
    VALUES (?, ?, ?, ?)`).run(code, device_id, JSON.stringify(babies || []), now);

  // Merge entries
  if (entries && entries.length > 0) {
    const upsert = db.prepare(`INSERT OR REPLACE INTO entries (family_code, entry_id, data, deleted, updated_at) 
      VALUES (?, ?, ?, ?, ?)`);
    const tx = db.transaction((items) => {
      for (const e of items) {
        upsert.run(code, e.id, JSON.stringify(e), e._deleted ? 1 : 0, e._ts || now);
      }
    });
    tx(entries);
  }

  db.prepare('UPDATE families SET last_sync = ? WHERE code = ?').run(now, code);
  res.json({ ok: true, synced: entries?.length || 0 });
});

// POST /api/sync/pull - Pull latest data from cloud
app.post('/api/sync/pull', (req, res) => {
  const { code, since } = req.body;
  if (!code) return res.status(400).json({ ok: false, error: 'Missing code' });

  const family = db.prepare('SELECT 1 FROM families WHERE code = ?').get(code);
  if (!family) return res.status(404).json({ ok: false, error: 'Familie nicht gefunden' });

  const sinceTs = since || 0;

  // Get all entries updated since timestamp
  const entries = db.prepare(
    'SELECT data, deleted FROM entries WHERE family_code = ? AND updated_at > ?'
  ).all(code, sinceTs);

  // Get baby profiles from all devices
  const devices = db.prepare(
    'SELECT device_id, data, updated_at FROM sync_data WHERE family_code = ?'
  ).all(code);

  const parsed = entries.map(e => {
    const d = JSON.parse(e.data);
    if (e.deleted) d._deleted = true;
    return d;
  });

  res.json({
    ok: true,
    entries: parsed,
    devices: devices.map(d => ({ device_id: d.device_id, babies: JSON.parse(d.data), updated_at: d.updated_at })),
    server_time: Math.floor(Date.now() / 1000)
  });
});

// GET /api/family/info - Get family info
app.get('/api/family/info/:code', (req, res) => {
  const family = db.prepare('SELECT * FROM families WHERE code = ?').get(req.params.code);
  if (!family) return res.status(404).json({ ok: false });
  const devices = db.prepare('SELECT device_id, updated_at FROM sync_data WHERE family_code = ?').all(req.params.code);
  const entryCount = db.prepare('SELECT COUNT(*) as c FROM entries WHERE family_code = ? AND deleted = 0').get(req.params.code);
  res.json({ ok: true, devices: devices.length, entries: entryCount.c, last_sync: family.last_sync });
});

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => console.log(`BabySchlaf Sync API on port ${PORT}`));
