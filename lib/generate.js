// lib/generate.js
// Crypto-backed generators for handles (github/gamer-style nicknames),
// email local-parts and passwords.

import crypto from 'node:crypto';

// Cool descriptors + creatures/objects — combined into modern internet handles.
const ADJ = [
  'neon', 'void', 'pixel', 'cyber', 'retro', 'hyper', 'glitch', 'lunar', 'toxic',
  'frost', 'shadow', 'turbo', 'chrome', 'static', 'vapor', 'ultra', 'mega', 'dark',
  'solar', 'sonic', 'phantom', 'rogue', 'crimson', 'electric', 'quantum', 'arcane',
  'feral', 'silent', 'crypto', 'digital', 'atomic', 'cosmic', 'hollow', 'savage',
];
const NOUN = [
  'wizard', 'ninja', 'ghost', 'byte', 'wolf', 'raven', 'goblin', 'phantom', 'samurai',
  'reaper', 'panda', 'dragon', 'hacker', 'coder', 'gamer', 'runner', 'sniper', 'vortex',
  'falcon', 'viper', 'yeti', 'otter', 'fox', 'shark', 'hydra', 'golem', 'specter',
  'nomad', 'bandit', 'pilot', 'druid', 'knight', 'wraith', 'titan',
];
const PREFIX = ['itz', 'its', 'the', 'real', 'not', 'ur', 'lil', 'yung', 'mr', 'big', 'prod', 'xX'];
const SUFFIX = ['gg', 'xd', 'ttv', 'dev', 'hd', 'yt', 'og', 'zz', 'io'];

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SYMBOLS = '!@#$%^&*-_=+?';

// --- unbiased randomness (rejection sampling) ---
function randInt(max) {
  const limit = Math.floor(256 / max) * max;
  let b;
  do {
    b = crypto.randomBytes(1)[0];
  } while (b >= limit);
  return b % max;
}
const pick = (pool) => pool[randInt(pool.length)];
const chance = (pct) => randInt(100) < pct;

function pickN(pool, count) {
  let out = '';
  for (let i = 0; i < count; i++) out += pick(pool);
  return out;
}
const digits = (count) => pickN(DIGITS, count);
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
const sep = () => pick(['', '', '-']); // weighted toward none, else a hyphen
const num = () => digits(randInt(2) + 1); // 1–2 trailing digits

function shuffle(str) {
  const arr = str.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join('');
}

export function slugify(str) {
  return (
    String(str)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 24) || 'user'
  );
}

// A modern handle, e.g. "neon-raven", "voidwolf7", "itz_reaper42", "pixelgoblin-gg".
export function randomNickname() {
  const style = randInt(100);
  let h;
  if (style < 45) {
    // adjective + noun (github-ish)
    h = pick(ADJ) + sep() + pick(NOUN);
    if (chance(40)) h += num();
  } else if (style < 65) {
    // prefix + noun
    const p = pick(PREFIX);
    if (p === 'xX') h = 'xX' + pick(NOUN) + 'Xx';
    else h = p + pick(['', '-']) + pick(NOUN) + (chance(45) ? num() : '');
  } else if (style < 85) {
    // adjective + noun + suffix
    h = pick(ADJ) + sep() + pick(NOUN) + pick(['', '-']) + pick(SUFFIX);
  } else {
    // noun + noun / word + number
    h = pick(NOUN) + sep() + pick(NOUN) + (chance(60) ? num() : '');
  }
  // No underscores: some sites reject them in usernames, and they read badly.
  const cleaned = h.replace(/[^a-zA-Z0-9.-]/g, '').slice(0, 20);
  return cleaned || pick(NOUN) + num();
}

// A handle the user typed by hand. Their choice of characters — we only strip
// control characters, collapse whitespace and cap the length.
export function cleanNickname(str) {
  return String(str)
    .replace(/[^\x20-￿]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

// Local-part of the address. style: 'word' | 'random' | 'nickname'
export function localPart(style, nickname) {
  switch (style) {
    case 'random':
      return pickN(LOWER, 3) + pickN(LOWER + DIGITS, 7) + digits(2);
    case 'nickname':
      return slugify(nickname) + digits(3);
    case 'word':
    default:
      return (pick(ADJ) + pick(NOUN) + digits(2)).toLowerCase();
  }
}

// Strong password. style: 'strong' | 'alnum' | 'memorable'
export function randomPassword(length = 16, style = 'strong') {
  length = Math.max(8, Math.min(64, Number(length) || 16));

  if (style === 'memorable') {
    const parts = [pick(ADJ), cap(pick(NOUN)), digits(4)];
    let pw = parts.join('-');
    while (pw.length < length) pw += pick(LOWER);
    return pw;
  }

  const pool = style === 'alnum' ? LOWER + UPPER + DIGITS : LOWER + UPPER + DIGITS + SYMBOLS;
  const required = [pick(LOWER), pick(UPPER), pick(DIGITS)];
  if (style !== 'alnum') required.push(pick(SYMBOLS));
  let pw = required.join('');
  pw += pickN(pool, length - pw.length);
  return shuffle(pw);
}
