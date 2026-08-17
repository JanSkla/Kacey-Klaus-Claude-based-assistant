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
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config (env with sane defaults)
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 8787);
const MODEL = process.env.KACEY_MODEL || 'claude-opus-5';
const PERSONA_PATH = process.env.KACEY_PERSONA_PATH || path.join(HERE, 'persona', 'kacey.md');
const PUBLIC_DIR = path.join(HERE, 'public');

// klaus_memory lives at <KLAUS_MEMORY_PYTHONPATH>/klaus_memory and is pure stdlib,
// so there is nothing to pip install. The --db flag ALWAYS wins over the KLAUS_DB
// env var (cli.py does Config.from_env().with_(db_path=...) and --db defaults to
// "klaus-memory.db"), so we must pass it explicitly or the server silently creates
// a fresh empty database in the current working directory.
const PYTHON_BIN = process.env.PYTHON_BIN || 'python';
// Klaus\memory\ was renamed to Klaus\Kacey-mvp\ — both paths below moved with it.
// This is the populated database (3.5 MB, real facts + FTS + embeddings); the
// sibling C:\repos\hobby\lukas\Klaus\klaus.db is schema-only with zero facts, so
// pointing at that one makes Kacey start with no memory and no error.
const KLAUS_DB =
  process.env.KLAUS_DB || 'C:\\repos\\hobby\\lukas\\Klaus\\Kacey-mvp\\klaus.db';
// Directory CONTAINING the klaus_memory package, not the package itself.
const KLAUS_MEMORY_PYTHONPATH =
  process.env.KLAUS_MEMORY_PYTHONPATH || 'C:\\repos\\hobby\\lukas\\Klaus\\Kacey-mvp';

const MCP_SERVER_NAME = 'klaus-memory';

const MCP_SERVERS = {
  [MCP_SERVER_NAME]: {
    type: 'stdio',
    command: PYTHON_BIN,
    args: ['-m', 'klaus_memory', '--db', KLAUS_DB, 'mcp'],
    env: { ...process.env, PYTHONPATH: KLAUS_MEMORY_PYTHONPATH },
    // Block startup until the server is connected, so the memory tools are
    // present in the very first prompt instead of appearing a turn late.
    alwaysLoad: true,
  },
};

// ---------------------------------------------------------------------------
// TOOL ALLOW-LIST  <-- the one place to widen Kacey's permissions
// ---------------------------------------------------------------------------
//
// Kacey runs with NO built-in tools at all (`tools: []` below): no Bash, no
// Read/Write/Edit, no Grep/Glob, no WebFetch/WebSearch. A voice assistant has no
// business touching the filesystem or a shell, and there is no human watching a
// terminal to approve anything.
//
// The only tools she gets are the klaus_memory MCP tools named here. Names are
// the SDK-prefixed form: mcp__<server name>__<tool>.
//
// To widen: add the bare tool name to MEMORY_TOOLS. To see every tool the memory
// server offers, start the server and read the log line it prints on boot, or run:
//   python -m klaus_memory --db <path> mcp        (and speak MCP tools/list to it)
//
// Deliberately NOT allowed, though the server offers them:
//   calendar_sync                   - the ONLY calendar call that reaches the
//                                     external backend (calendar_mirror.sync ->
//                                     backend.list_range). Also an orchestrator
//                                     batch job. calendar_create by contrast is a
//                                     plain local INSERT INTO calendar_event, so
//                                     it is allowed: the persona requires it
//                                     ("datum + cas = zavazek -> kalendar") and
//                                     tells her to confirm the day, time and who
//                                     with, which is the real guard against a
//                                     mis-heard event.
//   memory_replay, memory_reembed, memory_rebuild_indexes, dream_run,
//   dream_catchup                   - long-running maintenance / rebuild jobs.
//   memory_cache_put, memory_build_prompt, memory_config, memory_stats,
//   dream_status                    - plumbing, not conversation.
const MEMORY_TOOLS = [
  // recall
  'memory_search',
  'memory_get_facts',
  'memory_entity_candidates',
  'memory_briefing',
  // write
  'memory_remember',
  'memory_retract_fact',
  // episodes
  'memory_open_session',
  'memory_close_session',
  'memory_ingest_turn',
  // journal (episodic recall: "what did I do on Thursday")
  'journal_day',
  'journal_search',
  // calendar: local DB only. calendar_sync (external, wholesale) stays out.
  // update/delete DO write through to the external backend per event, which is
  // the point — the persona already makes her confirm day, time and who with.
  'calendar_day',
  'calendar_conflicts',
  'calendar_create',
  'calendar_update',
  'calendar_delete',
];

