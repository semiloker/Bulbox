// electron/main.cjs — Electron main process.
// Wires the framework-agnostic lib modules (db, generate, providers) to IPC handlers,
// and opens a persistent, isolated Chromium window per email.

const { app, BrowserWindow, ipcMain, dialog, session, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const HOME_URL = 'https://www.google.com';

// --- where everything this app stores lives ---------------------------------
// One visible folder holding the database, the per-email browser sessions and
// Tor's data, so it can be found, backed up or carried to another machine.
//   BULBOX_HOME              explicit override (a USB stick, say)
//   PORTABLE_EXECUTABLE_DIR  set by the portable .exe — keep data beside it
//   userData                 installed build; Program Files is not writable
function resolveHome() {
  const explicit = process.env.BULBOX_HOME || process.env.PORTABLE_EXECUTABLE_DIR;
  if (explicit) return path.join(path.resolve(explicit), 'Bulbox');
  return app.getPath('userData');
}

// Did the caller send storage somewhere throwaway? Read before we set BULBOX_DATA
// ourselves below — the destructive smoke harness refuses to run without this.
const STORAGE_WAS_REDIRECTED = !!(process.env.INBOX_FORGE_DATA || process.env.BULBOX_HOME);

const LEGACY_USER_DATA = app.getPath('userData'); // must be read before setPath below
const HOME = resolveHome();

// A data directory handed to us on the command line wins over the home folder.
// Without this the app would overwrite the caller's BULBOX_DATA/INBOX_FORGE_DATA
// with its own value, and a run meant to be isolated would hit the real database.
const DATA_OVERRIDE = process.env.BULBOX_DATA || process.env.INBOX_FORGE_DATA;
const DATA_DIR = DATA_OVERRIDE ? path.resolve(DATA_OVERRIDE) : path.join(HOME, 'data');
const TOR_DIR = path.join(HOME, 'tor');

// Earlier builds kept the database beside the source tree and the per-email
// sessions loose in userData. Move them in once, so an upgrade doesn't look like
// "all my identities and logins are gone". Runs only while the new layout is
// still empty, and never touches anything it has already moved.
function migrateOldLayout() {
  // Only for the default home. A portable or BULBOX_HOME folder is a deliberate
  // fresh location — pulling the old userData into it would move data the user
  // never asked to move, out of a folder they still expect to be intact.
  if (HOME !== LEGACY_USER_DATA || DATA_OVERRIDE) return;

  const sessions = path.join(HOME, 'sessions');
  try {
    const looksLikeOldSessions =
      fs.existsSync(path.join(LEGACY_USER_DATA, 'Local State')) ||
      fs.existsSync(path.join(LEGACY_USER_DATA, 'Partitions'));
    if (!fs.existsSync(sessions) && looksLikeOldSessions) {
      fs.mkdirSync(sessions, { recursive: true });
      for (const entry of fs.readdirSync(LEGACY_USER_DATA)) {
        if (entry === 'sessions' || entry === 'data' || entry === 'tor') continue;
        try {
          fs.renameSync(path.join(LEGACY_USER_DATA, entry), path.join(sessions, entry));
        } catch {
          /* a locked file stays where it is; the rest still moves */
        }
      }
    }
  } catch {
    /* migration is best-effort — never block startup over it */
  }

  try {
    const from = path.join(ROOT, 'data', 'emails.json');
    const to = path.join(DATA_DIR, 'emails.json');
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.copyFileSync(from, to); // copied, not moved: the original stays as a fallback
    }
  } catch {
    /* same */
  }
}

migrateOldLayout();

// Both must happen before anything reads them: setPath before the app is ready,
// and the env var before loadLibs() imports lib/db.js and lib/browser.js, which
// resolve their data directory at import time.
app.setPath('userData', path.join(HOME, 'sessions'));
process.env.BULBOX_DATA = DATA_DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });

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

// --- in-app updates ----------------------------------------------------------
// Installed builds check GitHub Releases and update themselves. A portable .exe
// cannot: NSIS is what performs the swap, and there is no installation to swap.
// Running from a checkout is excluded too — there is nothing to update there.
let updateState = { status: 'idle' };

function canSelfUpdate() {
  return app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;
}

function tellRenderer() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:state', updateState);
  }
}

function setUpdateState(next) {
  updateState = next;
  tellRenderer();
  return updateState;
}

let autoUpdater = null;
function loadUpdater() {
  if (autoUpdater) return autoUpdater;
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) =>
    setUpdateState({ status: 'downloading', version: info.version })
  );
  autoUpdater.on('update-not-available', () =>
    setUpdateState({ status: 'current', version: app.getVersion() })
  );
  autoUpdater.on('download-progress', (p) =>
    setUpdateState({ status: 'downloading', percent: Math.round(p.percent) })
  );
  autoUpdater.on('update-downloaded', (info) =>
    setUpdateState({ status: 'ready', version: info.version })
  );
  autoUpdater.on('error', (err) =>
    setUpdateState({ status: 'error', message: String((err && err.message) || err) })
  );
  return autoUpdater;
}

async function checkForUpdate() {
  if (!canSelfUpdate()) {
    return setUpdateState({
      status: 'unsupported',
      version: app.getVersion(),
      message: process.env.PORTABLE_EXECUTABLE_DIR
        ? 'The portable build cannot update itself — download the new .exe.'
        : 'Updates apply to the installed build only.',
    });
  }
  try {
    setUpdateState({ status: 'checking' });
    await loadUpdater().checkForUpdates();
  } catch (err) {
    setUpdateState({ status: 'error', message: String((err && err.message) || err) });
  }
  return updateState;
}

