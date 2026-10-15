/**
 * Kacey — improving the app from the chat (Claude Design "Kacey Self-Update").
 *
 * The owner says "Přidej novou funkci do úkolů…". Kacey recognises a request
 * for the app itself and calls her `app_upgrade_request` tool (app-tools.js),
 * which lands here as request(). From then on one job walks through:
 *
 *   confirm | questions   the page shows the popup; nothing exists yet
 *   drafting              a git worktree on kaceyFeature/<slug>, a coding agent
 *                         writes a clickable draft, the host commits it
 *   review                a preview of the branch runs on PREVIEW_PORT; the page
 *                         compares it side by side with the running app
 *   refining              a prompt from the owner → a new commit (revision N)
 *   finalizing            approved: the agent finishes it for production, the
 *                         tests run, the version goes up
 *   ready                 one tap merges the branch and restarts Kacey
 *   switching             merging / restarting
 *
 * Only one job at a time. The running app is never touched before the switch:
 * the agent works in its own folder (UPGRADE_DIR/<slug>), may write only there,
 * and the preview is a separate process with a copy of the database.
 *
 * Every change of the job goes to the pages as an `upgrade` frame (emit()), and
 * the job is kept in kv `upgrade.job`, so a page that opens later — or Kacey
 * after a restart — picks it up where it was.
 */

import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import path from 'node:path';
import { z } from 'zod';

import { kvGet, kvSet } from './db.js';
import {
  UPGRADE_REPO, KLAUS_DB, VERSION, SELFUPDATE, UPGRADE_DIR, PREVIEW_PORT, UPGRADE_MODEL, UPGRADE_EFFORT,
  UPGRADE_RESTART_CMD, SERVICE_UNIT,
} from './config.js';

const log = (...a) => console.log('[upgrade]', ...a);

const KV_JOB = 'upgrade.job';
const KV_LAST = 'upgrade.last';
const BRANCH_PREFIX = 'kaceyFeature/';
const PREVIEW_STATE = path.join(UPGRADE_DIR, '.preview');

/* The routes a feature can be about — the views the comparison opens on. */
export const VIEWS = ['main', 'tasks', 'calendar', 'journal', 'library', 'brief', 'timer', 'controller', 'rules', 'morning', 'lights'];

const STAGES_BUSY = ['drafting', 'refining', 'finalizing', 'switching'];

let job = null;              // the one job, or null
let broadcast = () => {};
let shutdown = () => process.exit(1);
let run = null;              // { token, abort } of the agent run in flight
let preview = null;          // { child, ready }

/* ---- the job --------------------------------------------------------------- */

/** What the pages see. */
export function snapshot() {
  if (!job) return { enabled: SELFUPDATE, job: null, last: recentSwitch() };
  const j = job;
  return {
    enabled: SELFUPDATE,
    last: recentSwitch(),
    job: {
      id: j.id, stage: j.stage, title: j.title, short: j.short, branch: j.branch, request: j.request,
      bullets: j.bullets, area: j.area, platforms: j.platforms, view: j.view, questions: j.questions,
      answers: j.answers, note: j.note,
      steps: j.steps, cur: j.cur,
      revs: j.revs.map((r) => ({ n: r.n, summary: r.summary })), viewRev: j.viewRev,
      hist: j.hist, summary: j.summary,
      versionFrom: j.versionFrom, versionTo: j.versionTo,
      preview: { port: PREVIEW_PORT, ready: !!(preview && preview.ready) },
      approvedAt: j.approvedAt, error: j.error, restart: j.restart || null,
      sessionId: j.sessionId || null,
    },
  };
}

function recentSwitch() {
  const last = kvGet(KV_LAST, null);
  if (!last || Date.now() - Date.parse(last.at) > 10 * 60000) return null;
  return last;
}

function save() { kvSet(KV_JOB, job); }
function emit() { save(); broadcast({ type: 'upgrade', ...snapshot() }); }

function set(patch) { Object.assign(job, patch); emit(); }

export function current() { return job; }

/** Session ids that asked for an improvement — the history marks them. */
export function sessionsWithUpgrade() { return kvGet('upgrade.sessions', []); }

/* ---- request: the popup ------------------------------------------------------- */

