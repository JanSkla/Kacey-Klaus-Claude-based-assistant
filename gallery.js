/**
 * Kacey — the photo gallery.
 *
 * Photos taken or uploaded on the Galerie screen, or saved from the chat
 * ("ulož mi tuto fotku"), stored on this machine: the file in GALLERY_DIR,
 * the row in the database (db.js, kacey_photo). Every photo gets a title, a
 * caption and tags written by the model, plus broader keywords that are not
 * shown but make the search find "zvíře" for a dog. Those are embedded
 * (vectors.js) and the search ranks by meaning, with a nudge for a tag that
 * matches word for word.
 *
 * Nothing here is editable by hand — that was the owner's call. A description
 * that went wrong is retried, not corrected.
 *
 * Two ways in, two ways the description is written:
 *  - the Galerie screen uploads; the row starts `describing`, a headless model
 *    call writes the text, then it is `ready` (or `failed`, with a retry);
 *  - the chat tool (app-tools.js) already has Kacey looking at the picture, so
 *    she writes the text in the tool call and the row is `ready` at once.
 *
 * Every change is reported through onEvent(), which server.js broadcasts as a
 * `gallery` frame: the grid updates, and the chat shows the saved photo.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { open, now } from './db.js';
import { GALLERY_DIR, MODEL, DISALLOWED_TOOLS } from './config.js';
import { embed, cosine, fold, toBlob, fromBlob, describeIndex } from './vectors.js';

export const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
export const MAX_BYTES = 25 * 1024 * 1024;     // the original, decoded
const MODEL_MAX_BYTES = 5 * 1024 * 1024;       // what the model accepts per image

const log = (...a) => console.log('[gallery]', ...a);

let listener = () => {};
export function onEvent(fn) { listener = typeof fn === 'function' ? fn : () => {}; }
function emit(event, photo, extra) { try { listener({ event, photo, ...extra }); } catch { /* a page went away */ } }

function newId() { return 'p' + Date.now().toString(36) + randomBytes(3).toString('hex'); }

/* ---- rows ------------------------------------------------------------------- */

function parseTags(s) { try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } }

/** A row as the page and Kacey see it. Never the vector, never the keywords. */
function shape(r, score) {
  if (!r) return null;
  const url = '/gallery-files/' + encodeURIComponent(r.file);
  return {
    id: r.photo_id,
    url,
    thumb_url: r.thumb ? '/gallery-files/' + encodeURIComponent(r.thumb) : url,
    title: r.title, caption: r.caption, tags: parseTags(r.tags),
    status: r.status, error: r.error || null, source: r.source,
    name: r.name, media_type: r.media_type, bytes: r.bytes, width: r.width, height: r.height,
    taken_at: r.taken_at, created_at: r.created_at,
    ...(score != null ? { score: Math.round(score * 1000) / 1000 } : {}),
  };
}

export function get(id) {
  return shape(open().prepare('SELECT * FROM kacey_photo WHERE photo_id = ?').get(String(id)));
}

function rows() { return open().prepare('SELECT * FROM kacey_photo ORDER BY created_at DESC, rowid DESC').all(); }

/** Every tag with how many photos carry it, commonest first. */
function tagCounts(list) {
  const seen = new Map();
  for (const r of list) for (const t of parseTags(r.tags)) seen.set(t, (seen.get(t) || 0) + 1);
  return [...seen].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'cs')).map(([name, count]) => ({ name, count }));
}

/* ---- the search ---------------------------------------------------------------- */

function searchText(r) {
  return [r.title, r.caption, parseTags(r.tags).join(' '), r.keywords].join('. ');
}

/* A vector from another embedder is in another space: embed it again. Runs on
   the first search after the embedder changed, row by row. */
async function ensureVector(r, model) {
  if (r.embedding && r.embed_model === model) return fromBlob(r.embedding);
  const { vec, model: used } = await embed(searchText(r));
  open().prepare('UPDATE kacey_photo SET embedding = ?, embed_model = ? WHERE photo_id = ?').run(toBlob(vec), used, r.photo_id);
  return vec;
}

/**
 * The list for the page and for Kacey. With `q`, ranked by meaning; with
 * `tag`, only photos carrying it. Photos still being described are listed
 * (newest first) but not searched — there is nothing to search yet.
 */
