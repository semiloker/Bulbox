// providers/domain.js
// Your own domain, via the Cloudflare worker in worker/: Email Routing catches
// every address on the domain, the worker stores it in D1 and serves it back.
// Nothing to register and nothing to expire — an address exists the moment you
// invent it, and its mail stays until you delete it.

function config(settings) {
  const api = String(settings.mailApi || '').trim().replace(/\/+$/, '');
  const token = String(settings.mailToken || '').trim();
  if (!api || !token) {
    throw new Error('Own domain needs the worker URL and its API token — fill them in Settings.');
  }
  return { api, token };
}

async function request(settings, path, method = 'GET') {
  const { api, token } = config(settings);

  let res;
  try {
    res = await fetch(api + path, { method, headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    const e = new Error(`Network error contacting ${api}: ${err.message}`);
    e.code = 'NETWORK';
    throw e;
  }

  if (res.status === 401) {
    const err = new Error('The mail worker rejected the API token — check Settings.');
    err.status = 401;
    throw err;
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && data.error) || `Mail worker request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function getDomains(settings) {
  const domain = String(settings.domain || '').trim().toLowerCase();
  return domain ? [domain] : [];
}

// Catch-all — there is no account to create.
export function createIdentity() {
  return null;
}

export function listMessages(settings, identity) {
  return request(settings, `/messages?to=${encodeURIComponent(identity.email)}`);
}

export function getMessage(settings, identity, id) {
  return request(settings, `/messages/${encodeURIComponent(id)}`);
}

export function deleteIdentity(settings, identity) {
  return request(settings, `/messages?to=${encodeURIComponent(identity.email)}`, 'DELETE');
}
