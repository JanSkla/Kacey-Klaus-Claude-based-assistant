// Úložiště — storage.js and core/filekind.js: which files the náhled shows and
// as what, and that a "PDF" which is not one is not served unsandboxed.
// Throwaway database and storage folder.
// Run: node test/storage.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kacey-storage-'));
process.env.KLAUS_DB = path.join(dir, 'test.db');
process.env.KACEY_STATE_PATH = path.join(dir, 'no-such-file.json');
process.env.KACEY_STORAGE_DIR = path.join(dir, 'files');

const storage = await import('../storage.js');
const { viewOf } = await import('../public/js/core/filekind.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
}

const put = (name, body) => storage.receive(Object.assign(Readable.from([Buffer.from(body)]), { complete: true }), { name, device: 'desktop' });

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

rmSync(dir, { recursive: true, force: true });
console.log(`storage: ${passed} passed`);
