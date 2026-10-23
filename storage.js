/**
 * Kacey — Úložiště, quick storage between the owner's devices.
 *
 * Any file goes up from the computer or the phone (the Úložiště screen,
 * public/js/views/storage.js) and comes down on any other. Nothing is read,
 * described or converted: the bytes stay as they came, under the name they
 * came with, until the owner deletes them. Files do not expire. A picture,
 * video, sound, PDF or text can also be opened in the page (viewable()).
 *
 * The bytes sit in STORAGE_DIR under the file's id (no extension, so nothing
 * there is ever served as what its name says); the name, type, size and the
 * device it came from are a row in kacey_file (db.js). An upload streams
 * straight to disk — a 2 GB video never sits in memory. A deleted file keeps
 * its row and bytes for a day, which is what Vrátit restores.
 *
 * Every change is reported through onEvent(); server.js broadcasts it as a
 * `storage` frame, so a list open on the other device fills in at once.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { open, now } from './db.js';
import { STORAGE_DIR } from './config.js';
import { viewOf } from './public/js/core/filekind.js';

/** One file at most this big. The disk is the real limit; this keeps a mistake from filling it. */
export const MAX_FILE_BYTES = 4 * 1024 ** 3;
const KEEP_DELETED_MS = 24 * 3600 * 1000;
const DEVICES = new Set(['desktop', 'phone', 'kacey']);

let listener = () => {};
export function onEvent(fn) { listener = typeof fn === 'function' ? fn : () => {}; }
function emit(ev) { try { listener(ev); } catch { /* a page went away */ } }

function fileId() { return 'f' + Date.now().toString(36) + randomBytes(5).toString('hex'); }

function ensureDir() { if (!existsSync(STORAGE_DIR)) mkdirSync(STORAGE_DIR, { recursive: true }); }

export function pathOf(id) { return path.join(STORAGE_DIR, String(id).replace(/[^a-z0-9]/g, '')); }

/** A name that is safe on every system it might be saved to, and still the owner's. */
export function cleanName(v) {
  const s = String(v || '').replace(/[\u0000-\u001f/\\]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 200);
  return s && s !== '.' && s !== '..' ? s : 'soubor';
}

function shape(r) {
  if (!r) return null;
  return { id: r.file_id, name: r.name, type: r.media_type, bytes: r.bytes, device: r.device, created_at: r.created_at };
}

function row(id) {
  return open().prepare('SELECT * FROM kacey_file WHERE file_id = ? AND deleted_at IS NULL').get(String(id || ''));
}

export function get(id) { return shape(row(id)); }

function startsWith(file, magic) {
  let fd = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(magic.length);
    return readSync(fd, buf, 0, magic.length, 0) === magic.length && buf.toString('latin1') === magic;
  } catch { return false; } finally { if (fd != null) closeSync(fd); }
}

/**
 * The file as the náhled may show it — { file, kind, type, ext }, or null when
 * its name is not a kind it shows (public/js/core/filekind.js). A PDF must
 * also start like one: it is the only kind served without the sandbox, as a
 * browser will not draw a PDF in a sandboxed page.
 */
export function viewable(id) {
  const f = get(id);
  const v = f && viewOf(f.name);
  if (!v) return null;
  if (v.kind === 'pdf' && !startsWith(pathOf(f.id), '%PDF-')) return null;
  return { file: f, ...v };
}

