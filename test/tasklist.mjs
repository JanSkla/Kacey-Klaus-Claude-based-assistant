// Seznam u úkolu — public/js/core/tasklist.js (what a stored list may hold,
// its progress, the changes Kacey makes), the `checklists` section cleaned on
// every write (appstate.js), and Kacey's app_task_list / app_read. The
// floating windows (ui/runwins.js) and the phone's runner both write through
// the same section. Throwaway database.
// Run: node test/tasklist.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kacey-tasklist-'));
process.env.KLAUS_DB = path.join(dir, 'test.db');
// Never let the one-time JSON import find (and rename!) a real app-state.json.
process.env.KACEY_STATE_PATH = path.join(dir, 'no-such-file.json');

const tl = await import('../public/js/core/tasklist.js');
const db = await import('../db.js');
const appstate = await import('../appstate.js');
const { APP_TOOLS, APP_TOOL_NAMES, setWriteListener } = await import('../app-tools.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
}

const writes = [];
setWriteListener((section, undo) => writes.push({ section, undo }));
const call = (name, args) => APP_TOOLS.find((t) => t.name === name).handler(args, {});
const text = (out) => out.content.map((c) => c.text).join('\n');
const labels = (items) => (items || []).map((i) => i.label);

/* ---- the shared module ------------------------------------------------------ */

await test('a stored list keeps only real items, trimmed, capped and each with its own id', () => {
  const list = tl.normalizeTaskList([
    { id: 'c1', label: '  Boty \n do tašky ', done: true },
    { id: 'c1', label: 'Stejné id' },
    { id: 'špatné id!', label: 'Ručník', note: '  modrý ', done: 'yes' },
    { label: '   ' },
    null,
    { label: 'x'.repeat(500) },
  ]);
  assert.deepEqual(labels(list).slice(0, 3), ['Boty do tašky', 'Stejné id', 'Ručník']);
  assert.equal(list.length, 4);
  assert.equal(list[0].id, 'c1');
  assert.notEqual(list[1].id, 'c1', 'a duplicate id gets a new one');
  assert.match(list[2].id, /^c[a-z0-9]+$/);
  assert.deepEqual([list[0].done, list[2].done], [true, false], 'only true is done');
  assert.equal(list[2].note, 'modrý');
  assert.equal(list[3].label.length, tl.MAX_LABEL);
  assert.equal(tl.normalizeTaskList(Array.from({ length: 60 }, (_, i) => ({ label: 'p' + i }))).length, tl.MAX_ITEMS);
  assert.deepEqual(tl.normalizeTaskList('nope'), []);
});

await test('every list: anything that is not { task id: [items] } goes', () => {
  assert.deepEqual(tl.normalizeTaskLists(null), {});
  assert.deepEqual(tl.normalizeTaskLists([1, 2]), {});
  const all = tl.normalizeTaskLists({ t1: [{ id: 'c1', label: 'A' }], t2: 'x', t3: { label: 'B' }, t4: [] });
  assert.deepEqual(Object.keys(all), ['t1', 't4']);
  assert.deepEqual(all.t1, [{ id: 'c1', label: 'A', note: '', done: false }]);
});

await test('the progress reads as the window and Kacey say it', () => {
  assert.equal(tl.progressText([]), 'prázdný');
  assert.equal(tl.progressText(undefined), 'prázdný');
  assert.equal(tl.progressText([{ label: 'a', done: true }, { label: 'b' }, { label: 'c' }]), '1 z 3 hotovo');
});

await test('an item is found by its id, its label or its words, without diacritics', () => {
  const items = [{ id: 'c1', label: 'Plavky' }, { id: 'c2', label: 'Ručník velký' }, { id: 'c3', label: 'Ručník malý' }];
  assert.equal(tl.findItem(items, 'c1').label, 'Plavky');
  assert.equal(tl.findItem(items, 'plavky').id, 'c1');
  assert.equal(tl.findItem(items, 'rucnik maly').id, 'c3');
  assert.equal(tl.findItem(items, 'ručník'), null, 'two match: neither');
  assert.equal(tl.findItem(items, ''), null);
});

await test('the changes: add, check, uncheck, remove, reset, clear — and what was not found or did not fit', () => {
  let out = tl.applyListOp(undefined, 'add', ['Plavky', ' ', 'Ručník', 'Zámek']);
  assert.deepEqual(labels(out.items), ['Plavky', 'Ručník', 'Zámek']);
  assert.deepEqual(out.changed, ['Plavky', 'Ručník', 'Zámek']);
  assert.equal(new Set(out.items.map((i) => i.id)).size, 3, 'ids differ within one millisecond');

  out = tl.applyListOp(out.items, 'check', ['rucnik', 'brýle']);
  assert.deepEqual(out.items.map((i) => i.done), [false, true, false]);
  assert.deepEqual(out.missing, ['brýle']);

  out = tl.applyListOp(out.items, 'uncheck', ['Ručník']);
  assert.equal(out.items[1].done, false);

  const ticked = tl.applyListOp(out.items, 'check', ['Plavky', 'Zámek']).items;
  out = tl.applyListOp(ticked, 'reset');
  assert.deepEqual(out.changed, ['Plavky', 'Zámek']);
  assert.ok(out.items.every((i) => !i.done));

  out = tl.applyListOp(out.items, 'remove', [out.items[0].id]);
  assert.deepEqual(labels(out.items), ['Ručník', 'Zámek']);

  out = tl.applyListOp(out.items, 'clear');
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.changed, ['Ručník', 'Zámek']);

  const full = Array.from({ length: tl.MAX_ITEMS - 1 }, (_, i) => ({ id: 'c' + i, label: 'p' + i }));
  out = tl.applyListOp(full, 'add', ['poslední', 'navíc']);
  assert.equal(out.items.length, tl.MAX_ITEMS);
  assert.deepEqual(out.full, ['navíc']);

  assert.throws(() => tl.applyListOp([], 'shuffle'), /neznámá/);
});

