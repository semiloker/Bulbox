// electron/main.cjs — Electron main process.
// Wires the framework-agnostic lib modules (db, generate, providers) to IPC handlers,
// and opens a persistent, isolated Chromium window per email.

const { app, BrowserWindow, ipcMain, dialog, session, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const HOME_URL = 'https://www.google.com';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bridgeArg = (s) => (s && s.torBridgeMode === 'bridges' ? s.torBridges || '' : '');

// lib/* and providers/* are ES modules — load them via dynamic import.
let libs = null;
async function loadLibs() {
  if (libs) return libs;
  const [db, generate, mail, tor] = await Promise.all([
    import(pathToFileURL(path.join(ROOT, 'lib', 'db.js')).href),
    import(pathToFileURL(path.join(ROOT, 'lib', 'generate.js')).href),
    import(pathToFileURL(path.join(ROOT, 'providers', 'index.js')).href),
    import(pathToFileURL(path.join(ROOT, 'lib', 'tor.js')).href),
  ]);
  libs = { db, generate, mail, tor };
  return libs;
}

let mainWindow = null;
let cancelGen = false;
const smokeConsole = [];

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e0f13',
    title: 'Bulbox',
    autoHideMenuBar: true,
    show: process.env.INBOX_FORGE_SMOKE !== '1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // the per-email browser is an in-window <webview> panel
    },
  });
  if (process.env.INBOX_FORGE_SMOKE === '1') {
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      smokeConsole.push({ level, message, source: String(source || '').split(/[\\/]/).pop(), line });
    });
    mainWindow.webContents.on('preload-error', (_e, p, err) => smokeConsole.push({ preloadError: String(err) }));
  }
  mainWindow.loadFile(path.join(ROOT, 'public', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// A self-contained mini-browser window with its own persistent session partition.
function openBrowserWindow(identity) {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: identity.email,
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'browser-shell.html'), {
    query: { partition: `persist:mail-${identity.id}`, url: HOME_URL, email: identity.email },
  });
  return win;
}

