/**
 * Kacey — the night run. D.R.E.A.M., the planning kind.
 *
 * Once per target date, while the owner sleeps: collect the next 48 hours,
 * turn the rules into tasks, ask a read-only reasoning pass for what the rules
 * missed, write the morning brief, and report what happened. docs/DREAM.md
 * §10 is the specification; this is the I/O around nightplan.js (the pure
 * decisions) and nightstore.js (the rows).
 *
 * The robustness is borrowed from klaus_memory's consolidation (which this
 * neither calls nor changes): the run is idempotent per date (the primary key
 * of kacey_dream_run), a run stuck in `running` is reset, and a missed night
 * is caught up at boot (night.js).
 *
 * The model is reached through a `runner` — `({ system, prompt, memory }) =>
 * text` — so tests drive the whole run with a fake one. The real runner is a
 * headless Agent SDK query() with NO write tools: at most read-only memory
 * search. The model's only output is JSON; Node decides what becomes a row.
 */

import { readFileSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  BRIEF_AUDIO_DIR, MODEL, DREAM_EFFORT, DREAM_STUCK_HOURS, DREAM_PLANNER_PATH, MCP_SERVERS, MCP_SERVER_NAME,
  DISALLOWED_TOOLS, OWNER_PROFILE, FALLBACK_PERSONA,
} from './config.js';
import * as appstate from './appstate.js';
import * as nightstore from './nightstore.js';
import { transact, kvGet } from './db.js';
import { addDays } from './public/js/core/due.js';
import { previewRules, routineBlocks, logicalStart, hhmmOf } from './rules.js';
import {
  eligibleEvents, buildReasoningInput, parseReasoning, postValidate, briefInputHash,
  splitBriefLines, briefContext, OVERLAP_NOTE,
} from './nightplan.js';

const log = (...a) => console.log('[night]', ...a);
const DAY = 86400000;

/* ---- the model -------------------------------------------------------------- */

const MEMORY_READ_TOOLS = ['memory_search', 'memory_get_facts'].map((t) => `mcp__${MCP_SERVER_NAME}__${t}`);

/**
 * The real runner: one headless query(), no built-in tools, and — only when
 * `memory` is set — klaus_memory with its two read-only search tools. Nothing
 * that writes, anywhere. Resolves with the final text.
 */
export function makeSdkRunner({ timeoutMs = 10 * 60000 } = {}) {
  return async ({ system, prompt, memory = false }) => {
    const q = query({
      prompt,
      options: {
        model: MODEL,
        effort: DREAM_EFFORT,
        systemPrompt: system,
        settingSources: [],
        tools: [],
        mcpServers: memory ? { [MCP_SERVER_NAME]: MCP_SERVERS[MCP_SERVER_NAME] } : {},
        strictMcpConfig: true,
        allowedTools: memory ? MEMORY_READ_TOOLS : [],
        disallowedTools: DISALLOWED_TOOLS,
        permissionMode: 'dontAsk',
        maxTurns: 8,
      },
    });
    const timer = setTimeout(() => { q.interrupt?.().catch(() => {}); }, timeoutMs);
    try {
      let lastError = '';
      for await (const msg of q) {
        if (msg.type === 'assistant' && msg.error) {
          lastError = (msg.message?.content || []).map((b) => (b.type === 'text' ? b.text : '')).join(' ').trim() || msg.error;
        }
        if (msg.type === 'result') {
          if (msg.subtype === 'success' && typeof msg.result === 'string') return msg.result;
          throw new Error(lastError || (msg.errors || []).join('; ') || msg.subtype);
        }
      }
      throw new Error(lastError || 'model skončil bez výsledku');
    } finally {
      clearTimeout(timer);
      try { q.close?.(); } catch { /* gone */ }
    }
  };
}

function plannerPrompt() {
  try { return readFileSync(DREAM_PLANNER_PATH, 'utf8'); } catch { return 'Odpověz jen JSON: {"duplicates":[],"proposals":[]}'; }
}

/* ---- step 1: collect ---------------------------------------------------------- */

function collect(date, report) {
  const doc = appstate.get();
  const sources = doc.settings.sources;
  const start = logicalStart(date);
  // A day either side: an event's first logical day decides, and the brief
  // needs events that started before D and still cover it.
  const events = nightstore.readCalendar(new Date(start.getTime() - DAY), new Date(start.getTime() + 3 * DAY), { sources });
  const history = nightstore.readCalendar(new Date(start.getTime() - 56 * DAY), start, { sources });
  const { rules, invalid } = nightstore.activeRules();
  const window = events.filter((e) => new Date(e.ends_at || e.starts_at) >= start && new Date(e.starts_at) < new Date(start.getTime() + 2 * DAY));
  report.collect = {
    events: window.length,
    routine_blocks: routineBlocks(doc.routine, dayOf(date)).length + routineBlocks(doc.routine, dayOf(addDays(date, 1))).length,
    open_tasks: doc.tasks.filter((t) => !t.done).length,
    rules: rules.length,
    // How many were held back from the cloud steps — a count, never titles.
    held_back_local_only: window.filter((e) => e.sensitivity === 'local_only').length
      + doc.tasks.filter((t) => !t.done && t.sensitivity === 'local_only').length,
  };
  return { doc, events, history, rules, invalid };
}

function dayOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  return (new Date(y, m - 1, d, 12).getDay() + 6) % 7;
}

/* ---- step 2: rules -> tasks ----------------------------------------------------
   Its own transaction, committed before the model is asked anything: if the
   reasoning pass fails at 01:00, the gym-bag reminder still exists. */

function dueInstant(due) {
  return due.length === 10 ? logicalStart(addDays(due, 1)).getTime() - 60000 : new Date(due).getTime();
}

function rulesPass(ctx, date, now, report) {
  const { rules, events, doc } = ctx;
  const from = new Date(Math.max(now.getTime(), logicalStart(date).getTime()));
  const to = logicalStart(addDays(date, 1));
  const items = previewRules({
    rules, events, routine: doc.routine, from, to, now,
    existingKeys: nightstore.existingKeys(), suppressedKeys: nightstore.suppressedKeys(),
  });

  const out = { status: 'done', created: [], merged: [], moved: [], withdrawn: [], suppressed_skipped: 0,
    invalid_rules: ctx.invalid };
  const createdItems = [];
  const pairs = [];

  // Reconciliation looks at the truth over the next two weeks, not just tonight.
  const wide = nightstore.readCalendar(new Date(now.getTime() - DAY), new Date(now.getTime() + 15 * DAY),
    { sources: doc.settings.sources });

  transact((h) => {
    for (const it of items) {
      if (it.status === 'suppressed') { out.suppressed_skipped++; continue; }
      if (it.status !== 'new') continue;
      if (it.source === 'routine' && it.overlap && it.overlap.exact) {
        // The same thing at the same time in both: one task, keyed by the calendar.
        nightstore.suppress(h, it.source_key, 'merged');
        out.merged.push({ key: it.source_key, into: it.overlap.with });
        continue;
      }
      const note = it.overlap && !it.overlap.exact ? OVERLAP_NOTE : null;
      const reason = it.source === 'calendar' && it.overlap && it.overlap.exact ? `${it.reason} · i v rutině` : it.reason;
      nightstore.insertGeneratedTask(h, {
        task_id: it.task_id, label: it.label, meta: it.meta, due_at: it.due_at, duration_min: it.duration_min,
        sensitivity: it.sensitivity, origin: 'rule', rule_id: it.rule_id, source_key: it.source_key,
        reason, note, checklist: it.checklist,
      });
      createdItems.push({ ...it, reason });
      out.created.push({ task_id: it.task_id, label: it.label, due_at: it.due_at, rule: it.rule_name, ...(note ? { note } : {}) });
    }

    // Calendar × routine on the same day at different times: a question for the model.
    const present = (k) => !!h.prepare('SELECT 1 FROM kacey_task WHERE source_key = ? AND note IS NOT NULL').get(k);
    for (const it of items) {
      if (it.source !== 'calendar' || !it.overlap || it.overlap.exact) continue;
      const other = items.find((x) => x.source_key === it.overlap.with);
      if (!other || !present(it.source_key) || !present(other.source_key)) continue;
      pairs.push({
        keys: [it.source_key, other.source_key], rule: it.rule_name,
        calendar: { title: it.about.title, start: it.about.start, end: it.about.end },
        routine: { title: other.about.title, start: other.about.start, end: other.about.end },
      });
    }

    // Following the source: an undone rule task whose event is gone is withdrawn, one that moved follows it.
    const truth = new Map(previewRules({
      rules, events: wide, routine: doc.routine, from: now, to: new Date(now.getTime() + 14 * DAY), now,
    }).map((i) => [i.source_key, i]));
    for (const t of nightstore.generatedTasks({ origin: 'rule' })) {
      if (!t.due_at || dueInstant(t.due_at) < now.getTime()) continue;     // the past is not rewritten
      const now_ = truth.get(t.source_key);
      if (!now_) {
        nightstore.withdrawTask(h, t.task_id);
        out.withdrawn.push({ task_id: t.task_id, label: t.label, due_at: t.due_at });
      } else if (now_.due_at !== t.due_at) {
        nightstore.moveTask(h, t.task_id, now_.due_at);
        out.moved.push({ task_id: t.task_id, label: t.label, from: t.due_at, to: now_.due_at });
      }
    }

    if (out.created.length || out.moved.length || out.withdrawn.length) appstate.bumpTasksRev();
  });

  report.rules = out;
  return { created: createdItems, pairs, changed: !!(out.created.length || out.moved.length || out.withdrawn.length) };
}

