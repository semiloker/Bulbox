# Bulbox

A **desktop app** (Electron / Chromium) to generate and manage **100+ real email inboxes**. Each
inbox gets a **handle** (github/gamer-style nickname), an **address**, its own **password/login**,
and a **dedicated in-app browser** with an isolated, persistent session that can route through its
**own Tor exit IP**. Data lives in a plain JSON file (`data/emails.json`).

## Install it

Prebuilt Windows binaries come out of `npm run dist` into `dist/`:

- **Bulbox-Setup-<version>.exe** — a per-user installer (no admin rights, you can pick the folder).
- **Bulbox-portable-<version>.exe** — a single file that keeps its data next to itself.

The build is **unsigned**, so Windows SmartScreen warns the first time: *More info → Run anyway*.
Signing needs a paid certificate and is not worth it for a personal tool.

### Where your data lives

Everything the app stores sits under one folder — shown in **Settings → Data folder**, with a
button that opens it:

```
<home>/
  data/       emails.json, backups/, profiles/, macros/
  sessions/   per-email cookies and logins
  tor/        Tor's data directory
```

`<home>` is the folder beside the **portable** .exe, or a per-user folder for the installed
build (an installed app cannot write to Program Files). Set `BULBOX_HOME` to override it —
point it at a USB stick and the whole setup travels with you. Copying the folder to another
machine carries the identities *and* the logged-in sessions.

## Run it

```bash
npm install     # one time (downloads the Chromium runtime)
npm start       # launches the desktop app
npm test        # runs the self-checks
```

Prefer the old browser version? `npm run web` starts a local server at http://localhost:3000
(same features, opens in your normal browser).

## Where the addresses come from

Switchable in **Settings**:

| Backend | Setup | Domains | Notes |
|---|---|---|---|
| **mail.tm** | none | **1** (`emalupe.com`) | one long-burned domain — the most blocked option |
| **mail.gw** | none | 5 | same operator, domains that read like real businesses |
| **temp-mail.io** | none | 8 | biggest free pool; anyone who knows the address can read it |
| **5minmail** | none | 1 (`zelnro.com`) | youngest domain, so the least blocked today — but see below |
| **DuckDuckGo** | ~2 min | `duck.com` | private aliases on your own Duck account; mail goes to your real mailbox |
| **Own domain** | ~10 min | yours | permanent, not recognisable as throwaway |

Generation spreads addresses across **every** domain a backend offers, round-robin, rather
than burning one — pick a specific one in the Generate screen only if you need to.

**5minmail is a special case.** It gets through where the others don't only because its
single domain is new, and that is temporary by nature — it is `emalupe.com` a few months
earlier. Three things come with it: the inbox dies after **~5 minutes**, the server picks
the address so **handles and local-part styles are ignored** (everything looks like
`u_9mq28cjb2c@`, a pattern that is itself easy to detect), and new addresses are rate
limited to **one per 5 seconds**, so 100 of them take about eight minutes. Good for a
signup where you read the code immediately; useless for an account you want to keep.

No public temp-mail service is unblockable: their domains are on the same lists, and the
only real difference is how well known each one is. If sites keep rejecting you, the fix is
your own domain, not another provider.

### Setting up DuckDuckGo

