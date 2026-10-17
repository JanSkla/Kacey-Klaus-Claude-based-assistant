// The photo gallery — gallery.js (saving, describing, the search, restarts),
// vectors.js (the built-in embedder) and Kacey's app_gallery_save /
// app_gallery_search. Throwaway database and folder; the model call that
// writes descriptions is swapped for a stand-in.
// Run: node test/gallery.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kacey-gallery-'));
process.env.KLAUS_DB = path.join(dir, 'test.db');
process.env.KACEY_GALLERY_DIR = path.join(dir, 'photos');
// Never let the one-time JSON import find (and rename!) a real app-state.json.
process.env.KACEY_STATE_PATH = path.join(dir, 'no-such-file.json');
delete process.env.KACEY_EMBED_URL;

const vectors = await import('../vectors.js');
const gallery = await import('../gallery.js');
const db = await import('../db.js');
const { makeGalleryTools } = await import('../app-tools.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)]).toString('base64');
const PDF = Buffer.from('%PDF-1.7 not a photo at all').toString('base64');
const png = { media_type: 'image/png', data: PNG };

const events = [];
gallery.onEvent((ev) => events.push(ev));

const files = () => (existsSync(process.env.KACEY_GALLERY_DIR) ? readdirSync(process.env.KACEY_GALLERY_DIR) : []);
const row = (id) => db.open().prepare('SELECT * FROM kacey_photo WHERE photo_id = ?').get(id);
async function settled(id) {
  for (let i = 0; i < 100; i++) {
    const p = gallery.get(id);
    if (p.status !== 'describing') return p;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${id} still describing`);
}

const DOG = { title: 'Pes na zahradě u chalupy', caption: 'Hnědý pes leží v trávě před dřevěnou chalupou.', tags: ['pes', 'zahrada', 'chalupa'], keywords: ['zvíře', 'mazlíček', 'léto', 'venku', 'tráva'] };
const RECEIPT = { title: 'Účtenka z Alzy', caption: 'Pokladní doklad za sluchátka.', tags: ['účtenka', 'dokument', 'nákup'], keywords: 'paragon, elektronika, alza, cena' };
const SNOW = { title: 'Hřeben v zimě', caption: 'Zasněžené hory pod modrou oblohou.', tags: ['hory', 'sníh'], keywords: ['zima', 'krajina', 'příroda', 'výlet'] };

/* ---- vectors ---------------------------------------------------------------- */

await test('fold drops case and diacritics', () => {
  assert.equal(vectors.fold('Účtenka z ALZY, 2026!'), 'uctenka z alzy 2026');
});

await test('the built-in embedder: Czech cases land near each other, unrelated words do not', () => {
  const a = vectors.localEmbed('chalupa');
  const b = vectors.localEmbed('na chalupě');
  const c = vectors.localEmbed('účtenka elektronika');
  assert.ok(vectors.cosine(a, b) > 0.5, `chalupa ~ na chalupě: ${vectors.cosine(a, b)}`);
  assert.ok(vectors.cosine(a, b) > vectors.cosine(a, c) + 0.3);
});

await test('a vector survives the database blob', () => {
  const v = vectors.localEmbed('pes na zahradě');
  const back = vectors.fromBlob(vectors.toBlob(v));
  assert.equal(back.length, v.length);
  assert.ok(Math.abs(vectors.cosine(v, back) - 1) < 1e-6);
});

/* ---- saving ------------------------------------------------------------------- */

await test('sniff reads the bytes, not the label', () => {
  assert.equal(gallery.sniff(Buffer.from(PNG, 'base64')), 'image/png');
  assert.equal(gallery.sniff(Buffer.from(JPEG, 'base64')), 'image/jpeg');
  assert.equal(gallery.sniff(Buffer.from(PDF, 'base64')), null);
});

await test('not a photo, or nothing at all, is refused and nothing is written', async () => {
  await assert.rejects(gallery.save({ image: { media_type: 'image/jpeg', data: PDF } }), /není fotka/);
  await assert.rejects(gallery.save({ image: { media_type: 'image/png', data: '' } }), /prázdná/);
  await assert.rejects(gallery.save({}), /prázdná/);
  assert.equal(files().length, 0);
  assert.equal(db.open().prepare('SELECT COUNT(*) n FROM kacey_photo').get().n, 0);
});

let dogId;
await test('from the chat, with Kacey\'s description: ready at once, stored with its vector', async () => {
  // A PNG labelled as JPEG is stored as what it is.
  const p = await gallery.save({ image: { media_type: 'image/jpeg', data: PNG }, source: 'chat', name: '../IMG_1.png', meta: DOG });
  dogId = p.id;
  assert.equal(p.status, 'ready');
  assert.equal(p.source, 'chat');
  assert.equal(p.media_type, 'image/png');
  assert.equal(p.name, '.._IMG_1.png', 'no path in a name');
  assert.deepEqual(p.tags, ['pes', 'zahrada', 'chalupa']);
  assert.match(p.url, /^\/gallery-files\/p.+\.png$/);
  assert.ok(existsSync(path.join(process.env.KACEY_GALLERY_DIR, row(p.id).file)));
  assert.equal(row(p.id).embed_model, vectors.LOCAL_MODEL);
  assert.ok(row(p.id).embedding.length === 512 * 4);
  assert.ok(!('keywords' in p) && !('embedding' in p), 'the page never sees the vector or keywords');
  assert.deepEqual(events.slice(-2).map((e) => e.event), ['added', 'ready']);
});

await test('from the Galerie screen: "describing", then the model\'s description', async () => {
  gallery.setDescriber(async () => RECEIPT);
  const p = await gallery.save({ image: { media_type: 'image/jpeg', data: JPEG }, thumb: png, name: 'alza.jpg', width: 3000, height: 4000 });
  assert.equal(p.status, 'describing');
  assert.match(p.thumb_url, /-t\.png$/);
  const done = await settled(p.id);
  assert.equal(done.status, 'ready');
  assert.equal(done.title, 'Účtenka z Alzy');
  assert.equal(done.width, 3000);
  assert.equal(events.at(-1).event, 'ready');
});

let snowId;
await test('a description that fails is kept as "failed" and a retry describes it', async () => {
  gallery.setDescriber(async () => { throw new Error('model nevrátil JSON'); });
  const p = await gallery.save({ image: png, taken_at: '2026-01-10T09:00:00Z' });
  snowId = p.id;
  const failed = await settled(p.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /JSON/);
  assert.equal(failed.taken_at, '2026-01-10T09:00:00.000Z');

  gallery.setDescriber(async () => SNOW);
  assert.equal(gallery.retry(p.id).status, 'describing');
  assert.equal((await settled(p.id)).title, 'Hřeben v zimě');
  assert.throws(() => gallery.retry('p-none'), /Taková fotka není/);
});

await test('an empty description from the model is a failure, not a blank photo', async () => {
  gallery.setDescriber(async () => ({ title: '', caption: '', tags: [] }));
  const p = await gallery.save({ image: png });
  assert.equal((await settled(p.id)).status, 'failed');
  gallery.remove(p.id);
});

await test('unusable words from the chat fall back to the model', async () => {
  gallery.setDescriber(async () => ({ ...SNOW, title: 'Jiný hřeben' }));
  const p = await gallery.save({ image: png, source: 'chat', meta: { title: 'X', caption: '', tags: [] } });
  assert.equal(p.status, 'describing');
  assert.equal((await settled(p.id)).title, 'Jiný hřeben');
  gallery.remove(p.id);
});

/* ---- the search -------------------------------------------------------------------- */

await test('no question: everything, newest first, with the tags counted', async () => {
  const r = await gallery.list();
  assert.equal(r.total, 3);
  assert.equal(r.photos[0].id, snowId);
  assert.equal(r.describing, 0);
  assert.equal(r.index.vectors, 3);
  assert.equal(r.index.remote, false);
  assert.ok(r.tags.some((t) => t.name === 'účtenka' && t.count === 1));
});

await test('by meaning: the dog for "zvíře", the receipt for "paragon z alzy", the ridge for "hory v zimě"', async () => {
  assert.equal((await gallery.list({ q: 'nějaké zvíře na chalupě' })).photos[0].id, dogId);
  assert.equal((await gallery.list({ q: 'paragon z alzy' })).photos[0].title, 'Účtenka z Alzy');
  const snow = await gallery.list({ q: 'hory v zimě' });
  assert.equal(snow.photos[0].id, snowId);
  assert.ok(snow.photos[0].score > 0);
});

await test('nothing like it: an empty list, not the whole gallery', async () => {
  const r = await gallery.list({ q: 'kvantový počítač' });
  assert.equal(r.photos.length, 0);
  assert.equal(r.total, 3);
});

await test('by tag, with or without diacritics', async () => {
  const r = await gallery.list({ tag: 'Uctenka' });
  assert.deepEqual(r.photos.map((p) => p.title), ['Účtenka z Alzy']);
});

await test('a photo still being described is listed but not searched', async () => {
  let release;
  gallery.setDescriber(() => new Promise((r) => { release = r; }));
  const p = await gallery.save({ image: png });
  assert.ok((await gallery.list()).photos.some((x) => x.id === p.id));
  assert.equal((await gallery.list()).describing, 1);
  assert.ok(!(await gallery.list({ q: 'pes' })).photos.some((x) => x.id === p.id));
  release(DOG);
  await settled(p.id);
  gallery.remove(p.id);
});

await test('vectors from another embedder are made again on the next search', async () => {
  db.open().prepare(`UPDATE kacey_photo SET embed_model = 'old-model' WHERE photo_id = ?`).run(dogId);
  await gallery.list({ q: 'pes' });
  assert.equal(row(dogId).embed_model, vectors.LOCAL_MODEL);
});

/* ---- restarts and deleting ------------------------------------------------------------- */

await test('after a restart, a photo left "describing" is described again from its file', async () => {
  gallery.setDescriber(async () => RECEIPT);
  db.open().prepare(`UPDATE kacey_photo SET status = 'describing' WHERE photo_id = ?`).run(snowId);
  assert.equal(gallery.resumeInterrupted(), 1);
  assert.equal((await settled(snowId)).title, 'Účtenka z Alzy');
  assert.equal(gallery.resumeInterrupted(), 0);
});

await test('a stuck photo whose file is gone ends "failed", not for ever "describing"', async () => {
  const p = await gallery.save({ image: png, meta: DOG });
  rmSync(path.join(process.env.KACEY_GALLERY_DIR, row(p.id).file));
  db.open().prepare(`UPDATE kacey_photo SET status = 'describing' WHERE photo_id = ?`).run(p.id);
  gallery.resumeInterrupted();
  assert.equal(gallery.get(p.id).status, 'failed');
  assert.match(gallery.get(p.id).error, /chybí/);
  gallery.remove(p.id);
});

await test('deleting takes the row and both files', async () => {
  const p = await gallery.save({ image: png, thumb: png, meta: SNOW });
  const before = files().length;
  assert.equal(gallery.remove(p.id), true);
  assert.equal(files().length, before - 2);
  assert.equal(gallery.get(p.id), null);
  assert.equal(gallery.remove(p.id), false);
  assert.deepEqual(events.at(-1), { event: 'removed', photo: { id: p.id } });
});

/* ---- Kacey's tools --------------------------------------------------------------------------- */

await test('app_gallery_save: no photo in the chat is an error that says what to do', async () => {
  const [save] = makeGalleryTools({ images: () => [], send: () => {} });
  const out = await save.handler({ title: 'Pes', caption: 'Pes v trávě.', tags: ['pes'] }, {});
  assert.ok(out.isError);
  assert.match(out.content[0].text, /pošle/);
});

await test('app_gallery_save stores the chat\'s photo and shows it in that chat', async () => {
  const sent = [];
  const [save] = makeGalleryTools({ images: () => [png, { media_type: 'image/jpeg', data: JPEG }], send: (f) => sent.push(f) });
  const out = await save.handler({ image: 2, ...DOG, title: 'Druhý pes' }, {});
  assert.ok(!out.isError, out.content[0].text);
  assert.match(out.content[0].text, /Uloženo do Galerie: .*Druhý pes/);
  assert.equal(sent[0].type, 'gallery');
  assert.equal(sent[0].event, 'saved_chat');
  assert.equal(sent[0].photo.source, 'chat');
  assert.equal(sent[0].photo.media_type, 'image/jpeg');
  assert.ok((await save.handler({ image: 3, ...DOG }, {})).isError, 'there is no third picture');
});

await test('app_gallery_search answers Kacey and sends the hits to the chat', async () => {
  const sent = [];
  const [, search] = makeGalleryTools({ images: () => [], send: (f) => sent.push(f) });
  const out = await search.handler({ query: 'zvíře' }, {});
  assert.match(out.content[0].text, /nejpodobnější první/);
  assert.match(out.content[0].text, /pes/i);
  assert.equal(sent[0].event, 'hits');
  assert.equal(sent[0].query, 'zvíře');
  assert.ok(sent[0].photos.length >= 1);

  const none = await search.handler({ query: 'kvantový počítač' }, {});
  assert.match(none.content[0].text, /Nic podobného/);
});

gallery.setDescriber(null);
db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`gallery: ${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
