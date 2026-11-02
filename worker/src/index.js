// HERMIT API (Cloudflare Worker + D1 + Vectorize): shared memory for coding agents, with a log anyone can check on Solana.
//   POST /mcp                     MCP over Streamable HTTP, key in Authorization
//   POST /v1/tools/:name          the same tools over plain REST
//   POST /v1/shells               new shell. No wallet: a drifter shell. With a session: yours
//   GET  /v1/shells               your shells
//   GET  /v1/shells/:id           one shell, its keys when it is yours
//   GET  /v1/shells/:id/log       the log with hashes, ?after=seq
//   GET  /v1/shells/:id/anchors   the Solana anchors that cover this shell
//   POST /v1/shells/:id/claim     tie a shell to your wallet (key and session)
//   POST /v1/shells/:id/public    { public } open or close it to everyone
//   POST /v1/shells/:id/keys      { label } another key. DELETE /v1/shells/:id/keys/:prefix revokes one
//   DELETE /v1/shells/:id         delete a shell and its memories
//   GET  /v1/anchors              latest anchors. /v1/anchors/:id adds the leaves
//   GET  /v1/stats                counts, tiers, the anchor wallet
//   POST /v1/auth                 { address, message, signature } wallet sign-in -> sess_ token
//   GET  /v1/me                   your wallet, $HERMIT held, tier

import { fail, ipOf, issueKey, keyed, me, newShellId, session, signIn, spend, tierOf, tiers, used } from './account.js';
import { anchor, anchorDetail, anchors, shellAnchors } from './anchor.js';
import { GENESIS, backfill, dropVectors, log, tools } from './memory.js';
import { handle } from './mcp.js';
import { anchorWallet } from './solana.js';

export const VERSION = '1.0.0';
const DRIFTERS_PER_DAY = 10;
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-hermit-key, x-hermit-agent, mcp-protocol-version, mcp-session-id',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
const label = (v, d) => { const s = String(v ?? '').trim().slice(0, 40); return s || d; };

const sharedShell = (s) => ({ id: s.id, name: s.name, entries: s.seq, head: s.head, anchored: s.anchored, public: !!s.public, created: s.created });

// what this request may do with a shell: owner > key > public reader
async function access(request, env, id) {
  const shell = await env.DB.prepare('SELECT * FROM shells WHERE id = ?').bind(id).first();
  if (!shell) throw fail(404, 'no shell by that id');
  const c = await session(request, env);
  if (c && shell.owner === c.wallet) return { shell, level: 'owner', wallet: c.wallet };
  const k = await keyed(request, env);
  if (k?.shell.id === id) return { shell, level: 'key', wallet: c?.wallet };
  if (shell.public) return { shell, level: 'public', wallet: c?.wallet };
  throw fail(request.headers.get('authorization') ? 403 : 401, 'that shell is private');
}
const requireOwner = (a) => { if (a.level !== 'owner') throw fail(403, 'only the wallet that owns this shell can do that'); };
const requireWrite = (a) => { if (a.level === 'public') throw fail(403, 'you can read this shell, not change it'); };

async function createShell(request, env, input) {
  const c = await session(request, env);
  const tier = await tierOf(env, c?.wallet);
  if (c) {
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM shells WHERE owner = ?').bind(c.wallet).first();
    if (n >= tier.shells) throw fail(429, `that is all ${tier.shells} shells on the ${tier.name} tier`);
  } else {
    if ((await used(env, ipOf(request), 'drifter')) >= DRIFTERS_PER_DAY) throw fail(429, 'that is enough new shells for today. connect a wallet for more');
    await spend(env, ipOf(request), 'drifter');
  }
  const id = newShellId();
  const name = label(input?.name, 'my project');
  await env.DB.prepare('INSERT INTO shells (id, name, owner, head, created) VALUES (?, ?, ?, ?, ?)').bind(id, name, c?.wallet ?? null, GENESIS, Date.now()).run();
  const key = await issueKey(env, id, 'agent');
  return { id, name, key, owner: c?.wallet ?? null, note: 'This key is shown once.' };
}

async function shellDetail(env, a) {
  const out = { ...sharedShell(a.shell), access: a.level };
  if (a.level === 'public') return out;
  const { results } = await env.DB.prepare('SELECT prefix, label, created, last_used FROM keys WHERE shell = ? ORDER BY created').bind(a.shell.id).all();
  const tier = await tierOf(env, a.shell.owner);
  return { ...out, owner: a.shell.owner, tier: tier.name, limits: tier, keys: results };
}

async function removeShell(env, shell) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM entries WHERE shell = ?').bind(shell.id),
    env.DB.prepare('DELETE FROM entries_fts WHERE shell = ?').bind(shell.id),
    env.DB.prepare('DELETE FROM keys WHERE shell = ?').bind(shell.id),
    env.DB.prepare('DELETE FROM shells WHERE id = ?').bind(shell.id),
  ]);
  await dropVectors(env, shell.id, shell.seq);
  return { deleted: shell.id };
}

async function stats(env) {
  const row = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM shells) AS shells, (SELECT COUNT(*) FROM entries) AS entries, (SELECT COUNT(*) FROM anchors WHERE status = 'confirmed') AS anchors").first();
  return { ...row, public_shell: env.PUBLIC_SHELL || null, anchor_wallet: anchorWallet(env), token: env.TOKEN_ADDRESS || null, tiers: tiers(env) };
}