/* Deleted more than a day ago: the bytes go for good. */
function purge() {
  const before = new Date(Date.now() - KEEP_DELETED_MS).toISOString();
  const gone = open().prepare('SELECT file_id FROM kacey_file WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(before);
  for (const g of gone) { try { rmSync(pathOf(g.file_id), { force: true }); } catch { /* already gone */ } }
  if (gone.length) open().prepare('DELETE FROM kacey_file WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(before);
}

/** How much the disk under STORAGE_DIR has left, in bytes (null when it cannot say). */
export function freeBytes() {
  try { ensureDir(); const s = statfsSync(STORAGE_DIR); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

/** Every file, newest first, with the totals the screen shows. */
export function list() {
  purge();
  const files = open().prepare('SELECT * FROM kacey_file WHERE deleted_at IS NULL ORDER BY created_at DESC, file_id DESC').all().map(shape);
  return { files, total_bytes: files.reduce((s, f) => s + f.bytes, 0), free_bytes: freeBytes(), max_file_bytes: MAX_FILE_BYTES };
}

/**
 * Take one upload off the wire. `stream` is the request itself; it is written
 * to a .part file and renamed only when complete, so a cut connection never
 * leaves half a file in the list.
 */
export function receive(stream, { name, type, device, expected, origin = '' } = {}) {
  return new Promise((resolve, reject) => {
    if (expected != null && expected > MAX_FILE_BYTES) { reject(new Error('Soubor je větší než 4 GB.')); return; }
    ensureDir();
    const id = fileId();
    const part = pathOf(id) + '.part';
    const out = createWriteStream(part);
    let bytes = 0, done = false;
    const fail = (msg) => {
      if (done) return;
      done = true;
      out.destroy();
      try { rmSync(part, { force: true }); } catch { /* nothing written */ }
      reject(new Error(msg));
    };
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_FILE_BYTES) { stream.unpipe(out); stream.resume(); fail('Soubor je větší než 4 GB.'); }
    });
    stream.on('aborted', () => fail('Nahrávání se přerušilo.'));
    stream.on('close', () => { if (stream.complete === false) fail('Nahrávání se přerušilo.'); });
    stream.on('error', () => fail('Nahrávání se přerušilo.'));
    out.on('error', (err) => fail(err.code === 'ENOSPC' ? 'Na disku došlo místo.' : 'Soubor se nepodařilo uložit.'));
    out.on('finish', () => {
      if (done) return;
      if (expected != null && bytes !== expected) { fail('Soubor nedorazil celý.'); return; }
      done = true;
      try {
        renameSync(part, pathOf(id));
        open().prepare('INSERT INTO kacey_file (file_id, name, media_type, bytes, device, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, cleanName(name), String(type || '').slice(0, 120), bytes, DEVICES.has(device) ? device : 'desktop', now());
        const file = get(id);
        emit({ event: 'added', file, origin });
        resolve(file);
      } catch (err) {
        try { rmSync(part, { force: true }); rmSync(pathOf(id), { force: true }); } catch { /* nothing to clean */ }
        reject(new Error('Soubor se nepodařilo uložit.'));
      }
    });
    stream.pipe(out);
  });
}

/** Delete one or more files (kept a day for Vrátit). The files as they were. */
export function remove(ids, { origin = '' } = {}) {
  const gone = [];
  const t = now();
  for (const id of [].concat(ids || []).slice(0, 500)) {
    const f = get(id);
    if (!f) continue;
    open().prepare('UPDATE kacey_file SET deleted_at = ? WHERE file_id = ?').run(t, f.id);
    gone.push(f);
  }
  if (gone.length) emit({ event: 'removed', ids: gone.map((f) => f.id), origin });
  return gone;
}

/** Vrátit: files deleted within the day come back as they were. */
export function restore(ids, { origin = '' } = {}) {
  const back = [];
  for (const id of [].concat(ids || []).slice(0, 500)) {
    const r = open().prepare('SELECT * FROM kacey_file WHERE file_id = ? AND deleted_at IS NOT NULL').get(String(id || ''));
    if (!r || !existsSync(pathOf(r.file_id))) continue;
    open().prepare('UPDATE kacey_file SET deleted_at = NULL WHERE file_id = ?').run(r.file_id);
    back.push(get(r.file_id));
  }
  if (!back.length) throw new Error('Ty soubory už vrátit nejde.');
  emit({ event: 'restored', files: back, origin });
  return back;
}

/** The self-update preview: a few small files, so the list has something to show.
    Only into a table that has never had one. */
export function seedSamples() {
  if (open().prepare('SELECT COUNT(*) AS n FROM kacey_file').get().n) return 0;
  ensureDir();
  const hour = 3600 * 1000;
  const samples = [
    { name: 'Nákupní seznam.txt', type: 'text/plain', device: 'phone', ago: 0.4 * hour,
      body: 'mléko\nvejce\nchleba\nrajčata\nkáva — ta dobrá\n' },
    { name: 'rozpočet-říjen.csv', type: 'text/csv', device: 'desktop', ago: 5 * hour,
      body: 'položka;částka\nnájem;14500\nenergie;2300\njídlo;6800\nposilovna;890\n'.repeat(40) },
    { name: 'Poznámky z porady.md', type: 'text/markdown', device: 'desktop', ago: 27 * hour,
      body: '# Porada týmu\n\n- report do pátku\n- nový termín pro demo: 4. 11.\n- Petr připraví podklady\n'.repeat(12) },
    { name: 'kacey-znacka.svg', type: 'image/svg+xml', device: 'desktop', ago: 3 * 24 * hour,
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#161616"/><rect x="20" y="20" width="24" height="24" fill="#5ed6f2"/></svg>\n' },
    { name: 'nastaveni-zalohy.json', type: 'application/json', device: 'phone', ago: 9 * 24 * hour,
      body: JSON.stringify({ zaloha: { kdy: '03:00', kam: 'kaceybody', ponechat: 14 } }, null, 2).repeat(30) },
  ];
  const ins = open().prepare('INSERT INTO kacey_file (file_id, name, media_type, bytes, device, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  samples.forEach((s, i) => {
    const id = fileId() + i;
    const buf = Buffer.from(s.body, 'utf8');
    writeFileSync(pathOf(id), buf);
    ins.run(id, s.name, s.type, buf.length, s.device, new Date(Date.now() - s.ago).toISOString());
  });
  return samples.length;
}