/* ---- step 3: the reasoning pass ------------------------------------------------ */

function routineDaysFor(routine, date) {
  const out = {};
  for (const d of [date, addDays(date, 1)]) {
    out[d] = routineBlocks(routine, dayOf(d)).map((b) => ({ from: hhmmOf(b.s), to: hhmmOf(b.e % 1440), category: b.cat, note: b.note }));
  }
  return out;
}

async function reasoningPass(ctx, date, now, rulesOut, report, runner, { decisions = [] } = {}) {
  const eligible = eligibleEvents({ events: ctx.events, history: ctx.history, rules: ctx.rules, date });
  if (!eligible.length && !rulesOut.pairs.length) {
    report.reasoning = { status: 'skipped', why: 'nic neobvyklého ani žádné překryvy' };
    return { changed: false };
  }
  const prior = nightstore.proposalsForEvents(eligible.map((e) => e.event_id));
  const input = buildReasoningInput({
    date, now, ownerProfile: OWNER_PROFILE, events: ctx.events.filter((e) => {
      const s = new Date(e.starts_at).getTime();
      return s < logicalStart(addDays(date, 2)).getTime() && new Date(e.ends_at || e.starts_at).getTime() >= logicalStart(date).getTime();
    }),
    eligible, rules: ctx.rules, routineDays: routineDaysFor(ctx.doc.routine, date),
    openTasks: appstate.get().tasks.filter((t) => !t.done), created: rulesOut.created,
    duplicates: rulesOut.pairs, prior, decisions,
  });

  const system = plannerPrompt();
  let output = null, lastErr = null, attempts = 0;
  for (attempts = 1; attempts <= 2; attempts++) {
    const prompt = JSON.stringify(input, null, 1) +
      (lastErr ? `\n\nTvoje předchozí odpověď byla neplatná (${lastErr}). Odpověz znovu, jen jedním JSON objektem podle zadání.` : '');
    try {
      output = parseReasoning(await runner({ system, prompt, memory: true }));
      break;
    } catch (err) {
      lastErr = err.message;
      log(`reasoning attempt ${attempts} failed: ${err.message}`);
    }
  }
  if (!output) {
    report.reasoning = { status: 'failed', attempts: attempts - 1, error: lastErr };
    return { changed: false };
  }

  const res = postValidate({ output, eligible, asked: rulesOut.pairs, prior, now });

  let changed = false;
  if (res.duplicates.length) {
    transact((h) => {
      for (const d of res.duplicates) {
        if (!d.confident) continue;
        const cal = d.keys.find((k) => k.includes('|cal:'));
        const rt = d.keys.find((k) => k.includes('|rt:'));
        if (d.verdict === 'one' && cal && rt) {
          const task = nightstore.taskBySourceKey(rt);
          if (task && !task.done) nightstore.withdrawTask(h, task.task_id);
          nightstore.suppress(h, rt, 'merged');
          nightstore.setTaskNote(h, cal, null);
        } else if (d.verdict === 'two') {
          for (const k of d.keys) nightstore.setTaskNote(h, k, null);
        }
        changed = true;
      }
      if (changed) appstate.bumpTasksRev();
    });
  }
  const ids = nightstore.insertProposals(date, res.proposals);

  report.reasoning = {
    status: 'done', attempts, proposals: ids.length,
    dropped: res.dropped, duplicates: res.duplicates,
  };
  return { changed, proposals: ids.length };
}

/* ---- step 4: the brief ----------------------------------------------------------
   Written at night, and on a machine where speech synthesis is slower than
   real time (kaceybody: XTTS on a 2 GB GPU, ~2x slower) also RENDERED at
   night: one WAV per line, played as finished files in the morning. */

export { BRIEF_AUDIO_DIR };
const KEEP_AUDIO_DAYS = 3;

/** Render each line to data/brief-audio/<date>/<i>.wav. Returns per line a URL, or null where it failed. */
async function renderBriefAudio(date, lines, synth) {
  const dir = path.join(BRIEF_AUDIO_DIR, date);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      writeFileSync(path.join(dir, `${i}.wav`), await synth(lines[i]));
      out.push(`/api/brief/audio/${date}/${i}?v=${stamp}`);
    } catch (err) {
      log(`brief line ${i + 1} not rendered: ${err.message}`);
      out.push(null);
    }
  }
  // Only the last few mornings are worth keeping.
  try {
    const days = readdirSync(BRIEF_AUDIO_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    for (const d of days.slice(0, Math.max(0, days.length - KEEP_AUDIO_DAYS))) rmSync(path.join(BRIEF_AUDIO_DIR, d), { recursive: true, force: true });
  } catch { /* nothing to tidy */ }
  return out;
}


