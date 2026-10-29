// electron/capture-preload.cjs — input capture for macro recording.
// Runs, isolated from the page, in the app window and in every email's browser
// panel. While a macro is being recorded it reports raw mouse and keyboard input
// to the main process, which timestamps it; the rest of the time it does nothing.
// Exposes nothing to the page.
const { ipcRenderer, webFrame } = require('electron');

// A page can end up with this preload twice (session-wide and per-webview).
if (!globalThis.__bulboxCapture) {
  globalThis.__bulboxCapture = true;

  let recording = false;
  ipcRenderer.on('rec:recording', (_e, on) => {
    recording = !!on;
  });
  // A page that loads mid-recording — any navigation in the browser panel — asks.
  ipcRenderer
    .invoke('rec:recording')
    .then((on) => {
      recording = !!on;
    })
    .catch(() => {});

  const MOVE_EVERY_MS = 16; // ~60 per second is plenty to replay a path
  let lastMove = 0;

  const send = (e, data) => {
    if (!recording) return;
    // The recorder's own controls are not part of the recording.
    const t = e.target;
    if (t && t.closest && t.closest('[data-rec-ui]')) return;
    ipcRenderer.send('rec:event', {
      ...data,
      shift: e.shiftKey,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      meta: e.metaKey,
    });
  };

  // clientX is in CSS pixels; sendInputEvent wants device-independent ones.
  const point = (e) => {
    const z = webFrame.getZoomFactor() || 1;
    return { x: Math.round(e.clientX * z), y: Math.round(e.clientY * z), buttons: e.buttons };
  };

  const opts = { capture: true, passive: true };
  window.addEventListener(
    'mousemove',
    (e) => {
      if (!recording || e.timeStamp - lastMove < MOVE_EVERY_MS) return;
      lastMove = e.timeStamp;
      send(e, { kind: 'move', ...point(e) });
    },
    opts
  );
  window.addEventListener('mousedown', (e) => send(e, { kind: 'down', button: e.button, clicks: e.detail, ...point(e) }), opts);
  window.addEventListener('mouseup', (e) => send(e, { kind: 'up', button: e.button, clicks: e.detail, ...point(e) }), opts);
  window.addEventListener(
    'wheel',
    (e) => {
      // Line and page deltas (rare on Windows) become roughly what a pixel wheel sends.
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      send(e, { kind: 'wheel', dx: e.deltaX * unit, dy: e.deltaY * unit, ...point(e) });
    },
    opts
  );
  window.addEventListener('keydown', (e) => send(e, { kind: 'keydown', key: e.key, code: e.code, repeat: e.repeat }), opts);
  window.addEventListener('keyup', (e) => send(e, { kind: 'keyup', key: e.key, code: e.code }), opts);
}