const ALLOWED_TOOLS = MEMORY_TOOLS.map((t) => `mcp__${MCP_SERVER_NAME}__${t}`);

// Defense in depth: even if a future SDK default or a plugin re-introduced the
// built-in tools, these stay removed from the model's context entirely.
const DISALLOWED_TOOLS = [
  'Bash', 'BashOutput', 'KillShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill',
];

// ---------------------------------------------------------------------------
// Persona
// ---------------------------------------------------------------------------

const FALLBACK_PERSONA = [
  'You are Kacey, a warm and direct personal assistant.',
  'Your replies are spoken aloud, so: short sentences, no markdown, no lists,',
  'no code blocks, no emoji, and never read URLs or file paths aloud.',
  'A few sentences is a complete answer. Do not be sycophantic.',
  'Mirror the user\'s language: Czech in, Czech out; English in, English out.',
  'Use the klaus_memory tools: recall relevant facts before answering anything',
  'personal, and store durable new facts. Follow the memory server\'s own',
  '`instructions` field, including calling memory_entity_candidates before',
  'memory_remember.',
].join(' ');

// Who Kacey is serving. She addresses the owner as "pane"/"paní", so grammatical
// gender matters — Czech has no neutral form here. Override with KACEY_OWNER.
const OWNER_PROFILE =
  process.env.KACEY_OWNER ||
  'Muž, oslovuj ho „pane“. Mluví česky, žije v časové zóně Europe/Prague. ' +
    'Jeho jméno si ověř v paměti (memory_search) — nedomýšlej si ho.';

// The persona is a template. These blocks come from the source document
// (Klaus/docs/kacey-system-prompt.md) and MUST all be substituted — an
// unreplaced {{...}} would reach the model as literal text.
//
// TURN_CONTEXT replaces the document's {{RETRIEVED_FACTS}} / {{RECENT_JOURNAL}} /
// {{L0_TAIL}} trio. Those assume a wrapper that pre-retrieves per turn and rebuilds
// the system prompt each time; the Agent SDK fixes the system prompt for the whole
// session, so retrieval here is tool-driven instead — she calls memory_search /
// memory_briefing herself, which the Paměť section already instructs.
const TURN_CONTEXT =
  'Kontext se ti nepředává předem. Vytáhni si ho sama nástroji nad `klaus_memory` ' +
  '(memory_search, memory_get_facts, journal_day, calendar_day, memory_briefing) ' +
  'podle sekce Paměť, a to ještě než odpovíš.';

// The logical day ends at 04:00, so 01:30 still belongs to the previous date.
function logicalNow(now = new Date()) {
  const shifted = new Date(now.getTime() - 4 * 3600 * 1000);
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

const AUTH_HINT =
  'Claude is not authenticated. Open a terminal, run `claude`, log in, then restart Kacey. ' +
  '(Alternatively set ANTHROPIC_API_KEY in the environment.)';

function isAuthError(err) {
  return err === 'authentication_failed' || err === 'oauth_org_not_allowed';
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
  }

  send(frame) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(frame));
  }

  /** Queue a user turn for the live SDK session. */
  pushUserMessage(text) {
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

    this.pending.push({
      type: 'user',
      message: { role: 'user', content: text + nudge },
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

        // The persona replaces the Claude Code system prompt entirely — we do not
        // want coding-agent instructions in a voice assistant.
        systemPrompt: this.persona,

        // SDK isolation: do not load settings.json / CLAUDE.md from disk. Kacey's
        // behaviour comes from persona/kacey.md alone.
        settingSources: [],

        mcpServers: MCP_SERVERS,

        // Use ONLY the server above. Without this, the SDK also auto-fetches the
        // account's claude.ai cloud connectors — Gmail, Google Calendar, Slack,
        // Notion and a dozen more turned up in Kacey's session. settingSources: []
        // does not stop them (they are not a settings source), and 15 servers
        // racing at startup is also what made klaus-memory time out.
        strictMcpConfig: true,

        // No built-in tools whatsoever; only the allow-listed MCP tools.
        tools: [],
        allowedTools: ALLOWED_TOOLS,
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
      this.send({ type: 'error', message: `Session error: ${err?.message || String(err)}` });
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
              const m = `Memory server "${s.name}" is ${s.status} — Kacey has no memory this session.`;
              log('WARNING:', m);
              this.send({ type: 'error', message: m });
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
          const message = isAuthError(msg.error)
            ? AUTH_HINT
            : `Model error (${msg.error}).`;
          log('assistant error:', msg.error);
          this.send({ type: 'error', message });
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
        // End of a turn — success or failure.
        if (msg.subtype !== 'success') {
          const detail = (msg.errors || []).join('; ') || msg.subtype;
          this.send({ type: 'error', message: `Turn failed: ${detail}` });
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
        this.send({ type: 'done' });
        return;
      }

      default:
        // Everything else (status, thinking-token counters, hooks, task events…)
        // is deliberately not forwarded: `delta` must stay clean speech.
        return;
    }
  }

  onUserMessage(text) {
    this.turnActive = true;
    this.send({ type: 'thinking' });
    this.pushUserMessage(text);
  }

  async onInterrupt() {
    if (!this.turnActive) return;
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
  res.json({ ok: true, model: MODEL, mcpServers: Object.keys(MCP_SERVERS) });
});

