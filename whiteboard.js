/**
 * Kacey — whiteboards.
 *
 * Named boards for sorting out thoughts: text cards, coloured rectangles,
 * images and documents laid out freely, with arrows between them. The owner
 * edits them by hand on the Whiteboard screen (public/js/views/whiteboard.js)
 * and through the chat, where Kacey reads a board as a description of its
 * layout — what sits inside which rectangle, roughly where, what points where —
 * and changes it with a list of operations (app-tools.js).
 *
 * One row per board (db.js, kacey_whiteboard), the whole document as JSON in
 * the shape public/js/core/board.js defines and cleans. Files dropped on a
 * board sit in WHITEBOARD_DIR, served at /whiteboard-files/.
 *
 * Every change is reported through onEvent(); server.js broadcasts it as a
 * `whiteboard` frame, so an open board redraws when Kacey moves something.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { open, now } from './db.js';
import { WHITEBOARD_DIR } from './config.js';
import {
  GRID, SIZES, DEFAULT_COLOR, LIMITS, normalizeDoc, newId, colorKey, colorOf, fold, snap,
  bbox, centre, holds, parentOf, overlaps,
} from './public/js/core/board.js';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const KEEP_DELETED_MS = 7 * 24 * 3600 * 1000;

let listener = () => {};
export function onEvent(fn) { listener = typeof fn === 'function' ? fn : () => {}; }
function emit(ev) { try { listener(ev); } catch { /* a page went away */ } }

function boardId() { return 'b' + Date.now().toString(36) + randomBytes(3).toString('hex'); }

/* ---- rows ------------------------------------------------------------------- */

function parseDoc(s) { try { return normalizeDoc(JSON.parse(s)); } catch { return normalizeDoc({}); } }

function shape(r) {
  if (!r) return null;
  return { id: r.board_id, name: r.name, rev: r.rev, doc: parseDoc(r.doc), created_at: r.created_at, updated_at: r.updated_at };
}

/** What the gallery shows of a board: its name, counts and a drawing small enough to send in a list. */
export function summary(b) {
  if (!b) return null;
  const items = b.doc.items;
  return {
    id: b.id, name: b.name, rev: b.rev, created_at: b.created_at, updated_at: b.updated_at,
    counts: { items: items.length, links: b.doc.links.length },
    preview: {
      items: items.slice(0, 240).map((it) => ({ kind: it.kind, x: it.x, y: it.y, w: it.w, h: it.h, color: it.color })),
      links: b.doc.links.slice(0, 240).map((l) => [l.from, l.to]),
      ids: items.slice(0, 240).map((it) => it.id),
    },
  };
}

function row(id) { return open().prepare('SELECT * FROM kacey_whiteboard WHERE board_id = ? AND deleted_at IS NULL').get(String(id)); }

export function get(id) { return shape(row(id)); }

function purge() {
  const before = new Date(Date.now() - KEEP_DELETED_MS).toISOString();
  open().prepare('DELETE FROM kacey_whiteboard WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(before);
}

export function list() {
  purge();
  return open().prepare('SELECT * FROM kacey_whiteboard WHERE deleted_at IS NULL ORDER BY updated_at DESC').all()
    .map((r) => summary(shape(r)));
}

/** A board by its id, or by its name as said ("povinnosti" finds „Povinnosti — říjen“). */
export function find(ref) {
  if (!ref) return null;
  const byId = get(ref);
  if (byId) return byId;
  const want = fold(ref);
  const all = open().prepare('SELECT * FROM kacey_whiteboard WHERE deleted_at IS NULL ORDER BY updated_at DESC').all();
  const hit = all.find((r) => fold(r.name) === want) || all.find((r) => fold(r.name).includes(want));
  return shape(hit);
}

function cleanName(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.name);
  if (!n) throw new Error('Whiteboard potřebuje jméno.');
  return n;
}

/* Two boards may not share a name: the gallery and Kacey both find them by it. */
function uniqueName(name, exceptId) {
  const taken = new Set(open().prepare('SELECT board_id, name FROM kacey_whiteboard WHERE deleted_at IS NULL').all()
    .filter((r) => r.board_id !== exceptId).map((r) => fold(r.name)));
  if (!taken.has(fold(name))) return name;
  for (let n = 2; n < 100; n++) {
    const next = `${name} (${n})`;
    if (!taken.has(fold(next))) return next;
  }
  return `${name} (${Date.now().toString(36)})`;
}