export async function list({ q = '', tag = '', limit = 200 } = {}) {
  const all = rows();
  const tags = tagCounts(all.filter((r) => r.status === 'ready'));
  let pool = tag ? all.filter((r) => parseTags(r.tags).some((t) => fold(t) === fold(tag))) : all;
  const question = String(q || '').trim();
  let photos;

  if (!question) {
    photos = pool.slice(0, limit).map((r) => shape(r));
  } else {
    const { vec, model } = await embed(question);
    const words = new Set(fold(question).split(' ').filter((w) => w.length > 2));
    const scored = [];
    for (const r of pool) {
      if (r.status !== 'ready') continue;
      let s = cosine(vec, await ensureVector(r, model));
      // A tag said word for word is the strongest hint there is.
      if (parseTags(r.tags).some((t) => fold(t).split(' ').some((w) => words.has(w)))) s += 0.2;
      scored.push([s, r]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const best = scored.length ? scored[0][0] : 0;
    photos = scored
      .filter(([s]) => s >= 0.12 && s >= best * 0.45)
      .slice(0, limit)
      .map(([s, r]) => shape(r, s));
  }

  return {
    photos, tags, total: all.length,
    describing: all.filter((r) => r.status === 'describing').length,
    index: { ...describeIndex(), vectors: all.filter((r) => r.embedding).length },
  };
}

/* ---- saving ------------------------------------------------------------------------ */

function writeFile(id, suffix, media_type, data) {
  mkdirSync(GALLERY_DIR, { recursive: true });
  const file = `${id}${suffix}.${TYPES[media_type]}`;
  writeFileSync(path.join(GALLERY_DIR, file), Buffer.from(data, 'base64'));
  return file;
}

function cleanMeta(meta) {
  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const tags = [...new Set((Array.isArray(meta.tags) ? meta.tags : [])
    .map((t) => clip(t, 30).toLowerCase()).filter(Boolean))].slice(0, 10);
  const keywords = (Array.isArray(meta.keywords) ? meta.keywords : String(meta.keywords || '').split(/[,;]/))
    .map((k) => clip(k, 40)).filter(Boolean).slice(0, 40).join(', ');
  return { title: clip(meta.title, 80), caption: clip(meta.caption, 400), tags, keywords };
}

async function finish(id, meta) {
  const m = cleanMeta(meta);
  if (!m.title || !m.tags.length) throw new Error('popis je prázdný');
  const { vec, model } = await embed(searchText({ ...m, tags: JSON.stringify(m.tags) }));
  open().prepare(
    `UPDATE kacey_photo SET status = 'ready', error = NULL, title = ?, caption = ?, tags = ?, keywords = ?,
       embedding = ?, embed_model = ?, updated_at = ? WHERE photo_id = ?`,
  ).run(m.title, m.caption, JSON.stringify(m.tags), m.keywords, toBlob(vec), model, now(), id);
  const photo = get(id);
  emit('ready', photo);
  return photo;
}

/**
 * Store a photo. `image` is the original ({ media_type, data } base64);
 * `thumb` an optional small copy for the grid; `small` an optional copy the
 * model can read (≤5 MB) — without one the original is described, if it fits.
 * `meta` ({ title, caption, tags, keywords }) is given when Kacey already
 * described it in the chat; otherwise the description runs in the background.
 */
export async function save({ image, thumb, small, name = '', width, height, taken_at, source = 'gallery', meta } = {}) {
  if (!image || !TYPES[image.media_type]) throw new Error('Tohle není fotka, kterou umím uložit (JPEG, PNG, WebP, GIF).');
  const bytes = Math.floor(String(image.data || '').length * 3 / 4);
  if (!bytes) throw new Error('Fotka je prázdná.');
  if (bytes > MAX_BYTES) throw new Error(`Fotka je moc velká (limit ${MAX_BYTES / 1024 / 1024} MB).`);

  const id = newId();
  const file = writeFile(id, '', image.media_type, image.data);
  const thumbFile = thumb && TYPES[thumb.media_type] ? writeFile(id, '-t', thumb.media_type, thumb.data) : null;
  const at = now();
  open().prepare(
    `INSERT INTO kacey_photo (photo_id, file, thumb, media_type, bytes, width, height, name, source, status,
       taken_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'describing', ?, ?, ?)`,
  ).run(id, file, thumbFile, image.media_type, bytes, Number(width) || null, Number(height) || null,
    String(name).slice(0, 200), source === 'chat' ? 'chat' : 'gallery', taken_at || at, at, at);
  emit('added', get(id));

  if (meta) return finish(id, meta);

  const forModel = small && TYPES[small.media_type] ? small : image;
  describeLater(id, forModel);
  return get(id);
}

/* The model copy is kept in memory only until it is described; a retry after
   a restart reads the stored file. */
const pendingImages = new Map();

function describeLater(id, img) {
  pendingImages.set(id, img);
  describe(img)
    .then((meta) => finish(id, meta))
    .catch((err) => {
      log(`${id} not described: ${err.message}`);
      open().prepare(`UPDATE kacey_photo SET status = 'failed', error = ?, updated_at = ? WHERE photo_id = ?`)
        .run(String(err.message || err).slice(0, 200), now(), id);
      emit('failed', get(id));
    })
    .finally(() => pendingImages.delete(id));
}

export function retry(id) {
  const r = open().prepare('SELECT * FROM kacey_photo WHERE photo_id = ?').get(String(id));
  if (!r) throw new Error('Taková fotka není.');
  if (r.status === 'describing' && pendingImages.has(r.photo_id)) return shape(r);
  let img = pendingImages.get(r.photo_id);
  if (!img) {
    // Prefer the grid copy when the original is too big for the model.
    const pick = r.bytes > MODEL_MAX_BYTES && r.thumb ? r.thumb : r.file;
    const ext = pick.split('.').pop();
    const type = Object.keys(TYPES).find((t) => TYPES[t] === ext) || r.media_type;
    img = { media_type: type, data: readBase64(pick) };
  }
  open().prepare(`UPDATE kacey_photo SET status = 'describing', error = NULL, updated_at = ? WHERE photo_id = ?`).run(now(), r.photo_id);
  emit('added', get(r.photo_id));
  describeLater(r.photo_id, img);
  return get(r.photo_id);
}

function readBase64(file) {
  return readFileSync(path.join(GALLERY_DIR, file)).toString('base64');
}

export function remove(id) {
  const r = open().prepare('SELECT * FROM kacey_photo WHERE photo_id = ?').get(String(id));
  if (!r) return false;
  open().prepare('DELETE FROM kacey_photo WHERE photo_id = ?').run(r.photo_id);
  for (const f of [r.file, r.thumb]) {
    if (f && existsSync(path.join(GALLERY_DIR, f))) { try { unlinkSync(path.join(GALLERY_DIR, f)); } catch { /* gone */ } }
  }
  emit('removed', { id: r.photo_id });
  return true;
}

/* ---- the description ---------------------------------------------------------------- */

const DESCRIBE_SYSTEM = [
  'Popisuješ fotku do pánovy osobní galerie, aby ji později našel hledáním. Odpověz POUZE jedním JSON objektem, nic jiného:',
  '{"title": "…", "caption": "…", "tags": ["…"], "keywords": ["…"]}',
  'title: 2–6 slov česky, bez tečky na konci („Pes na zahradě u chalupy“).',
  'caption: 1–2 věty česky, konkrétně co je na fotce — co/kdo, kde, denní doba, nálada. Neodhaduj, kdo jsou lidé.',
  'tags: 3–8 krátkých štítků malými písmeny: hlavní předměty, místo, událost, druh snímku (účtenka, dokument, screenshot, jídlo, krajina).',
  'keywords: 10–25 dalších slov pro hledání: nadřazené pojmy (pes → zvíře, mazlíček), synonyma, barvy, roční období, venku/uvnitř, text čitelný na fotce.',
].join('\n');

async function* oneImage(img) {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } },
        { type: 'text', text: 'Popiš tuto fotku podle pokynů. Jen JSON.' },
      ],
    },
    parent_tool_use_id: null,
  };
}