function registerIpc() {
  ipcMain.handle('db:list', async () => (await loadLibs()).db.read());

  ipcMain.handle('settings:get', async () => (await loadLibs()).db.getSettings());

  ipcMain.handle('app:version', async () => ({
    version: app.getVersion(),
    updatable: canSelfUpdate(),
  }));

  ipcMain.handle('update:check', async () => checkForUpdate());

  ipcMain.handle('update:install', async () => {
    if (updateState.status !== 'ready') throw new Error('No downloaded update to install.');
    loadUpdater().quitAndInstall();
    return { installing: true };
  });

  // The point of the portable layout is that you can find the folder.
  ipcMain.handle('home:get', async () => HOME);
  ipcMain.handle('home:open', async () => {
    const err = await shell.openPath(HOME);
    if (err) throw new Error(err);
    return { opened: true };
  });

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
      dataDir: TOR_DIR,
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
      dataDir: TOR_DIR,
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

  ipcMain.handle('settings:test', async (_e, patch = {}) => {
    const { db, mail } = await loadLibs();
    // Test what's on screen, not what was last saved.
    return mail.checkConnection({ ...(await db.getSettings()), ...patch });
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
    const domain = opts.domain || '';
    cancelGen = false;

    const emit = (data) => {
      if (!e.sender.isDestroyed()) e.sender.send('generate:progress', data);
    };

    // Some backends hand out the address themselves; for the rest, spread over
    // every domain they offer instead of burning one, which is what gets a
    // domain blocklisted in the first place.
    const assigned = mail.assignsAddresses(conf);
    const pool = assigned ? [] : domain ? [domain] : await mail.getDomains(conf);
    if (!assigned && !pool.length) {
      throw new Error(
        provider === 'domain'
          ? 'Set your domain in Settings first (the catch-all domain your worker receives mail for).'
          : `${provider} has no domains available right now. Try again shortly.`
      );
    }
    const throttleMs = assigned
      ? 5200 // 5minmail allows one new address every 5 seconds
      : provider === 'domain'
        ? 0 // a catch-all domain accepts every address offline: nothing to rate-limit
        : clamp(Number(s.throttleMs) || 500, 150, 5000);
    const existing = new Set((await db.read()).identities.map((i) => i.email.toLowerCase()));

    let created = 0;
    let failed = 0;
    emit({
      type: 'start',
      total: count,
      domain: assigned ? provider : pool.length > 1 ? `${pool.length} domains` : pool[0],
      provider,
    });

    for (let i = 0; i < count && !cancelGen; i++) {
      const nickname = generate.randomNickname();
      let identity = null;
      let lastErr = null;

      for (let attempt = 0; attempt < 6 && !cancelGen; attempt++) {
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

  // Downloads a single image the user chose. Runs here rather than in the
  // renderer so the page's CORS rules don't apply, and it fetches exactly the one
  // URL it is given — nothing crawls, nothing follows links.
  ipcMain.handle('avatar:fetch', async (_e, url) => {
    let parsed;
    try {
      parsed = new URL(String(url).trim());
    } catch {
      throw new Error('That is not a valid link.');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Only http(s) links are supported.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
      res = await fetch(parsed.href, { signal: controller.signal, redirect: 'follow' });
    } catch (err) {
      throw new Error(`Could not load that image: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`The server answered ${res.status} for that link.`);

    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!type.startsWith('image/')) {
      throw new Error(`That link is ${type || 'not an image'} — open the image itself and copy its address.`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) throw new Error('That image is larger than 5 MB.');
    return { base64: buf.toString('base64'), type };
  });

  ipcMain.handle('db:rename', async (_e, { id, nickname }) => {
    const { db, generate } = await loadLibs();
    const clean = generate.cleanNickname(nickname);
    if (!clean) throw new Error('A handle cannot be empty.');
    const identity = await db.renameIdentity(id, clean);
    if (!identity) throw new Error('Identity not found');
    return { id, nickname: clean };
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

  // This harness generates an address and then deletes *every* identity, so it
  // must never be pointed at a real database. Refuse unless the caller explicitly
  // redirected storage somewhere throwaway.
  if (!STORAGE_WAS_REDIRECTED) {
    const msg =
      'Refusing to run the smoke test against the default data folder — set ' +
      'INBOX_FORGE_DATA or BULBOX_HOME to a throwaway directory first.';
    if (outPath) fs.writeFileSync(outPath, JSON.stringify({ error: msg }));
    console.error(msg);
    return app.exit(1);
  }

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
    result.appJsRan = await mainWindow.webContents.executeJavaScript('window.__bulboxReady === true');
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
  // Keep a menu, even though autoHideMenuBar hides it: on Windows and Linux the
  // menu is what owns the standard Ctrl+C/V/X/A/Z accelerators. Dropping it with
  // setApplicationMenu(null) silently kills copy & paste everywhere in the app,
  // including inside each email's browser panel.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }, { role: 'viewMenu' }]));
  await loadLibs();
  await libs.db.ensure();
  registerIpc();
  createMainWindow();
  if (process.env.INBOX_FORGE_SMOKE === '1') runSmoke();
  // One quiet check a few seconds after launch; the UI can ask again any time.
  if (canSelfUpdate()) setTimeout(() => checkForUpdate(), 4000);
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