export function create({ name, doc } = {}) {
  const id = boardId();
  const at = now();
  const n = uniqueName(cleanName(name || 'Nový whiteboard'));
  open().prepare('INSERT INTO kacey_whiteboard (board_id, name, doc, rev, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
    .run(id, n, JSON.stringify(normalizeDoc(doc || {})), at, at);
  const b = get(id);
  emit({ event: 'created', board: summary(b) });
  return b;
}

export function duplicate(id, name) {
  const src = get(id);
  if (!src) throw new Error('Takový whiteboard nemám.');
  const doc = JSON.parse(JSON.stringify(src.doc));
  return create({ name: name || `${src.name} — kopie`, doc });
}

export function rename(id, name) {
  const b = get(id);
  if (!b) throw new Error('Takový whiteboard nemám.');
  const n = uniqueName(cleanName(name), b.id);
  // A rename is not an edit of the board: it keeps its place in "upraveno".
  open().prepare('UPDATE kacey_whiteboard SET name = ? WHERE board_id = ?').run(n, b.id);
  const out = get(b.id);
  emit({ event: 'renamed', board: summary(out) });
  return out;
}

export function remove(id) {
  const b = get(id);
  if (!b) return false;
  open().prepare('UPDATE kacey_whiteboard SET deleted_at = ? WHERE board_id = ?').run(now(), b.id);
  emit({ event: 'removed', board: summary(b) });
  return true;
}

export function restore(id) {
  const r = open().prepare('SELECT * FROM kacey_whiteboard WHERE board_id = ?').get(String(id));
  if (!r) throw new Error('Ten whiteboard už vrátit nejde.');
  const n = uniqueName(r.name, r.board_id);
  open().prepare('UPDATE kacey_whiteboard SET deleted_at = NULL, name = ? WHERE board_id = ?').run(n, r.board_id);
  const b = get(r.board_id);
  emit({ event: 'restored', board: summary(b) });
  return b;
}

export class Conflict extends Error {
  constructor(board) { super('Whiteboard se mezitím změnil.'); this.board = board; }
}

/**
 * Store a whole document. `rev` is the revision the writer started from: a
 * page that missed Kacey's change gets a Conflict with the board as it is.
 * `by` is who wrote it ('page' | 'kacey'), `origin` the page that did, so it
 * can ignore its own echo.
 */
export function save(id, doc, { rev, by = 'page', origin = '', changes } = {}) {
  const b = get(id);
  if (!b) throw new Error('Takový whiteboard nemám.');
  if (rev != null && Number(rev) !== b.rev) throw new Conflict(b);
  const clean = normalizeDoc(doc);
  // The page keeps where it was looking; Kacey's writes do not move it.
  if (by === 'kacey') clean.view = b.doc.view;
  open().prepare('UPDATE kacey_whiteboard SET doc = ?, rev = rev + 1, updated_at = ? WHERE board_id = ?')
    .run(JSON.stringify(clean), now(), b.id);
  const out = get(b.id);
  emit({ event: 'changed', by, origin, board: out, summary: summary(out), changes: changes || null });
  return out;
}

/* ---- files -------------------------------------------------------------------- */

const TEXTISH = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|x-sh|javascript))/;

