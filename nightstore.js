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

/* ---- the run record (kacey_dream_run) ----------------------------------------
   docs/DREAM.md §10. Starting is one BEGIN IMMEDIATE transaction, so two
   triggers racing for the same date cannot both win. */

export const MAX_AUTO_ATTEMPTS = 2;

function runFromRow(r) {
  return r ? { ...r, report: parseJson(r.report) || {} } : null;
}

export function getRun(date) {
  return runFromRow(open().prepare('SELECT * FROM kacey_dream_run WHERE logical_date = ?').get(String(date)));
}

export function recentRuns(limit = 10) {
  return open().prepare('SELECT * FROM kacey_dream_run ORDER BY logical_date DESC LIMIT ?')
    .all(Math.max(1, Math.min(100, limit))).map(runFromRow);
}

/** May an automatic trigger start a run for this date? No row, or a failed one with attempts left. */
export function canAutoStart(date) {
  const row = getRun(date);
  return !row || (row.status === 'failed' && row.attempts < MAX_AUTO_ATTEMPTS);
}

/**
 * Claim the date. Returns the run row when this caller now owns it, or null
 * (someone else is running it, it is done, or it has used its attempts).
 * `force` (a manual run) re-runs even a done date.
 */
export function claimRun(date, trigger, { force = false, now: at = new Date() } = {}) {
  return transact((h) => {
    const row = h.prepare('SELECT * FROM kacey_dream_run WHERE logical_date = ?').get(date);
    const stamp = at.toISOString();
    if (!row) {
      h.prepare(`INSERT INTO kacey_dream_run (logical_date, status, trigger, attempts, started_at, report)
                 VALUES (?, 'running', ?, 1, ?, '{}')`).run(date, trigger, stamp);
    } else {
      if (row.status === 'running') return null;
      const manual = trigger === 'manual';
      if (row.status === 'done' && !(manual && force)) return null;
      if (row.status === 'failed' && !manual && row.attempts >= MAX_AUTO_ATTEMPTS) return null;
      h.prepare(`UPDATE kacey_dream_run SET status = 'running', trigger = ?, attempts = attempts + 1,
                 started_at = ?, finished_at = NULL WHERE logical_date = ?`).run(trigger, stamp, date);
    }
    return runFromRow(h.prepare('SELECT * FROM kacey_dream_run WHERE logical_date = ?').get(date));
  });
}

export function finishRun(date, status, report) {
  open().prepare('UPDATE kacey_dream_run SET status = ?, finished_at = ?, report = ? WHERE logical_date = ?')
    .run(status, now(), JSON.stringify(report || {}), date);
  return getRun(date);
}

/** A run left `running` longer than `hours` (the process died mid-run) becomes failed and eligible again. */
export function resetStuckRuns(hours, at = new Date()) {
  const cutoff = new Date(at.getTime() - hours * 3600000).toISOString();
  const stuck = open().prepare("SELECT * FROM kacey_dream_run WHERE status = 'running' AND started_at < ?").all(cutoff);
  for (const r of stuck) {
    const report = { ...(parseJson(r.report) || {}), reset: 'stuck' };
    open().prepare("UPDATE kacey_dream_run SET status = 'failed', finished_at = ?, report = ? WHERE logical_date = ?")
      .run(at.toISOString(), JSON.stringify(report), r.logical_date);
  }
  return stuck.map((r) => r.logical_date);
}

/* ---- generated tasks -----------------------------------------------------------
   The generator is the only writer of the generation columns. Every change
   bumps the tasks revision (appstate.bumpTasksRev), so a page holding an
   older list is refused rather than allowed to delete these (§9). */

function nextSortOrder(h) {
  return h.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM kacey_task').get().n;
}

