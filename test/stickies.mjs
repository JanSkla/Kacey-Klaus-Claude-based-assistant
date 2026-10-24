// Lístečky — stickies.js (sticky notes in the database: make, change, delete,
// Smazat všechny and its Vrátit, the limit, finding one by its words), the
// draft's settings.stickies moved into the table (appstate.js), and Kacey's
// app_sticky (clear only after a yes) / app_read.
// Throwaway database.
// Run: node test/stickies.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kacey-stickies-'));
process.env.KLAUS_DB = path.join(dir, 'test.db');
// Never let the one-time JSON import find (and rename!) a real app-state.json.
process.env.KACEY_STATE_PATH = path.join(dir, 'no-such-file.json');

const db = await import('../db.js');
const st = await import('../stickies.js');
const appstate = await import('../appstate.js');
const { APP_TOOLS, APP_TOOL_NAMES } = await import('../app-tools.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
}

const events = [];
st.onEvent((ev) => events.push(ev));
const call = (name, args) => APP_TOOLS.find((t) => t.name === name).handler(args, {});
const text = (out) => out.content.map((c) => c.text).join('\n');
const clear = () => db.open().exec('DELETE FROM kacey_sticky');

/* ---- the draft's notes ------------------------------------------------------ */

await test("the draft's settings.stickies move into the table once and leave the settings", () => {
  db.kvSet('settings', { hue: 120, stickies: [
    { id: 's1', text: 'Z návrhu', x: 300.4, y: -5, w: 90, h: 5000 },
    { id: 's1', text: 'dvakrát' },
    null,
  ] });
  const all = st.list();
  assert.equal(all.length, 1);
  assert.deepEqual({ ...all[0], created_at: 0, updated_at: 0 },
    { id: 's1', text: 'Z návrhu', x: 300, y: 0, w: st.SIZE.minW, h: st.SIZE.max, origin: 'user', created_at: 0, updated_at: 0 });
  assert.equal(db.kvGet('settings').stickies, undefined);
  assert.equal(db.kvGet('settings').hue, 120, 'the rest of the settings stays');
  assert.equal(st.list().length, 1, 'only once');
});

await test('a settings save moves them first and never stores them in the settings', () => {
  clear();
  db.kvSet('settings', { hue: 120, stickies: [{ id: 's2', text: 'Před uložením' }] });
  appstate.setSection('settings', { ...appstate.get().settings, stickies: [{ id: 'zz', text: 'stará stránka' }] });
  assert.equal(appstate.get().settings.stickies, undefined);
  assert.deepEqual(st.list().map((n) => n.text), ['Před uložením']);
});

/* ---- the notes -------------------------------------------------------------- */

await test('a new note is cleaned, placed or left for the page to place, and announced', () => {
  clear();
  events.length = 0;
  const a = st.create({ text: 'Zavolat do servisu\r\nkvůli autu', x: 40, y: 80, origin: 'p1' });
  assert.match(a.id, /^s[a-z0-9]+$/);
  assert.equal(a.text, 'Zavolat do servisu\nkvůli autu');
  assert.deepEqual([a.x, a.y, a.w, a.h], [40, 80, st.SIZE.w, st.SIZE.h]);
  const b = st.create({ text: 'x'.repeat(3000), by: 'kacey' });
  assert.equal(b.x, null, 'no place: the top right corner');
  assert.equal(b.text.length, st.TEXT_MAX);
  assert.equal(b.origin, 'kacey');
  assert.deepEqual(events.map((e) => [e.event, e.by, e.origin]), [['created', 'user', 'p1'], ['created', 'kacey', '']]);
  assert.deepEqual(st.list().map((n) => n.id), [a.id, b.id], 'oldest first');
});

await test('a change writes only what was sent, kept in bounds', () => {
  const [a] = st.list();
  const moved = st.update(a.id, { x: 12000, y: 'nope', w: 50 }, { origin: 'p1' });
  assert.equal(moved.x, 10000);
  assert.equal(moved.y, null, 'an unreadable place goes back to the corner');
  assert.equal(moved.w, st.SIZE.minW);
  assert.equal(moved.text, a.text, 'the text stays');
  assert.equal(st.update(a.id, { text: 'Jen text' }).x, 10000, 'and the place stays');
  assert.equal(st.update('s-none', { text: 'x' }), null);
  assert.equal(events.at(-1).event, 'changed');
});

