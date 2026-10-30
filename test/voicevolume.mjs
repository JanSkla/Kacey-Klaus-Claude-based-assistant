// Hlasitost Kacey — public/js/core/voicevolume.js (the 5 % grid, the words,
// a step), settings.ttsVolume through appstate.setVoiceVolume (kept across a
// restart, kept through a stale page's settings save), and Kacey's
// app_voice_volume (status, set, louder / quieter, the ends, the undo frame).
// Throwaway database.
// Run: node test/voicevolume.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kacey-volume-'));
process.env.KLAUS_DB = path.join(dir, 'test.db');
// Never let the one-time JSON import find (and rename!) a real app-state.json.
process.env.KACEY_STATE_PATH = path.join(dir, 'no-such-file.json');

const vv = await import('../public/js/core/voicevolume.js');
const db = await import('../db.js');
const appstate = await import('../appstate.js');
const { APP_TOOLS, APP_TOOL_NAMES, setWriteListener } = await import('../app-tools.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
}

const call = (name, args) => APP_TOOLS.find((t) => t.name === name).handler(args, {});
const text = (out) => out.content.map((c) => c.text).join('\n');
const writes = [];
setWriteListener((section, undo) => writes.push({ section, undo }));

/* ---- the shared module ------------------------------------------------------ */

await test('a volume lands on the 5 % grid, 0–100; junk is the default', () => {
  assert.equal(vv.clampVolume(72), 70);
  assert.equal(vv.clampVolume(73), 75);
  assert.equal(vv.clampVolume(-20), 0);
  assert.equal(vv.clampVolume(140), 100);
  assert.equal(vv.clampVolume('45'), 45);
  assert.equal(vv.clampVolume(undefined), 100);
  assert.equal(vv.clampVolume(NaN), 100);
  assert.equal(vv.clampVolume(''), 100);
  assert.equal(vv.clampVolume(null, 40), 40);
  assert.equal(vv.volumeOf({}), 100);
  assert.equal(vv.volumeOf({ ttsVolume: 0 }), 0);
});

await test('only a number 0–100 may be sent', () => {
  assert.ok(vv.validVolume(0) && vv.validVolume(100) && vv.validVolume(37.5));
  for (const bad of [-1, 101, '50', null, undefined, NaN, Infinity]) assert.equal(vv.validVolume(bad), false, String(bad));
});

await test('words: "ticho" at 0, else percent', () => {
  assert.equal(vv.volumeWords(0), 'ticho');
  assert.equal(vv.volumeWords(55), '55 %');
});

await test('a step is 15 % unless told, and stops at the ends', () => {
  assert.equal(vv.stepVolume(70, 'quieter'), 55);
  assert.equal(vv.stepVolume(70, 'louder'), 85);
  assert.equal(vv.stepVolume(70, 'louder', 50), 100);
  assert.equal(vv.stepVolume(10, 'quieter'), 0);
  assert.equal(vv.stepVolume(50, 'quieter', 22), 30);
});

/* ---- stored ---------------------------------------------------------------- */

await test('a fresh database: Kacey speaks at 100 %', () => {
  assert.equal(appstate.get().settings.ttsVolume, 100);
  assert.deepEqual(appstate.voiceVolume(), { percent: 100, by: null, at: null });
});

await test('the owner sets it; it is stored with who and when', () => {
  const out = appstate.setVoiceVolume(62, { by: 'owner' });
  assert.equal(out.percent, 60);
  assert.equal(out.by, 'owner');
  assert.match(out.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(appstate.get().settings.ttsVolume, 60);
});

await test('a bad value is refused and changes nothing', () => {
  for (const bad of [150, -5, 'hlasitě', null]) {
    assert.throws(() => appstate.setVoiceVolume(bad), /0–100/);
  }
  assert.equal(appstate.voiceVolume().percent, 60);
});

await test('a settings save from a stale page keeps the stored volume', () => {
  const stale = { ...appstate.get().settings, ttsVolume: 100, ttsVolumeBy: 'kacey', hue: 210 };
  const saved = appstate.setSection('settings', stale);
  assert.equal(saved.hue, 210);
  assert.equal(saved.ttsVolume, 60);
  assert.equal(saved.ttsVolumeBy, 'owner');
  // A page from before the slider sends no volume at all: still kept.
  const { ttsVolume: _v, ...old } = appstate.get().settings;
  assert.equal(appstate.setSection('settings', old).ttsVolume, 60);
});

await test('it holds after a restart (the database closed and opened again)', () => {
  db.close();
  assert.equal(appstate.get().settings.ttsVolume, 60);
  assert.equal(appstate.voiceVolume().by, 'owner');
});

/* ---- Kacey's tool ----------------------------------------------------------- */

await test('app_voice_volume is offered and allowed', () => {
  assert.ok(APP_TOOLS.some((t) => t.name === 'app_voice_volume'));
  assert.ok(APP_TOOL_NAMES.some((n) => n.endsWith('__app_voice_volume')));
});

await test('status says how loud, and writes nothing', async () => {
  writes.length = 0;
  assert.match(text(await call('app_voice_volume', { action: 'status' })), /60 %/);
  assert.equal(writes.length, 0);
});

await test('"mluv tišeji": 15 % down, marked as hers, the pages get the old settings to undo', async () => {
  writes.length = 0;
  const out = await call('app_voice_volume', { action: 'quieter' });
  assert.ok(!out.isError);
  assert.match(text(out), /60 % → 45 %/);
  assert.deepEqual(appstate.voiceVolume().percent, 45);
  assert.equal(appstate.voiceVolume().by, 'kacey');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].section, 'settings');
  assert.equal(writes[0].undo.ttsVolume, 60);
  assert.match(text(await call('app_voice_volume', { action: 'status' })), /nastavila ty/);
});

await test('"hlasitost na 40" sets it; louder by a given amount', async () => {
  await call('app_voice_volume', { action: 'set', percent: 40 });
  assert.equal(appstate.voiceVolume().percent, 40);
  await call('app_voice_volume', { action: 'louder', by: 25 });
  assert.equal(appstate.voiceVolume().percent, 65);
});

await test('set without a number asks for one', async () => {
  const out = await call('app_voice_volume', { action: 'set' });
  assert.ok(out.isError);
  assert.match(text(out), /Na kolik procent/);
});

await test('the ends: no louder than 100, no quieter than 0 — nothing written', async () => {
  await call('app_voice_volume', { action: 'set', percent: 100 });
  writes.length = 0;
  assert.match(text(await call('app_voice_volume', { action: 'louder' })), /naplno/);
  await call('app_voice_volume', { action: 'set', percent: 0 });
  assert.match(text(await call('app_voice_volume', { action: 'set', percent: 0 })), /nic jsem neměnila/);
  assert.match(text(await call('app_voice_volume', { action: 'quieter' })), /potichu/);
  assert.equal(writes.length, 1);   // only the set to 0
});

await test('at 0 she is told the owner will not hear her', async () => {
  await call('app_voice_volume', { action: 'set', percent: 50 });
  assert.match(text(await call('app_voice_volume', { action: 'set', percent: 0 })), /neuslyší/);
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`voicevolume: ${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
