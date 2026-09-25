/**
 * Kacey — the night routine's rules. The pure half.
 *
 * A rule says: when the calendar or the weekly routine has X, create task Y at
 * time Z. Rules are data (kacey_rule rows), so Kacey can make them from speech
 * and the UI can edit them. Anything that needs judgement belongs to the
 * reasoning pass, never to a rule. docs/DREAM.md §8 is the specification; the
 * comments here say why the details are the way they are.
 *
 * Pure: no database, no clock (`now` is always a parameter), no I/O. The same
 * previewRules() is what the night run executes, what the rule_preview tool
 * shows and what the rules editor draws — three callers, one implementation,
 * so "the preview says it will create this" and "the night created this"
 * cannot drift apart. test/rules.mjs covers it.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

import { addDays, dowOf } from './public/js/core/due.js';
import { CATS, CATEGORY_KEYS } from './public/js/core/routine-cats.js';
import { dayRangeOf } from './calendar-days.js';
import { LOGICAL_DAY_START_HOUR } from './config.js';

const DAY_START_MIN = LOGICAL_DAY_START_HOUR * 60;
const DAY_MIN = 1440;

/* ---- schemas --------------------------------------------------------------
   One zod schema for the JSON columns, shared by the HTTP endpoints, the
   agent tools and the loader. */

const HHMM = z.string().trim().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'čas musí být HH:MM');
const Keyword = z.string().trim().min(1).max(40);

export const TriggerSchema = z.object({
  sources: z.array(z.enum(['calendar', 'routine'])).min(1).max(2),
  calendar_match: z.array(Keyword).max(20).optional(),
  routine_category: z.enum(CATEGORY_KEYS).optional(),
  routine_note_match: z.array(Keyword).max(20).optional(),
  starts_before: HHMM.optional(),
}).superRefine((t, ctx) => {
  if (t.sources.includes('calendar') && !(t.calendar_match && t.calendar_match.length)) {
    ctx.addIssue({ code: 'custom', path: ['calendar_match'], message: 'zdroj kalendář potřebuje aspoň jedno klíčové slovo' });
  }
  if (t.sources.includes('routine') && !t.routine_category) {
    ctx.addIssue({ code: 'custom', path: ['routine_category'], message: 'zdroj rutina potřebuje kategorii' });
  }
});

export const TimingSchema = z.object({
  anchor: z.enum(['evening_before', 'morning_of', 'before_start']),
  at: HHMM.optional(),
  offset_min: z.number().int().min(0).max(1440).optional(),
});

export const TaskSchema = z.object({
  label: z.string().trim().min(1).max(120),
  meta: z.string().trim().max(120).optional(),
  duration_min: z.number().int().min(5).max(1440).optional(),
  checklist: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
});

export const RuleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().optional(),
  trigger: TriggerSchema,
  timing: TimingSchema,
  task: TaskSchema,
});

/** A readable Czech line for a zod failure, for tools and the UI. */
export function explainIssues(error) {
  return (error.issues || []).map((i) => `${i.path.join('.') || 'pravidlo'}: ${i.message}`).join('; ');
}

export const TIMING_DEFAULTS = { evening_before: '20:00', morning_of: '07:00', before_start: 60 };

/* ---- keyword matching -----------------------------------------------------
   Czech inflects the end of a word: "posilovna" must match "posilovnu" and
   "posilovně", "fitko" must match "fitku". So a keyword of 5+ letters matches
   a token that starts with the keyword minus its last letter. A short keyword
   would match everything that way ("run" → "brunch", "beh" → "během", which
   means "during"), so under 5 it must equal the token. */

