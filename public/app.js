// app.js — renderer for both the Electron app (window.api / IPC) and the web server (fetch).
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  identities: [],
  settings: { provider: 'mail.tm', throttleMs: 500, theme: 'system' },
  selected: new Set(),
  revealed: new Set(),
  filter: '',
  generating: false,
  genOff: null,
  drawerId: null,
};

// Apply saved theme immediately to avoid a flash.
(function () {
  try {
    const t = localStorage.getItem('theme');
    if (t && t !== 'system') document.documentElement.setAttribute('data-theme', t);
  } catch {}
})();

// ---------- data layer: Electron IPC when available, else HTTP ----------
function makeHttpApi() {
  let es = null;
  let progressCb = null;
  const json = (r) => r.json();
  return {
    listIdentities: () => fetch('/api/identities').then(json),
    getSettings: () => fetch('/api/settings').then(json),
    saveSettings: (patch) =>
      fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then(json),
    getDomains: () => fetch('/api/domains').then(json).then((d) => d.domains || []),
    testMail: async (patch) => {
      const r = await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).then(json);
      if (!r.ok) throw new Error(r.detail);
      return r.detail;
    },
    onGenerateProgress: (cb) => {
      progressCb = cb;
      return () => { progressCb = null; };
    },
    generate: (opts) =>
      new Promise((resolve, reject) => {
        const params = new URLSearchParams({ count: opts.count, localPart: opts.localPart, pwStyle: opts.pwStyle, pwLen: opts.pwLen });
        if (opts.domain) params.set('domain', opts.domain);
        es = new EventSource('/api/generate?' + params.toString());
        const close = () => { if (es) { es.close(); es = null; } };
        es.addEventListener('start', (ev) => progressCb && progressCb({ type: 'start', ...JSON.parse(ev.data) }));
        es.addEventListener('progress', (ev) => progressCb && progressCb({ type: 'progress', ...JSON.parse(ev.data) }));
        es.addEventListener('done', (ev) => { const d = JSON.parse(ev.data); close(); resolve(d); });
        es.addEventListener('failed', (ev) => { let m = 'Generation failed'; try { m = JSON.parse(ev.data).message; } catch {} close(); reject(new Error(m)); });
        es.addEventListener('error', () => { if (es) { close(); resolve({ created: 0, failed: 0, aborted: true }); } });
      }),
    cancelGenerate: () => { if (es) { es.close(); es = null; } },
    deleteIdentities: (ids) =>
      fetch('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }).then(json),
    openInbox: async (id) => {
      const r = await fetch('/api/inbox?id=' + encodeURIComponent(id));
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load');
      return d;
    },
    openMessage: async (id, mid) => {
      const r = await fetch(`/api/message?id=${encodeURIComponent(id)}&mid=${encodeURIComponent(mid)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load');
      return d;
    },
    openBrowser: async (id) => {
      const r = await fetch('/api/browser', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to open browser');
      return d;
    },
    exportData: async () => { window.location.href = '/api/export'; return { saved: true }; },
    net: {
      status: async () => ({ running: false, bootstrapped: false, pct: 0, error: 'Tor is only available in the desktop app.' }),
      start: async () => ({ running: false, bootstrapped: false, error: 'Tor is only available in the desktop app.' }),
      apply: async () => ({ enabled: false }),
      clear: async () => ({ ok: true }),
      transports: async () => ({ obfs4: false, meek: false, webtunnel: false, snowflake: false, conjure: false, binaries: [] }),
    },
  };
}

const api = window.forge || makeHttpApi();
const IS_APP = !!window.forge;

// ---------- utilities ----------
const icon = (id) => `<svg class="ic"><use href="#${id}"/></svg>`;
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clampInt = (v, lo, hi, d) => {
  let n = parseInt(v, 10);
  if (!Number.isFinite(n)) n = d;
  return Math.max(lo, Math.min(hi, n));
};
function relTime(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return new Date(iso).toLocaleDateString();
}

let toastTimer;
function toast(msg, ok = true) {
  const t = $('#toast');
  t.innerHTML = (ok ? icon('i-check') : '') + '<span></span>';
  t.querySelector('span').textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('Copied');
    } catch {
      toast('Copy failed', false);
    }
    ta.remove();
  }
}

// ---------- navigation ----------
function showView(name) {
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $('#view-' + name).classList.remove('hidden');
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
}
$$('.nav-item').forEach((n) => n.addEventListener('click', () => showView(n.dataset.view)));
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.goto)));

// ---------- identities table ----------
function filtered() {
  const f = state.filter.trim().toLowerCase();
  if (!f) return state.identities;
  return state.identities.filter(
    (i) => i.email.toLowerCase().includes(f) || i.nickname.toLowerCase().includes(f)
  );
}

function renderRows() {
  const list = filtered();
  const tbody = $('#rows');
  tbody.innerHTML = '';
  for (const it of list) {
    const revealed = state.revealed.has(it.id);
    const tr = document.createElement('tr');
    tr.dataset.id = it.id;
    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" class="rowcheck" ${state.selected.has(it.id) ? 'checked' : ''}></td>
      <td><span class="cell-copy"><span class="mono">${esc(it.email)}</span>
        <button class="copy" data-copy="${esc(it.email)}" title="Copy email">${icon('i-copy')}</button></span></td>
      <td><span class="cell-copy"><span class="nickname">${esc(it.nickname)}</span>
        <button class="copy" data-copy="${esc(it.nickname)}" title="Copy nickname">${icon('i-copy')}</button></span></td>
      <td><span class="pw"><code>${revealed ? esc(it.password) : '•'.repeat(10)}</code>
        <button class="copy toggle-pw" title="${revealed ? 'Hide' : 'Reveal'}">${icon(revealed ? 'i-eye-off' : 'i-eye')}</button>
        <button class="copy" data-copy="${esc(it.password)}" title="Copy password">${icon('i-copy')}</button></span></td>
      <td class="col-when">${relTime(it.createdAt)}</td>
      <td class="col-act"><span class="row-act">
        <button class="icon-btn open-inbox" title="Read this inbox">${icon('i-mail')}Mail</button>
        <button class="icon-btn open-browser" title="Open a dedicated browser for this email (saves cookies &amp; logins)">${icon('i-globe')}Browser</button>
        <button class="icon-btn danger-btn del-one" title="Delete">${icon('i-trash')}</button>
      </span></td>`;
    tbody.appendChild(tr);
  }
  $('.grid').classList.toggle('hidden', state.identities.length === 0);
  $('#emptyState').classList.toggle('show', state.identities.length === 0);
  updateCounts();
}

function updateCounts() {
  $('#navCount').textContent = state.identities.length;
  const n = state.selected.size;
  $('#deleteSelBtn').disabled = n === 0;
  $('#delLabel').textContent = n ? `Delete (${n})` : 'Delete';
  const visible = filtered();
  $('#selectAll').checked = visible.length > 0 && visible.every((i) => state.selected.has(i.id));
}

$('#rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const id = tr.dataset.id;
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) return copy(copyBtn.getAttribute('data-copy'));
  if (e.target.closest('.toggle-pw')) {
    state.revealed.has(id) ? state.revealed.delete(id) : state.revealed.add(id);
    return renderRows();
  }
  if (e.target.closest('.open-inbox')) return openInbox(id);
  if (e.target.closest('.open-browser')) return openBrowser(id);
  if (e.target.closest('.del-one')) return deleteIds([id]);
});
$('#rows').addEventListener('change', (e) => {
  if (!e.target.classList.contains('rowcheck')) return;
  const id = e.target.closest('tr').dataset.id;
  e.target.checked ? state.selected.add(id) : state.selected.delete(id);
  updateCounts();
});
$('#selectAll').addEventListener('change', (e) => {
  const visible = filtered();
  visible.forEach((i) => (e.target.checked ? state.selected.add(i.id) : state.selected.delete(i.id)));
  renderRows();
});
$('#search').addEventListener('input', (e) => {
  state.filter = e.target.value;
  renderRows();
});
$('#exportBtn').addEventListener('click', async () => {
  try {
    const r = await api.exportData();
    if (r && r.saved && r.path) toast('Saved to ' + r.path);
  } catch {
    toast('Export failed', false);
  }
});
$('#deleteSelBtn').addEventListener('click', () => deleteIds([...state.selected]));

