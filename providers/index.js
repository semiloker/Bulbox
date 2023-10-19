// providers/index.js
// One entry point for every mail backend. Which backend answers is decided per
// identity, not per app setting, so a database holding both mail.tm addresses
// and own-domain ones keeps working after you switch providers.

import * as mailtm from './mailtm.js';
import * as domain from './domain.js';

// mail.tm hands out short-lived JWTs. Mint one per address and reuse it instead
// of paying a /token round-trip on every read; re-mint on the first 401.
const tokens = new Map();

function tokenFor(provider, identity) {
  const key = `${provider}|${identity.email}`;
  if (!tokens.has(key)) {
    tokens.set(
      key,
      mailtm.getToken(provider, identity.email, identity.password).catch((err) => {
        tokens.delete(key);
        throw err;
      })
    );
  }
  return tokens.get(key);
}

async function withToken(provider, identity, fn) {
  for (let attempt = 0; ; attempt++) {
    const token = await tokenFor(provider, identity);
    try {
      return await fn(token);
    } catch (err) {
      if (err.status !== 401 || attempt > 0) throw err;
      tokens.delete(`${provider}|${identity.email}`);
    }
  }
}

const providerOf = (settings, identity) =>
  (identity && identity.provider) || settings.provider || 'mail.tm';

export async function getDomains(settings) {
  return settings.provider === 'domain'
    ? domain.getDomains(settings)
    : mailtm.getDomains(settings.provider);
}

// Returns the backend's account id, or null when there is no account to make.
export async function createIdentity(settings, email, password) {
  return settings.provider === 'domain'
    ? domain.createIdentity()
    : mailtm.createAccount(settings.provider, email, password);
}

// Used by the Settings screen so a broken setup shows up before you generate 500
// addresses against it.
export async function checkConnection(settings) {
  if (settings.provider !== 'domain') return `${settings.provider || 'mail.tm'} needs no setup.`;
  await domain.checkConnection(settings);
  const [d] = domain.getDomains(settings);
  return `Worker answered — mail for @${d} will land here.`;
}

export async function listMessages(settings, identity) {
  const provider = providerOf(settings, identity);
  return provider === 'domain'
    ? domain.listMessages(settings, identity)
    : withToken(provider, identity, (t) => mailtm.listMessages(provider, t));
}

export async function getMessage(settings, identity, id) {
  const provider = providerOf(settings, identity);
  return provider === 'domain'
    ? domain.getMessage(settings, identity, id)
    : withToken(provider, identity, (t) => mailtm.getMessage(provider, t, id));
}

export async function deleteIdentity(settings, identity) {
  const provider = providerOf(settings, identity);
  return provider === 'domain'
    ? domain.deleteIdentity(settings, identity)
    : withToken(provider, identity, (t) => mailtm.deleteAccount(provider, t, identity.accountId));
}
