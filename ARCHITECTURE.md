# Architecture

How Kacey is put together, and why it is put together that way.

This document is about **structure**: what the pieces are, which of them may know
about which others, and the invariants that hold the whole thing up. It is not an
API reference — every module carries a header comment explaining its own job, and
that is the place for detail about how one piece works. Read this first, then read
the file you actually need.

## Contents

- [The whole system](#the-whole-system)
- [Frontend](#frontend)
  - [The rules](#the-rules)
  - [The four directories](#the-four-directories)
  - [What is not a module](#what-is-not-a-module)
- [A turn, end to end](#a-turn-end-to-end)
- [The orb: one derived state](#the-orb-one-derived-state)
- [The microphone: three listeners, one device](#the-microphone-three-listeners-one-device)
- [Who owns which state](#who-owns-which-state)
- [The two import cycles](#the-two-import-cycles)
- [Backend](#backend)
  - [The calendar day model](#the-calendar-day-model)
- [Invariants](#invariants)
- [Adding things](#adding-things)
- [Verifying a change](#verifying-a-change)

## The whole system

```
   ┌──────────────────────────────┐        ┌───────────────────────────────┐
   │ Browser                      │        │ server.js                     │
   │                              │  /ws   │                               │
   │  public/app.js  ─────────────┼───────►│  KaceySession                 │
   │  public/js/{core,ui,voice,   │◄───────┤    one connection == one       │
   │             net}             │ frames │    continuous query()         │
   │                              │        │                               │
   │  wake-voice.js  (classic)    │  HTTP  │  /api/health  /api/voices     │
   │  closing.js     (classic)    │◄──────►│  /api/calendar  /api/tts      │
   └──────────────────────────────┘        └───────────────┬───────────────┘
                                                           │
                                     Claude Agent SDK      │
                                     @anthropic-ai/…       ▼
                                                  ┌────────────────────┐
                                                  │ klaus_memory MCP   │
                                                  │ python -m …        │
                                                  │ → klaus.db         │
                                                  └────────────────────┘
```

Speech never touches the server as audio. The browser turns voice into text and
text into voice; the wire carries JSON only. The one exception is `/api/tts`,
which proxies a sentence to a local XTTS server and returns a WAV — still not the
microphone, and still never leaving the machine.

## Frontend

Vanilla JS, native ES modules, **no build step and no dependencies**. The browser
loads `public/app.js` as `<script type="module">` and resolves the rest. There is
nothing to compile, nothing to install, and no generated file to keep in sync.

`app.js` does one job: boot. Restore preferences, subscribe the orb's followers,
wire the DOM, start the transport — in that order, because the order is the only
part of it that can be wrong. It contains no application logic.

### The rules

Three rules decide where new code goes. They are worth more than the directory
names themselves.

**1. `core/` is a sink.** It imports nothing outside itself, and everything else
reads it. That is the one rule with no exceptions: if a `core/` module ever needs
something from `ui/`, the thing being imported was misplaced, not the rule.

Beyond `core/`, the graph is **not** a hierarchy, and it is worth being straight
about that rather than drawing a tidier picture than the code deserves:

```
                    ┌──────────────────┐
                    │      core/       │   imports nothing outside itself
                    │  state  i18n     │   everything reads it
                    │  dom    bus      │
                    └────────▲─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
         ┌────┴────┐    ┌────┴────┐    ┌────┴────┐
         │   ui/   │◄──►│  voice/ │◄──►│   net/  │
         └────┬────┘    └─────────┘    └────┬────┘
              └────────────◄──►─────────────┘

              debug.js reaches into all four, on purpose
```

Those three are mutually dependent because a voice interface genuinely is: the
transcript feeds the speech synthesiser, the synthesiser raises alerts through the
transcript's own alert strip, dictation submits through the protocol, and the
protocol paints. Pretending otherwise would mean routing every one of those
through an event bus and making the control flow unreadable to buy an acyclicity
nobody benefits from.

So what the directories buy is not acyclicity — it is **locality**. You can read
`voice/` as a unit and understand the microphone. The crossings that do exist are
few enough to name, and each is one idea:

| Crossing        | What actually crosses                                          |
| --------------- | -------------------------------------------------------------- |
| `ui/ → voice/`  | `log` feeds text to `feedTTS`; `labels` and `voice-picker` ask what the engines can do |
| `voice/ → ui/`  | Painting: `log` `orb` `telemetry`                               |
| `voice/ → net/` | `recognition` calls `submit`; `commands` calls `sendFrame`      |
| `net/ → ui/`    | Painting, plus `refreshCalendar` after a calendar tool          |
| `net/ → voice/` | `protocol` drives speech, dictation and the command handlers    |
| `ui/ → net/`    | One function: `labels` reads `readyInfo()` to re-label the pill |

If a new crossing is more than one idea, that is the signal something is in the
wrong directory.

**2. One owner per piece of mutable state.** A second copy of "are we listening"
is a bug waiting for a race to find it. Shared state lives in `core/state.js`;
everything else is private to its module and reached through functions. That is
why `telemetry.js` exposes `noteTurn()` rather than a counter, and why
`barge.js` owns the echo-guard string that `tts.js` writes into.

**3. Anything derived is derived in one place.** The orb is the example: nothing
sets it, everything changes `state` and calls `syncOrb()`.

### The four directories

Grouped by **what a module talks to**, not by what it is called.

#### `core/` — nothing outside itself

| Module      | What it owns                                                |
| ----------- | ----------------------------------------------------------- |
| `state.js`  | The shared state bag, the `kacey.*` storage keys, `?mock=1`  |
| `i18n.js`   | Every user-visible string, in both languages                 |
| `dom.js`    | The elements of the main chrome, resolved once               |
| `bus.js`    | Four lines of pub/sub, for the orb's followers and nothing else |

`state.js` does **not** read localStorage. Restoring preferences is boot's job,
because it has to happen once, in a known order.

`dom.js` resolves elements at import time, which is safe because a module script
is deferred until the document has been parsed. It holds only the shared
furniture — a panel's own elements are looked up by the module that owns the
panel, so a panel can be read on its own.

#### `ui/` — the DOM: what is on screen and how it is labelled

| Module            | What it owns                                            |
| ----------------- | ------------------------------------------------------- |
| `orb.js`          | The state machine every other module reports into        |
| `log.js`          | The transcript, the status line, the alert strip         |
| `telemetry.js`    | The HUD rails                                            |
| `labels.js`       | Re-labelling the chrome when language or mute changes    |
| `theme.js`        | One hue drives the whole interface                       |
| `voice-picker.js` | The voice select, and its fallback when XTTS is not running |
| `calendar.js`     | The calendar viewer — see [the day model](#the-calendar-day-model) for what the server hands it |

`voice-picker.js` is here rather than in `voice/` because it is a form control
that persists a preference. The engine it selects lives in `voice/tts.js`.

#### `voice/` — the microphone and the speakers, and who may hold them

| Module           | What it owns                                                |
| ---------------- | ----------------------------------------------------------- |
| `sentences.js`   | Sentence boundaries — pure, no DOM, no state, no imports      |
| `chime.js`       | The two confirmation sounds, and the Web Audio unlock         |
| `tts.js`         | Speaking the reply aloud: browser engine or XTTS              |
| `recognition.js` | Dictation — the microphone the user presses                   |
| `commands.js`    | "to je vše" / "ticho" — said to the interface, not to Kacey   |
| `barge.js`       | Hearing "ticho" while she is still talking                    |
| `wake.js`        | The wake word, and which detector holds the microphone        |
| `wake-panel.js`  | The voice-template detector and its tuning sheet              |

This is the largest group and deliberately so: exactly one thing may hold the
microphone at a time, and that constraint is what ties these eight files
together. See [the microphone](#the-microphone-three-listeners-one-device).

`sentences.js` is the one piece of the frontend with no environment at all, which
makes it the one piece that can be unit tested directly.

#### `net/` — the wire

| Module                                    | What it owns                        |
| ----------------------------------------- | ----------------------------------- |
| `transport-socket.js`                     | The real WebSocket, with backoff and bfcache revival |
| `transport-mock.js`                       | The same interface, scripted, for `?mock=1` |
| `protocol.js`                             | The frame pipeline both transports feed |

Both transports implement `{ start(), send(obj) -> bool, isOpen(), stop(), resume() }`
and `protocol.js` never knows which one it is holding. That is what makes
`?mock=1` worth having: the mock exercises the same pipeline as the real thing, so
anything that works in mock mode works for real.

#### `debug.js` — outside all four

`window.kacey` and `window.kaceyWake` deliberately reach into every layer, so
putting this in one of them would be a lie about the dependency direction. Each
subsystem exports its own `…Status()` function and `debug.js` composes them — a
new flag appears in the readout by being added next to the flags it belongs with.

### What is not a module

Three files in `public/` stay **classic scripts**:

| File               | Why it is not a module                                        |
| ------------------ | ------------------------------------------------------------- |
| `wake-voice.js`    | `test/wake-dsp.mjs` and `test/wake-pipeline.mjs` load it with `new Function(src)` |
| `closing.js`       | `test/closing.mjs` loads it the same way                       |
| `wake-worklet.js`  | Fetched by the browser at a relative URL, as an AudioWorklet   |

They expose `window.KaceyWakeVoice` and `window.KaceyClosing`. Classic scripts run
**before** deferred module scripts, so both globals exist by the time `app.js`
boots — `index.html` loads them in that order and the ordering is load-bearing.

This is a real trade: two globals in exchange for tests that need no browser and
no DOM shim. Given that both files hold the trickiest logic in the frontend (DSP
and phrase matching), the tests are worth more than the purity.

## A turn, end to end

Worth reading once. Almost every bug lives somewhere on this path.

**Outbound** — the user says or types something:

```
recognition.js  onresult (final)          or  app.js  form submit
        │                                          │
        └──────────────► protocol.js  submit(text) ◄┘
                              │
                    ┌─────────┴─────────┐
                    │ is it a command?  │  window.KaceyClosing.classify()
                    └─────────┬─────────┘
                    yes       │        no
             commands.js      │        cancelSpeech()  — silence the old answer
             bargeIn() or     │        telemetry noteTurn()
             endListening()   │        log.js  addMessage('user')
             ↑                │        transport.send({ type: 'user_message' })
             nothing is sent, │
             nothing is logged▼
                                                        ──────► server
```

**Inbound** — frames arrive and fan out from one switch in `protocol.js`:

| Frame      | What happens                                                     |
| ---------- | ---------------------------------------------------------------- |
| `ready`    | Build the connection line, set the model rail, flash the hint     |
| `session`  | Record the session id on `state`, show it in the pill's title     |
| `thinking` | `state.streaming = true`, swap send→stop, open a bubble           |
| `delta`    | `log.appendDelta()` → text into the bubble **and** into `feedTTS()` |
| `tool`     | First one of the turn seals the preamble bubble and speaks it now; refreshes the calendar on the way out |
| `done`     | `flushTTS()`, close the bubble, re-open the mic if nothing will speak |
| `error`    | `cancelSpeech()`, close quietly, alert, and stop the hands-free loop |

Speech starts before the reply has finished arriving: `appendDelta` feeds
`sentences.js`, and every complete sentence is spoken as soon as it is whole.

## The orb: one derived state

The orb is the single answer to "what is happening right now". Nothing assigns it.
Modules change `state` and call `syncOrb()`, which recomputes it:

```
error      Date.now() < state.errorUntil      (an alert, briefly)
offline    state.conn !== 'online'
speaking   state.ttsPending > 0               audio wins — it is what the user perceives
thinking   state.streaming
listening  state.listening
idle       otherwise
```

Three things **follow** the orb rather than being called by it, and subscribe on
the bus (wired in `app.js`, in this order):

1. `telemetry.updateTelemetry` — the HUD rails
2. `barge.superviseBarge` — the interrupt listener lives and dies with the spoken reply
3. `log.followOrbHint` — the ambient hint text, unless a flash owns it

They are observers: each already imports the orb to read its state, so publishing
instead of calling keeps that arrow pointing one way. The event fires on **every**
`syncOrb()`, not only on transitions, because the followers track things the orb
state does not capture (queue depth, session id, whether the mic can be taken).

## The microphone: three listeners, one device

The browser will not let two `SpeechRecognition` instances hold the microphone at
once, and the local voice detector holds it through `getUserMedia`. So there are
four possible holders and a supervisor that ensures at most one is live.

| Listener                     | Lives in           | Runs when                                    |
| ---------------------------- | ------------------ | -------------------------------------------- |
| Dictation                    | `recognition.js`   | The user pressed the mic, or a wake word fired |
| Wake word (transcript)       | `wake.js`          | Idle, online, visible, not speaking — and the voice detector is not usable |
| Wake word (voice template)   | `wake-panel.js`    | Same, but preferred whenever samples are enrolled |
| Barge-in                     | `barge.js`         | **Only** while a reply is actually being spoken |

Arbitration is `wake.superviseWake()`, called from a 1.5s interval; barge-in gets
its own 300ms interval because a reply only lasts seconds. Both are dull polling
loops rather than hooks on every transition (dictation start/stop, TTS, tab
switch, reconnect, engine timeout) for one reason: **polling cannot get wedged**,
and this is something that is supposed to be listening whenever you are not.

Two guards are easy to miss and both exist because of real failures:

- **Feedback loop.** `tts.js` stops dictation before it speaks and re-opens it once
  the queue drains, so the microphone never hears Kacey.
- **Self-hearing.** The barge-in listener hears her through the speakers. Before
  acting on "ticho" it checks whether the reply being spoken contains the word —
  `barge.js` owns that text, because it is the only module that reads it.

## Who owns which state

| State                                    | Owner                | Reached through            |
| ---------------------------------------- | -------------------- | -------------------------- |
| lang, muted, conn, streaming, listening, micDesired, ttsPending, … | `core/state.js` | Direct field access, one bag |
| Persisted `kacey.*` keys                 | `core/state.js`      | Names only; boot does the reading |
| The current orb state                    | `ui/orb.js`          | `orbState()`               |
| Hint lock, the streaming bubble           | `ui/log.js`          | `flashHint()` `unlockHint()` |
| Turn / tool / synthesis counters           | `ui/telemetry.js`    | `noteTurn()` `noteTool()` `noteSynthMs()` |
| Hue                                      | `ui/theme.js`        | `initTheme()` only         |
| Voice queue, XTTS generation token        | `voice/tts.js`       | `feedTTS()` `flushTTS()` `cancelSpeech()` |
| Composer prefix (`baseText`)              | `voice/recognition.js` | `clearBaseText()`        |
| Echo-guard text                          | `voice/barge.js`     | `noteSpoken()` `clearSpoken()` |
| Wake on/off, mic-refused flag             | `voice/wake.js`      | `wakeIsEnabled()` `setWakeBlocked()` |
| Wake mode, panel-open, samples             | `voice/wake-panel.js` | `wakeMode()` `setWakeMode()` |
| The transport, `readyInfo`, tool depth     | `net/protocol.js`    | `sendFrame()` `readyInfo()` |
| Calendar month, loading flag               | `ui/calendar.js`     | `refreshCalendar()`        |

## The two import cycles

Two pairs of modules import each other. Both are intentional, both describe a
real mutual constraint, and both are safe.

```
voice/tts.js  ◄──►  voice/recognition.js
    speech has to close the microphone;
    the microphone has to silence speech

voice/wake.js ◄──►  voice/wake-panel.js
    one arbiter, two detectors, and a button
    label that must describe whichever is live
```

**Why they are safe.** ES modules permit cycles. `export function` declarations
are hoisted and initialised before any module body runs, and imported bindings are
live. Every crossing in both cycles is a function *call*, made long after both
modules have finished evaluating.

**The rule that keeps them safe:** across a cycle boundary, export only functions.
Never read an imported `const`/`let`/`var` at module evaluation time — that is the
one case where a cycle throws. This is also why `readyInfo` and `wakeMode` are
accessor functions rather than exported variables.

Everywhere else, prefer the bus or an explicit parameter over a new cycle. The
mock transport receives `submit` as an argument for exactly this reason.

## Backend

`server.js` is one file on purpose — it is one concern (bridge the browser to the
SDK) and splitting it would mean inventing seams that the code does not have.

| Section                | What it does                                                |
| ---------------------- | ----------------------------------------------------------- |
| Configuration          | Every knob from the environment, all with working defaults   |
| `MCP_SERVERS`, `MEMORY_TOOLS` | The `klaus_memory` launch command and the tool allow-list |
| Persona loading        | `persona/kacey.md` read at startup, `{{TODAY}}`/`{{NOW}}` rendered per connection |
| `KaceySession`         | One WebSocket == one continuous `query()` in streaming-input mode |
| HTTP routes            | `/api/health` `/api/voices` `/api/calendar` (+ update/delete) `/api/tts`, then static `public/` |
| WebSocket              | `/ws`, JSON frames, one `KaceySession` per connection        |

Two things about `KaceySession` that the frame protocol does not show:

- The conversation is **continuous**. One `query()` call runs in streaming-input
  mode and user turns are pushed into it, so Claude remembers earlier turns
  without any history replay. `interrupt` aborts the in-flight turn and leaves the
  session usable.
- Assistant text reaches the browser **only** as `delta`. Thinking blocks, tool
  JSON, status events and model errors are filtered out or converted to `error`
  frames, because the browser speaks `delta` aloud.

The frame contract, the configuration table and the tool allow-list rationale are
in [README.md](README.md) — they are reference material, not structure.

### The calendar day model

`GET /api/calendar` does more than read rows, and the rules are not guessable
from the SQL. Three of them interact.

**A day starts at 04:00.** `LOGICAL_DAY_START_HOUR` exists so that something at
01:00 counts as the previous evening rather than as tomorrow, which is how people
actually talk about their day and how the persona is told to reason about it.

**All-day events opt out of that shift.** The sync materialises them as whole
clock days — midnight to midnight with an *exclusive* end, or midnight to 23:59.
Applying the 04:00 shift to those would file a holiday starting at 00:00 on the
26th as starting on the 25th, and ending a day early. `isAllDay()` detects the
shape (starts at 00:00, ends on a day boundary, at least 20 hours long) and uses
plain calendar days for it. This distinction is also what lets the UI say
"celý den" instead of inventing a clock time.

**An event occupies a range of days, not one.** `dayRangeOf()` returns the
inclusive `[first, last]` span and the day list is built by overlap, so a
fortnight in July/August appears on every day it covers. Ends are exclusive
throughout: an event finishing at 00:00 — or at 04:00 for a timed one — does not
reach into the day that begins there. Each day's copy of the event carries
`span: { index, count, first, last }`, which is what lets a row say which slice
of the event it is instead of repeating the full time range on all seventeen of
them.

Counts follow the same rule: a spanning event counts once in every month it
touches, so `monthsWithEvents` sends you to a month where something is actually
happening rather than only to months where something *starts*.

`source` and `source_meta` come from the same table. `source` is the calendar the
event came from; `source_meta` is free-form JSON from whatever produced it, so it
is parsed defensively and sent as `null` when it is absent, unparseable, or
empty — the UI then has nothing to decide.

## Invariants

Break one of these and something will go wrong in a way that is hard to trace
back. They are listed here because no single file can enforce them.

1. **`delta` is assistant speech, verbatim, and nothing else.** The browser speaks
   it. A status line leaking in gets read out loud.
2. **Server text reaches the DOM through `textContent` only.** A reply is
   untrusted input; there is no case where Kacey needs to emit markup.
3. **The log mirrors what the model saw.** Anything the browser handled by itself
   — a spoken command, a wake word — must not appear in the transcript.
4. **At most one listener holds the microphone.** Add a fourth and it goes through
   `superviseWake`, not around it.
5. **Unknown frame types are ignored, not fatal.** A newer server must not be able
   to break an older page.
6. **Nothing assigns the orb.** Change `state`, call `syncOrb()`.
7. **Every failure path ends the orb somewhere.** The engines that silently drop
   their end events are why every finish path in `tts.js` is guarded.
8. **All preferences have a usable default.** Reading localStorage throws in
   private mode; that must not be a broken app.
9. **No build step.** No bundler, no transpiler, no generated file in `public/`.

## Adding things

**A new UI panel.** A module in `ui/`, its own element lookups inside it, and one
exported `initX()` called from `app.js`. If it needs an Escape handler, register it
in capture phase and mind the ordering — `initVoiceWake()` runs before
`initTheme()` so that with both sheets open, Escape closes the inner one first.

**A new server frame.** Add a `case` to the switch in `net/protocol.js` and a row
to the wire-protocol table in the README. Existing pages ignore it until they are
reloaded, which is the point of invariant 5.

**A new persisted preference.** Its key goes in `core/state.js` next to the other
`kacey.*` keys. The read goes in `app.js`, or in the owning module's own
`restoreXPref()` if the module is the only thing that cares (`wake.js` does this).

**A new speech engine.** `voice/tts.js` already branches on `state.voice`. Add the
branch, keep the finish-path guards, and offer it through
`ui/voice-picker.js` — including what the picker says when the engine is missing.

**A new spoken command.** The phrase goes in `closing.js` (with a test in
`test/closing.mjs`); what it does goes in `voice/commands.js`. The matcher is
deliberately narrow — read the comment at the top of `closing.js` before widening
it.

**Anything that needs a fourth listener on the microphone.** Reconsider. If it is
genuinely necessary, it gets a `shouldRun()` predicate and a branch in
`superviseWake`, like the three that already exist.

## Verifying a change

No browser needed:

```bash
npm run test:wake
```

Covers the wake-word DSP, the wake pipeline and the spoken-command matcher — the
three pieces with logic worth asserting on.

In a browser, `?mock=1` replays the full frame sequence with no backend, no API
key and no memory database:

| URL                        | What it gives you                              |
| -------------------------- | ---------------------------------------------- |
| `?mock=1`                  | A working UI, scripted replies                 |
| `?mock=1&say=<text>`       | Auto-submits one turn on connect               |
| `?hue=<0-359>`             | Override the theme for this load only          |
| `?openSettings=1`          | Open the dial on load                          |

Type `/error`, `/offline` or `/long` in mock mode to exercise those branches.

From the console, `window.kacey` and `window.kaceyWake` reach the paths that need
a microphone and the right room:

```js
kacey.state                  // the live state bag
kacey.orb()                  // current orb state
kacey.send('ahoj')           // as if typed
kacey.inject({ type: 'done' })  // as if the server sent it
kacey.barge()                // barge-in listener status
kaceyWake.status()           // both detectors, every flag
kaceyWake.feed('káčé')       // trigger the transcript path with no mic
kaceyWake.fireVoice()        // trigger the voice path with no mic
```
