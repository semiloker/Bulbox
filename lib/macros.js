// lib/macros.js
// Recorded mouse & keyboard macros. Each recording is its own JSON file in
// data/macros/ — they can run to thousands of events, and keeping them out of
// emails.json means the generate loop never rewrites them.
// Also holds the pure translation from captured DOM input to the events
// Electron's webContents.sendInputEvent() replays.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_OVERRIDE = process.env.BULBOX_DATA || process.env.INBOX_FORGE_DATA;
const DATA_DIR = DATA_OVERRIDE ? path.resolve(DATA_OVERRIDE) : path.join(__dirname, '..', 'data');
const MACROS_DIR = path.join(DATA_DIR, 'macros');

// Ids come back from the renderer and become file names, so only ever accept
// the UUIDs we hand out — nothing that could walk out of the folder.
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fileFor(id) {
  if (!ID_RE.test(String(id))) throw new Error('No such macro.');
  return path.join(MACROS_DIR, `${id}.json`);
}

export function macrosDir() {
  return MACROS_DIR;
}

const cleanName = (name) => String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);

function defaultName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `Recording ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

// Everything but the events — what the list shows.
function meta({ events, ...rest }) {
  return rest;
}

async function writeAtomic(file, obj) {
  await fs.mkdir(MACROS_DIR, { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj), 'utf8');
  await fs.rename(tmp, file);
}

export async function list() {
  let names;
  try {
    names = await fs.readdir(MACROS_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      out.push(meta(JSON.parse(await fs.readFile(path.join(MACROS_DIR, name), 'utf8'))));
    } catch {
      /* a half-written or hand-mangled file is skipped, not fatal */
    }
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function get(id) {
  try {
    return JSON.parse(await fs.readFile(fileFor(id), 'utf8'));
  } catch {
    return null;
  }
}

export async function save({ name, events, context = null, viewport = null }) {
  if (!Array.isArray(events) || !events.length) throw new Error('Nothing was recorded.');
  const macro = {
    id: crypto.randomUUID(),
    name: cleanName(name) || defaultName(),
    createdAt: new Date().toISOString(),
    duration: events[events.length - 1].t,
    count: events.length,
    viewport,
    context,
    events,
  };
  await writeAtomic(fileFor(macro.id), macro);
  return meta(macro);
}

export async function rename(id, name) {
  const clean = cleanName(name);
  if (!clean) throw new Error('A macro needs a name.');
  const macro = await get(id);
  if (!macro) throw new Error('No such macro.');
  macro.name = clean;
  await writeAtomic(fileFor(id), macro);
  return meta(macro);
}

export async function remove(id) {
  try {
    await fs.unlink(fileFor(id));
    return { removed: 1 };
  } catch {
    return { removed: 0 };
  }
}

// --- captured DOM input -> Electron input events ------------------------------
// The capture preload sends what the DOM saw: { kind, x, y, button, clicks,
// buttons, dx, dy, key, code, repeat, shift, ctrl, alt, meta }. Coordinates are
// already in device-independent pixels relative to the page that got them.

const BUTTON_NAMES = ['left', 'middle', 'right'];

// DOM `key` names that differ from the ones Electron's keyCode understands.
const NAMED_KEYS = {
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Shift: 'Shift',
  Control: 'Control',
  Alt: 'Alt',
  Meta: 'Meta',
  CapsLock: 'Capslock',
  NumLock: 'Numlock',
  ScrollLock: 'Scrolllock',
  PrintScreen: 'PrintScreen',
  ' ': 'Space',
};

const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
const isPrintable = (key) => typeof key === 'string' && [...key].length === 1 && key >= ' ';

// The physical key, for keyDown/keyUp. Letters and digits come from `code`, so a
// shortcut typed on a Cyrillic layout still replays as Ctrl+C rather than Ctrl+с.
export function keyCodeFor(key, code) {
  if (NAMED_KEYS[key]) return NAMED_KEYS[key];
  if (/^F([1-9]|1\d|2[0-4])$/.test(key)) return key;
  const letter = /^Key([A-Z])$/.exec(code || '');
  if (letter) return letter[1].toLowerCase();
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code || '');
  if (digit && isPrintable(key)) return digit[1];
  if (isPrintable(key)) return key;
  return null; // dead keys, media keys, IME: nothing sensible to replay
}

function modifiers(raw, extra = []) {
  const m = [];
  if (raw.shift) m.push('shift');
  if (raw.ctrl) m.push('control');
  if (raw.alt) m.push('alt');
  if (raw.meta) m.push('meta');
  const b = num(raw.buttons);
  if (b & 1) m.push('leftbuttondown');
  if (b & 2) m.push('rightbuttondown');
  if (b & 4) m.push('middlebuttondown');
  return m.concat(extra);
}

// The button held during a move — Chromium needs it for drags and selections.
function heldButton(buttons) {
  const b = num(buttons);
  if (b & 1) return 'left';
  if (b & 2) return 'right';
  if (b & 4) return 'middle';
  return undefined;
}

export function toInputEvents(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const x = num(raw.x);
  const y = num(raw.y);

  switch (raw.kind) {
    case 'move': {
      const ev = { type: 'mouseMove', x, y, modifiers: modifiers(raw) };
      const held = heldButton(raw.buttons);
      if (held) ev.button = held;
      return [ev];
    }
    case 'down':
    case 'up':
      return [
        {
          type: raw.kind === 'down' ? 'mouseDown' : 'mouseUp',
          x,
          y,
          button: BUTTON_NAMES[num(raw.button)] || 'left',
          clickCount: Math.max(1, num(raw.clicks)),
          modifiers: modifiers(raw),
        },
      ];
    case 'wheel':
      // The DOM counts scrolling down as positive, Electron as negative.
      return [
        {
          type: 'mouseWheel',
          x,
          y,
          deltaX: -num(raw.dx),
          deltaY: -num(raw.dy),
          canScroll: true,
          modifiers: modifiers(raw),
        },
      ];
    case 'keydown':
    case 'keyup': {
      const keyCode = keyCodeFor(raw.key, raw.code);
      if (!keyCode) return [];
      const extra = raw.repeat ? ['isautorepeat'] : [];
      if (raw.kind === 'keyup') return [{ type: 'keyUp', keyCode, modifiers: modifiers(raw) }];

      const out = [{ type: 'keyDown', keyCode, modifiers: modifiers(raw, extra) }];
      // Text is inserted by the char event, not by keyDown. Ctrl/Cmd chords are
      // shortcuts, not typing — except Ctrl+Alt, which is AltGr on Windows.
      const shortcut = raw.meta || (raw.ctrl && !raw.alt);
      if (!shortcut) {
        if (raw.key === 'Enter') out.push({ type: 'char', keyCode: '\r', modifiers: modifiers(raw, extra) });
        else if (isPrintable(raw.key)) out.push({ type: 'char', keyCode: raw.key, modifiers: modifiers(raw, extra) });
      }
      return out;
    }
    default:
      return [];
  }
}

// Mouse wandering over to the Stop button is not part of what was recorded.
export function trimTrailingMoves(events) {
  let end = events.length;
  while (end > 0 && events[end - 1].type === 'mouseMove') end--;
  return events.slice(0, end);
}
