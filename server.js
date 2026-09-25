/**
 * Kacey — backend.
 *
 * Browser (voice+text UI)  ->  this server  ->  Claude Agent SDK  ->  klaus_memory MCP
 *
 * One WebSocket connection == one continuous Claude session. The SDK is driven in
 * "streaming input" mode: a single query() call lives for the whole connection and
 * we push user turns into it through an async generator, so the assistant remembers
 * earlier turns without us replaying history.
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';

import * as appstate from './appstate.js';
import { makeAppServer, APP_SERVER_NAME, APP_TOOL_NAMES, setWriteListener } from './app-tools.js';
import {
  startNight, stopNight, noteInteraction, noteSpeaking, noteVisibility, nightState, INTERACTION_KINDS,
} from './night.js';

import {
  HERE, VERSION, PORT, HOST, MODEL, EFFORT, PERSONA_PATH, PUBLIC_DIR,
  PYTHON_BIN, KLAUS_MEMORY_PYTHONPATH, KLAUS_DB, KLAUS_CALENDARS, KLAUS_ENV_FILE,
  MCP_SERVERS, MEMORY_TOOLS, ALLOWED_TOOLS, DISALLOWED_TOOLS,
  FALLBACK_PERSONA, OWNER_PROFILE, TURN_CONTEXT,
  XTTS_URL, VOICES, DEFAULT_VOICE, TTS_DOTS,
  LOGICAL_DAY_START_HOUR,
} from './config.js';

// ---------------------------------------------------------------------------
// Persona
// ---------------------------------------------------------------------------

// The logical day ends at 04:00, so 01:30 still belongs to the previous date.
function logicalNow(now = new Date()) {
  const shifted = new Date(now.getTime() - LOGICAL_DAY_START_HOUR * 3600 * 1000);
  const today = `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`;
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return { today, time };
}

function renderPersona(template, now = new Date()) {
  const { today, time } = logicalNow(now);
  const filled = template
    .replace(/\{\{OWNER_PROFILE\}\}/g, OWNER_PROFILE)
    .replace(/\{\{TODAY\}\}/g, today)
    .replace(/\{\{NOW\}\}/g, time)
    .replace(/\{\{TURN_CONTEXT\}\}/g, TURN_CONTEXT);

  // Fail loudly rather than shipping "{{FOO}}" to the model as instructions.
  const leftover = filled.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) {
    console.warn(
      `[kacey] WARNING: unsubstituted persona placeholders: ${[...new Set(leftover)].join(', ')}. ` +
        `Add them to renderPersona() in server.js or remove them from the persona file.`,
    );
  }
  return filled;
}

function loadPersona() {
  try {
    const text = readFileSync(PERSONA_PATH, 'utf8').trim();
    if (!text) throw new Error('persona file is empty');
    log(`persona loaded from ${PERSONA_PATH} (${text.length} chars)`);
    return text;
  } catch (err) {
    console.warn(
      `[kacey] WARNING: could not load persona from ${PERSONA_PATH} (${err.message}). ` +
        `Using the built-in default. Set KACEY_PERSONA_PATH to point at your own file.`,
    );
    return FALLBACK_PERSONA;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const log = (...a) => console.log('[kacey]', ...a);

/** Strip the mcp__server__ prefix so the UI shows "memory_search". */
const shortToolName = (name) =>
  name?.startsWith('mcp__') ? name.split('__').slice(2).join('__') || name : name;

/* What the user is told when a turn dies for a reason explainError() below does
   not recognise. The SDK's own wording is English diagnostics
   ("[ede_diagnostic] result_type=user stop_reason=tool_use") that means nothing
   to the person in the room, so it is never passed through; it goes to the log. */
const ERR_TURN = 'Něco se nepovedlo. Zkus to prosím znovu.';

/* Not a failure but a real loss of capability, so it is worth saying out loud —
   she will answer, just without knowing anything about you. */
const ERR_NO_MEMORY = 'Teď nemám přístup k paměti ani ke kalendáři.';

const AUTH_HINT =
  'Kacey není přihlášená ke Claude. Na serveru spusť `claude`, přihlas se a restartuj Kacey ' +
  '(nebo nastav ANTHROPIC_API_KEY).';

function isAuthError(err) {
  return err === 'authentication_failed' || err === 'oauth_org_not_allowed';
}

/* The text of an assistant error message — the SDK puts the real reason there
   ("API Error: 400 Claude Code 2.1.220 does not support this model; …") while
   `error` is often just 'unknown'. */
function errorText(msg) {
  return (msg.message?.content || [])
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join(' ').trim();
}

