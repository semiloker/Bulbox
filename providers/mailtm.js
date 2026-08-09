// providers/mailtm.js
// Thin adapter over the mail.tm (and sister mail.gw) public REST API.
// Docs: https://docs.mail.tm  — no signup, no API key. Rate limit ~8 req/s per IP.

const BASES = {
  'mail.tm': 'https://api.mail.tm',
  'mail.gw': 'https://api.mail.gw',
};

export function baseFor(provider) {
  return BASES[provider] || BASES['mail.tm'];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A single HTTP call with JSON handling and automatic retry on 429 (rate limit).
async function request(base, path, { method = 'GET', token, body, retries = 4 } = {}) {
  const headers = { Accept: 'application/ld+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // Network hiccup — retry a couple of times, then surface it.
      if (attempt++ < retries) {
        await sleep(400 * attempt);
        continue;
      }
      const e = new Error(`Network error contacting ${base}: ${err.message}`);
      e.code = 'NETWORK';
      throw e;
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      if (attempt++ < retries) {
        await sleep(retryAfter ? retryAfter * 1000 : 800 * attempt);
        continue;
      }
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }

    if (!res.ok) {
      const err = new Error(
        (data && (data['hydra:description'] || data.detail || data.message)) ||
          `mail.tm request failed (${res.status})`
      );
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
}

// List active, public domains available for new addresses.
export async function getDomains(provider) {
  const base = baseFor(provider);
  const data = await request(base, '/domains?page=1');
  const members = (data && data['hydra:member']) || [];
  return members
    .filter((d) => d.isActive && !d.isPrivate)
    .map((d) => d.domain);
}

// Create an inbox. Returns the account id. Throws with .status 422 if taken/invalid.
export async function createAccount(provider, address, password) {
  const base = baseFor(provider);
  const data = await request(base, '/accounts', {
    method: 'POST',
    body: { address, password },
  });
  return data.id;
}

// Exchange address+password for a short-lived JWT used to read the inbox.
export async function getToken(provider, address, password) {
  const base = baseFor(provider);
  const data = await request(base, '/token', {
    method: 'POST',
    body: { address, password },
  });
  return data.token;
}

// List messages (headers only) for an inbox.
export async function listMessages(provider, token, page = 1) {
  const base = baseFor(provider);
  const data = await request(base, `/messages?page=${page}`, { token });
  const members = (data && data['hydra:member']) || [];
  return members.map((m) => ({
    id: m.id,
    from: m.from,
    subject: m.subject,
    intro: m.intro,
    seen: m.seen,
    hasAttachments: m.hasAttachments,
    createdAt: m.createdAt,
  }));
}

// Fetch one full message (with text/html body).
export async function getMessage(provider, token, id) {
  const base = baseFor(provider);
  const m = await request(base, `/messages/${id}`, { token });
  return {
    id: m.id,
    from: m.from,
    to: m.to,
    subject: m.subject,
    text: m.text || '',
    html: Array.isArray(m.html) ? m.html.join('\n') : m.html || '',
    createdAt: m.createdAt,
  };
}

// Delete an inbox on the server.
export async function deleteAccount(provider, token, accountId) {
  const base = baseFor(provider);
  await request(base, `/accounts/${accountId}`, { method: 'DELETE', token });
}
