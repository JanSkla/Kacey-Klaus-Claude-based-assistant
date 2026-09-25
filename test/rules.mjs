// The night routine's rule engine — rules.js, pure. docs/DREAM.md §8.
// Events are built in local time, the way the host sees them; the calendar
// stores UTC instants, so each is passed through toISOString() like the DB.
// Run: node test/rules.mjs

import assert from 'node:assert/strict';

import {
  matchesKeyword, matchesAny, normalizeText, RuleSchema, previewRules, dueFor,
  sourceKeyFor, taskIdFor, describeRule, logicalDateOf, logicalStart, routineBlocks,
} from '../rules.js';
import { dowOf } from '../public/js/core/due.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.message}`); process.exitCode = 1; }
}

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const ev = (id, title, start, end, extra = {}) => ({
  event_id: id, title, starts_at: start.toISOString(), ends_at: end ? end.toISOString() : null,
  source: 'osobní', sensitivity: 'cloud_safe', ...extra,
});

const POSILOVNA = {
  id: 'rl_gym', name: 'Posilovna',
  trigger: { sources: ['calendar', 'routine'], calendar_match: ['posilovna', 'gym', 'fitko'], routine_category: 'gym' },
  timing: { anchor: 'evening_before', at: '20:00' },
  task: { label: 'Sbalit tašku na posilovnu', checklist: ['Ručník', 'Láhev'] },
};
const BEH = {
  id: 'rl_run', name: 'Běh ráno',
  trigger: {
    sources: ['calendar', 'routine'], calendar_match: ['běh', 'run', 'běhat'],
    routine_category: 'gym', routine_note_match: ['běh'], starts_before: '10:00',
  },
  timing: { anchor: 'evening_before', at: '20:30' },
  task: { label: 'Připravit věci na běh' },
};

// Thursday 1 October 2026 — the event day. Wednesday is the "evening before".
const THU = '2026-10-01';
const WED = '2026-09-30';

/** The window a night run for `date` looks at: that logical day. */
function dayWindow(date, now = at(2026, 9, 29, 23, 0)) {
  const from = logicalStart(date);
  return { from, to: new Date(from.getTime() + 86400000), now };
}

/** A routine grid with one block: weekday `day`, from..to in minutes. */
function grid(day, from, to, cat, note) {
  const g = {}, notes = {};
  for (let m = from; m < to; m += 15) g[day + '-' + m / 15] = cat;
  if (note) notes[day + '-' + from / 15] = note;
  return { grid: g, notes };
}

/* ---- matching ---------------------------------------------------------- */

test('the fixture days are what the tests think they are', () => {
  assert.equal(dowOf(THU), 3);
  assert.equal(dowOf(WED), 2);
});

test('diacritics and case do not matter', () => {
  assert.equal(normalizeText('Běh ŘEKOU'), 'beh rekou');
  assert.ok(matchesKeyword('POSILOVNA s Petrem', 'posilovna'));
  assert.ok(matchesKeyword('Ranní běh', 'Běh'));
});

test('long keywords catch Czech inflection', () => {
  assert.ok(matchesKeyword('Jdu do posilovny', 'posilovna'));
  assert.ok(matchesKeyword('Posilovně s Petrem', 'posilovna'));
  assert.ok(matchesKeyword('fitku', 'fitko'));
  assert.ok(matchesKeyword('běhání v lese', 'běhat'));
});

test('short keywords match whole words only', () => {
  assert.ok(matchesKeyword('Gym s Honzou', 'gym'));
  assert.ok(!matchesKeyword('Gymnázium — třídní schůzky', 'gym'));
  assert.ok(!matchesKeyword('Brunch s mámou', 'run'));
  assert.ok(!matchesKeyword('Během dne zavolat', 'běh'), '"během" means "during"');
  assert.ok(matchesKeyword('Run club', 'run'));
});

test('multi-word keywords match in a row', () => {
  assert.ok(matchesKeyword('Zubní lékař — Novák', 'zubní lékař'));
  assert.ok(!matchesKeyword('Lékař zubní', 'zubní lékař'));
  assert.ok(matchesAny('Zubař', ['posilovna', 'zubař']));
  assert.ok(!matchesAny('Zubař', []));
});

