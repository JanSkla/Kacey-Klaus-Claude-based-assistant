"""Calendar sync for Kacey — the night run and the calendar page's Synchronizovat.

Runs klaus_memory's own sync (calendar_mirror.sync), the one call that reaches
the external calendars wholesale, then reports the owner's answer to every
invitation it saw (Google's attendees[self].responseStatus), so Kacey can draw
an unanswered one with a "?".

    python tools/calendar_sync.py --db <path> --calendars <path> --env <path>

Prints one JSON object on stdout:
    {"ok": true, "events": 214, "responses": {"ev_…": "needsAction", …}}
    {"ok": false, "error": "...", "kind": "..."}

Same construction as calendar_write.py: --calendars makes the Google sources
exist at all, --env carries their credentials.

DRAFT: klaus_memory's sync result is walked for anything that carries an
event_id and a response status. Where its Google backend does not hand the
status through yet, server.js also reads it from source_meta; the production
pass makes the backend keep it.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

STATUSES = ("needsAction", "tentative", "accepted", "declined")


def collect(node, out, depth=0):
    """Every {event_id, response status} pair anywhere in the sync result."""
    if depth > 6:
        return
    if isinstance(node, dict):
        eid = node.get("event_id")
        status = node.get("response_status") or node.get("responseStatus")
        if not status:
            for a in node.get("attendees") or []:
                if isinstance(a, dict) and a.get("self"):
                    status = a.get("responseStatus")
        if isinstance(eid, str) and status in STATUSES:
            out[eid] = status
        for v in node.values():
            collect(v, out, depth + 1)
    elif isinstance(node, (list, tuple)):
        for v in node:
            collect(v, out, depth + 1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--calendars", help="JSON declaring the calendar sources")
    ap.add_argument("--env", help=".env holding the provider credentials")
    args = ap.parse_args()

    try:
        from klaus_memory.config import Config
        from klaus_memory.service import MemoryService
        from klaus_memory.calendar import CalendarSources
        from klaus_memory.providers import DeterministicEmbedder, ModelRouter, RuleBasedLLM
        from klaus_memory.util import read_text_any

        if args.env:
            from klaus_memory import envstore

            envstore.load_report(args.env)

        config = Config.from_env().with_(db_path=Path(args.db))
        if not args.calendars:
            print(json.dumps({"ok": False, "error": "chybí calendars.json — není s čím synchronizovat"},
                             ensure_ascii=False))
            return 1
        sources = CalendarSources.from_config(
            json.loads(read_text_any(args.calendars)), timezone=config.timezone
        )
        svc = MemoryService(
            config,
            embedder=DeterministicEmbedder(dim=config.embed_dim),
            router=ModelRouter(realtime=RuleBasedLLM(), batch=RuleBasedLLM()),
            calendar_backend=None,
            calendar_sources=sources,
        )

        result = svc.calendar_sync()
        responses: dict[str, str] = {}
        collect(result, responses)
        events = None
        if isinstance(result, dict):
            for key in ("events", "count", "synced", "total"):
                if isinstance(result.get(key), int):
                    events = result[key]
                    break
        print(json.dumps({"ok": True, "events": events, "responses": responses},
                         ensure_ascii=False, default=str))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc), "kind": type(exc).__name__},
                         ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