export function normalizeText(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function tokens(s) { return normalizeText(s).match(/[a-z0-9]+/g) || []; }

function tokenMatches(token, kw) {
  return kw.length >= 5 ? token.startsWith(kw.slice(0, -1)) : token === kw;
}

/** Does `text` contain `keyword` (one word, or several in a row)? */
export function matchesKeyword(text, keyword) {
  const kw = tokens(keyword);
  if (!kw.length) return false;
  const tk = tokens(text);
  for (let i = 0; i + kw.length <= tk.length; i++) {
    if (kw.every((k, j) => tokenMatches(tk[i + j], k))) return true;
  }
  return false;
}

export function matchesAny(text, keywords) {
  return (keywords || []).some((k) => matchesKeyword(text, k));
}

/* ---- time ---------------------------------------------------------------- */

function pad(n) { return String(n).padStart(2, '0'); }

export function hhmmOf(mins) { return pad(Math.floor(mins / 60) % 24) + ':' + pad(mins % 60); }

function clockMin(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

/* A clock time inside a logical day: 00:00–03:59 is the END of the day
   (24:00–27:59), not its start. So a 01:00 event is late on the previous day,
   and "at 01:30" on the evening before means that night. */
function logicalMin(mins) { return mins < DAY_START_MIN ? mins + DAY_MIN : mins; }

/** 'YYYY-MM-DDTHH:MM' for a logical date plus logical minutes. */
function atLogical(date, lmins) {
  return lmins >= DAY_MIN ? `${addDays(date, 1)}T${hhmmOf(lmins - DAY_MIN)}` : `${date}T${hhmmOf(lmins)}`;
}

function localStamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local 'YYYY-MM-DDTHH:MM' → Date. */
function parseLocal(stamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(stamp);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}

/* A dated (untimed) due is "some time that day": for the window it counts as
   the end of that logical day, so it belongs to that day's run. */
function dueInstant(due) {
  return due.length === 10 ? parseLocal(`${addDays(due, 1)}T${hhmmOf(DAY_START_MIN - 1)}`) : parseLocal(due);
}

const WEEKDAYS = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];

/** 'čt 1. 10.' — short, the way the UI and the brief say a day. */
export function dayWord(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `${WEEKDAYS[new Date(y, m - 1, d, 12).getDay()]} ${d}. ${m}.`;
}

/** 'čt 1. 10. 20:00', or 'čt 1. 10.' for a dated due. */
export function dueWord(due) {
  if (!due) return 'bez termínu';
  return due.length === 10 ? dayWord(due) : `${dayWord(due.slice(0, 10))} ${due.slice(11, 16)}`;
}

/* ---- occurrences ----------------------------------------------------------
   What a rule's trigger matches: calendar events (on their FIRST logical day,
   so a three-day event does not make three reminders) and routine blocks (one
   per contiguous block per date). */

/** The contiguous blocks of one weekday in the routine grid, as {cat, slot, s, e, note}. */
export function routineBlocks(routine, day) {
  const grid = (routine && routine.grid) || {};
  const notes = (routine && routine.notes) || {};
  const out = [];
  let cur = null;
  for (let i = 0; i < 96; i++) {
    const cat = grid[day + '-' + i];
    if (cat && cur && cur.cat === cat) cur.n++;
    else {
      if (cur) out.push(cur);
      cur = cat ? { cat, i, n: 1 } : null;
    }
  }
  if (cur) out.push(cur);
  return out.map((b) => ({ cat: b.cat, slot: b.i, s: b.i * 15, e: (b.i + b.n) * 15, note: notes[day + '-' + b.i] || '' }));
}

function calendarOccurrences(trigger, events, dates) {
  if (!trigger.sources.includes('calendar')) return [];
  const sb = trigger.starts_before ? logicalMin(clockMin(trigger.starts_before)) : null;
  const out = [];
  for (const ev of events || []) {
    const range = dayRangeOf(ev);
    if (!range || !dates.has(range.first)) continue;
    if (!matchesAny(ev.title, trigger.calendar_match)) continue;
    const start = range.allDay ? null : localStamp(new Date(ev.starts_at));
    const end = range.allDay || !ev.ends_at ? null : localStamp(new Date(ev.ends_at));
    if (sb !== null) {
      if (range.allDay) continue;                          // no start time to compare
      const s = new Date(ev.starts_at);
      const lm = start.slice(0, 10) === range.first ? s.getHours() * 60 + s.getMinutes()
        : DAY_MIN + s.getHours() * 60 + s.getMinutes();
      if (lm >= sb) continue;
    }
    out.push({
      source: 'calendar', date: range.first, start, end, all_day: range.allDay,
      event_id: ev.event_id, title: ev.title, calendar: ev.source || '',
      sensitivity: ev.sensitivity === 'local_only' ? 'local_only' : 'cloud_safe',
    });
  }
  return out;
}

function routineOccurrences(trigger, routine, dates) {
  if (!trigger.sources.includes('routine')) return [];
  const sb = trigger.starts_before ? logicalMin(clockMin(trigger.starts_before)) : null;
  const out = [];
  /* One clock day past the last date too: a block before 04:00 on that day
     belongs to the last logical date. */
  const clockDays = [...dates].sort();
  if (clockDays.length) clockDays.push(addDays(clockDays[clockDays.length - 1], 1));
  for (const date of clockDays) {
    const day = dowOf(date);
    for (const b of routineBlocks(routine, day)) {
      if (b.cat !== trigger.routine_category) continue;
      if (trigger.routine_note_match && trigger.routine_note_match.length && !matchesAny(b.note, trigger.routine_note_match)) continue;
      if (sb !== null && logicalMin(b.s) >= sb) continue;
      /* The grid is in clock days: a block at 02:00 on Tuesday is Monday's
         logical night, the same rule the calendar follows. */
      out.push({
        source: 'routine', date: b.s < DAY_START_MIN ? addDays(date, -1) : date, all_day: false,
        start: `${date}T${hhmmOf(b.s)}`,
        end: b.e >= DAY_MIN ? `${addDays(date, 1)}T00:00` : `${date}T${hhmmOf(b.e)}`,
        block: { day, slot: b.slot }, title: CATS[b.cat].label + (b.note ? ` „${b.note}“` : ''),
        sensitivity: 'cloud_safe',
      });
    }
  }
  return out;
}

/** When a task for this occurrence is due, per the rule's timing. */
export function dueFor(timing, occ) {
  const anchor = timing.anchor;
  if (anchor === 'before_start') {
    if (occ.all_day || !occ.start) return occ.date;          // no start: that day, no time
    const offset = timing.offset_min === undefined ? TIMING_DEFAULTS.before_start : timing.offset_min;
    const s = parseLocal(occ.start);
    return localStamp(new Date(s.getFullYear(), s.getMonth(), s.getDate(), s.getHours(), s.getMinutes() - offset));
  }
  const at = logicalMin(clockMin(timing.at || TIMING_DEFAULTS[anchor]));
  return atLogical(anchor === 'evening_before' ? addDays(occ.date, -1) : occ.date, at);
}

export function sourceKeyFor(ruleId, occ) {
  return occ.source === 'calendar'
    ? `r:${ruleId}|cal:${occ.event_id}`
    : `r:${ruleId}|rt:${occ.block.day}-${occ.block.slot}|${occ.date}`;
}

/** The task id for an occurrence: derived from its key, so a re-run cannot mint a second one. */
export function taskIdFor(sourceKey) {
  return 'tr_' + createHash('sha1').update(sourceKey).digest('hex').slice(0, 12);
}

function reasonFor(occ) {
  const when = occ.all_day || !occ.start ? `${dayWord(occ.date)}, celý den` : `${dayWord(occ.date)} v ${occ.start.slice(11, 16)}`;
  return occ.source === 'calendar'
    ? `„${occ.title}“ v kalendáři${occ.calendar ? ` (${occ.calendar})` : ''}, ${when}`
    : `Rutina: ${occ.title}, ${when}`;
}

/* ---- the preview ----------------------------------------------------------
   Every occurrence of every rule whose due time falls in [from, to). Status:
     new         would be created
     exists      a task with this key is already there
     suppressed  the owner deleted it once; it stays deleted
     past        due before `now` (only when the window starts earlier)
   overlap: the same rule fired from both the calendar and the routine on the
   same day. `exact` when the times are identical to the minute — the night
   run merges those in code; any other pair goes to the reasoning pass. */

export function previewRules({ rules, events = [], routine = {}, from, to, now, existingKeys = new Set(), suppressedKeys = new Set() }) {
  const fromMs = from.getTime(), toMs = to.getTime(), nowMs = now.getTime();

  /* Occurrences are looked for on every logical date a due in the window can
     come from: a due is at most a day before its occurrence (evening before,
     or a before-start offset of up to 24 h), and never after it. */
  const dates = new Set();
  const lastDate = logicalDateOf(new Date(toMs - 1));
  for (let d = logicalDateOf(from); d <= addDays(lastDate, 1); d = addDays(d, 1)) dates.add(d);

  const items = [];
  for (const rule of rules || []) {
    const occs = [
      ...calendarOccurrences(rule.trigger, events, dates),
      ...routineOccurrences(rule.trigger, routine, dates),
    ];
    for (const occ of occs) {
      const due = dueFor(rule.timing, occ);
      const at = dueInstant(due).getTime();
      if (at < fromMs || at >= toMs) continue;
      const key = sourceKeyFor(rule.id, occ);
      items.push({
        rule_id: rule.id,
        rule_name: rule.name,
        source_key: key,
        task_id: taskIdFor(key),
        source: occ.source,
        about: {
          title: occ.title,
          start: occ.start, end: occ.end, all_day: occ.all_day,
          ...(occ.event_id ? { event_id: occ.event_id, calendar: occ.calendar } : {}),
          ...(occ.block ? { block: occ.block } : {}),
        },
        occurrence_date: occ.date,
        due_at: due,
        label: rule.task.label,
        meta: rule.task.meta || `pravidlo „${rule.name}“`,
        duration_min: due.length > 10 ? (rule.task.duration_min || null) : null,
        checklist: rule.task.checklist || [],
        reason: reasonFor(occ),
        sensitivity: occ.sensitivity,
        status: suppressedKeys.has(key) ? 'suppressed' : existingKeys.has(key) ? 'exists' : at < nowMs ? 'past' : 'new',
        overlap: null,
      });
    }
  }

  // Calendar × routine: the same rule, the same day, both sources.
  const groups = new Map();
  for (const it of items) {
    const g = it.rule_id + '|' + it.occurrence_date;
    (groups.get(g) || groups.set(g, []).get(g)).push(it);
  }
  for (const list of groups.values()) {
    const cal = list.filter((i) => i.source === 'calendar');
    const rt = list.filter((i) => i.source === 'routine');
    for (const c of cal) {
      for (const r of rt) {
        const exact = !!c.about.start && c.about.start === r.about.start && c.about.end === r.about.end;
        if (!c.overlap || exact) c.overlap = { with: r.source_key, exact };
        if (!r.overlap || exact) r.overlap = { with: c.source_key, exact };
      }
    }
  }

  return items.sort((a, b) => (a.due_at < b.due_at ? -1 : a.due_at > b.due_at ? 1 : 0));
}

/** The logical date of an instant (04:00 boundary), from the wall clock. */
export function logicalDateOf(d) {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getHours() * 60 + d.getMinutes() < DAY_START_MIN ? addDays(date, -1) : date;
}

/** The start of a logical date, as a Date: 04:00 local. */
export function logicalStart(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, LOGICAL_DAY_START_HOUR, 0);
}

