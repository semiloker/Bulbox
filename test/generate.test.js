// Self-check for the generators: node test/generate.test.js
import assert from 'node:assert/strict';
import { slugify, randomNickname, localPart, randomPassword } from '../lib/generate.js';

assert.equal(slugify('Neon Raven!'), 'neonraven');
assert.equal(slugify('---'), 'user', 'empty slug falls back');

for (let i = 0; i < 500; i++) {
  const nick = randomNickname();
  assert.match(nick, /^[a-zA-Z0-9._-]{1,20}$/, `bad nickname: ${nick}`);

  for (const style of ['word', 'random', 'nickname']) {
    const lp = localPart(style, nick);
    assert.match(lp, /^[a-z0-9]+$/, `bad local-part (${style}): ${lp}`);
  }

  const pw = randomPassword(16);
  assert.equal(pw.length, 16);
  assert.match(pw, /[a-z]/);
  assert.match(pw, /[A-Z]/);
  assert.match(pw, /[0-9]/);
  assert.match(pw, /[!@#$%^&*\-_=+?]/, `no symbol: ${pw}`);

  assert.equal(randomPassword(4).length, 8, 'length is clamped to >= 8');
  assert.equal(randomPassword(999).length, 64, 'length is clamped to <= 64');
  assert.match(randomPassword(20, 'alnum'), /^[a-zA-Z0-9]{20}$/);
  assert.ok(randomPassword(16, 'memorable').length >= 16);
}

console.log('ok');
