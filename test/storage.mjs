// Úložiště — storage.js (uploads streamed to disk, a cut or short upload
// leaving nothing behind, delete + Vrátit within the day, the purge, the
// events the other device hears), core/filekind.js (which files the náhled
// shows and as what, and that a "PDF" which is not one is not served
// unsandboxed), and Kacey's app_storage. Throwaway database and folder.
// Run: node test/storage.mjs

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kacey-storage-'));
process.env.KLAUS_DB = path.join(dir, 'test.db');
process.env.KACEY_STATE_PATH = path.join(dir, 'no-such-file.json');
process.env.KACEY_STORAGE_DIR = path.join(dir, 'files');

const db = await import('../db.js');
const storage = await import('../storage.js');
const { viewOf } = await import('../public/js/core/filekind.js');
const { APP_TOOL_NAMES, makeStorageTools } = await import('../app-tools.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
}

const events = [];
storage.onEvent((ev) => events.push(ev));
const FILES = process.env.KACEY_STORAGE_DIR;
const put = (name, body, opts = {}) => storage.receive(Object.assign(Readable.from([Buffer.from(body)]), { complete: true }), { name, device: 'desktop', ...opts });
const clear = () => { db.open().exec('DELETE FROM kacey_file'); events.length = 0; };
const leftovers = () => readdirSync(FILES).filter((n) => n.endsWith('.part'));
const text = (out) => out.content.map((c) => c.text).join('\n');

/* ---- the náhled's kinds ------------------------------------------------------ */

await test('viewOf: kinds by extension, any case', () => {
  assert.equal(viewOf('Dovolená.JPG').kind, 'image');
  assert.equal(viewOf('video.mov').type, 'video/mp4');
  assert.equal(viewOf('hlasovka.m4a').kind, 'audio');
  assert.equal(viewOf('smlouva.pdf').kind, 'pdf');
  assert.equal(viewOf('rozpočet.csv').kind, 'table');
  assert.equal(viewOf('stránka.html').type, 'text/plain; charset=utf-8');
  assert.equal(viewOf('archiv.zip'), null);
  assert.equal(viewOf('bez přípony'), null);
});

await test('viewable: a text shows, a zip does not', async () => {
  const t = await put('poznámky.md', '# ahoj\n');
  const z = await put('zaloha.zip', 'PK\u0003\u0004');
  assert.equal(storage.viewable(t.id).kind, 'text');
  assert.equal(storage.viewable(z.id), null);
  assert.equal(storage.viewable('fnope'), null);
});

await test('viewable: a PDF only when it starts like one', async () => {
  const real = await put('faktura.pdf', '%PDF-1.7\n…');
  const fake = await put('nebezpecne.pdf', '<script>alert(1)</script>');
  assert.equal(storage.viewable(real.id).kind, 'pdf');
  assert.equal(storage.viewable(fake.id), null);
});

await test('viewable: a deleted file is gone', async () => {
  const f = await put('foto.png', 'x');
  storage.remove([f.id]);
  assert.equal(storage.viewable(f.id), null);
});

/* ---- uploads ----------------------------------------------------------------- */

await test('an upload lands on disk under its id, with its name, size and device, and is announced', async () => {
  clear();
  const f = await put('Výplatní páska — říjen.pdf', '%PDF-1.4 hello', { type: 'application/pdf', device: 'phone', origin: 'p1' });
  assert.equal(f.name, 'Výplatní páska — říjen.pdf');
  assert.equal(f.bytes, Buffer.byteLength('%PDF-1.4 hello'));
  assert.equal(f.device, 'phone');
  assert.equal(f.type, 'application/pdf');
  assert.equal(readFileSync(storage.pathOf(f.id), 'utf8'), '%PDF-1.4 hello');
  assert.ok(!path.basename(storage.pathOf(f.id)).includes('.'), 'no extension on disk');
  assert.deepEqual(events.map((e) => [e.event, e.file?.id, e.origin]), [['added', f.id, 'p1']]);
});