async function openBrowser(id) {
  if (IS_APP) return openBrowserPanel(id); // in-window webview panel
  // Web mode: ask the server to launch the system browser with a per-email profile.
  toast('Opening browser…');
  try {
    const data = await api.openBrowser(id);
    if (data && data.browser && data.browser !== 'in-app') toast(`Opened in ${data.browser}`);
  } catch (e) {
    toast(e.message, false);
  }
}

async function deleteIds(ids) {
  if (!ids.length) return;
  const msg = ids.length === 1 ? 'Delete this inbox?' : `Delete ${ids.length} inboxes?`;
  if (!confirm(msg + '\nThis also removes them from the server and clears their saved browser data.')) return;
  try {
    const data = await api.deleteIdentities(ids);
    ids.forEach((id) => state.selected.delete(id));
    await loadIdentities();
    if (bwCurrentId && ids.includes(bwCurrentId)) {
      $('#browserView').innerHTML = '';
      bwWebview = null;
      bwCurrentId = null;
      closeBrowserDrawer();
    }
    toast(`Deleted ${data.removed}`);
  } catch {
    toast('Delete failed', false);
  }
}

async function loadIdentities() {
  const data = await api.listIdentities();
  state.identities = (data.identities || []).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  state.settings = data.settings || state.settings;
  const ids = new Set(state.identities.map((i) => i.id));
  state.selected = new Set([...state.selected].filter((id) => ids.has(id)));
  renderRows();
}

