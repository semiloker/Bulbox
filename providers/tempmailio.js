// providers/tempmailio.js
// temp-mail.io's public v3 API. No signup and no key, and — the reason it is
// here — a pool of several domains instead of mail.tm's single, long-burned one.
//
// Mind the trade-off: reading an inbox needs nothing but the address, so anyone
// who guesses it can read the mail. Fine for throwaway signups, not for anything
// you would mind a stranger seeing.

const BASE = 'https://api.internal.temp-mail.io/api/v3';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(path, { method = 'GET', body, retries = 3 } = {}) {
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (attempt++ < retries) {
        await sleep(400 * attempt);
        continue;
      }
      const e = new Error(`Network error contacting temp-mail.io: ${err.message}`);
      e.code = 'NETWORK';
      throw e;
    }

    if (res.status === 429 && attempt++ < retries) {
      await sleep(800 * attempt);
      continue;
    }

    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error((data && (data.error || data.message)) || `temp-mail.io request failed (${res.status})`);
      // 400 here means "that local part is taken or invalid" — same meaning the
      // generation loop already gives mail.tm's 422.
      err.status = res.status === 400 ? 422 : res.status;
      throw err;
    }
    return data;
  }
}

// Their router matches the raw address: a percent-encoded @ comes back as
// "Email not found".
const at = (address) => encodeURIComponent(address).replace(/%40/g, '@');

const map = (m) => ({
  id: m.id,
  from: { address: m.from || '', name: '' },
  subject: m.subject || '(no subject)',
  intro: String(m.body_text || '').replace(/\s+/g, ' ').trim().slice(0, 180),
  seen: false,
  hasAttachments: Array.isArray(m.attachments) && m.attachments.length > 0,
  createdAt: m.created_at,
});

export async function getDomains() {
  const data = await request('/domains');
  return (data.domains || []).filter((d) => d.type === 'public').map((d) => d.name);
}

// Returns the delete token, which the app stores as the identity's accountId.
export async function createAccount(address) {
  const [name, domain] = String(address).split('@');
  const data = await request('/email/new', { method: 'POST', body: { name, domain } });
  return data.token;
}

export async function listMessages(address) {
  const data = await request(`/email/${at(address)}/messages`);
  return (Array.isArray(data) ? data : []).map(map);
}

// v3 returns full bodies in the listing, so there is nothing extra to fetch.
export async function getMessage(address, id) {
  const data = await request(`/email/${at(address)}/messages`);
  const m = (Array.isArray(data) ? data : []).find((x) => String(x.id) === String(id));
  if (!m) {
    const err = new Error('Message not found (temp-mail.io may have expired it).');
    err.status = 404;
    throw err;
  }
  return {
    id: m.id,
    from: { address: m.from || '', name: '' },
    to: [{ address }],
    subject: m.subject || '(no subject)',
    text: m.body_text || '',
    html: m.body_html || '',
    createdAt: m.created_at,
  };
}

export async function deleteAccount(address, token) {
  await request(`/email/${at(address)}`, { method: 'DELETE', body: { token } });
}