/** From Kacey's tool. Returns { ok, text } — the text is what the tool tells her. */
export function request(spec, sessionId) {
  if (!SELFUPDATE) return { ok: false, text: 'Vylepšování aplikace je na tomhle serveru vypnuté (KACEY_SELFUPDATE=off).' };
  if (job && !['confirm', 'questions'].includes(job.stage)) {
    return {
      ok: false,
      text: `Právě běží jiné vylepšení („${job.short}“, stav ${job.stage}). Řekni pánovi, ať ho dokončí, ` +
        'nebo ho v porovnání zahodí — teprve pak jde začít další.',
    };
  }
  const slug = slugify(spec.slug || spec.title);
  const questions = (spec.questions || []).slice(0, 3).map((q) => ({
    title: q.title, key: q.key || q.title, multi: !!q.multi,
    options: q.options.slice(0, 5),
    def: (q.default || [0]).filter((i) => i >= 0 && i < q.options.length).slice(0, q.multi ? 5 : 1),
  }));
  job = {
    id: `u${Date.now().toString(36)}`,
    stage: questions.length ? 'questions' : 'confirm',
    title: spec.title, short: spec.short || spec.title, slug, branch: BRANCH_PREFIX + slug,
    request: spec.request, bullets: spec.bullets, area: spec.area,
    platforms: spec.platforms?.length ? spec.platforms : ['desktop', 'telefon'],
    view: VIEWS.includes(spec.view) ? spec.view : 'main',
    questions, answers: null, note: '',
    steps: [], cur: 0, revs: [], viewRev: 0, hist: [], summary: '',
    versionFrom: VERSION, versionTo: bumpPatch(VERSION),
    createdAt: new Date().toISOString(), approvedAt: null, error: null, restart: null,
    sessionId: sessionId || null,
  };
  if (sessionId) {
    const marked = sessionsWithUpgrade();
    if (!marked.includes(sessionId)) kvSet('upgrade.sessions', [...marked, sessionId].slice(-200));
  }
  emit();
  log(`request "${job.title}" → ${job.branch} (${job.stage})`);
  return {
    ok: true,
    text: questions.length
      ? 'Na obrazovce je okno s doplňujícími otázkami. Řekni jednou větou, že než začneš, upřesníš pár věcí. Nic dalšího nedělej — pán odpoví v okně.'
      : 'Na obrazovce je okno s potvrzením zadání. Řekni jednou větou, že jde o vylepšení aplikace a ať zkontroluje zadání. Nic dalšího nedělej.',
  };
}

/** The popup's "Zrušit vylepšení" — before anything started. */
export function cancel() {
  need(['confirm', 'questions']);
  log(`request "${job.title}" cancelled`);
  job = null;
  emit();
}

/** The popup's "Spustit návrh". `answers`: per question, the chosen option indexes. */
export function start({ answers, note } = {}) {
  need(['confirm', 'questions']);
  const qs = job.questions;
  const picked = qs.map((q, i) => {
    const a = Array.isArray(answers?.[i]) ? answers[i].filter((k) => Number.isInteger(k) && k >= 0 && k < q.options.length) : [];
    return a.length ? (q.multi ? [...new Set(a)] : [a[0]]) : q.def;
  });
  job.answers = picked;
  job.note = String(note || '').slice(0, 2000);
  job.hist = [{ who: 'Jan · zadání', text: job.request }];
  if (job.note) job.hist.push({ who: 'Jan · doplnění', text: job.note });
  job.stage = 'drafting';
  job.steps = ['Větev vytvořena', 'Prozkoumávám kód', 'Navrhuji změnu', 'Commit a náhled'];
  job.cur = 0;
  emit();
  background(draft);
}

/* ---- drafting ------------------------------------------------------------------ */

async function draft(token) {
  const dir = workDir();
  await createWorktree(dir);
  if (!alive(token)) return;
  set({ cur: 1 });
  const summary = await runAgent(token, draftPrompt(), {
    fixedHead: ['Větev vytvořena'], fixedTail: ['Commit a náhled'],
  });
  if (!alive(token)) return;
  set({ cur: job.steps.length - 1 });
  if (!(await git(['status', '--porcelain'], dir))) throw new Error('agent nic nezměnil');
  const sha = await commit(dir, `${job.title} — návrh (revize 1)`);
  job.revs = [{ n: 1, sha, summary }];
  job.viewRev = 1;
  job.summary = summary;
  job.hist.push({ who: 'Kacey · revize 1', text: summary });
  await startPreview();
  if (!alive(token)) return;
  set({ stage: 'review', steps: [], cur: 0 });
  log(`draft of "${job.title}" ready for review`);
}

/** "Upravit promptem" → "Vytvořit revizi N". */
export function refine({ text } = {}) {
  need(['review']);
  const ask = String(text || '').trim().slice(0, 4000);
  if (!ask) throw httpError(400, 'Napiš, co se má na návrhu změnit.');
  job.hist.push({ who: 'Jan · připomínka', text: ask });
  job.stage = 'refining';
  job.error = null;
  job.steps = ['Čtu připomínku', 'Upravuji návrh', 'Commit revize'];
  job.cur = 0;
  emit();
  background(async (token) => {
    await checkoutRev(job.revs.length);   // a refinement builds on the newest revision
    const n = job.revs.length + 1;
    set({ cur: 1 });
    const summary = await runAgent(token, refinePrompt(ask, n), { fixedHead: ['Čtu připomínku'], fixedTail: ['Commit revize'] });
    if (!alive(token)) return;
    set({ cur: job.steps.length - 1 });
    const sha = await commit(workDir(), `${job.title} — revize ${n}`);
    job.revs.push({ n, sha, summary });
    job.viewRev = n;
    job.summary = summary;
    job.hist.push({ who: `Kacey · revize ${n}`, text: summary });
    await startPreview();
    if (!alive(token)) return;
    set({ stage: 'review', steps: [], cur: 0 });
  }, 'review');
}

