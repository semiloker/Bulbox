// server.js — zero-dependency HTTP server: serves the UI, proxies mail.tm, owns the JSON DB.

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import * as db from './lib/db.js';
import * as generate from './lib/generate.js';
import * as mail from './providers/index.js';
import * as browser from './lib/browser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---- helpers ---------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5_000_000) req.destroy();
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  // Prevent path traversal outside /public.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const buf = await fs.readFile(filePath);
    const type = MIME[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

// Why generation could not start, in the words of the provider you picked.
function noDomainMessage(provider) {
  return provider === 'domain'
    ? 'Set your domain in Settings first (the catch-all domain your worker receives mail for).'
    : 'No mail.tm domains are available right now. Try again shortly.';
}

// ---- API handlers ----------------------------------------------------------

async function handleGenerate(req, res, q) {
  const count = clamp(parseInt(q.get('count')) || 100, 1, 500);
  const style = q.get('localPart') || 'word';
  const pwLen = parseInt(q.get('pwLen')) || 16;
  const pwStyle = q.get('pwStyle') || 'strong';
  const settings = await db.getSettings();
  const provider = q.get('provider') || settings.provider || 'mail.tm';
  const conf = { ...settings, provider };
  const domain = q.get('domain') || '';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let aborted = false;
  req.on('close', () => {
    aborted = true;
  });

  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Some backends hand out the address themselves; for the rest, spread over
    // every domain they offer instead of burning one, which is what gets a
    // domain blocklisted in the first place.
    const assigned = mail.assignsAddresses(conf);
    const pool = assigned ? [] : domain ? [domain] : await mail.getDomains(conf);
    if (!assigned && !pool.length) throw new Error(noDomainMessage(provider));
    const throttleMs = assigned
      ? 5200 // 5minmail allows one new address every 5 seconds
      : provider === 'domain'
        ? 0 // a catch-all domain accepts every address offline: nothing to rate-limit
        : clamp(Number(settings.throttleMs) || 500, 150, 5000);
    const existing = new Set((await db.read()).identities.map((i) => i.email.toLowerCase()));

    let created = 0;
    let failed = 0;
    send('start', {
      total: count,
      domain: assigned ? provider : pool.length > 1 ? `${pool.length} domains` : pool[0],
      provider,
    });

    for (let i = 0; i < count && !aborted; i++) {
      const nickname = generate.randomNickname();
      let identity = null;
      let lastErr = null;

      for (let attempt = 0; attempt < 6 && !aborted; attempt++) {
        const wanted = assigned
          ? ''
          : `${generate.localPart(style, nickname)}@${pool[(i + attempt) % pool.length]}`.toLowerCase();
        if (wanted && existing.has(wanted)) continue;
        const password = generate.randomPassword(pwLen, pwStyle);
        try {
          const made = await mail.createIdentity(conf, wanted, password);
          if (existing.has(made.email)) continue;
          identity = {
            id: db.newId(),
            email: made.email,
            nickname,
            password,
            provider,
            accountId: made.accountId,
            expiresAt: made.expiresAt || null,
            active: true,
            createdAt: new Date().toISOString(),
          };
          existing.add(made.email);
          break;
        } catch (err) {
          lastErr = err;
          if (err.status === 422) continue; // taken/invalid -> new local part
          await sleep(600 * (attempt + 1)); // transient -> back off and retry
        }
      }

      if (identity) {
        await db.addIdentity(identity);
        created++;
        send('progress', {
          index: i + 1,
          total: count,
          created,
          failed,
          identity: {
            id: identity.id,
            email: identity.email,
            nickname: identity.nickname,
            password: identity.password,
            createdAt: identity.createdAt,
          },
        });
      } else {
        failed++;
        send('progress', {
          index: i + 1,
          total: count,
          created,
          failed,
          error: lastErr ? lastErr.message : 'unknown error',
        });
      }

      if (i < count - 1 && !aborted) await sleep(throttleMs);
    }

    send('done', { created, failed, aborted });
  } catch (err) {
    send('failed', { message: err.message });
  } finally {
    res.end();
  }
}

async function handleInbox(res, id) {
  const identity = await db.getIdentity(id);
  if (!identity) return sendJson(res, 404, { error: 'Identity not found' });
  try {
    const messages = await mail.listMessages(await db.getSettings(), identity);
    sendJson(res, 200, { email: identity.email, messages });
  } catch (err) {
    sendJson(res, 502, { error: `Could not open inbox: ${err.message}` });
  }
}

async function handleMessage(res, id, mid) {
  const identity = await db.getIdentity(id);
  if (!identity) return sendJson(res, 404, { error: 'Identity not found' });
  try {
    const message = await mail.getMessage(await db.getSettings(), identity, mid);
    sendJson(res, 200, { message });
  } catch (err) {
    sendJson(res, 502, { error: `Could not load message: ${err.message}` });
  }
}

