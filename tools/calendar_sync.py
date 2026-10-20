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

Where the answers come from, in order (a later one wins for the same event):
  1. the sync result itself — anything in it that carries an event_id and a
     response status, at any depth (klaus_memory's report shape is its own);
  2. the mirror after the sync — calendar_event.source_meta, the attendee
     marked `self` or a flat response_status, read straight from SQLite.
`responses` is null when neither could be read at all (the server then keeps
the answers it had); an empty object means "no open invitation anywhere".
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

STATUSES = ("needsAction", "tentative", "accepted", "declined")


def status_of(node):
    """The owner's answer carried by one dict, or None."""
    status = node.get("response_status") or node.get("responseStatus")
    if status in STATUSES:
        return status
    for a in node.get("attendees") or []:
        if isinstance(a, dict) and a.get("self") and a.get("responseStatus") in STATUSES:
            return a["responseStatus"]
    return None


def collect(node, out, depth=0):
    """Every {event_id, response status} pair anywhere in the sync result."""
    if depth > 6:
        return
    if isinstance(node, dict):
        eid = node.get("event_id")
        status = status_of(node)
        if isinstance(eid, str) and status:
            out[eid] = status
        for v in node.values():
            collect(v, out, depth + 1)
    elif isinstance(node, (list, tuple)):
        for v in node:
            collect(v, out, depth + 1)


def from_mirror(db_path, out):
    """Answers kept in the mirror's source_meta. False when it cannot be read."""
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
        try:
            rows = con.execute(
                "SELECT event_id, source_meta FROM calendar_event "
                "WHERE source_meta IS NOT NULL AND source_meta LIKE '%esponse%'"
            ).fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        return False
    for eid, raw in rows:
        try:
            meta = json.loads(raw)
        except (TypeError, ValueError):
            continue
        status = status_of(meta) if isinstance(meta, dict) else None
        if status:
            out[eid] = status
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--calendars", help="JSON declaring the calendar sources")
    ap.add_argument("--env", help=".env holding the provider credentials")
    args = ap.parse_args()

    if not args.calendars:
        print(json.dumps({"ok": False, "error": "chybí calendars.json — není s čím synchronizovat"},
                         ensure_ascii=False))
        return 1

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
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc), "kind": type(exc).__name__},
                         ensure_ascii=False))
        return 1

    responses: dict[str, str] = {}
    collect(result, responses)
    mirror_ok = from_mirror(args.db, responses)

    events = None
    if isinstance(result, dict):
        for key in ("events", "count", "synced", "total"):
            if isinstance(result.get(key), int):
                events = result[key]
                break
    print(json.dumps({
        "ok": True,
        "events": events,
        "responses": responses if (responses or mirror_ok) else None,
    }, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