/** Insert one generated task and its checklist. Inside the caller's transaction. */
export function insertGeneratedTask(h, t) {
  const stamp = now();
  h.prepare(`INSERT INTO kacey_task
      (task_id, label, meta, done, due_at, duration_min, sensitivity, sort_order, created_at, updated_at,
       origin, rule_id, source_key, reason, note)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    t.task_id, t.label, t.meta || '', t.due_at || null,
    t.due_at && t.due_at.length > 10 && t.duration_min ? t.duration_min : null,
    t.sensitivity === 'local_only' ? 'local_only' : 'cloud_safe', nextSortOrder(h), stamp, stamp,
    t.origin, t.rule_id || null, t.source_key || null, t.reason || null, t.note || null,
  );
  if (t.checklist && t.checklist.length) {
    const all = kvGet('checklists', {}) || {};
    all[t.task_id] = t.checklist.map((label, i) => ({ id: `c${Date.now()}${i}`, label, note: '', done: false }));
    kvSet('checklists', all);
  }
}

export function generatedTasks({ origin = 'rule', undoneOnly = true } = {}) {
  return open().prepare(`SELECT * FROM kacey_task WHERE origin = ? ${undoneOnly ? 'AND done = 0' : ''}`).all(origin);
}

/** Withdraw a generated task (its source is gone). No suppress entry: if the source comes back, so may the task. */
export function withdrawTask(h, taskId) {
  h.prepare('DELETE FROM kacey_task WHERE task_id = ?').run(taskId);
  const all = kvGet('checklists', {}) || {};
  if (all[taskId]) { delete all[taskId]; kvSet('checklists', all); }
}

export function moveTask(h, taskId, dueAt) {
  h.prepare('UPDATE kacey_task SET due_at = ?, updated_at = ? WHERE task_id = ?').run(dueAt, now(), taskId);
}

export function setTaskNote(h, sourceKey, note) {
  h.prepare('UPDATE kacey_task SET note = ?, updated_at = ? WHERE source_key = ?').run(note || null, now(), sourceKey);
}

export function suppress(h, sourceKey, reason) {
  h.prepare('INSERT OR IGNORE INTO kacey_dream_suppress (source_key, reason, created_at) VALUES (?, ?, ?)')
    .run(sourceKey, reason, now());
}

export function taskBySourceKey(sourceKey) {
  return open().prepare('SELECT * FROM kacey_task WHERE source_key = ?').get(sourceKey) || null;
}

/* ---- proposals (kacey_proposal) ------------------------------------------------ */

export function insertProposals(date, list) {
  const stamp = now();
  const ins = open().prepare(`INSERT INTO kacey_proposal
      (proposal_id, logical_date, label, due_at, reason, about_event, about_title, about_start, about_end, kind, confidence, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`);
  const ids = [];
  for (const p of list) {
    const id = newId('pr_');
    ins.run(id, date, p.label, p.due_at, p.reason || '', p.about_event, p.about_title || '', p.about_start || null, p.about_end || null,
      p.kind || '', Number(p.confidence) || 0, stamp);
    ids.push(id);
  }
  return ids;
}

export function listProposals({ status, date, limit = 50 } = {}) {
  const where = [], args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (date) { where.push('logical_date = ?'); args.push(date); }
  args.push(Math.max(1, Math.min(500, limit)));
  return open().prepare(`SELECT * FROM kacey_proposal ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                         ORDER BY status = 'pending' DESC, confidence DESC, created_at DESC LIMIT ?`).all(...args);
}

export function getProposal(id) {
  return open().prepare('SELECT * FROM kacey_proposal WHERE proposal_id = ?').get(String(id)) || null;
}

/** Proposals already made for these events, for the reasoning pass not to repeat itself. */
export function proposalsForEvents(eventIds) {
  if (!eventIds.length) return [];
  const marks = eventIds.map(() => '?').join(',');
  return open().prepare(`SELECT label, about_event, status FROM kacey_proposal WHERE about_event IN (${marks})`).all(...eventIds);
}

/** The last `limit` decided proposals — the learning loop's input (§13). */
export function recentDecisions(limit = 30) {
  return open().prepare(`SELECT proposal_id, label, kind, about_title, about_start, status, due_at, final_task_id, decided_at
                         FROM kacey_proposal WHERE status IN ('accepted','rejected','edited')
                         ORDER BY decided_at DESC LIMIT ?`).all(limit);
}

export function markExpired(ids, at = new Date()) {
  const upd = open().prepare("UPDATE kacey_proposal SET status = 'expired', decided_at = ? WHERE proposal_id = ? AND status = 'pending'");
  for (const id of ids) upd.run(at.toISOString(), id);
}

function normalizeDueSafe(v) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(v || '').trim());
  if (!m) throw new Error(`termín musí být YYYY-MM-DD nebo YYYY-MM-DDTHH:MM, ne "${v}"`);
  return m[2] ? `${m[1]}T${m[2]}:${m[3]}` : m[1];
}

/**
 * Accept, edit or reject one proposal. Accept and edit create a task with
 * origin 'dream'. Returns { proposal, task }.
 */
export function decideProposal(id, { action, label, due_at } = {}) {
  const p = getProposal(id);
  if (!p) throw new Error('návrh neexistuje');
  if (p.status !== 'pending') throw new Error(`návrh už je vyřízený (${p.status})`);
  if (!['accept', 'edit', 'reject'].includes(action)) throw new Error('akce musí být accept, edit nebo reject');
  const stamp = now();

  if (action === 'reject') {
    open().prepare("UPDATE kacey_proposal SET status = 'rejected', decided_at = ? WHERE proposal_id = ?").run(stamp, p.proposal_id);
    return { proposal: getProposal(p.proposal_id), task: null };
  }

  let finalLabel = p.label, finalDue = p.due_at;
  if (action === 'edit') {
    if (label !== undefined) finalLabel = String(label).trim() || p.label;
    if (due_at !== undefined) finalDue = normalizeDueSafe(due_at);
  }
  const taskId = 'tp_' + p.proposal_id.slice(3);
  transact((h) => {
    insertGeneratedTask(h, {
      task_id: taskId, label: finalLabel, meta: 'návrh od Kacey', due_at: finalDue,
      origin: 'dream', source_key: 'p:' + p.proposal_id, reason: p.reason,
    });
    h.prepare('UPDATE kacey_proposal SET status = ?, decided_at = ?, final_task_id = ?, label = ?, due_at = ? WHERE proposal_id = ?')
      .run(action === 'edit' ? 'edited' : 'accepted', stamp, taskId, finalLabel, finalDue, p.proposal_id);
    appstate.bumpTasksRev();
  });
  return { proposal: getProposal(p.proposal_id), task: appstate.get().tasks.find((t) => t.id === taskId) || null };
}

/* ---- the brief draft --------------------------------------------------------- */

export function briefDraft() { return kvGet('brief.draft', null); }
export function saveBriefDraft(draft) { kvSet('brief.draft', draft); }
