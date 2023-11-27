// lib/db.js
// Tiny JSON "database" with atomic writes. Single source of truth = data/emails.json.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DB location can be redirected with INBOX_FORGE_DATA (used for isolated testing so a
// test run can never touch your real database).
const DATA_DIR = process.env.INBOX_FORGE_DATA
  ? path.resolve(process.env.INBOX_FORGE_DATA)
  : path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'emails.json');

const DEFAULTS = {
  settings: { provider: 'mail.tm', throttleMs: 500, theme: 'system' },
  identities: [],
};

// Serialize all writes so the generate loop can save after every inbox safely.
let writeChain = Promise.resolve();

export function dbPath() {
  return DB_PATH;
}

export async function ensure() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DB_PATH);
  } catch {
    await write(DEFAULTS);
  }
}

export async function read() {
  try {
    const raw = await fs.readFile(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      settings: { ...DEFAULTS.settings, ...(parsed.settings || {}) },
      identities: Array.isArray(parsed.identities) ? parsed.identities : [],
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function write(obj) {
  // Chain writes; atomic via temp file + rename (libuv rename overwrites on Windows too).
  writeChain = writeChain.then(async () => {
    const tmp = `${DB_PATH}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
    await fs.rename(tmp, DB_PATH);
  });
  return writeChain;
}

// Snapshot the current DB into data/backups/ before a destructive operation.
export async function backup(tag = 'backup') {
  try {
    const raw = await fs.readFile(DB_PATH, 'utf8');
    const dir = path.join(DATA_DIR, 'backups');
    await fs.mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.writeFile(path.join(dir, `emails-${ts}-${tag}.json`), raw, 'utf8');
  } catch {
    /* backup is best-effort; never block the operation */
  }
}

export async function getSettings() {
  const db = await read();
  return db.settings;
}

export async function updateSettings(patch) {
  const db = await read();
  db.settings = { ...db.settings, ...patch };
  await write(db);
  return db.settings;
}

export async function addIdentity(identity) {
  const db = await read();
  db.identities.push(identity);
  await write(db);
  return identity;
}

export async function getIdentity(id) {
  const db = await read();
  return db.identities.find((i) => i.id === id) || null;
}

export async function renameIdentity(id, nickname) {
  const db = await read();
  const identity = db.identities.find((i) => i.id === id);
  if (!identity) return null;
  identity.nickname = nickname;
  await write(db);
  return identity;
}

export async function removeIdentities(ids) {
  const set = new Set(ids);
  const db = await read();
  const before = db.identities.length;
  db.identities = db.identities.filter((i) => !set.has(i.id));
  await write(db);
  return before - db.identities.length;
}

export function newId() {
  return crypto.randomUUID();
}