/* ---- the schema -------------------------------------------------------- */

test('a valid rule passes the schema', () => {
  assert.ok(RuleSchema.safeParse(POSILOVNA).success);
  assert.ok(RuleSchema.safeParse(BEH).success);
});

test('the schema refuses rules that could never fire, or bad times', () => {
  const noKeywords = { ...POSILOVNA, trigger: { sources: ['calendar'] } };
  const noCategory = { ...POSILOVNA, trigger: { sources: ['routine'] } };
  const badTime = { ...POSILOVNA, timing: { anchor: 'evening_before', at: '25:00' } };
  const badAnchor = { ...POSILOVNA, timing: { anchor: 'whenever' } };
  const badCat = { ...POSILOVNA, trigger: { sources: ['routine'], routine_category: 'sleep' } };
  for (const r of [noKeywords, noCategory, badTime, badAnchor, badCat]) assert.ok(!RuleSchema.safeParse(r).success, JSON.stringify(r));
});

/* ---- timing ------------------------------------------------------------ */

const occ = (start, extra = {}) => ({ date: THU, start, all_day: false, ...extra });

test('evening before, morning of, before start', () => {
  assert.equal(dueFor({ anchor: 'evening_before', at: '20:00' }, occ('2026-10-01T07:00')), '2026-09-30T20:00');
  assert.equal(dueFor({ anchor: 'evening_before' }, occ('2026-10-01T07:00')), '2026-09-30T20:00', 'default 20:00');
  assert.equal(dueFor({ anchor: 'morning_of' }, occ('2026-10-01T18:00')), '2026-10-01T07:00', 'default 07:00');
  assert.equal(dueFor({ anchor: 'before_start' }, occ('2026-10-01T09:15')), '2026-10-01T08:15', 'default 60 min');
  assert.equal(dueFor({ anchor: 'before_start', offset_min: 90 }, occ('2026-10-01T00:30')), '2026-09-30T23:00');
});

test('an "at" after midnight is that night, not the next evening', () => {
  assert.equal(dueFor({ anchor: 'evening_before', at: '01:30' }, occ('2026-10-01T07:00')), '2026-10-01T01:30');
});

test('before start on an all-day event is that day, untimed', () => {
  assert.equal(dueFor({ anchor: 'before_start' }, { date: THU, start: null, all_day: true }), THU);
});

test('the evening before across the autumn DST change', () => {
  assert.equal(dueFor({ anchor: 'evening_before' }, { date: '2026-10-26', start: '2026-10-26T07:00' }), '2026-10-25T20:00');
});

/* ---- the preview: the calendar ------------------------------------------ */

const gymThu = ev('ev_gym1', 'Posilovna', at(2026, 10, 1, 7, 0), at(2026, 10, 1, 8, 30));

test('an event on Thursday makes a Wednesday-evening task, in Wednesday\'s window', () => {
  const items = previewRules({ rules: [POSILOVNA], events: [gymThu], ...dayWindow(WED) });
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.due_at, '2026-09-30T20:00');
  assert.equal(it.occurrence_date, THU);
  assert.equal(it.label, 'Sbalit tašku na posilovnu');
  assert.equal(it.status, 'new');
  assert.equal(it.source_key, 'r:rl_gym|cal:ev_gym1');
  assert.deepEqual(it.checklist, ['Ručník', 'Láhev']);
  assert.match(it.reason, /Posilovna/);
  assert.equal(it.meta, 'pravidlo „Posilovna“');
});

test('...and nothing in Thursday\'s own window: each occurrence belongs to one night', () => {
  assert.equal(previewRules({ rules: [POSILOVNA], events: [gymThu], ...dayWindow(THU) }).length, 0);
});

test('an event at 01:00 belongs to the previous logical day', () => {
  const late = ev('ev_late', 'Gym', at(2026, 10, 2, 1, 0), at(2026, 10, 2, 2, 0));   // Fri 01:00 = Thursday night
  const items = previewRules({ rules: [POSILOVNA], events: [late], ...dayWindow(WED) });
  assert.equal(items.length, 1);
  assert.equal(items[0].occurrence_date, THU);
});

