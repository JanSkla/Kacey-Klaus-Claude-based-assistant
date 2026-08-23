"""Calendar writes for the Kacey web UI.

Reads are done straight from SQLite by server.js. Writes must NOT be, because
klaus_memory owns real logic on this path: it recomputes conflicts, stamps
updated_at, and pushes through to the external calendar backend. Bypassing that
would leave the mirror inconsistent with what sync() expects.

Invoked per write as a short-lived process — writes are user-initiated and rare,
so a ~1-2s start beats keeping a third daemon alive.

    echo '{"action":"update","event_id":"ev_…","title":"…"}' \
      | python tools/calendar_write.py --db <path> --calendars <path> --env <path>

Reads one JSON object on stdin, prints one JSON object on stdout:
    {"ok": true,  "result": {...}}
    {"ok": false, "error": "...", "kind": "NotFoundError"}

--calendars is what makes a write to an EXTERNAL event possible at all. Without
it the calendar runs on an in-memory backend whose only source is called
"local", while every stored event says 'osobní', 'práce' or 'rodina' — and
delete() checks the source before it touches anything, so it fails with
"neznámý kalendářní zdroj 'osobní'". Reads never notice, because they come from
the mirror table in SQLite.

--env carries the Google credentials. They sit next to calendars.json in the
memory tree, which is NOT an ancestor of this repo, so the automatic upward
search for `.env` cannot find them from here.

Only update and delete are exposed. calendar_sync stays out — it is the one call
that reaches the external backend wholesale, and it is an orchestrator job.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--calendars", help="JSON declaring the calendar sources")
    ap.add_argument("--env", help=".env holding the provider credentials")
    args = ap.parse_args()

    try:
        raw = sys.stdin.read()
        req = json.loads(raw or "{}")
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"bad request: {exc}"}))
        return 1

    action = req.get("action")
    event_id = req.get("event_id")
    if action not in ("update", "delete") or not event_id:
        print(json.dumps({"ok": False, "error": "action (update|delete) and event_id required"}))
        return 1

    try:
        from klaus_memory.config import Config
        from klaus_memory.service import MemoryService
        from klaus_memory.calendar import CalendarSources, InMemoryCalendarBackend
        from klaus_memory.providers import DeterministicEmbedder, ModelRouter, RuleBasedLLM
        from klaus_memory.util import read_text_any

        # Credentials first: the providers read them from the environment while
        # they are being constructed, so a later load is too late. The real
        # environment still wins over the file, same rule as the CLI.
        if args.env:
            from klaus_memory import envstore

            envstore.load_report(args.env)

        config = Config.from_env().with_(db_path=Path(args.db))

        sources = None
        if args.calendars:
            sources = CalendarSources.from_config(
                json.loads(read_text_any(args.calendars)), timezone=config.timezone
            )

        # Deterministic/offline providers: a calendar write never needs an LLM or
        # an embedding, and this must not depend on network or an API key.
        svc = MemoryService(
            config,
            embedder=DeterministicEmbedder(dim=config.embed_dim),
            router=ModelRouter(realtime=RuleBasedLLM(), batch=RuleBasedLLM()),
            # With sources declared, the in-memory stand-in must NOT be passed —
            # it would shadow them and put us straight back to source 'local'.
            calendar_backend=None if sources else InMemoryCalendarBackend(),
            calendar_sources=sources,
        )

        if action == "delete":
            result = svc.calendar_delete(event_id)
        else:
            kw = {}
            for key in ("title", "starts_at", "sensitivity"):
                if req.get(key) is not None:
                    kw[key] = req[key]
            # ends_at is tri-state: absent = keep, null = clear the end time.
            if "ends_at" in req:
                kw["ends_at"] = req["ends_at"]
            if not kw:
                print(json.dumps({"ok": False, "error": "update bez jediné změny"}))
                return 1
            result = svc.calendar_update(event_id, **kw)

        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, default=str))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc), "kind": type(exc).__name__},
                         ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