function registerIpc() {
  ipcMain.handle('db:list', async () => (await loadLibs()).db.read());

  ipcMain.handle('settings:get', async () => (await loadLibs()).db.getSettings());

  ipcMain.handle('settings:save', async (_e, patch = {}) => {
    const { db } = await loadLibs();
    const p = {};
    if (patch.provider) p.provider = patch.provider;
    if (patch.throttleMs != null) p.throttleMs = clamp(Number(patch.throttleMs) || 500, 150, 5000);
    if (patch.theme) p.theme = patch.theme;
    if (patch.domain !== undefined) p.domain = String(patch.domain || '').trim().toLowerCase();
    if (patch.mailApi !== undefined) p.mailApi = String(patch.mailApi || '').trim();
    if (patch.mailToken !== undefined) p.mailToken = String(patch.mailToken || '').trim();
    if (typeof patch.torEnabled === 'boolean') p.torEnabled = patch.torEnabled;
    if (patch.torPath !== undefined) p.torPath = String(patch.torPath || '');
    if (patch.torBridgeMode) p.torBridgeMode = patch.torBridgeMode === 'bridges' ? 'bridges' : 'none';
    if (patch.torBridges !== undefined) p.torBridges = String(patch.torBridges || '');
    return db.updateSettings(p);
  });

  // --- per-email network identity (Tor) ---
  ipcMain.handle('net:status', async () => (await loadLibs()).tor.status());

  ipcMain.handle('net:apply', async (_e, id) => {
    const { db, tor } = await loadLibs();
    const s = await db.getSettings();
    const part = session.fromPartition(`persist:mail-${id}`);
    if (!s.torEnabled) {
      await part.setProxy({ mode: 'direct' });
      return { enabled: false };
    }
    const st = await tor.ensureStarted({
      torPath: s.torPath || undefined,
      dataDir: path.join(app.getPath('userData'), 'tor'),
      bridges: bridgeArg(s),
    });
    if (!st.bootstrapped) {
      throw new Error(st.error || `Tor is still starting (${st.pct || 0}%). Try again in a few seconds.`);
    }
    const port = tor.getPortForId(id);
    await part.setProxy({ proxyRules: `socks5://127.0.0.1:${port}` });
    return { enabled: true, port };
  });

  ipcMain.handle('net:clear', async (_e, id) => {
    await session.fromPartition(`persist:mail-${id}`).setProxy({ mode: 'direct' });
    return { ok: true };
  });

  ipcMain.handle('net:start', async () => {
    const { db, tor } = await loadLibs();
    const s = await db.getSettings();
    return tor.ensureStarted({
      torPath: s.torPath || undefined,
      dataDir: path.join(app.getPath('userData'), 'tor'),
      bridges: bridgeArg(s),
    });
  });

  ipcMain.handle('net:transports', async () => {
    const { db, tor } = await loadLibs();
    const s = await db.getSettings();
    return tor.listTransports(s.torPath || undefined);
  });

  ipcMain.handle('domains:get', async () => {
    const { db, mail } = await loadLibs();
    return mail.getDomains(await db.getSettings());
  });

  ipcMain.on('generate:cancel', () => {
    cancelGen = true;
  });

  ipcMain.handle('generate:run', async (e, opts = {}) => {
    const { db, generate, mail } = await loadLibs();
    const count = clamp(parseInt(opts.count) || 100, 1, 500);
    const style = opts.localPart || 'word';
    const pwLen = parseInt(opts.pwLen) || 16;
    const pwStyle = opts.pwStyle || 'strong';
    const s = await db.getSettings();
    const provider = opts.provider || s.provider || 'mail.tm';
    const conf = { ...s, provider };
    let domain = opts.domain || '';
    cancelGen = false;

    const emit = (data) => {
      if (!e.sender.isDestroyed()) e.sender.send('generate:progress', data);
    };

    if (!domain) {
      const domains = await mail.getDomains(conf);
      if (!domains.length) {
        throw new Error(
          provider === 'domain'
            ? 'Set your domain in Settings first (the catch-all domain your worker receives mail for).'
            : 'No mail.tm domains are available right now. Try again shortly.'
        );
      }
      domain = domains[0];
    }
    // A catch-all domain accepts every address offline: nothing to rate-limit.
    const throttleMs = provider === 'domain' ? 0 : clamp(Number(s.throttleMs) || 500, 150, 5000);
    const existing = new Set((await db.read()).identities.map((i) => i.email.toLowerCase()));

    let created = 0;
    let failed = 0;
    emit({ type: 'start', total: count, domain, provider });

    for (let i = 0; i < count && !cancelGen; i++) {
      const nickname = generate.randomNickname();
      let identity = null;
      let lastErr = null;

      for (let attempt = 0; attempt < 6 && !cancelGen; attempt++) {
        const email = `${generate.localPart(style, nickname)}@${domain}`.toLowerCase();
        if (existing.has(email)) continue;
        const password = generate.randomPassword(pwLen, pwStyle);
        try {
          const accountId = await mail.createIdentity(conf, email, password);
          identity = {
            id: db.newId(),
            email,
            nickname,
            password,
            provider,
            accountId,
            active: true,
            createdAt: new Date().toISOString(),
          };
          existing.add(email);
          break;
        } catch (err) {
          lastErr = err;
          if (err.status === 422) continue;
          await sleep(600 * (attempt + 1));
        }
      }

      if (identity) {
        await db.addIdentity(identity);
        created++;
        emit({
          type: 'progress',
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
        emit({
          type: 'progress',
          index: i + 1,
          total: count,
          created,
          failed,
          error: lastErr ? lastErr.message : 'unknown error',
        });
      }

      if (i < count - 1 && !cancelGen) await sleep(throttleMs);
    }

    const aborted = cancelGen;
    cancelGen = false;
    return { created, failed, aborted };
  });

  ipcMain.handle('db:delete', async (_e, ids) => {
    const { db, mail } = await loadLibs();
    if (!Array.isArray(ids) || !ids.length) return { removed: 0, serverDeleted: 0 };
    await db.backup('pre-delete');
    const settings = await db.getSettings();
    let serverDeleted = 0;
    for (const id of ids) {
      const identity = await db.getIdentity(id);
      if (!identity) continue;
      try {
        await mail.deleteIdentity(settings, identity);
        serverDeleted++;
      } catch {
        /* already gone server-side */
      }
      try {
        await session.fromPartition(`persist:mail-${id}`).clearStorageData();
      } catch {
        /* no saved browser data for this identity */
      }
    }
    const removed = await db.removeIdentities(ids);
    return { removed, serverDeleted };
  });

  ipcMain.handle('inbox:open', async (_e, id) => {
    const { db, mail } = await loadLibs();
    const identity = await db.getIdentity(id);
    if (!identity) throw new Error('Identity not found');
    const messages = await mail.listMessages(await db.getSettings(), identity);
    return { email: identity.email, messages };
  });

  ipcMain.handle('message:open', async (_e, { id, mid }) => {
    const { db, mail } = await loadLibs();
    const identity = await db.getIdentity(id);
    if (!identity) throw new Error('Identity not found');
    const message = await mail.getMessage(await db.getSettings(), identity, mid);
    return { message };
  });

  ipcMain.handle('browser:open', async (_e, id) => {
    const { db } = await loadLibs();
    const identity = await db.getIdentity(id);
    if (!identity) throw new Error('Identity not found');
    openBrowserWindow(identity);
    return { ok: true, browser: 'in-app' };
  });

  ipcMain.handle('data:export', async () => {
    const { db } = await loadLibs();
    const data = await db.read();
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export database',
      defaultPath: 'emails.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { saved: false };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return { saved: true, path: filePath };
  });
}

// Make target=_blank / window.open inside a per-email webview load in place,
// instead of spawning stray blank windows.
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() === 'webview') {
    try {
      // Don't leak the real IP over WebRTC when routed through Tor/proxy.
      contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    } catch {}
    contents.setWindowOpenHandler(({ url }) => {
      contents.loadURL(url);
      return { action: 'deny' };
    });
  }
});