/**
 * Write the brief for `date` and store it with the hash of what it was written
 * from. Used by the night run and by the morning's T−5 refresh (§12).
 */
export async function writeBrief({ date, runner, persona, synth = null, trigger = 'night', created = [], peakAt = null }) {
  const doc = appstate.get();
  const start = logicalStart(date);
  const events = nightstore.readCalendar(new Date(start.getTime() - DAY), new Date(start.getTime() + 2 * DAY),
    { sources: doc.settings.sources });
  const pending = nightstore.listProposals({ status: 'pending' }).length;
  const prompt = (doc.settings.briefPrompt || 'Shrň mi den.') +
    briefContext({ date, events, tasks: doc.tasks, created, pendingProposals: pending, injected: doc.settings.injected }) +
    `\n\n(Píšeš ranní brief pro den ${date} předem${peakAt ? `; přečte se nahlas v ${peakAt}` : ''}. ` +
    'Mluv k pánovi, jako bys mu ho říkala ráno. Žádné nadpisy ani odrážky.)';
  const text = await runner({ system: persona ? persona(date) : FALLBACK_PERSONA, prompt, memory: false });
  const lines = splitBriefLines(text);
  if (!lines.length) throw new Error('prázdný brief');
  const draft = {
    logical_date: date, lines, made_at: new Date().toISOString(),
    input_hash: briefInputHash({ date, events, tasks: doc.tasks }), trigger,
    audio: synth ? await renderBriefAudio(date, lines, synth) : [],
  };
  nightstore.saveBriefDraft(draft);
  return draft;
}

/** The hash the current state would give — compared with the draft's at T−5. */
export function currentBriefHash(date) {
  const doc = appstate.get();
  const start = logicalStart(date);
  const events = nightstore.readCalendar(new Date(start.getTime() - DAY), new Date(start.getTime() + 2 * DAY),
    { sources: doc.settings.sources });
  return briefInputHash({ date, events, tasks: doc.tasks });
}

/* ---- the run ------------------------------------------------------------------ */

/**
 * Run the night for `date`. Returns the finished run row, or null when the
 * date was not claimed (already done, already running, out of attempts).
 *
 *   deps.runner     ({ system, prompt, memory }) => Promise<text>
 *   deps.persona    (date) => the rendered persona, for the brief's voice
 *   deps.onWrite    (section) => void, so open pages reload
 *   deps.decisions  () => recent proposal decisions (the learning loop, §13)
 */
export async function runNight({ date, trigger, now = new Date(), force = false }, deps = {}) {
  const runner = deps.runner || makeSdkRunner();
  const onWrite = deps.onWrite || (() => {});

  const reset = nightstore.resetStuckRuns(DREAM_STUCK_HOURS, now);
  if (reset.length) log(`reset stuck run(s): ${reset.join(', ')}`);

  const run = nightstore.claimRun(date, trigger, { force, now });
  if (!run) {
    log(`night run for ${date} not started (${trigger}): already done, running, or out of attempts`);
    return null;
  }
  log(`night run for ${date} started (${trigger}, attempt ${run.attempts})`);

  const report = { target_date: date, trigger, attempt: run.attempts, started_at: now.toISOString() };
  let status = 'done';
  try {
    const ctx = collect(date, report);
    const rulesOut = rulesPass(ctx, date, now, report);
    if (rulesOut.changed) onWrite('tasks');

    const r = await reasoningPass(ctx, date, now, rulesOut, report, runner,
      { decisions: deps.decisions ? deps.decisions() : [] });
    if (r.changed) onWrite('tasks');
    if (r.proposals) onWrite('proposals');
    if (report.reasoning.status === 'failed') status = 'failed';

    try {
      const peak = (kvGet('lightsd.last', null) || {}).morning_peak_at || null;
      const draft = await writeBrief({ date, runner, persona: deps.persona, synth: deps.synth || null, created: rulesOut.created, peakAt: peak });
      report.brief = {
        status: 'done', lines: draft.lines.length, input_hash: draft.input_hash,
        audio: draft.audio.filter(Boolean).length,
      };
    } catch (err) {
      // A failed brief does not fail the run: the morning tries again at T−5.
      report.brief = { status: 'failed', error: err.message };
      log(`brief failed: ${err.message}`);
    }
  } catch (err) {
    status = 'failed';
    report.error = err.message;
    log(`night run for ${date} failed: ${err.stack || err.message}`);
  }
  report.finished_at = new Date().toISOString();
  const done = nightstore.finishRun(date, status, report);
  log(`night run for ${date} ${status}: ${(report.rules?.created || []).length} tasks, ` +
      `${report.reasoning?.proposals || 0} proposals, brief ${report.brief?.status || '—'}`);
  return done;
}
