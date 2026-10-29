# Changelog

Kacey is versioned as **KC x.y.z** ([semver](https://semver.org)). The version
lives in `package.json` and nowhere else; the server reads it from there
(`config.js` `VERSION`), reports it in `/api/health` and the `ready` frame, and
the header shows it.

- **Every change** — a feature, a screen, a fix — bumps the last number:
  KC 1.0.1 → 1.0.2. Improving the app from the chat does this by itself when
  it finishes a change ([selfupdate.js](selfupdate.js)).
- **Major / minor** move only by hand: major for a change that breaks existing
  data or setup (a migration that cannot go back, a renamed setting in
  `/etc/kacey.env`), minor when you decide a set of changes is a milestone.

To release: bump `version` in `package.json`, add a section here, commit, then
`git tag -a vX.Y.Z -m "KC X.Y.Z"` and `git push origin master --tags`.

UI changes are also logged, in more detail, in [DESIGN.md §8](DESIGN.md#8-changelog).

---

## KC 1.0.16 — 2026-10-29

**Přehrávač — otevřít i bez hudby**
- The header mini player no longer disappears when nothing is playing (or
  nowplayingd is down). It stays as an idle bar, "Nic nehraje" with Otevřít,
  and a click on it opens the player page (the visual over the page on the
  kiosk, its own tab elsewhere). "Hudba" off in the Controller still hides it.

## KC 1.0.15 — 2026-10-28

**Světla — oprava přesměrování**
- `/lights/` redirected to itself: Express matches `/lights` and `/lights/`
  alike, so the bare-path redirect caught both. Only the bare `/lights` is
  redirected now.

## KC 1.0.14 — 2026-10-28

**Světla z telefonu a vzdáleného notebooku**
- The Lights view showed "lightsd neodpovídá" everywhere but the bedside
  screen: it framed `https://<host>:8080`, and behind tailscale serve there is
  no TLS on 8080. Kacey now passes `/lights/` (and `/lights/ws`) through to
  `LIGHTSD_URL` on loopback, so the frame and the "Otevřít samostatně" link
  work from any device that reaches Kacey. The proxy is shared with the
  self-update preview (`frameproxy.js`), which also gains root-absolute
  `src`/`href` rewriting, redirects kept under the prefix and `wss:` on https.

## KC 1.0.13 — 2026-10-25

**Hlas — Whisper small zpět jako výchozí**
- Whisper **small** is back as a third choice in Přepis řeči and is the
  default again (`stt.js`, the sidecar, `stt.service`). On kaceybody's CPU
  large v3 took ~37 s a sentence (127 s after idle, past Kacey's 60 s limit)
  and turbo ~27 s whatever the length; small takes ~5 s (less accurate).
  Kacey's `app_stt` and persona know all three and offer small when
  dictation is slow.
- A model switch no longer keeps the old model in memory: the sidecar now
  hands it back to the system (`malloc_trim`). Switching large v3 → turbo had
  left it at 5.1 GB with swap full and the machine crawling.

## KC 1.0.12 — 2026-10-25

**Hlas — mikrofon na kaceybody zase končí větu**
- The bedside mic recorded every request for the full 20 s: KC 1.0.11 capped
  the speech gate at 0.02, below the room kaceybody's mic hears (0.005–0.064,
  a fan or music), so the gate never closed. The level is now smoothed over a
  few buffers, the noise floor keeps learning from quiet ones, and the gate
  stays at least 2.5× above it. A quiet laptop mic keeps the low gate.

## KC 1.0.11 — 2026-10-25

**Hlas — přechod na Whisper large v3**
- The mic works again: the recording's audio context is made inside the tap
  (made after the permission prompt it started suspended in Chrome and
  Safari, recorded nothing and sat on "Poslouchám" for 20 s), the speech gate
  adapts to a quiet laptop mic, and a mic that gives pure silence says so
  ("…jestli není ztlumený…") instead of "Nic jsem neslyšela". While Whisper
  records, the orb and the HUD meter follow the real mic level; after the
  utterance the strip reads "Přepisuji, co jsem slyšela…".
- Dictation goes to Whisper on kaceybody whenever it is ready (the audio
  stays home), the browser's engine only while Whisper is down or loading,
  or after the browser's own fails with `network` (Chromium on Linux).
  `?stt=native` still prefers the browser.
- Whisper **large v3** by default (was `small`), with **turbo**
  (large-v3-turbo, several times faster) one tap away: Controller → Hlas →
  Přepis řeči, `large v3 · turbo`, with the state ("připraveno", "věta za
  2,4 s", "načítám turbo…", "nedostupný", "offline", "turbo nejde"). A switch
  takes about a minute; a model that will not load falls back to large v3.
- [stt.js](stt.js): the choice in `kacey_kv` `stt.model`, the last sentence's
  time in `stt.last` (every device shows it); a sidecar that comes up with a
  different model is asked for the owner's (at most every 5 minutes, never
  over its own load error); `stt` frames on a switch. Routes
  `GET /api/stt/health`, `POST /api/stt/model`, `POST /api/stt`. A preview
  only pretends to switch, so a draft never changes the live app's model.
- Sidecar ([voicelab/stt_server.py](voicelab/stt_server.py)): one model at a
  time (the old one freed first), `POST /model`, the choice kept in
  `stt_state.json` across restarts; needs faster-whisper ≥ 1.1 for turbo.
- Kacey by voice: `app_stt` `status` and `switch` ("přepni přepis na
  turbo"); the persona offers turbo when large v3 is slow but does not
  switch on her own.
- Tests: [test/stt.mjs](test/stt.mjs) (`npm run test:stt`).

## KC 1.0.10 — 2026-10-24

**Lístečky — potvrzení mazání a smazat vše**
- × on a sticky note always asks first ("Smazat lísteček?" · Nechat ·
  Smazat), an empty note too; Escape keeps it.
- A new bin in the header, left of the note button, deletes every note at
  once after its own question ("Smazat všechny lístečky?", with the count).
  It stays put and is dimmed while there is no note. Vrátit brings the whole
  batch back in one request (`POST /api/stickies/restore`), as many as fit
  under the 12.
- [stickies.js](stickies.js): `removeAll` (one timestamp, one `cleared`
  frame), `restoreMany`, `restoreLast`; route `DELETE /api/stickies`.
- Kacey by voice: `app_sticky` `clear` (only with `sure: true`, after the
  owner's yes; the persona has her ask first) and `restore` (the last
  delete: one note or the whole batch). Her clear toasts on every desktop
  with Vrátit.
- Offline and errors: deleting refuses with "Jsi offline — smazat půjde, až
  se připojím."; a failed delete-all closes the panel and says why. Hidden on
  a phone, like the notes.
- Tests: Smazat všechny, its Vrátit, the limit and `app_sticky` clear /
  restore in [test/stickies.mjs](test/stickies.mjs).

## KC 1.0.9 — 2026-10-23

**Úložiště — rychlé sdílení souborů mezi zařízeními**
- A new screen, Úložiště (sidebar DALŠÍ and the phone's Víc, with the file
  count): any file up from the computer (Nahrát soubory, or dropped on the
  list) or the phone, down on any device. Kept until deleted — nothing
  expires. Name, size, when and from which device; search, Nejnovější ·
  Název · Velikost (remembered per device); tick several to download or
  delete them at once; Smazat always with Vrátit within a day.
- Uploads stream to disk ([storage.js](storage.js), `POST /api/storage`, the
  raw file with its name in headers) one at a time with real progress; a cut
  or short upload leaves nothing behind, 4 GB a file, the free disk is shown.
  The listeners no longer cut a request after Node's default 5 minutes, so a
  long upload from the phone finishes.
  Table `kacey_file`, files in `STORAGE_DIR` (`data/storage`), live `storage`
  frames so the other device's list fills in at once and toasts the new file.
- A picture, video, sound, PDF, text or CSV opens in a náhled (formats in
  [public/js/core/filekind.js](public/js/core/filekind.js), shared with the
  server's sandboxed `/view` route); anything else is a download.
- Offline: the list says so with Zkusit znovu, uploads, deletes and downloads
  explain why they wait, and an upload cut by a lost connection goes up again
  by itself once it is back.
- Kacey reaches it by voice: `app_storage` lists the files, writes a text or
  a photo from the chat as a file ("pošli mi ten seznam na telefon"),
  deletes, restores and opens the screen or a file; the persona's new
  "Úložiště" section. Deleted files and stale `.part`s are purged after a day.
- Tests: [test/storage.mjs](test/storage.mjs) (`npm run test:storage`).

## KC 1.0.8 — 2026-10-22

**Opravy a novinky — kalendář, whiteboard, lístečky, štítky**
- Kalendář: a confirmed Smazat (and Uložit název, Potvrdit / S otazníkem)
  closes the event card on the desktop too; a change that never reached the
  server says the owner is offline instead of "Failed to fetch".
- Whiteboard: a text card follows its text while it is edited — taller for
  a new line, back down when it goes, never smaller than before the edit. It
  used to grow a grid step on every key, a deletion too.
- Lístečky: sticky notes over every page of the desktop (the note button in
  the header). Dragged by their bar, resized from the corner, they stay where
  they were put across views, reloads and desktops until deleted with × and
  the "Smazat" beside it (Vrátit within a day). Their own table
  `kacey_sticky` ([stickies.js](stickies.js)), routes `/api/stickies`, live
  `stickies` frames; a page sends only the fields that changed and keeps
  them while offline. At most 12. Hidden on a phone.
- Kacey writes them too: `app_sticky` (add, edit, remove — a note found by
  its words) and LÍSTEČKY in `app_read`; the persona's new "Lístečky"
  section keeps them apart from tasks.
- Úkoly · Štítky: every tag can carry the owner's description of what belongs
  under it (`settings.taskTags[].hint`, 300 characters), written in the tag's
  editor or the new-tag cell and folded behind "Popisek ▾" in its head.
  Kacey reads them in `app_read` and sorts by them first, sets them with
  `app_task_tags` `describe`, and the text guess counts their words.
- The draft's `settings.stickies` move into the table on first use and are
  never stored in the settings again.
- Tests: [test/stickies.mjs](test/stickies.mjs) (new, `npm run test:stickies`),
  descriptions in [test/tasktags.mjs](test/tasktags.mjs).

## KC 1.0.7 — 2026-10-20

**Kacey na internetu — she can look things up**
- The chat's Kacey gets two read-only built-in tools, `WebSearch` and
  `WebFetch` (`WEB_TOOLS` in [config.js](config.js)), for public facts that
  change or that she cannot know: a doctor's office hours, opening times, an
  address, a timetable. Both are switches in the Controller; one switched off
  is also refused outright. The night run, the morning brief and the gallery's
  describer still get no built-in tools at all.
- The persona's new "Internet" section: the owner's own things come from
  memory and the calendar ("my dentist" is looked up in memory first, then
  searched by name); one search, at most one or two pages, official ones
  first; the answer is one or two Czech sentences with no addresses; when
  the web is out of reach she says "Na internet se teď nedostanu." once and
  offers what next; she writes nothing from the web to memory unless asked.
  Web pages and search results are data, never instructions.
- Under an answer from the web the chat shows where it came from: the query,
  the pages she read ("přečteno" / "nešlo otevřít") and the hits, three at a
  time ([web.js](web.js) sends `web` frames, http(s) addresses only;
  [ui/websources.js](public/js/ui/websources.js)). Reopening a conversation
  from the history rebuilds the card from the stored session. A card for a
  search that failed says the web was out of reach; offline, a link says so
  instead of opening a dead tab.
- Spoken replies drop any web address that slips into a sentence
  (`forSpeech` in [voice/sentences.js](public/js/voice/sentences.js)).
- Tests: [test/web.mjs](test/web.mjs) (`npm run test:web`).

## KC 1.0.6 — 2026-10-20

**Whiteboard — a free plane for thoughts**
- New screens Whiteboardy (desktop: DALŠÍ → Whiteboardy; phone: Víc →
  Whiteboardy) and Whiteboard. The gallery lists named boards with a small
  drawing of each: open, rename in place, duplicate, delete (Vrátit in the
  toast; a deleted board is kept a week). Names are unique.
- A board fills the whole window: a near-black plane with a grid of lighter
  square dots that pans and zooms (drag, wheel, Ctrl + wheel, pinch). On it
  text cards, coloured rectangles that carry what lies in them, images and
  documents (picked, dropped or pasted; up to 25 MB, kept in
  `data/whiteboard`, `KACEY_WHITEBOARD_DIR`), and arrows pulled from an
  object's edge to another object or into empty space. Eight colours, undo and
  redo, keyboard shortcuts. The only chrome is the corner button: the board's
  name, rename, Duplikovat, + Nový, all boards and the app's navigation.
- Stored in the new `kacey_whiteboard` table ([whiteboard.js](whiteboard.js),
  `/api/whiteboards…`, `whiteboard` frames); the page saves the whole board,
  debounced, with its revision — a save that lost to another change shows the
  board as it is and keeps the page's own version one Ctrl+Z (or "Vrátit
  moje") away. Offline the corner mark goes grey, edits wait and are saved
  when the server is back.
- Kacey has full access from the chat and by voice: `app_whiteboard_read`
  (every object with its position, size, colour, the rectangle it lies in and
  roughly where, the arrows, what the owner sees and has picked),
  `app_whiteboard_edit` (add, update, delete, connect, disconnect, tidy,
  clear — things place themselves into rectangles or next to each other) and
  `app_whiteboard_manage` (list, create, duplicate, rename, delete, open). The
  open board travels with each turn, so "dej to sem" needs no question. Her
  edits flash on the board and toast with Vrátit; the chat shows the board.
  The persona tells her to gather from the app (tasks, calendar, journal)
  before laying things out — "Pomoz mi ujasnit si všechny povinnosti".
- Tests: [test/whiteboard.mjs](test/whiteboard.mjs) (`npm run test:whiteboard`).

## KC 1.0.5 — 2026-10-20

**Kalendář — unanswered invitations, nightly and manual sync**
- Each calendar sync stores the owner's answer to every invitation it sees
  (Google's `responseStatus`: needsAction · tentative · accepted · declined) in
  the new `kacey_event_response` table ([calsync.js](calsync.js),
  [tools/calendar_sync.py](tools/calendar_sync.py)); `/api/calendar` sends it
  as `response` on each event. An unanswered or "Možná" invitation is drawn
  like an unsure event — dotted, with a "?", meta "nepotvrzeno ·" / "možná ·" —
  and its editor says to answer in Google; the next sync takes the "?" away.
  A sync whose answers cannot be read keeps the previous ones.
- Every calendar is synced at the start of each night run; a failed sync does
  not fail the run. The Brief timeline shows it ("Kalendář ✓ — synchronizován
  · 2 pozvánky čekají na odpověď", or the failure in the owner's words).
- The calendar page has a sync strip: the time and source of the last sync,
  the open invitations, and a sync button (`GET`/`POST /api/calendar/sync`,
  `calendar_sync` frames). One sync at a time — a press during the night's sync
  joins it. Offline the button rests and the strip says which sync still holds;
  a sync another page started is followed even if its end frame is missed.
- Kacey: `app_calendar_sync` (sync now, list the open invitations, last sync);
  the persona tells her to use it instead of klaus_memory's raw `calendar_sync`
  and that invitations are answered in Google.
- Note: the answers come from klaus_memory's sync result or its `source_meta`.
  If its Google backend does not pass `responseStatus` through, no "?" appears
  until it does; the server log then says "no invitation answers in this sync"
  after every run.

## KC 1.0.4 — 2026-10-17

**Galerie — photos with descriptions and search by meaning**
- New screen Galerie (desktop: DALŠÍ → Galerie; phone: Víc → Galerie): take a
  photo (the webcam on a computer, the phone's own camera app), upload or drop
  photos. They are stored on kaceybody — the files in `data/gallery`
  (`KACEY_GALLERY_DIR`), the rows in the new `kacey_photo` table
  ([gallery.js](gallery.js)).
- Kacey writes each photo's title, caption, tags and hidden search keywords;
  they are not edited by hand. A description that fails can be retried, and a
  photo left half-described by a restart is described again on start.
- The search ranks by meaning over a vector index ([vectors.js](vectors.js)):
  built-in hashed vectors by default, or an Ollama-compatible embedder via
  `KACEY_EMBED_URL` / `KACEY_EMBED_MODEL`; vectors from another embedder are
  rebuilt lazily. Tags filter the grid.
- In the chat: "ulož mi tuto fotku" saves the attached picture
  (`app_gallery_save`, Kacey writes the description herself) and "najdi fotku
  z hor" searches (`app_gallery_search`); both show the photos in the chat.
  Kacey's persona has a Galerie section.
- The server checks the image bytes (JPEG, PNG, WebP, GIF; up to 25 MB) and
  stores what they really are.
- Offline: a loaded grid stays on screen with a note and reloads on return;
  uploads that failed offline go up by themselves once connected; a failed
  upload offers Zkusit znovu · Zahodit.
- Tests: [test/gallery.mjs](test/gallery.mjs) (`npm run test:gallery`).

## KC 1.0.3 — 2026-10-16

**The day kept current**
- Fixed: a page left open for long — on the phone especially — kept showing the
  day it was opened (Wednesday all of Thursday). New
  [public/js/core/clock.js](public/js/core/clock.js) checks the logical day (it
  turns at 04:00) every 30 s and at once when the page comes back: shown again,
  focused, back online, after the device slept, and when the Android app resumes
  (`WebHostActivity.onResume` sends `kacey-resume`; the WebView does not always
  report itself hidden). Views follow on the bus (`day`, `clock`): the calendar's
  today, the routine's today row, tasks' groups, the sidenav badge, the morning
  clock, the brief's title.
- Main says which day it is: "Dnes · čt 15. října", on the phone "Další na řadě ·
  čt 15. 10.". A new day reloads the app document (the night run wrote since) and
  says so in a toast; offline it says it will catch up, and does when the
  connection is back ([public/js/core/store.js](public/js/core/store.js) `load()`
  now resolves whether the server answered).
- Kacey: every turn carries the current day and time ("Teď je čtvrtek 15. října
  (2026-10-15), 09:12.", due.js `turnClock`), since a conversation can stay open
  for days; the persona says that line wins over the date it opened with.
- Tests: [test/clock.mjs](test/clock.mjs).

## KC 1.0.2 — 2026-10-15

**Task tags**
- Every new task gets a tag — what it belongs to. Kacey picks it herself in
  `app_task_add`; anything added without her (the add form, the today panel, the
  night run, a page offline) gets a word-match guess
  ([public/js/core/tasktags.js](public/js/core/tasktags.js)). Existing tasks are
  tagged once by their text when the database opens (`kacey_task.tag`, [db.js](db.js)).
- The tags are the owner's: they start as Práce · Škola · Byt · Až bude volný čas ·
  Rodina and can be renamed, added, reordered (by voice) and deleted at any time
  (`settings.taskTags`, cleaned on save in [appstate.js](appstate.js); a deleted
  tag's tasks stay, "Bez štítku").
- Úkoly switch between **Podle termínu** and **Podle štítků**; by tag, a task is
  dragged by its ⋮⋮ to another group (or tapped for the tag chips), on the phone too.
- Kacey: `app_read` lists ŠTÍTKY, `app_task_update` moves a task (`tag`, "bez
  štítku" clears it), new `app_task_tags` (add · rename · move · remove); persona
  section "Štítky úkolů".
- A save that fails offline stays on screen, says so, and goes out again when the
  connection is back ([public/js/core/store.js](public/js/core/store.js)).
- Tests: [test/tasktags.mjs](test/tasktags.mjs); `test/routine-days.mjs` no longer
  depends on today's date.

## KC 1.0.1 — 2026-10-15

**Improving the app from the chat**
- Ask Kacey for a new feature and a popup confirms the brief (or asks up to three
  questions); a coding agent drafts it on a `kaceyFeature/` branch, a live preview
  runs beside the current app for comparison (side by side; a toggle on a phone),
  prompts make new revisions, approval finishes it for production with tests and the
  next KC 1.0.x, and "Přepnout teď" merges and restarts ([selfupdate.js](selfupdate.js),
  [public/js/views/upgrade.js](public/js/views/upgrade.js), Claude Design "Kacey Self-Update").
- **Conversation history**: earlier chats are listed by day and can be resumed
  ([public/js/ui/history.js](public/js/ui/history.js), `/api/chat/sessions`).
- New settings: `KACEY_SELFUPDATE`, `KACEY_UPGRADE_DIR`, `KACEY_PREVIEW_PORT`,
  `KACEY_UPGRADE_MODEL`, `KACEY_UPGRADE_EFFORT`, `KACEY_RESTART_CMD`, `KACEY_UNIT`.

**The routine on concrete dates**
- The weekly routine is now the default week, and a single date can diverge
  from it: a run cancelled while sick, the gym moved to the evening, a one-off
  block, a range of sick days. The default week is untouched; each change is a
  row in `kacey_routine_override` for that date ([routine-days.js](routine-days.js),
  [public/js/core/routine-day.js](public/js/core/routine-day.js),
  [docs/routine-divergence.drawio](docs/routine-divergence.drawio)).
- **Finished days are cemented.** At 04:00 after a day the night tick writes
  what the routine actually was that day into `kacey_routine_day`, and the
  default week can no longer change it. A server that was off catches up at its
  next tick. History starts on the first day this version runs.
- **The calendar** draws each date's own routine (cancelled blocks hollow and
  struck, one-off blocks with a "+"), and a tap changes a block for that day:
  cancel, move within the week, undo. **+ Blok**, **Nemoc / volno…** (cancel a
  range of days, all or chosen categories) and **Obnovit výchozí** sit above the
  lane. Past days are read-only there.
- **Kacey** gets `app_routine_alter` with the same operations (cancel,
  cancel_range, add, move, reset, remove, keep_overlap), and `app_read` shows
  the days around today with their changes. She alone can amend a day already
  in history, when you tell her you forgot.
- A block added on top of a default one is drawn **beside** it, never hiding
  it. Whether the default one goes is Kacey's call: she decides in the turn, or
  the calendar's "Zeptat se Kacey" asks her.
- The night run's rules follow the date: no gym-bag reminder for a cancelled
  gym, and the reminder for a moved one follows it.
- New API: `GET /api/routine/days?from&to`, `POST /api/routine/alter`;
  `/api/calendar` carries the month's cemented days (`routine`), `/api/app`'s
  routine its overrides. New tables `kacey_routine_override`, `kacey_routine_day`
  (created on boot; nothing to migrate). New test `test/routine-days.mjs`.

**The bedside screen as a second monitor**
- A new switch in the Controller, **Druhý monitor**, turns kaceybody's panel
  into a second monitor for the PC. Apollo on the PC adds a virtual display for
  the stream; Kacey starts Moonlight over the kiosk to show it
  ([monitor.js](monitor.js)). When the stream ends (the switch, Ctrl+Alt+Shift+Q
  on the laptop, or the PC dropping it) Moonlight exits and the kiosk shows
  Kacey again.
- The screen is held lit while it runs. Kacey keeps listening behind it.
- It opens Apollo's **Virtual Display** app at the panel's 1920×1080, and
  closes the session on the PC when the stream ends, so the extra display
  goes away. When Moonlight reports an error (not paired, PC away), the error
  shows under the switch and Moonlight is closed. Before, its dialog stayed
  over the kiosk.
- Found on the real kiosk: SDL's libdecor/GTK window frame kept the stream
  window from ever appearing, so Kacey turns it off. And the snap launcher
  rebuilt its MIME cache on every start (minutes) until
  `~/.config/user-dirs.dirs` existed.
- New API: `GET/POST /api/monitor` (`{"on": true|false}`). New settings:
  `KACEY_MONITOR_HOST`, `_APP`, `_CMD`, `_ARGS`, `KACEY_WAYLAND_DISPLAY`,
  `KACEY_RUNTIME_DIR`. Setup is in
  [docs/RUNBOOK-kaceybody.md](docs/RUNBOOK-kaceybody.md) (P2.6).

**The phone's notifications in Kacey**
- The Android app copies every notification the phone shows to kaceybody
  (`NotificationRelayService`, `POST /api/notify`). It only reads the shade,
  so Instagram never sees anything unusual. It queues to a file while
  kaceybody is out of reach. A new **Čtení oznámení** row on the launcher
  grants the access and shows whether the copies are getting through.
- They're stored in a new table, `kacey_notification`: one row per message
  for messaging apps, with re-sends dropped. They're kept 30 days
  (`KACEY_NOTIFY_KEEP_DAYS`).
- New API: `/api/notifications` (list, per app, Instagram DM threads, read
  state) and a model-written summary of what is unread. There's a new
  `notifications` frame for open pages.
- Kacey can read them with her new `app_notifications` tool ("co mi kdo psal
  na Instagramu?"). Login codes and secret notifications never reach the
  model.
- The notifications page and the Instagram DM window are waiting for Claude
  Design ([docs/design-brief-notifications.md](docs/design-brief-notifications.md)).

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
