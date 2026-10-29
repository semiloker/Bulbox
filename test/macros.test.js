// Self-check for recorded macros: node test/macros.test.js
// Storage runs against a throwaway directory; the input translation is pure.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bulbox-macros-'));
process.env.BULBOX_DATA = dir;
// Imported dynamically: macros.js resolves its data dir at import time.
const macros = await import('../lib/macros.js');
const { toInputEvents, keyCodeFor, trimTrailingMoves } = macros;

try {
  // --- storage ---
  assert.equal(macros.macrosDir(), path.join(dir, 'macros'));
  assert.deepEqual(await macros.list(), [], 'no folder yet is an empty list, not an error');
  await assert.rejects(() => macros.save({ events: [] }), /Nothing was recorded/);

  const events = [
    { t: 0, target: 'app', type: 'mouseDown', x: 1, y: 2, button: 'left', clickCount: 1 },
    { t: 120, target: 'browser', type: 'keyDown', keyCode: 'a' },
  ];
  const saved = await macros.save({ events, context: { view: 'identities' }, viewport: { width: 800, height: 600 } });
  assert.match(saved.name, /^Recording \d{4}-\d\d-\d\d \d\d:\d\d$/, 'gets a dated default name');
  assert.equal(saved.duration, 120, 'duration is the last event time');
  assert.equal(saved.count, 2);
  assert.equal(saved.events, undefined, 'the summary leaves the events out');

  const full = await macros.get(saved.id);
  assert.deepEqual(full.events, events, 'events round-trip unchanged');
  assert.deepEqual(full.context, { view: 'identities' });

  const second = await macros.save({ name: '  sign   in  ', events });
  assert.equal(second.name, 'sign in', 'names are tidied');
  const listed = await macros.list();
  assert.equal(listed.length, 2);
  assert.ok(listed.every((m) => m.events === undefined), 'the list carries no events');

  assert.equal((await macros.rename(saved.id, 'Open inbox')).name, 'Open inbox');
  assert.equal((await macros.get(saved.id)).name, 'Open inbox');
  assert.deepEqual((await macros.get(saved.id)).events, events, 'renaming keeps the events');
  await assert.rejects(() => macros.rename(saved.id, '   '), /needs a name/);

  // Ids become file names, so anything that isn't one of ours is refused.
  assert.equal(await macros.get('../emails'), null);
  await assert.rejects(() => macros.rename('../../evil', 'x'), /No such macro/);
  assert.deepEqual(await macros.remove('..\\..\\emails'), { removed: 0 });

  assert.deepEqual(await macros.remove(second.id), { removed: 1 });
  assert.deepEqual(await macros.remove(second.id), { removed: 0 }, 'counts only what it removed');
  assert.deepEqual((await macros.list()).map((m) => m.id), [saved.id]);

  await fs.writeFile(path.join(dir, 'macros', 'broken.json'), '{ not json', 'utf8');
  assert.equal((await macros.list()).length, 1, 'a mangled file is skipped');

  // --- mouse ---
  assert.deepEqual(toInputEvents({ kind: 'move', x: 10.4, y: 20.6, buttons: 0 }), [
    { type: 'mouseMove', x: 10, y: 21, modifiers: [] },
  ]);
  assert.deepEqual(
    toInputEvents({ kind: 'move', x: 5, y: 5, buttons: 1 })[0],
    { type: 'mouseMove', x: 5, y: 5, modifiers: ['leftbuttondown'], button: 'left' },
    'a drag carries the held button'
  );
  assert.deepEqual(toInputEvents({ kind: 'down', x: 3, y: 4, button: 2, clicks: 1, buttons: 2, shift: true }), [
    { type: 'mouseDown', x: 3, y: 4, button: 'right', clickCount: 1, modifiers: ['shift', 'rightbuttondown'] },
  ]);
  assert.equal(toInputEvents({ kind: 'up', x: 0, y: 0, button: 0, clicks: 2 })[0].clickCount, 2, 'double clicks survive');
  assert.equal(toInputEvents({ kind: 'up', x: 0, y: 0, button: 0, clicks: 0 })[0].clickCount, 1);

  const wheel = toInputEvents({ kind: 'wheel', x: 1, y: 1, dx: 0, dy: 100 })[0];
  assert.equal(wheel.type, 'mouseWheel');
  assert.equal(wheel.deltaY, -100, 'DOM scroll-down is negative for Electron');
  assert.equal(wheel.canScroll, true);

  // --- keyboard ---
  assert.equal(keyCodeFor('Enter', 'Enter'), 'Enter');
  assert.equal(keyCodeFor('ArrowLeft', 'ArrowLeft'), 'Left');
  assert.equal(keyCodeFor(' ', 'Space'), 'Space');
  assert.equal(keyCodeFor('F5', 'F5'), 'F5');
  assert.equal(keyCodeFor('ф', 'KeyA'), 'a', 'the physical key, whatever the layout');
  assert.equal(keyCodeFor('!', 'Digit1'), '1');
  assert.equal(keyCodeFor('/', 'Slash'), '/');
  assert.equal(keyCodeFor('Dead', 'Quote'), null);
  assert.equal(keyCodeFor('MediaPlayPause', 'MediaPlayPause'), null);

  assert.deepEqual(toInputEvents({ kind: 'keydown', key: 'ф', code: 'KeyA' }), [
    { type: 'keyDown', keyCode: 'a', modifiers: [] },
    { type: 'char', keyCode: 'ф', modifiers: [] },
  ], 'Cyrillic text is typed as itself');
  assert.deepEqual(toInputEvents({ kind: 'keyup', key: 'ф', code: 'KeyA' }), [
    { type: 'keyUp', keyCode: 'a', modifiers: [] },
  ]);

  const shifted = toInputEvents({ kind: 'keydown', key: 'A', code: 'KeyA', shift: true });
  assert.deepEqual(shifted[1], { type: 'char', keyCode: 'A', modifiers: ['shift'] });

  const copyKeys = toInputEvents({ kind: 'keydown', key: 'c', code: 'KeyC', ctrl: true });
  assert.deepEqual(copyKeys, [{ type: 'keyDown', keyCode: 'c', modifiers: ['control'] }], 'Ctrl+C types nothing');
  assert.equal(toInputEvents({ kind: 'keydown', key: 'с', code: 'KeyC', ctrl: true })[0].keyCode, 'c', 'Ctrl+C on a Cyrillic layout');

  const altGr = toInputEvents({ kind: 'keydown', key: '@', code: 'KeyQ', ctrl: true, alt: true });
  assert.equal(altGr.length, 2, 'AltGr (Ctrl+Alt) still types its character');
  assert.equal(altGr[1].keyCode, '@');

  assert.deepEqual(toInputEvents({ kind: 'keydown', key: 'Enter', code: 'Enter' })[1], {
    type: 'char',
    keyCode: '\r',
    modifiers: [],
  }, 'Enter sends the carriage return that submits forms');
  assert.equal(toInputEvents({ kind: 'keydown', key: 'Tab', code: 'Tab' }).length, 1, 'Tab types nothing');
  assert.equal(toInputEvents({ kind: 'keydown', key: 'Backspace', code: 'Backspace' }).length, 1);
  assert.deepEqual(toInputEvents({ kind: 'keydown', key: 'x', code: 'KeyX', repeat: true })[0].modifiers, ['isautorepeat']);
  assert.deepEqual(toInputEvents({ kind: 'keydown', key: 'Dead', code: 'Quote' }), [], 'nothing replayable, nothing kept');

  assert.deepEqual(toInputEvents(null), []);
  assert.deepEqual(toInputEvents({ kind: 'teleport' }), []);

  // --- trimming ---
  const m = (type) => ({ type });
  assert.deepEqual(trimTrailingMoves([m('mouseMove'), m('mouseDown'), m('mouseUp'), m('mouseMove'), m('mouseMove')]), [
    m('mouseMove'),
    m('mouseDown'),
    m('mouseUp'),
  ]);
  assert.deepEqual(trimTrailingMoves([m('mouseMove')]), []);

  console.log('macros: all checks passed');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
