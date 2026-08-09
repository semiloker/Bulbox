// lib/tor.js
// Manages a single local Tor process configured with a POOL of SocksPorts.
// Different SocksPorts never share circuits, so assigning one port per email gives
// each email its own Tor circuit -> its own exit IP. (Chromium can't auth SOCKS, so
// per-port isolation is the only approach that works through the <webview>.)
//
// Also supports BRIDGES + pluggable transports (obfs4 / webtunnel / meek via lyrebird,
// snowflake, conjure) so Tor can connect from networks where Tor itself is blocked.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const BASE_PORT = 9052;
export const POOL_SIZE = 20;

const stateObj = {
  proc: null,
  ready: false,
  pct: 0,
  torPath: null,
  dataDir: null,
  error: null,
  usingBridges: false,
  key: null,
  pendingKey: null,
};
let startPromise = null;
const idToPort = new Map();
let rr = 0;

function toTorPath(p) {
  return '"' + p.replace(/\\/g, '/') + '"';
}

// Accepts a string (newline-separated) or array; returns clean Bridge lines without the
// leading "Bridge " keyword (we add it back when writing torrc).
function normalizeBridges(input) {
  if (Array.isArray(input)) input = input.join('\n');
  return String(input || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((l) => (/^bridge\s+/i.test(l) ? l.replace(/^bridge\s+/i, '').trim() : l))
    .filter(Boolean);
}

export function buildTorrc(dataDir, opts = {}) {
  const { bridges, transports } = opts;
  const lines = ['Log notice stdout', 'ClientOnly 1', `DataDirectory ${toTorPath(dataDir)}`];
  if (bridges && bridges.length) {
    lines.push('UseBridges 1');
    if (transports) {
      if (transports.lyrebird) {
        lines.push(`ClientTransportPlugin obfs4,meek_lite,webtunnel,scramblesuit exec ${transports.lyrebird}`);
      } else if (transports.obfs4proxy) {
        lines.push(`ClientTransportPlugin obfs4,meek_lite,scramblesuit exec ${transports.obfs4proxy}`);
      }
      if (transports.snowflake) lines.push(`ClientTransportPlugin snowflake exec ${transports.snowflake}`);
      if (transports.conjure) lines.push(`ClientTransportPlugin conjure exec ${transports.conjure}`);
    }
    for (const b of bridges) lines.push(`Bridge ${b}`);
  }
  for (let i = 0; i < POOL_SIZE; i++) lines.push(`SocksPort 127.0.0.1:${BASE_PORT + i}`);
  return lines.join('\n') + '\n';
}

// Stable id -> SocksPort. Distinct ports for distinct emails (round-robin over the pool).
export function getPortForId(id) {
  if (idToPort.has(id)) return idToPort.get(id);
  const port = BASE_PORT + (rr % POOL_SIZE);
  rr += 1;
  idToPort.set(id, port);
  return port;
}

function candidatePaths(explicit) {
  const list = [];
  if (explicit) list.push(explicit);
  if (process.env.TOR_PATH) list.push(process.env.TOR_PATH);
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    const pf = process.env.ProgramFiles || 'C:/Program Files';
    const home = process.env.USERPROFILE || '';
    list.push(
      path.join(local, 'Programs/Tor Browser/Browser/TorBrowser/Tor/tor.exe'),
      'C:/Tor/tor.exe',
      'C:/tor/tor.exe',
      'C:/tor browser/tor/tor.exe',
      'C:/tor browser/Browser/TorBrowser/Tor/tor.exe',
      path.join(home, 'Desktop/Tor Browser/Browser/TorBrowser/Tor/tor.exe'),
      path.join(home, 'Downloads/Tor Browser/Browser/TorBrowser/Tor/tor.exe'),
      path.join(home, 'Downloads/tor/tor.exe'),
      path.join(pf, 'Tor/tor.exe'),
      path.join(pf, 'Tor Browser/Browser/TorBrowser/Tor/tor.exe')
    );
  } else if (process.platform === 'darwin') {
    list.push('/opt/homebrew/bin/tor', '/usr/local/bin/tor', '/usr/bin/tor');
  } else {
    list.push('/usr/bin/tor', '/usr/local/bin/tor');
  }
  return list;
}

