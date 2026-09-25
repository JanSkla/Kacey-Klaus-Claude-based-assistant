# D.R.E.A.M. — Kacey's night routine

How Kacey gets from "going to bed" to "here is your day", and why each step is
built the way it is.

This is a **spec**, written before any of it exists. Every implementation session
reads it first, builds one phase, and updates it if the build changes the design.
Like [ARCHITECTURE.md](../ARCHITECTURE.md), it explains structure and invariants,
not every line. The reasoning sits next to each decision, so a later session can
tell a deliberate choice from an accident.

**Status:** P3 (sleep detection) has landed, with the night run still a stub.
The rest is planned. Phases P1–P7 are in [§16](#16-phases). A phase that ships
moves its row from *planned* to *done* and records the commit.

## Contents

- [1. What it is, and what it is not](#1-what-it-is-and-what-it-is-not)
- [2. Where it runs](#2-where-it-runs)
- [3. The day cycle](#3-the-day-cycle)
- [4. Time: which day a run is for](#4-time-which-day-a-run-is-for)
- [5. lightsd: morning_peak_at](#5-lightsd-morning_peak_at)
- [6. Kiosk, screen, lid](#6-kiosk-screen-lid)
- [7. Sleep detection](#7-sleep-detection)
- [8. Rules](#8-rules)
- [9. Generated tasks](#9-generated-tasks)
- [10. The night run](#10-the-night-run)
- [11. Proposals](#11-proposals)
- [12. Morning mode](#12-morning-mode)
- [13. The learning loop](#13-the-learning-loop)
- [14. Settings](#14-settings)
- [15. Server surface, for reference](#15-server-surface-for-reference)
- [16. Phases](#16-phases)
- [17. Rules of work](#17-rules-of-work)
- [18. Decisions made in this spec, and open questions](#18-decisions-made-in-this-spec-and-open-questions)

---

## 1. What it is, and what it is not

Once you are asleep, Kacey **plans the next day**. Deterministic rules turn the
calendar and the weekly routine into tasks ("pack the gym bag the evening
before"). A reasoning pass looks for what the rules missed and turns it into
*proposals* that you accept or reject. Then she writes the morning brief. In the
morning, as the sunrise lamp reaches full brightness, she reads the brief aloud
and shows a fixed morning checklist.

**It is not Klaus's D.R.E.A.M.** `klaus_memory/dream.py` is memory consolidation
(acquisition, reinforcement, elimination over the day's turns). This feature
neither calls it nor changes it. The persona still forbids `dream_run` and
`dream_catchup`, and that stays true. The shared name is historical, so the code
avoids the bare word `dream` wherever a reader could confuse the two:

| Here                         | Not                     |
| ---------------------------- | ----------------------- |
| `kacey_dream_run` (table)    | `consolidation_run`     |
| `POST /api/night/run`        | `dream_run` (MCP tool)  |
| "noční plánování" (UI copy)  | "noční konsolidace"     |

The table names keep `dream` because the brief asked for them and the `kacey_`
prefix already sets them apart.

**What is borrowed from Klaus** is only its robustness pattern, because that
pattern was built from real failures (`dream.py` findings A10, C4):

- **Idempotent per logical date.** A second run for the same day does nothing,
  so a retry after a crash is safe.
- **Catch-up.** Missing a night does not depend on the machine being up at a
  fixed hour.
- **Stuck runs are reset.** A run left `running` longer than a limit is marked
  failed and becomes eligible again.

---

## 2. Where it runs

**kaceybody**: an Ubuntu laptop on the bedside table, with speakers and a screen.
Two long-running services live there:

| Service  | Port | Owns                                                    |
| -------- | ---- | ------------------------------------------------------- |
| `kacey`  | 8082 | This repo. Sleep state, the night run, morning mode.    |
| `lightsd`| 8080 | `project-kacey-finds-home/tools/lights`. Lamps, the sleep button, sunrise. |

**The capability boundary.** Claude can update files on kaceybody but **cannot**
restart services or change system configuration. So every system-level step
(display server, autologin, kiosk browser, logind, permissions, packages) goes
into a hand-run runbook, **[docs/RUNBOOK-kaceybody.md](RUNBOOK-kaceybody.md)**,
created in P2. It has one section per phase, and each command is followed by a
way to check it worked. A phase that needs the runbook is only *done* once the
user reports the steps ran. Until then it is *done, awaiting runbook*.

The code must also degrade on a machine without any of this (the Windows dev
box, CI). `screen.js` becomes a logged no-op off Linux or when `xset` is
missing. The lid reads as `unknown`. A lightsd that cannot be reached means "no
sleep signal", not a crash.

---

## 3. The day cycle

```
          lightsd sleep button (POST /api/sleep)
 awake ─────────────────────────────────────► winding_down(since)
   ▲  ▲                                           │  60 min, no interaction
   │  │ interaction                               ▼
   │  └───────────────────────────────────── asleep(since) ──► NIGHT RUN
   │                                              │              (once per target date)
   │  lightsd releases sleep at wake_at           │
   └──────────────────────────────────────────────┘   the sunrise ramp starts, dim and warm
                                                  ⋮
                            morning_peak_at − 5 min: brief still fresh? if not, rewrite it
                            morning_peak_at: lid open? → screen on, `morning` frame,
                                             brief read aloud, morning checklist shown
                                                  ⋮
                            every item ticked → "hotovo" → idle
                            or 09:00 with no interaction since the brief → idle
```

Ownership is split along one line: **lightsd owns the light, Kacey owns the
person.** lightsd knows when the room goes dark and when the sunrise starts, and
nothing about tasks, briefs or screens. Kacey subscribes to lightsd and never
drives a lamp. That is the existing contract, stated in `views/lights.js`, and
this feature keeps it. The one change to lightsd (P1) is a new *published fact*,
not a new behaviour.

Kacey's own states (`awake | winding_down | asleep`) are **not** lightsd's sleep
layer. lightsd's sleep is "the room is dark"; Kacey's is "the person is probably
asleep". They start together (the button) but end differently. Kacey's
`winding_down` ends on a timer or on interaction, and lightsd knows neither.

---

## 4. Time: which day a run is for

Everything in Kacey already uses the **logical day**, which starts at 04:00
(`LOGICAL_DAY_START_HOUR`, [ARCHITECTURE.md § The calendar day
model](../ARCHITECTURE.md#the-calendar-day-model)). The night run adds one rule
on top.

**The target date** is the day a run plans. It is computed from the clock at the
moment the run starts:

```
target(now) = logicalToday(now)       if 04:00 <= clock(now) < 12:00
              logicalToday(now) + 1   otherwise
```

| Run starts at          | logicalToday | target |
| ---------------------- | ------------ | ------ |
| Fri 23:50 (sleep)      | Fri          | Sat    |
| Sat 02:10 (sleep)      | Fri          | Sat    |
| Sat 04:00 (fallback)   | Sat          | Sat    |
| Sat 05:30 (catch-up)   | Sat          | Sat    |
| Sat 15:00 (manual)     | Sat          | Sun    |

*Why noon:* a run in the morning is a late run for *this* day (fallback,
catch-up). A run after noon can only be meant for tomorrow. Without this rule,
the 04:00 fallback and a 23:50 sleep trigger would plan different days, and
idempotence per date would break. `targetDate(now)` is a pure function in
`sleep.js` and has its own tests, including both DST changes.

**Local time throughout.** The host runs in Europe/Prague. Dates are
`YYYY-MM-DD`. Times inside a day are `HH:MM`. Instants are ISO strings, as in
`kacey_task.due_at` and `calendar_event.starts_at`. Day arithmetic uses
`addDays()` from `public/js/core/due.js`, which works at noon so a DST change
cannot move a date.

**Resolving lightsd's clock times.** lightsd publishes `wake_at` (and after P1
`morning_peak_at`) as bare `HH:MM`, with no date. Both fall inside lightsd's wake
window (default 04:00–11:00), which is inside the logical day, so for a target
date D the instant is simply `D + HH:MM`. Kacey stores the resolved instant (see
`night.morning` in [§15](#kv-keys)). It never re-derives the instant from a later
status, because after the peak passes lightsd's "next" peak is tomorrow's.

---

## 5. lightsd: morning_peak_at

*Phase P1. Separate repo: `C:\repos\hobby\project-kacey-finds-home\tools\lights`.
Minimal change.*

**The problem.** `wake_at` is the first lit keypoint of the morning, which is the
*start* of the sunrise: dim, around 1800 K. Reading the brief then would mean
talking into a dark room. It should play at the brightest point of the ramp,
which in practice comes about 30 minutes later.

**The definition.** For one lamp, starting at the keypoint that `next_wake_at`
chose:

1. Walk the keypoints forward in clock order, wrapping past midnight.
2. Keep walking while the next keypoint **rises**. It rises if it is `on` and
   either its brightness is higher, or its brightness is equal and its kelvin is
   higher. The equal-brightness case is the "tie → higher kelvin" rule: the same
   brightness at a whiter colour is still the ramp climbing. Kelvin only counts
   for `white`-mode keypoints. For `color` mode, equal brightness does not rise.
3. The peak is the first keypoint where the walk stops (the first local
   maximum).
4. **The walk is bounded**, which is a refinement of the brief (see
   [§18](#18-decisions-made-in-this-spec-and-open-questions)):
   - If the wake keypoint has a `group` (e.g. `"morning"`), only keypoints of
     that group are followed. Groups already exist for exactly this: "the
     morning" as a unit.
   - Otherwise, only keypoints inside the wake window
     (`wake_window_start`–`wake_window_end`) are followed.

   Without the bound, `bedside_schedule()` (06:30 8 % → 07:00 55 % → 09:00 70 %
   → 16:00 70 % at a lower kelvin) would put the peak at 09:00, two and a half
   hours into the day. With the bound it is 07:00, the top of the "morning"
   group. `default_schedule()` has no groups, and the window bound gives 08:00.
5. If the wake point came from the fallback (nothing lit in the window), the
   peak equals `wake_at`.

For the room, the peak is the **earliest across all lamps**, the same way
`Room.wake_at()` takes the earliest ramp start. "When the room is at its
brightest" has no single answer with two lamps. The earliest peak is when the
room first reaches full light, and later is always worse than earlier for a
brief.

**Where it lives.**

- `schedule.py`: `morning_peak_at(keypoints, wake, window_start, window_end) ->
  datetime`. A pure function, taking the wake instant `next_wake_at` returned.
- `arbiter.py`: `Room.morning_peak_at(now)`, the minimum over lamps. It is
  computed from each lamp's own wake instant, not from the room's minimum.
- `Room.status()` gains `"morning_peak_at": "HH:MM"` next to `"wake_at"`,
  published whether or not the room is asleep, for the same reason `wake_at` is.
  While asleep, `sleep` also carries `"morning_peak_at"`, derived from the
  stored `SleepState.wake_at` so it cannot drift if the schedule is edited
  mid-night.
- `/ws` already pushes `engine.status()` about every 200 ms, so the new field
  reaches `/ws` subscribers with no further change.

**Tests** in `tests/test_lightsd.py`, next to the existing sleep tests:
bedside schedule → 07:00, default schedule → 08:00, the tie rule (equal
brightness, higher kelvin → keeps walking; equal brightness, lower kelvin →
stops), a `color`-mode tie stops, the wrap past midnight, two lamps → the earlier
peak, the fallback wake → peak == wake, the status carries both fields, and
editing the schedule while asleep leaves `sleep.morning_peak_at` unchanged.

**What lightsd must not learn.** Nothing about Kacey: no callback URL, no Kacey
endpoint, no "brief" concept. It publishes; Kacey reads.

### How Kacey reads lightsd

`lightsd.js`, a new server module, subscribes to `ws://<LIGHTSD_URL>/ws` with
the `ws` package, which is already a dependency. *Why /ws and not polling:*
lightsd pushes the full status about 5× a second, so a sleep press is seen
within a fraction of a second, and the WebSocket drop is itself the "lightsd went
away" signal. While the socket is down, Kacey polls `GET /api/status` every 30 s
and keeps reconnecting with backoff (1 s → 60 s). Only four fields are read:
`sleep` (object or `null`), `sleep.held_for`, `sleep.minutes_until_wake` and
`morning_peak_at`/`wake_at`.

lightsd reports a *state*, not events. `diffLightsd(prev, next, ctx)` is a pure,
tested function that turns two consecutive statuses into events:

| prev.sleep | next.sleep | Condition                                            | Event          |
| ---------- | ---------- | ---------------------------------------------------- | -------------- |
| `null`     | object     | —                                                    | `sleep_start` (since = now − `held_for`) |
| object     | `null`     | same connection, `prev.minutes_until_wake > 2`       | `awake_early` (an interaction) |
| object     | `null`     | same connection, `prev.minutes_until_wake <= 2`      | `sunrise`      |
| object     | `null`     | the first status after a reconnect                   | none, baseline only |
| —          | —          | first status after a reconnect, `next.sleep` set, Kacey `awake` | `sleep_start` (since = now − `held_for`) |

Three of these rows exist because of how lightsd works:

- **lightsd has no "why sleep ended".** A `DELETE /api/sleep` and reaching
  `wake_at` both turn `sleep` into `null`. They are told apart by how close
  `wake_at` was. Two minutes is well above the 200 ms push interval, and far
  below any real "awake early".
- **lightsd keeps sleep in memory only.** A lightsd restart drops it. After a
  reconnect, a vanished `sleep` is therefore *not* treated as an interaction.
  Otherwise restarting lightsd at 02:00 would wake Kacey's state machine and
  cancel the night.
- **`held_for` backdates the start.** If the button was pressed while Kacey was
  down, the 60-minute timer still counts from the press.

---

## 6. Kiosk, screen, lid

*Phase P2. Mostly runbook. One new server module, `screen.js`.*

### The kiosk

**Target state:** the laptop boots into an **X11** session with autologin, and
that session runs only

```
chromium --kiosk --autoplay-policy=no-user-gesture-required \
         --noerrdialogs --disable-infobars \
         http://localhost:8082
```

- *Why X11:* `xset dpms` does not work under Wayland, and Ubuntu's GDM defaults
  to Wayland (`WaylandEnable=false` in `/etc/gdm3/custom.conf`).
- *Why the autoplay flag:* the morning brief is spoken with no user gesture.
  Without the flag, Chromium blocks audio until the first tap, and the brief
  would be silent. The same applies to XTTS audio elements.
- *Microphone:* the wake word needs `getUserMedia` without a prompt. The runbook
  sets the Chromium policy `AudioCaptureAllowedUrls: ["http://localhost:8082"]`
  in the managed-policies directory. The path differs between snap and deb
  Chromium, and P2 records which one applies. This is scoped to one origin,
  unlike `--use-fake-ui-for-media-stream`, which accepts every prompt.
- *No screen blanking or locking by the desktop:* GNOME's idle-delay,
  screensaver lock and idle suspend are turned off, so `screen.js` is the only
  thing deciding when the panel sleeps.

**P2 starts by finding out what is there now**, and writes the findings into the
runbook before proposing any change:

```bash
loginctl list-sessions
loginctl show-session <id> -p Type -p Desktop -p Name
ps -eo user,cmd | grep -Ei 'chrom|firefox' | grep -v grep
echo $XDG_SESSION_TYPE; ls -l /run/user/$(id -u)/gdm/Xauthority ~/.Xauthority
```

### The screen: DPMS

The panel is **off by default** and turned on by software. `screen.js` owns this:

| Function          | What it does                                                    |
| ----------------- | --------------------------------------------------------------- |
| `on(reason)`      | `xset dpms force on`; starts the idle clock                      |
| `off(reason)`     | `xset dpms force off`                                            |
| `status()`        | `{ state: on|off|unknown, since, reason, idle_ms }` for the readout |

Commands run with `DISPLAY` and `XAUTHORITY` from `config.js`
(`KACEY_DISPLAY`, default `:0`; `KACEY_XAUTHORITY`, default the path P2
records). Kacey runs as the kiosk user, so no privilege is needed. Every call is
logged with its reason (`[screen] on (wake word)`), because "why did the screen
come on at 3 am" must be answerable from the log.

**Turned on for:** the wake word, speech or an alert the server starts, and
morning mode. **Forced off:** when `winding_down` starts, and after the idle
timeout.

**The idle timeout** (default 2 min, [§14](#14-settings)) counts from the latest
of: the last interaction, the end of speech, and the X server's own input idle
time. *Why include X idle:* mouse and keyboard wake a DPMS-off panel through the
OS by themselves, without Kacey knowing. A timer that only counted Kacey's
events would then never turn that panel back off. So `screen.js` checks every
10 s: if the monitor is on (`xset q` reports "Monitor is On") and nothing,
including X input (`xprintidle`, installed by the runbook), has happened for the
timeout, it forces the panel off. X's own DPMS timers are disabled
(`xset s off; xset dpms 0 0 0`) so there is exactly one owner. That is rule 2 of
the frontend applied to the backend.

A mouse *move* wakes the panel (the OS does that) but is **not** an interaction
for sleep detection ([§7](#7-sleep-detection)). Waking the screen is harmless.
Cancelling the night because a cat walked across the touchpad is not.

**Verify in P2: does Chromium hide the page when the panel is off?** The wake
word only listens while `document.visibilityState === 'visible'` (the wake
predicate in `voice/wake.js`, [ARCHITECTURE.md § The
microphone](../ARCHITECTURE.md#the-microphone-three-listeners-one-device)). DPMS
normally does not unmap windows, so the page should stay visible. That must be
*measured*, not assumed:

1. The page logs every `visibilitychange` to the server (a debug line is enough).
2. Force the panel off, wait 5 min, say "KC", and check whether the wake word
   fired.
3. Repeat with the lid closed. On some setups GNOME disables the internal output
   (`xrandr`) when the lid closes, which *can* occlude the window.

If the page does go hidden, fix it in this order: Chromium flags
(`--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
--disable-background-timer-throttling`). If that is not enough, change the wake
predicate to accept `hidden` when the page runs as the kiosk (`?kiosk=1` in the
kiosk URL, recorded in `core/state.js`). Record the outcome in this section.

### The lid

`readLid()` reads `/proc/acpi/button/lid/*/state` (`state:      open` /
`closed`). A missing file gives `unknown`, and **`unknown` counts as open**
wherever a decision depends on it. Skipping the brief because we could not read
a lid is worse than playing it into a closed laptop.

Runbook: a logind drop-in, `/etc/systemd/logind.conf.d/kacey-lid.conf`, with
`HandleLidSwitch=ignore`, `HandleLidSwitchExternalPower=ignore` and
`HandleLidSwitchDocked=ignore`, applied by a **reboot**.
`systemctl restart systemd-logind` can end the graphical session, which on a
kiosk means a black screen until someone logs in.

### The readout

The controller's `readout` gains a block **Noc**: screen (on/off, since, why),
lid, sleep state (and since when), next night run (target date, what triggers
it), last run (date, status, how long). It is fed by `GET /api/night` and the
`night_state` frame ([§15](#15-server-surface-for-reference)). It uses the
existing `readout__row` component. That is a small UI change, logged in
DESIGN.md with `[design: pending]`. Rows are added phase by phase as their data
starts to exist.

---

## 7. Sleep detection

*Phase P3. Server module `sleep.js`: a pure state machine plus persistence.*

### States

| State          | Stored as                                             |
| -------------- | ----------------------------------------------------- |
| `awake`        | `{ state: 'awake', since, reason }`                   |
| `winding_down` | `{ state: 'winding_down', since, until }`             |
| `asleep`       | `{ state: 'asleep', since }`                          |

Stored in `kacey_kv` under `night.sleep`, so a restart does not lose the night.
**Nothing keeps time in memory.** A `setTimeout` for "60 minutes from now" dies
with the process. A 30 s scheduler tick (`night.js`) instead re-evaluates
everything from stored instants. That is the same argument ARCHITECTURE.md makes
for the wake supervisor: polling cannot get wedged.

### Transitions

`sleepStep(state, event, now, settings) -> { state, effects[] }` is pure. The
effects (`screen_off`, `start_run`, `broadcast`) are carried out by `night.js`.
Tests drive the function directly.

| From           | Event                         | To                        | Effects |
| -------------- | ----------------------------- | ------------------------- | ------- |
| any            | `sleep_start` (lightsd button) | `winding_down(since, until = since + delay)` | `screen_off` |
| `winding_down` | `interaction`                 | `awake(reason: interaction)` | the timer is gone with the state |
| `winding_down` | `tick`, now ≥ `until`         | `asleep(since = until)`   | `start_run(trigger: sleep, at: until)` |
| `asleep`       | `interaction`                 | `awake(reason: interaction)` | a run already started keeps going |
| `asleep` / `winding_down` | `sunrise` (lightsd released at `wake_at`) | `awake(reason: sunrise)` | **not** an interaction |
| any            | `tick`, fallback ≤ now < fallback + 60 min, no run row for `target(now)` | unchanged | `start_run(trigger: fallback)` |

- **The next button press starts over.** `sleep_start` from any state resets
  `since`/`until`, so pressing again after a wake-word blip gives a fresh 60
  minutes.
- **`asleep.since = until`, not the tick time.** A tick up to 30 s late does not
  move the recorded bedtime, and a restart across the deadline records the
  deadline.
- **The run is dated by the deadline** (`at: until`), not by the tick that
  noticed it. A deadline at 11:59:50 seen by a tick at 12:00:10 still plans the
  deadline's day under the noon rule of §4.
- **The fallback does not care about state.** If there is no run for the target
  date at 04:00 (`LOGICAL_DAY_START_HOUR`, as a setting), it starts, even if you
  are still awake. The run is once per target date, so a button press later that
  night does not run it again ([§10](#10-the-night-run)).
- **The fallback window is one hour** (`FALLBACK_WINDOW_MIN`). A restart at 04:20
  still counts. A server booting at 11:00 does **not** plan a morning that is
  over, because a late boot is catch-up's call, and catch-up checks whether the
  brief is still ahead ([§10](#10-the-night-run)). *Found while building P3:* with
  the window running to noon, the first boot at 11:56 ran the night for a day
  half gone.

**As built in P3:** `sleep.js` exports `sleepStep`, `normalizeSleep`,
`targetDate` and `fallbackDue`, all pure. `night.js` holds the state in kv
`night.sleep`, ticks every 30 s (`NIGHT_TICK_MS`), and pushes `night_state` on
every change. Until P5 the run is a stub. It logs, and records
`{ logical_date, trigger, started_at, status: 'done', stub: true }` in kv
`night.last_run`, which is what "once per target date" checks for now. P5
replaces that with `kacey_dream_run` and must also skip a sleep-triggered run
whose target morning has already passed. A restart many hours after the
deadline otherwise starts a stale run, the same case catch-up refuses.

`targetDate()` works from the wall clock ("the calendar date, or tomorrow from
noon") rather than from `logicalToday()`. `due.js`'s `logicalToday()` subtracts
4 h of milliseconds, which returns the previous date between 04:00 and 04:59 on
the spring DST day. The test for 2027-03-28 is what caught it.

### What counts as interaction

| Signal                                          | Where it arrives                     | Interaction? |
| ----------------------------------------------- | ------------------------------------ | ------------ |
| Wake word                                       | page → `interaction {kind:'wake'}`   | yes          |
| `user_message` (typed or dictated)              | the existing frame                   | yes          |
| `pointerdown` / `keydown` / `touchstart` in the page | page → `interaction {kind}`, throttled to one per 10 s | yes |
| lightsd `DELETE /api/sleep` (awake early)       | `lightsd.js` → `awake_early`         | yes          |
| Mouse move, OS wake of the panel                | —                                    | **no**       |
| lightsd reaching `wake_at`                      | `lightsd.js` → `sunrise`             | **no**       |

The page sends `interaction` only when the server's `ready` frame lists
`features: ['night']`. *Why:* today `server.js` answers an unknown client frame
with an `error` frame, which pops an alert. A new page talking to an old server
must not start throwing alerts. (The server side of invariant 5 runs the other
way. The page ignores unknown frames, the server does not.)

---

## 8. Rules

*Phase P4. Deterministic: data, not code.*

A rule says: *when the calendar or the routine has X, create task Y at time Z.*
Rules are rows, not functions, so Kacey can create them from speech and the UI
can edit them. Anything that needs judgement belongs to the reasoning pass
([§10](#10-the-night-run)), never to a rule.

### Schema

```sql
CREATE TABLE IF NOT EXISTS kacey_ruleset (
  ruleset_id  TEXT PRIMARY KEY,                 -- 'rs_' + random
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kacey_rule (
  rule_id     TEXT PRIMARY KEY,                 -- 'rl_' + random
  ruleset_id  TEXT NOT NULL REFERENCES kacey_ruleset(ruleset_id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  trigger     TEXT NOT NULL,                    -- JSON, below
  timing      TEXT NOT NULL,                    -- JSON, below
  task        TEXT NOT NULL,                    -- JSON, below
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

They follow db.js conventions: TEXT keys, ISO timestamps, `updated_at` on
everything, `IF NOT EXISTS`, `kacey_` prefix. `PRAGMA foreign_keys = ON` is
already set, so deleting a ruleset deletes its rules. A rule is active only when
both it and its ruleset are enabled. That is what makes rulesets useful: switch
off "Posilovna" as a whole for a holiday week.

The JSON columns are validated by **one zod schema** in `rules.js`, shared by the
HTTP endpoints, the agent tools and the loader. A row that fails validation on
load is skipped and reported (`rules: rl_x invalid: …`), never fatal. A bad rule
must not stop the other rules from running.

### trigger

```jsonc
{
  "sources": ["calendar", "routine"],        // non-empty subset
  "calendar_match": ["posilovna", "gym"],    // required if sources has 'calendar'
  "routine_category": "gym",                 // required if sources has 'routine'
  "routine_note_match": ["běh"],             // optional
  "starts_before": "10:00"                   // optional
}
```

**Keyword matching** is the part that is easy to get subtly wrong, so it is
specified exactly and tested:

1. Normalize both sides: NFD, strip combining marks, lower-case (`Běh` → `beh`).
   Tokens are runs of `[a-z0-9]`.
2. A **single-word keyword** of 5 or more characters matches a token that
   *starts with* the keyword minus its last character. A keyword shorter than 5
   characters must *equal* a token.
3. A **multi-word keyword** matches when its tokens appear consecutively, each
   one matching by rule 2.

*Why:* Czech inflects the end of a word. `posilovna` has to match "posilovnu"
and "posilovně", and `fitko` has to match "fitku". So long keywords match on a
stem. Short keywords would match everything as stems (`run` → "brunch",
`beh` → "během", which means "during"), so they must match exactly. The cost is
that `run` does not match "running". The fix for that is another keyword, and
`rule_preview` exists to show it before anything is created.

- **`routine_category`**: one of the routine categories (`routine gym work study
  free commute`). The list moves to `public/js/core/routine-cats.js`, a pure file
  with no DOM and no imports, like `due.js`, imported by `views/routine.js`,
  `app-tools.js` and `rules.js`. Today it is duplicated by hand in two places,
  and a third copy would be one too many.
- **`routine_note_match`**: matched against the block's note (the note is stored
  on the block's first slot). A block with no note does not match.
- **`starts_before`**: the event's or block's start must be earlier than this.
  Compared in *logical* minutes, where 00:00–03:59 counts as 24:00–27:59, so a
  01:00 event is late on the previous day and not early. An **all-day event
  never satisfies `starts_before`**, since it has no start time to compare.

**What a match yields: an occurrence.**

- Calendar: one occurrence per matching event, on the event's **first** logical
  day. A three-day "Posilovna camp" does not create three evening reminders. The
  first day and the all-day rule reuse `dayRangeOf()`/`isAllDay()`, which move
  out of `server.js` into a pure `calendar-days.js`, unchanged, so the calendar
  view and the rule engine cannot disagree about which day an event is on.
- Routine: one occurrence per matching **block** (a contiguous run of one
  category, as `blocksFor()` computes it) per date, on the weekday the grid says.
- Calendar events from a source switched off in the controller
  (`settings.sources.cal_*`) are ignored. If you turned a calendar off, the rules
  should not act on it either.

### timing

```jsonc
{ "anchor": "evening_before", "at": "20:00" }
{ "anchor": "morning_of",     "at": "07:00" }
{ "anchor": "before_start",   "offset_min": 60 }
```

| anchor           | due_at                                          | default   |
| ---------------- | ----------------------------------------------- | --------- |
| `evening_before` | the occurrence's logical date − 1 day, at `at`  | `at` 20:00 |
| `morning_of`     | the occurrence's logical date, at `at`          | `at` 07:00 |
| `before_start`   | occurrence start − `offset_min`                 | 60 min    |

A due time is always a **timed** `due_at` (`YYYY-MM-DDTHH:MM`), so the task shows
in the calendar lane and has a real moment. `before_start` on an all-day event
has no start, so it becomes a *dated* `due_at` (that day, no time). `at` in
00:00–03:59 means that night, the same logical-minute rule as above.

### task

```jsonc
{
  "label": "Sbalit tašku na posilovnu",   // required, 1–120 chars
  "meta": "",                              // optional; default: 'pravidlo „<rule name>“'
  "duration_min": 10,                      // optional, 5–1440, timed due only
  "checklist": ["Ručník", "Láhev", "Boty"] // optional, ≤ 20 labels
}
```

The checklist is written to the existing `checklists` document (kv
`checklists`, keyed by task id, items `{ id, label, note: '', done: false }`),
so the task opens in the existing checklist runner with no new UI.

### Look-ahead and the window

A run for target date D creates exactly the occurrences whose **due_at falls in
`[max(now, D 04:00), D+1 04:00)`**. It scans events from D 04:00 to D+2 04:00
(48 h), because an "evening before" task due on D belongs to an event on D+1.

*Why define it by the due time and not by the event:* every occurrence is then
created by exactly one night's run, the one for the day it is due. An
evening-before task for a D event was due on D−1 and belonged to D−1's run. A
missed night therefore loses only the tasks already in the past, which is the
right thing to lose.

### Preview: one function, three callers

```js
previewRules({ rules, events, routine, from, to, now, existingKeys, suppressedKeys })
  -> [{ rule_id, rule_name, source_key, source: 'calendar'|'routine',
        about: { event_id?, title, start, end?, all_day?, block?: { day, slot } },
        occurrence_date, due_at, label, meta, duration_min, checklist, reason,
        status: 'new' | 'exists' | 'suppressed' | 'past',
        overlap: null | { with: source_key, exact: boolean } }]
```

It is pure: no database, no clock (`now` is a parameter), no I/O. It is what the
night run executes, what `rule_preview` shows for the next 7 days, and what the
rules editor draws. Three callers, one implementation. If the preview says a
rule will create a task, the night run creates exactly that task. `reason` is
Czech prose for the UI and the brief: "Posilovna v kalendáři zítra v 7:00
(práce)".

### Starter rules

Seeded once, into a ruleset "Základní", marked by kv `rules.seeded`. The flag
means that deleting a starter keeps it deleted.

| Name       | trigger                                                              | timing                | task                           |
| ---------- | -------------------------------------------------------------------- | --------------------- | ------------------------------ |
| Posilovna  | sources calendar+routine; calendar_match `posilovna, gym, fitko`; routine_category `gym` | evening_before 20:00 | "Sbalit tašku na posilovnu"    |
| Běh ráno   | sources calendar+routine; calendar_match `běh, run, běhat`; routine_category `gym`; routine_note_match `běh`; starts_before 10:00 | evening_before 20:30 | "Připravit věci na běh" |

Under the matcher above, `běh` (3 chars after normalizing) matches only the
token "beh" exactly, and `běhat` (5) matches "beha…" ("běhat", "běhání").
`run` must equal "run".

### Editing rules: UI and speech

**(a) The rules editor**: a new screen, so Claude Design first (P6).

**(b) Chat.** New tools in `app-tools.js`, in the same in-process server, with
the same `ok()`/`fail()` conventions. Every write goes through `onWrite('rules',
undo)`, which broadcasts `app_changed`, exactly as the other sections do.

| Tool             | Does                                                            |
| ---------------- | --------------------------------------------------------------- |
| `rules_list`     | Every ruleset and rule in readable Czech: what triggers it, when, what it creates |
| `ruleset_upsert` | Create or rename, enable or disable, reorder a ruleset          |
| `rule_upsert`    | Create or change a rule; validated by the shared zod schema; the result includes a 7-day preview |
| `rule_delete`    | Delete a rule (the undo value is the rule)                      |
| `rule_preview`   | What a rule, saved or a draft, would create over the next 7 days |

`rule_upsert` returns the preview on purpose. The persona repeats what she heard
before and after every write ("Zápis vždy potvrzuješ zopakováním"), and the
preview is the most concrete thing to repeat: "Každý čtvrtek v osm večer, před
posilovnou v pátek."

**Persona** (`persona/kacey.md`, a new short section *Pravidla*): when the owner
describes a standing pattern ("kdykoli mám posilovnu, připomeň mi večer předem,
ať si sbalím tašku"), she creates a rule with `rule_upsert`, not a one-off task
and not a memory fact. She picks the keywords from how the event actually
appears in the calendar (checking `calendar_day` or `rule_preview` if unsure),
confirms by repeating trigger, time and task in one sentence, and mentions when
the preview finds nothing in the coming week. She never promises that the night
run exists as a tool she can call, because it isn't one.

---

## 9. Generated tasks

*Phases P4 (the schema) and P5 (creation).*

### New columns on kacey_task

| Column       | Type                                   | Meaning                         |
| ------------ | -------------------------------------- | ------------------------------- |
| `origin`     | `TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','rule','dream'))` | Who made it |
| `rule_id`    | `TEXT`                                 | The rule, for `origin = 'rule'` |
| `source_key` | `TEXT`                                 | The occurrence this task is for |
| `reason`     | `TEXT`                                 | Why it exists, in Czech, shown in the UI |
| `note`       | `TEXT`                                 | A caveat (the overlap note, below) |

```sql
CREATE UNIQUE INDEX IF NOT EXISTS kacey_task_source_idx
  ON kacey_task (source_key) WHERE source_key IS NOT NULL;
```

**The migration** follows db.js: `migrate()` reads `PRAGMA table_info(kacey_task)`
and, if `origin` is missing, adds the five columns with `ALTER TABLE … ADD
COLUMN`. It never looks at a version number, because `user_version` belongs to
klaus_memory's file. `taskTable()` gains the same columns, so a fresh database
and the `dropTaskGroups` rebuild produce the same shape. The partial unique index
is what enforces "at most one task per occurrence" at the database, not only in
code.

**source_key**, stable per occurrence:

| Origin              | source_key                                   |
| ------------------- | -------------------------------------------- |
| rule, calendar      | `r:<rule_id>\|cal:<event_id>`                |
| rule, routine       | `r:<rule_id>\|rt:<day>-<slot>\|<date>`       |
| accepted proposal   | `p:<proposal_id>`                            |

The calendar key has **no date**. A calendar event is one row per occurrence
(recurring instances are materialized separately), so `event_id` already
identifies the occurrence, and when an event moves the key stays the same, so the
task can follow it (below). The routine key needs the date because a block
repeats every week. The task id is derived from the key (`tr_` + 12 hex of
SHA-1), so a re-run cannot mint a second id for the same occurrence.

### The whole-list write problem

This is the part most likely to go wrong, and why:

`appstate.writeTasks()` replaces the table: `DELETE FROM kacey_task`, then
re-insert what the client sent. The browser saves the whole `tasks` section,
debounced, from its copy. That causes three failures unless it is designed
around:

1. **The new columns would be wiped** on every browser save, since the browser
   does not send them. → `writeTasks` reads the existing rows first (inside the
   same transaction) and **carries `origin`, `rule_id`, `source_key`, `reason`,
   `note` over by `task_id`**. Values sent by a client for these fields are
   ignored. A new row from a client is always `origin = 'user'`. The generator
   is the only writer of generation fields. `readTasks()` exposes them read-only
   (`origin`, `reason`, `note`), so the UI can show them.
2. **A stale page would delete what the night created.** The kiosk page loaded at
   22:00 still holds the 22:00 list. The first tick of a checkbox in the morning
   would PUT that list, deleting the tasks the run created at 00:30, and (by the
   rule below) suppressing them forever. → **Optimistic concurrency:** kv
   `tasks.rev` is incremented on every tasks write. `GET /api/app` returns
   `tasksRev`, and the browser sends `{ value, base_rev }`. On a mismatch the
   server answers **409** and writes nothing. `store.js` then reloads and
   re-applies the pending patch *function* to the fresh list (`patch()` is
   already called with a function almost everywhere, for exactly this kind of
   race), and saves again. Server-side writers (agent tools, the generator) hold
   the current document and write without `base_rev`. A PUT without `base_rev`
   (an old page) is accepted, because the runbook reloads the kiosk after a
   deploy.
3. **Deletes need detecting.** There is no delete endpoint; a delete is a row
   missing from the next list. → `writeTasks` compares: every existing row with a
   `source_key` that is absent from the incoming list gets an
   `INSERT OR IGNORE INTO kacey_dream_suppress`. This is one choke point for
   every way a task disappears: the ✕, "Smazat hotové", or `app_task_update
   remove`.

### Staying deleted

```sql
CREATE TABLE IF NOT EXISTS kacey_dream_suppress (
  source_key TEXT PRIMARY KEY,
  reason     TEXT NOT NULL CHECK (reason IN ('deleted','merged')),
  created_at TEXT NOT NULL
);
```

The generator never creates a task whose key is suppressed, and the preview
reports it as `suppressed`. Deleting a generated task is the owner saying "not
this one". A rule that brings it back the next night would be the kind of
automation that gets switched off.

### Following the source

Every rule pass (step 2 of the run) also **reconciles** the undone generated
tasks with `origin = 'rule'` whose occurrence date is today or later:

- **The source is gone** (the event was deleted, the block repainted, the rule
  disabled or deleted, the event no longer matches) → the task is **withdrawn**:
  deleted by the generator *without* a suppress entry, and listed in the report.
  Nobody asked for it to stay deleted, so if the source comes back, the task may
  too.
- **The source moved** (same `event_id`, new start) → `due_at` is recomputed.
  If the new due time falls outside tonight's window, the task is left as it is
  and the report says so. It still exists, and the run whose window it is in
  will move it.
- **Done tasks are never touched.** Withdrawing a task that was already ticked
  would rewrite history.

### Calendar × routine: the same thing twice

The Posilovna rule listens to both sources, so a Tuesday with a "Posilovna"
calendar event *and* a gym block in the routine would create two identical
reminders. The generator handles this in two tiers:

1. **Exact** (same rule, same logical date, one occurrence from each source,
   **and** the event start/end equal the block start/end to the minute) →
   merged in code. One task keyed by the calendar occurrence, with a reason
   naming both. The routine key is suppressed with `reason = 'merged'`. No
   judgement is needed, so no model is asked.
2. **Any other same-day pair** (same rule, same date, different times) → **both**
   tasks are created, each with `note = "Možná jen jedna — kalendář a rutina se
   překrývají."`, and the pair goes to the reasoning pass as a question
   ([§10](#10-the-night-run)):
   - `verdict: one, confident: true` → the routine task is withdrawn and its key
     suppressed as `merged`; the calendar task loses its note.
   - `verdict: two, confident: true` → both notes are removed.
   - Not confident, or the reasoning pass failed → both stay, with notes.

   *Why create both first:* step 2 commits before step 3 runs, so a reasoning
   failure must never cost a reminder. Two reminders with a caveat is the safe
   default. Silently choosing one is not.

Generated tasks from a **`local_only` event** are created (rules are local and
deterministic, and nothing leaves the machine), with `sensitivity = 'local_only'`.
They are then excluded from everything that goes to the cloud (step 3 input, the
brief). Only the reasoning pass needs the filter, not the rules.

---

## 10. The night run

*Phase P5. Server module `dream.js`, storage in `nightstore.js`.*

### The run record

```sql
CREATE TABLE IF NOT EXISTS kacey_dream_run (
  logical_date TEXT PRIMARY KEY,                -- the TARGET date (§4)
  status       TEXT NOT NULL CHECK (status IN ('running','done','failed')),
  trigger      TEXT NOT NULL CHECK (trigger IN ('sleep','fallback','manual','catchup')),
  attempts     INTEGER NOT NULL DEFAULT 1,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  report       TEXT NOT NULL DEFAULT '{}'        -- JSON, below
);
```

`logical_date` as the primary key is the idempotence.

**Starting a run** is one `BEGIN IMMEDIATE` transaction:

- No row → insert `running`.
- `done` → do nothing (a manual run with `force: true` excepted).
- `running` → do nothing. Someone else holds it.
- `failed` with `attempts < 2` → set `running`, `attempts + 1`.

*Why at most two automatic attempts:* a retry after a crash is safe (step 2 is
idempotent by `source_key`, and step 3 deduplicates against the proposals
already stored), but a run that fails the same way every time must not spend a
cloud call every 30 s until morning. Manual runs are always allowed.

**Stuck runs.** At boot and before every start, a `running` row older than
`DREAM_STUCK_HOURS` (config, default 3) becomes `failed` with
`report.reset = 'stuck'`. A process killed mid-run otherwise holds the date
forever. This is the Klaus pattern.

**Catch-up at boot.** If there is no `done` row for `target(now)`, and the target
day's morning has not happened yet (now is before the resolved
`morning_peak_at`, or 09:00 if lightsd never published one), a run starts with
`trigger: catchup`. Otherwise the miss is logged and nothing runs: planning a
morning that has passed would only put stale proposals on the screen. Only the
last missed day is considered. Earlier days are gone.

### Steps

Each step records its outcome in the report whatever happens. A failing step
never stops the report from being written.

**1. Collect.** From `klaus.db` `calendar_event`, opened **read-only**, as
`/api/calendar` does: the events touching D 04:00 → D+2 04:00. For recurrence
detection, the titles of events in the 56 days before D. From Kacey's tables:
the routine grid and `routine.hours`, open tasks, existing generated keys, the
suppress list, stored proposals. klaus_memory's schema is never written or
migrated. Calendar reads go through its table exactly as it is.

Everything is marked by sensitivity here. `local_only` rows go to step 2 but
**not** to steps 3–4. The report records how many were held back (a count, not
titles).

**Memory facts are not collected in Node.** The reasoning pass fetches them
itself through read-only memory tools (step 3). *Why:* Node has no MCP client of
its own, and the Agent SDK already is one. Launching klaus_memory just to
pre-fetch facts would duplicate what the model does better, which is searching
for what the day actually needs.

**2. Rules → tasks.** `previewRules()` over the window. The `new` occurrences
are inserted, reconciliation and the exact merge are applied, and the checklists
are written. All of it happens in **its own transaction**, followed by one
`onWrite('tasks')` so open pages reload. *Why a separate transaction:* the rules
are the part that must not fail. If the model is down at 01:00, the gym bag
reminder still exists.

**3. The reasoning pass.** A headless `query()` from the Agent SDK:

| Option            | Value                                                     |
| ----------------- | --------------------------------------------------------- |
| `model`           | `MODEL` (config)                                          |
| `effort`          | `DREAM_EFFORT` (config, defaults to `EFFORT`)             |
| `systemPrompt`    | A dedicated planner prompt in `persona/dream-planner.md`. Not the persona: this is not Kacey talking |
| `tools`           | `[]`                                                      |
| `mcpServers`      | klaus-memory only; `strictMcpConfig: true`                |
| `allowedTools`    | `memory_search`, `memory_get_facts`. Nothing that writes  |
| `permissionMode`  | `dontAsk`                                                 |
| `settingSources`  | `[]`                                                      |
| `maxTurns`        | 8                                                         |
| timeout           | 10 min, then `interrupt()` and fail the attempt           |

**No write tools**, not even Kacey's app tools. The model's only output is the
JSON below, and Node decides what becomes a row. That is the same trust boundary
as everywhere else: tool output is data, and here model output is data too.
klaus_memory filters `local_only` facts itself in cloud mode (the persona already
relies on this). Step 1's filter covers the calendar and the tasks, and the
journal is never included at all.

**Input:** one JSON document in the user turn.

```jsonc
{
  "target_date": "2026-09-26", "now": "2026-09-26T00:41",
  "owner_profile": "…OWNER_PROFILE…",
  "events": [{ "id": "ev_…", "title": "…", "start": "…", "end": "…", "all_day": false,
               "source": "práce", "recurring": false, "matched_rules": ["rl_…"] }],
  "routine": { "2026-09-26": [{ "from": "07:00", "to": "08:30", "category": "gym", "note": "běh" }], "2026-09-27": [] },
  "open_tasks": [{ "label": "…", "due_at": "…" }],
  "created_by_rules": [{ "label": "…", "due_at": "…", "reason": "…" }],
  "duplicates_to_judge": [{ "keys": ["r:…|cal:ev_…", "r:…|rt:1-28|2026-09-26"],
                            "rule": "Posilovna", "calendar": { … }, "routine": { … } }],
  "prior_proposals": [{ "label": "…", "about_event": "ev_…", "status": "rejected" }]
}
```

**Output:** validated with **zod** (already a dependency).

```js
const Out = z.object({
  duplicates: z.array(z.object({
    keys: z.tuple([z.string(), z.string()]),
    verdict: z.enum(['one', 'two']),
    confident: z.boolean(),
  })),
  proposals: z.array(z.object({
    label: z.string().min(1).max(120),
    due_at: z.string(),                 // then normalizeDue(); timed or dated
    reason: z.string().max(300),
    about_event: z.string(),            // an event id from the input
    confidence: z.number().min(0).max(1),
    kind: z.string().regex(/^[a-z0-9_]{3,40}$/),  // a stable slug: 'pack_gym_bag'
  })).max(5),
});
```

The planner prompt asks for JSON only. If the installed SDK supports structured
output (`outputFormat` with a JSON schema), the implementation uses it. Otherwise
it extracts the first JSON object from the final text. Either way, zod has the
last word.

**Which events may get proposals**, which is the heart of "don't nag about the
routine": only those that are cloud-safe, inside the window, **not matched by any
active rule**, and **not recurring**. Recurring means a recurrence id in
`source_meta` or an `external_uid` of the form `<base>_<timestamp>` shared with
another event, *or* the same normalized title at least 3 times in the last 8
weeks. Note that today's sync writes `source_meta` as `{}`, so in practice only
the title heuristic applies until the sync records recurrence. This is computed
in Node, and the model only sees `recurring: true/false` and is told not to
propose for those.

**Post-validation** in Node, per item, dropping failures one at a time with a
line in the report: `about_event` must be an eligible id; `due_at` must be
parseable, not in the past, and not after the event's end; a duplicate of an
existing proposal for the same event with the same normalized label is dropped;
a `duplicates` entry whose keys were not asked about is ignored.

**Failure.** Unparseable output or a zod failure → **one retry**, with the
validation error appended to the prompt. A second failure → the step is
`failed`, the error is in the report, and the run's status is `failed`. Step 2's
tasks stay (their own transaction). The overlap notes stay (the safe default).

**4. The brief draft.** A second headless `query()`: the rendered persona as
the system prompt (the brief is in Kacey's voice), no tools, `MODEL`/`EFFORT`.
The prompt is `settings.briefPrompt` plus a context block built server-side from
the same filtered data. It follows the style and switches of `brief.js`'s
`contextBlock()`, but with the real events and tasks rather than counts, plus
what the night created and how many proposals are waiting. The text is split
into lines the way `brief.js` splits them (the regex moves into a shared pure
helper), and stored:

```jsonc
// kv 'brief.draft'
{ "logical_date": "2026-09-26", "lines": ["…"], "made_at": "…",
  "input_hash": "sha256 of the canonical JSON of D's cloud-safe events
                 (id, title, starts_at, ends_at) + open tasks due by D (id, label, due_at, done)",
  "trigger": "night" | "refresh" }
```

A failed brief does not fail the run. Morning mode tries again at T − 5
([§12](#12-morning-mode)).

**5. The report**, stored in `kacey_dream_run.report` and shown in the UI:

```jsonc
{
  "target_date": "…", "trigger": "sleep", "attempt": 1,
  "collect":   { "events": 7, "routine_blocks": 5, "open_tasks": 12, "held_back_local_only": 2 },
  "rules":     { "status": "done", "created": [{ "task_id", "label", "due_at", "rule" }],
                 "moved": […], "withdrawn": […], "merged": […], "suppressed_skipped": 1,
                 "invalid_rules": [] },
  "reasoning": { "status": "done|failed|skipped", "attempts": 1, "error": null,
                 "proposals": 2, "dropped": [{ "label", "why" }], "duplicates": […] },
  "brief":     { "status": "done|failed", "lines": 9, "input_hash": "…" },
  "reset": null
}
```

**A manual run for testing:** `POST /api/night/run { date?, force? }` and
`npm run night:run` (a script that calls it). **The persona does not get it.** No
session's allow-list includes it, and there is no MCP tool for it. *Why:* a run
spends cloud calls, rewrites the brief and can create a batch of tasks, and "run
the night" is not something a misheard sentence should do. (If a
`dream_night_run` tool is ever written for a debugging session, it stays out of
`APP_TOOL_NAMES`.)

---

## 11. Proposals

*Phase P5 (storage, creation). The review UI comes in P6.*

```sql
CREATE TABLE IF NOT EXISTS kacey_proposal (
  proposal_id   TEXT PRIMARY KEY,                -- 'pr_' + random
  logical_date  TEXT NOT NULL,                   -- the run that made it
  label         TEXT NOT NULL,
  due_at        TEXT,
  reason        TEXT NOT NULL DEFAULT '',
  about_event   TEXT,                            -- calendar_event.event_id
  about_title   TEXT NOT NULL DEFAULT '',        -- kept, since the event may disappear
  about_end     TEXT,                            -- when it expires
  kind          TEXT NOT NULL DEFAULT '',        -- the model's slug, for §13
  confidence    REAL NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','rejected','edited','expired')),
  decided_at    TEXT,
  final_task_id TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS kacey_proposal_status_idx ON kacey_proposal (status, logical_date);
```

`about_title`, `about_end`, `kind` and `created_at` go beyond the brief's column
list. The first two let a proposal be shown and expired after its event has
changed or gone. `kind` is what the learning loop counts, and adding it later
would mean re-labelling old decisions by guesswork.

- **Reviewed one at a time**, most confident first: *accept* / *edit* (label,
  due) / *reject*. Accept or edit creates a task with `origin = 'dream'`,
  `source_key = 'p:<id>'`, `reason` from the proposal, and records
  `final_task_id`. Edit stores the status `edited`, which tells the learning loop
  "right idea, wrong details".
- **Expiry:** a pending proposal becomes `expired` once `about_end` (or the
  event's start, if it has no end) has passed. It is checked on the scheduler
  tick, as a pure `expireProposals(list, now)` with tests.
- **Decisions are the learning data** ([§13](#13-the-learning-loop)). Nothing is
  deleted. A decided proposal is history.

Endpoints: `GET /api/proposals?status=pending`, `POST /api/proposals/:id
{ action: 'accept'|'edit'|'reject', label?, due_at? }`. Changes broadcast
`app_changed { section: 'proposals' }` and a new `night_state`.

---

## 12. Morning mode

*Phase P6, with the UI from Claude Design.*

**When:** `morning_peak_at` for today, resolved and stored at night
([§4](#4-time-which-day-a-run-is-for)) as kv `night.morning.peak_at`. If lightsd
was unreachable all night, the last peak it ever published (kv `lightsd.last`)
is used. If there has never been one, morning mode does not start by itself, and
the log says why.

**At T − 5 min: is the brief still true?** Recompute `input_hash`. If it differs
from `brief.draft.input_hash` (an event was added at 06:00, a task was ticked
from the phone), or there is no draft for today, the brief is rewritten (step 4
again, `trigger: 'refresh'`). If the rewrite fails, the old draft is used and the
log says so. Five minutes is enough for one low-effort generation. If the
generation is not ready at T, T waits for it for at most 2 minutes, then plays
whatever exists.

**At T:**

1. Read the lid (if `lid_check` is on). **Closed** → skip: log it, record
   `delivered: false, why: 'lid_closed'`. The brief stays in the Brief view for
   later.
2. **Open** (or `unknown`) → `screen.on('morning')`, broadcast
   `morning { logical_date, lines, checklist, peak_at }`. The kiosk page opens
   the morning screen and reads the brief line by line through the existing TTS
   (browser or XTTS), using the same `speakLine()`/queue-drain logic as
   `brief.js`. It then sends `morning_ack { logical_date }`.
3. **No page connected**, or no ack within 30 s → logged as not delivered
   (`delivered: false, why: 'no_page'`). The morning checklist is still active,
   and a page that connects later is shown morning mode from `night_state`, but
   does not auto-play. Speaking out of nowhere at 08:14 because a page reloaded
   would be a bug.

**The morning checklist is fixed.** It is the same every day and reset every
logical day. The items are a constant in `config.js` (constants only):

```
Vyčistit zuby · Sprcha · Kreatin · Purtier · Snídaně · Obléct se
```

Plus **"Projít návrhy od Kacey (N)"**, only when proposals are pending. It
**ticks itself** once every pending proposal from that date has been decided (it
cannot be ticked by hand, because ticking it is what deciding does). N updates
as they are decided.

*Why fixed and not rules-driven:* this is a habit list. Its value is that it is
the same every morning. The rules engine is for things that depend on the day.

Stored in kv:

```jsonc
// 'morning.today'
{ "logical_date": "2026-09-26", "state": "pending|active|done|ended",
  "started_at": "…", "ended_at": null, "end_reason": null,
  "delivered": true, "why": null, "last_interaction_at": null,
  "items": [{ "key": "teeth", "label": "Vyčistit zuby", "done": false, "done_at": null }, …] }
// 'morning.history'   (capped at 120 days)
{ "2026-09-26": { "done": ["teeth", …], "total": 7, "delivered": true,
                  "end_reason": "done", "completed_at": "…" } }
```

Ticks go through `POST /api/morning/tick { key, done }` and broadcast
`night_state`, so the phone and the kiosk agree.

**The end:**

| Condition                                                   | End reason | What happens                          |
| ----------------------------------------------------------- | ---------- | ------------------------------------- |
| Every item ticked                                           | `done`     | "Hotovo." shown (and spoken unless muted), then back to idle |
| `morning_end` (09:00) reached with **no interaction since the brief** | `timeout` | Ends quietly. Nobody is there |
| There was interaction                                        | —          | Waits for every item, however long    |
| The logical day rolls over at 04:00                          | `day_end`  | History records what was done         |

*Why interaction changes the timeout:* if you touched the screen, you are doing
the list, and a morning that runs long should not have its list pulled away at
09:00. If you never touched it, you were not there, and a list on a lit screen
all day helps no one.

**The Brief view's cycle becomes real.** `brief.js` `renderCycle()` is a mock
today: four steps computed from `settings.wakeMin`. It is replaced with the real
cycle from `night_state`: bedtime (sleep since), the night run (status, time),
the sunrise (`wake_at`), the brief (`peak_at`, delivered or not).
**`settings.wakeMin` stops being a source of truth.** The wake time comes from
lightsd, and the ± buttons that shift `wakeMin` are removed (moving the sunrise
is lightsd's job, in its own page). The key stays readable in stored settings,
so old data does not break, but nothing reads it. The Brief view also shows the
night's draft instead of generating a new brief on entry, when a draft for today
exists.

---

## 13. The learning loop

*Phase P7, the last one.*

- **What was rejected does not come back.** The last ~30 decided proposals
  (label, kind, about_title, status, and for `edited` the final label and due)
  go into the reasoning input as `prior_decisions`, and the planner prompt says
  what to learn from them. From P5 on the input already carries
  `prior_proposals` for the *same events*, which is deduplication. P7 adds the
  history, which is learning.
- **Accepted three times → offer a rule.** When proposals of the same `kind` have
  been `accepted` or `edited` 3 times, the morning screen offers "Udělat z toho
  pravidlo?". Yes → a rule draft is built from the three examples: keywords from
  the shared tokens of their `about_title`s, and the anchor and time from how
  `due_at` sat relative to each event. It opens prefilled in the rules editor
  and is saved through **the same code path as `rule_upsert`** (the same zod
  schema, preview and `onWrite`). The offer is made once per kind. Declining is
  recorded (kv `learning.declined_kinds`).

---

## 14. Settings

In the controller, as `srow`s (existing component), stored in `settings.night`:

| Key                  | Default   | Row                                           |
| -------------------- | --------- | --------------------------------------------- |
| `enabled`            | `true`    | Noční plánování zapnuto                        |
| `sleep_delay_min`    | `60`      | Usnutí po (min) bez interakce                  |
| `fallback`           | `"04:00"` | Záložní spuštění (00:00–06:00)                 |
| `morning_end`        | `"09:00"` | Ranní režim končí bez interakce v              |
| `screen_idle_min`    | `2`       | Obrazovka zhasne po (min)                      |
| `lid_check`          | `true`    | Nečíst brief při zavřeném víku                 |

`appstate`'s settings merge is **shallow** (`{ ...DEFAULT_SETTINGS, ...stored }`),
so a stored `night` object that lacks a new key would hide that key's default.
Readers take `{ ...NIGHT_DEFAULTS, ...settings.night }`, with `NIGHT_DEFAULTS`
in `config.js`. `enabled: false` stops the run and morning mode. Sleep detection
and the screen keep working, since they are useful on their own.

---

## 15. Server surface, for reference

### New modules

| Module          | Pure? | Owns                                                        |
| --------------- | ----- | ----------------------------------------------------------- |
| `calendar-days.js` | yes | `isAllDay`, `dayRangeOf`, `logicalDayOf`, moved out of `server.js` unchanged |
| `rules.js`      | yes   | The zod schemas, matcher, timing, `previewRules`, merge detection |
| `sleep.js`      | yes*  | `sleepStep`, `targetDate`; *plus a thin kv load/save        |
| `lightsd.js`    | no    | The /ws subscription and polling fallback; `diffLightsd` is pure and exported |
| `screen.js`     | no    | xset, xprintidle, the lid; a no-op off Linux                |
| `nightstore.js` | no    | SQL for the rulesets, rules, runs, proposals, suppress, and generated task writes |
| `dream.js`      | no    | The night run: steps 1–5, catch-up, stuck reset             |
| `morning.js`    | no    | T − 5, T, the checklist, the end                            |
| `night.js`      | no    | The 30 s tick that drives all of the above, and `night_state` broadcasts |

*Why more files than the "backend is two files" line in ARCHITECTURE.md:* that
line already doesn't hold (`db.js`, `appstate.js`, `app-tools.js`), and this
feature has real seams. The pure modules must be importable by `node test/*.mjs`
with no database, no SDK and no clock. ARCHITECTURE.md's Backend section gets
updated when P3 lands.

`config.js` gains constants only: `LIGHTSD_URL` (default
`http://127.0.0.1:8080`), `KACEY_DISPLAY`, `KACEY_XAUTHORITY`,
`DREAM_EFFORT`, `DREAM_STUCK_HOURS`, `NIGHT_DEFAULTS`, `MORNING_ITEMS`.

### HTTP

| Route                              | Purpose                                         |
| ---------------------------------- | ----------------------------------------------- |
| `GET  /api/night`                  | The `night_state` snapshot (below)              |
| `POST /api/night/run`              | A manual run `{ date?, force? }`                 |
| `GET  /api/night/runs?limit=`      | Recent runs with their reports                  |
| `GET  /api/rules`                  | Rulesets with their rules                       |
| `PUT  /api/rules/sets/:id`         | Upsert a ruleset                                |
| `PUT  /api/rules/:id`              | Upsert a rule                                   |
| `DELETE /api/rules/:id`            | Delete a rule                                   |
| `POST /api/rules/preview`          | `{ rule | rule_id, days }` → occurrences        |
| `GET  /api/proposals?status=`      | Proposals                                       |
| `POST /api/proposals/:id`          | Decide one                                      |
| `GET  /api/morning`                | `morning.today`                                 |
| `POST /api/morning/tick`           | Tick an item                                    |
| `PUT  /api/app/tasks`              | Now honours `base_rev` → 409 ([§9](#9-generated-tasks)) |

### Frames

Each new frame gets a `case` in `net/protocol.js` and a row in the README's
wire-protocol table, as ARCHITECTURE.md § Adding things requires.

| Direction | Frame                                   | Meaning                           |
| --------- | --------------------------------------- | --------------------------------- |
| s → c     | `ready { …, features: ['night'] }`      | This server understands the frames below |
| c → s     | `interaction { kind: 'pointer'\|'key'\|'touch'\|'wake' }` | Throttled to one per 10 s; counts for sleep and screen |
| c → s     | `speaking { on: bool }`                 | The screen stays on while she speaks; the idle clock starts at `on: false`. Not an interaction |
| c → s     | `morning_ack { logical_date }`          | The brief started playing          |
| s → c     | `night_state { sleep, screen, lid, run: { next, last }, morning, pending_proposals }` | On every change, to every client |
| s → c     | `morning { logical_date, lines, checklist, peak_at }` | Open the morning screen and play |
| s → c     | `app_changed { section: 'rules'\|'proposals' }` | New section values; old pages fall back to "Aplikace" and reload harmlessly |

### kv keys

| Key                     | Holds                                                   |
| ----------------------- | ------------------------------------------------------- |
| `night.sleep`           | The sleep state ([§7](#7-sleep-detection))              |
| `night.morning`         | `{ logical_date, wake_at, peak_at, source }`, resolved at night |
| `lightsd.last`          | The last `wake_at` / `morning_peak_at` seen, and when   |
| `brief.draft`           | The night's brief ([§10](#10-the-night-run))            |
| `morning.today`, `morning.history` | [§12](#12-morning-mode)                      |
| `tasks.rev`             | The optimistic-concurrency counter ([§9](#9-generated-tasks)) |
| `rules.seeded`          | The starters were seeded once                           |
| `learning.declined_kinds` | [§13](#13-the-learning-loop)                          |

### Agent tools

`rules_list`, `ruleset_upsert`, `rule_upsert`, `rule_delete`, `rule_preview`, in
`app-tools.js`, added to `APP_TOOLS` and `APP_TOOL_NAMES`. No night-run tool.

---

## 16. Phases

One commit per phase. Each phase ends with its tests green, a CHANGELOG.md
entry, and this document updated if the build changed the design.

| Phase | What | Repo | Depends on | Status |
| ----- | ---- | ---- | ---------- | ------ |
| **P1** | lightsd `morning_peak_at` (§5): schedule, arbiter, status, pytest | lights | — | planned |
| **P2** | Kiosk, screen, lid (§6): `screen.js`, the lid, readout rows, the `visibilityState` check, runbook | Kacey | — | planned |
| **P3** | Sleep detection (§7): `lightsd.js`, `sleep.js`, `night.js` tick, `interaction` frame, `ready.features`, `night_state`, a minimal `screen.js` (on/off), tests. **Not yet:** the `speaking` frame and the idle timeout (with P2's screen work), the readout rows (UI), the real run (P5) | Kacey | P1, P2 | done (see the commit adding it) |
| **P4** | Rules (§8), the task schema (§9): tables, migration, `writeTasks` carry-over, suppress, `tasks.rev`/409, `routine-cats.js`, `calendar-days.js`, `rules.js`, the agent tools, starters, the persona, tests | Kacey | — | planned |
| **P5** | The night run (§10), proposals (§11): `dream.js`, `nightstore.js`, runs, catch-up, stuck reset, reasoning, brief draft, report, endpoints, readout rows, tests | Kacey | P3, P4 | planned |
| **P6** | Morning mode (§12) and the UI from Claude Design: morning screen, proposal review, rules editor, the real cycle in Brief, task origin/reason/note in rows, the settings `srow`s, the report view | Kacey | P5 | planned |
| **P7** | The learning loop (§13) | Kacey | P6 | planned |

**What counts as done**, beyond the tests:

- **P1:** `GET :8080/api/status` on kaceybody shows `morning_peak_at`. It needs
  a lightsd restart, which the user does (runbook).
- **P2:** the runbook has been run; `screen.js` turns the real panel on and off;
  the visibility question has an answer written into §6.
- **P3:** pressing the lightsd button puts the screen off and the readout into
  `winding_down`; a tap returns it to `awake`; a quiet hour reaches `asleep`
  (verified with `sleep_delay_min` set to 2).
- **P4:** "kdykoli mám posilovnu, připomeň mi večer předem" in chat creates a
  rule whose preview matches the calendar; deleting a generated task survives a
  re-run.
- **P5:** a manual run produces tasks, at most 5 proposals and a brief, and the
  report says so; a second run for the same date is a no-op; killing the process
  mid-run leads to a stuck reset and a clean retry.
- **P6:** one real morning, end to end.

---

## 17. Rules of work

For every phase:

- **CLAUDE.md.** Before any UI change, read DESIGN.md. After it, update DESIGN.md
  in the same commit (tokens, components, screens inventory, changelog). Small
  changes built from existing components (readout rows, `srow`s) are tagged
  `[design: pending]`. **New screens (morning, proposal review, rules editor, the
  report) come only from Claude Design output** and are tagged `[design:
  synced]`. A phase that needs a new screen waits for the design rather than
  improvising one.
- **ARCHITECTURE.md.** The frontend has no build step and no dependencies. New
  frames go into `protocol.js` and the README table. `config.js` holds constants
  only. Kacey's tables are only `kacey_*`, klaus_memory's are read-only, and
  their schema is never touched. Server text reaches the DOM through
  `textContent` only, and that includes the model-written `reason` and brief
  lines.
- **Tests.** `node test/*.mjs` for the pure logic: `rules.mjs` (matcher,
  timing, window, preview, merge), `sleep.mjs` (the state machine, `targetDate`
  incl. DST on 2026-10-25 and 2027-03-28), `lightsd-diff.mjs`, `proposals.mjs`
  (expiry, post-validation), `tasks-write.mjs` (carry-over, suppress on delete,
  409, against a temp database via `KLAUS_DB`). pytest in lightsd. package.json
  gains `test:night` (all of the above) and `test` (`test:wake` + `test:night`).
- **CHANGELOG.md** for every phase. A new feature is a minor bump: P3 → KC 1.1.0
  is reasonable, and each phase after it bumps the minor version or not, as
  CHANGELOG.md's own rules say.
- **One commit per phase**, code and docs together.

---

## 18. Decisions made in this spec, and open questions

The brief left these open or was silent. The choice made here is marked, so a
later session can overturn it on purpose rather than by accident.

**Decided here**

1. **The peak walk is bounded** by the wake keypoint's `group`, else by the wake
   window (§5). The unbounded "follow while rising" puts the bedside lamp's peak
   at 09:00. *Revisit if* the real kaceybody schedule behaves differently. P1
   should print the peak for the live config before committing.
2. **Target date by the noon rule** (§4).
3. **"Awake early" vs "sunrise"** is inferred from `minutes_until_wake` (§5),
   which keeps lightsd free of a "why sleep ended" field.
4. **Two automatic attempts per date**, then manual only (§10).
5. **Catch-up means "before this morning's brief"** (§10). The brief's "only if
   the target day is still in the future" was read as "the morning being planned
   hasn't happened yet".
6. **Optimistic concurrency on the tasks section** (`tasks.rev`, 409), which is
   needed so a stale page cannot delete and suppress generated tasks (§9).
7. **Overlaps: create both, then let the model remove one** (§9), so a reasoning
   failure costs nothing.
8. **Rules run on `local_only` events too**; only the cloud steps filter (§9).
9. **Keyword matching**: stem match for ≥ 5 characters, exact below (§8).
10. **Memory facts are fetched by the model** through read-only tools, not
    pre-collected in Node (§10).
11. **`kind` on proposals from P5 on**, so P7 has clean data (§11).
12. **`morning_ack`**: "delivered" means the page started playing, not merely
    that a socket existed (§12).
13. **Calendar switches in the controller also gate the rules** (§8).

**Open**

- **Rules during the day.** Today the rule pass runs only at night. An event
  added at noon for tomorrow morning gets its evening-before task only if
  tonight's run still has the evening in its window, and it does not (the window
  for D+1's run starts at D+1 04:00). A cheap hourly rule pass during the day
  would close that gap. It needs a decision on whether tasks may appear
  mid-afternoon without a night run.
- **Recurrence ids.** `calendar_event.source_meta` is `{}` today, so only the
  title heuristic detects recurring events. If klaus_memory's sync starts
  recording the recurring id, the check should prefer it. That is a change in
  klaus_memory, out of scope here.
- **Brief rewrite at T − 5 vs XTTS latency.** On CPU, XTTS can take tens of
  seconds per sentence. If the first line lands late, T − 10 may be needed. To
  be measured in P6.
- **Proposal confidence floor.** Everything valid is stored, and the review sorts
  by confidence. If low-confidence noise shows up in practice, add a floor
  setting.
