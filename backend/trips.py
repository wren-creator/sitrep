"""Trips: saved destinations and dates, a briefing per stop, and alerts when the picture changes.

A trip is a list of stops (a place, its country, arrive and depart dates). The briefing pulls together what
the map already knows about each stop and ranks the warnings worst first, so the thing to worry about is at
the top. Alerts compare a snapshot of each stop's country (State Dept level, EASA airspace bulletins, the
advisory's embassy note, embassy status) with the last one and record what changed.

Stored only in the local SQLite file (data/sitrep.db, ignored by git). Nothing about a trip leaves this machine
except the place name sent to the geocoder when a stop is added.
"""
import json
import time
from datetime import date, datetime, timezone

import lookup
from facts import names

_db = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', created_at REAL
);
CREATE TABLE IF NOT EXISTS trip_stops (
    id INTEGER PRIMARY KEY AUTOINCREMENT, trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    label TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, iso2 TEXT, arrive TEXT, depart TEXT, created_at REAL
);
CREATE TABLE IF NOT EXISTS trip_snapshots (
    stop_id INTEGER PRIMARY KEY REFERENCES trip_stops(id) ON DELETE CASCADE, signature TEXT, updated_at REAL
);
CREATE TABLE IF NOT EXISTS trip_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    stop_id INTEGER, kind TEXT, severity TEXT, text TEXT, created_at REAL, seen INTEGER NOT NULL DEFAULT 0
);
"""

RANK = {"critical": 3, "high": 2, "medium": 1, "low": 0}
LEVEL_TEXT = {4: "Do not travel", 3: "Reconsider travel", 2: "Exercise increased caution", 1: "Exercise normal precautions"}
AIR_TEXT = {"do_not_operate": "airlines advised not to operate", "caution": "airlines advised to take caution"}
NEWS_LAYERS = ("conflict", "unrest", "disaster")
RECENT_DAYS = 30


def set_db(factory) -> None:
    global _db
    _db = factory


# ------------------------------------------------------------------ storage

def _rows(sql: str, args=()) -> list[dict]:
    with _db() as c:
        return [dict(r) for r in c.execute(sql, args).fetchall()]


def _one(sql: str, args=()) -> dict | None:
    rows = _rows(sql, args)
    return rows[0] if rows else None


def create_trip(name: str, notes: str = "") -> int:
    with _db() as c:
        return c.execute("INSERT INTO trips (name, notes, created_at) VALUES (?,?,?)", (name.strip(), notes.strip(), time.time())).lastrowid


def update_trip(trip_id: int, name: str, notes: str) -> bool:
    with _db() as c:
        return c.execute("UPDATE trips SET name = ?, notes = ? WHERE id = ?", (name.strip(), notes.strip(), trip_id)).rowcount > 0


def delete_trip(trip_id: int) -> bool:
    with _db() as c:
        return c.execute("DELETE FROM trips WHERE id = ?", (trip_id,)).rowcount > 0


def add_stop(trip_id: int, label: str, lat: float, lon: float, iso2: str | None, arrive: str | None, depart: str | None) -> int | None:
    if not _one("SELECT id FROM trips WHERE id = ?", (trip_id,)):
        return None
    with _db() as c:
        stop_id = c.execute("INSERT INTO trip_stops (trip_id, label, lat, lon, iso2, arrive, depart, created_at) VALUES (?,?,?,?,?,?,?,?)",
                            (trip_id, label.strip(), lat, lon, iso2.upper() if iso2 else None, arrive, depart, time.time())).lastrowid
    _store_snapshot(stop_id, iso2)  # the baseline, so the first check does not alert about what was already true
    return stop_id


def update_stop(stop_id: int, label: str, arrive: str | None, depart: str | None) -> bool:
    with _db() as c:
        return c.execute("UPDATE trip_stops SET label = ?, arrive = ?, depart = ? WHERE id = ?", (label.strip(), arrive, depart, stop_id)).rowcount > 0


def delete_stop(stop_id: int) -> bool:
    with _db() as c:
        return c.execute("DELETE FROM trip_stops WHERE id = ?", (stop_id,)).rowcount > 0


def _stops(trip_id: int) -> list[dict]:
    return _rows("SELECT * FROM trip_stops WHERE trip_id = ? ORDER BY COALESCE(arrive, '9999-12-31'), id", (trip_id,))


def _span(stops: list[dict]) -> tuple[str | None, str | None]:
    starts = [s["arrive"] for s in stops if s["arrive"]]
    ends = [s["depart"] or s["arrive"] for s in stops if s["depart"] or s["arrive"]]
    return (min(starts) if starts else None, max(ends) if ends else None)


def _status(start: str | None, end: str | None, today: date) -> str:
    if end and end < today.isoformat():
        return "past"
    if start and start > today.isoformat():
        return "upcoming"
    return "current" if (start or end) else "undated"


def get_trip(trip_id: int) -> dict | None:
    trip = _one("SELECT * FROM trips WHERE id = ?", (trip_id,))
    if not trip:
        return None
    stops = _stops(trip_id)
    start, end = _span(stops)
    return {**trip, "stops": stops, "start": start, "end": end, "status": _status(start, end, date.today())}


def list_trips() -> list[dict]:
    out = []
    for t in _rows("SELECT id FROM trips ORDER BY created_at DESC"):
        trip = get_trip(t["id"])
        trip["unseen_alerts"] = _one("SELECT COUNT(*) AS n FROM trip_alerts WHERE trip_id = ? AND seen = 0", (t["id"],))["n"]
        out.append(trip)
    # Ongoing and upcoming trips first, soonest first. Past ones last.
    order = {"current": 0, "upcoming": 1, "undated": 2, "past": 3}
    out.sort(key=lambda t: (order[t["status"]], t["start"] or "9999"))
    return out


# ------------------------------------------------------------------ briefing

def _days_between(iso: str | None, today: date) -> int | None:
    return (date.fromisoformat(iso[:10]) - today).days if iso else None


def _stale_hours(as_of: str | None) -> float | None:
    if not as_of:
        return None
    try:
        t = datetime.fromisoformat(as_of)
    except ValueError:
        return None
    return (datetime.now(timezone.utc) - (t if t.tzinfo else t.replace(tzinfo=timezone.utc))).total_seconds() / 3600


def stop_briefing(stop: dict, today: date) -> dict:
    iso2, lat, lon = stop["iso2"], stop["lat"], stop["lon"]
    country = names.display_name(iso2) if iso2 else None
    adv = lookup.advisory(iso2)
    air = lookup.airspace(iso2)
    embassy_posts = lookup.embassies_in(iso2)
    nearest = lookup.nearest_embassies(lat, lon, 2)
    near = [n for n in lookup.nearby(lat, lon, 150) if n["layer"] in NEWS_LAYERS]

    warnings: list[dict] = []

    def warn(level: str, source: str, text: str, url: str | None = None):
        warnings.append({"level": level, "source": source, "text": text, "url": url})

    if not iso2:
        warn("medium", "place", "This stop has no country attached, so advisories, airspace and health information cannot be matched to it.")
    if adv:
        lvl = adv["level"]
        text = f"State Dept advisory Level {lvl}: {LEVEL_TEXT[lvl]}."
        if lvl >= 3 and adv.get("reasons"):
            why = ", ".join(adv["reasons"][:4])
            text += " " + why[:1].upper() + why[1:] + "."  # not .capitalize(), it would turn "U.S." into "u.s."
        warn({4: "critical", 3: "high", 2: "low", 1: "low"}[lvl], "advisory", text, adv.get("source_url"))
        old = _stale_hours(adv.get("as_of"))
        if old is not None and old > 12:
            warn("medium", "advisory", "The State Dept feed has been unreachable for a while, this advisory may be out of date.")
        if adv.get("embassy_notice"):
            warn("medium", "embassy", "State Dept advisory on the embassy: “" + adv["embassy_notice"] + "”", adv.get("source_url"))
    elif lookup.have("advisory") and iso2:
        warn("low", "advisory", "No State Dept advisory matched this country.")

    for b in air:
        issued, revised = _days_between(b.get("issued"), today), _days_between(b.get("revised"), today)
        issued_ago = -issued if issued is not None else None
        revised_ago = -revised if revised is not None else None
        tag = ""
        if issued_ago is not None and issued_ago <= RECENT_DAYS:
            tag = " Issued in the last 30 days."
        elif revised_ago is not None and revised_ago <= RECENT_DAYS:
            tag = f" Revised {revised_ago} days ago."
        part = f" (part of the country: {b['scope']})" if b.get("partial") and b.get("scope") else ""
        recent = bool(tag)
        level = ("high" if b["kind"] == "do_not_operate" else "medium")
        warn(level, "airspace", f"EASA airspace bulletin{part}: {AIR_TEXT[b['kind']]}.{tag}", b.get("source_url"))
        if recent and b["kind"] == "do_not_operate":
            warnings[-1]["recent"] = True

    suspended = [e for e in embassy_posts if e.get("status") != "active"]
    if suspended:
        warn("high", "embassy", "The US embassy here is not operating normally: " + (suspended[0].get("status_note") or suspended[0]["status"]) + " (from our hand-kept list, confirm with the State Dept).")
    if nearest and nearest[0]["km"] > 300:
        warn("medium", "embassy", f"The nearest operating US embassy is {nearest[0]['km']} km away ({nearest[0]['title']}), straight-line.")
    elif not nearest:
        warn("medium", "embassy", "No operating US embassy in the data.")

    conflict = [n for n in near if n["layer"] == "conflict" and n["severity"] in ("high", "critical")]
    unrest = [n for n in near if n["layer"] == "unrest" and n["severity"] in ("medium", "high", "critical")]
    disasters = [n for n in near if n["layer"] == "disaster" and n["severity"] in ("high", "critical")]
    if conflict:
        warn("high", "conflict", f"{len(conflict)} military conflict report(s) within 150 km, worst: {conflict[0]['title']} ({conflict[0]['km']} km).", conflict[0].get("source_url"))
    if unrest:
        warn("medium", "unrest", f"{len(unrest)} civil unrest report(s) within 150 km, e.g. {unrest[0]['title']} ({unrest[0]['km']} km).", unrest[0].get("source_url"))
    if disasters:
        warn("high", "disaster", f"{len(disasters)} serious disaster alert(s) within 150 km, e.g. {disasters[0]['title']} ({disasters[0]['km']} km).", disasters[0].get("source_url"))

    warnings.sort(key=lambda w: (-RANK[w["level"]], w["source"]))

    to_start, to_end = _days_between(stop["arrive"], today), _days_between(stop["depart"] or stop["arrive"], today)
    if to_end is not None and to_end < 0:
        when = "past"
    elif to_start is not None and to_start > 0:
        when = "upcoming"
    else:
        when = "now" if (stop["arrive"] or stop["depart"]) else "undated"
    return {
        "stop": stop, "country": country, "when": when, "days_to_start": to_start, "days_to_end": to_end,
        "advisory": adv, "airspace": air, "embassies": nearest, "nearby": near[:8],
        "warnings": warnings, "worst": warnings[0]["level"] if warnings else "low",
    }


def briefing(trip_id: int) -> dict | None:
    trip = get_trip(trip_id)
    if not trip:
        return None
    today = date.today()
    stops = [stop_briefing(s, today) for s in trip["stops"]]
    worst = max((s["worst"] for s in stops), key=lambda w: RANK[w], default="low")
    alerts = _rows("SELECT * FROM trip_alerts WHERE trip_id = ? ORDER BY created_at DESC LIMIT 50", (trip_id,))
    return {"trip": {k: v for k, v in trip.items() if k != "stops"}, "stops": stops, "worst": worst, "alerts": alerts,
            "as_of": datetime.now(timezone.utc).isoformat()}


# ------------------------------------------------------------------ alerts

def _signature(iso2: str | None) -> dict:
    """What matters about a country right now. A part is left out when its layer has not loaded, so 'not loaded
    yet' after a restart can never be mistaken for 'the advisory was removed'."""
    sig: dict = {}
    if not iso2:
        return sig
    if lookup.have("advisory"):
        a = lookup.advisory(iso2)
        sig["adv"] = a["level"] if a else None
        sig["notice"] = (a or {}).get("embassy_notice", "")
    if lookup.have("airspace"):
        sig["air"] = {p["number"]: {"revised": p.get("revised"), "kind": p["kind"], "subject": p["subject"]} for p in lookup.airspace(iso2)}
    if lookup.have("embassy"):
        sig["emb"] = sorted([e["title"], e["status"]] for e in lookup.embassies_in(iso2) if e.get("status") != "active")
    return sig


