// The night run's pure decisions — nightplan.js. docs/DREAM.md §10–§11.
// Run: node test/nightplan.mjs

import assert from 'node:assert/strict';

import {
  isRecurring, eligibleEvents, extractJson, parseReasoning, postValidate, expiredProposals,
  briefInputHash, splitBriefLines, buildReasoningInput, briefContext, MAX_PROPOSALS,
} from '../nightplan.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.message}`); process.exitCode = 1; }
}

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const ev = (id, title, start, end, extra = {}) => ({
  event_id: id, title, starts_at: start.toISOString(), ends_at: end ? end.toISOString() : null,
  source: 'osobní', sensitivity: 'cloud_safe', source_meta: '{}', external_uid: null, ...extra,
});

const D = '2026-10-01';                 // Thursday
const NOW = at(2026, 10, 1, 0, 40);     // the run, in the night before
const GYM_RULE = {
  id: 'rl_gym', name: 'Posilovna',
  trigger: { sources: ['calendar'], calendar_match: ['posilovna'] },
  timing: { anchor: 'evening_before' }, task: { label: 'Taška' },
};

const zubar = ev('ev_z', 'Zubař MUDr. Nová', at(2026, 10, 1, 9, 0), at(2026, 10, 1, 9, 45));
const gym = ev('ev_g', 'Posilovna', at(2026, 10, 1, 18, 0), at(2026, 10, 1, 19, 0));
const standup = ev('ev_s', 'Standup', at(2026, 10, 1, 9, 30), at(2026, 10, 1, 9, 45));
const secret = ev('ev_x', 'Doktor', at(2026, 10, 1, 11, 0), at(2026, 10, 1, 12, 0), { sensitivity: 'local_only' });
const friday = ev('ev_f', 'Vlak do Brna', at(2026, 10, 2, 7, 10), at(2026, 10, 2, 9, 40));
const saturday = ev('ev_sat', 'Oslava', at(2026, 10, 3, 19, 0), at(2026, 10, 3, 23, 0));
const history = [1, 2, 3].map((w) => ev(`ev_h${w}`, 'Standup', at(2026, 9, 30 - w * 7, 9, 30), null));

/* ---- recurring and eligible --------------------------------------------- */

test('the same title three times in eight weeks is recurring', () => {
  assert.equal(isRecurring(standup, history), true);
  assert.equal(isRecurring(standup, history.slice(0, 2)), false);
  assert.equal(isRecurring(zubar, history), false);
});

test('a recurrence id or a shared series uid is recurring', () => {
  assert.equal(isRecurring({ ...zubar, source_meta: '{"recurringEventId":"abc"}' }, []), true);
  const a = { ...zubar, external_uid: 'series42_20261001T070000Z' };
  const b = { ...zubar, event_id: 'ev_b', external_uid: 'series42_20261008T070000Z' };
  assert.equal(isRecurring(a, [], [a, b]), true);
  assert.equal(isRecurring(a, [], [a]), false);
});

test('eligible: not a rule\'s, not recurring, not local_only, on D or D+1', () => {
  const got = eligibleEvents({ events: [zubar, gym, standup, secret, friday, saturday], history, rules: [GYM_RULE], date: D });
  assert.deepEqual(got.map((e) => e.event_id), ['ev_z', 'ev_f']);
});

/* ---- the model's answer --------------------------------------------------- */

test('JSON is found bare, fenced, or after prose', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Tady:\n```json\n{"a":{"b":"}"}}\n```'), { a: { b: '}' } });
  assert.deepEqual(extractJson('Výsledek: {"a":[1,2]} hotovo'), { a: [1, 2] });
  assert.throws(() => extractJson('nic'), /JSON/);
  assert.throws(() => extractJson('{"a":1'), /uzavřený/);
});

const good = {
  duplicates: [],
  proposals: [{
    label: 'Najít kartičku pojišťovny', due_at: '2026-10-01T07:30', reason: 'V 9 zubař.',
    about_event: 'ev_z', confidence: 0.8, kind: 'find_insurance_card',
  }],
};

test('a valid answer parses; missing lists default to empty', () => {
  assert.equal(parseReasoning(JSON.stringify(good)).proposals.length, 1);
  assert.deepEqual(parseReasoning('{}'), { duplicates: [], proposals: [] });
});

test('an answer breaking the schema is refused with the reason', () => {
  assert.throws(() => parseReasoning(JSON.stringify({ proposals: [{ ...good.proposals[0], kind: 'Not A Slug' }] })), /kind/);
  const six = Array.from({ length: MAX_PROPOSALS + 1 }, () => good.proposals[0]);
  assert.throws(() => parseReasoning(JSON.stringify({ proposals: six })), /proposals/);
  assert.throws(() => parseReasoning(JSON.stringify({ proposals: [{ ...good.proposals[0], confidence: 2 }] })), /confidence/);
});

/* ---- post-validation ---------------------------------------------------- */

const eligible = [zubar, friday];

test('a good proposal survives, normalised and annotated', () => {
  const { proposals, dropped } = postValidate({ output: good, eligible, asked: [], prior: [], now: NOW });
  assert.equal(dropped.length, 0);
  assert.equal(proposals[0].due_at, '2026-10-01T07:30');
  assert.equal(proposals[0].about_title, 'Zubař MUDr. Nová');
  assert.equal(proposals[0].about_end, zubar.ends_at);
});

