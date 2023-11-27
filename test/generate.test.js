// Self-check for the generators: node test/generate.test.js
import assert from 'node:assert/strict';
import { slugify, randomNickname, localPart, randomPassword, cleanNickname } from '../lib/generate.js';

assert.equal(slugify('Neon Raven!'), 'neonraven');
assert.equal(slugify('---'), 'user', 'empty slug falls back');

for (let i = 0; i < 500; i++) {
  const nick = randomNickname();
  assert.match(nick, /^[a-zA-Z0-9.-]{1,20}$/, `bad nickname: ${nick}`);
  assert.ok(!nick.includes('_'), `handles must not contain underscores: ${nick}`);

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


// A handle the user typed by hand keeps their characters — we only tidy it.
assert.equal(cleanNickname('  My Cool  Handle '), 'My Cool Handle');
assert.equal(cleanNickname('shadowsniper'), 'shadowsniper', 'letters must survive');
assert.equal(cleanNickname('a	b'), 'a b');
assert.equal(cleanNickname('ok' + String.fromCharCode(0) + 'go'), 'ok go', 'control chars become a space');
assert.equal(cleanNickname('x'.repeat(60)).length, 40, 'length is capped');
assert.equal(cleanNickname('   '), '', 'blank is rejected by the callers');
assert.equal(cleanNickname('Привіт-світ'), 'Привіт-світ', 'non-latin handles are fine');

console.log('ok');
