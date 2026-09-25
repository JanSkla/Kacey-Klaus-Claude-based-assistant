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
