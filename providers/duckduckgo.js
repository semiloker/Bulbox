// providers/duckduckgo.js
// Private Duck Addresses, minted on your own DuckDuckGo Email Protection account
// (the same endpoint their extension and Bitwarden's generator use).
//
// Two things make it unlike the other backends, and they are not bugs:
//   * the server picks the address — no handle styles;
//   * mail is forwarded to the mailbox behind your Duck account, so there is
//     nothing here to read, and an alias cannot be deleted through this API.

const BASE = 'https://quack.duckduckgo.com/api/email';

const NO_INBOX =
  'Duck Addresses have no inbox here — mail to this address is forwarded to the mailbox behind your Duck account.';

export async function createAccount(settings) {
  const token = String(settings.duckToken || '').trim().replace(/^bearer\s+/i, '');
  if (!token) {
    const err = new Error('DuckDuckGo needs your account token — fill it in Settings.');
    err.fatal = true;
    throw err;
  }

  let res;
  try {
    res = await fetch(`${BASE}/addresses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    const e = new Error(`Network error contacting DuckDuckGo: ${err.message}`);
    e.code = 'NETWORK';
    throw e;
  }

  // Retrying can't fix either of these, so stop the whole run.
  if (res.status === 401 || res.status === 403) {
    const err = new Error('DuckDuckGo rejected the token — check Settings.');
    err.status = res.status;
    err.fatal = true;
    throw err;
  }
  if (res.status === 429) {
    const err = new Error('DuckDuckGo is rate limiting new addresses — stopped. Try again later.');
    err.status = 429;
    err.fatal = true;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`DuckDuckGo request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json().catch(() => null);
  if (!data || !data.address) throw new Error('DuckDuckGo answered without an address.');
  return { email: `${data.address}@duck.com`.toLowerCase(), accountId: null, expiresAt: null };
}

export function listMessages() {
  throw new Error(NO_INBOX);
}

export function getMessage() {
  throw new Error(NO_INBOX);
}

// ponytail: no delete API, so the alias keeps forwarding; turn it off at duckduckgo.com/email.
export function deleteAccount() {
  return null;
}