/** "Obnovit předchozí revizi": the newest revision is dropped. */
export async function restorePrev() {
  need(['review']);
  if (job.revs.length < 2) throw httpError(409, 'Není žádná předchozí revize.');
  const prev = job.revs[job.revs.length - 2];
  await git(['checkout', job.branch], workDir());
  await git(['reset', '--hard', prev.sha], workDir());
  job.revs.pop();
  // The last note and Kacey's answer to it.
  job.hist = job.hist.slice(0, -2);
  job.viewRev = prev.n;
  job.summary = prev.summary;
  emit();
  await startPreview();
  emit();
}

/** The revision tabs: show an older revision in the preview. */
export async function viewRev(n) {
  need(['review']);
  if (!job.revs.some((r) => r.n === n)) throw httpError(400, 'Taková revize není.');
  if (n === job.viewRev) return;
  await checkoutRev(n);
  job.viewRev = n;
  emit();
  await startPreview();
  emit();
}

async function checkoutRev(n) {
  const dir = workDir();
  const rev = job.revs.find((r) => r.n === n);
  if (!rev) return;
  if (n === job.revs.length) await git(['checkout', job.branch], dir);
  else await git(['checkout', '--detach', rev.sha], dir);
}

/* ---- approving: finishing for production ----------------------------------------- */

export function approve() {
  need(['review']);
  const n = job.viewRev || job.revs.length;
  job.stage = 'finalizing';
  job.approvedAt = new Date().toISOString();
  job.error = null;
  job.steps = ['Data a ukládání', 'Telefon a hlasové příkazy', 'Dokumentace', 'Testy a sestavení'];
  job.cur = 0;
  job.hist.push({ who: 'Jan · schváleno', text: `Revize ${n}` });
  emit();
  background(async (token) => {
    const dir = workDir();
    // The approved revision is what gets finished: newer ones are dropped.
    const rev = job.revs.find((r) => r.n === n);
    await git(['checkout', '-B', job.branch, rev.sha], dir);
    job.revs = job.revs.filter((r) => r.n <= n);
    await runAgent(token, finalizePrompt(), { fixedHead: [], fixedTail: ['Testy a sestavení'] });
    if (!alive(token)) return;
    set({ cur: job.steps.length - 1 });
    bumpVersion(dir, job.versionTo);
    let tests = await runTests(dir);
    if (!tests.ok && alive(token)) {
      log('tests failed after finishing — one more pass to fix them');
      await runAgent(token, fixTestsPrompt(tests.output), { fixedHead: [], fixedTail: ['Testy a sestavení'] });
      if (!alive(token)) return;
      tests = await runTests(dir);
    }
    if (!alive(token)) return;
    if (!tests.ok) {
      // Back to the comparison: the owner decides (another prompt, or discard).
      await commit(dir, `${job.title} — dokončení (testy neprošly)`);
      job.stage = 'review';
      job.error = 'Testy po dokončení neprošly. Uprav návrh promptem, nebo ho zahoď.';
      job.steps = []; job.cur = 0;
      emit();
      log(`tests still failing:\n${tests.output.slice(-2000)}`);
      return;
    }
    await commit(dir, `${job.title} — KC ${job.versionTo}`);
    await startPreview();
    if (!alive(token)) return;
    set({ stage: 'ready', steps: [], cur: 0, restart: restartPlan() });
    log(`"${job.title}" is ready as KC ${job.versionTo}`);
  }, 'review');
}

/* ---- discarding ------------------------------------------------------------------- */

/** "Zamítnout" / "Zastavit a zahodit". keep = the branch stays (archived), only the folder goes. */
export async function discard({ keep = false } = {}) {
  if (!job) return;
  if (['confirm', 'questions'].includes(job.stage)) return cancel();
  if (job.stage === 'switching') throw httpError(409, 'Právě se přepíná na novou verzi.');
  const { branch, title, slug } = job;
  stopRun();
  stopPreview();
  job = null;
  emit();
  await removeWorktree(slug).catch((err) => log(`worktree not removed: ${err.message}`));
  if (!keep) await git(['branch', '-D', branch]).catch(() => {});
  log(`"${title}" discarded (${keep ? 'branch kept' : 'branch deleted'})`);
}

