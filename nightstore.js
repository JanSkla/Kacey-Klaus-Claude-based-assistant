/**
 * Kacey — the night routine's storage.
 *
 * The SQL behind the rules (kacey_ruleset, kacey_rule), the suppress list, and
 * the read-only view of klaus_memory's calendar the rules and the night run
 * look at. rules.js decides what a rule means; this only stores and loads.
 *
 * The calendar is klaus_memory's table and is only ever READ here, through a
 * read-only handle opened per call, exactly as /api/calendar does — its
 * schema is never touched (docs/DREAM.md §10).
 */

import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { KLAUS_DB } from './config.js';
import { open, transact, kvGet, kvSet, now } from './db.js';
import * as appstate from './appstate.js';
import { RuleSchema, explainIssues, previewRules, normalizeText } from './rules.js';

const newId = (prefix) => prefix + randomBytes(6).toString('hex');

function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }

/* ---- rulesets and rules --------------------------------------------------- */

function ruleFromRow(r) {
  const raw = { name: r.name, enabled: !!r.enabled, trigger: parseJson(r.trigger), timing: parseJson(r.timing), task: parseJson(r.task) };
  const parsed = RuleSchema.safeParse(raw);
  return {
    id: r.rule_id,
    ruleset_id: r.ruleset_id,
    sort_order: r.sort_order,
    ...raw,
    ...(parsed.success ? {} : { invalid: explainIssues(parsed.error) }),
    updated_at: r.updated_at,
  };
}

/** Every ruleset with its rules, in order. Invalid rules are listed with `invalid`. */
export function listRulesets() {
  const h = open();
  const sets = h.prepare('SELECT * FROM kacey_ruleset ORDER BY sort_order, created_at').all();
  const rules = h.prepare('SELECT * FROM kacey_rule ORDER BY sort_order, created_at').all().map(ruleFromRow);
  return sets.map((s) => ({
    id: s.ruleset_id,
    name: s.name,
    description: s.description,
    enabled: !!s.enabled,
    sort_order: s.sort_order,
    rules: rules.filter((r) => r.ruleset_id === s.ruleset_id),
  }));
}

export function getRule(id) {
  const r = open().prepare('SELECT * FROM kacey_rule WHERE rule_id = ?').get(String(id));
  return r ? ruleFromRow(r) : null;
}

export function getRuleset(id) {
  return listRulesets().find((s) => s.id === id) || null;
}

/** The rules that run: enabled, in an enabled ruleset, and valid. */
export function activeRules() {
  const out = [], invalid = [];
  for (const set of listRulesets()) {
    if (!set.enabled) continue;
    for (const r of set.rules) {
      if (!r.enabled) continue;
      if (r.invalid) { invalid.push({ id: r.id, name: r.name, why: r.invalid }); continue; }
      out.push(r);
    }
  }
  return { rules: out, invalid };
}

