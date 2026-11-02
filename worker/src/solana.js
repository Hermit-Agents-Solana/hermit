// Solana RPC and one hand-built transaction: a single Memo instruction paid and signed by the anchor wallet.

import { ed25519 } from '@noble/curves/ed25519';
import { b58decode, b58encode, fail, unhex } from './account.js';

const url = (env) => env.SOL_RPC_URL || 'https://api.mainnet-beta.solana.com';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export async function rpc(env, method, params) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url(env), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if ((r.status === 429 || r.status >= 500) && attempt < 2) { await new Promise((res) => setTimeout(res, 800 * 2 ** attempt)); continue; }
    const json = await r.json().catch(() => null);
    if (json?.error) throw fail(502, `Solana RPC: ${json.error.message || 'error'}`);
    if (!r.ok || !json) throw fail(503, 'Solana RPC is busy, try again in a moment');
    return json.result;
  }
}

const compact = (n) => { const out = []; for (;;) { const b = n & 127; n >>= 7; if (!n) { out.push(b); return out; } out.push(b | 128); } };

export const anchorWallet = (env) => (env.ANCHOR_KEY ? b58encode(ed25519.getPublicKey(unhex(env.ANCHOR_KEY))) : null);

// legacy message: one signer (the payer), one read-only program, one instruction with no accounts
export function memoTx(seed, memo, blockhash) {
  const data = new TextEncoder().encode(memo);
  const payer = ed25519.getPublicKey(seed);
  const message = Uint8Array.from([
    1, 0, 1,
    ...compact(2), ...payer, ...b58decode(MEMO_PROGRAM),
    ...b58decode(blockhash),
    ...compact(1), 1, ...compact(0), ...compact(data.length), ...data,
  ]);
  const signature = ed25519.sign(message, seed);
  return Uint8Array.from([...compact(1), ...signature, ...message]);
}

export async function sendMemo(env, memo) {
  const { value } = await rpc(env, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const tx = memoTx(unhex(env.ANCHOR_KEY), memo, value.blockhash);
  return rpc(env, 'sendTransaction', [btoa(String.fromCharCode(...tx)), { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }]);
}

export async function statuses(env, signatures) {
  const { value } = await rpc(env, 'getSignatureStatuses', [signatures, { searchTransactionHistory: true }]);
  return value;
}