/* ---- switching ---------------------------------------------------------------------- */

/** "Přepnout teď": merge the branch into the running checkout and restart. */
export async function switchNow() {
  need(['ready']);
  const plan = restartPlan();
  job.stage = 'switching';
  job.restart = plan;
  emit();
  try {
    const dirty = await git(['status', '--porcelain', '--untracked-files=no']);
    if (dirty) throw new Error('V běžící kopii Kacey jsou neuložené změny — přepnutí by je přepsalo.');
    stopPreview();
    await git(['checkout', job.branch], workDir()).catch(() => {});
    try {
      await git(['merge', '--ff-only', job.branch]);
    } catch {
      try {
        await git(['merge', '--no-edit', job.branch]);
      } catch (err) {
        await git(['merge', '--abort']).catch(() => {});
        throw new Error(`Větev se nedá sloučit bez konfliktu (${err.message}).`);
      }
    }
  } catch (err) {
    job.stage = 'ready';
    job.error = err.message;
    emit();
    throw httpError(409, err.message);
  }
  const done = { title: job.title, short: job.short, view: job.view, version: job.versionTo, at: new Date().toISOString() };
  kvSet(KV_LAST, done);
  await removeWorktree(job.slug).catch(() => {});
  await git(['branch', '-d', job.branch]).catch(() => {});
  log(`merged ${job.branch} — KC ${job.versionTo}; restart: ${plan}`);
  job = null;
  save();
  broadcast({ type: 'upgrade', ...snapshot(), switching: { version: done.version, restart: plan } });
  // Give the frame a moment to leave before the process goes.
  setTimeout(() => restart(plan), 400);
  return { restart: plan };
}

function restartPlan() {
  if (UPGRADE_RESTART_CMD) return 'cmd';
  if (process.env.INVOCATION_ID) {
    try {
      const policy = execFileSync('systemctl', ['show', SERVICE_UNIT, '-p', 'Restart', '--value'], { timeout: 3000 }).toString().trim();
      if (policy === 'always' || policy === 'on-failure') return 'exit';
    } catch { /* not readable: fall through */ }
  }
  return 'manual';
}

function restart(plan) {
  if (plan === 'cmd') {
    log(`restarting with: ${UPGRADE_RESTART_CMD}`);
    spawn(UPGRADE_RESTART_CMD, { shell: true, detached: true, stdio: 'ignore' }).unref();
  } else if (plan === 'exit') {
    log('exiting so systemd starts the new version');
    shutdown(1);
  } else {
    log(`merged — restart Kacey by hand to run KC ${kvGet(KV_LAST, {}).version}`);
  }
}

/* ---- the coding agent ----------------------------------------------------------------- */

const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
/* Shell commands the agent may run without asking: checks and tests. Anything
   else (installs, git history, network) is refused by canUseTool below. */
const SAFE_BASH = [
  'Bash(node --check:*)', 'Bash(node test/:*)', 'Bash(npm test:*)', 'Bash(npm run test:*)',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(ls:*)',
];

const AGENT_RULES = `
You are working on Kacey, the owner's voice-first personal assistant: a Node server (server.js and
siblings) and a vanilla-JS frontend with no build step (public/). The repo's CLAUDE.md, DESIGN.md and
ARCHITECTURE.md are the rules: read DESIGN.md before any UI change and use its tokens and components.
You work in a git worktree on its own branch; the running app is untouched until the owner switches.

Hard rules:
- Touch only files inside the current folder. No new npm dependencies, no build step.
- Never run git commands that change history (commit, checkout, reset, merge, branch) — the host commits.
- All user-facing copy is Czech, in the app's voice.
- Report progress with the mcp__kacey-upgrade__progress tool: first call it with your plan as 2–4 short
  Czech step labels (e.g. "Navrhuji obrazovku Úkoly"), then advance \`current\` (0-based) as you go.
- End with ONE short Czech sentence (max 140 characters) saying what you changed, for the owner —
  e.g. "Přepínač Skupina / Termín, skupiny Práce · Zdraví · Domácnost · Osobní." No markdown.`;

function scopeText() {
  const j = job;
  const answers = j.questions.map((q, i) => `- ${q.title} → ${(j.answers?.[i] || q.def).map((k) => q.options[k]).join(', ')}`);
  return [
    `The owner asked (Czech): "${j.request}"`,
    `Feature: ${j.title}`,
    `What to build:\n${j.bullets.map((b) => `- ${b}`).join('\n')}`,
    `Area: ${j.area}. Platforms: ${j.platforms.join(', ')}. The change shows on the route #${j.view}.`,
    answers.length ? `Agreed details:\n${answers.join('\n')}` : '',
    j.note ? `The owner added: "${j.note}"` : '',
  ].filter(Boolean).join('\n\n');
}