await test('a deleted note is gone from the list, and Vrátit brings it back where it was', () => {
  const [a] = st.list();
  const gone = st.remove(a.id, { origin: 'p1' });
  assert.equal(gone.text, 'Jen text');
  assert.ok(!st.list().some((n) => n.id === a.id));
  assert.equal(st.remove(a.id), null, 'not twice');
  assert.equal(events.at(-1).event, 'deleted');
  const back = st.restore(a.id);
  assert.equal(back.x, 10000);
  assert.ok(st.list().some((n) => n.id === a.id));
  assert.throws(() => st.restore(a.id), /vrátit nejde/);
});

await test('a deleted note is purged after a day', () => {
  const [a] = st.list();
  st.remove(a.id);
  db.open().prepare('UPDATE kacey_sticky SET deleted_at = ? WHERE sticky_id = ?').run('2020-01-01T00:00:00.000Z', a.id);
  st.list();
  assert.equal(db.open().prepare('SELECT COUNT(*) AS n FROM kacey_sticky WHERE sticky_id = ?').get(a.id).n, 0);
});

await test('at most twelve: the thirteenth is refused, and so is a Vrátit over the limit', () => {
  clear();
  for (let i = 0; i < st.MAX; i++) st.create({ text: 'Lísteček ' + i });
  assert.throws(() => st.create({ text: 'navíc' }), /Víc lístečků se nevejde/);
  const first = st.list()[0];
  st.remove(first.id);
  st.create({ text: 'místo něj' });
  assert.throws(() => st.restore(first.id), /nevejde/);
});

await test('Smazat všechny: every note goes in one frame, and Vrátit brings the batch back where it was', () => {
  clear();
  events.length = 0;
  assert.deepEqual(st.removeAll(), [], 'nothing to delete, no frame');
  assert.equal(events.length, 0);
  const a = st.create({ text: 'První', x: 10, y: 20 });
  const b = st.create({ text: 'Druhý', by: 'kacey' });
  events.length = 0;
  const order = st.list().map((n) => n.id);
  const gone = st.removeAll({ origin: 'p1' });
  assert.deepEqual(gone.map((n) => n.id), order);
  assert.equal(st.list().length, 0);
  assert.deepEqual(events, [{ event: 'cleared', ids: order, by: 'user', origin: 'p1' }]);
  const back = st.restoreMany([b.id, a.id, a.id, 'nope'], { origin: 'p1' });
  assert.deepEqual(back.map((n) => n.id), order, 'in the list order, once each');
  assert.deepEqual([st.get(a.id).x, st.get(a.id).y], [10, 20], 'where it was');
  assert.deepEqual(events.at(-1), { event: 'restored', ids: order, by: 'user', origin: 'p1' });
  assert.throws(() => st.restoreMany([a.id]), /vrátit nejde/, 'not twice');
  assert.throws(() => st.restoreMany([]), /vrátit nejde/);
});

await test('Vrátit after Smazat všechny brings back only as many as fit', () => {
  clear();
  for (let i = 0; i < 3; i++) st.create({ text: 'Starý ' + i });
  const ids = st.removeAll().map((n) => n.id);
  for (let i = 0; i < st.MAX - 1; i++) st.create({ text: 'Nový ' + i });
  const back = st.restoreMany(ids);
  assert.deepEqual(back.map((n) => n.id), [ids[0]], 'the first in the list order');
  assert.equal(st.list().length, st.MAX);
  assert.throws(() => st.restoreMany(ids), /nevejde/);
});

await test('restoreLast brings back the last delete: one note, or the whole cleared batch', () => {
  clear();
  assert.throws(() => st.restoreLast(), /Žádný smazaný/);
  const a = st.create({ text: 'A' });
  st.create({ text: 'B' });
  st.create({ text: 'C' });
  st.remove(a.id);
  db.open().prepare('UPDATE kacey_sticky SET deleted_at = ? WHERE sticky_id = ?').run(new Date(Date.now() - 60000).toISOString(), a.id);
  st.removeAll();
  assert.deepEqual(st.restoreLast().map((n) => n.text).sort(), ['B', 'C'], 'the batch, not the older single one');
  assert.deepEqual(st.restoreLast().map((n) => n.text), ['A']);
});

await test('a note is found by its id or its words; an unclear reference finds nothing', () => {
  clear();
  const mum = st.create({ text: 'Zavolat mámě' });
  st.create({ text: 'Koupit mléko a chleba' });
  st.create({ text: 'Koupit dárek' });
  assert.equal(st.find(mum.id).id, mum.id);
  assert.equal(st.find('ten o mámě').id, mum.id);
  assert.equal(st.find('MLÉKO').text, 'Koupit mléko a chleba');
  assert.equal(st.find('koupit'), null, 'two of them');
  assert.equal(st.find(''), null);
  clear();
  const only = st.create({ text: 'Jediný' });
  assert.equal(st.find('ten lísteček').id, only.id, 'with one note, it is that one');
});

