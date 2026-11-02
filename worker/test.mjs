// node test.mjs — the whole API against node:sqlite, with stand-ins for Workers AI, Vectorize and Solana.
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519';
import { sqliteD1 } from './d1-sqlite.mjs';
import api from './src/index.js';
import { redact } from './src/redact.js';
import { anchor, rootOf } from './src/anchor.js';
import { memoTx } from './src/solana.js';
import { b58encode, sha256 } from './src/account.js';
import { linkHash, GENESIS } from './src/memory.js';

let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('ok  ', name); } catch (e) { console.error('FAIL', name, '\n', e); process.exitCode = 1; } };

// embeddings: letters counted into a vector, so close texts land close together
const vec = (text) => { const v = new Array(32).fill(0); for (const c of text.toLowerCase()) v[c.charCodeAt(0) % 32]++; const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
const fakeAI = { run: async (_, { text }) => ({ data: text.map(vec) }) };
const fakeVectors = () => {
  const all = new Map();
  return {
    all,
    upsert: async (list) => { for (const v of list) all.set(v.id, v); },
    deleteByIds: async (ids) => { ids.forEach((i) => all.delete(i)); },
    query: async (values, { topK, namespace }) => ({ matches: [...all.values()].filter((v) => v.namespace === namespace).map((v) => ({ id: v.id, score: v.values.reduce((t, x, i) => t + x * values[i], 0) })).sort((a, b) => b.score - a.score).slice(0, topK) }),
  };
};
const freshEnv = (more = {}) => ({ DB: sqliteD1(), AI: fakeAI, VECTORS: fakeVectors(), ...more });

const call = async (env, method, path, { body, auth, headers = {} } = {}) => {
  const r = await api.fetch(new Request('https://x' + path, { method, headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
  return { status: r.status, json: r.status === 202 ? null : await r.json() };
};
const shell = async (env) => (await call(env, 'POST', '/v1/shells', { body: { name: 'demo' }, headers: { 'cf-connecting-ip': String(Math.random()) } })).json;
const tool = async (env, key, name, args = {}) => {
  const r = await call(env, 'POST', '/mcp', { auth: key, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  const res = r.json.result;
  return res.isError ? { error: res.content[0].text } : JSON.parse(res.content[0].text);
};

const seed = crypto.getRandomValues(new Uint8Array(32));
const keypair = Uint8Array.from([...seed, ...ed25519.getPublicKey(seed)]);
const signIn = async (env, s = crypto.getRandomValues(new Uint8Array(32))) => {
  const address = b58encode(ed25519.getPublicKey(s));
  const message = `HERMIT sign-in\nWallet: ${address}\nTime: ${new Date().toISOString()}`;
  const signature = b58encode(ed25519.sign(new TextEncoder().encode(message), s));
  return (await call(env, 'POST', '/v1/auth', { body: { address, message, signature } })).json;
};

// ---------- redaction ----------
await test('redacts the usual secrets', () => {
  for (const [input, what] of [
    ['key is sk-ant-api03-abcdefghijklmnop1234', 'api key'], ['ghp_abcdefghijklmnopqrstuvwxyz123456', 'api key'],
    ['AKIAIOSFODNN7EXAMPLE', 'api key'], ['Authorization: Bearer abcdefghijklmnop123456', 'token'],
    ['DB_PASSWORD=hunter2hunter', 'secret'], ['"api_key": "abc123def456"', 'secret'], ['rpc?api-key=abc123def456', 'secret'],
    ['postgres://me:pass@host/db', 'login'], ['mail me at nico@example.com', 'email'],
    ['-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----', 'private key'],
  ]) {
    const r = redact(input);
    assert.ok(r.redacted.includes(what), `${input} -> ${JSON.stringify(r)}`);
    assert.ok(!r.text.includes('hunter2') && !r.text.includes('abc123def456') && !r.text.includes('ghp_'), r.text);
  }
});
await test('finds a real Solana keypair but leaves a signature alone', () => {
  assert.deepEqual(redact(`wallet ${b58encode(keypair)}`).redacted, ['wallet key']);
  assert.deepEqual(redact(`[${[...keypair].join(',')}]`).redacted, ['wallet key']);
  const sig = b58encode(crypto.getRandomValues(new Uint8Array(64)));
  assert.equal(redact(`tx ${sig}`).text, `tx ${sig}`);
});
await test('finds a seed phrase, leaves prose alone', () => {
  const words = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  assert.deepEqual(redact(`seed: ${words}`).redacted, ['seed phrase']);
  assert.ok(!redact(`1. ${words.split(' ').join('\n2. ')}`).text.includes('abandon'));
  const prose = 'We moved the retry into the worker because the queue kept dropping messages when the deploy ran and nobody noticed for days';
  assert.equal(redact(prose).text, prose);
});
await test('keeps what only looks secret', () => {
  for (const s of ['TOKEN_ADDRESS=HCftE2X71Aoqqo9sxGU3tFeZj8ywZn43LG2d9Yk7pump', 'the token: $HERMIT stays', 'react@18.3.1 and @noble/curves@1.9.7', 'sha256 of the secret is not stored']) assert.equal(redact(s).text, s);
});

// ---------- shells and MCP ----------
await test('a shell needs no wallet and its key opens MCP', async () => {
  const env = freshEnv();
  const s = await shell(env);
  assert.match(s.key, /^hk_[0-9a-f]{48}$/);
  const init = await call(env, 'POST', '/mcp', { auth: s.key, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } } });
  assert.equal(init.json.result.protocolVersion, '2025-06-18');
  assert.match(init.json.result.instructions, /pickup/);
  assert.equal((await call(env, 'POST', '/mcp', { auth: s.key, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status, 202);
  const list = await call(env, 'POST', '/mcp', { auth: s.key, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
  assert.deepEqual(list.json.result.tools.map((t) => t.name), ['pickup', 'recall', 'remember', 'decide', 'plan', 'handoff', 'forget']);
});
await test('MCP refuses a missing or wrong key, and strangers', async () => {
  const env = freshEnv();
  const s = await shell(env);
  assert.equal((await call(env, 'POST', '/mcp', { body: {} })).status, 401);
  assert.equal((await call(env, 'POST', '/mcp', { auth: 'hk_' + '0'.repeat(48), body: {} })).status, 401);
  assert.equal((await call(env, 'GET', `/v1/shells/${s.id}/log`)).status, 401);
  const other = await shell(env);
  assert.equal((await call(env, 'GET', `/v1/shells/${s.id}/log`, { auth: other.key })).status, 403);
  const odd = await call(env, 'POST', '/mcp', { auth: s.key, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'toString' } } });
  assert.equal(odd.json.error.code, -32602);
});
await test('the next agent picks up where the last one stopped', async () => {
  const env = freshEnv();
  const { key } = await shell(env);
  await tool(env, key, 'decide', { text: 'Use D1 for the log', why: 'one writer at a time keeps the chain simple' });
  await tool(env, key, 'remember', { text: 'Never change the hash format', kind: 'constraint' });
  await tool(env, key, 'plan', { text: 'first plan' });
  await tool(env, key, 'plan', { text: 'second plan' });
  await tool(env, key, 'handoff', { text: 'Routes done, tests left' });
  const p = await tool(env, key, 'pickup');
  assert.equal(p.plan.text, 'second plan');
  assert.equal(p.handoff.text, 'Routes done, tests left');
  assert.match(p.decisions[0].text, /Why: one writer/);
  assert.equal(p.constraints[0].kind, 'constraint');
  assert.equal(p.entries, 5);
});
await test('writes are signed by the agent header or the key label', async () => {
  const env = freshEnv();
  const { key, id } = await shell(env);
  await call(env, 'POST', '/v1/tools/remember', { auth: key, body: { text: 'one' }, headers: { 'x-hermit-agent': 'cursor' } });
  await tool(env, key, 'remember', { text: 'two' });
  const { entries } = (await call(env, 'GET', `/v1/shells/${id}/log`, { auth: key })).json;
  assert.deepEqual(entries.map((e) => e.agent), ['cursor', 'agent']);
});
await test('recall finds by meaning and by exact word, and hides what was replaced', async () => {
  const env = freshEnv();
  const { key } = await shell(env);
  const a = await tool(env, key, 'remember', { text: 'The retry logic lives in src/queue_runner.js' });
  await tool(env, key, 'remember', { text: 'Deploys go out on Tuesday' });
  assert.equal((await tool(env, key, 'recall', { query: 'queue_runner' })).memories[0].id, a.id);
  await tool(env, key, 'remember', { text: 'Retry logic moved to src/backoff.js', supersedes: a.id });
  const m = (await tool(env, key, 'recall', { query: 'queue_runner retry logic' })).memories;
  assert.ok(!m.some((x) => x.id === a.id));
  assert.ok(m.some((x) => /backoff/.test(x.text)));
  assert.equal((await tool(env, key, 'remember', { text: 'x', supersedes: a.id })).error, `entry ${a.id} was already replaced by entry 3`);
});
await test('recall works with the vector index down', async () => {
  const env = freshEnv({ AI: { run: async () => { throw new Error('down'); } } });
  const { key } = await shell(env);
  await tool(env, key, 'remember', { text: 'Port 8795 is taken by relay-sol' });
  assert.equal((await tool(env, key, 'recall', { query: '8795' })).memories.length, 1);
});
await test('a close duplicate is flagged, and the cron indexes what was missed', async () => {
  const env = freshEnv();
  const { key } = await shell(env);
  await tool(env, key, 'decide', { text: 'Ship the free tier without a wallet' });
  const r = await tool(env, key, 'decide', { text: 'Ship the free tier without a wallet, always' });
  assert.equal(r.may_conflict[0].id, 1);
  const down = freshEnv({ AI: { run: async () => { throw new Error('down'); } } });
  const s2 = await shell(down);
  await tool(down, s2.key, 'remember', { text: 'later' });
  assert.equal(down.VECTORS.all.size, 0);
  down.AI = fakeAI;
  await api.scheduled({}, down, { waitUntil: (p) => p });
  await new Promise((r2) => setTimeout(r2, 20));
  assert.equal(down.VECTORS.all.size, 1);
});
await test('a secret never reaches storage, and the agent is told', async () => {
  const env = freshEnv();
  const { key, id } = await shell(env);
  const r = await tool(env, key, 'remember', { text: `Hot wallet is ${b58encode(keypair)} on the VPS` });
  assert.deepEqual(r.redacted, ['wallet key']);
  const raw = JSON.stringify((await call(env, 'GET', `/v1/shells/${id}/log`, { auth: key })).json);
  assert.ok(!raw.includes(b58encode(keypair)));
  assert.ok(!JSON.stringify([...env.VECTORS.all.values()]).includes(b58encode(keypair)));
});

// ---------- the chain ----------
const verify = async (entries, id) => {
  let prev = GENESIS;
  for (const e of entries) {
    assert.equal(e.prev, prev);
    assert.equal(await linkHash({ ...e, shell: id }), e.hash);
    if (e.text !== null) assert.equal(await sha256(e.text), e.content_hash);
    prev = e.hash;
  }
  return prev;
};
await test('the log verifies, and still verifies after forgetting', async () => {
  const env = freshEnv();
  const { key, id } = await shell(env);
  const a = await tool(env, key, 'remember', { text: 'one' });
  await tool(env, key, 'decide', { text: 'two', why: 'because' });
  await tool(env, key, 'plan', { text: 'three' });
  const f = await tool(env, key, 'forget', { id: a.id, reason: 'was wrong' });
  assert.equal(f.forgot, a.id);
  const { entries, shell: meta } = (await call(env, 'GET', `/v1/shells/${id}/log`, { auth: key })).json;
  assert.equal(entries[0].text, null);
  assert.equal(await verify(entries, id), meta.head);
  assert.ok(!(await tool(env, key, 'recall', { query: 'one' })).memories.some((m) => m.id === a.id));
  assert.equal(env.VECTORS.all.size, 2);
  const tampered = entries.map((e, i) => (i === 1 ? { ...e, agent: 'someone else' } : e));
  await assert.rejects(verify(tampered, id));
  await assert.rejects(verify(entries.map((e, i) => (i === 2 ? { ...e, text: 'other text' } : e)), id));
});
await test('two writers at once both land and the chain holds', async () => {
  const env = freshEnv();
  const { key, id } = await shell(env);
  const out = await Promise.all(Array.from({ length: 6 }, (_, i) => tool(env, key, 'remember', { text: `note ${i}` })));
  assert.ok(out.every((r) => r.id));
  const { entries } = (await call(env, 'GET', `/v1/shells/${id}/log`, { auth: key })).json;
  assert.equal(entries.length, 6);
  await verify(entries, id);
});
await test('a Memo transaction is well formed and correctly signed', async () => {
  const s = crypto.getRandomValues(new Uint8Array(32));
  const tx = memoTx(s, 'hermit:1:abc', b58encode(new Uint8Array(32).fill(7)));
  assert.equal(tx[0], 1);
  const message = tx.slice(65);
  assert.ok(ed25519.verify(tx.slice(1, 65), message, ed25519.getPublicKey(s)));
  assert.deepEqual([...message.slice(0, 4)], [1, 0, 1, 2]);
  assert.equal(new TextDecoder().decode(message.slice(-12)), 'hermit:1:abc');
});

const solana = () => {
  const sent = [];
  let confirmed = false;
  globalThis.fetch = async (_, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === 'sendTransaction') sent.push(params[0]);
    const result = { getLatestBlockhash: { value: { blockhash: b58encode(new Uint8Array(32).fill(1)) } }, sendTransaction: 'sig' + sent.length, getSignatureStatuses: { value: (params[0] || []).map?.(() => (confirmed ? { confirmationStatus: 'confirmed', err: null } : null)) } }[method];
    return new Response(JSON.stringify({ result }));
  };
  return { sent, confirm: (v = true) => { confirmed = v; } };
};
await test('an anchor covers each moved shell once, and a root can be rebuilt from the log', async () => {
  const sol = solana();
  const env = freshEnv({ ANCHOR_KEY: '11'.repeat(32) });
  const a = await shell(env), b = await shell(env);
  await tool(env, a.key, 'remember', { text: 'a1' });
  await tool(env, b.key, 'remember', { text: 'b1' });
  const first = await anchor(env);
  assert.equal(sol.sent.length, 1);
  assert.equal(await anchor(env), null, 'waits for the pending one');
  sol.confirm();
  assert.equal(await anchor(env), null, 'nothing new after settling');
  assert.equal((await call(env, 'GET', `/v1/shells/${a.id}`, { auth: a.key })).json.anchored, 1);
  const detail = (await call(env, 'GET', `/v1/anchors/${first.id}`)).json;
  assert.equal(detail.status, 'confirmed');
  assert.ok(!JSON.stringify(detail).includes(a.id), 'shell ids stay hidden');
  const head = (await call(env, 'GET', `/v1/shells/${a.id}`, { auth: a.key })).json.head;
  assert.ok(detail.leaves.includes(`${await sha256(a.id)}:1:${head}`));
  assert.equal(await rootOf(detail.leaves), detail.root);
  const mine = (await call(env, 'GET', `/v1/shells/${a.id}/anchors`, { auth: a.key })).json.anchors;
  assert.equal(mine[0].root, detail.root);
  await tool(env, a.key, 'remember', { text: 'a2' });
  assert.equal(await anchor(env), null, 'an hour has not passed');
  env.ANCHOR_EVERY_MIN = '0';
  assert.ok(await anchor(env));
  assert.equal(sol.sent.length, 2);
});
await test('a failed anchor leaves the heads for the next one', async () => {
  const sol = solana();
  const env = freshEnv({ ANCHOR_KEY: '22'.repeat(32) });
  const a = await shell(env);
  await tool(env, a.key, 'remember', { text: 'a1' });
  await anchor(env);
  await env.DB.prepare('UPDATE anchors SET created = 0').run();
  assert.ok(await anchor(env), 'tries again');
  assert.equal(sol.sent.length, 2);
  assert.equal((await call(env, 'GET', '/v1/anchors')).json.anchors.length, 1);
});
await test('no anchor key, no anchors', async () => { assert.equal(await anchor(freshEnv()), null); });

// ---------- wallets, keys, limits ----------
await test('a wallet owns shells, issues and revokes keys', async () => {
  const env = freshEnv();
  const { session } = await signIn(env);
  const s = (await call(env, 'POST', '/v1/shells', { auth: session, body: { name: 'mine' } })).json;
  assert.ok(s.owner);
  assert.equal((await call(env, 'GET', '/v1/shells', { auth: session })).json.shells.length, 1);
  const k2 = (await call(env, 'POST', `/v1/shells/${s.id}/keys`, { auth: session, body: { label: 'cursor' } })).json.key;
  await tool(env, k2, 'remember', { text: 'from the second key' });
  const { keys } = (await call(env, 'GET', `/v1/shells/${s.id}`, { auth: session })).json;
  assert.equal(keys.length, 2);
  assert.equal((await call(env, 'POST', `/v1/shells/${s.id}/keys`, { auth: k2, body: {} })).status, 403);
  await call(env, 'DELETE', `/v1/shells/${s.id}/keys/${k2.slice(0, 9)}`, { auth: session });
  assert.equal((await call(env, 'POST', '/mcp', { auth: k2, body: {} })).status, 401);
});
await test('a wrong signature gets nothing', async () => {
  const env = freshEnv();
  const s = crypto.getRandomValues(new Uint8Array(32));
  const address = b58encode(ed25519.getPublicKey(s));
  const message = `HERMIT sign-in\nWallet: ${address}\nTime: ${new Date().toISOString()}`;
  const signature = b58encode(ed25519.sign(new TextEncoder().encode('other'), s));
  assert.equal((await call(env, 'POST', '/v1/auth', { body: { address, message, signature } })).status, 401);
});
await test('a drifter shell can be claimed once, with its key', async () => {
  const env = freshEnv();
  const s = await shell(env);
  const a = await signIn(env), b = await signIn(env);
  assert.equal((await call(env, 'POST', `/v1/shells/${s.id}/claim`, { auth: a.session, body: { key: 'hk_' + '1'.repeat(48) } })).status, 401);
  assert.equal((await call(env, 'POST', `/v1/shells/${s.id}/claim`, { auth: a.session, body: { key: s.key } })).status, 200);
  assert.equal((await call(env, 'POST', `/v1/shells/${s.id}/claim`, { auth: b.session, body: { key: s.key } })).status, 409);
  assert.equal((await call(env, 'GET', `/v1/shells/${s.id}`, { auth: a.session })).json.tier, 'free');
});
await test('limits: drifters a day, shells a wallet, memories a shell', async () => {
  const env = freshEnv();
  const ask = () => call(env, 'POST', '/v1/shells', { body: {}, headers: { 'cf-connecting-ip': '1.1.1.1' } });
  for (let i = 0; i < 10; i++) assert.equal((await ask()).status, 201);
  assert.equal((await ask()).status, 429);
  const { session } = await signIn(env);
  for (let i = 0; i < 3; i++) await call(env, 'POST', '/v1/shells', { auth: session, body: {} });
  assert.equal((await call(env, 'POST', '/v1/shells', { auth: session, body: {} })).status, 429);
  const s = await shell(env);
  await env.DB.prepare("INSERT INTO usage (who, kind, day, n) VALUES (?, 'write', ?, 200)").bind('s:' + s.id, new Date().toISOString().slice(0, 10)).run();
  assert.match((await tool(env, s.key, 'remember', { text: 'x' })).error, /writes for today/);
  const full = await shell(env);
  for (let i = 1; i <= 500; i++) await env.DB.prepare("INSERT INTO entries (shell, seq, kind, text, agent, created, content_hash, prev, hash) VALUES (?, ?, 'fact', 'x', 'a', 0, 'h', 'p', 'h')").bind(full.id, i).run();
  assert.match((await tool(env, full.key, 'remember', { text: 'x' })).error, /full at 500/);
});
await test('holders get the holder tier, checked on chain', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ result: { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: 2000000 } } } } } }] } }));
  const env = freshEnv({ TOKEN_ADDRESS: 'mint', HOLD_HOLDER: '1000000', HOLD_ELDER: '5000000' });
  const { session } = await signIn(env);
  const me = (await call(env, 'GET', '/v1/me', { auth: session })).json;
  assert.equal(me.tier, 'holder');
  assert.equal(me.limits.memories, 50000);
});
await test('a public shell can be read by anyone, written by no one', async () => {
  const env = freshEnv();
  const { key, id } = await shell(env);
  await tool(env, key, 'remember', { text: 'open note' });
  await call(env, 'POST', `/v1/shells/${id}/public`, { auth: key, body: { public: true } });
  const r = await call(env, 'GET', `/v1/shells/${id}/log`);
  assert.equal(r.json.entries[0].text, 'open note');
  const meta = (await call(env, 'GET', `/v1/shells/${id}`)).json;
  assert.equal(meta.keys, undefined);
  assert.equal((await call(env, 'DELETE', `/v1/shells/${id}`)).status, 403);
  assert.equal((await call(env, 'POST', `/v1/shells/${id}/public`, { body: { public: false } })).status, 403);
});
await test('deleting a shell takes everything with it', async () => {
  const env = freshEnv();
  const { key, id } = await shell(env);
  await tool(env, key, 'remember', { text: 'gone soon' });
  assert.equal((await call(env, 'DELETE', `/v1/shells/${id}`, { auth: key })).status, 200);
  assert.equal(env.VECTORS.all.size, 0);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM entries_fts').first()).n, 0);
  assert.equal((await call(env, 'POST', '/mcp', { auth: key, body: {} })).status, 401);
});
await test('bad input gets a plain error', async () => {
  const env = freshEnv();
  const { key } = await shell(env);
  assert.match((await tool(env, key, 'remember', {})).error, /required/);
  assert.match((await tool(env, key, 'remember', { text: 'x'.repeat(4001) })).error, /over 4000/);
  assert.match((await tool(env, key, 'remember', { text: 'x', kind: 'plan' })).error, /kind must be/);
  assert.match((await tool(env, key, 'forget', { id: 99 })).error, /no entry 99/);
  assert.match((await tool(env, key, 'recall', { query: '  ' })).error, /required/);
  assert.equal((await tool(env, key, 'recall', { query: '"*:(' })).memories.length, 0);
});

console.log(`\n${passed} passed`);