// Optional hidden self-test: exercises the full preload->IPC->lib->mail.tm path, then exits.
// Enabled only with INBOX_FORGE_SMOKE=1 (used for automated verification); no-op otherwise.
async function runSmoke() {
  const outPath = process.env.INBOX_FORGE_SMOKE_OUT;
  try {
    await new Promise((res) => {
      if (mainWindow.webContents.isLoadingMainFrame()) mainWindow.webContents.once('did-finish-load', res);
      else res();
    });
    const result = await mainWindow.webContents.executeJavaScript(`(async () => {
      const api = window.forge;
      const out = { hasApi: !!api, hasGenBtn: !!document.querySelector('#genBtn'), hasRows: !!document.querySelector('#rows') };
      if (!api) return out;
      const s = await api.getSettings(); out.theme = s.theme;
      const domains = await api.getDomains(); out.domains = domains.length;
      const summary = await api.generate({ count: 1, localPart: 'word', pwStyle: 'strong', pwLen: 14, domain: '' });
      out.generated = summary;
      const list = await api.listIdentities();
      out.countAfterGen = list.identities.length;
      out.sample = list.identities[0] ? { email: list.identities[0].email, nickname: list.identities[0].nickname, hasPw: !!list.identities[0].password } : null;
      const del = await api.deleteIdentities(list.identities.map(i => i.id));
      out.deleted = del;
      out.countAfterDel = (await api.listIdentities()).identities.length;
      out.netStatus = await api.net.status();
      out.netApply = await api.net.apply(list.identities[0].id);
      out.hasBrowserPanelFn = typeof window.openBrowserPanel === 'function';
      out.canWebview = await (async () => {
        try {
          const w = document.createElement('webview');
          w.setAttribute('partition', 'persist:__probe');
          w.setAttribute('src', 'about:blank');
          document.body.appendChild(w);
          await new Promise((r) => setTimeout(r, 300));
          const ok = typeof w.loadURL === 'function';
          w.remove();
          return ok;
        } catch (e) { return String(e); }
      })();
      return out;
    })()`);
    result.appJsRan = await mainWindow.webContents.executeJavaScript('window.__inboxForgeReady === true');
    result.console = smokeConsole;
    try {
      const testPart = session.fromPartition('persist:__proxytest');
      await testPart.setProxy({ proxyRules: 'socks5://127.0.0.1:9052' });
      result.proxyPlumbing = await testPart.resolveProxy('https://example.com');
    } catch (e) {
      result.proxyPlumbing = 'ERR ' + e.message;
    }
    if (outPath) fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  } catch (err) {
    if (outPath) fs.writeFileSync(outPath, JSON.stringify({ error: String((err && err.message) || err) }));
  } finally {
    app.exit(0);
  }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  await loadLibs();
  await libs.db.ensure();
  registerIpc();
  createMainWindow();
  if (process.env.INBOX_FORGE_SMOKE === '1') runSmoke();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('will-quit', () => {
  if (libs && libs.tor) {
    try {
      libs.tor.stop();
    } catch {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