test('a multi-day event triggers on its first day only', () => {
  const camp = ev('ev_camp', 'Posilovna kemp', at(2026, 10, 1, 9, 0), at(2026, 10, 3, 17, 0));
  const win = { from: logicalStart(WED), to: new Date(logicalStart(WED).getTime() + 4 * 86400000), now: at(2026, 9, 29, 23) };
  const items = previewRules({ rules: [POSILOVNA], events: [camp], ...win });
  assert.equal(items.length, 1);
  assert.equal(items[0].due_at, '2026-09-30T20:00');
});

test('starts_before: early yes, late no, all-day never', () => {
  const early = ev('ev_r1', 'Běh s Janou', at(2026, 10, 1, 7, 0), at(2026, 10, 1, 8, 0));
  const late = ev('ev_r2', 'Běh s Janou', at(2026, 10, 1, 17, 0), at(2026, 10, 1, 18, 0));
  const allDay = ev('ev_r3', 'Run festival', at(2026, 10, 1, 0, 0), at(2026, 10, 2, 0, 0));
  const items = previewRules({ rules: [BEH], events: [early, late, allDay], ...dayWindow(WED) });
  assert.deepEqual(items.map((i) => i.about.event_id), ['ev_r1']);
  assert.equal(items[0].due_at, '2026-09-30T20:30');
});

test('an event nothing matches creates nothing', () => {
  const other = ev('ev_x', 'Zubař', at(2026, 10, 1, 9, 0), at(2026, 10, 1, 10, 0));
  assert.equal(previewRules({ rules: [POSILOVNA, BEH], events: [other], ...dayWindow(WED) }).length, 0);
});

/* ---- the preview: the routine -------------------------------------------- */

test('a routine block triggers on its weekday', () => {
  const routine = grid(3, 7 * 60, 8 * 60 + 30, 'gym', 'běh v parku');   // Thursday 07:00–08:30
  const items = previewRules({ rules: [BEH], routine, ...dayWindow(WED) });
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'routine');
  assert.equal(items[0].due_at, '2026-09-30T20:30');
  assert.equal(items[0].source_key, `r:rl_run|rt:3-28|${THU}`);
  assert.equal(items[0].about.start, '2026-10-01T07:00');
  assert.equal(items[0].about.end, '2026-10-01T08:30');
});

test('the note filter and the category filter both apply', () => {
  assert.equal(previewRules({ rules: [BEH], routine: grid(3, 420, 510, 'gym', 'posilovna'), ...dayWindow(WED) }).length, 0);
  assert.equal(previewRules({ rules: [BEH], routine: grid(3, 420, 510, 'gym'), ...dayWindow(WED) }).length, 0, 'no note, no match');
  assert.equal(previewRules({ rules: [BEH], routine: grid(3, 420, 510, 'work', 'běh'), ...dayWindow(WED) }).length, 0);
});

test('routineBlocks joins contiguous slots of one category', () => {
  const r = grid(3, 420, 510, 'gym', 'x');
  r.grid['3-40'] = 'work';
  assert.deepEqual(routineBlocks(r, 3).map((b) => [b.cat, b.s, b.e, b.note]), [['gym', 420, 510, 'x'], ['work', 600, 615, '']]);
});

test('a routine block at 02:00 is the previous logical day', () => {
  const routine = grid(4, 120, 180, 'gym');          // Friday 02:00 = Thursday night
  const rule = { ...POSILOVNA, trigger: { sources: ['routine'], routine_category: 'gym' } };
  const items = previewRules({ rules: [rule], routine, ...dayWindow(WED) });
  assert.equal(items.length, 1);
  assert.equal(items[0].occurrence_date, THU);
  assert.equal(items[0].about.start, '2026-10-02T02:00');
});

/* ---- calendar × routine ---------------------------------------------------- */

