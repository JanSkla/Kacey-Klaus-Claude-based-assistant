/**
 * Kacey — the night run's decisions. The pure half.
 *
 * Which events may get proposals, what the reasoning pass is shown, what it
 * may answer (a zod schema), which of its answers survive, what the brief is
 * written from and how "has anything changed since" is told. dream.js does the
 * I/O around these; test/nightplan.mjs tests them with no model, no database
 * and no clock. docs/DREAM.md §10–§11.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

import { normalizeDue, addDays } from './public/js/core/due.js';
import { dayRangeOf } from './calendar-days.js';
import { eventMatchesRule, normalizeText, logicalStart } from './rules.js';

export const MAX_PROPOSALS = 5;
export const OVERLAP_NOTE = 'Možná jen jedna — kalendář a rutina se překrývají.';

/* ---- recurring events ---------------------------------------------------- */

/* A recurring instance's external uid looks like "<base>_<timestamp>". Two
   events sharing a base are one series. */
const SERIES_UID = /^(.+)_\d{8}(T\d{6}Z?)?$/;

function sourceMeta(ev) {
  if (!ev.source_meta) return {};
  if (typeof ev.source_meta === 'object') return ev.source_meta;
  try { return JSON.parse(ev.source_meta) || {}; } catch { return {}; }
}

/**
 * Is this event part of the routine of life rather than a one-off? A
 * recurrence id from the sync, an external uid shared with another instance,
 * or the same title at least 3 times in the last 8 weeks. The sync writes
 * `source_meta` as {} today, so in practice the title count decides.
 */
export function isRecurring(ev, history = [], all = []) {
  const meta = sourceMeta(ev);
  if (meta.recurring_event_id || meta.recurringEventId || meta.recurrence_id) return true;
  const m = SERIES_UID.exec(ev.external_uid || '');
  if (m && all.some((o) => o !== ev && (SERIES_UID.exec(o.external_uid || '') || [])[1] === m[1])) return true;
  const title = normalizeText(ev.title).trim();
  if (!title) return false;
  return history.filter((h) => normalizeText(h.title).trim() === title).length >= 3;
}

/**
 * The events the reasoning pass may propose tasks for: cloud-safe, on D or
 * D+1, not matched by any active rule (the rules already handle those), and
 * not recurring (a proposal a week for the weekly stand-up would be noise).
 */
export function eligibleEvents({ events, history, rules, date }) {
  const days = new Set([date, addDays(date, 1)]);
  return events.filter((ev) => {
    const range = dayRangeOf(ev);
    if (!range || !days.has(range.first)) return false;
    if (ev.sensitivity === 'local_only') return false;
    if (rules.some((r) => eventMatchesRule(r, ev))) return false;
    return !isRecurring(ev, history, events);
  });
}

/* ---- what the model is shown -------------------------------------------- */

const pad = (n) => String(n).padStart(2, '0');
function local(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The structured context of the reasoning pass (docs/DREAM.md §10 step 3). Cloud-safe only. */
export function buildReasoningInput({ date, now, ownerProfile, events, eligible, rules, routineDays, openTasks, created, duplicates, prior, decisions }) {
  const eligibleIds = new Set(eligible.map((e) => e.event_id));
  return {
    target_date: date,
    now: local(now.toISOString()),
    owner_profile: ownerProfile || '',
    events: events.filter((e) => e.sensitivity !== 'local_only').map((e) => {
      const range = dayRangeOf(e);
      return {
        id: e.event_id, title: e.title, start: local(e.starts_at), end: local(e.ends_at),
        all_day: !!(range && range.allDay), source: e.source || '',
        may_propose: eligibleIds.has(e.event_id),
        matched_rules: rules.filter((r) => eventMatchesRule(r, e)).map((r) => r.name),
      };
    }),
    routine: routineDays,
    open_tasks: openTasks.filter((t) => t.sensitivity !== 'local_only').map((t) => ({ label: t.label, due_at: t.due_at })),
    created_by_rules: created.filter((c) => c.sensitivity !== 'local_only').map((c) => ({ label: c.label, due_at: c.due_at, reason: c.reason })),
    duplicates_to_judge: duplicates,
    prior_proposals: prior,
    ...(decisions && decisions.length ? { prior_decisions: decisions } : {}),
  };
}

/* ---- what the model may answer -------------------------------------------- */

export const ReasoningOutput = z.object({
  duplicates: z.array(z.object({
    keys: z.tuple([z.string(), z.string()]),
    verdict: z.enum(['one', 'two']),
    confident: z.boolean(),
  })).default([]),
  proposals: z.array(z.object({
    label: z.string().trim().min(1).max(120),
    due_at: z.string(),
    reason: z.string().trim().max(300).default(''),
    about_event: z.string(),
    confidence: z.number().min(0).max(1),
    kind: z.string().regex(/^[a-z0-9_]{3,40}$/),
  })).max(MAX_PROPOSALS).default([]),
});

/** The first JSON object in the model's text: bare, or inside a ``` fence. */
export function extractJson(text) {
  const s = String(text || '');
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  const body = fence ? fence[1] : s;
  const start = body.indexOf('{');
  if (start < 0) throw new Error('odpověď neobsahuje JSON');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(body.slice(start, i + 1));
  }
  throw new Error('JSON v odpovědi není uzavřený');
}

