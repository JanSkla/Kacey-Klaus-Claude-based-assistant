# Changelog

Kacey is versioned as **KC x.y.z** ([semver](https://semver.org)). The version
lives in `package.json` and nowhere else; the server reads it from there
(`config.js` `VERSION`), reports it in `/api/health` and the `ready` frame, and
the header shows it.

- **Major:** a change that breaks existing data or setup (a migration that cannot
  go back, a renamed setting in `/etc/kacey.env`).
- **Minor:** a new feature or screen.
- **Patch:** fixes only.

To release: bump `version` in `package.json`, add a section here, commit, then
`git tag -a vX.Y.Z -m "KC X.Y.Z"` and `git push origin master --tags`.

UI changes are also logged, in more detail, in [DESIGN.md §8](DESIGN.md#8-changelog).

---

## Unreleased

**Voice on the bedside laptop**
- XTTS runs on kaceybody's GeForce 940MX in half precision (it has 2 GB). It
  speaks about 2× slower than real time, so the night run now also renders
  the morning brief to audio, one clip per line, and the morning plays the
  finished clips without gaps.
- Dictation works in the kiosk's browser, which has no speech recognition of
  its own: the page records what you say and Whisper transcribes it on the
  laptop (`voicelab/stt_server.py`, `/api/stt`). The audio never leaves the
  machine.

**The bedside screen, for kaceybody as it really is** (cage + Epiphany on
Wayland, no desktop)
- `screen.js` switches the panel at the backlight (`/sys/class/backlight`)
  when it can, and falls back to `xset` on a desktop. The screen is dark by
  default. A tap, a key, the wake word or the mouse over the page lights it
  (new `presence` frame, which does not count as interaction for sleep).
- The runbook's P2 is rewritten for the real machine: the NVIDIA 580 legacy
  driver for the GeForce 940MX (the installed 610 ignores it), a udev rule for
  the backlight, and pointing the existing cage kiosk at Kacey.

**Fix: Kacey also listens on localhost when `HOST` is set** (a Tailscale
address on kaceybody). The kiosk needs `http://localhost:8082` for the
microphone, and `npm run night:run` and the runbook's checks call localhost.

**The night routine, phase P7: learning**
- The night's reasoning pass now sees the last 30 decisions about its
  proposals, so what was rejected doesn't come back.
- When the same kind of proposal has been accepted three times in 30 days,
  accepting it asks "Tohle přijímáš pravidelně — udělat z toho pravidlo?".
  Yes opens the rules editor with a rule drafted from those examples
  (keywords, timing, task); no means it isn't offered again.
- Accepting a proposal no longer shows "Úkoly — změnila Kacey".

**The night routine, phase P6: the morning, and every new screen** (from Claude Design "Kacey DREAM")
- At the sunrise's brightest point the bedside screen comes on and the kiosk
  reads the night's brief aloud. The morning screen shows the time, the brief
  line by line, a fixed checklist (Vyčistit zuby · Sprcha · Kreatin · Purtier ·
  Snídaně · Obléct se, plus "Projít návrhy" when some are waiting, which ticks
  itself), and what the rules added for today.
  - Five minutes before, the brief is rewritten if the day changed.
  - A closed lid skips the morning.
  - It ends when everything is ticked ("Hotovo, hezký den."), or at 09:00 if
    nobody touched it.
- Proposal review, one card at a time: accept, edit (name and due, in the
  card), or reject.
- The rules editor: rulesets, rules, keywords, routine categories, timing, the
  task and its checklist, with a live 7-day preview. It also works on a phone,
  one pane at a time.
- The Brief view shows the real night (button, sleep, night run, sunrise,
  brief) instead of a mock. Its ±15 moves lightsd's sunrise. `wakeMin` is no
  longer used.
- Tasks made by the night carry a PRAVIDLO / KACEY tag and a "?" with the
  reason. The controller gets "Noc a ráno" settings and a "Stav noci" readout.
- The kiosk URL is now `http://localhost:8082/?kiosk=1` (runbook).

**The night routine, phase P5: the night run**
- Once per planned day, while the owner sleeps, Kacey:
  - turns the rules into tasks (merging exact calendar × routine duplicates;
    other same-day overlaps are created with a note),
  - moves or withdraws rule tasks whose event moved or vanished,
  - asks a read-only reasoning pass for up to 5 **proposals** for unusual
    events and for verdicts on the overlaps,
  - writes the morning brief with a hash of what it was written from,
  - and stores a report of all of it (`kacey_dream_run`).
- Robust like Klaus's consolidation: idempotent per date, a stuck run is reset
  after 3 h, one automatic retry, a catch-up at boot while the morning is still
  ahead. Nothing `local_only` goes to the cloud.
- Proposals (`kacey_proposal`) can be accepted, edited or rejected through
  `POST /api/proposals/:id`; accepting makes a task with origin `dream`. They
  expire once their event has passed. The review screen comes in P6.
- A manual run for testing: `npm run night:run` (`POST /api/night/run`).
  New setting from the environment: `KACEY_DREAM_EFFORT`.

**The night routine, phase P4: rules**
- Rules turn the calendar and the weekly routine into tasks: "whenever there's
  gym, the evening before at 20:00: pack the gym bag". They are data
  (`kacey_ruleset`, `kacey_rule`), matched case- and diacritics-insensitively,
  with Czech inflection handled for keywords of 5+ letters. The starters are
  Posilovna and Běh ráno.
- Kacey edits rules by talking: new tools `rules_list`, `ruleset_upsert`,
  `rule_upsert`, `rule_delete` and `rule_preview` (what a rule would create in
  the next 7 days). The persona has a new section, *Pravidla*.
- Tasks gain `origin`, `rule_id`, `source_key`, `reason` and `note`. The
  migration adds them on first start. A deleted generated task stays deleted
  (`kacey_dream_suppress`). The task list now carries a revision, so a stale
  page can no longer overwrite newer tasks: it gets a 409, reloads, and
  re-applies its edit.
- The routine categories and the calendar day model moved into shared modules
  (`public/js/core/routine-cats.js`, `calendar-days.js`). No behaviour change.

**The night routine, phases P1–P2: the sunrise peak, the screen, the lid**
- lightsd publishes `morning_peak_at`, the top of the sunrise ramp: when the
  brief will play (lightsd repo, `7093fb6`).
- The bedside screen: `screen.js` turns the panel on for the wake word, keeps
  it lit while Kacey speaks, and turns it off after 2 minutes of nothing. It
  also turns off a panel the mouse woke, using X's own idle time via
  `xprintidle`. It reads the lid from `/proc/acpi`.
- The page reports `speaking` and `visibility` frames. The second answers
  whether the wake word still listens with the panel off.
- [docs/RUNBOOK-kaceybody.md](docs/RUNBOOK-kaceybody.md): the steps to run by
  hand: X11 kiosk with autologin, Chromium flags and the microphone policy,
  DPMS handed to Kacey, logind ignoring the lid, the display in `/etc/kacey.env`.

**The night routine, phase P3: sleep detection** ([docs/DREAM.md §7](docs/DREAM.md#7-sleep-detection))
- Kacey listens to lightsd (`/ws`, polling `/api/status` every 30 s when the
  socket is down). The sleep button starts a 60-minute wind-down and turns the
  bedside screen off. An hour with no interaction means asleep, which starts
  the night run. Any tap, key, the wake word or a message cancels the
  wind-down; moving the mouse does not.
- If nothing has run by 04:00, the night run starts anyway, once per planned
  day. The run itself is still a stub that only logs.
- The state (`awake` / `winding_down` / `asleep`) lives in `kacey_kv`, so a
  restart keeps the night. `GET /api/night` and the new `night_state` frame
  show it. The page sends throttled `interaction` frames when the server
  advertises `features: ['night']`.
- New settings from the environment: `LIGHTSD_URL`, `KACEY_DISPLAY`,
  `KACEY_XAUTHORITY`. `npm test` now runs everything, and `npm run test:night`
  runs the new tests.

---

## KC 1.0.0 — 2026-09-24

The first real release: the version meant to be lived with day to day rather
than tried out.

**Talking to her**
- Voice-first: recorded wake word "KC", barge-in ("ticho" stops her, "počkej"
  pauses), the conversation ends on its own; Czech TTS through XTTS, pipelined.
- Brain: Claude Opus 5.5 at low effort through the Claude Agent SDK
  (`KACEY_MODEL`, `KACEY_EFFORT`); klaus_memory for memory, the journal and the
  calendar.
- Images can be attached to chat, and Kacey can edit the app itself through
  her own tools: tasks, routine, journal.
- A failed turn says why (outdated SDK, login, rate limit, outage, network…)
  instead of "Něco se nepovedlo"; the full reason goes to the log.

**The app**
- Ten views in one shell, from Claude Design "Kacey Redesign", plus a phone
  layout of its own ("Kacey Mobile"): tab bar, bottom sheets.
- Calendar: month grid, day lane over the weekly routine, 1–7 days side by side
  (drag across days), sources switchable.
- Tasks are due by timestamp: a date, or a date and time with a length. Po
  termínu / Dnes / Tento týden are worked out from the clock, never stored.
  Timed tasks sit in the calendar lane, dated ones in the all-day strip.
- Weekly routine planner (painted in 15-minute cells, notes, revert), journal
  with tags and dictation, morning brief, timers, checklist runner and focus
  mode, a controller for sources and tools.
- Lights: frames the separate lightsd app on the same host (:8080).

**Under it**
- Tasks, journal, routine and settings in SQLite, in klaus_memory's file but in
  tables of their own (`kacey_*`). This release migrates `kacey_task` from fixed
  groups to due dates on first start.
- Runs on `kaceybody` as `kacey.service`, port 8082.