test('each bad proposal is dropped on its own, with why', () => {
  const p = good.proposals[0];
  const output = { duplicates: [], proposals: [
    { ...p, about_event: 'ev_g' },                        // a rule's event
    { ...p, due_at: 'zítra' },                            // unreadable
    { ...p, due_at: '2026-09-30T20:00' },                 // past
    { ...p, due_at: '2026-10-01T11:00' },                 // after the event
    { ...p, label: 'Vytisknout jízdenku', about_event: 'ev_f', due_at: '2026-10-01T20:00' },   // fine
  ] };
  const { proposals, dropped } = postValidate({ output, eligible, asked: [], prior: [], now: NOW });
  assert.deepEqual(proposals.map((x) => x.label), ['Vytisknout jízdenku']);
  assert.equal(dropped.length, 4);
  assert.deepEqual(dropped.map((d) => d.why), ['událost, ke které návrh nesmí být', 'nečitelný termín "zítra"', 'termín v minulosti', 'termín až po události']);
});

test('a repeat of an earlier proposal for the same event is dropped', () => {
  const prior = [{ label: 'najít kartičku POJIŠŤOVNY', about_event: 'ev_z', status: 'rejected' }];
  assert.equal(postValidate({ output: good, eligible, asked: [], prior, now: NOW }).proposals.length, 0);
});

test('only the duplicate pairs that were asked about count', () => {
  const asked = [{ keys: ['a', 'b'] }];
  const output = { proposals: [], duplicates: [
    { keys: ['b', 'a'], verdict: 'one', confident: true },
    { keys: ['x', 'y'], verdict: 'one', confident: true },
  ] };
  assert.deepEqual(postValidate({ output, eligible, asked, prior: [], now: NOW }).duplicates.map((d) => d.keys), [['b', 'a']]);
});

/* ---- expiry ------------------------------------------------------------ */

test('a pending proposal expires once its event has passed', () => {
  const list = [
    { proposal_id: 'p1', status: 'pending', about_end: at(2026, 10, 1, 9, 45).toISOString() },
    { proposal_id: 'p2', status: 'pending', about_end: at(2026, 10, 2, 9, 40).toISOString() },
    { proposal_id: 'p3', status: 'accepted', about_end: at(2026, 9, 1).toISOString() },
    { proposal_id: 'p4', status: 'pending', about_end: null },
  ];
  assert.deepEqual(expiredProposals(list, at(2026, 10, 1, 10, 0)).map((p) => p.proposal_id), ['p1']);
  assert.deepEqual(expiredProposals(list, at(2026, 10, 1, 9, 44)).map((p) => p.proposal_id), []);
});

/* ---- the brief ------------------------------------------------------------ */

const tasks = [
  { id: 't1', label: 'Zavolat', due_at: '2026-10-01T15:00', done: false, sensitivity: 'cloud_safe' },
  { id: 't2', label: 'Tajné', due_at: '2026-10-01', done: false, sensitivity: 'local_only' },
  { id: 't3', label: 'Příští týden', due_at: '2026-10-08', done: false, sensitivity: 'cloud_safe' },
];

test('the brief hash is stable under reordering and ignores what does not matter', () => {
  const h1 = briefInputHash({ date: D, events: [zubar, gym], tasks });
  assert.equal(briefInputHash({ date: D, events: [gym, zubar], tasks: tasks.slice().reverse() }), h1);
  assert.equal(briefInputHash({ date: D, events: [zubar, gym, secret, friday], tasks }), h1, 'local_only and other days do not count');
  assert.equal(briefInputHash({ date: D, events: [zubar, gym], tasks: tasks.concat({ id: 't4', label: 'x', due_at: null, done: false }) }), h1, 'undated tasks do not count');
});

test('the brief hash changes when the day changes', () => {
  const h1 = briefInputHash({ date: D, events: [zubar], tasks });
  assert.notEqual(briefInputHash({ date: D, events: [zubar, gym], tasks }), h1, 'an event added');
  assert.notEqual(briefInputHash({ date: D, events: [{ ...zubar, starts_at: at(2026, 10, 1, 10).toISOString() }], tasks }), h1, 'an event moved');
  assert.notEqual(briefInputHash({ date: D, events: [zubar], tasks: [{ ...tasks[0], done: true }, ...tasks.slice(1)] }), h1, 'a task ticked');
});

test('the brief splits into sentences, as brief.js does', () => {
  assert.deepEqual(splitBriefLines('Dobré ráno. V devět máte zubaře!\n\nPak nic.'), ['Dobré ráno.', 'V devět máte zubaře!', 'Pak nic.']);
  assert.deepEqual(splitBriefLines('  '), []);
});

test('nothing local_only reaches the cloud inputs', () => {
  const input = buildReasoningInput({
    date: D, now: NOW, ownerProfile: '', events: [zubar, secret], eligible: [zubar], rules: [GYM_RULE],
    routineDays: {}, openTasks: tasks, created: [{ label: 'x', due_at: 'y', reason: 'z', sensitivity: 'local_only' }],
    duplicates: [], prior: [],
  });
  const text = JSON.stringify(input);
  assert.ok(!text.includes('Doktor') && !text.includes('Tajné') && !text.includes('"x"'), text);
  assert.equal(input.events[0].may_propose, true);
  const ctx = briefContext({ date: D, events: [zubar, secret], tasks, created: [], pendingProposals: 2 });
  assert.ok(!ctx.includes('Doktor') && !ctx.includes('Tajné'));
  assert.match(ctx, /Zubař/);
  assert.match(ctx, /čekající na potvrzení: 2/);
});

console.log(`nightplan: ${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
