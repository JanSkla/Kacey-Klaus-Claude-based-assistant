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
