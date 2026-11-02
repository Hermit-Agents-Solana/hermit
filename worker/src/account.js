// Wallets, holder tiers, shell keys and daily limits.
//   Sign-in: the site asks Phantom to sign "HERMIT sign-in\nWallet: <address>\nTime: <iso>" and gets a sess_ token (7 days).
//   Agents use an hk_ key tied to one shell. A shell with no owner gets the "drifter" limits until a wallet claims it.
//   Tiers by $HERMIT held by the owner: free, holder (HOLD_HOLDER), elder (HOLD_ELDER). Before the token exists everyone is free.

import { ed25519 } from '@noble/curves/ed25519';
import { rpc } from './solana.js';

const DAY = 86400000;
const B58 = '[1-9A-HJ-NP-Za-km-z]';
const AUTH_MSG = new RegExp(`^HERMIT sign-in\\nWallet: (${B58}{32,44})\\nTime: (\\S+)$`);
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export const fail = (status, error) => { const e = new Error(error); e.status = status; return e; };
export const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
export const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
export const sha256 = async (s) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
export const newShellId = () => randomHex(8);
export const today = () => new Date().toISOString().slice(0, 10);

export function b58decode(s) {
  let n = 0n;
  for (const c of s) { const i = ALPHABET.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}
export function b58encode(bytes) {
  let n = 0n, s = '';
  for (const b of bytes) n = n * 256n + BigInt(b);
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b) break; s = '1' + s; }
  return s;
}
export const isPubkey = (s) => typeof s === 'string' && new RegExp(`^${B58}{32,44}$`).test(s) && (() => { try { return b58decode(s).length === 32; } catch { return false; } })();

// ---------- tiers ----------
const num = (v, d) => (v != null && v !== '' && Number.isFinite(+v) ? +v : d);
export function tiers(env) {
  return {
    token: env.TOKEN_ADDRESS || null,
    drifter: { name: 'drifter', min: 0, shells: 0, memories: 500, keys: 1, writes: 200 },
    free: { name: 'free', min: 0, shells: 3, memories: 2000, keys: 3, writes: 500 },
    holder: { name: 'holder', min: num(env.HOLD_HOLDER, 1000000), shells: 20, memories: 50000, keys: 20, writes: 5000 },
    elder: { name: 'elder', min: num(env.HOLD_ELDER, 5000000), shells: 100, memories: 250000, keys: 100, writes: 25000 },
  };
}

