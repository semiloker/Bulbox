// lib/browser.js
// Launch a real Chromium browser (Chrome/Edge/Brave) with a per-identity,
// persistent --user-data-dir so each email keeps its own cookies, logins and data.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.INBOX_FORGE_DATA
  ? path.resolve(process.env.INBOX_FORGE_DATA)
  : path.join(__dirname, '..', 'data');
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');

function candidates() {
  const env = process.env.BROWSER_PATH;
  if (process.platform === 'win32') {
    const LOCAL = process.env.LOCALAPPDATA || '';
    return [
      env,
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      path.join(LOCAL, 'Google/Chrome/Application/chrome.exe'),
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    ];
  }
  if (process.platform === 'darwin') {
    return [
      env,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return [
    env,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
  ];
}

let cached;
export async function findBrowser() {
  if (cached !== undefined) return cached;
  for (const c of candidates()) {
    if (!c) continue;
    try {
      await fs.access(c);
      cached = c;
      return c;
    } catch {}
  }
  cached = null;
  return null;
}

export function profileDir(id) {
  return path.join(PROFILES_DIR, id);
}

export function buildArgs(dir, url, extra = []) {
  const args = [`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', ...extra];
  if (url) args.push(url);
  return args;
}

export async function openProfile(id, url) {
  const browser = await findBrowser();
  if (!browser) {
    const err = new Error(
      'No Chrome, Edge or Brave found. Install one, or set BROWSER_PATH to your browser .exe.'
    );
    err.code = 'NO_BROWSER';
    throw err;
  }
  const dir = profileDir(id);
  await fs.mkdir(dir, { recursive: true });
  const child = spawn(browser, buildArgs(dir, url), { detached: true, stdio: 'ignore' });
  child.on('error', () => {}); // don't crash the server if the launch fails
  child.unref();
  return { browser: path.basename(browser), dir };
}

export async function removeProfile(id) {
  try {
    await fs.rm(profileDir(id), { recursive: true, force: true });
  } catch {}
}