async function handleDelete(res, ids) {
  if (!Array.isArray(ids) || !ids.length) return sendJson(res, 400, { error: 'No ids provided' });
  await db.backup('pre-delete'); // snapshot before removing anything
  const settings = await db.getSettings();
  let serverDeleted = 0;
  for (const id of ids) {
    const identity = await db.getIdentity(id);
    if (!identity) continue;
    try {
      await mail.deleteIdentity(settings, identity);
      serverDeleted++;
    } catch {
      /* account may already be gone server-side; still remove it locally */
    }
    await browser.removeProfile(id); // drop this identity's saved browser data too
  }
  const removed = await db.removeIdentities(ids);
  sendJson(res, 200, { removed, serverDeleted });
}

async function handleOpenBrowser(res, id) {
  const identity = await db.getIdentity(id);
  if (!identity) return sendJson(res, 404, { error: 'Identity not found' });
  try {
    const info = await browser.openProfile(identity.id, '');
    sendJson(res, 200, { ok: true, browser: info.browser });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleExport(res) {
  const dbData = await db.read();
  const body = JSON.stringify(dbData, null, 2);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': 'attachment; filename="emails.json"',
  });
  res.end(body);
}

// ---- router ----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = parsed;
  const q = parsed.searchParams;

  try {
    if (pathname === '/api/domains' && req.method === 'GET') {
      const settings = await db.getSettings();
      const provider = q.get('provider') || settings.provider;
      const domains = await mail.getDomains({ ...settings, provider });
      return sendJson(res, 200, { domains });
    }

    if (pathname === '/api/identities' && req.method === 'GET') {
      const data = await db.read();
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/generate' && req.method === 'GET') {
      return handleGenerate(req, res, q);
    }

    if (pathname === '/api/inbox' && req.method === 'GET') {
      return handleInbox(res, q.get('id'));
    }

    if (pathname === '/api/message' && req.method === 'GET') {
      return handleMessage(res, q.get('id'), q.get('mid'));
    }

    if (pathname === '/api/delete' && req.method === 'POST') {
      const body = await readBody(req);
      return handleDelete(res, body.ids);
    }

    if (pathname === '/api/browser' && req.method === 'POST') {
      const body = await readBody(req);
      return handleOpenBrowser(res, body.id);
    }

    if (pathname === '/api/categories' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        return sendJson(res, 200, { categories: await db.upsertCategory(body) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname === '/api/categories/remove' && req.method === 'POST') {
      const { id } = await readBody(req);
      return sendJson(res, 200, await db.removeCategory(id));
    }

    if (pathname === '/api/assign' && req.method === 'POST') {
      const { ids, categoryId } = await readBody(req);
      if (!Array.isArray(ids) || !ids.length) return sendJson(res, 400, { error: 'No ids provided' });
      try {
        return sendJson(res, 200, await db.assignCategory(ids, categoryId || null));
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname === '/api/rename' && req.method === 'POST') {
      const { id, nickname } = await readBody(req);
      const clean = generate.cleanNickname(nickname);
      if (!clean) return sendJson(res, 400, { error: 'A handle cannot be empty.' });
      const identity = await db.renameIdentity(id, clean);
      if (!identity) return sendJson(res, 404, { error: 'Identity not found' });
      return sendJson(res, 200, { id, nickname: clean });
    }

    if (pathname === '/api/settings' && req.method === 'GET') {
      return sendJson(res, 200, await db.getSettings());
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      const patch = {};
      if (body.provider) patch.provider = body.provider;
      if (body.throttleMs != null) patch.throttleMs = clamp(Number(body.throttleMs) || 500, 150, 5000);
      if (body.theme) patch.theme = body.theme;
      if (body.domain !== undefined) patch.domain = String(body.domain || '').trim().toLowerCase();
      if (body.mailApi !== undefined) patch.mailApi = String(body.mailApi || '').trim();
      if (body.mailToken !== undefined) patch.mailToken = String(body.mailToken || '').trim();
      return sendJson(res, 200, await db.updateSettings(patch));
    }

    if (pathname === '/api/settings/test' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const detail = await mail.checkConnection({ ...(await db.getSettings()), ...body });
        return sendJson(res, 200, { ok: true, detail });
      } catch (err) {
        return sendJson(res, 200, { ok: false, detail: err.message });
      }
    }

    if (pathname === '/api/export' && req.method === 'GET') {
      return handleExport(res);
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'Unknown endpoint' });
    }

    // Static files (UI).
    return serveStatic(res, pathname);
  } catch (err) {
    if (!res.writableEnded) sendJson(res, 500, { error: err.message });
  }
});

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* opening a browser is a nicety; ignore failures */
  }
}

await db.ensure();
server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Bulbox running at  ${url}`);
  console.log(`  Database file:          ${db.dbPath()}`);
  console.log(`  Press Ctrl+C to stop.\n`);
  if (process.env.NO_OPEN !== '1') openBrowser(url);
});
