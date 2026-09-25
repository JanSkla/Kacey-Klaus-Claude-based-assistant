// The learning loop — nightplan.js ruleOffers / draftRuleFromExamples /
// decisionsForModel, pure. docs/DREAM.md §13. Run: node test/learning.mjs

import assert from 'node:assert/strict';

import { ruleOffers, draftRuleFromExamples, decisionsForModel, OFFER_AFTER } from '../nightplan.js';
import { RuleSchema } from '../rules.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.message}`); process.exitCode = 1; }
}

const NOW = new Date(2026, 9, 1, 8, 0);
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
const local = (y, mo, d, h, mi = 0) => {
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
};

/** A train the next morning; the ticket printed the evening before at ~20:00. */
const ticket = (n, status = 'accepted', day = 10 + n) => ({
  proposal_id: 'p' + n, kind: 'print_ticket', status, decided_at: daysAgo(n),
  label: 'Vytisknout jízdenku', about_title: n % 2 ? 'Vlak do Brna' : 'Vlak do Olomouce',
  about_start: new Date(2026, 8, day + 1, 6, 52).toISOString(),
  due_at: local(2026, 9, day, n === 2 ? 20 : 19, n === 2 ? 30 : 45),
});

test('a kind accepted three times is offered; twice is not', () => {
  assert.equal(ruleOffers([ticket(1), ticket(2)], { now: NOW }).length, 0);
  const offers = ruleOffers([ticket(1), ticket(2), ticket(3)], { now: NOW });
  assert.equal(offers.length, 1);
  assert.equal(offers[0].kind, 'print_ticket');
  assert.equal(offers[0].count, OFFER_AFTER);
});

test('edited counts as accepted; rejected and expired do not', () => {
  assert.equal(ruleOffers([ticket(1), ticket(2, 'edited'), ticket(3)], { now: NOW }).length, 1);
  assert.equal(ruleOffers([ticket(1), ticket(2, 'rejected'), ticket(3)], { now: NOW }).length, 0);
  assert.equal(ruleOffers([ticket(1), ticket(2, 'expired'), ticket(3)], { now: NOW }).length, 0);
});

test('only the last 30 days count', () => {
  const old = { ...ticket(3), decided_at: daysAgo(40) };
  assert.equal(ruleOffers([ticket(1), ticket(2), old], { now: NOW }).length, 0);
});

test('a declined or ruled kind is not offered again', () => {
  assert.equal(ruleOffers([ticket(1), ticket(2), ticket(3)], { now: NOW, closed: ['print_ticket'] }).length, 0);
});

test('the draft: shared title words, evening before at the usual time, the last label', () => {
  const draft = draftRuleFromExamples([ticket(1), ticket(2), ticket(3)]);
  assert.deepEqual(draft.trigger, { sources: ['calendar'], calendar_match: ['vlak'] });
  assert.equal(draft.timing.anchor, 'evening_before');
  assert.equal(draft.timing.at, '19:45');
  assert.equal(draft.task.label, 'Vytisknout jízdenku');
  assert.equal(draft.name, 'Vlak');
  assert.ok(RuleSchema.safeParse(draft).success, 'the draft is a valid rule');
});

test('the draft: a fixed time before the start when that is the pattern', () => {
  const dentist = [1, 2, 3].map((n) => ({
    kind: 'insurance_card', status: 'accepted', label: 'Vzít kartičku', about_title: 'Zubař MUDr. Nová',
    about_start: new Date(2026, 8, 10 + n, 14, 0).toISOString(), due_at: local(2026, 9, 10 + n, 13, n === 2 ? 5 : 0),
  }));
  const draft = draftRuleFromExamples(dentist);
  assert.deepEqual(draft.timing, { anchor: 'before_start', offset_min: 60 });
  assert.deepEqual(draft.trigger.calendar_match, ['zubar', 'mudr', 'nova']);
});

test('the draft: the morning of when the task sat early on the day', () => {
  const party = [1, 2, 3].map((n) => ({
    kind: 'buy_gift', status: 'accepted', label: 'Koupit dárek', about_title: 'Oslava — ' + ['Petr', 'Jana', 'Eva'][n - 1],
    about_start: new Date(2026, 8, 10 + n, 18, 0).toISOString(), due_at: local(2026, 9, 10 + n, 8, 0),
  }));
  const draft = draftRuleFromExamples(party);
  assert.deepEqual(draft.timing, { anchor: 'morning_of', at: '08:00' });
  assert.deepEqual(draft.trigger.calendar_match, ['oslava']);
});

test('the model is told what was decided, in words', () => {
  const out = decisionsForModel([ticket(1), ticket(2, 'rejected'), ticket(3, 'edited')]);
  assert.deepEqual(out.map((d) => d.decision), ['přijato', 'zamítnuto', 'upraveno a přijato']);
  assert.equal(out[0].about, 'Vlak do Brna');
});

console.log(`learning: ${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