function draftPrompt() {
  return `${scopeText()}

This is the DRAFT. The owner will judge it in a live, clickable preview shown side by side with the
current app — the point is to agree on what it looks like and how it behaves. Prioritise what they will
SEE: the screens, layout, copy and states, on desktop and on the phone layout (≤760px) where the
platforms include it. Wire it to existing data where that is cheap; stubs or sample data are fine where
the real backend would take long. Do not write tests or docs yet.`;
}

function refinePrompt(ask, n) {
  return `${scopeText()}

The owner reviewed the draft on this branch and asks for changes (this becomes revision ${n}):
"${ask}"

Change the draft accordingly. Keep everything they did not mention as it is. It is still a draft:
what they see matters most.`;
}

function finalizePrompt() {
  return `${scopeText()}

The owner APPROVED the draft on this branch (read \`git diff master...HEAD\` or the changed files first).
Now finish it for production, end to end:
- real data and persistence instead of any stubs (server routes, db.js conventions for tables),
- the phone layout (≤760px) and Kacey's own tools or persona where voice should reach the feature,
- empty, error and offline states,
- tests in test/ in the style of the existing ones (add new files to package.json's test scripts),
- DESIGN.md (tokens, components, screens, a changelog line tagged [design: pending]) and CHANGELOG.md
  under KC ${job.versionTo} (do not change package.json's version — the host does),
- run \`npm test\` and fix what fails.`;
}

function fixTestsPrompt(output) {
  return `${scopeText()}

The feature on this branch is finished, but \`npm test\` fails. Fix the cause (not the tests, unless a
test is wrong about the new behaviour). The end of the output:

${output.slice(-6000)}`;
}

/**
 * One agent run in the branch's folder. Resolves to its closing sentence.
 * `fixedHead` / `fixedTail` are the host's own steps around the agent's plan.
 */
async function runAgent(token, prompt, { fixedHead = [], fixedTail = [] } = {}) {
  const dir = workDir();
  const report = (steps, current) => {
    if (!alive(token)) return;
    const plan = steps || job.steps.slice(fixedHead.length, job.steps.length - fixedTail.length);
    set({ steps: [...fixedHead, ...plan, ...fixedTail], cur: fixedHead.length + Math.min(current, plan.length - 1) });
  };
  if (testAgent) return testAgent({ prompt, dir, report });
  const abort = new AbortController();
  run = { token, abort };

  const progress = tool(
    'progress',
    'Report progress to the owner. First call: `steps` = your plan as 2–4 short Czech labels. Then call with `current` (0-based) each time you move to the next step.',
    { steps: z.array(z.string().min(1).max(60)).min(1).max(5).optional(), current: z.number().int().min(0).max(4) },
    async ({ steps, current }) => {
      report(steps, current);
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  );

  const inside = (p) => {
    const rel = path.relative(dir, path.resolve(dir, String(p || '.')));
    return !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep).includes('.git');
  };

  const q = query({
    prompt,
    options: {
      model: UPGRADE_MODEL,
      effort: UPGRADE_EFFORT,
      cwd: dir,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: AGENT_RULES },
      settingSources: ['project'],
      tools: [...READ_TOOLS, ...WRITE_TOOLS.slice(0, 2), 'Bash'],
      mcpServers: { 'kacey-upgrade': createSdkMcpServer({ name: 'kacey-upgrade', version: '1.0.0', tools: [progress] }) },
      strictMcpConfig: true,
      allowedTools: ['mcp__kacey-upgrade__progress', ...SAFE_BASH],
      permissionMode: 'default',
      /* Everything not pre-allowed comes here: reads and writes are fine inside
         the branch's folder and nowhere else; every other shell command is refused. */
      canUseTool: async (name, input) => {
        if (READ_TOOLS.includes(name)) {
          const p = input.file_path || input.path;
          return inside(p) || !p ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Jen soubory v této složce.' };
        }
        if (WRITE_TOOLS.includes(name)) {
          const p = input.file_path || input.notebook_path;
          const rel = path.relative(dir, path.resolve(dir, String(p || '')));
          if (p && inside(p) && !rel.split(path.sep).includes('node_modules')) return { behavior: 'allow', updatedInput: input };
          return { behavior: 'deny', message: 'Zapisovat jde jen do souborů téhle větve (ne node_modules, ne .git).' };
        }
        return { behavior: 'deny', message: `${name} tu není povolený. Povolené příkazy: ${SAFE_BASH.join(', ')}.` };
      },
      maxTurns: 150,
      abortController: abort,
      stderr: (d) => { const line = String(d).trim(); if (line) log('agent stderr:', line.slice(0, 300)); },
    },
  });

  try {
    let lastError = '';
    for await (const msg of q) {
      if (!alive(token)) break;
      if (msg.type === 'assistant') {
        if (msg.error) lastError = msg.error;
        for (const b of msg.message?.content || []) {
          if (b.type === 'tool_use' && b.name !== 'mcp__kacey-upgrade__progress') {
            log(`agent ${b.name} ${String(b.input?.file_path || b.input?.command || b.input?.pattern || '').slice(0, 120)}`);
          }
        }
      }
      if (msg.type === 'result') {
        if (msg.subtype === 'success') return lastLine(msg.result) || 'Hotovo.';
        throw new Error(lastError || (msg.errors || []).join('; ') || msg.subtype);
      }
    }
    if (!alive(token)) return '';
    throw new Error(lastError || 'agent skončil bez výsledku');
  } finally {
    // The step goes on (commit, preview) under the same token; only the abort is spent.
    if (run?.token === token) run = { token, abort: null };
    try { q.close?.(); } catch { /* gone */ }
  }
}

function lastLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).filter(Boolean);
  return (lines[lines.length - 1] || '').slice(0, 200);
}

/* A background step. `fallback`: the stage to go back to when it fails
   (none = the job fails). The token makes a discarded job's run harmless. */
function background(fn, fallback = null) {
  const token = `${job.id}:${Date.now()}`;
  run = { token, abort: null };
  fn(token).catch((err) => {
    if (!alive(token)) return;
    log(`step failed: ${err.message}`);
    if (fallback && job.revs.length) {
      set({ stage: fallback, error: `Nepovedlo se: ${humanError(err)}`, steps: [], cur: 0 });
      if (fallback === 'review') startPreview().then(emit, () => {});
    } else {
      set({ stage: 'failed', error: `Nepovedlo se: ${humanError(err)}` });
    }
  });
}

function alive(token) { return !!job && run?.token === token && token.startsWith(`${job.id}:`); }

function stopRun() {
  try { run?.abort?.abort(); } catch { /* gone */ }
  run = null;
}

function humanError(err) {
  const t = String(err?.message || err);
  if (/rate.?limit|429/i.test(t)) return 'došel limit Claude.';
  if (/ECONN|ENOTFOUND|fetch failed|network/i.test(t)) return 'server se nedostal ke Claude.';
  if (/nothing to commit|žádnou změnu/i.test(t)) return 'agent nic nezměnil.';
  return t.slice(0, 200);
}

/* ---- git ------------------------------------------------------------------------- */