/* ---------------------------------------------------------------------------
 * Voice. Chosen in the Voice Lab on 2026-08-17 by listening to all 58 XTTS
 * studio speakers. Note the spellings — "Ana" not "Anna", "María" with the
 * accent, "Lidiya" not "Lidia"; XTTS matches the speaker name exactly and a
 * near-miss is a 500, not a fallback.
 *
 * Synthesis runs through the local XTTS server (voicelab/xtts_server.py, port
 * 8790), so nothing leaves the machine. It is slower than real time on CPU —
 * the browser voice stays available as the fast fallback.
 * ------------------------------------------------------------------------- */

const XTTS_URL = process.env.XTTS_URL || 'http://127.0.0.1:8790';

const VOICES = [
  { id: 'Nova Hogarth', label: 'Nova Hogarth', preferred: true },
  { id: 'Ana Florence', label: 'Ana Florence' },
  { id: 'Alma María', label: 'Alma María' },
  { id: 'Uta Obando', label: 'Uta Obando' },
  { id: 'Lidiya Szekeres', label: 'Lidiya Szekeres' },
];

const DEFAULT_VOICE = process.env.KACEY_TTS_VOICE || 'Nova Hogarth';

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

const LOGICAL_DAY_START_HOUR = 4;

function logicalDayOf(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const shifted = new Date(d.getTime() - LOGICAL_DAY_START_HOUR * 3600 * 1000);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`;
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
                sensitivity, sync_error
           FROM calendar_event
          ORDER BY starts_at`,
      )
      .all();

    const today = logicalDayOf(new Date().toISOString());
    const month = wantMonth || today.slice(0, 7);

    // Index every event by logical day once, then slice the month out of it.
    const byDay = new Map();
    const byMonth = new Map();
    for (const r of rows) {
      const day = logicalDayOf(r.starts_at);
      if (!day) continue;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(r);
      const m = day.slice(0, 7);
      byMonth.set(m, (byMonth.get(m) || 0) + 1);
    }

    // Every day of the requested month, so the view reads as a month even where
    // nothing is booked.
    const [y, mo] = month.split('-').map(Number);
    const dayCount = new Date(y, mo, 0).getDate();
    const days = [];
    for (let d = 1; d <= dayCount; d++) {
      const date = `${month}-${String(d).padStart(2, '0')}`;
      days.push({ date, events: byDay.get(date) || [] });
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
      [path.join(HERE, 'tools', 'calendar_write.py'), '--db', KLAUS_DB],
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
const TTS_DOTS = process.env.KACEY_TTS_DOTS || 'comma';

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
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  log('client connected');
  const session = new KaceySession(ws, persona);

  // Sent immediately, before the SDK has finished booting, so the UI can render.
  session.send({ type: 'ready', model: MODEL, mcpServers: Object.keys(MCP_SERVERS) });

  try {
    session.start();
  } catch (err) {
    log('failed to start session:', err?.message || err);
    session.send({ type: 'error', message: `Could not start Claude: ${err?.message || err}` });
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
      if (!text) {
        session.send({ type: 'error', message: 'Empty user_message.' });
        return;
      }
      session.onUserMessage(text);
    } else if (frame?.type === 'interrupt') {
      await session.onInterrupt();
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

server.listen(PORT, () => {
  log(`listening on http://localhost:${PORT}  (ws://localhost:${PORT}/ws)`);
  log(`model=${MODEL}`);
  log(`memory db=${KLAUS_DB}`);
  log(`allowed tools (${ALLOWED_TOOLS.length}): ${MEMORY_TOOLS.join(', ')}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig} — shutting down`);
    for (const ws of wss.clients) ws.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  });
}