/** A file dropped on a board. Text-like files keep their beginning, so Kacey can read them. */
export function saveFile({ name, type, data }) {
  if (typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('Soubor nedorazil celý.');
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw new Error('Soubor je prázdný.');
  if (buf.length > MAX_FILE_BYTES) throw new Error('Soubor je větší než 25 MB.');
  const base = String(name || 'soubor').replace(/[/\\]/g, '_').slice(0, 160) || 'soubor';
  const ext = (path.extname(base).toLowerCase().match(/^\.[a-z0-9]{1,8}$/) || [''])[0];
  const file = 'w' + Date.now().toString(36) + randomBytes(4).toString('hex') + ext;
  if (!existsSync(WHITEBOARD_DIR)) mkdirSync(WHITEBOARD_DIR, { recursive: true });
  writeFileSync(path.join(WHITEBOARD_DIR, file), buf);
  const mime = String(type || '').slice(0, 100);
  const out = { name: base, type: mime, bytes: buf.length, url: '/whiteboard-files/' + file };
  if (TEXTISH.test(mime) || /\.(txt|md|csv|json|ya?ml|log)$/i.test(base)) {
    out.excerpt = buf.subarray(0, 24000).toString('utf8').replace(/\u0000/g, '').slice(0, LIMITS.excerpt);
  }
  return out;
}

/* ---- the board in words, for Kacey ----------------------------------------------- */

const KIND_WORDS = { text: 'text', rect: 'obdélník', image: 'obrázek', doc: 'dokument' };

function quote(s, max = 90) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '(bez textu)';
  return '„' + (t.length > max ? t.slice(0, max - 1) + '…' : t) + '“';
}

/** Roughly where a point sits in an area, in the words the owner would use. */
function whereIn(area, p) {
  if (!area || area.w < 1 || area.h < 1) return '';
  const fx = (p.x - area.x) / area.w, fy = (p.y - area.y) / area.h;
  const col = fx < 1 / 3 ? 0 : fx > 2 / 3 ? 2 : 1;
  const rw = fy < 1 / 3 ? 0 : fy > 2 / 3 ? 2 : 1;
  return [['vlevo nahoře', 'nahoře uprostřed', 'vpravo nahoře'],
    ['vlevo', 'uprostřed', 'vpravo'],
    ['vlevo dole', 'dole uprostřed', 'vpravo dole']][rw][col];
}

function sizeWords(bytes) {
  if (!bytes) return '';
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' kB';
}

function stamp(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getDate()}. ${d.getMonth() + 1}. ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function nameOf(it) { return it.kind === 'doc' ? quote(it.file?.name || it.text) : quote(it.text, 60); }

/**
 * The whole board as Kacey reads it: every object with its id, kind, colour,
 * text, position and size; which rectangle it sits in and roughly where; the
 * arrows. `view` is what the owner's screen shows, `selected` what they picked.
 */
