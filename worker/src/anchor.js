// Puts the log on Solana. The cron takes the head of every shell that moved, hashes the sorted list into one root
// and writes "hermit:1:<root>" in a Memo transaction. Shell ids are hashed in the list, so it says nothing about who wrote what.
// A leaf is "sha256(shell id):seq:head". Anyone can rebuild the root from a shell's log and the leaves of an anchor.

import { sha256 } from './account.js';
import { sendMemo, statuses } from './solana.js';

const STUCK = 3 * 60000;

const leaf = async (l) => `${await sha256(l.shell)}:${l.seq}:${l.head}`;
export const rootOf = async (leaves) => sha256([...leaves].sort().join('\n'));

async function settle(env) {
  const { results } = await env.DB.prepare("SELECT id, signature, created FROM anchors WHERE status = 'pending'").all();
  if (!results.length) return 0;
  const found = await statuses(env, results.map((a) => a.signature));
  let open = 0;
  for (const [i, a] of results.entries()) {
    const s = found[i];
    if (s && !s.err && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
      await env.DB.batch([
        env.DB.prepare("UPDATE anchors SET status = 'confirmed' WHERE id = ?").bind(a.id),
        env.DB.prepare('UPDATE shells SET anchored = MAX(anchored, (SELECT seq FROM anchor_leaves l WHERE l.anchor = ?1 AND l.shell = shells.id)) WHERE id IN (SELECT shell FROM anchor_leaves WHERE anchor = ?1)').bind(a.id),
      ]);
    } else if (s?.err || Date.now() - a.created > STUCK) {
      await env.DB.prepare("UPDATE anchors SET status = 'failed' WHERE id = ?").bind(a.id).run();
    } else open++;
  }
  return open;
}

export async function anchor(env) {
  if (!env.ANCHOR_KEY) return null;
  if (await settle(env)) return null;
  const last = await env.DB.prepare("SELECT created FROM anchors WHERE status = 'confirmed' ORDER BY id DESC LIMIT 1").first();
  const every = Number(env.ANCHOR_EVERY_MIN || 60) * 60000;
  if (last && Date.now() - last.created < every) return null;
  const { results: moved } = await env.DB.prepare('SELECT id, seq, head FROM shells WHERE seq > anchored LIMIT 500').all();
  if (!moved.length) return null;
  const list = moved.map((s) => ({ shell: s.id, seq: s.seq, head: s.head }));
  const root = await rootOf(await Promise.all(list.map(leaf)));
  const signature = await sendMemo(env, `hermit:1:${root}`);
  const { meta } = await env.DB.prepare("INSERT INTO anchors (root, signature, status, entries, created) VALUES (?, ?, 'pending', ?, ?)").bind(root, signature, list.length, Date.now()).run();
  const id = meta?.last_row_id;
  await env.DB.batch(list.map((l) => env.DB.prepare('INSERT INTO anchor_leaves (anchor, shell, seq, head) VALUES (?, ?, ?, ?)').bind(id, l.shell, l.seq, l.head)));
  return { id, root, signature };
}

export async function anchors(env, limit = 30) {
  const { results } = await env.DB.prepare("SELECT id, root, signature, status, entries, created FROM anchors WHERE status != 'failed' ORDER BY id DESC LIMIT ?").bind(limit).all();
  return results;
}

export async function anchorDetail(env, id) {
  const a = await env.DB.prepare('SELECT id, root, signature, status, entries, created FROM anchors WHERE id = ?').bind(id).first();
  if (!a) return null;
  const { results } = await env.DB.prepare('SELECT shell, seq, head FROM anchor_leaves WHERE anchor = ?').bind(id).all();
  return { ...a, leaves: (await Promise.all(results.map(leaf))).sort() };
}

// the anchors that cover a shell, newest first, for the verifier
export async function shellAnchors(env, shell) {
  const { results } = await env.DB.prepare("SELECT a.id, a.root, a.signature, a.created, l.seq, l.head FROM anchor_leaves l JOIN anchors a ON a.id = l.anchor WHERE l.shell = ? AND a.status = 'confirmed' ORDER BY a.id DESC LIMIT 50").bind(shell).all();
  return results;
}