/**
 * What to tell the person when a turn fails, from the SDK's error code and
 * text. Shown as an alert, never spoken (protocol.js cancels speech on
 * `error`), so it can name the cause and what to do about it. Anything not
 * recognised stays the plain sentence, plus a pointer to the log, which always
 * gets the full detail.
 */
function explainError(code, text = '') {
  const t = String(text);
  if (isAuthError(code) || /not authenticated|invalid.*(api key|token)|API Error: 401/i.test(t)) return AUTH_HINT;
  if (/does not support this model|or newer is required/i.test(t)) {
    const need = /version ([\d.]+) or newer/i.exec(t);
    return `Model ${MODEL} potřebuje novější Claude Agent SDK${need ? ` (Claude Code ${need[1]}+)` : ''}. ` +
      'Na serveru spusť `npm install` a restartuj Kacey, nebo nastav KACEY_MODEL na starší model.';
  }
  if (code === 'model_not_found' || /model.{0,40}(not found|not_found|does not exist)/i.test(t)) {
    return `Model „${MODEL}“ API nezná. Zkontroluj KACEY_MODEL v nastavení serveru.`;
  }
  if (code === 'rate_limit' || /rate.?limit|usage limit|\b429\b/i.test(t)) {
    return 'Došel limit používání Claude. Zkus to za chvíli znovu.';
  }
  if (code === 'overloaded' || /overloaded|\b529\b/i.test(t)) {
    return 'Claude je teď přetížený. Zkus to za chvíli znovu.';
  }
  if (code === 'billing_error' || code === 'account_on_hold') {
    return 'Účet Claude, na kterém Kacey běží, je pozastavený nebo nemá zaplaceno. Zkontroluj ho na claude.ai.';
  }
  if (code === 'server_error' || /API Error: 5\d\d/.test(t)) {
    return 'Claude má výpadek na své straně. Zkus to za chvíli znovu.';
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network/i.test(t)) {
    return 'Kacey se nedostane ke Claude. Zkontroluj připojení serveru k internetu.';
  }
  if (code === 'max_output_tokens') return 'Odpověď byla moc dlouhá a uřízla se. Zkus otázku zúžit.';
  return ERR_TURN + ' Podrobnosti jsou v logu serveru.';
}

// ---------------------------------------------------------------------------
// One WebSocket connection == one Kacey session
// ---------------------------------------------------------------------------

class KaceySession {
  constructor(ws, persona) {
    this.ws = ws;
    // Rendered per connection so {{TODAY}}/{{NOW}} are current. A session that
    // stays open across the 04:00 rollover keeps its original date — reload the
    // page to get a fresh one.
    this.persona = renderPersona(persona);
    this.sessionId = null;

    // Streaming-input plumbing: user turns are queued here and handed to the SDK
    // by the async generator below.
    this.pending = [];
    this.wake = null;
    this.closed = false;

    // Maps tool_use_id -> short tool name, so we can pair a tool_result back to
    // the tool that produced it and emit { phase: 'end' }.
    this.toolNames = new Map();

    // True once we have seen at least one text_delta. From then on we trust the
    // delta stream for assistant text and ignore the completed assistant text
    // blocks (which would otherwise duplicate everything the UI already spoke).
    this.sawTextDelta = false;

    this.turnActive = false;

    // Set when the user cancels a turn ("ticho", or the stop button), so the
    // `result` that follows is not reported to them as a failure.
    this.interrupted = false;
  }

