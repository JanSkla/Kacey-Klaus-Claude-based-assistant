/**
 * Kacey — configuration.
 *
 * Every knob, in one place, and nothing else. This module holds only constants:
 * the environment variables and their defaults, the klaus_memory launch command,
 * the tool allow-list, the voice table and the persona's substitution blocks.
 * It has no runtime state, opens no connections and does no I/O beyond the
 * existsSync() checks needed to decide which flags the memory server can be
 * given — so it can be imported from anywhere and read on its own.
 *
 * The logic that acts on all of this lives in server.js. If something here needs
 * to know about a session, a socket or a request, it does not belong here.
 *
 * The reference table for these knobs is in README.md.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo root — this file sits next to server.js. */
export const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Server and model
// ---------------------------------------------------------------------------

export const PORT = Number(process.env.PORT || 8787);
export const MODEL = process.env.KACEY_MODEL || 'claude-opus-5';
export const PERSONA_PATH = process.env.KACEY_PERSONA_PATH || path.join(HERE, 'persona', 'kacey.md');
export const PUBLIC_DIR = path.join(HERE, 'public');

// ---------------------------------------------------------------------------
// klaus_memory
// ---------------------------------------------------------------------------

// klaus_memory lives at <KLAUS_MEMORY_PYTHONPATH>/klaus_memory and is pure stdlib,
// so there is nothing to pip install. The --db flag ALWAYS wins over the KLAUS_DB
// env var (cli.py does Config.from_env().with_(db_path=...) and --db defaults to
// "klaus-memory.db"), so we must pass it explicitly or the server silently creates
// a fresh empty database in the current working directory.
export const PYTHON_BIN = process.env.PYTHON_BIN || 'python';
// Klaus\memory\ was renamed to Klaus\Kacey-mvp\ — both paths below moved with it.
// Both are derived from THIS checkout (../Klaus/Kacey-mvp) instead of hardcoded:
// the tree has already moved once (C:\repos\hobby\lukas -> D:\code\hobby\lukas),
// and an absolute default pointing at an old copy fails SILENTLY — SQLite just
// creates a fresh schema-only file there, so Kacey starts with no memory and an
// empty calendar and reports no error at all. Override with the env vars if the
// memory tree does not sit next to this repo.
// Directory CONTAINING the klaus_memory package, not the package itself.
export const KLAUS_MEMORY_PYTHONPATH =
  process.env.KLAUS_MEMORY_PYTHONPATH || path.join(HERE, '..', 'Klaus', 'Kacey-mvp');
export const KLAUS_DB =
  process.env.KLAUS_DB || path.join(KLAUS_MEMORY_PYTHONPATH, 'klaus.db');

/* The external calendars — Google "osobní" and "práce", TimeTree "rodina".
 *
 * WITHOUT --calendars, klaus_memory falls back to InMemoryCalendarBackend and
 * the only source that exists is a throwaway one called "local". Reads still
 * look fine, because they come from the mirror table in SQLite, so the failure
 * is invisible until a WRITE: delete() calls sources.require_writable(source),
 * and every stored event says 'osobní' / 'práce' / 'rodina', none of which the
 * session knows. The result is "neznámý kalendářní zdroj 'osobní'" on every
 * attempt to delete a real event.
 *
 * WITHOUT --env, the file is looked up relative to the process's own directory,
 * which is THIS repo — and the credentials live next to calendars.json in the
 * memory tree, a sibling rather than a parent, so the search never reaches it.
 * The sources then load but no Google source is authorised.
 *
 * Both are passed explicitly, and only when the file is actually there: a
 * --calendars pointing at nothing is a hard startup failure, and with
 * alwaysLoad below that would take the whole assistant down rather than just
 * the calendar.
 */
export const KLAUS_CALENDARS =
  process.env.KLAUS_CALENDARS || path.join(KLAUS_MEMORY_PYTHONPATH, 'calendars.json');
export const KLAUS_ENV_FILE =
  process.env.KLAUS_ENV_FILE || path.join(KLAUS_MEMORY_PYTHONPATH, '.env');