async function shellRoutes(request, env, id, rest, q) {
  const a = await access(request, env, id);
  const m = request.method;
  if (m === 'GET' && rest === '') return json(await shellDetail(env, a));
  if (m === 'GET' && rest === '/log') {
    const after = Math.max(Number(q.get('after')) || 0, 0);
    const limit = Math.min(Math.max(Number(q.get('limit')) || 200, 1), 500);
    return json({ shell: sharedShell(a.shell), entries: await log(env, a.shell, after, limit) });
  }
  if (m === 'GET' && rest === '/anchors') return json({ anchors: await shellAnchors(env, id) });
  if (m === 'DELETE' && rest === '') {
    if (a.shell.owner) requireOwner(a); else requireWrite(a);
    return json(await removeShell(env, a.shell));
  }
  if (m === 'POST' && rest === '/public') {
    if (a.shell.owner) requireOwner(a); else requireWrite(a);
    const on = !!(await request.json().catch(() => ({}))).public;
    await env.DB.prepare('UPDATE shells SET public = ? WHERE id = ?').bind(on ? 1 : 0, id).run();
    return json({ id, public: on });
  }
  if (m === 'POST' && rest === '/keys') {
    requireOwner(a);
    const tier = await tierOf(env, a.shell.owner);
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM keys WHERE shell = ?').bind(id).first();
    if (n >= tier.keys) throw fail(429, `that is all ${tier.keys} keys on the ${tier.name} tier`);
    const input = await request.json().catch(() => ({}));
    return json({ key: await issueKey(env, id, label(input.label, 'agent')), note: 'This key is shown once.' }, 201);
  }
  const del = rest.match(/^\/keys\/(hk_[0-9a-f]{6})$/);
  if (m === 'DELETE' && del) {
    requireOwner(a);
    await env.DB.prepare('DELETE FROM keys WHERE shell = ? AND prefix = ?').bind(id, del[1]).run();
    return json({ revoked: del[1] });
  }
  throw fail(404, 'not found');
}

async function claim(request, env, id) {
  const c = await session(request, env);
  if (!c) throw fail(401, 'connect your wallet first');
  const raw = String((await request.json().catch(() => ({}))).key || '');
  const k = await keyed(new Request(request.url, { headers: { authorization: `Bearer ${raw}` } }), env);
  if (k?.shell.id !== id) throw fail(403, 'that key does not open this shell');
  if (k.shell.owner) throw fail(409, 'this shell already has an owner');
  const tier = await tierOf(env, c.wallet);
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM shells WHERE owner = ?').bind(c.wallet).first();
  if (n >= tier.shells) throw fail(429, `that is all ${tier.shells} shells on the ${tier.name} tier`);
  await env.DB.prepare('UPDATE shells SET owner = ? WHERE id = ? AND owner IS NULL').bind(c.wallet, id).run();
  return json({ id, owner: c.wallet });
}

async function route(request, env) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const body = () => request.json().catch(() => ({}));

  if (p === '/mcp') {
    if (request.method !== 'POST') return new Response('POST only', { status: 405, headers: { ...cors, allow: 'POST' } });
    const a = await keyed(request, env);
    if (!a) throw fail(401, 'send your shell key: Authorization: Bearer hk_...');
    const out = await handle(await request.json().catch(() => null), env, a);
    return out ? json(out) : new Response(null, { status: 202, headers: cors });
  }

  if (request.method === 'GET') {
    if (p === '/' || p === '/v1') return json({ name: 'HERMIT API', version: VERSION, mcp: '/mcp', endpoints: ['/v1/tools/:name', '/v1/shells', '/v1/shells/:id', '/v1/shells/:id/log', '/v1/shells/:id/anchors', '/v1/anchors', '/v1/stats', '/v1/auth', '/v1/me'] });
    if (p === '/v1/stats') return json(await stats(env));
    if (p === '/v1/anchors') return json({ anchors: await anchors(env) });
    if (p === '/v1/me') return json(await me(env, await session(request, env)));
    if (p === '/v1/shells') {
      const c = await session(request, env);
      if (!c) throw fail(401, 'connect your wallet first');
      const { results } = await env.DB.prepare('SELECT * FROM shells WHERE owner = ? ORDER BY created DESC').bind(c.wallet).all();
      return json({ shells: results.map(sharedShell) });
    }
    const m = p.match(/^\/v1\/anchors\/(\d+)$/);
    if (m) {
      const a = await anchorDetail(env, Number(m[1]));
      if (!a) throw fail(404, 'no anchor by that id');
      return json(a);
    }
  }

  if (request.method === 'POST') {
    if (p === '/v1/auth') return json(await signIn(env, await body()));
    if (p === '/v1/shells') return json(await createShell(request, env, await body()), 201);
    const t = p.match(/^\/v1\/tools\/(\w+)$/);
    if (t) {
      const a = await keyed(request, env);
      if (!a) throw fail(401, 'send your shell key: Authorization: Bearer hk_...');
      if (!Object.hasOwn(tools, t[1])) throw fail(404, 'no such tool');
      return json(await tools[t[1]](env, a.shell, await body(), a.agent));
    }
    const c = p.match(/^\/v1\/shells\/([0-9a-f]{16})\/claim$/);
    if (c) return claim(request, env, c[1]);
  }

  const s = p.match(/^\/v1\/shells\/([0-9a-f]{16})(\/.*)?$/);
  if (s) return shellRoutes(request, env, s[1], s[2] || '', url.searchParams);
  throw fail(404, 'not found');
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    try {
      return await route(request, env);
    } catch (e) {
      if (!e.status) console.error(e);
      return json({ error: e.status ? e.message : 'internal error' }, e.status || 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([
      backfill(env).catch((e) => console.error('backfill', e)),
      anchor(env).catch((e) => console.error('anchor', e)),
    ]));
  },
};