  send(frame) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(frame));
  }

  /**
   * Queue a user turn for the live SDK session.
   *
   * `images` are base64 blocks from the composer's attachments. A turn with
   * images sends an array of content blocks instead of a plain string — the
   * text still carries the nudge below, because it has to be the LAST thing
   * the model reads and blocks are read in order.
   */
  pushUserMessage(text, images) {
    // Two rules keep slipping despite being in the persona, because the system
    // prompt sits far back in context while the model's tool-use reflex fires
    // right here: it opens with an English "I'll check your calendar." and it
    // refers to itself in masculine. Restating them on the turn itself puts
    // them in the most recent context, where they actually hold.
    // Kept short so it cannot crowd out what the user actually said.
    const nudge =
      '\n\n[systémová poznámka: veškerý text česky — včetně úvodní věty před ' +
      'použitím nástroje. O sobě mluv v ženském rodě (ráda, podívala jsem se). ' +
      'Anglicky jen tehdy, když uživatel píše anglicky.]';

    const list = Array.isArray(images) ? images : [];
    const content = list.length
      ? [
          ...list.map((img) => ({
            type: 'image',
            source: { type: 'base64', media_type: img.media_type, data: img.data },
          })),
          { type: 'text', text: text + nudge },
        ]
      : text + nudge;

    this.pending.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? undefined,
    });
    if (this.wake) {
      const w = this.wake;
      this.wake = null;
      w();
    }
  }

  async *userMessageStream() {
    while (!this.closed) {
      if (this.pending.length === 0) {
        await new Promise((resolve) => {
          this.wake = resolve;
        });
        continue;
      }
      yield this.pending.shift();
    }
  }

  start() {
    this.query = query({
      prompt: this.userMessageStream(),
      options: {
        model: MODEL,
        effort: EFFORT,

        // The persona replaces the Claude Code system prompt entirely — we do not
        // want coding-agent instructions in a voice assistant.
        systemPrompt: this.persona,

        // SDK isolation: do not load settings.json / CLAUDE.md from disk. Kacey's
        // behaviour comes from persona/kacey.md alone.
        settingSources: [],

        /* klaus-memory (a subprocess) plus Kacey's own app tools, which run in
           THIS process — see app-tools.js. One server object per session so a
           restart cannot leave a stale instance behind. */
        mcpServers: { ...MCP_SERVERS, [APP_SERVER_NAME]: makeAppServer() },

        // Use ONLY the server above. Without this, the SDK also auto-fetches the
        // account's claude.ai cloud connectors — Gmail, Google Calendar, Slack,
        // Notion and a dozen more turned up in Kacey's session. settingSources: []
        // does not stop them (they are not a settings source), and 15 servers
        // racing at startup is also what made klaus-memory time out.
        strictMcpConfig: true,

        // No built-in tools whatsoever; only the allow-listed MCP tools.
        tools: [],
        // Filtered through the controller's switches, so denying a tool there
        // actually removes it from the session rather than only dimming a chip.
        allowedTools: [...ALLOWED_TOOLS, ...APP_TOOL_NAMES].filter((t) => appstate.toolAllowed(t)),
        disallowedTools: DISALLOWED_TOOLS,

        // Never prompt for permission (there is no terminal and no human to ask);
        // anything not pre-approved above is denied outright. This is what keeps a
        // voice turn from hanging forever on an invisible confirmation prompt.
        permissionMode: 'dontAsk',

        // Needed for the `delta` frames the frontend speaks as it arrives.
        includePartialMessages: true,

        stderr: (data) => {
          // klaus_memory writes warnings to stderr (e.g. no OPENROUTER_API_KEY).
          // That is normal — log it, never treat it as failure.
          const line = data.toString().trim();
          if (line) log('cli/mcp stderr:', line.slice(0, 500));
        },
      },
    });

    this.pump();
  }

  async pump() {
    try {
      for await (const msg of this.query) {
        this.handle(msg);
      }
    } catch (err) {
      if (this.closed) return;
      log('session error:', err?.message || err);
      this.send({ type: 'error', message: explainError(null, err?.message) });
      this.send({ type: 'done' });
      this.turnActive = false;
    }
  }

  handle(msg) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          this.send({ type: 'session', sessionId: msg.session_id });

          const servers = msg.mcp_servers || [];
          log(
            `session ${msg.session_id} ready | model=${msg.model} | ` +
              `mcp=${servers.map((s) => `${s.name}:${s.status}`).join(', ') || 'none'} | ` +
              `tools=${(msg.tools || []).length}`,
          );
          for (const s of servers) {
            if (s.status !== 'connected') {
              log(`WARNING: memory server "${s.name}" is ${s.status} — no memory this session.`);
              this.send({ type: 'error', message: ERR_NO_MEMORY });
            }
          }
        }
        return;

      // Streamed assistant text -> `delta`. TEXT ONLY: we deliberately ignore
      // thinking_delta and input_json_delta so no reasoning or tool-call JSON is
      // ever spoken aloud.
      case 'stream_event': {
        const ev = msg.event;
        if (
          msg.parent_tool_use_id == null &&
          ev?.type === 'content_block_delta' &&
          ev.delta?.type === 'text_delta' &&
          ev.delta.text
        ) {
          this.sawTextDelta = true;
          this.send({ type: 'delta', text: ev.delta.text });
        }
        return;
      }

      case 'assistant': {
        // Auth (and other hard model errors) arrive as an assistant message whose
        // text is the error string. Surface it as `error` — never as `delta`, or
        // the browser would read "Failed to authenticate..." out loud.
        if (msg.error) {
          // The code is often just 'unknown'; the reason is in the text. Both
          // go to the log, and explainError() turns them into something the
          // person can act on.
          const text = errorText(msg);
          log(`assistant error: ${msg.error}${text ? ` — ${text}` : ''}`);
          this.errorShown = true;
          this.send({ type: 'error', message: explainError(msg.error, text) });
          return;
        }

        for (const block of msg.message?.content ?? []) {
          if (block.type === 'tool_use') {
            const short = shortToolName(block.name);
            this.toolNames.set(block.id, short);
            this.send({ type: 'tool', name: short, phase: 'start' });
          } else if (block.type === 'text' && !this.sawTextDelta && block.text) {
            // Fallback only: partial messages unavailable, so send the whole text.
            this.send({ type: 'delta', text: block.text });
          }
        }
        return;
      }

      case 'user': {
        // Tool results come back as synthetic user messages.
        const content = msg.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type === 'tool_result') {
            const name = this.toolNames.get(block.tool_use_id);
            if (name) {
              this.toolNames.delete(block.tool_use_id);
              this.send({ type: 'tool', name, phase: 'end' });
            }
          }
        }
        return;
      }

      case 'result': {
        // End of a turn: success, failure, or a turn the user cancelled.
        if (msg.subtype !== 'success') {
          const detail = (msg.errors || []).join('; ') || msg.subtype;
          if (this.interrupted) {
            /* The user said "ticho" or pressed stop. The SDK reports the aborted
               turn as a failure, which it is not — it is exactly what was asked
               for, and there is nothing to tell anyone.

               Staying quiet also matters beyond the wording: an `error` frame
               clears resumeVoiceLoop in the browser, which would kill the
               hands-free loop that barge-in deliberately keeps alive. Saying
               "ticho" is meant to stop her talking, not to end the
               conversation. */
            log(`turn cancelled by the user (${detail})`);
          } else {
            log(`turn failed: ${detail}`);
            // Once per turn: an assistant error before this already said why.
            if (!this.errorShown) this.send({ type: 'error', message: explainError(null, detail) });
          }
        }
        for (const denial of msg.permission_denials || []) {
          log('permission denied:', denial.tool_name);
        }
        // Close any tool that never reported a result (e.g. interrupted).
        for (const [, name] of this.toolNames) {
          this.send({ type: 'tool', name, phase: 'end' });
        }
        this.toolNames.clear();

        this.turnActive = false;
        this.interrupted = false;
        this.send({ type: 'done' });
        return;
      }

      default:
        // Everything else (status, thinking-token counters, hooks, task events…)
        // is deliberately not forwarded: `delta` must stay clean speech.
        return;
    }
  }

  onUserMessage(text, images) {
    this.turnActive = true;
    this.errorShown = false;
    this.interrupted = false;
    this.send({ type: 'thinking' });
    this.pushUserMessage(text, images);
  }

  async onInterrupt() {
    if (!this.turnActive) return;
    this.interrupted = true;
    try {
      await this.query?.interrupt();
      log('turn interrupted');
    } catch (err) {
      log('interrupt failed:', err?.message || err);
      // Make sure the UI is never left spinning.
      if (this.turnActive) {
        this.turnActive = false;
        this.send({ type: 'done' });
      }
    }
  }

  dispose() {
    this.closed = true;
    if (this.wake) {
      const w = this.wake;
      this.wake = null;
      w();
    }
    try {
      this.query?.close?.();
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket
// ---------------------------------------------------------------------------

const persona = loadPersona();
const app = express();

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: VERSION, model: MODEL, effort: EFFORT, mcpServers: Object.keys(MCP_SERVERS) });
});