function memoryArgs() {
  const args = ['-m', 'klaus_memory', '--db', KLAUS_DB];
  if (existsSync(KLAUS_CALENDARS)) args.push('--calendars', KLAUS_CALENDARS);
  if (existsSync(KLAUS_ENV_FILE)) args.push('--env', KLAUS_ENV_FILE);
  args.push('mcp');
  return args;
}

export const MCP_SERVER_NAME = 'klaus-memory';

export const MCP_SERVERS = {
  [MCP_SERVER_NAME]: {
    type: 'stdio',
    command: PYTHON_BIN,
    args: memoryArgs(),
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
// Kacey runs with NO built-in tools at all (`tools: []` in server.js): no Bash,
// no Read/Write/Edit, no Grep/Glob, no WebFetch/WebSearch. A voice assistant has
// no business touching the filesystem or a shell, and there is no human watching
// a terminal to approve anything.
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
export const MEMORY_TOOLS = [
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
  'calendar_sync',
  'calendar_sources',
];

export const ALLOWED_TOOLS = MEMORY_TOOLS.map((t) => `mcp__${MCP_SERVER_NAME}__${t}`);

// Defense in depth: even if a future SDK default or a plugin re-introduced the
// built-in tools, these stay removed from the model's context entirely.
export const DISALLOWED_TOOLS = [
  'Bash', 'BashOutput', 'KillShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill',
];

// ---------------------------------------------------------------------------
// Persona — the text; the loading and substitution live in server.js
// ---------------------------------------------------------------------------

export const FALLBACK_PERSONA = [
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
export const OWNER_PROFILE =
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
export const TURN_CONTEXT =
  'Kontext se ti nepředává předem. Vytáhni si ho sama nástroji nad `klaus_memory` ' +
  '(memory_search, memory_get_facts, journal_day, calendar_day, memory_briefing) ' +
  'podle sekce Paměť, a to ještě než odpovíš.';

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

/* Chosen in the Voice Lab on 2026-08-17 by listening to all 58 XTTS studio
 * speakers. Note the spellings — "Ana" not "Anna", "María" with the accent,
 * "Lidiya" not "Lidia"; XTTS matches the speaker name exactly and a near-miss is
 * a 500, not a fallback.
 *
 * Synthesis runs through the local XTTS server (voicelab/xtts_server.py, port
 * 8790), so nothing leaves the machine. It is slower than real time on CPU —
 * the browser voice stays available as the fast fallback.
 */

export const XTTS_URL = process.env.XTTS_URL || 'http://127.0.0.1:8790';

export const VOICES = [
  { id: 'Nova Hogarth', label: 'Nova Hogarth', preferred: true },
  { id: 'Tammie Ema', label: 'Tammie Ema' },
  { id: 'Ana Florence', label: 'Ana Florence' },
  { id: 'Alma María', label: 'Alma María' },
  { id: 'Uta Obando', label: 'Uta Obando' },
  { id: 'Lidiya Szekeres', label: 'Lidiya Szekeres' },
  // "Zofija", not "Zofia" — the model also ships a separate "Sofia Hellen", and
  // either near-miss is a 500 rather than a fallback.
  { id: 'Zofija Kendrick', label: 'Zofija Kendrick' },
  { id: 'Lilya Stainthorpe', label: 'Lilya Stainthorpe' },
];

export const DEFAULT_VOICE = process.env.KACEY_TTS_VOICE || 'Nova Hogarth';

/* 'comma' rewrites full stops before synthesis, which measurably cleans up
 * XTTS's delivery — see ttsText() in server.js for why, and where. Set
 * KACEY_TTS_DOTS=keep to send the text through untouched. */
export const TTS_DOTS = process.env.KACEY_TTS_DOTS || 'comma';

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

/* The logical day ends at 04:00: an event at 01:30 belongs to the previous date,
 * which is how people talk about their day and the same rule the persona and
 * klaus_memory both use. All-day events opt out of the shift — see isAllDay()
 * in server.js. */
export const LOGICAL_DAY_START_HOUR = 4;
