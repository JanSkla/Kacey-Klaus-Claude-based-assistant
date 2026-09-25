// The rules' storage and the preview over a real (throwaway) database:
// nightstore.js. The starter rules, validation on write, the cascade, and a
// preview reading klaus_memory's calendar table read-only.
// Run: node test/nightstore.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kacey-rules-'));
process.env.KLAUS_DB = path.join(dir, 'test.db');
process.env.KACEY_STATE_PATH = path.join(dir, 'no-such-file.json');

/* klaus_memory's calendar, as much of it as the rules read. */
const inDays = (d, h, m = 0) => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(h, m, 0, 0); return x; };
{
  const k = new DatabaseSync(process.env.KLAUS_DB);
  k.exec(`CREATE TABLE calendar_event (event_id TEXT PRIMARY KEY, title TEXT, starts_at TEXT, ends_at TEXT,
          sensitivity TEXT, source TEXT, source_meta TEXT, external_uid TEXT)`);
  const add = k.prepare('INSERT INTO calendar_event VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  add.run('ev_gym', 'Posilovna s Petrem', inDays(3, 7).toISOString(), inDays(3, 8, 30).toISOString(), 'cloud_safe', 'osobní', '{}', null);
  add.run('ev_work', 'Gym — pracovní', inDays(4, 18).toISOString(), inDays(4, 19).toISOString(), 'cloud_safe', 'práce', '{}', null);
  add.run('ev_far', 'Posilovna', inDays(20, 7).toISOString(), inDays(20, 8).toISOString(), 'cloud_safe', 'osobní', '{}', null);
  k.close();
}

const nightstore = await import('../nightstore.js');
const appstate = await import('../appstate.js');
const db = await import('../db.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
}

test('the starter rules are seeded once', () => {
  assert.equal(nightstore.seedStarterRules(), true);
  assert.equal(nightstore.seedStarterRules(), false);
  const sets = nightstore.listRulesets();
  assert.equal(sets.length, 1);
  assert.equal(sets[0].name, 'Základní');
  assert.deepEqual(sets[0].rules.map((r) => r.name), ['Posilovna', 'Běh ráno']);
  assert.ok(sets[0].rules.every((r) => !r.invalid));
});

test('a deleted starter stays deleted', () => {
  const beh = nightstore.listRulesets()[0].rules.find((r) => r.name === 'Běh ráno');
  nightstore.deleteRule(beh.id);
  nightstore.seedStarterRules();
  assert.deepEqual(nightstore.listRulesets()[0].rules.map((r) => r.name), ['Posilovna']);
});

test('an invalid rule is refused with a readable reason, and nothing is written', () => {
  assert.throws(() => nightstore.upsertRule({ name: 'Nic', trigger: { sources: ['calendar'] }, timing: { anchor: 'morning_of' }, task: { label: 'x' } }),
    /calendar_match/);
  assert.equal(nightstore.listRulesets()[0].rules.length, 1);
});

test('a partial update merges with the stored rule', () => {
  const gym = nightstore.listRulesets()[0].rules[0];
  const { rule, before } = nightstore.upsertRule({ id: gym.id, timing: { anchor: 'evening_before', at: '21:00' } });
  assert.equal(before.timing.at, '20:00');
  assert.equal(rule.timing.at, '21:00');
  assert.equal(rule.task.label, 'Sbalit tašku na posilovnu');
  nightstore.upsertRule({ id: gym.id, timing: { anchor: 'evening_before', at: '20:00' } });
});

test('a new rule without a ruleset lands in the first one', () => {
  const { rule } = nightstore.upsertRule({
    name: 'Zubař', trigger: { sources: ['calendar'], calendar_match: ['zubař'] },
    timing: { anchor: 'before_start', offset_min: 60 }, task: { label: 'Kartička pojišťovny' },
  });
  assert.equal(rule.ruleset_id, nightstore.listRulesets()[0].id);
});

test('a disabled ruleset takes its rules out of the active set', () => {
  const set = nightstore.listRulesets()[0];
  nightstore.upsertRuleset({ id: set.id, enabled: false });
  assert.equal(nightstore.activeRules().rules.length, 0);
  nightstore.upsertRuleset({ id: set.id, enabled: true });
  assert.equal(nightstore.activeRules().rules.length, 2);
});

test('the preview reads the calendar and honours the controller\'s calendar switches', () => {
  const from = new Date();
  const to = new Date(from.getTime() + 7 * 86400000);
  const items = nightstore.previewWindow({ from, to, now: from });
  const byEvent = items.map((i) => i.about.event_id).sort();
  assert.deepEqual(byEvent, ['ev_gym', 'ev_work'], 'the far event is outside 7 days');

  const doc = appstate.get();
  appstate.setSection('settings', { ...doc.settings, sources: { ...doc.settings.sources, cal_prace: false } });
  assert.deepEqual(nightstore.previewWindow({ from, to, now: from }).map((i) => i.about.event_id), ['ev_gym']);
});

test('the preview marks existing and suppressed keys', () => {
  const from = new Date();
  const to = new Date(from.getTime() + 7 * 86400000);
  const [it] = nightstore.previewWindow({ from, to, now: from });
  db.open().prepare(`INSERT INTO kacey_dream_suppress VALUES (?, 'deleted', 'x')`).run(it.source_key);
  assert.equal(nightstore.previewWindow({ from, to, now: from })[0].status, 'suppressed');
});

test('deleting a ruleset deletes its rules', () => {
  const set = nightstore.listRulesets()[0];
  nightstore.deleteRuleset(set.id);
  assert.equal(db.open().prepare('SELECT COUNT(*) AS n FROM kacey_rule').get().n, 0);
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`nightstore: ${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