Addresses are private aliases on **your own** [Duck account](https://duckduckgo.com/email); the
app does not create Duck accounts.

1. Sign in at [duckduckgo.com/email](https://duckduckgo.com/email), open DevTools → **Network**,
   and click **Generate Private Duck Address**.
2. Open the `addresses` request and copy the value of its `Authorization` header.
3. **Settings → Provider → DuckDuckGo**, paste it in, and **Save**.

The endpoint is the one Duck's extension and Bitwarden use; it isn't a public API with published
limits. A rejected token or a rate limit stops the run. The app **can't read this mail** (it
arrives in the mailbox behind your Duck account), so the Mail panel just says so. Deleting a row
only removes it here: the alias keeps forwarding until you turn it off with Duck. The stored
password is for the sites you sign up to, not a login for the address.

### Setting up your own domain

The receiving half lives in `worker/`: Cloudflare Email Routing catches all mail for the
domain, an Email Worker parses it and stores it in D1, and the app reads it over HTTP.
Cloudflare's free tier covers this comfortably (100k worker requests/day, 5 GB in D1).

1. **Get a domain** and point its nameservers at Cloudflare. Note that the Cloudflare side
   is free — only the domain can cost anything, and it does not have to:
   - a normal TLD (~$5–10/yr) is the safest;
   - [`.eu.org`](https://nic.eu.org) is **free**, real and barely associated with abuse,
     but applications are approved by hand (days);
   - [DigitalPlat FreeDomain](https://dash.domain.digitalplat.org) hands out
     `.dpdns.org` / `.qzz.io` / `.us.kg` **free in minutes** and lets you delegate NS to
     Cloudflare. The catch: those TLDs are abused a lot, so some sites block them
     wholesale. Still better than a shared temp-mail domain, and free.
2. **Cloudflare → Email → Email Routing**, enable it and let it add the MX records.
3. **Deploy the worker:**
   ```bash
   cd worker
   npm install
   npx wrangler d1 create bulbox          # paste database_id into wrangler.toml
   npx wrangler d1 execute bulbox --remote --file schema.sql
   npx wrangler secret put API_TOKEN      # invent a long random string
   npx wrangler deploy
   ```
4. **Email Routing → Routing rules → Catch-all**: action **Send to a Worker**, pick
   `bulbox-mail`.
5. In the app: **Settings → Provider → Own domain**, fill in the domain, the worker URL
   and the same `API_TOKEN`, then **Save**.

Generation then runs offline — no API calls, no rate limit, no throttle.

**Reality check:** one domain used for hundreds of signups eventually earns its own place
on the blocklists. The domain buys you a clean start, not immunity.

## What each inbox gives you

- **Mail** — read the inbox right inside the app (a real address either way).
- **Browser** — opens an in-window browser panel (toolbar with back/forward/reload + address bar)
  with a **persistent session unique to that email**. Sign in to a site as that identity and the
  cookies are saved and isolated per email. Deleting the row wipes its saved browser data.
- **Password** — the inbox's real login, generated for you and stored so you keep it.
- **Avatar** — a grid of avatars drawn from this identity's handle (identicon, arcs or
  initials); click one and it lands in the page's image upload field as a real PNG file.
  Generated locally, so no third-party image and no real person's face.
  You can also point it at a picture you chose yourself: paste an image link or pick a file
  from disk (5 MB cap, image content types only). It fetches exactly the one URL you give it
  — there is no crawler here, and whether you may use a given picture is on you.
- **Mail** (in the browser panel) — opens this inbox on top of the page, so a verification code
  can be copied without leaving it.
- **Fill** — puts this identity's handle, email and password into the login form on the page
  you are looking at. It fills and stops; submitting stays your call. Sessions are already
  persistent, so this is for the first sign-in, not for every visit.

**Generate** makes up to 500 at a time with a live progress bar, auto-throttling and retrying to
respect mail.tm's rate limit (~8 requests/second).

## Macros (record & replay)

**Record macro** (bottom of the sidebar, or **Record** in an email's browser panel) captures your
mouse and keyboard everywhere in the app — the app's own screens *and* inside the browser panel —
until you press **Stop**. Each recording is saved to `data/macros/` and listed under **Macros**,
where you can rename it, delete it, **Play** it back at 0.5×–4×, or **Run on…** other inboxes.

- **Playback starts where the recording did.** It goes back to the same screen, reopens the same
  email's browser on the same page, and sizes the window the way it was — clicks are replayed as
  positions, so a different layout would send them somewhere else.
- **Run on…** takes a macro recorded in an email's browser and plays it in every inbox you pick —
  all of them, the ones ticked on the Inboxes screen, or a category — one after another. Each run
  opens that inbox's own browser (its own session, and its own Tor exit when Tor is on) on the
  page the macro started on. Click **Fill**, **Avatar** or **Mail** while recording instead of
  typing an address: on replay they act for whichever inbox is playing.
- **It waits for pages.** Inside the browser, replay pauses while a page is still loading (up to
  15 s), so a slow Tor circuit doesn't make it click on a half-loaded page.
- **Esc or Stop** ends playback, a whole run included. Your own mouse and keyboard still work
  while a macro plays, so keep off the window or your input mixes into it. A dot shows where
  replayed clicks go.
- Typing replays as text, so non-Latin layouts work; a recorded **Ctrl+V** pastes whatever is on
  the clipboard at playback time. Desktop app only — the web version can't replay input.

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
- **Semi-temporary — on mail.tm only.** mail.tm may expire inactive inboxes. Mail on your
  own domain stays in D1 until you delete it.
- **Some sites block temp-mail domains.** That's the whole reason the own-domain backend
  exists.
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
| `electron/capture-preload.cjs` | reports mouse/keyboard input to the main process while a macro records |
| `providers/index.js` | picks the backend per identity, hides mail.tm's tokens |
| `providers/mailtm.js` | mail.tm / mail.gw API adapter |
| `providers/tempmailio.js` | temp-mail.io API adapter (8 public domains) |
| `providers/fiveminmail.js` | 5minmail adapter — assigns its own addresses, 5 min inboxes |
| `providers/duckduckgo.js` | DuckDuckGo adapter — private aliases on your own Duck account |
| `providers/domain.js` | own-domain adapter — talks to the worker |
| `worker/` | Cloudflare Email Worker + D1 schema (deployed separately) |
| `lib/db.js` | atomic JSON storage + backups |
| `lib/generate.js` | handle / address / password generators |
| `lib/tor.js` | local Tor manager (SocksPort pool, one exit IP per email) |
| `lib/macros.js` | macro storage (`data/macros/`) + DOM input → Electron input translation |
| `public/` | the UI (HTML, CSS, JS) — works in Electron *and* the web server |
| `server.js` | optional web-server mode (`npm run web`) |
| `data/emails.json` | your database |

## Environment variables

- `INBOX_FORGE_DATA` — use a different folder for the database.
- `API_TOKEN` — worker-side secret (set with `wrangler secret put`, not an app env var).
- `TOR_PATH` — path to `tor.exe` if it isn't auto-detected (also settable in Settings).
- `PORT` — web-server mode port (default `3000`).
- `NO_OPEN=1` — web-server mode: don't auto-open the browser.

## License

MIT — see [LICENSE](LICENSE).