async function isFile(p) {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

// Resolve `p` to the tor binary: if it's the executable, use it; if it's a FOLDER
// (e.g. a Tor Browser install root the user pasted), look for tor.exe inside it.
async function resolveBinary(p) {
  if (!p) return null;
  if (await isFile(p)) return p;
  let st;
  try {
    st = await fs.stat(p);
  } catch {
    return null;
  }
  if (st.isDirectory()) {
    const subs = ['tor.exe', 'tor', 'tor/tor.exe', 'Tor/tor.exe', 'Browser/TorBrowser/Tor/tor.exe'];
    for (const s of subs) {
      const cand = path.join(p, s);
      if (await isFile(cand)) return cand;
    }
  }
  return null;
}

// Returns the tor binary path if found (accepts a file OR a folder to search), else null.
export async function findTor(explicit) {
  for (const c of candidatePaths(explicit)) {
    const bin = await resolveBinary(c);
    if (bin) return bin;
  }
  return null;
}

// Find pluggable-transport binaries near the tor executable.
async function findTransports(torBin) {
  const dir = path.dirname(torBin);
  const dirs = [
    path.join(dir, 'pluggable_transports'),
    path.join(dir, 'PluggableTransports'),
    path.join(dir, '..', 'pluggable_transports'),
    path.join(dir, '..', 'PluggableTransports'),
    path.join(dir, 'Tor', 'PluggableTransports'),
    path.join(dir, '..', 'Browser', 'TorBrowser', 'Tor', 'PluggableTransports'),
  ];
  const names = [
    ['lyrebird', 'lyrebird.exe'],
    ['obfs4proxy', 'obfs4proxy.exe'],
    ['snowflake', 'snowflake-client.exe'],
    ['conjure', 'conjure-client.exe'],
  ];
  const found = {};
  for (const d of dirs) {
    for (const [key, file] of names) {
      if (found[key]) continue;
      const p = path.join(d, file);
      if (await isFile(p)) found[key] = p;
    }
  }
  return found;
}

// Which transports are available for a given tor install (for the UI).
export async function listTransports(torPath) {
  const out = { obfs4: false, meek: false, webtunnel: false, snowflake: false, conjure: false, binaries: [] };
  const bin = await findTor(torPath);
  if (!bin) return out;
  const f = await findTransports(bin);
  out.binaries = Object.keys(f);
  if (f.lyrebird || f.obfs4proxy) {
    out.obfs4 = true;
    out.meek = true;
  }
  if (f.lyrebird) out.webtunnel = true;
  if (f.snowflake) out.snowflake = true;
  if (f.conjure) out.conjure = true;
  return out;
}

// Copy a PT binary next to torrc so its path has no spaces (Tor's ClientTransportPlugin
// cannot handle spaces in the exec path). Falls back to the original path on failure.
async function stagePT(dataDir, src) {
  try {
    const ptDir = path.join(dataDir, 'pt');
    await fs.mkdir(ptDir, { recursive: true });
    const dest = path.join(ptDir, path.basename(src));
    await fs.copyFile(src, dest);
    return dest;
  } catch {
    return src;
  }
}

export function status() {
  return {
    running: !!stateObj.proc,
    bootstrapped: stateObj.ready,
    pct: stateObj.pct,
    torPath: stateObj.torPath,
    dataDir: stateObj.dataDir,
    usingBridges: !!stateObj.usingBridges,
    error: stateObj.error,
  };
}

export async function ensureStarted({ torPath, dataDir, bridges } = {}) {
  const key = JSON.stringify({ t: torPath || '', b: normalizeBridges(bridges) });
  if (stateObj.ready && stateObj.key === key) return status();
  if (startPromise && stateObj.pendingKey === key) return startPromise;

  // First start, or the config (path/bridges) changed -> (re)start Tor.
  if (stateObj.proc || stateObj.ready) stop();
  startPromise = null;
  stateObj.pendingKey = key;
  startPromise = _start({ torPath, dataDir, bridges })
    .then((s) => {
      if (stateObj.ready) stateObj.key = key;
      return s;
    })
    .finally(() => {
      if (!stateObj.ready) startPromise = null; // allow retry if bootstrap didn't complete
    });
  return startPromise;
}

async function _start({ torPath, dataDir, bridges }) {
  stateObj.error = null;
  const found = await findTor(torPath);
  // Never fall back to a raw user path (it may be a folder); use PATH as last resort.
  const bin = found || (process.platform === 'win32' ? 'tor.exe' : 'tor');
  stateObj.torPath = bin;

  const dir = dataDir || path.join(os.tmpdir(), 'inbox-forge-tor');
  stateObj.dataDir = dir;
  await fs.mkdir(dir, { recursive: true });

  const normBridges = normalizeBridges(bridges);
  stateObj.usingBridges = normBridges.length > 0;
  let transports = null;
  if (normBridges.length) {
    const avail = await findTransports(bin);
    transports = {};
    for (const key of ['lyrebird', 'obfs4proxy', 'snowflake', 'conjure']) {
      if (avail[key]) transports[key] = await stagePT(dir, avail[key]);
    }
  }

  const torrcPath = path.join(dir, 'torrc');
  await fs.writeFile(torrcPath, buildTorrc(dir, { bridges: normBridges, transports }), 'utf8');

  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve(status());
      }
    };

    let proc;
    try {
      proc = spawn(bin, ['-f', torrcPath], { windowsHide: true });
    } catch (err) {
      stateObj.error = `Could not start Tor: ${err.message}. Install the Tor Expert Bundle or set the Tor path in Settings.`;
      return done();
    }
    stateObj.proc = proc;

    proc.on('error', (err) => {
      stateObj.error = `Could not start Tor (${bin}): ${err.message}. Install the Tor Expert Bundle or set the Tor path in Settings.`;
      stateObj.proc = null;
      done();
    });
    proc.stdout.on('data', (buf) => {
      const s = String(buf);
      const m = s.match(/Bootstrapped (\d+)%/);
      if (m) {
        stateObj.pct = Number(m[1]);
        if (stateObj.pct >= 100) {
          stateObj.ready = true;
          done();
        }
      }
    });
    proc.stderr.on('data', () => {});
    proc.on('exit', (code) => {
      stateObj.proc = null;
      stateObj.ready = false;
      if (!settled && !stateObj.error) stateObj.error = `Tor exited (code ${code}).`;
      done();
    });

    // Bridges/PTs bootstrap slower; give them more time.
    setTimeout(done, normBridges.length ? 180000 : 90000);
  });
}

export function stop() {
  if (stateObj.proc) {
    try {
      stateObj.proc.kill();
    } catch {}
    stateObj.proc = null;
  }
  stateObj.ready = false;
  stateObj.key = null;
}