def _store_snapshot(stop_id: int, iso2: str | None, merge_with: dict | None = None) -> None:
    sig = {**(merge_with or {}), **_signature(iso2)}
    with _db() as c:
        c.execute("INSERT OR REPLACE INTO trip_snapshots VALUES (?,?,?)", (stop_id, json.dumps(sig), time.time()))


def _diff(old: dict, new: dict, country: str) -> list[tuple[str, str, str]]:
    """(kind, severity, text) for everything that changed between two signatures of one country."""
    out = []
    if "adv" in new and "adv" in old and old["adv"] != new["adv"] and new["adv"] is not None:
        up = old["adv"] is None or new["adv"] > old["adv"]
        was = f"Level {old['adv']}" if old["adv"] else "no level"
        out.append(("advisory", "high" if up and new["adv"] >= 3 else "medium" if up else "low",
                    f"the State Dept advisory for {country} changed from {was} to Level {new['adv']} ({LEVEL_TEXT[new['adv']]})."))
    if "notice" in new and "notice" in old and old["notice"] != new["notice"] and new["notice"]:
        out.append(("embassy_notice", "medium", f"the State Dept advisory's note about the embassy in {country} changed: “{new['notice']}”"))
    if "air" in new and "air" in old:
        for number, b in new["air"].items():
            if number not in old["air"]:
                out.append(("airspace_new", "high", f"new EASA airspace bulletin {number} ({b['subject']}), {AIR_TEXT[b['kind']]}."))
            elif old["air"][number].get("revised") != b.get("revised") or old["air"][number].get("kind") != b["kind"]:
                out.append(("airspace_revised", "high" if b["kind"] == "do_not_operate" else "medium",
                            f"EASA revised airspace bulletin {number} ({b['subject']}), now {AIR_TEXT[b['kind']]}."))
        for number, b in old["air"].items():
            if number not in new["air"]:
                out.append(("airspace_ended", "low", f"EASA airspace bulletin {number} ({b['subject']}) is no longer active."))
    if "emb" in new and "emb" in old and old["emb"] != new["emb"]:
        out.append(("embassy_status", "high", f"the status of the US embassy in {country} changed in our list."))
    return out


