/**
 * Kacey — vectors for searching by meaning.
 *
 * The gallery's search embeds what Kacey wrote about a photo (title, caption,
 * tags and the broader keywords she adds for exactly this purpose) and finds
 * the nearest ones to the question by cosine similarity. The vectors sit in
 * the database next to the row; the index is that table read into memory,
 * which is plenty for a personal gallery of thousands.
 *
 * Two embedders, one interface:
 *
 *  - built-in (the default): a hashed vector of word stems and character
 *    trigrams, Czech diacritics folded. It needs nothing installed and finds
 *    "chalupa" from "na chalupě" and "pes" from "psík"-ish typos; the meaning
 *    ("zvíře" for a dog) comes from the keywords the describer writes.
 *  - KACEY_EMBED_URL: an Ollama-compatible /api/embed, for a real model.
 *    Falls back to the built-in one when it does not answer.
 *
 * Each vector remembers its model, so switching embedders re-embeds lazily
 * instead of comparing vectors from two different spaces.
 */

import { EMBED_URL, EMBED_MODEL } from './config.js';

export const LOCAL_MODEL = 'kacey-hash-512';
const DIMS = 512;

/* Words that carry no meaning in a search ("fotka se psem na zahradě"). */
const STOP = new Set(('a i o u v ve z ze s se k ke na do od po za pro pri pred pod nad mezi '
  + 'je jsou byl byla bylo to ten ta tento tato toto tuhle tenhle ktery ktera ktere '
  + 'jak kde kdy co mi me moje muj tvoje nejaky nejaka nejake fotka fotku fotky foto fotce '
  + 'obrazek snimek snimku najdi ukaz hledam the of and with in on').split(' '));

/** Lowercase, no diacritics, words only. */
export function fold(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/* A crude Czech stemmer, and a good enough one: drop a case ending and the
   last vowels, keep five letters. chalupa / chalupě / chalupy all land on
   "chalu", hory / horách on "hor", zima / zimě on "zim". */
function stem(word) {
  if (word.length <= 3) return word;
  let s = word.replace(/(ami|emi|ovi|ech|ich|ach|ych|em|ou|um|ym|im|om)$/, '');
  if (s.length < 3) s = word;
  s = s.replace(/[aeiouy]+$/, '');
  if (s.length < 3) s = word.slice(0, 3);
  return s.slice(0, 5);
}

function hash(str, seed) {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function add(vec, feature, weight) {
  const h = hash(feature, 0);
  vec[h % DIMS] += (hash(feature, 7) & 1 ? 1 : -1) * weight;
}

export function localEmbed(text) {
  const vec = new Float32Array(DIMS);
  for (const word of fold(text).split(' ')) {
    if (word.length < 2 || STOP.has(word)) continue;
    add(vec, 'w:' + stem(word), 1);
    const padded = ' ' + word + ' ';
    for (let i = 0; i + 3 <= padded.length; i++) add(vec, 't:' + padded.slice(i, i + 3), 0.3);
  }
  return normalize(vec);
}

function normalize(vec) {
  let n = 0;
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= n;
  return vec;
}

async function remoteEmbed(text) {
  const r = await fetch(EMBED_URL.replace(/\/$/, '') + '/api/embed', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`embed ${r.status}`);
  const j = await r.json();
  const v = j.embeddings?.[0] || j.embedding;
  if (!Array.isArray(v) || !v.length) throw new Error('embed: no vector');
  return normalize(Float32Array.from(v));
}

/** { vec, model } — the remote model when configured and answering, else the built-in one. */
export async function embed(text) {
  if (EMBED_URL) {
    try { return { vec: await remoteEmbed(text), model: EMBED_MODEL }; } catch (err) {
      console.warn('[vectors] embedding service did not answer, using the built-in one:', err.message);
    }
  }
  return { vec: localEmbed(text), model: LOCAL_MODEL };
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function toBlob(vec) { return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength); }
export function fromBlob(blob) {
  if (!blob) return null;
  // A fresh, aligned copy: a small Buffer can sit at any offset in Node's pool.
  const bytes = new Uint8Array(blob.byteLength - (blob.byteLength % 4));
  bytes.set(blob.subarray(0, bytes.length));
  return new Float32Array(bytes.buffer);
}

/** What the search panel says about the index. */
export function describeIndex() {
  return EMBED_URL ? { model: EMBED_MODEL, remote: true } : { model: LOCAL_MODEL, remote: false };
}