// ---------- generate ----------
const genBtn = $('#genBtn');
const stopBtn = $('#stopBtn');
genBtn.addEventListener('click', startGenerate);
stopBtn.addEventListener('click', () => api.cancelGenerate());

function onProgress(d) {
  if (!d) return;
  if (d.type === 'start') {
    $('#progressTitle').textContent = `Creating ${d.total} @ ${d.domain}`;
    $('#cTotal').textContent = d.total;
    return;
  }
  $('#cCreated').textContent = d.created;
  $('#cFailed').textContent = d.failed;
  $('#barFill').style.width = Math.round((d.index / d.total) * 100) + '%';
  const line = document.createElement('div');
  if (d.identity) {
    line.className = 'ok';
    line.textContent = `✓ ${d.identity.email}`;
  } else {
    line.className = 'err';
    line.textContent = `✗ ${d.error || 'failed'}`;
  }
  $('#genLog').prepend(line);
}

function startGenerate() {
  if (state.generating) return;
  state.generating = true;
  const opts = {
    count: clampInt($('#count').value, 1, 500, 100),
    localPart: $('#localStyle').value,
    pwStyle: $('#pwStyle').value,
    pwLen: clampInt($('#pwLen').value, 8, 64, 16),
    domain: $('#domain').value,
  };

  $('#genLog').innerHTML = '';
  $('#cCreated').textContent = '0';
  $('#cFailed').textContent = '0';
  $('#cTotal').textContent = opts.count;
  $('#barFill').style.width = '0%';
  $('#progressTitle').textContent = 'Starting…';
  genBtn.disabled = true;
  stopBtn.classList.remove('hidden');

  const off = api.onGenerateProgress(onProgress);
  state.genOff = off;

  api
    .generate(opts)
    .then((summary) => {
      cleanupGenerate();
      toast(
        `Created ${summary.created} inbox${summary.created === 1 ? '' : 'es'}` +
          (summary.failed ? `, ${summary.failed} failed` : '') +
          (summary.aborted ? ' (stopped)' : '')
      );
      loadIdentities().then(() => showView('identities'));
    })
    .catch((err) => {
      cleanupGenerate('Failed');
      toast(err.message, false);
      loadIdentities();
    });
}