def check_alerts() -> int:
    """Compare every active stop's country with its last snapshot and record what changed. Returns alerts created."""
    today = date.today().isoformat()
    made = 0
    for stop in _rows("SELECT * FROM trip_stops"):
        end = stop["depart"] or stop["arrive"]
        if (end and end < today) or not stop["iso2"]:
            continue
        snap = _one("SELECT signature FROM trip_snapshots WHERE stop_id = ?", (stop["id"],))
        old = json.loads(snap["signature"]) if snap else None
        if old is None:
            _store_snapshot(stop["id"], stop["iso2"])
            continue
        new = _signature(stop["iso2"])
        country = names.display_name(stop["iso2"])
        found = _diff(old, new, country)
        if found:
            with _db() as c:
                for kind, sev, text in found:
                    c.execute("INSERT INTO trip_alerts (trip_id, stop_id, kind, severity, text, created_at) VALUES (?,?,?,?,?,?)",
                              (stop["trip_id"], stop["id"], kind, sev, f"{stop['label']}: {text}", time.time()))
                    made += 1
        _store_snapshot(stop["id"], stop["iso2"], merge_with=old)
    return made


def list_alerts(unseen_only: bool = False) -> list[dict]:
    sql = "SELECT a.*, t.name AS trip_name FROM trip_alerts a JOIN trips t ON t.id = a.trip_id"
    if unseen_only:
        sql += " WHERE a.seen = 0"
    return _rows(sql + " ORDER BY a.created_at DESC LIMIT 100")


def mark_seen(alert_ids: list[int] | None = None, trip_id: int | None = None) -> int:
    with _db() as c:
        if alert_ids:
            return c.execute(f"UPDATE trip_alerts SET seen = 1 WHERE id IN ({','.join('?' * len(alert_ids))})", alert_ids).rowcount
        if trip_id:
            return c.execute("UPDATE trip_alerts SET seen = 1 WHERE trip_id = ?", (trip_id,)).rowcount
        return c.execute("UPDATE trip_alerts SET seen = 1 WHERE seen = 0").rowcount