function git(args, cwd = UPGRADE_REPO, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'user.name=Kacey', '-c', 'user.email=kacey@localhost', ...args],
      { cwd, timeout, maxBuffer: 16 << 20, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]}: ${String(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`));
        else resolve(String(stdout).trim());
      });
  });
}

function workDir() { return path.join(UPGRADE_DIR, job.slug); }

async function createWorktree(dir) {
  mkdirSync(UPGRADE_DIR, { recursive: true });
  if (existsSync(dir)) {
    await git(['worktree', 'remove', '--force', dir]).catch(() => rmSync(dir, { recursive: true, force: true }));
    await git(['worktree', 'prune']).catch(() => {});
  }
  // A name taken by an archived attempt gets a suffix.
  let branch = job.branch;
  for (let i = 2; await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false); i++) {
    branch = `${BRANCH_PREFIX}${job.slug}-${i}`;
  }
  job.branch = branch;
  await git(['worktree', 'add', '-b', branch, dir, 'HEAD']);
  // The worktree has no node_modules; the preview and the tests need them.
  const nm = path.join(dir, 'node_modules');
  if (!existsSync(nm) && existsSync(path.join(UPGRADE_REPO, 'node_modules'))) {
    symlinkSync(path.join(UPGRADE_REPO, 'node_modules'), nm, process.platform === 'win32' ? 'junction' : 'dir');
    // .gitignore's "node_modules/" matches a folder, not a link to one: keep it out of the commits.
    const common = path.resolve(dir, await git(['rev-parse', '--git-common-dir'], dir));
    const exclude = path.join(common, 'info', 'exclude');
    const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!/^\/node_modules$/m.test(text)) {
      mkdirSync(path.dirname(exclude), { recursive: true });
      const sep = text && !text.endsWith('\n') ? '\n' : '';
      writeFileSync(exclude, `${text}${sep}/node_modules\n`);
    }
  }
  emit();
}

async function removeWorktree(slug) {
  const dir = path.join(UPGRADE_DIR, slug);
  if (slug && existsSync(dir)) await git(['worktree', 'remove', '--force', dir]);
  await git(['worktree', 'prune']).catch(() => {});
}

async function commit(dir, message) {
  await git(['add', '-A'], dir);
  const staged = await git(['diff', '--cached', '--name-only'], dir);
  if (!staged) {
    // Nothing new (a revision that only re-checked things) still gets a revision.
    await git(['commit', '--allow-empty', '-m', message], dir);
  } else {
    await git(['commit', '-m', message], dir);
  }
  return git(['rev-parse', 'HEAD'], dir);
}

/* Every change to the app is one step of the last number: KC 1.0.1 → 1.0.2
   (CHANGELOG.md). Major and minor move only by hand. */
function bumpPatch(v) {
  const [a, b, c] = String(v).split('.').map((n) => Number(n) || 0);
  return `${a}.${b}.${c + 1}`;
}

function bumpVersion(dir, to) {
  const file = path.join(dir, 'package.json');
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text.replace(/"version":\s*"[^"]*"/, `"version": "${to}"`));
}

function runTests(dir) {
  return new Promise((resolve) => {
    const child = spawn('npm test', {
      cwd: dir, shell: true, windowsHide: true,
      env: { ...process.env, KACEY_WEATHER: 'off' },
    });
    let output = '';
    const keep = (d) => { output = (output + d).slice(-20000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill(), 10 * 60000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, output: err.message }); });
  });
}

/* ---- the preview -------------------------------------------------------------------- */

/* The branch runs as a second Kacey on PREVIEW_PORT, so the comparison shows
   the whole app live. Its database is a copy taken once per job, its calendar
   runs in memory (no Google writes), and KACEY_PREVIEW=1 keeps it away from
   the night, the screen, the lights and the music. */
async function startPreview() {
  stopPreview();
  if (!job || testAgent) return;
  const dir = workDir();
  mkdirSync(PREVIEW_STATE, { recursive: true });
  const db = path.join(PREVIEW_STATE, `${job.id}.db`);
  if (!existsSync(db) && existsSync(KLAUS_DB)) {
    try {
      const src = new DatabaseSync(KLAUS_DB, { readOnly: true });
      src.exec(`VACUUM INTO '${db.replace(/'/g, "''")}'`);
      src.close();
    } catch (err) { log(`database not copied for the preview (${err.message}) — it starts empty`); }
  }
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(PREVIEW_PORT), KACEY_PREVIEW: '1', KLAUS_DB: db,
      KLAUS_CALENDARS: path.join(PREVIEW_STATE, 'no-calendars.json'),
      KLAUS_ENV_FILE: path.join(PREVIEW_STATE, 'no.env'),
      KACEY_BRIEF_AUDIO_DIR: path.join(PREVIEW_STATE, 'brief-audio'),
      KACEY_WEATHER: 'off', KACEY_MONITOR_HOST: '',
    },
  });
  preview = { child, ready: false };
  const tag = (d) => String(d).trim().split('\n').forEach((l) => l && log(`preview: ${l.slice(0, 200)}`));
  child.stdout.on('data', tag);
  child.stderr.on('data', tag);
  child.on('exit', (code) => {
    if (preview?.child === child) { preview = null; log(`preview exited (${code})`); if (job) emit(); }
  });
  for (let i = 0; i < 60 && preview?.child === child; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PREVIEW_PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) { preview.ready = true; break; }
    } catch { /* not yet */ }
    await new Promise((res) => setTimeout(res, 500));
  }
  if (!preview?.ready) log('preview did not answer in 30 s');
}

function stopPreview() {
  if (!preview) return;
  const { child } = preview;
  preview = null;
  try { child.kill(); } catch { /* gone */ }
}

/* ---- the preview, through Kacey ------------------------------------------------------------
   The comparison loads the preview at /preview/ on Kacey's own origin, not on
   its port: behind an https front (tailscale serve) a frame on http://host:8092
   is refused, and a phone may not reach that port at all. Every request under
   /preview/ is passed to the preview process, and its page gets a <base> and a
   small shim so the absolute URLs its code uses (/api/…, the /ws socket) stay
   under /preview/ too. The shim is Kacey's, not the branch's, so it works for
   whatever the branch has changed. */

const PREFIX = '/preview';

const SHIM = `<base href="${PREFIX}/"><script>(function(){
var P=${JSON.stringify(PREFIX)};
function fix(u){try{var x=new URL(String(u),location.href);
if(x.host===location.host&&x.pathname.indexOf(P+'/')!==0){x.pathname=P+x.pathname;return x.href;}}catch(e){}return u;}
var F=window.fetch;window.fetch=function(i,o){
if(typeof i==='string'||i instanceof URL)i=fix(i);else if(i&&i.url)i=new Request(fix(i.url),i);return F.call(this,i,o);};
var W=window.WebSocket;function S(u,p){return p===undefined?new W(fix(u)):new W(fix(u),p);}
S.prototype=W.prototype;['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(k){S[k]=W[k];});window.WebSocket=S;
var E=window.EventSource;if(E){var ES=function(u,o){return new E(fix(u),o);};ES.prototype=E.prototype;window.EventSource=ES;}
var X=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=fix(u);return X.apply(this,arguments);};
if(navigator.serviceWorker)navigator.serviceWorker.register=function(){return Promise.reject(new Error('preview'));};
})();</script>`;

