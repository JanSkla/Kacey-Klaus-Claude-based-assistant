# Design brief — notifications and Instagram DMs

For Claude Design. Two new screens, on desktop (Kacey Desktop) and on the phone
(Kacey Phone), and the Android app's WebView, which uses the phone layout. The
backend and the Android relay are already built. This brief describes the data
the screens can use and what each screen has to do. It does not decide what
they look like.

Read [DESIGN.md](../DESIGN.md) first. As always, pick up the `[design: pending]`
entries in §8 before designing anything new. The design rules still hold:
monospace, square corners, one accent, neutral surfaces, Czech copy.

## Why this exists

The owner keeps Instagram's notifications quiet so reels don't pull them in.
They still want to know when someone writes to them. The phone now copies every
notification to Kacey. The Instagram DM window gives the owner their messages
without opening Instagram. The notifications page does the same for everything
else, and it leads with a summary rather than a raw list.

## What exists already (no design needed)

- **Android.** `NotificationRelayService` copies the shade to kaceybody.
  - The launcher's STAV list has a new **Čtení oznámení** row, built from the
    existing status row and logged in DESIGN.md §8 as `[design: pending]`:
    "vypnuté" + Povolit, "čeká N" + Odeslat, "posílá do Kacey" + ghost Nastavit.
  - Nothing is ever dismissed from the phone.
- **Server.**
  - The table is `kacey_notification`, with one row per message for messaging
    apps.
  - The endpoints and the `notifications` frame are listed in [README.md § Wire protocol](../README.md#wire-protocol).
- **Kacey's voice.** She can already read them through her `app_notifications`
  tool: "co mi kdo psal na Instagramu?"

## The data

One row (`GET /api/notifications`, `GET /api/notifications/thread`):

```jsonc
{ "id": "nt_…", "package": "com.instagram.android", "app": "Instagram",
  "kind": "message",            // or "notification"
  "conversation": "petr.k",     // the thread: a group's name, else the other person
  "group": false, "sender": "petr.k",
  "title": "petr.k", "text": "jdeš večer?", "sub_text": null,
  "posted_at": "2026-10-05T18:02:11Z",
  "read": false,                // read in Kacey
  "removed": false,             // gone from the phone (read in the app, or swiped away)
  "sensitive": false }          // a login code / secret notification: show it, but the model never sees it
```

The other endpoints:

- `GET /api/notifications/apps` returns, per app: `app`, `total`, `unread`,
  `messages`, `last_at`.
- `GET /api/notifications/threads` returns Instagram's threads, each with
  `conversation`, `group`, `total`, `unread`, `last_at` and the `last` row.
- `POST /api/notifications/summary { scope: "all" | "dm" }` returns `{ text, count,
  generated_at, cached }`.
  - The text is a few Czech sentences, written to be readable aloud.
  - A fresh summary takes a few seconds (a model call). A cached one is
    instant, and stays cached until something new is unread.
- `POST /api/notifications/read` marks rows read: by id, by thread, by app, or
  all.
- The live frame `notifications` arrives whenever something comes in or
  anything is read: `{ fresh: [...no text...], unread: { all, dm } }`.

**Limits the design has to respect:**
- Only what the notification showed is available.
- Photos arrive as "[obrázek]", and long messages are cut off.
- The owner's own replies appear only if they replied from the notification
  shade (sender "Já").
- There is no sending. Replying happens in Instagram, so a "reply" control has
  nothing to call.

## Screen 1 — `notifications` ("Oznámení")

**Job:** what came to the phone since the owner last looked, summary first.

It needs:

- **The summary** of what's unread, at the top.
  - States: loading (a few seconds), ready, error, nothing unread.
  - A way to refresh it.
  - Optional: a way to have Kacey say it aloud. `/api/tts` exists, and so does
    the brief's line player pattern.
- **Per-app grouping.** The owner thinks in apps ("12 from WhatsApp, 30 from
  Spotify"), so the list should be scannable by app.
  - Unread is visibly distinct from read.
  - "Mark this app read" and "mark everything read".
- **Each notification:** app, title, text, time. Sensitive rows are shown but
  look different; they are why the summary says "a jeden přihlašovací kód".
  "Gone from the phone" may be a quiet hint, not a headline.
- **Filters:** all / messages only / one app. Older history pages back
  (`before=`), up to 30 days.
- **Empty states:**
  - The relay has never sent anything. Point the owner to the Android launcher
    row (README, "Notifications").
  - Nothing unread.
- **A way into the Instagram DM window** when there are DMs.

## Screen 2 — `dms` ("Instagram" / "Zprávy")

**Job:** read Instagram DMs without opening Instagram. This is the feature the
whole relay was built for.

It needs:

- **Thread list:** name (or group name), the last message and when, an unread
  count. Latest first.
- **One thread:** messages oldest first, the way a chat reads.
  - Sender names in groups; "Já" for the owner's own replies.
  - Opening a thread marks it read (`POST /api/notifications/read { package,
    conversation }`).
- **The DM summary** (`scope: "dm"`): who wrote, what they want, who's waiting
  for an answer. Probably above the thread list.
- **Live:** a new DM shows up without a reload, through the `notifications`
  frame.
- **Desktop vs phone:**
  - On desktop, list and thread side by side is the obvious fit (like
    calendar's list + detail).
  - On a phone the list and the thread are separate panes (like rules' `data-step`).
- **Deliberately absent:** reply, reactions, media, a link into Instagram's
  feed. A plain "Otevřít Instagram" may be fine on the phone, but it is a
  doorway back into the distraction, so the design should weigh it.

## Navigation and ambient signals (to design)

- **Where the screens live.** The desktop's Funkce rail and the phone's Víc
  sheet are the existing patterns. Should Instagram DMs earn a tab or a header
  badge?
- **Unread count.** The frame carries `unread.all` and `unread.dm`. Should a
  badge show anywhere (the header, the Funkce entry, the tab)?
- **Arrival.** When a DM arrives with Kacey open, should it be a toast, a
  line in the status strip, nothing, or Kacey saying "Petr ti píše na
  Instagramu"? Speaking needs a Controller switch and must respect the night
  (no voice while the owner sleeps). This is a design call, and it probably
  wants a `.srow` in Controller.
- **Morning brief.** The night run could fold "overnight messages" into the
  brief. That is not built; say whether you want it.

## Components likely to fit (DESIGN.md §3)

Some candidates:
- `.card`
- `.rowbtn` (list rows)
- `.msg` / `.msg__bubble` (the thread)
- `.chips` / `.chip--filter` (filters)
- `.seg` (all / messages)
- `.briefline` (the summary as lines)
- `.empty`
- `.subhead` (app groups)
- `.psheet` (the phone's thread pane)
- the toast

New components are fine where these don't fit: an unread badge, an app
header row, a sensitive-row treatment. Name them, and Claude Code will
implement them and log them in DESIGN.md as `[design: synced]`.