/* The night routine's state — sleep, screen, lightsd, the last and next run
   (docs/DREAM.md). The controller readout reads this; open pages also get it
   pushed as `night_state` whenever it changes. */
app.get('/api/night', (_req, res) => {
  res.json(nightState());
});

app.get('/api/voices', async (_req, res) => {
  let available = false;
  try {
    const r = await fetch(`${XTTS_URL}/health`, { signal: AbortSignal.timeout(3000) });
    available = r.ok && (await r.json()).ok === true;
  } catch {
    available = false;                       // XTTS not running — browser voice only
  }
  res.json({ voices: VOICES, defaultVoice: DEFAULT_VOICE, xtts: available });
});

/* ---------------------------------------------------------------------------
 * The application document — tasks, journal, routine, timers, settings.
 *
 * Everything the interface owns that klaus_memory does not. One document, read
 * whole and written section at a time. Stored in klaus_memory's SQLite file in
 * `kacey_`-prefixed tables — see db.js for why sharing the file is safe.
 * ------------------------------------------------------------------------- */

app.get('/api/app', (_req, res) => {
  // Seeding here rather than at boot: the controller should list the tools this
  // build actually exposes, including any added since the document was written.
  appstate.seedTools(ALLOWED_TOOLS);
  // deniedTools is read-only context, not part of the stored document: these
  // are refused by configuration and no switch in the UI can change that.
  res.json({ ...appstate.get(), deniedTools: DISALLOWED_TOOLS });
});

