// Task tags — public/js/core/tasktags.js (the guess, the owner's list), the
// tag column and its migration (db.js), settings.taskTags (appstate.js), and
// Kacey's app_task_add / app_task_update / app_task_tags. Throwaway database.
// Run: node test/tasktags.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kacey-tags-'));
process.env.KLAUS_DB = path.join(dir, 'test.db');
// Never let the one-time JSON import find (and rename!) a real app-state.json.
process.env.KACEY_STATE_PATH = path.join(dir, 'no-such-file.json');

/* A task table from before the tags, so opening the database has to add the
   column and tag what is already there. */
{
  const old = new DatabaseSync(process.env.KLAUS_DB);
  old.exec(`CREATE TABLE kacey_task (
    task_id TEXT PRIMARY KEY, label TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '',
    done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)), due_at TEXT,
    duration_min INTEGER CHECK (duration_min IS NULL OR duration_min BETWEEN 5 AND 1440),
    sensitivity TEXT NOT NULL DEFAULT 'cloud_safe' CHECK (sensitivity IN ('cloud_safe','local_only')),
    sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const ins = old.prepare(`INSERT INTO kacey_task (task_id, label, created_at, updated_at) VALUES (?, ?, 'x', 'x')`);
  ins.run('t_flat', 'Uklidit koupelnu');
  ins.run('t_mum', 'Zavolat mámě');
  ins.run('t_what', 'Něco neurčitého');
  old.close();
}

const tt = await import('../public/js/core/tasktags.js');
const db = await import('../db.js');
const appstate = await import('../appstate.js');
const { APP_TOOLS } = await import('../app-tools.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
}

const D = tt.DEFAULT_TAGS;
const byId = () => Object.fromEntries(appstate.get().tasks.map((t) => [t.id, t]));
const call = (name, args) => APP_TOOLS.find((t) => t.name === name).handler(args, {});
const text = (out) => out.content.map((c) => c.text).join('\n');

/* ---- the guess ------------------------------------------------------------ */

await test('the guess reads Czech with or without diacritics', () => {
  assert.equal(tt.guessTag('Připravit prezentaci pro klienta', D), 'prace');
  assert.equal(tt.guessTag('Naučit se na zkoušku z fyziky', D), 'skola');
  assert.equal(tt.guessTag('uklidit koupelnu a vyluxovat', D), 'byt');
  assert.equal(tt.guessTag('Přečíst knihu', D), 'volno');
  assert.equal(tt.guessTag('Koupit dárek k narozeninám pro babičku', D), 'rodina');
  assert.equal(tt.guessTag('Zavolat mamce', D), 'rodina');
});

await test('nothing fits: no guess, not a random tag', () => {
  assert.equal(tt.guessTag('Něco neurčitého', D), null);
  assert.equal(tt.guessTag('', D), null);
  assert.equal(tt.guessTag('Uklidit', []), null);
  assert.equal(tt.guessTag('synchronizovat kalendář', D), null);
});

await test("the owner's own tag is guessed by its name; a renamed one keeps its words", () => {
  const tags = D.concat([{ id: 'zdravi', name: 'Zdraví' }]);
  assert.equal(tt.guessTag('Zdravotní prohlídka', tags), 'zdravi');
  const renamed = D.map((g) => (g.id === 'byt' ? { id: 'byt', name: 'Domácnost' } : g));
  assert.equal(tt.guessTag('Vytřít kuchyň', renamed), 'byt');
});

await test('a tag by its id or name, any case, with or without diacritics', () => {
  assert.equal(tt.tagByName(D, 'skola').id, 'skola');
  assert.equal(tt.tagByName(D, 'ŠKOLA').id, 'skola');
  assert.equal(tt.tagByName(D, 'az bude volny cas').id, 'volno');
  assert.equal(tt.tagByName(D, ''), null);
  assert.equal(tt.tagByName(D, 'Zdraví'), null);
});

await test('no list means the starting five; an empty list stays empty', () => {
  assert.deepEqual(tt.tagsFrom({}), D);
  assert.deepEqual(tt.tagsFrom(null), D);
  assert.deepEqual(tt.tagsFrom({ taskTags: [] }), []);
});

await test('a stored list is cleaned: names trimmed and cut, no blanks, nothing twice', () => {
  const out = tt.normalizeTags([
    { id: 'a', name: '  Práce  ' }, { id: 'b', name: 'práce' }, { id: 'a', name: 'Jiné' },
    { id: 'c', name: '' }, null, 'x', { name: 'Zdraví' }, { id: 'd', name: 'x'.repeat(60) },
  ]);
  assert.deepEqual(out.map((g) => g.name), ['Práce', 'Zdraví', 'x'.repeat(tt.TAG_NAME_MAX)]);
  assert.equal(out[1].id, 'zdravi');
  assert.deepEqual(tt.normalizeTags('nope'), D);
});

await test("a tag's description is kept on one line, cut to its length, and dropped when empty", () => {
  const out = tt.normalizeTags([
    { id: 'byt', name: 'Byt', hint: '  úklid,\n nákupy   do domácnosti ' },
    { id: 'prace', name: 'Práce', hint: '   ' },
    { id: 'skola', name: 'Škola', hint: 'z'.repeat(400) },
  ]);
  assert.equal(out[0].hint, 'úklid, nákupy do domácnosti');
  assert.ok(!('hint' in out[1]), 'an empty one is no key at all');
  assert.equal(out[2].hint.length, tt.TAG_HINT_MAX);
});

await test("the guess reads the owner's description too", () => {
  const plain = D.concat([{ id: 'zdravi', name: 'Zdraví' }]);
  const described = D.concat([{ id: 'zdravi', name: 'Zdraví', hint: 'doktor, lékárna, očkování, recepty' }]);
  assert.equal(tt.guessTag('Vyzvednout léky v lékárně', plain), null);
  assert.equal(tt.guessTag('Vyzvednout léky v lékárně', described), 'zdravi');
  assert.equal(tt.guessTag('uklidit koupelnu', described), 'byt', 'the others keep their words');
});

await test('a new name must be there, short enough, and not taken', () => {
  assert.equal(tt.tagNameProblem('', D), 'Štítek potřebuje název.');
  assert.equal(tt.tagNameProblem('byt', D), 'Takový štítek už je.');
  assert.equal(tt.tagNameProblem('Byt', D, 'byt'), '', 'its own name is fine');
  assert.match(tt.tagNameProblem('y'.repeat(41), D), /dlouhý/);
  assert.equal(tt.tagNameProblem('Zdraví', D), '');
});

await test('a new id is the name without diacritics, unique', () => {
  assert.equal(tt.newTagId('Až to půjde', D), 'az-to-pujde');
  assert.equal(tt.newTagId('Byt', D), 'byt-2');
  assert.equal(tt.newTagId('!!!', D), 'stitek');
});

/* ---- the column ----------------------------------------------------------- */

const h = db.open();

await test('opening an old database adds the column and tags what is there by its text', () => {
  const cols = h.prepare('PRAGMA table_info(kacey_task)').all().map((c) => c.name);
  assert.ok(cols.includes('tag'));
  const t = byId();
  assert.equal(t.t_flat.tag, 'byt');
  assert.equal(t.t_mum.tag, 'rodina');
  assert.equal(t.t_what.tag, null);
});

await test('a browser save stores the tag and moves a task under another one', () => {
  appstate.setSection('tasks', appstate.get().tasks.map((t) => (t.id === 't_what' ? { ...t, tag: 'volno' } : t)));
  assert.equal(byId().t_what.tag, 'volno');
  appstate.setSection('tasks', appstate.get().tasks.map((t) => (t.id === 't_what' ? { ...t, tag: null } : t)));
  assert.equal(byId().t_what.tag, null);
});

/* ---- the list in settings ------------------------------------------------- */

await test('settings start with the five and store what the owner makes of them', () => {
  assert.deepEqual(appstate.get().settings.taskTags, D);
  appstate.setSection('settings', { ...appstate.get().settings, taskTags: D.concat([{ id: 'zdravi', name: ' Zdraví ' }, { id: 'x', name: 'zdraví' }]) });
  assert.deepEqual(appstate.get().settings.taskTags.map((g) => g.name), ['Práce', 'Škola', 'Byt', 'Až bude volný čas', 'Rodina', 'Zdraví']);
});

await test('a settings save without the list (an older page) keeps it', () => {
  const { taskTags, ...rest } = appstate.get().settings;
  appstate.setSection('settings', { ...rest, hue: 200 });
  assert.equal(appstate.get().settings.hue, 200);
  assert.deepEqual(appstate.get().settings.taskTags, taskTags);
});

/* ---- Kacey ---------------------------------------------------------------- */

await test('app_task_add stores the tag Kacey picked', async () => {
  const out = await call('app_task_add', { label: 'Objednat se k doktorovi', tag: 'zdraví' });
  assert.ok(!out.isError, text(out));
  const t = appstate.get().tasks.at(-1);
  assert.equal(t.tag, 'zdravi');
  assert.match(text(out), /\[Zdraví\]/);
});

await test('app_task_add with a tag that is not there falls back to the guess', async () => {
  await call('app_task_add', { label: 'Vynést odpad', tag: 'Domácnost' });
  assert.equal(appstate.get().tasks.at(-1).tag, 'byt');
});

await test('app_task_update moves a task, clears its tag, and refuses an unknown one', async () => {
  const id = appstate.get().tasks.at(-1).id;
  assert.ok(!(await call('app_task_update', { id, tag: 'Rodina' })).isError);
  assert.equal(byId()[id].tag, 'rodina');
  assert.ok(!(await call('app_task_update', { id, tag: 'bez štítku' })).isError);
  assert.equal(byId()[id].tag, null);
  const bad = await call('app_task_update', { id, tag: 'Neexistuje' });
  assert.ok(bad.isError);
  assert.match(text(bad), /Práce/);
});

await test('app_task_tags adds, renames, reorders and deletes; tasks keep their tag id', async () => {
  assert.ok((await call('app_task_tags', { action: 'add', name: 'Byt' })).isError, 'a name taken');
  assert.ok(!(await call('app_task_tags', { action: 'add', name: 'Auto' })).isError);
  assert.ok(!(await call('app_task_tags', { action: 'rename', name: 'Byt', new_name: 'Domácnost' })).isError);
  assert.equal(byId().t_flat.tag, 'byt', 'a rename moves nothing');
  assert.ok(!(await call('app_task_tags', { action: 'move', name: 'Auto', position: 1 })).isError);
  assert.deepEqual(appstate.get().settings.taskTags.map((g) => g.name),
    ['Auto', 'Práce', 'Škola', 'Domácnost', 'Až bude volný čas', 'Rodina', 'Zdraví']);
  const out = await call('app_task_tags', { action: 'remove', name: 'Domácnost' });
  assert.ok(!out.isError);
  assert.match(text(out), /bez štítku: 1/);
  assert.equal(byId().t_flat.tag, null);
  assert.ok(!appstate.get().settings.taskTags.some((g) => g.id === 'byt'));
  assert.ok((await call('app_task_tags', { action: 'rename', name: 'Nic', new_name: 'X' })).isError);
});

await test("the night run's task is tagged by its text, against the owner's list", async () => {
  const nightstore = await import('../nightstore.js');
  nightstore.insertGeneratedTask(h, { task_id: 'tr_gift', label: 'Koupit dárek mámě', origin: 'rule', reason: 'Narozeniny' });
  appstate.bumpTasksRev();
  assert.equal(byId().tr_gift.tag, 'rodina');
});

await test('app_task_tags describe writes and clears a description; a rename keeps it; app_read lists it', async () => {
  const out = await call('app_task_tags', { action: 'describe', name: 'Rodina', hint: 'máma, táta, babička, dárky a návštěvy' });
  assert.ok(!out.isError, text(out));
  assert.equal(tt.tagByName(appstate.get().settings.taskTags, 'Rodina').hint, 'máma, táta, babička, dárky a návštěvy');
  assert.ok(!(await call('app_task_tags', { action: 'rename', name: 'Rodina', new_name: 'Blízcí' })).isError);
  const g = tt.tagByName(appstate.get().settings.taskTags, 'Blízcí');
  assert.equal(g.id, 'rodina');
  assert.match(g.hint, /babička/);
  const read = text(await call('app_read', { section: 'tasks' }));
  assert.match(read, /ŠTÍTKY \(za pomlčkou/);
  assert.match(read, /- Blízcí — máma, táta/);
  assert.match(read, /- Práce\n/, 'a tag without one is just its name');
  assert.ok(!(await call('app_task_tags', { action: 'add', name: 'Hobby', hint: 'kytara, modelaření' })).isError);
  assert.equal(tt.tagByName(appstate.get().settings.taskTags, 'Hobby').hint, 'kytara, modelaření');
  assert.match(text(await call('app_task_tags', { action: 'describe', name: 'Blízcí', hint: '' })), /smazán/);
  assert.ok(!('hint' in tt.tagByName(appstate.get().settings.taskTags, 'Blízcí')));
  assert.ok((await call('app_task_tags', { action: 'describe', name: 'Nic', hint: 'x' })).isError);
});

await test("the page's settings save keeps a description and cleans it", () => {
  const tags = appstate.get().settings.taskTags.map((g) => (g.id === 'prace' ? { ...g, hint: ' porady,\nreporty ' } : g));
  appstate.setSection('settings', { ...appstate.get().settings, taskTags: tags });
  assert.equal(tt.tagById(appstate.get().settings.taskTags, 'prace').hint, 'porady, reporty');
});

await test('with every tag deleted, a new task goes without one', async () => {
  appstate.setSection('settings', { ...appstate.get().settings, taskTags: [] });
  assert.deepEqual(appstate.get().settings.taskTags, []);
  await call('app_task_add', { label: 'Uklidit sklep', tag: 'Byt' });
  assert.equal(appstate.get().tasks.at(-1).tag, null);
  const read = await call('app_read', { section: 'tasks' });
  assert.match(text(read), /ŠTÍTKY: \(žádné/);
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`tasktags: ${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