function cleanupGenerate(title = 'Done') {
  if (state.genOff) {
    state.genOff();
    state.genOff = null;
  }
  state.generating = false;
  genBtn.disabled = false;
  stopBtn.classList.add('hidden');
  $('#progressTitle').textContent = title;
}

// Called again after every settings save: the domain list belongs to the chosen
// provider, so switching provider must replace it instead of piling options up.
async function loadDomains() {
  const sel = $('#domain');
  const pinned = sel.value;
  sel.length = 1; // keep "Auto (recommended)"
  try {
    const domains = (await api.getDomains()) || [];
    for (const d of domains) {
      const o = document.createElement('option');
      o.value = d;
      o.textContent = '@' + d;
      sel.appendChild(o);
    }
    // A domain pinned from the previous provider would silently force every
    // address onto it, so drop it unless the new provider offers it too.
    sel.value = domains.includes(pinned) ? pinned : '';
  } catch {}
}

// ---------- inbox drawer ----------
function openDrawer() {
  const d = $('#drawer');
  d.classList.remove('hidden');
  d.setAttribute('aria-hidden', 'false');
}
function closeDrawer() {
  const d = $('#drawer');
  d.classList.add('hidden');
  d.setAttribute('aria-hidden', 'true');
  state.drawerId = null;
}
$$('[data-close-drawer]').forEach((el) => el.addEventListener('click', closeDrawer));
$('#drawerRefresh').addEventListener('click', refreshInbox);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#browserDrawer').classList.contains('hidden')) closeBrowserDrawer();
  else if (!$('#drawer').classList.contains('hidden')) closeDrawer();
});

async function openInbox(id) {
  state.drawerId = id;
  const it = state.identities.find((i) => i.id === id);
  $('#drawerEmail').textContent = it ? it.email : 'inbox';
  $('#msgView').innerHTML = '<div class="msg-empty">Select a message to read it.</div>';
  openDrawer();
  await refreshInbox();
}

async function refreshInbox() {
  const id = state.drawerId;
  if (!id) return;
  const list = $('#msgList');
  list.innerHTML = '<div class="loading-center"><span class="spinner"></span> Loading…</div>';
  try {
    const data = await api.openInbox(id);
    renderMessages(data.messages);
  } catch (e) {
    list.innerHTML = `<div class="msg-empty">${esc(e.message)}</div>`;
  }
}

function renderMessages(msgs) {
  const list = $('#msgList');
  if (!msgs || !msgs.length) {
    list.innerHTML = '<div class="msg-empty">No messages yet.<br>Send an email to this address to test it.</div>';
    return;
  }
  list.innerHTML = '';
  msgs.forEach((m) => {
    const from = (m.from && (m.from.name || m.from.address)) || 'unknown';
    const div = document.createElement('div');
    div.className = 'msg-item';
    div.innerHTML = `
      <div class="from">${esc(from)}</div>
      <div class="subj">${esc(m.subject || '(no subject)')}</div>
      <div class="intro">${esc(m.intro || '')}</div>
      <div class="when">${relTime(m.createdAt)}</div>`;
    div.addEventListener('click', () => openMessage(m.id, div));
    list.appendChild(div);
  });
}

async function openMessage(mid, el) {
  $$('.msg-item').forEach((x) => x.classList.remove('active'));
  el.classList.add('active');
  const view = $('#msgView');
  view.innerHTML = '<div class="loading-center"><span class="spinner"></span> Loading…</div>';
  try {
    const data = await api.openMessage(state.drawerId, mid);
    renderMessage(data.message);
  } catch (e) {
    view.innerHTML = `<div class="msg-empty">${esc(e.message)}</div>`;
  }
}