const WAITING = '<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="dark">' +
  '<body style="margin:0;display:grid;place-items:center;height:100vh;background:#161616;color:#9a9a9a;font:14px Consolas,monospace">' +
  'Náhled ještě neběží.</body>';

/** Express middleware, mounted at /preview. */
export function previewHttp(req, res) {
  const headers = { ...req.headers, host: `127.0.0.1:${PREVIEW_PORT}`, 'accept-encoding': 'identity' };
  delete headers['if-none-match'];
  delete headers['if-modified-since'];
  const out = http.request({ host: '127.0.0.1', port: PREVIEW_PORT, method: req.method, path: req.url || '/', headers }, (pr) => {
    const type = String(pr.headers['content-type'] || '');
    if (!type.startsWith('text/html')) {
      res.writeHead(pr.statusCode || 502, pr.headers);
      pr.pipe(res);
      return;
    }
    const chunks = [];
    pr.on('data', (c) => chunks.push(c));
    pr.on('end', () => {
      let html = Buffer.concat(chunks).toString('utf8');
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + SHIM) : SHIM + html;
      const hdrs = { ...pr.headers, 'content-length': Buffer.byteLength(html), 'cache-control': 'no-store' };
      delete hdrs.etag;
      delete hdrs['transfer-encoding'];
      delete hdrs['last-modified'];
      res.writeHead(pr.statusCode || 200, hdrs);
      res.end(html);
    });
  });
  out.on('error', () => {
    if (res.headersSent) res.end();
    else res.status(503).type('html').send(WAITING);
  });
  req.pipe(out);
}

/** The socket of a framed preview (/preview/ws) → the preview's own /ws. */
export function previewUpgrade(req, socket, head) {
  const pathPart = (req.url || '').slice(PREFIX.length) || '/';
  const out = http.request({
    host: '127.0.0.1', port: PREVIEW_PORT, method: 'GET', path: pathPart,
    headers: { ...req.headers, host: `127.0.0.1:${PREVIEW_PORT}` },
  });
  out.on('upgrade', (pres, psock, phead) => {
    let lines = 'HTTP/1.1 101 Switching Protocols\r\n';
    for (let i = 0; i < pres.rawHeaders.length; i += 2) lines += `${pres.rawHeaders[i]}: ${pres.rawHeaders[i + 1]}\r\n`;
    socket.write(`${lines}\r\n`);
    if (phead?.length) socket.write(phead);
    if (head?.length) psock.write(head);
    psock.on('error', () => socket.destroy());
    socket.on('error', () => psock.destroy());
    psock.pipe(socket).pipe(psock);
  });
  out.on('response', () => socket.destroy());
  out.on('error', () => socket.destroy());
  out.end();
}

/* ---- helpers ------------------------------------------------------------------------- */

function need(stages) {
  if (!job) throw httpError(404, 'Žádné vylepšení teď neběží.');
  if (!stages.includes(job.stage)) throw httpError(409, `Teď to nejde (stav ${job.stage}).`);
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

export function slugify(text) {
  return String(text || 'funkce')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40).replace(/-+$/, '') || 'funkce';
}

/* ---- boot ------------------------------------------------------------------------------ */

/**
 * `deps.broadcast` sends a frame to every page; `deps.shutdown(code)` stops
 * Kacey cleanly (the switch uses it when systemd will start her again).
 */
export function initSelfUpdate(deps = {}) {
  broadcast = deps.broadcast || broadcast;
  shutdown = deps.shutdown || shutdown;
  job = kvGet(KV_JOB, null);
  if (!job) return;
  // A restart in the middle of a step: the step is lost, the branch is not.
  if (job.stage === 'drafting' || job.stage === 'failed') {
    job.stage = 'failed';
    job.error = job.error || 'Návrh přerušil restart Kacey.';
  } else if (['refining', 'finalizing', 'switching'].includes(job.stage)) {
    job.stage = job.revs.length ? 'review' : 'failed';
    job.error = 'Krok přerušil restart Kacey — návrh zůstal, jak byl.';
  }
  job.steps = []; job.cur = 0;
  save();
  if (['review', 'ready'].includes(job.stage) && existsSync(workDir())) {
    startPreview().then(emit, (err) => log(`preview not started: ${err.message}`));
  }
}

export function stopSelfUpdate() {
  stopRun();
  stopPreview();
}

/* For the tests: a stand-in agent ({ prompt, dir, report }) — and no preview. */
let testAgent = null;
export const _test = {
  setAgent(fn) { testAgent = fn; },
  restartPlan,
  git,
};