await test('the preview gets one sample note, only into a table that never had one', () => {
  clear();
  assert.equal(st.seedSample(), 1);
  assert.equal(st.list()[0].origin, 'kacey');
  assert.equal(st.seedSample(), 0);
});

/* ---- Kacey ------------------------------------------------------------------ */

await test('app_sticky is allowed, and adds, rewrites and deletes a note', async () => {
  clear();
  assert.ok(APP_TOOL_NAMES.some((n) => n.endsWith('__app_sticky')));
  events.length = 0;
  const added = await call('app_sticky', { action: 'add', text: '  Zavolat do servisu  ' });
  assert.ok(!added.isError, text(added));
  assert.match(text(added), /vpravo nahoře: „Zavolat do servisu“/);
  assert.deepEqual([events[0].event, events[0].by], ['created', 'kacey']);
  const n = st.list()[0];
  assert.equal(n.x, null);
  assert.ok((await call('app_sticky', { action: 'add', text: ' ' })).isError);

  assert.ok(!(await call('app_sticky', { action: 'edit', which: 'servis', text: 'Servis — ve středu v 9' })).isError);
  assert.equal(st.get(n.id).text, 'Servis — ve středu v 9');
  assert.ok((await call('app_sticky', { action: 'edit', which: n.id, text: '' })).isError);

  st.create({ text: 'Koupit mléko' });
  const unclear = await call('app_sticky', { action: 'remove', which: 'něco jiného' });
  assert.ok(unclear.isError);
  assert.match(text(unclear), /Koupit mléko/, 'she is shown the list');
  const removed = await call('app_sticky', { action: 'remove', which: 'mléko' });
  assert.ok(!removed.isError);
  assert.match(text(removed), /Vrátit/);
  assert.deepEqual(st.list().map((x) => x.id), [n.id]);
  assert.deepEqual([events.at(-1).event, events.at(-1).by], ['deleted', 'kacey']);
});

await test('app_sticky clear asks first, deletes only with sure, and restore brings them back', async () => {
  clear();
  assert.match(text(await call('app_sticky', { action: 'clear', sure: true })), /žádné lístečky nejsou/);
  st.create({ text: 'Zavolat mámě' });
  st.create({ text: 'PIN k Wi-Fi' });
  st.create({ text: 'Koupit mléko' });
  events.length = 0;
  const asked = await call('app_sticky', { action: 'clear' });
  assert.ok(!asked.isError);
  assert.match(text(asked), /Nic jsem nesmazala/);
  assert.match(text(asked), /„Smazat všechny 3 lístečky\?“/);
  assert.match(text(asked), /Zavolat mámě/, 'she sees what would go');
  assert.equal(st.list().length, 3, 'nothing deleted without a yes');
  assert.equal(events.length, 0);

  const done = await call('app_sticky', { action: 'clear', sure: true });
  assert.ok(!done.isError, text(done));
  assert.match(text(done), /Smazáno 3 lístečky/);
  assert.equal(st.list().length, 0);
  assert.deepEqual([events.at(-1).event, events.at(-1).by, events.at(-1).ids.length], ['cleared', 'kacey', 3]);

  const back = await call('app_sticky', { action: 'restore' });
  assert.ok(!back.isError, text(back));
  assert.match(text(back), /Vráceno 3 lístečky/);
  assert.equal(st.list().length, 3);
  assert.deepEqual([events.at(-1).event, events.at(-1).by], ['restored', 'kacey']);

  for (let i = 0; i < 2; i++) st.create({ text: 'další ' + i });
  assert.match(text(await call('app_sticky', { action: 'clear' })), /„Smazat všech 5 lístečků\?“/);
});

await test('app_sticky says when there is no room', async () => {
  clear();
  for (let i = 0; i < st.MAX; i++) st.create({ text: 'L' + i });
  const out = await call('app_sticky', { action: 'add', text: 'navíc' });
  assert.ok(out.isError);
  assert.match(text(out), /nevejde/);
});

await test('app_read lists the notes, alone and with everything', async () => {
  clear();
  assert.match(text(await call('app_read', { section: 'stickies' })), /LÍSTEČKY[^\n]*\n\(žádné\)/);
  const a = st.create({ text: 'PIN k Wi-Fi\npro hosty' });
  st.create({ text: '', by: 'kacey' });
  const one = text(await call('app_read', { section: 'stickies' }));
  assert.match(one, new RegExp(`- \\(${a.id}\\) „PIN k Wi-Fi pro hosty“`));
  assert.match(one, /\(prázdný\) · napsala Kacey/);
  assert.match(text(await call('app_read', { section: 'all' })), /LÍSTEČKY/);
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`stickies: ${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