/** Parse and validate the model's answer. Throws with a message fit to send back to it. */
export function parseReasoning(text) {
  const parsed = ReasoningOutput.safeParse(extractJson(text));
  if (!parsed.success) {
    throw new Error('JSON neodpovídá schématu: ' + parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return parsed.data;
}

/**
 * Keep what may become a row. Each proposal is checked on its own and a
 * failure costs only that proposal: the event must be one it was allowed to
 * propose for, the due time real, not past, and not after the event ends, and
 * it must not repeat something already proposed for that event.
 */
export function postValidate({ output, eligible, asked, prior, now }) {
  const byId = new Map(eligible.map((e) => [e.event_id, e]));
  const seen = new Set(prior.map((p) => `${p.about_event}|${normalizeText(p.label).trim()}`));
  const keep = [], dropped = [];

  for (const p of output.proposals) {
    const ev = byId.get(p.about_event);
    if (!ev) { dropped.push({ label: p.label, why: 'událost, ke které návrh nesmí být' }); continue; }
    let due;
    try { due = normalizeDue(p.due_at); } catch { dropped.push({ label: p.label, why: `nečitelný termín "${p.due_at}"` }); continue; }
    if (!due) { dropped.push({ label: p.label, why: 'bez termínu' }); continue; }
    const dueAt = due.length === 10 ? new Date(`${due}T23:59`) : new Date(due);
    if (dueAt.getTime() < now.getTime() - 60000) { dropped.push({ label: p.label, why: 'termín v minulosti' }); continue; }
    const end = new Date(ev.ends_at || ev.starts_at);
    if (due.length > 10 && dueAt.getTime() > end.getTime()) { dropped.push({ label: p.label, why: 'termín až po události' }); continue; }
    const key = `${p.about_event}|${normalizeText(p.label).trim()}`;
    if (seen.has(key)) { dropped.push({ label: p.label, why: 'už navrženo' }); continue; }
    seen.add(key);
    keep.push({ ...p, due_at: due, about_title: ev.title, about_end: ev.ends_at || ev.starts_at });
  }

  const askedKeys = new Set(asked.map((d) => d.keys.slice().sort().join('|')));
  const duplicates = output.duplicates.filter((d) => askedKeys.has(d.keys.slice().sort().join('|')));
  return { proposals: keep.slice(0, MAX_PROPOSALS), dropped, duplicates };
}

/* ---- expiry ---------------------------------------------------------------- */

/** The pending proposals whose event has passed (its end, or its start when it has none). */
export function expiredProposals(list, now) {
  return list.filter((p) => p.status === 'pending' && p.about_end && new Date(p.about_end).getTime() <= now.getTime());
}

/* ---- the brief --------------------------------------------------------------- */

/**
 * The hash that says whether the brief is still true (§12): the target day's
 * cloud-safe events and the open tasks due by then. Canonical JSON — sorted,
 * only the fields that matter — so reordering rows is not a "change".
 */
export function briefInputHash({ date, events, tasks }) {
  const dayEnd = logicalStart(addDays(date, 1)).getTime();
  const ev = events
    .filter((e) => e.sensitivity !== 'local_only')
    .filter((e) => { const r = dayRangeOf(e); return r && r.first <= date && r.last >= date; })
    .map((e) => [e.event_id, e.title, e.starts_at, e.ends_at || null])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const tk = tasks
    .filter((t) => t.sensitivity !== 'local_only' && !t.done && t.due_at)
    .filter((t) => new Date(t.due_at.length === 10 ? `${t.due_at}T12:00` : t.due_at).getTime() < dayEnd)
    .map((t) => [t.id, t.label, t.due_at])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return createHash('sha256').update(JSON.stringify({ ev, tk })).digest('hex');
}

/** One line per sentence, as brief.js splits a reply: the brief is tapped through line by line. */
export function splitBriefLines(text) {
  const lines = String(text || '').split(/\n+|(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  return lines.length ? lines : [];
}

/** What the brief is written from, in words, like brief.js's contextBlock() but with the real rows. */
export function briefContext({ date, events, tasks, created, pendingProposals, injected = {} }) {
  const parts = [];
  if (injected.cal !== false) {
    const day = events
      .filter((e) => e.sensitivity !== 'local_only')
      .filter((e) => { const r = dayRangeOf(e); return r && r.first <= date && r.last >= date; })
      .map((e) => {
        const r = dayRangeOf(e);
        return `- ${r.allDay ? 'celý den' : local(e.starts_at).slice(11, 16)} ${e.title}`;
      });
    parts.push(`Kalendář na ${date}:\n${day.length ? day.join('\n') : '- nic'}`);
  }
  if (injected.tasks !== false) {
    const dayEnd = logicalStart(addDays(date, 1)).getTime();
    const due = tasks.filter((t) => t.sensitivity !== 'local_only' && !t.done && t.due_at
      && new Date(t.due_at.length === 10 ? `${t.due_at}T12:00` : t.due_at).getTime() < dayEnd);
    parts.push(`Úkoly do konce dne:\n${due.length ? due.map((t) => `- ${t.due_at.slice(11, 16) || 'dnes'} ${t.label}`).join('\n') : '- nic'}`);
    const made = created.filter((c) => c.sensitivity !== 'local_only');
    if (made.length) parts.push(`V noci podle pravidel přidáno:\n${made.map((c) => `- ${c.label} (${c.reason})`).join('\n')}`);
  }
  if (pendingProposals) parts.push(`Návrhy od Kacey čekající na potvrzení: ${pendingProposals}.`);
  if (injected.weather) parts.push('Počasí: použij, co víš, nebo ho vynech, když ho nemáš.');
  return parts.length ? '\n\nData k dispozici:\n' + parts.join('\n\n') : '';
}
