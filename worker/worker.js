// Cloudflare Email Worker: a catch-all inbox for one domain, stored in D1.
//
// Email Routing hands every message for the domain to email(); the HTTP handler
// serves them back to Bulbox. The response shape deliberately mirrors what
// providers/mailtm.js returns, so the app's UI needs no special-casing.

import PostalMime from 'postal-mime';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const head = (r) => ({
  id: r.id,
  from: { address: r.sender, name: r.sender_name || '' },
  subject: r.subject,
  intro: r.intro,
  seen: false,
  hasAttachments: false,
  createdAt: r.created_at,
});

const full = (r) => ({
  id: r.id,
  from: { address: r.sender, name: r.sender_name || '' },
  to: [{ address: r.addr }],
  subject: r.subject,
  text: r.text,
  html: r.html,
  createdAt: r.created_at,
});

export default {
  async email(message, env) {
    const parsed = await PostalMime.parse(message.raw);
    const text = parsed.text || '';
    await env.DB.prepare(
      `INSERT INTO messages (id, addr, sender, sender_name, subject, intro, text, html, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        String(message.to || '').toLowerCase(),
        parsed.from?.address || '',
        parsed.from?.name || '',
        parsed.subject || '(no subject)',
        text.replace(/\s+/g, ' ').trim().slice(0, 180),
        text,
        parsed.html || '',
        new Date().toISOString()
      )
      .run();
  },

  async fetch(request, env) {
    // Single shared secret. Everything below is reachable only with it.
    if (request.headers.get('authorization') !== `Bearer ${env.API_TOKEN}`) {
      return json({ error: 'unauthorized' }, 401);
    }

    const url = new URL(request.url);
    const to = (url.searchParams.get('to') || '').toLowerCase();
    const one = url.pathname.startsWith('/messages/') ? url.pathname.slice(10) : '';

    if (request.method === 'GET' && one) {
      const row = await env.DB.prepare(`SELECT * FROM messages WHERE id = ?`).bind(one).first();
      return row ? json(full(row)) : json({ error: 'message not found' }, 404);
    }

    if (url.pathname === '/messages') {
      if (!to) return json({ error: 'missing ?to=' }, 400);

      if (request.method === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT id, sender, sender_name, subject, intro, created_at FROM messages
           WHERE addr = ? ORDER BY created_at DESC LIMIT 100`
        )
          .bind(to)
          .all();
        return json(results.map(head));
      }

      if (request.method === 'DELETE') {
        const { meta } = await env.DB.prepare(`DELETE FROM messages WHERE addr = ?`).bind(to).run();
        return json({ deleted: meta?.changes || 0 });
      }
    }

    return json({ error: 'not found' }, 404);
  },
};