export function describe(b, { view, selected } = {}) {
  const { items, links } = b.doc;
  const byId = new Map(items.map((it) => [it.id, it]));
  const area = bbox(items);
  const lines = [];
  lines.push(`WHITEBOARD ${quote(b.name)} (${b.id}) · ${items.length} objektů · ${links.length} šipek · upraveno ${stamp(b.updated_at)}`);
  lines.push(`Souřadnice v px při 100 %: x doprava, y dolů, mřížka ${GRID}. ` +
    (area ? `Obsah zabírá x ${area.x}…${area.x + area.w}, y ${area.y}…${area.y + area.h}.` : 'Plocha je prázdná.'));
  if (view && isFinite(view.x) && isFinite(view.w)) {
    lines.push(`Pán teď vidí x ${Math.round(view.x)}…${Math.round(view.x + view.w)}, y ${Math.round(view.y)}…${Math.round(view.y + view.h)} (zoom ${Math.round((view.z || 1) * 100)} %).`);
  }
  if (Array.isArray(selected) && selected.length) {
    const sel = selected.map((id) => byId.get(id)).filter(Boolean);
    if (sel.length) lines.push(`Pán má vybráno: ${sel.map((it) => `${it.id} ${nameOf(it)}`).join(', ')} — „tohle“ myslí nejspíš to.`);
  }
  if (!items.length) return lines.join('\n');

  const parent = new Map(items.map((it) => [it.id, parentOf(items, it)]));
  const outgoing = new Map(), incoming = new Map();
  for (const l of links) {
    (outgoing.get(l.from) || outgoing.set(l.from, []).get(l.from)).push(l);
    (incoming.get(l.to) || incoming.set(l.to, []).get(l.to)).push(l);
  }

  const line = (it) => {
    const p = parent.get(it.id);
    const where = p ? `v ${quote(p.text, 40)} (${p.id}), ${whereIn(p, centre(it))}` : `na ploše ${whereIn(area, centre(it))}`;
    const colour = colorOf(it.color).name;
    let head = `- ${it.id} ${KIND_WORDS[it.kind]} [${colour}] `;
    if (it.kind === 'doc') head += `${quote(it.file?.name || 'dokument')} (${[it.file?.type, sizeWords(it.file?.bytes)].filter(Boolean).join(', ')})`;
    else if (it.kind === 'image') head += it.text ? `s popiskem ${quote(it.text)}` : '(bez popisku)';
    else head += quote(it.text, it.kind === 'rect' ? 60 : 240);
    if (it.kicker) head += ` · štítek ${quote(it.kicker, 40)}`;
    head += ` · x ${it.x} y ${it.y} · ${it.w}×${it.h} · ${where}`;
    const out = (outgoing.get(it.id) || []).map((l) => l.to);
    const inn = (incoming.get(it.id) || []).map((l) => l.from);
    if (out.length) head += ` · → ${out.join(', ')}`;
    if (inn.length) head += ` · ← ${inn.join(', ')}`;
    if (it.by === 'kacey') head += ' · přidala Kacey';
    if (it.kind === 'doc' && it.file?.excerpt) head += `\n    obsah (začátek): ${quote(it.file.excerpt, 600)}`;
    else if (it.kind === 'doc') head += '\n    obsah: soubor neumím přečíst, znám jen jméno';
    return head;
  };

  const rects = items.filter((it) => it.kind === 'rect');
  if (rects.length) {
    lines.push('', 'OBDÉLNÍKY (oblasti; co v nich leží, k nim patří):');
    for (const r of rects) {
      const kids = items.filter((it) => parent.get(it.id) === r);
      lines.push(line(r) + ` · obsahuje ${kids.length ? kids.map((k) => k.id).join(', ') : 'nic'}`);
    }
  }
  const rest = items.filter((it) => it.kind !== 'rect')
    .sort((a, b2) => (parent.get(a.id)?.id || '').localeCompare(parent.get(b2.id)?.id || '') || a.y - b2.y || a.x - b2.x);
  if (rest.length) {
    lines.push('', 'OBJEKTY:');
    for (const it of rest) lines.push(line(it));
  }
  if (links.length) {
    lines.push('', 'ŠIPKY (od → k):');
    for (const l of links) {
      const a = byId.get(l.from), c = byId.get(l.to);
      lines.push(`- ${l.id}: ${l.from} ${nameOf(a)} → ${l.to} ${nameOf(c)}${l.label ? ` · popisek ${quote(l.label, 60)}` : ''}`);
    }
  }
  return lines.join('\n');
}

/* ---- Kacey's edits ------------------------------------------------------------- */

/* A card tall enough for its text: 14px monospace, 21px lines, 10px padding. */
const CHAR_W = 8.2;
export function textHeight(text, w, kicker) {
  const perLine = Math.max(8, Math.floor((w - 28) / CHAR_W));
  const lines = String(text || '').split('\n').reduce((n, p) => n + Math.max(1, Math.ceil(p.length / perLine)), 0);
  const h = 22 + lines * 21 + (kicker ? 20 : 0);
  return Math.max(48, Math.ceil(h / GRID) * GRID);
}

function textWidth(text) {
  const n = String(text || '').length;
  return n > 140 ? 312 : n > 60 ? 264 : SIZES.text.w;
}

/* The first free spot in an area, row by row on the grid, clear of `obstacles`. */
function findFree(obstacles, area, w, h) {
  const maxX = Math.max(area.x, area.x + area.w - w);
  for (let row = 0; row < 400; row++) {
    const y = area.y + row * GRID;
    for (let x = area.x; x <= maxX; x += GRID) {
      const box = { x, y, w, h };
      if (!obstacles.some((o) => overlaps(o, box, 12))) return { x, y };
    }
  }
  return { x: area.x, y: area.y + 400 * GRID };
}

/* Inside a rectangle: below its title, left to right, and the rectangle grows when it is full. */
function placeInside(doc, rect, w, h) {
  const area = { x: rect.x + GRID, y: rect.y + 2 * GRID, w: rect.w - 2 * GRID };
  // Whatever lies on it, except the rectangles it lies in itself.
  const obstacles = doc.items.filter((it) => it !== rect && overlaps(it, rect) && !(it.kind === 'rect' && holds(it, rect)));
  const spot = findFree(obstacles, area, Math.min(w, area.w), h);
  if (spot.y + h + GRID > rect.y + rect.h) rect.h = snap(spot.y + h + GRID - rect.y);
  if (spot.x + w + GRID > rect.x + rect.w) rect.w = snap(spot.x + w + GRID - rect.x);
  return spot;
}