// $HERMIT held by a wallet. Holders are cached for 10 minutes, everyone else for 30 seconds so a fresh buy counts at once.
export async function holding(env, wallet) {
  if (!env.TOKEN_ADDRESS) return 0;
  const row = await env.DB.prepare('SELECT holds, hold_checked FROM wallets WHERE addr = ?').bind(wallet).first();
  if (row && Date.now() - row.hold_checked < (row.holds >= tiers(env).holder.min ? 10 * 60000 : 30000)) return row.holds;
  let holds = 0;
  try {
    const r = await rpc(env, 'getTokenAccountsByOwner', [wallet, { mint: env.TOKEN_ADDRESS }, { encoding: 'jsonParsed' }]);
    holds = r.value.reduce((t, a) => t + Number(a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
  } catch { return row?.holds ?? 0; }
  await env.DB.prepare('INSERT INTO wallets (addr, holds, hold_checked) VALUES (?1, ?2, ?3) ON CONFLICT(addr) DO UPDATE SET holds = ?2, hold_checked = ?3').bind(wallet, holds, Date.now()).run();
  return holds;
}

export async function tierOf(env, wallet) {
  const t = tiers(env);
  if (!wallet) return { ...t.drifter, holds: 0 };
  if (!env.TOKEN_ADDRESS) return { ...t.free, holds: 0 };
  const holds = await holding(env, wallet);
  return { ...(holds >= t.elder.min ? t.elder : holds >= t.holder.min ? t.holder : t.free), holds };
}

// ---------- who is calling ----------
const bearer = (request) => (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || request.headers.get('x-hermit-key') || '';

export async function session(request, env) {
  const raw = bearer(request);
  if (!raw.startsWith('sess_')) return null;
  if (!/^sess_[0-9a-f]{48}$/.test(raw)) throw fail(401, 'unknown session');
  const row = await env.DB.prepare('SELECT wallet, expires FROM tokens WHERE hash = ?').bind(await sha256(raw)).first();
  if (!row) throw fail(401, 'unknown session');
  if (row.expires < Date.now()) throw fail(401, 'session expired, connect your wallet again');
  return { wallet: row.wallet };
}

// the shell an hk_ key opens, or null when the request carries no key
export async function keyed(request, env) {
  const raw = bearer(request);
  if (!raw.startsWith('hk_')) return null;
  if (!/^hk_[0-9a-f]{48}$/.test(raw)) throw fail(401, 'unknown key');
  const hash = await sha256(raw);
  const key = await env.DB.prepare('SELECT shell, label, last_used FROM keys WHERE hash = ?').bind(hash).first();
  if (!key) throw fail(401, 'unknown key');
  const shell = await env.DB.prepare('SELECT * FROM shells WHERE id = ?').bind(key.shell).first();
  if (!shell) throw fail(401, 'that shell is gone');
  if (Date.now() - key.last_used > 3600000) await env.DB.prepare('UPDATE keys SET last_used = ? WHERE hash = ?').bind(Date.now(), hash).run();
  const agent = (request.headers.get('x-hermit-agent') || '').trim();
  return { shell, agent: /^[\w.@-]{1,40}$/.test(agent) ? agent : key.label };
}

export async function issueKey(env, shell, label) {
  const key = 'hk_' + randomHex(24);
  await env.DB.prepare('INSERT INTO keys (hash, prefix, shell, label, created) VALUES (?, ?, ?, ?, ?)').bind(await sha256(key), key.slice(0, 9), shell, label, Date.now()).run();
  return key;
}

export async function signIn(env, input) {
  const { address, message, signature } = input || {};
  if (!isPubkey(address ?? '') || typeof message !== 'string' || typeof signature !== 'string') throw fail(400, 'bad request');
  const m = message.match(AUTH_MSG);
  if (!m || m[1] !== address) throw fail(400, 'bad message');
  if (!(Math.abs(Date.now() - Date.parse(m[2])) < 15 * 60000)) throw fail(400, 'signature expired, sign again');
  let ok = false;
  try { ok = ed25519.verify(b58decode(signature), new TextEncoder().encode(message), b58decode(address)); } catch {}
  if (!ok) throw fail(401, 'signature does not match the wallet');
  const raw = 'sess_' + randomHex(24);
  const expires = Date.now() + 7 * DAY;
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO wallets (addr) VALUES (?)').bind(address),
    env.DB.prepare('INSERT INTO tokens (hash, wallet, created, expires) VALUES (?, ?, ?, ?)').bind(await sha256(raw), address, Date.now(), expires),
  ]);
  return { session: raw, wallet: address, expires: new Date(expires).toISOString() };
}

// ---------- daily usage ----------
export const ipOf = (request) => 'ip:' + (request.headers.get('cf-connecting-ip') || 'local');
export async function used(env, who, kind) {
  return (await env.DB.prepare('SELECT n FROM usage WHERE who = ? AND kind = ? AND day = ?').bind(who, kind, today()).first())?.n || 0;
}
export async function spend(env, who, kind) {
  await env.DB.prepare('INSERT INTO usage (who, kind, day, n) VALUES (?1, ?2, ?3, 1) ON CONFLICT(who, kind, day) DO UPDATE SET n = n + 1').bind(who, kind, today()).run();
}

export async function me(env, c) {
  if (!c) throw fail(401, 'connect your wallet first');
  const tier = await tierOf(env, c.wallet);
  return { wallet: c.wallet, holds: tier.holds, tier: tier.name, limits: tier, tiers: tiers(env) };
}