/** One headless call, no tools. Resolves with { title, caption, tags, keywords }. */
export async function describe(img, { timeoutMs = 90000 } = {}) {
  if (Math.floor(String(img.data).length * 3 / 4) > MODEL_MAX_BYTES) throw new Error('fotka je na popis moc velká');
  const q = query({
    prompt: oneImage(img),
    options: {
      model: MODEL, effort: 'low', systemPrompt: DESCRIBE_SYSTEM,
      settingSources: [], tools: [], mcpServers: {}, strictMcpConfig: true,
      allowedTools: [], disallowedTools: DISALLOWED_TOOLS, permissionMode: 'dontAsk', maxTurns: 1,
    },
  });
  const timer = setTimeout(() => { q.interrupt?.().catch(() => {}); }, timeoutMs);
  try {
    for await (const msg of q) {
      if (msg.type !== 'result') continue;
      if (msg.subtype !== 'success' || typeof msg.result !== 'string') throw new Error((msg.errors || []).join('; ') || msg.subtype);
      const m = /\{[\s\S]*\}/.exec(msg.result);
      if (!m) throw new Error('model nevrátil JSON');
      return JSON.parse(m[0]);
    }
    throw new Error('model skončil bez výsledku');
  } finally {
    clearTimeout(timer);
    try { q.close?.(); } catch { /* gone */ }
  }
}

/** One line per photo, as Kacey reads a search result. */
export function describeForModel(p) {
  const when = new Date(p.taken_at || p.created_at);
  const d = isNaN(when) ? '' : `${when.getDate()}. ${when.getMonth() + 1}. ${when.getFullYear()}`;
  return `- (${p.id}) ${d} · ${p.title} — ${p.caption} [${p.tags.join(', ')}]${p.score != null ? ` · shoda ${p.score}` : ''}`;
}