/* ---- the section ------------------------------------------------------------ */

await test('the page\'s save of `checklists` is cleaned on the way in', () => {
  appstate.setSection('checklists', {
    t_pool: [{ id: 'c1', label: ' Plavky ', done: true }, { label: '' }],
    t_bad: 'nope',
  });
  assert.deepEqual(appstate.get().checklists, { t_pool: [{ id: 'c1', label: 'Plavky', note: '', done: true }] });
  appstate.setSection('checklists', null);
  assert.deepEqual(appstate.get().checklists, {});
});

/* ---- Kacey's app_task_list -------------------------------------------------- */

appstate.setSection('tasks', [
  { id: 't_pool', label: 'Bazén', meta: '', done: false, due_at: null },
  { id: 't_shop', label: 'Nákup', meta: '', done: false, due_at: null },
]);

await test('app_task_list is one of Kacey\'s tools', () => {
  assert.ok(APP_TOOL_NAMES.includes('mcp__kacey-app__app_task_list'));
  assert.ok(APP_TOOLS.some((t) => t.name === 'app_task_list'));
});

await test('add writes the items to the task\'s list and hands the page an undo', async () => {
  writes.length = 0;
  const out = await call('app_task_list', { task: 't_pool', action: 'add', items: ['plavky', 'ručník', 'zámek'] });
  assert.ok(!out.isError, text(out));
  assert.deepEqual(labels(appstate.get().checklists.t_pool), ['plavky', 'ručník', 'zámek']);
  assert.match(text(out), /Přidáno do seznamu u „Bazén“: plavky, ručník, zámek\.\nTeď: seznam 0 z 3 hotovo/);
  assert.deepEqual(writes, [{ section: 'checklists', undo: {} }]);
});

await test('check by words; something not on the list is said, and with nothing found nothing is written', async () => {
  writes.length = 0;
  const out = await call('app_task_list', { task: 't_pool', action: 'check', items: ['Rucnik', 'brýle'] });
  assert.ok(!out.isError, text(out));
  assert.match(text(out), /Odškrtnuto u „Bazén“: ručník\. Nenašla jsem: brýle\./);
  assert.match(text(out), /seznam 1 z 3 hotovo/);
  assert.equal(writes.length, 1);

  const none = await call('app_task_list', { task: 't_pool', action: 'remove', items: ['kolo'] });
  assert.ok(none.isError);
  assert.match(text(none), /není: kolo\. Nic se nezměnilo\./);
  assert.equal(writes.length, 1, 'nothing written');
  assert.equal(appstate.get().checklists.t_pool.length, 3);
});

await test('app_read shows a task\'s list under it, with the item ids', async () => {
  const read = text(await call('app_read', { section: 'tasks' }));
  const ids = appstate.get().checklists.t_pool.map((i) => i.id);
  assert.match(read, new RegExp(`\\(t_pool\\)[^\\n]*Bazén[^\\n]*\\n    seznam 1 z 3 hotovo: \\[ \\] \\(${ids[0]}\\) plavky · \\[x\\] \\(${ids[1]}\\) ručník`));
  assert.doesNotMatch(read, /Nákup[^\n]*\n    seznam/, 'a task without a list has no line');
});

await test('reset and clear; clear takes the task\'s key away', async () => {
  assert.match(text(await call('app_task_list', { task: 't_pool', action: 'reset' })), /Odškrtnuto zpátky u „Bazén“: ručník/);
  assert.ok(appstate.get().checklists.t_pool.every((i) => !i.done));
  assert.match(text(await call('app_task_list', { task: 't_pool', action: 'reset' })), /nic odškrtnuté není/);
  writes.length = 0;
  const out = await call('app_task_list', { task: 't_pool', action: 'clear' });
  assert.match(text(out), /Seznam smazán u „Bazén“/);
  assert.ok(!('t_pool' in appstate.get().checklists));
  assert.equal(writes[0].undo.t_pool.length, 3, 'Vrátit zpět brings the list back');
  assert.match(text(await call('app_task_list', { task: 't_pool', action: 'clear' })), /prázdný — není co mazat/);
});

await test('an unknown task, or no items to add, changes nothing', async () => {
  writes.length = 0;
  const gone = await call('app_task_list', { task: 't_nope', action: 'add', items: ['x'] });
  assert.ok(gone.isError);
  assert.match(text(gone), /neexistuje/);
  const empty = await call('app_task_list', { task: 't_shop', action: 'add', items: ['  '] });
  assert.ok(empty.isError);
  assert.match(text(empty), /Které položky/);
  assert.equal(writes.length, 0);
});

await test('a full list says so', async () => {
  appstate.setSection('checklists', { t_shop: Array.from({ length: tl.MAX_ITEMS }, (_, i) => ({ id: 'c' + i, label: 'p' + i })) });
  const out = await call('app_task_list', { task: 't_shop', action: 'add', items: ['mléko'] });
  assert.ok(out.isError);
  assert.match(text(out), new RegExp(`má už ${tl.MAX_ITEMS} položek`));
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`tasklist: ${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