await test('a name is cleaned of paths and control characters; an unknown device is a desktop', async () => {
  assert.equal(storage.cleanName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(storage.cleanName('a\u0000b\nc'), 'a_b_c');
  assert.equal(storage.cleanName('   '), 'soubor');
  assert.equal(storage.cleanName('..'), 'soubor');
  assert.equal(storage.cleanName('x'.repeat(300)).length, 200);
  const f = await put('ok.txt', 'x', { device: 'toaster' });
  assert.equal(f.device, 'desktop');
});

await test('more than 4 GB is refused before a byte is written', async () => {
  await assert.rejects(put('obr.iso', 'x', { expected: storage.MAX_FILE_BYTES + 1 }), /4 GB/);
  assert.deepEqual(leftovers(), []);
});

await test('a short upload is not kept, and leaves no .part behind', async () => {
  clear();
  await assert.rejects(put('napůl.mp4', 'abc', { expected: 10 }), /nedorazil celý/);
  assert.equal(storage.list().files.length, 0);
  assert.deepEqual(leftovers(), []);
  assert.equal(events.length, 0, 'nothing announced');
});

await test('a cut connection is not kept either', async () => {
  clear();
  const s = new Readable({ read() {} });
  s.complete = false;
  const p = storage.receive(s, { name: 'video.mp4', device: 'phone' });
  s.push(Buffer.from('first chunk'));
  setTimeout(() => s.destroy(), 10);
  await assert.rejects(p, /přerušilo/);
  assert.equal(storage.list().files.length, 0);
  assert.deepEqual(leftovers(), []);
});

/* ---- the list, delete and Vrátit ------------------------------------------------ */

await test('list: newest first, with the total and the free disk', async () => {
  clear();
  const a = await put('a.txt', '12345');
  await new Promise((r) => setTimeout(r, 5));
  const b = await put('b.txt', '123');
  const l = storage.list();
  assert.deepEqual(l.files.map((f) => f.id), [b.id, a.id]);
  assert.equal(l.total_bytes, 8);
  assert.ok(l.free_bytes == null || l.free_bytes > 0);
  assert.equal(l.max_file_bytes, storage.MAX_FILE_BYTES);
});

await test('delete hides several at once, Vrátit brings them back, both announced', async () => {
  clear();
  const a = await put('a.txt', 'a');
  const b = await put('b.txt', 'b');
  events.length = 0;
  const gone = storage.remove([a.id, b.id, 'fnope'], { origin: 'p2' });
  assert.equal(gone.length, 2);
  assert.equal(storage.list().files.length, 0);
  assert.equal(storage.get(a.id), null);
  assert.ok(existsSync(storage.pathOf(a.id)), 'the bytes stay for the day');
  const back = storage.restore([a.id, b.id], { origin: 'p2' });
  assert.equal(back.length, 2);
  assert.equal(storage.list().files.length, 2);
  assert.deepEqual(events.map((e) => [e.event, e.origin]), [['removed', 'p2'], ['restored', 'p2']]);
  assert.deepEqual(events[0].ids.sort(), [a.id, b.id].sort());
});

await test('deleting nothing is nothing; restoring what is not deleted fails', async () => {
  clear();
  assert.deepEqual(storage.remove(['fnope']), []);
  assert.equal(events.length, 0);
  const f = await put('živý.txt', 'x');
  assert.throws(() => storage.restore([f.id]), /vrátit nejde/);
});

await test('a day after the delete the file goes for good, and so does a stale .part', async () => {
  clear();
  const f = await put('stará záloha.zip', 'PK');
  storage.remove([f.id]);
  const twoDays = new Date(Date.now() - 48 * 3600 * 1000);
  db.open().prepare('UPDATE kacey_file SET deleted_at = ? WHERE file_id = ?').run(twoDays.toISOString(), f.id);
  const stale = path.join(FILES, 'fstale.part');
  const fresh = path.join(FILES, 'ffresh.part');
  writeFileSync(stale, 'x'); writeFileSync(fresh, 'x');
  utimesSync(stale, twoDays, twoDays);
  storage.list();
  assert.ok(!existsSync(storage.pathOf(f.id)));
  assert.equal(db.open().prepare('SELECT COUNT(*) AS n FROM kacey_file').get().n, 0);
  assert.throws(() => storage.restore([f.id]), /vrátit nejde/);
  assert.ok(!existsSync(stale), 'an upload a stopped server left');
  assert.ok(existsSync(fresh), 'one that may still be going up stays');
  rmSync(fresh);
});

await test('a file whose bytes vanished cannot be restored', async () => {
  clear();
  const f = await put('pryč.txt', 'x');
  storage.remove([f.id]);
  rmSync(storage.pathOf(f.id));
  assert.throws(() => storage.restore([f.id]), /vrátit nejde/);
});

/* ---- written whole, found by words ------------------------------------------------- */

await test('write: a file made in memory is a row like an upload, from Kacey', () => {
  clear();
  const f = storage.write({ name: 'Nákup.txt', type: 'text/plain', data: 'mléko\n' });
  assert.equal(f.device, 'kacey');
  assert.equal(f.bytes, Buffer.byteLength('mléko\n'));
  assert.equal(readFileSync(storage.pathOf(f.id), 'utf8'), 'mléko\n');
  assert.equal(events[0].event, 'added');
  assert.deepEqual(leftovers(), []);
});

await test('find: by id, exact name, or every word of the name without diacritics — the newest', async () => {
  clear();
  const old = storage.write({ name: 'Faktura září.pdf', data: '%PDF-' });
  await new Promise((r) => setTimeout(r, 5));
  const neu = storage.write({ name: 'Faktura říjen.pdf', data: '%PDF-' });
  assert.equal(storage.find(old.id).id, old.id);
  assert.equal(storage.find('faktura zari').id, old.id);
  assert.equal(storage.find('faktura').id, neu.id);
  assert.equal(storage.find('Faktura září.pdf').id, old.id);
  assert.equal(storage.find('smlouva'), null);
  assert.equal(storage.find(''), null);
  storage.remove([neu.id]);
  assert.equal(storage.find('říjen'), null);
  assert.equal(storage.findDeleted('říjen').id, neu.id);
});

/* ---- Kacey ------------------------------------------------------------------------ */

const sent = [];
const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
const [tool] = makeStorageTools({ images: () => [{ media_type: 'image/png', data: PNG }], send: (m) => sent.push(m) });
const call = (args) => tool.handler(args, {});

await test('app_storage is allowed by name', () => {
  assert.equal(tool.name, 'app_storage');
  assert.ok(APP_TOOL_NAMES.some((n) => n.endsWith('__app_storage')));
});

await test('app_storage list: empty, everything, by words, nothing by those words', async () => {
  clear();
  assert.match(text(await call({ action: 'list' })), /prázdné/);
  storage.write({ name: 'Rozpočet říjen.csv', data: 'a;b' });
  storage.write({ name: 'Dovolená.jpg', data: 'x', device: 'phone' });
  const all = text(await call({ action: 'list' }));
  assert.match(all, /2 z 2/);
  assert.match(all, /„Dovolená\.jpg“ · 1 B · .* · z telefonu/);
  const some = text(await call({ action: 'list', query: 'rozpocet' }));
  assert.match(some, /1 z 2/);
  assert.ok(!some.includes('Dovolená'));
  assert.match(text(await call({ action: 'list', query: 'smlouva' })), /Žádný soubor/);
});

await test('app_storage write: a text becomes a file, .txt when no extension is given', async () => {
  clear();
  const out = await call({ action: 'write', name: 'Nákupní seznam', text: 'mléko\nvejce\n' });
  assert.ok(!out.isError);
  const f = storage.find('nakupni seznam');
  assert.equal(f.name, 'Nákupní seznam.txt');
  assert.equal(f.device, 'kacey');
  assert.equal(readFileSync(storage.pathOf(f.id), 'utf8'), 'mléko\nvejce\n');
  assert.ok((await call({ action: 'write', name: 'x.txt', text: '  ' })).isError);
  await call({ action: 'write', name: 'Plán.md', text: '# Plán' });
  assert.equal(storage.find('plan').type, 'text/markdown');
});

await test('app_storage save_image: the chat photo as a file; none in the chat is an error', async () => {
  clear();
  assert.ok(!(await call({ action: 'save_image', name: 'Účtenka' })).isError);
  const f = storage.find('uctenka');
  assert.equal(f.name, 'Účtenka.png');
  assert.equal(f.type, 'image/png');
  assert.deepEqual(readFileSync(storage.pathOf(f.id)), Buffer.from(PNG, 'base64'));
  const [bare] = makeStorageTools({ images: () => [] });
  const none = await bare.handler({ action: 'save_image' }, {});
  assert.ok(none.isError);
  assert.match(text(none), /fotku nemám/);
});

await test('app_storage delete and restore by words; says what it could not find', async () => {
  clear();
  storage.write({ name: 'Stará záloha.zip', data: 'PK' });
  storage.write({ name: 'Smlouva.pdf', data: '%PDF-' });
  const del = await call({ action: 'delete', files: ['stara zaloha', 'nic takoveho'] });
  assert.ok(!del.isError);
  assert.match(text(del), /Smazáno: „Stará záloha\.zip“/);
  assert.match(text(del), /Nenašla jsem: nic takoveho/);
  assert.equal(storage.list().files.length, 1);
  assert.ok((await call({ action: 'delete', files: ['nic'] })).isError);
  assert.ok((await call({ action: 'delete' })).isError);
  const back = await call({ action: 'restore', files: ['zaloha'] });
  assert.match(text(back), /Zpátky v úložišti: „Stará záloha\.zip“/);
  assert.equal(storage.list().files.length, 2);
});

await test('app_storage open: the screen, or one file in it, on her own page', async () => {
  sent.length = 0;
  await call({ action: 'open' });
  await call({ action: 'open', files: ['smlouva'] });
  assert.deepEqual(sent, [
    { type: 'storage', event: 'open', id: null },
    { type: 'storage', event: 'open', id: storage.find('smlouva').id },
  ]);
  assert.ok((await call({ action: 'open', files: ['nic'] })).isError);
  assert.equal(sent.length, 2);
});

/* ---- the preview ------------------------------------------------------------------ */

await test('seedSamples: five files into a table that never had one, never again', () => {
  db.open().exec('DELETE FROM kacey_file');
  assert.equal(storage.seedSamples(), 5);
  assert.equal(storage.list().files.length, 5);
  assert.equal(storage.seedSamples(), 0);
});

rmSync(dir, { recursive: true, force: true });
console.log(`storage: ${passed} passed`);
