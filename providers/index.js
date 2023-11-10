// providers/index.js
// One entry point for every mail backend. Which backend answers is decided per
// identity, not per app setting, so a database holding addresses from several
// providers keeps working after you switch.

import * as mailtm from './mailtm.js';
import * as tempmailio from './tempmailio.js';
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

const backendOf = (provider) =>
  provider === 'domain' ? 'domain' : provider === 'temp-mail.io' ? 'tempmailio' : 'mailtm';

const providerOf = (settings, identity) =>
  (identity && identity.provider) || settings.provider || 'mail.tm';

export async function getDomains(settings) {
  const provider = settings.provider || 'mail.tm';
  switch (backendOf(provider)) {
    case 'domain':
      return domain.getDomains(settings);
    case 'tempmailio':
      return tempmailio.getDomains();
    default:
      return mailtm.getDomains(provider);
  }
}

// Returns the backend's account id, or null when there is no account to make.
export async function createIdentity(settings, email, password) {
  const provider = settings.provider || 'mail.tm';
  switch (backendOf(provider)) {
    case 'domain':
      return domain.createIdentity();
    case 'tempmailio':
      return tempmailio.createAccount(email);
    default:
      return mailtm.createAccount(provider, email, password);
  }
}

export async function listMessages(settings, identity) {
  const provider = providerOf(settings, identity);
  switch (backendOf(provider)) {
    case 'domain':
      return domain.listMessages(settings, identity);
    case 'tempmailio':
      return tempmailio.listMessages(identity.email);
    default:
      return withToken(provider, identity, (t) => mailtm.listMessages(provider, t));
  }
}

export async function getMessage(settings, identity, id) {
  const provider = providerOf(settings, identity);
  switch (backendOf(provider)) {
    case 'domain':
      return domain.getMessage(settings, identity, id);
    case 'tempmailio':
      return tempmailio.getMessage(identity.email, id);
    default:
      return withToken(provider, identity, (t) => mailtm.getMessage(provider, t, id));
  }
}

export async function deleteIdentity(settings, identity) {
  const provider = providerOf(settings, identity);
  switch (backendOf(provider)) {
    case 'domain':
      return domain.deleteIdentity(settings, identity);
    case 'tempmailio':
      return tempmailio.deleteAccount(identity.email, identity.accountId);
    default:
      return withToken(provider, identity, (t) => mailtm.deleteAccount(provider, t, identity.accountId));
  }
}

// Used by the Settings screen so a broken setup shows up before you generate 500
// addresses against it.
export async function checkConnection(settings) {
  if (settings.provider !== 'domain') return `${settings.provider || 'mail.tm'} needs no setup.`;
  await domain.checkConnection(settings);
  const [d] = domain.getDomains(settings);
  return `Worker answered — mail for @${d} will land here.`;
}
