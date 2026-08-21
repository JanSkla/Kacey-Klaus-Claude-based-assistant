# Kacey — backend

Voice-first personal assistant. The browser captures speech and speaks the reply;
this server runs the Claude Agent SDK and gives Claude access to the `klaus_memory`
MCP server, so Kacey remembers things between conversations.

```
Browser (voice + text UI)  ->  this server (Node)  ->  Claude Agent SDK  ->  klaus_memory MCP
   public/app.js + js/            server.js            @anthropic-ai/...      python -m klaus_memory
```

## Run it

```sh
npm install
npm start
```

Then open <http://localhost:8787>.

Authentication comes from the Claude CLI — run `claude` once in a terminal and log
in. No `ANTHROPIC_API_KEY` is needed if you are logged in. If Claude is not
authenticated, Kacey says so in the UI instead of failing silently.

Run the tests (no browser needed — they cover the wake-word DSP, the wake
pipeline and the spoken-command matcher):

```sh
npm run test:wake
```

Check it is alive:

```sh
curl http://localhost:8787/api/health
# {"ok":true,"model":"claude-opus-5","mcpServers":["klaus-memory"]}
```

## Files

| Path                 | What it is                                                    |
| -------------------- | ------------------------------------------------------------- |
| `server.js`          | The whole backend: HTTP, WebSocket, SDK session, MCP          |
| `persona/kacey.md`   | Kacey's system prompt — edit and restart, no code change      |
| `.env.example`       | Every configuration knob with explanation                     |
| `public/index.html`  | The markup, and the only place scripts are loaded             |
| `public/app.js`      | Frontend entry point — boot and wiring, nothing else          |
| `public/js/`         | The frontend proper: `core/` `ui/` `voice/` `net/` (below)      |
| `public/styles.css`  | All of the styling; one hue drives the whole palette          |
| `test/`              | Node tests for the pieces that can be tested without a browser |
| `ARCHITECTURE.md`    | How it all fits together, and the invariants that hold          |

### Frontend layout

`public/app.js` is a native ES module — `<script type="module">`, no build step, no
dependencies. It restores preferences, subscribes the orb's followers, wires the
DOM and starts the transport, in that order. Everything else is in `public/js/`,
grouped by what a module talks to:

```
public/js/
  core/    state i18n dom bus              imports nothing outside itself
  ui/      orb log telemetry labels        the DOM: what is on screen
           theme voice-picker calendar
  voice/   sentences chime tts             the microphone and the speakers,
           recognition commands barge      and who is allowed to hold them
           wake wake-panel
  net/     transport-socket                the wire: two transports and the
           transport-mock protocol         pipeline they both feed
  debug.js                                 reaches across all four, on purpose
```

Three files stay **classic scripts** at the root of `public/` rather than modules:
`wake-voice.js` and `closing.js`, because the Node tests load them by evaluating
the source, and `wake-worklet.js`, which the browser fetches by relative URL at
runtime. Classic scripts run before deferred module scripts, so the globals they
define exist by the time `app.js` boots.

**[ARCHITECTURE.md](ARCHITECTURE.md) is the full account**: a module-by-module
table, how a turn flows end to end, the microphone arbitration, the two deliberate
import cycles, the invariants, and where to put new code.

## Configuration

All environment variables, all with working defaults — see `.env.example`.

| Variable                  | Default                                | Notes                                     |
| ------------------------- | -------------------------------------- | ----------------------------------------- |
| `PORT`                    | `8787`                                 |                                           |
| `KACEY_MODEL`             | `claude-opus-5`                        |                                           |
| `KACEY_PERSONA_PATH`      | `./persona/kacey.md`                   | Missing file → built-in default + warning |
| `PYTHON_BIN`              | `python`                               | Launches the MCP server                   |
| `KLAUS_DB`                | `C:\repos\hobby\lukas\Klaus\klaus.db`  | Passed as `--db`                          |
| `KLAUS_MEMORY_PYTHONPATH` | `C:\repos\hobby\lukas\Klaus\memory`    | Directory *containing* `klaus_memory`     |

`klaus_memory` is pure standard library (sqlite3/json/urllib) — there is nothing to
`pip install`.

> **The `--db` flag always wins.** Inside `klaus_memory`, `--db` overrides the
> `KLAUS_DB` environment variable and defaults to `klaus-memory.db`. The server
> therefore always passes `--db` explicitly. Point it at the wrong path and you get
> a brand-new empty database instead of an error.

`klaus_memory` prints warnings to stderr on startup (for example about a missing
`OPENROUTER_API_KEY`). That is normal. They are logged, not treated as failures.

## Tool permissions

Kacey runs with **no built-in tools at all** — no shell, no file read or write, no
web access. She gets only an explicit allow-list of `klaus_memory` tools.

The allow-list is the `MEMORY_TOOLS` array near the top of `server.js`, with a
comment explaining how to widen it and why certain tools are left out. Three layers
enforce it:

1. `tools: []` — every built-in tool is removed from the model's context.
2. `allowedTools: [...]` — only the allow-listed memory tools run, and they run
   without a confirmation prompt.
3. `permissionMode: 'dontAsk'` — anything not pre-approved is denied rather than
   prompted for. This is what stops a voice turn hanging forever on a confirmation
   dialog nobody can see.

Deliberately **not** allowed even though the memory server offers them:
`calendar_create` and `calendar_sync` (they write to a real external calendar, and a
misheard sentence should not create real events), and the maintenance jobs
`memory_replay`, `memory_reembed`, `memory_rebuild_indexes`, `dream_run`,
`dream_catchup`.

## Wire protocol

WebSocket at `/ws`, one JSON object per frame.

Client → server:

```jsonc
{ "type": "user_message", "text": "..." }
{ "type": "interrupt" }
```

Server → client:

```jsonc
{ "type": "ready",   "model": "claude-opus-5", "mcpServers": ["klaus-memory"] }
{ "type": "session", "sessionId": "..." }
{ "type": "thinking" }
{ "type": "delta",   "text": "..." }              // assistant speech, verbatim
{ "type": "tool",    "name": "memory_search", "phase": "start" }
{ "type": "done" }
{ "type": "error",   "message": "..." }
```

`delta` carries assistant **text only**. Thinking blocks, tool-call JSON, status
events and model errors never reach it — the browser speaks `delta` aloud, so
anything else leaking in would be read out. Model and authentication errors are
converted into `error` frames instead.

The conversation is continuous for the life of the connection: one `query()` call
runs in streaming-input mode and user turns are pushed into it, so Claude remembers
earlier turns without any history replay. `interrupt` aborts the in-flight turn and
leaves the session usable for the next message.

HTTP:

- `GET /` → `public/index.html` (static file server over `public/`)
- `GET /api/health` → `{ "ok": true, "model": "...", "mcpServers": [...] }`

## Editing the persona

`persona/kacey.md` is loaded from disk at startup, so you can rewrite how Kacey
speaks without touching code. Restart the server to pick up changes. It is written
for a voice: short sentences, no markdown, no lists, mirrors the user's language
(Czech or English), and it is told to follow the memory server's own `instructions`
field — including calling `memory_entity_candidates` before `memory_remember`.