export function upsertRuleset({ id, name, description, enabled, sort_order } = {}) {
  const stamp = now();
  const h = open();
  const existing = id ? h.prepare('SELECT * FROM kacey_ruleset WHERE ruleset_id = ?').get(String(id)) : null;
  if (id && !existing) throw new Error(`sada pravidel "${id}" neexistuje`);
  if (existing) {
    h.prepare(`UPDATE kacey_ruleset SET name = ?, description = ?, enabled = ?, sort_order = ?, updated_at = ? WHERE ruleset_id = ?`).run(
      name !== undefined ? String(name).trim() || existing.name : existing.name,
      description !== undefined ? String(description) : existing.description,
      enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
      sort_order !== undefined ? Number(sort_order) || 0 : existing.sort_order,
      stamp, existing.ruleset_id,
    );
    return getRuleset(existing.ruleset_id);
  }
  const label = String(name || '').trim();
  if (!label) throw new Error('sada pravidel potřebuje název');
  const rid = newId('rs_');
  const order = sort_order !== undefined ? Number(sort_order) || 0
    : (h.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM kacey_ruleset').get().n);
  h.prepare(`INSERT INTO kacey_ruleset (ruleset_id, name, description, enabled, sort_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`).run(rid, label, String(description || ''), enabled === false ? 0 : 1, order, stamp, stamp);
  return getRuleset(rid);
}

export function deleteRuleset(id) {
  const before = getRuleset(String(id));
  if (!before) throw new Error(`sada pravidel "${id}" neexistuje`);
  open().prepare('DELETE FROM kacey_ruleset WHERE ruleset_id = ?').run(before.id);   // rules go with it (FK cascade)
  return before;
}

/** The ruleset new rules go into when none is named: the first one, or a new "Moje pravidla". */
export function defaultRulesetId() {
  const first = open().prepare('SELECT ruleset_id FROM kacey_ruleset ORDER BY sort_order, created_at LIMIT 1').get();
  return first ? first.ruleset_id : upsertRuleset({ name: 'Moje pravidla' }).id;
}

/**
 * Create or change a rule. `patch` may be partial for an existing rule; the
 * merged result is validated by the shared zod schema before anything is
 * written. Returns { rule, before } — `before` is null for a new rule.
 */
export function upsertRule(patch = {}) {
  const h = open();
  const existing = patch.id ? getRule(patch.id) : null;
  if (patch.id && !existing) throw new Error(`pravidlo "${patch.id}" neexistuje`);

  const merged = {
    name: patch.name !== undefined ? patch.name : existing?.name,
    enabled: patch.enabled !== undefined ? !!patch.enabled : existing ? existing.enabled : true,
    trigger: patch.trigger !== undefined ? patch.trigger : existing?.trigger,
    timing: patch.timing !== undefined ? patch.timing : existing?.timing,
    task: patch.task !== undefined ? patch.task : existing?.task,
  };
  const parsed = RuleSchema.safeParse(merged);
  if (!parsed.success) throw new Error(explainIssues(parsed.error));
  const rule = parsed.data;

  const rulesetId = patch.ruleset_id || existing?.ruleset_id || defaultRulesetId();
  if (!h.prepare('SELECT 1 FROM kacey_ruleset WHERE ruleset_id = ?').get(rulesetId)) {
    throw new Error(`sada pravidel "${rulesetId}" neexistuje`);
  }
  const stamp = now();
  if (existing) {
    h.prepare(`UPDATE kacey_rule SET ruleset_id = ?, name = ?, enabled = ?, sort_order = ?, trigger = ?, timing = ?, task = ?, updated_at = ?
               WHERE rule_id = ?`).run(
      rulesetId, rule.name, rule.enabled === false ? 0 : 1,
      patch.sort_order !== undefined ? Number(patch.sort_order) || 0 : existing.sort_order,
      JSON.stringify(rule.trigger), JSON.stringify(rule.timing), JSON.stringify(rule.task), stamp, existing.id,
    );
    return { rule: getRule(existing.id), before: existing };
  }
  const id = newId('rl_');
  const order = patch.sort_order !== undefined ? Number(patch.sort_order) || 0
    : h.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM kacey_rule WHERE ruleset_id = ?').get(rulesetId).n;
  h.prepare(`INSERT INTO kacey_rule (rule_id, ruleset_id, name, enabled, sort_order, trigger, timing, task, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, rulesetId, rule.name, rule.enabled === false ? 0 : 1, order,
    JSON.stringify(rule.trigger), JSON.stringify(rule.timing), JSON.stringify(rule.task), stamp, stamp,
  );
  return { rule: getRule(id), before: null };
}

export function deleteRule(id) {
  const before = getRule(id);
  if (!before) throw new Error(`pravidlo "${id}" neexistuje`);
  open().prepare('DELETE FROM kacey_rule WHERE rule_id = ?').run(before.id);
  return before;
}

/* ---- the starter rules ---------------------------------------------------
   Seeded once, marked in kv, so deleting a starter keeps it deleted. */

export const STARTER_RULES = [
  {
    name: 'Posilovna',
    trigger: { sources: ['calendar', 'routine'], calendar_match: ['posilovna', 'gym', 'fitko'], routine_category: 'gym' },
    timing: { anchor: 'evening_before', at: '20:00' },
    task: { label: 'Sbalit tašku na posilovnu' },
  },
  {
    name: 'Běh ráno',
    trigger: {
      sources: ['calendar', 'routine'], calendar_match: ['běh', 'run', 'běhat'],
      routine_category: 'gym', routine_note_match: ['běh'], starts_before: '10:00',
    },
    timing: { anchor: 'evening_before', at: '20:30' },
    task: { label: 'Připravit věci na běh' },
  },
];

export function seedStarterRules() {
  if (kvGet('rules.seeded', false)) return false;
  transact(() => {
    const set = upsertRuleset({ name: 'Základní', description: 'Pravidla, se kterými Kacey začínala.' });
    for (const r of STARTER_RULES) upsertRule({ ...r, ruleset_id: set.id });
    kvSet('rules.seeded', true);
  });
  console.log('[night] seeded the starter rules (Posilovna, Běh ráno)');
  return true;
}

/* ---- tasks the rules have made ---------------------------------------------- */

export function suppressedKeys() {
  return new Set(open().prepare('SELECT source_key FROM kacey_dream_suppress').all().map((r) => r.source_key));
}

export function existingKeys() {
  return new Set(open().prepare('SELECT source_key FROM kacey_task WHERE source_key IS NOT NULL').all().map((r) => r.source_key));
}

/* ---- the calendar, read-only ----------------------------------------------- */

/* The controller's calendar switches are keyed cal_<source without accents>;
   a calendar switched off there is invisible to the rules too. */
function calendarAllowed(source, sources) {
  const key = 'cal_' + normalizeText(source).replace(/[^a-z0-9]/g, '');
  return !(sources && sources[key] === false);
}

/**
 * Calendar events touching [from, to), from klaus_memory's calendar_event.
 * A read-only handle per call: never a lock held, always the latest writes.
 */
export function readCalendar(from, to, { sources } = {}) {
  let db;
  try {
    db = new DatabaseSync(KLAUS_DB, { readOnly: true });
  } catch (err) {
    throw new Error(`kalendář nelze otevřít: ${err.message}`);
  }
  try {
    const rows = db.prepare(
      `SELECT event_id, title, starts_at, ends_at, sensitivity, source, source_meta, external_uid
         FROM calendar_event
        WHERE starts_at < ? AND COALESCE(ends_at, starts_at) >= ?
        ORDER BY starts_at`,
    ).all(to.toISOString(), from.toISOString());
    return rows.filter((r) => calendarAllowed(r.source, sources));
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/**
 * The preview over a window, with everything it needs loaded: the calendar,
 * the routine, which keys exist and which are suppressed. `rules` defaults to
 * the active ones; pass a draft to preview a rule before saving it.
 */
export function previewWindow({ from, to, now: at = new Date(), rules } = {}) {
  const doc = appstate.get();
  const list = rules || activeRules().rules;
  /* Events from a day before the window to a day after: an event's first
     logical day decides, and a due can sit up to a day before its event. */
  const events = readCalendar(new Date(from.getTime() - 86400000), new Date(to.getTime() + 2 * 86400000),
    { sources: doc.settings.sources });
  return previewRules({
    rules: list, events, routine: doc.routine, from, to, now: at,
    existingKeys: existingKeys(), suppressedKeys: suppressedKeys(),
  });
}
