// What agents do with a shell: write to the log, pick up where the last one stopped, search what is still true.
//   Every entry links to the one before: hash = sha256(prev, shell, seq, kind, agent, created, supersedes, content_hash).
//   Text lives outside the hash, so forgetting clears it and the chain still checks out.

import { fail, sha256, spend, tierOf, used } from './account.js';
import { redact } from './redact.js';

export const GENESIS = '0'.repeat(64);
export const NOTE_KINDS = ['fact', 'constraint', 'lesson'];
const MAX_TEXT = 4000, STALE_SCORE = 0.82, MATCH_SCORE = 0.45;
const MODEL = '@cf/baai/bge-m3';

const cleanText = (v, name = 'text') => {
  const text = String(v ?? '').trim();
  if (!text) throw fail(400, `${name} is required`);
  if (text.length > MAX_TEXT) throw fail(400, `${name} is over ${MAX_TEXT} characters, store the conclusion, not the transcript`);
  return redact(text);
};
export const linkHash = (e) => sha256([e.prev, e.shell, e.seq, e.kind, e.agent, e.created, e.supersedes ?? '', e.content_hash].join('\n'));
const view = (e) => ({ id: e.seq, kind: e.kind, text: e.text, agent: e.agent, at: new Date(e.created).toISOString(), ...(e.supersedes ? { replaced: e.supersedes } : {}) });

// ---------- search index, best effort: the log is the truth and full-text search still works without it ----------
async function embed(env, text) {
  if (!env.AI) return null;
  const r = await env.AI.run(MODEL, { text: [text] });
  return r?.data?.[0] || null;
}
const vectorId = (shell, seq) => `${shell}:${seq}`;

async function index(env, shell, seq, text) {
  try {
    const values = await embed(env, text);
    if (!values || !env.VECTORS) return null;
    await env.VECTORS.upsert([{ id: vectorId(shell, seq), values, namespace: shell }]);
    await env.DB.prepare('UPDATE entries SET indexed = 1 WHERE shell = ? AND seq = ?').bind(shell, seq).run();
    return values;
  } catch (e) { console.error('index', e); return null; }
}

// entries the search index missed, retried by the cron
export async function backfill(env) {
  const { results } = await env.DB.prepare("SELECT shell, seq, text FROM entries WHERE indexed = 0 AND text IS NOT NULL AND kind != 'forget' LIMIT 20").all();
  for (const e of results) await index(env, e.shell, e.seq, e.text);
}