app.put('/api/app/:section', express.json({ limit: '1mb' }), (req, res) => {
  const name = String(req.params.section || '');
  if (!appstate.SECTIONS.includes(name)) {
    return res.status(404).json({ error: `unknown section "${name}"` });
  }
  const value = req.body && Object.prototype.hasOwnProperty.call(req.body, 'value')
    ? req.body.value
    : req.body;
  if (value === undefined) return res.status(400).json({ error: 'nothing to store' });

  try {
    res.json({ ok: true, section: name, value: appstate.setSection(name, value) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ---------------------------------------------------------------------------
 * Internal calendar — READ ONLY.
 *
 * The calendar is klaus_memory's own: table `calendar_event`, written by Kacey
 * through the calendar_create MCP tool. Editing stays in the conversation for
 * now, so this endpoint only reads.
 *
 * Read straight from SQLite with node:sqlite rather than standing up
 * klaus_memory's HTTP API on 8010: one less process to keep alive, and the MCP
 * server already owns the write path. Opened read-only, per request, so we never
 * hold a lock and always see Kacey's latest writes.
 *
 * Day boundaries follow klaus_memory's logical day, which ends at 04:00 — an
 * event at 01:30 belongs to the previous date, same rule the persona uses.
 * ------------------------------------------------------------------------- */

/** Local calendar date of a Date, as 'YYYY-MM-DD'. */
function calDayOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function logicalDayOf(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return calDayOf(new Date(d.getTime() - LOGICAL_DAY_START_HOUR * 3600 * 1000));
}

/* All-day events arrive from the calendar sync as whole clock days: midnight to
   midnight with an EXCLUSIVE end, or midnight to 23:59. They must not get the
   4-hour logical-day shift — midnight belongs to the previous logical day, so a
   holiday starting at 00:00 on the 26th would be filed as starting on the 25th
   and ending a day early. Detect the shape and use plain calendar days for it. */
function isAllDay(startIso, endIso) {
  if (!endIso) return false;
  const s = new Date(startIso), e = new Date(endIso);
  if (isNaN(s) || isNaN(e)) return false;
  if (s.getHours() !== 0 || s.getMinutes() !== 0) return false;
  const endsAtMidnight = e.getHours() === 0 && e.getMinutes() === 0;
  const endsAtDayEnd = e.getHours() === 23 && e.getMinutes() === 59;
  if (!endsAtMidnight && !endsAtDayEnd) return false;
  return e.getTime() - s.getTime() >= 20 * 3600 * 1000;    // at least most of a day
}

/* The inclusive range of days an event occupies. The end is treated as
   exclusive throughout — an event ending at 00:00, or at 04:00 for a timed one,
   does not reach into the day that begins there. */
function dayRangeOf(r) {
  const s = new Date(r.starts_at);
  if (isNaN(s)) return null;
  const allDay = isAllDay(r.starts_at, r.ends_at);
  const first = allDay ? calDayOf(s) : logicalDayOf(r.starts_at);
  if (!first) return null;

  let last = first;
  if (r.ends_at) {
    const e = new Date(r.ends_at);
    if (!isNaN(e) && e.getTime() > s.getTime()) {
      const endMoment = new Date(e.getTime() - 1);
      const end = allDay ? calDayOf(endMoment) : logicalDayOf(endMoment.toISOString());
      if (end && end > first) last = end;
    }
  }
  return { first, last, allDay };
}

/** Days since epoch for a 'YYYY-MM-DD'. UTC so a DST change cannot shift it. */
function dayIndex(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

/** Every 'YYYY-MM' from a to b inclusive. Capped: a corrupt far-future row must
    not turn into an unbounded loop. */
function monthsBetween(a, b) {
  const out = [];
  let [y, m] = a.split('-').map(Number);
  const [ey, em] = b.split('-').map(Number);
  while ((y < ey || (y === ey && m <= em)) && out.length < 240) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/* source_meta is free-form JSON written by whatever produced the event, so it is
   parsed defensively and only sent when it actually holds something. */
function parseSourceMeta(raw) {
  if (!raw) return null;
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.keys(value).length ? value : null;
}

app.get('/api/calendar', async (req, res) => {
  // month=YYYY-MM shows one calendar month; omitted means the current one.
  const wantMonth = /^\d{4}-\d{2}$/.test(String(req.query.month || ''))
    ? String(req.query.month)
    : null;

  let db;
  try {
    // Dynamic import (this file is ESM, so there is no bare `require`), and lazy
    // so a Node build without node:sqlite still runs the rest of Kacey.
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(KLAUS_DB, { readOnly: true });
  } catch (err) {
    return res.status(503).json({ error: `Kalendář nelze otevřít: ${err.message}` });
  }

  try {
    const rows = db
      .prepare(
        `SELECT event_id, title, starts_at, ends_at, origin, sync_state,
                sensitivity, sync_error, source, source_meta, updated_at
           FROM calendar_event
          ORDER BY starts_at`,
      )
      .all();

    const today = logicalDayOf(new Date().toISOString());
    const month = wantMonth || today.slice(0, 7);

    /* Resolve each event once to the range of days it covers. Ranges rather
       than a single bucket: an event that runs from July to August belongs on
       every day in between, and used to appear only on the day it started —
       which made a two-week holiday invisible in the month it mostly covers. */
    const spans = [];
    const byMonth = new Map();
    for (const r of rows) {
      const range = dayRangeOf(r);
      if (!range) continue;
      spans.push({ row: r, ...range });
      // A spanning event counts once in every month it touches.
      for (const m of monthsBetween(range.first.slice(0, 7), range.last.slice(0, 7))) {
        byMonth.set(m, (byMonth.get(m) || 0) + 1);
      }
    }

    // Every day of the requested month, so the view reads as a month even where
    // nothing is booked.
    const [y, mo] = month.split('-').map(Number);
    const dayCount = new Date(y, mo, 0).getDate();
    const days = [];
    for (let d = 1; d <= dayCount; d++) {
      const date = `${month}-${String(d).padStart(2, '0')}`;
      const events = [];
      for (const s of spans) {
        // 'YYYY-MM-DD' compares lexicographically the same as chronologically.
        if (date < s.first || date > s.last) continue;
        const count = dayIndex(s.last) - dayIndex(s.first) + 1;
        const index = dayIndex(date) - dayIndex(s.first) + 1;
        events.push({
          ...s.row,
          source_meta: parseSourceMeta(s.row.source_meta),
          all_day: s.allDay,
          // Which slice of the event this day is, so the row can say so rather
          // than repeating the full time range on every day it covers.
          span: { index, count, first: index === 1, last: index === count },
        });
      }
      days.push({ date, events });
    }

    // Which months hold anything — so the UI can jump straight to a populated
    // month instead of the user clicking through empty ones.
    const monthsWithEvents = [...byMonth.entries()]
      .map(([m, count]) => ({ month: m, count }))
      .sort((a, b) => (a.month < b.month ? -1 : 1));

    res.json({
      today,
      month,
      monthEvents: byMonth.get(month) || 0,
      total: rows.length,
      monthsWithEvents,
      days,
    });
  } catch (err) {
    log(`calendar read failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
});

/* ---------------------------------------------------------------------------
 * Calendar writes.
 *
 * Reads go straight to SQLite (above); writes must NOT, because klaus_memory
 * owns real logic here — it recomputes conflicts, stamps updated_at, and pushes
 * through to the external calendar backend. So each write runs
 * tools/calendar_write.py, which drives MemoryService properly.
 *
 * A short-lived process per write rather than another daemon: writes are
 * user-initiated and rare, and a dead daemon fails silently (which this project
 * has already been bitten by).
 * ------------------------------------------------------------------------- */

const EVENT_ID_RE = /^ev_[A-Za-z0-9_-]{4,64}$/;

function calendarWrite(payload) {
  return new Promise((resolve) => {
    const child = spawn(
      PYTHON_BIN,
      // Same two flags as the MCP server: without them a write to an external
      // event fails with "neznámý kalendářní zdroj 'osobní'".
      [
        path.join(HERE, 'tools', 'calendar_write.py'), '--db', KLAUS_DB,
        ...(existsSync(KLAUS_CALENDARS) ? ['--calendars', KLAUS_CALENDARS] : []),
        ...(existsSync(KLAUS_ENV_FILE) ? ['--env', KLAUS_ENV_FILE] : []),
      ],
      {
        env: { ...process.env, PYTHONPATH: KLAUS_MEMORY_PYTHONPATH, PYTHONIOENCODING: 'utf-8' },
      },
    );

    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 30000);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `nelze spustit python: ${e.message}` });
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out.trim()));
      } catch {
        resolve({ ok: false, error: (err || out || 'zápis selhal').trim().slice(0, 300) });
      }
    });

    child.stdin.end(JSON.stringify(payload), 'utf8');
  });
}

app.post('/api/calendar/:id/update', express.json({ limit: '32kb' }), async (req, res) => {
  const id = String(req.params.id || '');
  if (!EVENT_ID_RE.test(id)) return res.status(400).json({ error: 'neplatné event_id' });

  const body = req.body || {};
  const payload = { action: 'update', event_id: id };
  for (const key of ['title', 'starts_at', 'sensitivity']) {
    if (typeof body[key] === 'string' && body[key].trim()) payload[key] = body[key].trim();
  }
  // ends_at is tri-state: absent = keep, null = clear the end time.
  if ('ends_at' in body) payload.ends_at = body.ends_at === null ? null : String(body.ends_at);
  if (Object.keys(payload).length <= 2) {
    return res.status(400).json({ error: 'nic ke změně' });
  }

  const r = await calendarWrite(payload);
  log(`calendar update ${id}: ${r.ok ? 'ok' : 'FAILED ' + r.error}`);
  res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/calendar/:id/delete', express.json({ limit: '4kb' }), async (req, res) => {
  const id = String(req.params.id || '');
  if (!EVENT_ID_RE.test(id)) return res.status(400).json({ error: 'neplatné event_id' });

  const r = await calendarWrite({ action: 'delete', event_id: id });
  log(`calendar delete ${id}: ${r.ok ? 'ok' : 'FAILED ' + r.error}`);
  res.status(r.ok ? 200 : 400).json(r);
});

/**
 * Normalise text for XTTS.
 *
 * A full stop makes XTTS produce a hard terminal drop — clipped, and it often
 * swallows the last syllable. A comma gives a softer boundary, which measurably
 * cleans up the delivery (found by ear in the Voice Lab, 2026-08-17).
 *
 * This runs at the synthesis boundary, NOT before it: the frontend splits the
 * reply into sentences on '.', so rewriting dots earlier would leave it with no
 * boundaries to split on and Kacey would speak the whole reply as one breath.
 *
 * Set KACEY_TTS_DOTS=keep to send the text through untouched.
 */
function ttsText(input) {
  let s = String(input);
  if (TTS_DOTS !== 'comma') return s.trim();

  // "..." would become ",,," — make it a real ellipsis first.
  s = s.replace(/\.{2,}/g, '…');
  s = s.replace(/\./g, ',');
  // Czech writes decimals with a comma anyway, so "3.14" -> "3,14" is a bonus.
  s = s.replace(/\s+,/g, ',');        // stray " ," from an odd split
  s = s.replace(/,{2,}/g, ',');       // ",," reads as a stumble
  // A question or exclamation mark already carries the boundary; a comma glued to
  // either side ("Ano!, Hned,") reads as a stumble. The stronger mark wins.
  s = s.replace(/,(\s*[!?])/g, '$1');
  s = s.replace(/([!?])\s*,/g, '$1');
  return s.trim();
}

app.post('/api/tts', express.json({ limit: '64kb' }), async (req, res) => {
  const { text, voice } = req.body || {};
  if (!text || !voice) return res.status(400).json({ error: 'text and voice are required' });
  if (!VOICES.some((v) => v.id === voice)) {
    return res.status(400).json({ error: `unknown voice "${voice}"` });
  }

  const spoken = ttsText(text);
  if (!spoken) return res.status(400).json({ error: 'nothing to speak' });

  try {
    const started = Date.now();
    const upstream = await fetch(`${XTTS_URL}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: spoken, speaker: voice, language: 'cs' }),
      // CPU synthesis of a sentence can take tens of seconds.
      signal: AbortSignal.timeout(120000),
    });
    if (!upstream.ok) throw new Error(`XTTS ${upstream.status}`);
    const audio = Buffer.from(await upstream.arrayBuffer());
    const ms = Date.now() - started;
    log(`tts ${voice}: ${JSON.stringify(spoken)} -> ${audio.length} B in ${ms} ms`);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('X-Tts-Ms', String(ms));
    res.end(audio);
  } catch (err) {
    log(`tts failed (${voice}): ${err.message}`);
    res.status(502).json({ error: `Hlasový server neodpovídá (${err.message})` });
  }
});

// The frontend agent owns public/ exclusively.
app.use(express.static(PUBLIC_DIR));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

const server = createServer(app);
/* ---------------------------------------------------------------------------
 * Attachments.
 *
 * Images only, and only the formats the model actually accepts. Everything is
 * re-validated here rather than trusted from the browser: the frame arrives
 * over a socket that anything on the loopback interface can open.
 * ------------------------------------------------------------------------- */

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;     // per image, decoded
const MAX_IMAGES = 4;                        // per turn

/* Returns the accepted images. On rejection the array carries an `.error`
   string — checked by the caller BEFORE length, because a rejection on the
   first image returns an empty array that still has to be reported. */
function sanitiseImages(raw) {
  const out = [];
  if (!Array.isArray(raw) || !raw.length) return out;

  for (const item of raw.slice(0, MAX_IMAGES)) {
    if (!item || typeof item !== 'object') continue;
    const type = String(item.media_type || '');
    const data = String(item.data || '');
    if (!IMAGE_TYPES.includes(type)) {
      out.error = `Nepodporovaný typ přílohy: ${type || 'neznámý'}.`;
      return out;
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      out.error = 'Příloha není platný base64.';
      return out;
    }
    // base64 inflates by 4/3; check the decoded size, which is what counts.
    if (data.length * 3 / 4 > MAX_IMAGE_BYTES) {
      out.error = `Obrázek je moc velký (limit ${MAX_IMAGE_BYTES / 1024 / 1024} MB).`;
      return out;
    }
    out.push({ media_type: type, data });
  }
  return out;
}

const wss = new WebSocketServer({ server, path: '/ws' });

/** One frame to every open page. */
function broadcast(frame) {
  const text = JSON.stringify(frame);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(text);
  }
}

/* Kacey's app tools write straight into appstate, so an open page would sit on
   a stale routine unless it is told. Every write is broadcast to every client,
   carrying the previous value so the browser can offer an undo. */
setWriteListener((section, undo) => {
  broadcast({ type: 'app_changed', section, undo });
  log(`app tool wrote ${section}`);
});

wss.on('connection', (ws) => {
  log('client connected');
  const session = new KaceySession(ws, persona);

  // Sent immediately, before the SDK has finished booting, so the UI can render.
  /* `features` tells the page which of its optional frames this server
     understands. An unknown client frame is answered with an `error` below,
     so a newer page must not send `interaction` to an older server. */
  session.send({
    type: 'ready', version: VERSION, model: MODEL, mcpServers: Object.keys(MCP_SERVERS),
    features: ['night'],
  });
  session.send({ type: 'night_state', ...nightState() });

  try {
    session.start();
  } catch (err) {
    log('failed to start session:', err?.message || err);
    session.send({ type: 'error', message: explainError(null, err?.message) });
  }

  ws.on('message', async (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      session.send({ type: 'error', message: 'Malformed JSON frame.' });
      return;
    }

    if (frame?.type === 'user_message') {
      const text = typeof frame.text === 'string' ? frame.text.trim() : '';
      const images = sanitiseImages(frame.images);

      // An attachment on its own is a legitimate turn — "here, look at this".
      if (!text && !images.length) {
        session.send({ type: 'error', message: 'Empty user_message.' });
        return;
      }
      // Not `images.length && images.error` — a first image that fails
      // validation leaves an EMPTY array carrying the error, and that guard
      // would drop the attachment silently instead of saying why.
      if (images.error) {
        session.send({ type: 'error', message: images.error });
        return;
      }
      noteInteraction('message');
      session.onUserMessage(text || 'Podívej se na tohle.', images);
    } else if (frame?.type === 'interrupt') {
      await session.onInterrupt();
    } else if (frame?.type === 'interaction') {
      // A tap, a key, the wake word — the page throttles these. Anything else
      // in `kind` is dropped silently: it is a signal, not a request.
      if (INTERACTION_KINDS.includes(frame.kind)) noteInteraction(frame.kind);
    } else if (frame?.type === 'speaking') {
      noteSpeaking(frame.on === true);
    } else if (frame?.type === 'visibility') {
      if (frame.state === 'visible' || frame.state === 'hidden') noteVisibility(frame.state);
    } else {
      session.send({ type: 'error', message: `Unknown frame type: ${frame?.type}` });
    }
  });

  ws.on('close', () => {
    log('client disconnected');
    session.dispose();
  });

  ws.on('error', (err) => log('websocket error:', err?.message || err));
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}  (ws://${HOST}:${PORT}/ws)`);
  log(`KC ${VERSION} | model=${MODEL} effort=${EFFORT}`);
  log(`memory db=${KLAUS_DB}`);
  // A missing database is not an error to SQLite — it creates an empty one and
  // Kacey then runs with no memory and no calendar. Say so at startup instead.
  if (!existsSync(KLAUS_DB)) {
    log(`WARNING: ${KLAUS_DB} does not exist — an empty one will be created ` +
        'and Kacey will have no memory and no calendar. Set KLAUS_DB.');
  }
  /* Say plainly whether the external calendars are wired up. Silence here is
     what made this hard to find: reads come from the mirror in SQLite and look
     perfectly healthy, and only a write says "neznámý kalendářní zdroj". */
  if (existsSync(KLAUS_CALENDARS)) {
    log(`calendars=${KLAUS_CALENDARS}` +
        (existsSync(KLAUS_ENV_FILE) ? ` env=${KLAUS_ENV_FILE}` : ' (no .env — Google not authorised)'));
  } else {
    log(`WARNING: ${KLAUS_CALENDARS} not found — the calendar runs in memory. ` +
        'Reads still work (they come from the mirror), but deleting or editing ' +
        'an event from Google or TimeTree will fail. Set KLAUS_CALENDARS.');
  }
  log(`allowed tools (${ALLOWED_TOOLS.length}): ${MEMORY_TOOLS.join(', ')}`);
  startNight({ broadcast });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig} — shutting down`);
    stopNight();
    appstate.flushNow();            // close the database cleanly
    for (const ws of wss.clients) ws.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  });
}