/* ---- describing ---------------------------------------------------------- */

export function describeTiming(timing) {
  if (timing.anchor === 'evening_before') return `večer předem ${timing.at || TIMING_DEFAULTS.evening_before}`;
  if (timing.anchor === 'morning_of') return `ráno v den ${timing.at || TIMING_DEFAULTS.morning_of}`;
  const off = timing.offset_min === undefined ? TIMING_DEFAULTS.before_start : timing.offset_min;
  return `${off} min před začátkem`;
}

export function describeTrigger(trigger) {
  const parts = [];
  if (trigger.sources.includes('calendar')) parts.push(`kalendář: ${(trigger.calendar_match || []).join(', ')}`);
  if (trigger.sources.includes('routine')) {
    const cat = CATS[trigger.routine_category] ? CATS[trigger.routine_category].label : trigger.routine_category;
    parts.push(`rutina: ${cat}${trigger.routine_note_match && trigger.routine_note_match.length ? ` s poznámkou ${trigger.routine_note_match.join('/')}` : ''}`);
  }
  return parts.join(' nebo ') + (trigger.starts_before ? `, jen když začíná před ${trigger.starts_before}` : '');
}

/** "Posilovna → večer předem 20:00 → Sbalit tašku na posilovnu" */
export function describeRule(rule) {
  return `${rule.name} → ${describeTiming(rule.timing)} → ${rule.task.label}`;
}

/** One preview line: "st 30. 9. 20:00 Sbalit tašku (Posilovna čt 1. 10. v 7:00)". */
export function describeItem(it) {
  const flag = it.status === 'suppressed' ? ' [smazáno, nevrátí se]' : it.status === 'exists' ? ' [už existuje]' : '';
  const dup = it.overlap ? (it.overlap.exact ? ' [kalendář i rutina ve stejný čas — sloučí se]' : ' [kalendář i rutina týž den]') : '';
  return `${dueWord(it.due_at)} ${it.label} — ${it.reason}${flag}${dup}`;
}