// ---------- the log ----------
async function append(env, shell, { kind, text, agent, supersedes = null, also = [] }) {
  const content_hash = await sha256(text);
  for (let attempt = 0; attempt < 6; attempt++) {
    const head = await env.DB.prepare('SELECT seq, head FROM shells WHERE id = ?').bind(shell.id).first();
    if (!head) throw fail(404, 'that shell is gone');
    const e = { shell: shell.id, seq: head.seq + 1, kind, text, agent, supersedes, created: Date.now(), content_hash, prev: head.head };
    e.hash = await linkHash(e);
    try {
      // two writers can read the same head: the primary key lets one through and the other goes round again
      await env.DB.batch([
        env.DB.prepare('INSERT INTO entries (shell, seq, kind, text, agent, supersedes, created, content_hash, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(e.shell, e.seq, kind, text, agent, supersedes, e.created, content_hash, e.prev, e.hash),
        env.DB.prepare('UPDATE shells SET seq = ?, head = ? WHERE id = ?').bind(e.seq, e.hash, e.shell),
        ...(kind === 'forget' ? [] : [env.DB.prepare('INSERT INTO entries_fts (shell, seq, text) VALUES (?, ?, ?)').bind(e.shell, e.seq, text)]),
        ...(supersedes ? [env.DB.prepare('UPDATE entries SET superseded_by = ? WHERE shell = ? AND seq = ? AND superseded_by IS NULL').bind(e.seq, e.shell, supersedes)] : []),
        ...also.map((sql) => sql(e)),
      ]);
      return e;
    } catch (err) {
      if (!/UNIQUE|constraint/i.test(String(err.message))) throw err;
    }
  }
  throw fail(503, 'this shell is busy, try again in a moment');
}

async function gate(env, shell, addsMemory) {
  const tier = await tierOf(env, shell.owner);
  if ((await used(env, 's:' + shell.id, 'write')) >= tier.writes) throw fail(429, 'that is all the writes for today on this shell');
  if (addsMemory) {
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM entries WHERE shell = ? AND superseded_by IS NULL AND text IS NOT NULL AND kind != 'forget'").bind(shell.id).first();
    if (n >= tier.memories) throw fail(429, `this shell is full at ${tier.memories} memories. forget what is stale${tier.name === 'drifter' ? ' or claim it with a wallet' : ''}`);
  }
}

async function target(env, shell, id) {
  const seq = Number(id);
  if (!Number.isInteger(seq) || seq < 1) throw fail(400, 'that entry id looks wrong');
  const row = await env.DB.prepare('SELECT seq, kind, superseded_by FROM entries WHERE shell = ? AND seq = ?').bind(shell.id, seq).first();
  if (!row || row.kind === 'forget') throw fail(404, `there is no entry ${seq} in this shell`);
  if (row.superseded_by) throw fail(409, `entry ${seq} was already replaced by entry ${row.superseded_by}`);
  return seq;
}

async function liveLatest(env, shell, kind) {
  return env.DB.prepare('SELECT * FROM entries WHERE shell = ? AND kind = ? AND superseded_by IS NULL ORDER BY seq DESC LIMIT 1').bind(shell.id, kind).first();
}

// entries that may say the same thing, so the agent can replace one instead of leaving two truths
async function similar(env, shell, values, seq) {
  if (!values || !env.VECTORS) return [];
  try {
    const { matches } = await env.VECTORS.query(values, { topK: 4, namespace: shell.id });
    const seqs = matches.filter((m) => m.score >= STALE_SCORE).map((m) => Number(m.id.split(':')[1])).filter((s) => s !== seq);
    return (await rows(env, shell, seqs)).map(view);
  } catch (e) { console.error('similar', e); return []; }
}

async function rows(env, shell, seqs) {
  if (!seqs.length) return [];
  const { results } = await env.DB.prepare(`SELECT * FROM entries WHERE shell = ? AND superseded_by IS NULL AND text IS NOT NULL AND seq IN (${seqs.map(() => '?').join(',')})`).bind(shell.id, ...seqs).all();
  const at = new Map(results.map((e) => [e.seq, e]));
  return seqs.map((s) => at.get(s)).filter(Boolean);
}

async function write(env, shell, agent, kind, input, supersedes) {
  const { text, redacted } = cleanText(kind === 'decision' && input.why ? `${input.text}\n\nWhy: ${input.why}` : input.text);
  await gate(env, shell, !supersedes);
  const e = await append(env, shell, { kind, text, agent, supersedes });
  await spend(env, 's:' + shell.id, 'write');
  const values = await index(env, shell.id, e.seq, text);
  const stale = await similar(env, shell, values, e.seq);
  return {
    id: e.seq, kind, hash: e.hash,
    ...(supersedes ? { replaced: supersedes } : {}),
    ...(redacted.length ? { redacted, note: 'Removed before storing. The rest was kept.' } : {}),
    ...(stale.length ? { may_conflict: stale, note_conflict: 'If this replaces one of these, call forget on the old one or write again with supersedes.' } : {}),
  };
}

// ---------- tools ----------
export const tools = {
  async whoami(env, shell) {
    return { shell: shell.id, name: shell.name };
  },

  async pickup(env, shell) {
    const pick = async (kinds, limit) => (await env.DB.prepare(`SELECT * FROM entries WHERE shell = ? AND superseded_by IS NULL AND text IS NOT NULL AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY seq DESC LIMIT ?`).bind(shell.id, ...kinds, limit).all()).results.map(view);
    const [plan, handoff, decisions, constraints, lessons, facts] = await Promise.all([liveLatest(env, shell, 'plan'), liveLatest(env, shell, 'handoff'), pick(['decision'], 15), pick(['constraint'], 20), pick(['lesson'], 10), pick(['fact'], 10)]);
    const head = await env.DB.prepare('SELECT seq, head FROM shells WHERE id = ?').bind(shell.id).first();
    return { shell: shell.name, entries: head.seq, head: head.head, handoff: handoff?.text ? view(handoff) : null, plan: plan?.text ? view(plan) : null, decisions, constraints, lessons, facts };
  },

  async recall(env, shell, input) {
    const query = String(input.query ?? '').trim().slice(0, 500);
    if (!query) throw fail(400, 'query is required');
    const limit = Math.min(Math.max(Number(input.limit) || 8, 1), 25);
    const tier = await tierOf(env, shell.owner);
    if ((await used(env, 's:' + shell.id, 'recall')) >= tier.writes * 5) throw fail(429, 'that is all the recalls for today on this shell');
    await spend(env, 's:' + shell.id, 'recall');
    const rank = new Map();
    const add = (list) => list.forEach((seq, i) => rank.set(seq, (rank.get(seq) || 0) + 1 / (10 + i)));
    const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12) || [];
    if (terms.length) {
      const { results } = await env.DB.prepare('SELECT seq FROM entries_fts WHERE entries_fts MATCH ? AND shell = ? ORDER BY rank LIMIT 25').bind(terms.map((t) => `"${t}"`).join(' OR '), shell.id).all();
      add(results.map((r) => Number(r.seq)));
    }
    try {
      const values = await embed(env, query);
      if (values && env.VECTORS) add((await env.VECTORS.query(values, { topK: 25, namespace: shell.id })).matches.filter((m) => m.score >= MATCH_SCORE).map((m) => Number(m.id.split(':')[1])));
    } catch (e) { console.error('recall', e); }
    const best = [...rank.entries()].sort((a, b) => b[1] - a[1]).map(([seq]) => seq);
    const live = (await rows(env, shell, best)).filter((e) => !input.kind || e.kind === input.kind);
    return { query, memories: live.slice(0, limit).map(view) };
  },

  async remember(env, shell, input, agent) {
    const kind = input.kind ?? 'fact';
    if (!NOTE_KINDS.includes(kind)) throw fail(400, `kind must be one of ${NOTE_KINDS.join(', ')}`);
    const supersedes = input.supersedes ? await target(env, shell, input.supersedes) : null;
    return write(env, shell, agent, kind, input, supersedes);
  },

  async decide(env, shell, input, agent) {
    const supersedes = input.supersedes ? await target(env, shell, input.supersedes) : null;
    return write(env, shell, agent, 'decision', input, supersedes);
  },

  // one plan and one handoff stand at a time: a new one retires the old
  async plan(env, shell, input, agent) {
    return write(env, shell, agent, 'plan', input, (await liveLatest(env, shell, 'plan'))?.seq ?? null);
  },
  async handoff(env, shell, input, agent) {
    return write(env, shell, agent, 'handoff', input, (await liveLatest(env, shell, 'handoff'))?.seq ?? null);
  },

  async forget(env, shell, input, agent) {
    const seq = await target(env, shell, input.id);
    const { text } = cleanText(input.reason || 'no reason given', 'reason');
    const e = await append(env, shell, {
      kind: 'forget', text, agent, supersedes: seq,
      also: [(entry) => env.DB.prepare('UPDATE entries SET text = NULL WHERE shell = ? AND seq = ?').bind(entry.shell, seq), (entry) => env.DB.prepare('DELETE FROM entries_fts WHERE shell = ? AND seq = ?').bind(entry.shell, seq)],
    });
    await spend(env, 's:' + shell.id, 'write');
    try { await env.VECTORS?.deleteByIds([vectorId(shell.id, seq)]); } catch (err) { console.error('forget', err); }
    return { id: e.seq, forgot: seq, hash: e.hash, note: 'The text is gone. Its hash stays in the chain.' };
  },
};

// ---------- reading a shell from outside ----------
export async function log(env, shell, after, limit) {
  const { results } = await env.DB.prepare('SELECT seq, kind, text, agent, supersedes, superseded_by, created, content_hash, prev, hash FROM entries WHERE shell = ? AND seq > ? ORDER BY seq LIMIT ?').bind(shell.id, after, limit).all();
  return results;
}

export async function dropVectors(env, shell, seq) {
  if (!env.VECTORS) return;
  for (let from = 1; from <= seq; from += 500) {
    const ids = Array.from({ length: Math.min(500, seq - from + 1) }, (_, i) => vectorId(shell, from + i));
    try { await env.VECTORS.deleteByIds(ids); } catch (e) { console.error('drop', e); return; }
  }
}
