// The whole night run — dream.js — against a throwaway database and a fake
// model. What the real one would be asked is checked; what it answers is
// scripted. docs/DREAM.md §10–§11.
// Run: node test/dream.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kacey-dream-'));
process.env.KLAUS_DB = path.join(dir, 'test.db');
process.env.KACEY_STATE_PATH = path.join(dir, 'no-such-file.json');

// Thursday 10 January 2030 is the planned day; the run happens at 00:40 that night.
const D = '2030-01-10';
const NOW = new Date(2030, 0, 10, 0, 40);
const at = (d, h, m = 0) => new Date(2030, 0, d, h, m).toISOString();

const cal = new DatabaseSync(process.env.KLAUS_DB);
cal.exec(`CREATE TABLE calendar_event (event_id TEXT PRIMARY KEY, title TEXT, starts_at TEXT, ends_at TEXT,
          sensitivity TEXT, source TEXT, source_meta TEXT, external_uid TEXT)`);
const addEvent = cal.prepare('INSERT INTO calendar_event VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
addEvent.run('ev_gym', 'Posilovna', at(11, 7), at(11, 8), 'cloud_safe', 'osobní', '{}', null);          // Fri, exact with the routine
addEvent.run('ev_kurz', 'Kurz keramiky', at(11, 10), at(11, 11), 'cloud_safe', 'osobní', '{}', null);   // Fri, the routine says 16:00
addEvent.run('ev_zubar', 'Zubař MUDr. Nová', at(11, 9), at(11, 9, 45), 'cloud_safe', 'osobní', '{}', null);
addEvent.run('ev_secret', 'Psychiatr', at(10, 15), at(10, 16), 'local_only', 'osobní', '{}', null);
addEvent.run('ev_sgym', 'Gym tajně', at(11, 12), at(11, 13), 'local_only', 'osobní', '{}', null);

const db = await import('../db.js');
const appstate = await import('../appstate.js');
const nightstore = await import('../nightstore.js');
const { runNight } = await import('../dream.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
}

/* The week: a gym block Friday 07:00–08:00 (exact with the calendar), and a
   study block Friday 16:00–17:00 (the same day as "Kurz", another time). */
const grid = {};
for (let s = 28; s < 32; s++) grid['4-' + s] = 'gym';
for (let s = 64; s < 68; s++) grid['4-' + s] = 'study';
appstate.setSection('routine', { grid, notes: {}, wake: 360, sleep: 1380 });

nightstore.seedStarterRules();
nightstore.upsertRule({
  name: 'Kurz', trigger: { sources: ['calendar', 'routine'], calendar_match: ['kurz'], routine_category: 'study' },
  timing: { anchor: 'evening_before', at: '19:00' }, task: { label: 'Připravit hlínu', checklist: ['Zástěra'] },
});

/* ---- the fake model ---------------------------------------------------------- */

const calls = [];
let planner = () => ({ duplicates: [], proposals: [] });
const runner = async ({ system, prompt, memory }) => {
  calls.push({ system, prompt, memory });
  if (system.includes('noční plánovač')) {
    const input = JSON.parse(prompt.split('\n\nTvoje předchozí')[0]);
    const out = planner(input);
    return typeof out === 'string' ? out : '```json\n' + JSON.stringify(out) + '\n```';
  }
  return 'Dobré ráno, pane. Zítra v devět máte zubaře. Večer nezapomeňte na tašku.';
};
const persona = (date) => `PERSONA for ${date}`;
const writes = [];
const deps = { runner, persona, onWrite: (s) => writes.push(s) };

const tasksNow = () => appstate.get().tasks;
const task = (key) => tasksNow().find((t) => t.source_key === key);

/* ---- the first run ------------------------------------------------------------ */

let kurzPair = null;
planner = (input) => {
  kurzPair = input.duplicates_to_judge[0];
  return {
    duplicates: [{ keys: kurzPair.keys, verdict: 'one', confident: true }],
    proposals: [
      { label: 'Najít kartičku pojišťovny', due_at: '2030-01-10T20:00', reason: 'Zítra v 9 zubař.', about_event: 'ev_zubar', confidence: 0.8, kind: 'find_insurance_card' },
      { label: 'Jít cvičit', due_at: '2030-01-10T20:00', reason: 'x', about_event: 'ev_gym', confidence: 0.3, kind: 'go_gym' },
    ],
  };
};

const run1 = await runNight({ date: D, trigger: 'sleep', now: NOW }, deps);

await test('the run finishes done, with a report', () => {
  assert.equal(run1.status, 'done');
  assert.equal(run1.trigger, 'sleep');
  assert.equal(run1.report.target_date, D);
  assert.equal(run1.report.rules.status, 'done');
  assert.equal(run1.report.reasoning.status, 'done');
  assert.equal(run1.report.brief.status, 'done');
  assert.equal(run1.report.collect.held_back_local_only, 2);
});

await test('rules made the tasks, with the exact calendar × routine pair merged', () => {
  const gymTask = task('r:' + nightstore.activeRules().rules.find((r) => r.name === 'Posilovna').id + '|cal:ev_gym');
  assert.ok(gymTask, 'the gym task exists');
  assert.equal(gymTask.origin, 'rule');
  assert.equal(gymTask.due_at, '2030-01-10T20:00');
  assert.match(gymTask.reason, /i v rutině/);
  assert.equal(run1.report.rules.merged.length, 1);
  assert.equal(tasksNow().filter((t) => t.label === 'Sbalit tašku na posilovnu' && t.sensitivity !== 'local_only').length, 1, 'one gym task, not two');
});

await test('a local_only event still gets its rule task, marked local_only', () => {
  const t = tasksNow().find((x) => x.source_key && x.source_key.endsWith('|cal:ev_sgym'));
  assert.ok(t);
  assert.equal(t.sensitivity, 'local_only');
});

await test('the other same-day pair went to the model, which merged it', () => {
  assert.ok(kurzPair, 'the pair was asked about');
  const calKey = kurzPair.keys.find((k) => k.includes('|cal:'));
  const rtKey = kurzPair.keys.find((k) => k.includes('|rt:'));
  assert.equal(task(calKey).note, undefined, 'the note is gone from the calendar one');
  assert.equal(task(rtKey), undefined, 'the routine one is withdrawn');
  assert.ok(nightstore.suppressedKeys().has(rtKey));
});

await test('the checklist was written for the new task', () => {
  const kurz = tasksNow().find((t) => t.label === 'Připravit hlínu');
  assert.deepEqual(appstate.get().checklists[kurz.id].map((i) => i.label), ['Zástěra']);
});

await test('the model saw nothing local_only, and could only read memory', () => {
  const plan = calls.find((c) => c.system.includes('noční plánovač'));
  assert.equal(plan.memory, true);
  assert.ok(!plan.prompt.includes('Psychiatr') && !plan.prompt.includes('Gym tajně'));
  const brief = calls.find((c) => c.system.startsWith('PERSONA'));
  assert.equal(brief.memory, false);
  assert.equal(brief.system, `PERSONA for ${D}`);
  assert.ok(!brief.prompt.includes('Psychiatr'));
});

await test('proposals: the good one stored, the one about a rule\'s event dropped', () => {
  const ps = nightstore.listProposals({ status: 'pending' });
  assert.deepEqual(ps.map((p) => p.label), ['Najít kartičku pojišťovny']);
  assert.equal(ps[0].about_title, 'Zubař MUDr. Nová');
  assert.equal(ps[0].kind, 'find_insurance_card');
  assert.equal(run1.report.reasoning.dropped.length, 1);
});

await test('the brief draft is stored with its hash', () => {
  const draft = nightstore.briefDraft();
  assert.equal(draft.logical_date, D);
  assert.equal(draft.lines.length, 3);
  assert.match(draft.input_hash, /^[0-9a-f]{64}$/);
});

await test('open pages were told', () => {
  assert.ok(writes.includes('tasks'));
  assert.ok(writes.includes('proposals'));
});

/* ---- idempotence --------------------------------------------------------------- */

await test('a second run for the same date is a no-op', async () => {
  const before = tasksNow().length;
  assert.equal(await runNight({ date: D, trigger: 'fallback', now: NOW }, deps), null);
  assert.equal(tasksNow().length, before);
});

await test('a forced manual re-run creates no duplicates and repeats no proposal', async () => {
  const before = tasksNow().length;
  planner = () => ({ duplicates: [], proposals: [{ label: 'najít kartičku pojišťovny', due_at: '2030-01-10T20:00', reason: 'x', about_event: 'ev_zubar', confidence: 0.9, kind: 'find_insurance_card' }] });
  const run = await runNight({ date: D, trigger: 'manual', now: NOW, force: true }, deps);
  assert.equal(run.status, 'done');
  assert.equal(run.attempts, 2);
  assert.equal(tasksNow().length, before);
  assert.equal(run.report.rules.created.length, 0);
  assert.equal(nightstore.listProposals({ status: 'pending' }).length, 1);
  assert.equal(run.report.reasoning.dropped[0].why, 'už navrženo');
});

/* ---- following the source ----------------------------------------------------- */

await test('a deleted generated task stays deleted', async () => {
  const gym = tasksNow().find((t) => t.source_key && t.source_key.endsWith('|cal:ev_gym'));
  appstate.setSection('tasks', tasksNow().filter((t) => t.id !== gym.id));
  const run = await runNight({ date: D, trigger: 'manual', now: NOW, force: true }, deps);
  assert.equal(run.report.rules.suppressed_skipped >= 1, true);
  assert.equal(tasksNow().some((t) => t.id === gym.id), false);
});

await test('a moved event moves its task; a deleted one withdraws it', async () => {
  cal.prepare('UPDATE calendar_event SET starts_at = ?, ends_at = ? WHERE event_id = ?').run(at(12, 10), at(12, 11), 'ev_kurz');  // Kurz to Saturday
  cal.prepare("DELETE FROM calendar_event WHERE event_id = 'ev_sgym'").run();
  const run = await runNight({ date: D, trigger: 'manual', now: NOW, force: true }, deps);
  const kurz = tasksNow().find((t) => t.label === 'Připravit hlínu');
  assert.equal(kurz.due_at, '2030-01-11T19:00');
  assert.equal(run.report.rules.moved.length, 1);
  assert.ok(run.report.rules.withdrawn.some((w) => w.label === 'Sbalit tašku na posilovnu'));
  assert.equal(tasksNow().some((t) => t.source_key && t.source_key.endsWith('|cal:ev_sgym')), false);
});

/* ---- failure ---------------------------------------------------------------- */

const D2 = '2030-01-17';
const NOW2 = new Date(2030, 0, 17, 0, 40);
addEvent.run('ev_vlak', 'Vlak do Brna', at(18, 7, 10), at(18, 9, 40), 'cloud_safe', 'osobní', '{}', null);

await test('garbage twice: the run fails with the reason, the rule tasks stay', async () => {
  planner = () => 'Omlouvám se, ale nevím.';
  const n = calls.length;
  const run = await runNight({ date: D2, trigger: 'sleep', now: NOW2 }, deps);
  assert.equal(run.status, 'failed');
  assert.equal(run.report.reasoning.status, 'failed');
  assert.equal(run.report.reasoning.attempts, 2);
  assert.match(run.report.reasoning.error, /JSON/);
  assert.equal(calls.filter((c, i) => i >= n && c.system.includes('noční plánovač')).length, 2, 'one retry');
  assert.equal(run.report.brief.status, 'done', 'the brief is still written');
});

await test('one automatic retry, then only a manual run', async () => {
  planner = () => ({ duplicates: [], proposals: [] });
  const retry = await runNight({ date: D2, trigger: 'sleep', now: NOW2 }, deps);
  assert.equal(retry.status, 'done');
  assert.equal(retry.attempts, 2);
  db.open().prepare("UPDATE kacey_dream_run SET status = 'failed' WHERE logical_date = ?").run(D2);
  assert.equal(nightstore.canAutoStart(D2), false);
  assert.equal(await runNight({ date: D2, trigger: 'fallback', now: NOW2 }, deps), null);
  assert.ok(await runNight({ date: D2, trigger: 'manual', now: NOW2 }, deps));
});

await test('a model that throws is a failed attempt, not a crash', async () => {
  const D3 = '2030-01-24';
  addEvent.run('ev_pohovor', 'Pohovor', at(25, 10), at(25, 11), 'cloud_safe', 'práce', '{}', null);
  const boom = async ({ system }) => { if (system.includes('noční plánovač')) throw new Error('API Error: 529 overloaded'); return 'Ráno.'; };
  const run = await runNight({ date: D3, trigger: 'sleep', now: new Date(2030, 0, 24, 0, 40) }, { ...deps, runner: boom });
  assert.equal(run.status, 'failed');
  assert.match(run.report.reasoning.error, /overloaded/);
});

await test('a run stuck in running is reset and can be claimed again', async () => {
  const D4 = '2030-01-31';
  db.open().prepare(`INSERT INTO kacey_dream_run (logical_date, status, trigger, attempts, started_at) VALUES (?, 'running', 'sleep', 1, ?)`)
    .run(D4, new Date(2030, 0, 30, 20, 0).toISOString());
  const run = await runNight({ date: D4, trigger: 'fallback', now: new Date(2030, 0, 31, 4, 0) }, deps);
  assert.ok(run, 'claimed after the reset');
  assert.equal(run.attempts, 2);
});

/* ---- proposals, decided ----------------------------------------------------- */

await test('accepting a proposal makes a dream task; the decision is kept', () => {
  const [p] = nightstore.listProposals({ status: 'pending' });
  const { proposal, task: t } = nightstore.decideProposal(p.proposal_id, { action: 'accept' });
  assert.equal(proposal.status, 'accepted');
  assert.equal(t.origin, 'dream');
  assert.equal(t.label, 'Najít kartičku pojišťovny');
  assert.equal(t.source_key, 'p:' + p.proposal_id);
  assert.throws(() => nightstore.decideProposal(p.proposal_id, { action: 'reject' }), /vyřízený/);
  assert.equal(nightstore.recentDecisions()[0].status, 'accepted');
});

await test('editing changes label and due; rejecting makes no task', () => {
  const ids = nightstore.insertProposals(D, [
    { label: 'A', due_at: '2030-01-10T20:00', about_event: 'ev_zubar', kind: 'a_kind', confidence: 0.5 },
    { label: 'B', due_at: '2030-01-10T20:00', about_event: 'ev_zubar', kind: 'b_kind', confidence: 0.5 },
  ]);
  const edited = nightstore.decideProposal(ids[0], { action: 'edit', label: 'A2', due_at: '2030-01-10T21:15' });
  assert.equal(edited.proposal.status, 'edited');
  assert.equal(edited.task.label, 'A2');
  assert.equal(edited.task.due_at, '2030-01-10T21:15');
  const rejected = nightstore.decideProposal(ids[1], { action: 'reject' });
  assert.equal(rejected.task, null);
  assert.equal(rejected.proposal.status, 'rejected');
});

await test('recent decisions reach the reasoning pass (the learning loop)', async () => {
  const D5 = '2030-02-07';
  addEvent.run('ev_opera', 'Opera', at(38, 19), at(38, 22), 'cloud_safe', 'osobní', '{}', null);
  let seen = null;
  planner = (input) => { seen = input; return { duplicates: [], proposals: [] }; };
  const decisions = () => [{ label: 'Koupit dárek', kind: 'buy_gift', about: 'Oslava', decision: 'zamítnuto' }];
  await runNight({ date: D5, trigger: 'sleep', now: new Date(2030, 1, 7, 0, 40) }, { ...deps, decisions });
  assert.ok(seen, 'the planner was asked');
  assert.deepEqual(seen.prior_decisions, decisions());
});

cal.close();
db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`dream: ${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