function placeNear(doc, target, side, w, h) {
  const gap = 3 * GRID;
  let x = target.x, y = target.y;
  if (side === 'right') x = target.x + target.w + gap;
  else if (side === 'left') x = target.x - gap - w;
  else if (side === 'above') y = target.y - 2 * GRID - h;
  else y = target.y + target.h + 2 * GRID;
  const horizontal = side === 'right' || side === 'left';
  for (let i = 0; i < 80; i++) {
    const box = { x: snap(x), y: snap(y), w, h };
    if (!doc.items.some((o) => o.kind !== 'rect' && overlaps(o, box, 12))) return box;
    if (horizontal) y += GRID; else x += GRID;
  }
  return { x: snap(x), y: snap(y) };
}

function childrenOf(doc, rect) {
  return doc.items.filter((it) => it !== rect && holds(rect, it));
}

function moveBy(doc, it, dx, dy) {
  const moving = it.kind === 'rect' ? [it, ...childrenOf(doc, it)] : [it];
  for (const m of moving) { m.x += dx; m.y += dy; }
}

/* Re-lay a rectangle's contents in reading order and fit the rectangle around them. */
function tidy(doc, rect) {
  const kids = childrenOf(doc, rect).filter((k) => !doc.items.some((r2) => r2 !== rect && r2.kind === 'rect' && holds(r2, k) && holds(rect, r2)));
  kids.sort((a, b) => a.y - b.y || a.x - b.x);
  const inner = rect.w - 2 * GRID;
  let x = rect.x + GRID, y = rect.y + 2 * GRID, rowH = 0;
  for (const k of kids) {
    if (x > rect.x + GRID && x + k.w > rect.x + GRID + inner) { x = rect.x + GRID; y += rowH + GRID; rowH = 0; }
    moveBy(doc, k, x - k.x, y - k.y);
    x += k.w + GRID; rowH = Math.max(rowH, k.h);
  }
  rect.h = Math.max(4 * GRID, snap(y + rowH + GRID - rect.y));
  return kids.length;
}

/**
 * Apply a list of operations to a board and store it. Each op may name an
 * object by its id, by the `ref` an earlier op of the same call gave it, or by
 * its text. Returns the stored board and one line per op saying what happened
 * (with the ids of what was made), plus the errors.
 */
