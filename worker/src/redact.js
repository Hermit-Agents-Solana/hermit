// Runs before anything is stored. Pattern matching: it catches the usual shapes of a secret, not every secret.
// Solana keys are checked for real: a 64-byte value only counts when its second half is the public key of its first,
// so transaction signatures, which look the same, stay readable.

import { ed25519 } from '@noble/curves/ed25519';
import { wordlist } from '@scure/bip39/wordlists/english';
import { b58decode } from './account.js';

const BIP39 = new Set(wordlist);

const isKeypair = (bytes) => {
  if (bytes.length !== 64) return false;
  const pub = ed25519.getPublicKey(bytes.slice(0, 32));
  return pub.every((b, i) => b === bytes[32 + i]);
};

const TOKENS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['api key', /\bsk-[A-Za-z0-9_-]{16,}/g],
  ['api key', /\bgh[pousr]_[A-Za-z0-9]{20,}/g],
  ['api key', /\bgithub_pat_[A-Za-z0-9_]{20,}/g],
  ['api key', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['api key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['api key', /\bAIza[0-9A-Za-z_-]{30,}/g],
  ['api key', /\b(?:hk|sess)_[0-9a-f]{48}\b/g],
  ['token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g],
  ['token', /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g],
  ['email', /\b[\w.+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g],
];

// NAME=value and name: value, where the name says secret. TOKEN_ADDRESS and the like are public, so they stay.
const NAMED = /\b([\w-]*(?:password|passwd|pwd|secret|api[_-]?key|apikey|auth[_-]?token|access[_-]?token|private[_-]?key|token)[\w-]*)(["']?\s*[=:]\s*["']?)([^\s"',&]{6,})/gi;
const PUBLIC_NAME = /(address|mint|url|id|name|program|count|limit|supply)$/i;

export function redact(input) {
  const found = [];
  const hit = (what) => { found.push(what); return `[redacted ${what}]`; };
  let text = String(input);

  text = text.replace(/\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g, (m) => {
    const bytes = Uint8Array.from(JSON.parse(m));
    return isKeypair(bytes) ? hit('wallet key') : m;
  });
  text = text.replace(/\b[1-9A-HJ-NP-Za-km-z]{85,90}\b/g, (m) => {
    try { return isKeypair(b58decode(m)) ? hit('wallet key') : m; } catch { return m; }
  });

  for (const [what, re] of TOKENS) text = text.replace(re, () => hit(what));
  text = text.replace(/(\w+:\/\/)[^\s/:@]+:[^\s/@]+@/g, (_, scheme) => `${scheme}${hit('login')}@`);
  text = text.replace(NAMED, (m, name, sep, value) => {
    if (PUBLIC_NAME.test(name) || value.startsWith('[redacted')) return m;
    if (/^token$/i.test(name) && !(value.length >= 20 && /[0-9]/.test(value))) return m; // "token: $HERMIT" is just a sentence
    return `${name}${sep}${hit('secret')}`;
  });

  // twelve or more seed words in a row, however they are separated
  text = text.replace(/[A-Za-z]+(?:[\s,.:;\d)-]+[A-Za-z]+){11,}/g, (run) => {
    const parts = run.match(/[A-Za-z]+/g);
    let start = -1, best = 0, bestAt = 0;
    parts.forEach((w, i) => {
      if (BIP39.has(w.toLowerCase())) { if (start < 0) start = i; if (i - start + 1 > best) { best = i - start + 1; bestAt = start; } } else start = -1;
    });
    if (best < 12) return run;
    const re = new RegExp(parts.slice(bestAt, bestAt + best).join('[\\s,.:;\\d)-]+'));
    return run.replace(re, () => hit('seed phrase'));
  });

  return { text, redacted: found };
}