function renderMessage(m) {
  const view = $('#msgView');
  const from = (m.from && (m.from.name || m.from.address)) || 'unknown';
  view.innerHTML = `
    <div class="msg-meta">
      <h3>${esc(m.subject || '(no subject)')}</h3>
      <div class="line">From: ${esc(from)}</div>
      <div class="line">${m.createdAt ? new Date(m.createdAt).toLocaleString() : ''}</div>
    </div>`;
  if (m.html) {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', '');
    iframe.srcdoc = m.html;
    view.appendChild(iframe);
  } else {
    const pre = document.createElement('pre');
    pre.className = 'text';
    pre.textContent = m.text || '(empty message)';
    view.appendChild(pre);
  }
}

// ---------- in-window browser panel (Electron) ----------
const BROWSER_HOME = 'https://www.google.com';
let bwWebview = null;
let bwCurrentId = null;
let bwCurrentPass = '';
let bwPassShown = false;

function normalizeUrl(v) {
  v = (v || '').trim();
  if (!v) return '';
  if (/^[a-z]+:\/\//i.test(v)) return v;
  if (/^[^\s.]+\.[^\s]{2,}(\/.*)?$/.test(v)) return 'https://' + v;
  return 'https://www.google.com/search?q=' + encodeURIComponent(v);
}

async function openBrowserPanel(id) {
  const it = state.identities.find((i) => i.id === id);
  if (!it) return;

  // Credential strip (so you can copy email/password WITHOUT closing the browser).
  bwCurrentPass = it.password;
  bwPassShown = false;
  $('#browserEmail').textContent = it.email;
  $('#bwCredNick').textContent = it.nickname || '—';
  $('#bwCredEmail').textContent = it.email;
  $('#bwCredPass').textContent = '••••••••';
  $('#bwRevealPass use').setAttribute('href', '#i-eye');

  // If this same email's browser is still alive, just resume it (don't reload).
  if (bwCurrentId === id && bwWebview) {
    try { $('#bwAddr').value = bwWebview.getURL(); } catch {}
    openBrowserDrawer();
    focusBrowser();
    return;
  }

  bwCurrentId = id;
  const host = $('#browserView');
  host.innerHTML = '';
  bwWebview = null;
  openBrowserDrawer();

  // Configure this email's network route (Tor exit or direct) BEFORE anything loads.
  await applyNetwork(id);

  const wv = document.createElement('webview');
  wv.setAttribute('partition', `persist:mail-${id}`); // isolated, persistent session per email
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('src', BROWSER_HOME);
  host.appendChild(wv);
  bwWebview = wv;
  const addr = $('#bwAddr');
  addr.value = BROWSER_HOME;
  const sync = () => { try { addr.value = wv.getURL(); } catch {} };
  wv.addEventListener('did-navigate', sync);
  wv.addEventListener('did-navigate-in-page', sync);
  wv.addEventListener('dom-ready', focusBrowser, { once: true });
}

// Hiding the drawer takes the webview through display:none, which detaches the
// guest. On the way back clicks land but keystrokes go nowhere until the guest
// is focused again — so focus it explicitly whenever the panel is shown.
function focusBrowser() {
  // Never take focus off something the user is typing into — the address bar and
  // the app's own fields must win over the page inside the panel.
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
  try { if (bwWebview) bwWebview.focus(); } catch {}
}

async function applyNetwork(id) {
  const chip = $('#bwNet');
  if (!IS_APP || !api.net) { chip.textContent = 'direct'; chip.className = 'net-chip'; return; }
  if (!state.settings.torEnabled) {
    try { await api.net.clear(id); } catch {}
    chip.textContent = 'direct'; chip.className = 'net-chip';
    return;
  }
  chip.textContent = 'connecting…'; chip.className = 'net-chip warn';
  try {
    const r = await api.net.apply(id);
    if (r && r.enabled) { chip.textContent = `Tor · :${r.port}`; chip.className = 'net-chip ok'; }
    else { chip.textContent = 'direct'; chip.className = 'net-chip'; }
  } catch (e) {
    try { await api.net.clear(id); } catch {}
    chip.textContent = 'Tor failed'; chip.className = 'net-chip err';
    toast(e.message, false);
  }
}

function openBrowserDrawer() {
  const d = $('#browserDrawer');
  d.classList.remove('hidden');
  d.setAttribute('aria-hidden', 'false');
}
function closeBrowserDrawer() {
  const d = $('#browserDrawer');
  d.classList.add('hidden');
  d.setAttribute('aria-hidden', 'true');
  // Keep the webview alive so reopening the same email resumes where you left off.
}
$$('[data-close-browser]').forEach((el) => el.addEventListener('click', closeBrowserDrawer));

// Credential copy/reveal — usable while the browser is open.
$('#bwCopyNick').addEventListener('click', () => copy($('#bwCredNick').textContent));
$('#bwCopyEmail').addEventListener('click', () => copy($('#bwCredEmail').textContent));
$('#bwCopyPass').addEventListener('click', () => { if (bwCurrentPass) copy(bwCurrentPass); });
$('#bwRevealPass').addEventListener('click', () => {
  bwPassShown = !bwPassShown;
  $('#bwCredPass').textContent = bwPassShown ? bwCurrentPass || '' : '••••••••';
  $('#bwRevealPass use').setAttribute('href', bwPassShown ? '#i-eye-off' : '#i-eye');
});

function bwNavigate() {
  const u = normalizeUrl($('#bwAddr').value);
  if (u && bwWebview) try { bwWebview.loadURL(u); } catch {}
}
$('#bwGo').addEventListener('click', bwNavigate);
$('#bwAddr').addEventListener('keydown', (e) => { if (e.key === 'Enter') bwNavigate(); });
$('#bwBack').addEventListener('click', () => { try { if (bwWebview && bwWebview.canGoBack()) bwWebview.goBack(); } catch {} });
$('#bwFwd').addEventListener('click', () => { try { if (bwWebview && bwWebview.canGoForward()) bwWebview.goForward(); } catch {} });
$('#bwReload').addEventListener('click', () => { try { if (bwWebview) bwWebview.reload(); } catch {} });
$('#bwCheckIp').addEventListener('click', () => { if (bwWebview) try { bwWebview.loadURL('https://check.torproject.org/'); } catch {} });

// ---------- settings + theme ----------
const THEMES = ['system', 'light', 'dark'];
function applyTheme(theme) {
  state.settings.theme = theme;
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  $('#themeLabel').textContent = { system: 'System', light: 'Light', dark: 'Dark' }[theme];
  $('#themeToggle use').setAttribute('href', theme === 'light' ? '#i-sun' : '#i-moon');
  localStorage.setItem('theme', theme);
}
$('#themeToggle').addEventListener('click', () => {
  const next = THEMES[(THEMES.indexOf(state.settings.theme || 'system') + 1) % THEMES.length];
  applyTheme(next);
  api.saveSettings({ theme: next }).catch(() => {});
});

async function loadSettings() {
  try {
    const s = await api.getSettings();
    state.settings = s;
    $('#provider').value = s.provider || 'mail.tm';
    $('#ownDomain').value = s.domain || '';
    $('#mailApi').value = s.mailApi || '';
    $('#mailToken').value = s.mailToken || '';
    $('#throttle').value = s.throttleMs || 500;
    $('#torEnabled').checked = !!s.torEnabled;
    $('#torPath').value = s.torPath || '';
    $('#torBridgeMode').value = s.torBridgeMode || 'none';
    $('#torBridges').value = s.torBridges || '';
    applyTheme(s.theme || 'system');
  } catch {}
  updateProviderVisibility();
  updateBridgeVisibility();
  refreshTransports();
  refreshTorStatus();
  warmTor();
}
// The own-domain fields are noise unless that provider is selected.
function updateProviderVisibility() {
  $('#domainFields').classList.toggle('hidden', $('#provider').value !== 'domain');
}
$('#provider').addEventListener('change', updateProviderVisibility);

$('#testMail').addEventListener('click', async () => {
  const out = $('#testMailResult');
  out.textContent = 'Checking…';
  try {
    out.textContent = await api.testMail({
      provider: $('#provider').value,
      domain: $('#ownDomain').value,
      mailApi: $('#mailApi').value,
      mailToken: $('#mailToken').value,
    });
  } catch (e) {
    out.textContent = e.message;
  }
});

$('#saveSettings').addEventListener('click', async () => {
  try {
    state.settings = await api.saveSettings({
      provider: $('#provider').value,
      domain: $('#ownDomain').value,
      mailApi: $('#mailApi').value,
      mailToken: $('#mailToken').value,
      throttleMs: $('#throttle').value,
      torEnabled: $('#torEnabled').checked,
      torPath: $('#torPath').value,
      torBridgeMode: $('#torBridgeMode').value,
      torBridges: $('#torBridges').value,
    });
    toast('Settings saved');
    loadDomains();
    refreshTransports();
    refreshTorStatus();
    warmTor();
  } catch {
    toast('Save failed', false);
  }
});

$('#torEnabled').addEventListener('change', async () => {
  try {
    state.settings = await api.saveSettings({ torEnabled: $('#torEnabled').checked });
    toast($('#torEnabled').checked ? 'Tor routing on' : 'Tor routing off');
  } catch {}
  if ($('#torEnabled').checked) warmTor();
  refreshTorStatus();
});

let torPollTimer = null;
async function refreshTorStatus() {
  const el = $('#torStatus');
  if (!el) return;
  if (torPollTimer) { clearTimeout(torPollTimer); torPollTimer = null; }
  if (!IS_APP || !api.net) { el.textContent = 'Tor: available only in the desktop app'; return; }
  try {
    const st = await api.net.status();
    if (st.error) el.textContent = 'Tor: ' + st.error;
    else if (st.bootstrapped) el.textContent = 'Tor: connected (100%)';
    else if (st.running) {
      el.textContent = `Tor: starting… ${st.pct || 0}%`;
      torPollTimer = setTimeout(refreshTorStatus, 1500);
    } else {
      el.textContent = state.settings.torEnabled ? 'Tor: starting…' : 'Tor: off';
    }
  } catch {
    el.textContent = 'Tor: unavailable';
  }
}

// Start Tor in the background so it's ready (and the status ticks up) before you open a browser.
function warmTor() {
  if (IS_APP && api.net && state.settings.torEnabled) {
    api.net.start().catch(() => {});
    setTimeout(refreshTorStatus, 400);
  }
}

function updateBridgeVisibility() {
  $('#bridgeField').classList.toggle('hidden', $('#torBridgeMode').value !== 'bridges');
}
$('#torBridgeMode').addEventListener('change', updateBridgeVisibility);

async function refreshTransports() {
  const el = $('#torTransports');
  if (!el) return;
  if (!IS_APP || !api.net || !api.net.transports) { el.textContent = 'Bridges are available only in the desktop app'; return; }
  try {
    const t = await api.net.transports();
    const avail = [];
    if (t.obfs4) avail.push('obfs4');
    if (t.webtunnel) avail.push('webtunnel');
    if (t.meek) avail.push('meek');
    if (t.snowflake) avail.push('snowflake');
    if (t.conjure) avail.push('conjure');
    el.textContent = avail.length ? 'Detected transports: ' + avail.join(', ') : 'No pluggable transports found next to tor.exe';
  } catch {
    el.textContent = '';
  }
}

// ---------- init ----------
(async function init() {
  await Promise.all([loadIdentities(), loadSettings(), loadDomains()]);
})();

// Marker so a smoke test can confirm this script attached all listeners without throwing.
window.__inboxForgeReady = true;