export function applyOps(b, ops, { gallery } = {}) {
  const doc = JSON.parse(JSON.stringify(b.doc));
  const refs = new Map();
  const done = [], errors = [];
  let added = 0, changed = 0, removed = 0;

  const byId = (id) => doc.items.find((it) => it.id === id);
  const resolve = (r) => {
    if (r == null || r === '') return null;
    const key = String(r);
    const hit = byId(refs.get(key) || key);
    if (hit) return hit;
    const want = fold(key.replace(/^[„"']|[“"']$/g, ''));
    return doc.items.find((it) => fold(it.text) === want) || doc.items.find((it) => it.kind === 'rect' && fold(it.text).startsWith(want)) || null;
  };
  const need = (r, what) => {
    const it = resolve(r);
    if (!it) throw new Error(`${what} „${r}“ na ploše není`);
    return it;
  };

  // Things placed without a position flow to the right of what is already there.
  const start = bbox(doc.items);
  const freeArea = start ? { x: snap(start.x + start.w + 4 * GRID), y: snap(start.y), w: 30 * GRID } : { x: 0, y: 0, w: 40 * GRID };

  ops.forEach((op, n) => {
    const tag = `#${n + 1} ${op.op}`;
    try {
      if (op.op === 'add') {
        const kind = op.kind || 'text';
        if (kind === 'doc') throw new Error('dokument přidá jen pán přetažením souboru; napiš obsah do textu');
        const it = { id: newId(kind[0]), kind, x: 0, y: 0, w: 0, h: 0, color: colorKey(op.color) || DEFAULT_COLOR[kind], text: String(op.text || '').slice(0, LIMITS.text), by: 'kacey' };
        if (op.kicker) it.kicker = String(op.kicker).slice(0, LIMITS.kicker);
        if (kind === 'image') {
          const photo = op.photo && gallery ? gallery(op.photo) : null;
          if (!photo) throw new Error('obrázek potřebuje photo = id fotky z Galerie (app_gallery_search)');
          it.src = photo.url;
          if (!op.text && photo.title) it.text = photo.title;
          const ratio = photo.width && photo.height ? photo.height / photo.width : 0.75;
          it.w = op.w || SIZES.image.w; it.h = op.h || snap(it.w * ratio) + (it.text ? GRID : 0);
        } else {
          it.w = op.w || (kind === 'text' ? textWidth(it.text) : SIZES.rect.w);
          it.h = op.h || (kind === 'text' ? textHeight(it.text, it.w, it.kicker) : SIZES.rect.h);
        }
        it.w = snap(it.w); it.h = Math.max(GRID * 2, snap(it.h));
        let spot;
        if (op.x != null && op.y != null) spot = { x: snap(op.x), y: snap(op.y) };
        else if (op.inside) spot = placeInside(doc, need(op.inside, 'obdélník'), it.w, it.h);
        else if (op.near) spot = placeNear(doc, need(op.near, 'objekt'), op.side || 'below', it.w, it.h);
        else spot = findFree(doc.items, freeArea, it.w, it.h);
        it.x = spot.x; it.y = spot.y;
        doc.items.push(it);
        if (op.ref) refs.set(String(op.ref), it.id);
        added++;
        const p = parentOf(doc.items, it);
        done.push(`${tag}: ${it.id}${op.ref ? ` (ref ${op.ref})` : ''} ${KIND_WORDS[kind]} ${quote(it.text, 50)} x ${it.x} y ${it.y}${p ? ` v ${quote(p.text, 30)}` : ''}`);
      } else if (op.op === 'update') {
        const it = need(op.id, 'objekt');
        if (op.text != null) it.text = String(op.text).slice(0, LIMITS.text);
        if (op.kicker != null) { if (op.kicker) it.kicker = String(op.kicker).slice(0, LIMITS.kicker); else delete it.kicker; }
        if (op.color) {
          const c = colorKey(op.color);
          if (!c) throw new Error(`barvu „${op.color}“ neznám`);
          it.color = c;
        }
        if (op.w) it.w = snap(op.w);
        if (op.h) it.h = snap(op.h);
        else if (it.kind === 'text' && (op.text != null || op.w)) it.h = Math.max(it.h, textHeight(it.text, it.w, it.kicker));
        if (op.x != null || op.y != null) moveBy(doc, it, op.x != null ? snap(op.x) - it.x : 0, op.y != null ? snap(op.y) - it.y : 0);
        if (op.dx || op.dy) moveBy(doc, it, snap(op.dx || 0), snap(op.dy || 0));
        if (op.inside) {
          const r = need(op.inside, 'obdélník');
          const spot = placeInside({ ...doc, items: doc.items.filter((o) => o !== it) }, r, it.w, it.h);
          moveBy(doc, it, spot.x - it.x, spot.y - it.y);
        } else if (op.near) {
          const t = need(op.near, 'objekt');
          const spot = placeNear({ ...doc, items: doc.items.filter((o) => o !== it) }, t, op.side || 'below', it.w, it.h);
          moveBy(doc, it, spot.x - it.x, spot.y - it.y);
        }
        changed++;
        done.push(`${tag}: ${it.id} ${quote(it.text, 40)} x ${it.x} y ${it.y} · ${it.w}×${it.h}`);
      } else if (op.op === 'delete') {
        const it = need(op.id, 'objekt');
        const gone = new Set([it.id]);
        if (op.with_contents && it.kind === 'rect') for (const k of childrenOf(doc, it)) gone.add(k.id);
        doc.items = doc.items.filter((o) => !gone.has(o.id));
        doc.links = doc.links.filter((l) => !gone.has(l.from) && !gone.has(l.to));
        removed += gone.size;
        done.push(`${tag}: smazáno ${[...gone].join(', ')}`);
      } else if (op.op === 'connect') {
        const a = need(op.from, 'objekt'), c = need(op.to, 'objekt');
        if (a === c) throw new Error('šipka musí vést k jinému objektu');
        let l = doc.links.find((x) => x.from === a.id && x.to === c.id);
        if (!l) { l = { id: newId('a'), from: a.id, to: c.id }; doc.links.push(l); added++; } else changed++;
        if (op.label != null) { if (op.label) l.label = String(op.label).slice(0, LIMITS.label); else delete l.label; }
        if (op.ref) refs.set(String(op.ref), l.id);
        done.push(`${tag}: ${l.id} ${a.id} → ${c.id}${l.label ? ` ${quote(l.label, 30)}` : ''}`);
      } else if (op.op === 'disconnect') {
        const before = doc.links.length;
        if (op.id && doc.links.some((l) => l.id === op.id)) doc.links = doc.links.filter((l) => l.id !== op.id);
        else {
          const a = need(op.from, 'objekt'), c = need(op.to, 'objekt');
          doc.links = doc.links.filter((l) => !(l.from === a.id && l.to === c.id) && !(op.both && l.from === c.id && l.to === a.id));
        }
        if (doc.links.length === before) throw new Error('takovou šipku tu nemám');
        removed += before - doc.links.length;
        done.push(`${tag}: šipek pryč ${before - doc.links.length}`);
      } else if (op.op === 'tidy') {
        const r = need(op.inside || op.id, 'obdélník');
        if (r.kind !== 'rect') throw new Error('uklidit jde jen obsah obdélníku');
        const k = tidy(doc, r);
        changed += k;
        done.push(`${tag}: v ${quote(r.text, 30)} srovnáno ${k} objektů, obdélník ${r.w}×${r.h}`);
      } else if (op.op === 'clear') {
        removed += doc.items.length;
        doc.items = []; doc.links = [];
        done.push(`${tag}: plocha je prázdná`);
      } else {
        throw new Error('neznámá operace');
      }
    } catch (err) {
      errors.push(`${tag}: ${err.message}`);
    }
  });

  if (!added && !changed && !removed) return { board: b, done, errors, changes: 0 };
  const out = save(b.id, doc, { by: 'kacey', changes: { added, changed, removed } });
  return { board: out, done, errors, changes: added + changed + removed, counts: { added, changed, removed } };
}

/* ---- sample boards, for a preview only ------------------------------------------ */

const MOUNTAIN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 320"><rect width="480" height="320" fill="#20262b"/><circle cx="370" cy="78" r="30" fill="#f1c21b"/><path d="M0 250 140 110 230 200 300 140 480 280V320H0z" fill="#3d4a52"/><path d="M140 110 172 142 156 140 140 152 124 138z" fill="#e8eef2"/><path d="M0 286 90 230 190 270 300 220 480 300V320H0z" fill="#24a148" opacity=".75"/><rect x="62" y="236" width="44" height="34" fill="#8a5a3c"/><path d="M56 238 84 214 112 238z" fill="#5c3b28"/></svg>`;

const PACKING_TXT = `Chalupa — co s sebou
- spacák, karimatka
- čelovka + baterky
- jídlo na 2 dny (těstoviny, konzervy, káva)
- klíče od chalupy od mámy!
- deskovky
- nabíječka, powerbanka`;

function sampleFile(name, type, body) {
  return saveFile({ name, type, data: Buffer.from(body, 'utf8').toString('base64') });
}

/** Two boards that show what a board can hold — the running app never gets them. */
export function seedSamples() {
  const have = open().prepare('SELECT COUNT(*) AS n FROM kacey_whiteboard').get().n;
  if (have) return 0;
  const t = (id, x, y, text, color, extra) => ({ id, kind: 'text', x, y, w: 216, h: textHeight(text, 216, extra?.kicker), text, color, ...extra });
  const duties = {
    items: [
      { id: 'r_work', kind: 'rect', x: 0, y: 0, w: 528, h: 360, color: 'blue', text: 'Práce' },
      { id: 'r_school', kind: 'rect', x: 576, y: 0, w: 528, h: 360, color: 'violet', text: 'Škola' },
      { id: 'r_home', kind: 'rect', x: 0, y: 408, w: 528, h: 264, color: 'amber', text: 'Domácnost' },
      { id: 'r_health', kind: 'rect', x: 576, y: 408, w: 528, h: 264, color: 'green', text: 'Zdraví' },
      t('t_report', 24, 48, 'Odevzdat měsíční report', 'blue', { kicker: 'ÚKOL · DNES 17:00', by: 'kacey' }),
      t('t_invoice', 264, 48, 'Poslat fakturu za září', 'blue', { kicker: 'ÚKOL · ZÍTRA', by: 'kacey' }),
      t('t_standup', 24, 192, 'Porada týmu — připravit 3 body', 'grey', { kicker: 'KALENDÁŘ · ČT 10:30', by: 'kacey' }),
      t('t_thesis', 600, 48, 'Kapitola 2 diplomky — první verze', 'violet', { kicker: 'ÚKOL · TENTO TÝDEN', by: 'kacey' }),
      t('t_lab', 840, 48, 'Protokol z laboratoře', 'violet', { kicker: 'ÚKOL · PO TERMÍNU', by: 'kacey' }),
      t('t_consult', 600, 192, 'Konzultace s vedoucím', 'grey', { kicker: 'KALENDÁŘ · PÁ 13:00', by: 'kacey' }),
      t('t_plants', 24, 456, 'Zalít kytky', 'amber', { kicker: 'RÁNO · CHECKLIST', by: 'kacey' }),
      t('t_rent', 264, 456, 'Zaplatit nájem do 25.', 'amber', { kicker: 'ÚKOL · 25. 10.', by: 'kacey' }),
      t('t_dentist', 600, 456, 'Zubař — objednat prohlídku', 'green', { kicker: 'ZMÍNKA V DENÍKU · 12. 10.', by: 'kacey' }),
      t('t_gym', 840, 456, 'Posilovna 3× týdně', 'green', { kicker: 'RUTINA · PO ST PÁ', by: 'kacey' }),
      { id: 't_first', kind: 'text', x: 1176, y: 48, w: 264, h: textHeight('Co nejdřív? Report blokuje fakturu, protokol je po termínu.', 264), text: 'Co nejdřív? Report blokuje fakturu, protokol je po termínu.', color: 'red' },
    ],
    links: [
      { id: 'a1', from: 't_report', to: 't_invoice', label: 'pak' },
      { id: 'a2', from: 't_first', to: 't_lab' },
      { id: 'a3', from: 't_consult', to: 't_thesis', label: 'probrat' },
    ],
    view: { x: -48, y: -96, z: 0.85 },
  };
  create({ name: 'Povinnosti — tento týden', doc: duties });

  let mountain = null, packing = null;
  try {
    mountain = sampleFile('chalupa.svg', 'image/svg+xml', MOUNTAIN_SVG);
    packing = sampleFile('co-s-sebou.txt', 'text/plain', PACKING_TXT);
  } catch { /* no disk: the board still shows the rest */ }
  const trip = {
    items: [
      { id: 'n_title', kind: 'rect', x: 0, y: 0, w: 960, h: 504, color: 'teal', text: 'Víkend na chalupě · 31. 10.' },
      ...(mountain ? [{ id: 'n_pic', kind: 'image', x: 24, y: 48, w: 336, h: 248, src: mountain.url, text: 'Výhled od chalupy', color: 'grey' }] : []),
      t('n_who', 408, 48, 'Kdo jede: já, Tom, Bára — Ondra možná', 'teal'),
      t('n_car', 408, 168, 'Auto: půjčit od táty, vrátit v neděli do 18:00', 'grey'),
      t('n_food', 672, 48, 'Nákup v pátek cestou', 'amber'),
      ...(packing ? [{ id: 'n_list', kind: 'doc', x: 672, y: 168, w: 264, h: 72, color: 'grey', text: '', file: packing }] : []),
      t('n_wood', 24, 360, 'Dříví — je ho dost? Zeptat se souseda', 'red'),
    ],
    links: [
      { id: 'b1', from: 'n_food', to: 'n_car', label: 'až bude auto' },
      ...(packing ? [{ id: 'b2', from: 'n_food', to: 'n_list' }] : []),
    ],
    view: { x: -72, y: -96, z: 1 },
  };
  create({ name: 'Nápady — víkend na chalupě', doc: trip });
  return 2;
}
