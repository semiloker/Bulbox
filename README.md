# Inbox Forge

A **desktop app** (Electron / Chromium) to generate and manage **100+ real email inboxes**. Each
inbox gets a **handle** (github/gamer-style nickname), an **address**, its own **password/login**,
and a **dedicated in-app browser** with an isolated, persistent session that can route through its
**own Tor exit IP**. Data lives in a plain JSON file (`data/emails.json`).

## Run it

```bash
npm install     # one time (downloads the Chromium runtime)
npm start       # launches the desktop app
```

Prefer the old browser version? `npm run web` starts a local server at http://localhost:3000
(same features, opens in your normal browser).

## What each inbox gives you

- **Mail** — read the inbox right inside the app (it's a real mail.tm address).
- **Browser** — opens an in-window browser panel (toolbar with back/forward/reload + address bar)
  with a **persistent session unique to that email**. Sign in to a site as that identity and the
  cookies are saved and isolated per email. Deleting the row wipes its saved browser data.
- **Password** — the inbox's real login, generated for you and stored so you keep it.

**Generate** makes up to 500 at a time with a live progress bar, auto-throttling and retrying to
respect mail.tm's rate limit (~8 requests/second).

## Per-email exit IP (Tor)

Each email's browser can route through its **own Tor circuit → its own exit IP** (for privacy /
research / geo-testing). One local Tor process is run with a **pool of SocksPorts**; each email is
assigned a distinct port, and different Tor SocksPorts never share circuits.

**Setup:**
1. Install the **Tor Expert Bundle** from torproject.org (or have Tor Browser installed). Note the
   path to `tor.exe`.
2. In **Settings**, tick **"Route each email's browser through its own Tor exit IP"**. If Tor isn't
   auto-detected, paste the `tor.exe` path (or set the `TOR_PATH` env var).
3. Open a row's **Browser** panel — the chip shows `Tor · :<port>`. Click **IP** to load
   `check.torproject.org` and confirm the exit. Open a different email → different exit IP.

### If Tor itself is blocked on your network (bridges)

If Tor won't connect because your network/country censors it, use **bridges** + a pluggable
transport (which disguises the Tor connection):

1. **Settings → Tor connection → Bridges**.
2. Paste **obfs4** (or webtunnel / meek) bridge lines, one per line. Get fresh ones from
   Tor Browser → Settings → Connection → Bridges, Telegram **@GetBridgesBot**, or email
   **bridges@torproject.org** with `get transport obfs4` in the body.
3. **Save.** The app runs Tor through the transport using the `lyrebird` binary bundled with your
   Tor install, so the traffic doesn't look like Tor. The "Detected transports" line shows what's
   available; **Snowflake** additionally needs `snowflake-client.exe` in your Tor's
   `pluggable_transports` folder.

**Limits / honesty:** Tor is slower than direct, and **many sites block Tor exits**. Per-email
**exit country** isn't selectable yet (that needs a per-country Tor instance — planned). This is for
privacy/research/geo-testing and managing your own accounts — **not** for evading platform bans or
mass-creating accounts (and there's deliberately no fingerprint-spoofing/anti-detect).

*Planned (Phase 2):* an optional per-email **Linux sandbox** — a Docker container per chosen
identity with an in-app terminal, sharing that email's Tor circuit.

## Good to know

- **Receive-only.** Great for signups & verification codes; you can't *send* from these.
- **Semi-temporary.** mail.tm may expire inactive inboxes — not for permanent archives.
- **Some sites block temp-mail domains.** Works for most signups, not all.
- **Privacy.** Passwords are stored in plain text in `data/emails.json` on your machine.

## Data & safety

- Your database is `data/emails.json`. Every **delete writes a backup first** to `data/backups/`.
- `INBOX_FORGE_DATA=<dir>` redirects the database elsewhere (used to keep tests isolated).
- Per-email browser sessions are stored by Electron under its user-data directory, keyed per email.

## Files

| Path | What it is |
|------|------------|
| `electron/main.cjs` | Electron main process — IPC handlers, per-email sessions, Tor proxying |
| `electron/preload.cjs` | secure bridge exposing `window.forge` to the UI |
| `providers/mailtm.js` | mail.tm API adapter |
| `lib/db.js` | atomic JSON storage + backups |
| `lib/generate.js` | handle / address / password generators |
| `lib/tor.js` | local Tor manager (SocksPort pool, one exit IP per email) |
| `public/` | the UI (HTML, CSS, JS) — works in Electron *and* the web server |
| `server.js` | optional web-server mode (`npm run web`) |
| `data/emails.json` | your database |

## Environment variables

- `INBOX_FORGE_DATA` — use a different folder for the database.
- `TOR_PATH` — path to `tor.exe` if it isn't auto-detected (also settable in Settings).
- `PORT` — web-server mode port (default `3000`).
- `NO_OPEN=1` — web-server mode: don't auto-open the browser.