test('the same time in both sources is an exact overlap', () => {
  const routine = grid(3, 420, 510, 'gym');
  const items = previewRules({ rules: [POSILOVNA], events: [gymThu], routine, ...dayWindow(WED) });
  assert.equal(items.length, 2);
  for (const it of items) assert.equal(it.overlap.exact, true);
  const cal = items.find((i) => i.source === 'calendar');
  const rt = items.find((i) => i.source === 'routine');
  assert.equal(cal.overlap.with, rt.source_key);
  assert.equal(rt.overlap.with, cal.source_key);
});

test('a different time on the same day is an overlap for the reasoning pass', () => {
  const routine = grid(3, 18 * 60, 19 * 60, 'gym');
  const items = previewRules({ rules: [POSILOVNA], events: [gymThu], routine, ...dayWindow(WED) });
  assert.equal(items.length, 2);
  for (const it of items) assert.deepEqual([!!it.overlap, it.overlap.exact], [true, false]);
});

test('different days, or different rules, are not an overlap', () => {
  const routine = grid(4, 420, 510, 'gym');          // Friday
  const win = { from: logicalStart(WED), to: new Date(logicalStart(WED).getTime() + 2 * 86400000), now: at(2026, 9, 29, 23) };
  const items = previewRules({ rules: [POSILOVNA], events: [gymThu], routine, ...win });
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.overlap === null));
});

/* ---- status: exists, suppressed, past ---------------------------------------- */

test('an existing key is "exists", a suppressed one "suppressed"', () => {
  const key = 'r:rl_gym|cal:ev_gym1';
  assert.equal(previewRules({ rules: [POSILOVNA], events: [gymThu], ...dayWindow(WED), existingKeys: new Set([key]) })[0].status, 'exists');
  assert.equal(previewRules({ rules: [POSILOVNA], events: [gymThu], ...dayWindow(WED), suppressedKeys: new Set([key]) })[0].status, 'suppressed');
  assert.equal(previewRules({
    rules: [POSILOVNA], events: [gymThu], ...dayWindow(WED),
    existingKeys: new Set([key]), suppressedKeys: new Set([key]),
  })[0].status, 'suppressed', 'suppressed wins');
});

test('a due before now is "past"', () => {
  const items = previewRules({ rules: [POSILOVNA], events: [gymThu], ...dayWindow(WED, at(2026, 9, 30, 21, 0)) });
  assert.equal(items[0].status, 'past');
});

test('a timed task carries the rule\'s duration; an untimed one does not', () => {
  const rule = { ...POSILOVNA, task: { label: 'x', duration_min: 15 } };
  assert.equal(previewRules({ rules: [rule], events: [gymThu], ...dayWindow(WED) })[0].duration_min, 15);
});

/* ---- keys and words ------------------------------------------------------ */

test('source keys and task ids are stable', () => {
  const o = { source: 'routine', date: THU, block: { day: 3, slot: 28 } };
  assert.equal(sourceKeyFor('rl_x', o), `r:rl_x|rt:3-28|${THU}`);
  assert.equal(taskIdFor('r:rl_gym|cal:ev_gym1'), taskIdFor('r:rl_gym|cal:ev_gym1'));
  assert.match(taskIdFor('r:rl_gym|cal:ev_gym1'), /^tr_[0-9a-f]{12}$/);
  assert.notEqual(taskIdFor('a'), taskIdFor('b'));
});

test('describeRule reads like the design', () => {
  assert.equal(describeRule(POSILOVNA), 'Posilovna → večer předem 20:00 → Sbalit tašku na posilovnu');
  assert.equal(describeRule({ ...POSILOVNA, timing: { anchor: 'before_start', offset_min: 45 } }),
    'Posilovna → 45 min před začátkem → Sbalit tašku na posilovnu');
});

test('logicalDateOf works from the wall clock', () => {
  assert.equal(logicalDateOf(at(2026, 10, 1, 3, 59)), WED);
  assert.equal(logicalDateOf(at(2026, 10, 1, 4, 0)), THU);
  assert.equal(logicalDateOf(at(2027, 3, 28, 4, 30)), '2027-03-28', 'spring DST');
});

console.log(`rules: ${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
