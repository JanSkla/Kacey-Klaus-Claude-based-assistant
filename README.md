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
claude mcp add klaus-memory -- python -m klaus_memory --db D:/code/hobby/lukas/Klaus/Kacey-mvp/klaus.db --calendars D:/code/hobby/lukas/Klaus/Kacey-mvp/calendars.json mcp
npm start
```

Then open <http://localhost:8082>.

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
curl http://localhost:8082/api/health
# {"ok":true,"model":"claude-opus-5","mcpServers":["klaus-memory"]}
```

## The XTTS voices (optional)

Without this, the voice picker offers only the browser engine — which is the
designed fallback, not a failure. The neural voices need a separate Python
environment, because Coqui TTS pins versions that have no business near
anything else.

One-time setup. **Python 3.11**, not 3.13+: Coqui TTS does not support them.
The venv path is hardcoded in `package.json`, so the name matters.

```sh
py -3.11 -m venv .venv-xtts
.venv-xtts\Scripts\python.exe -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
.venv-xtts\Scripts\python.exe -m pip install coqui-tts "transformers<5"
```

Three things in there are not optional and each fails in its own way:

- **CUDA wheels first.** Install `coqui-tts` before torch and pip resolves the
  CPU-only build, which is slower than real time — the difference between
  continuous speech and audible gaps.
- **`torchaudio` explicitly.** `coqui-tts` imports it but does not depend on it,
  so the venv installs clean and then dies with `ModuleNotFoundError` on the
  first import.
- **`transformers<5`.** XTTS imports `isin_mps_friendly`, which 5.x removed. The
  symptom is an `ImportError` deep inside the Tortoise layers, not a version
  complaint.

Then download the model (~1.8 GB) and audition a few speakers into
`voicelab/samples/`:

```sh
.venv-xtts\Scripts\python.exe voicelab/xtts_fetch.py "Nova Hogarth" "Tammie Ema"
```

With no arguments it renders the first six of the 58 studio speakers. Note that
this script runs on the **CPU** — ~20 s a sentence is expected here and says
nothing about the server, which uses the GPU when there is one.

Start the voice server (leave it running; it holds the model in memory):

```sh
npm run xtts
```

Wait for `[xtts] ready` and then `[xtts] warmed up` — it burns the expensive
first inference at startup so a real request never pays it. Confirm the GPU was
picked up, and which speakers exist:

```sh
curl http://127.0.0.1:8790/health
```

Restart Kacey and the picker gains the voices from `VOICES` in `config.js`.
Those five names are an allow-list: `/api/tts` rejects anything else, and XTTS
matches speaker names exactly, so `Ana` / `Anna` and `Lidiya` / `Lidia` are the
difference between a voice and a 500.

XTTS-v2 is **CPML — non-commercial only**, and only the built-in studio speakers
are used. Cloning a real person's voice would need that person's consent.

## Files

| Path                 | What it is                                                    |
| -------------------- | ------------------------------------------------------------- |
| `server.js`          | The backend: HTTP, WebSocket, SDK session, MCP                 |
| `config.js`          | Every knob, the MCP launch command and the tool allow-list      |
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
| `PORT`                    | `8082`                                 |                                           |
| `HOST`                    | `127.0.0.1`                            | Interface to bind; see the note below     |

> **`HOST` and the microphone.** Kacey listens on loopback by default: the
> server hands out a logged-in Claude session, so it must not turn up on a
> network by accident. Point `HOST` at a Tailscale address to reach it as
> `kaceybody:8082` from the tailnet, or `0.0.0.0` for every interface.
>
> A browser only grants the microphone on a *secure* origin — https, or
> localhost. Over plain http at a hostname the browser refuses speech
> recognition and Kacey says so. To use voice from a phone, put TLS in front:
> `tailscale serve --bg 8082` gives a real certificate on the tailnet.
| `KACEY_MODEL`             | `claude-opus-5`                        |                                           |
| `KACEY_PERSONA_PATH`      | `./persona/kacey.md`                   | Missing file → built-in default + warning |
| `PYTHON_BIN`              | `python`                               | Launches the MCP server                   |
| `KLAUS_DB`                | `<PYTHONPATH>\klaus.db`                | Passed as `--db`                          |
| `KLAUS_MEMORY_PYTHONPATH` | `..\Klaus\Kacey-mvp`                   | Directory *containing* `klaus_memory`     |
| `KLAUS_CALENDARS`         | `<PYTHONPATH>\calendars.json`          | Passed as `--calendars` when present      |
| `KLAUS_ENV_FILE`          | `<PYTHONPATH>\.env`                    | Passed as `--env`; OAuth credentials      |

`klaus_memory` is pure standard library (sqlite3/json/urllib) — there is nothing to
`pip install`.

> **Without `--calendars` there is no calendar.** `klaus_memory` then falls back to
> a single in-memory source named `local`. Reads keep working, because they come
> from the mirror table in SQLite, so the failure stays invisible until a *write*:
> every stored event says `osobní`, `práce` or `rodina`, none of which the session
> knows, and the delete fails with `neznámý kalendářní zdroj 'osobní'`. `--env` is
> explicit for a related reason — `.env` is searched from the working directory
> *upwards*, and the server spawns Python from this repo, so the memory tree's
> `.env` sits on a sibling branch and is never reached. Both flags are passed only
> when the file actually exists: pointing `--calendars` at nothing is a hard startup
> failure, which would take the whole assistant down rather than just the calendar.

> **The `--db` flag always wins.** Inside `klaus_memory`, `--db` overrides the
> `KLAUS_DB` environment variable and defaults to `klaus-memory.db`. The server
> therefore always passes `--db` explicitly. Point it at the wrong path and you get
> a brand-new empty database instead of an error.

`klaus_memory` prints warnings to stderr on startup (for example about a missing
`OPENROUTER_API_KEY`). That is normal. They are logged, not treated as failures.

## Tool permissions

Kacey runs with **no built-in tools at all** — no shell, no file read or write, no
web access. She gets only an explicit allow-list of `klaus_memory` tools.

The allow-list is the `MEMORY_TOOLS` array in `config.js`, with a
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
