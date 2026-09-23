"""Live aircraft from adsb.lol and routes from adsbdb.com.

adsb.lol aggregates ADS-B from community receivers. Its API is open, licensed ODbL 1.0, so anything shown
from it credits adsb.lol. Routes (airline, origin, destination) come from adsbdb.com by callsign.

What this can and cannot see, and the page says so:
  - Only aircraft in range of a community receiver and broadcasting ADS-B. Coverage is thin over oceans,
    deserts and conflict zones, so an empty patch of sky is NOT evidence that airspace is closed.
  - Military aircraft mostly do not appear. The ones flagged military (dbFlags bit 1) are the ones that do,
    mostly Western, so a count is not a measure of military activity anywhere.
  - Never for navigation or anything safety-critical.

Being a good neighbour to a community service: every upstream call goes through one gate with a minimum gap,
results are cached for seconds to minutes depending on what they are, and the area query is capped at the
250 nautical mile radius the API allows.
"""
import asyncio
import re
import time

import httpx

BASE = "https://api.adsb.lol/v2"
ROUTES = "https://api.adsbdb.com/v0/callsign"
HEADERS = {"User-Agent": "sitrep-personal/0.1 (personal travel tool; britleyhoff@britleyhoffconsulting.com)"}
MIN_GAP = 1.5          # seconds between any two upstream requests, across every gate
MAX_RADIUS_NM = 250    # the API's limit
MAX_AIRCRAFT = 900
STALE_S = 60           # a position older than this is dropped

TRACES = "https://adsb.lol/data/traces"
MAX_TRACE_POINTS = 150
MAX_BATCH = 4

SQUAWKS = {"7500": "hijack code", "7600": "radio failure", "7700": "general emergency"}
# The ADS-B emergency status field. "lifeguard" is an air ambulance, routine, so it is labelled but kept out of the watch list.
EMERGENCY_TEXT = {"general": "general emergency", "lifeguard": "medical flight", "minfuel": "minimum fuel", "nordo": "no radio",
                  "unlawful": "unlawful interference (possible hijack)", "downed": "aircraft down"}
ROUTINE_ALERTS = {"medical flight"}


class AircraftError(Exception):
    """The message is shown to the user, so keep it plain."""


# Two queues, one shared clock. Live positions and routes wait in one queue, the static trace files that seed the trails in
# the other, so a burst of trail seeding can never leave the live view stuck behind it (it once made a poll take 8 seconds).
# But both draw from the same pacing clock, so the COMBINED rate never exceeds one request per MIN_GAP. Two independent gates
# each a second apart could fire together, and adsb.lol answered that with 429s.
class _Gate:
    def __init__(self):
        self.lock = asyncio.Lock()


_clock = {"last": 0.0}
_live, _static = _Gate(), _Gate()
_cache: dict[str, tuple[float, object, float]] = {}  # (monotonic time, value, wall clock time)
_cooldown_until = 0.0  # after a 429 nothing goes upstream until then, whichever gate it would use


async def _get(url: str, gate: _Gate = _live):
    global _cooldown_until
    remaining = _cooldown_until - time.monotonic()
    if remaining > 0:  # we were told to slow down, do not even try until that time has passed
        raise AircraftError(f"The aircraft data service asked us to slow down, trying again in {int(remaining) + 1} seconds.")
    async with gate.lock:
        # claim the next time slot on the shared clock before sleeping, so the other queue sees it taken
        slot = max(time.monotonic(), _clock["last"] + MIN_GAP)
        _clock["last"] = slot
        wait = slot - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            async with httpx.AsyncClient(timeout=20, headers=HEADERS) as client:
                r = await client.get(url)
        except httpx.HTTPError as e:
            raise AircraftError(f"Could not reach the aircraft data service ({type(e).__name__}).") from e
    if r.status_code == 404:
        return None
    if r.status_code == 429:
        try:
            wait = min(600, max(30, int(r.headers.get("retry-after", 60))))
        except ValueError:
            wait = 60
        _cooldown_until = time.monotonic() + wait
        raise AircraftError(f"The aircraft data service asked us to slow down, trying again in {wait} seconds.")
    if r.status_code != 200:
        raise AircraftError(f"The aircraft data service answered HTTP {r.status_code}.")
    try:
        return r.json()
    except ValueError as e:
        raise AircraftError("The aircraft data service sent something unreadable.") from e


async def _cached(key: str, ttl: float, build, stale_for: float = 300):
    """(value, fetched_at, stale). If the build fails the last good value is served for up to stale_for seconds, labelled
    stale, because old positions with an honest label beat an empty screen while the service is asking us to slow down."""
    hit = _cache.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < ttl:
        return hit[1], hit[2], False
    try:
        value = await build()
    except AircraftError:
        if hit and now - hit[0] < stale_for:
            return hit[1], hit[2], True
        raise
    if len(_cache) > 300:  # never grow without bound
        for k in [k for k, (t, _, _w) in _cache.items() if now - t > 3600]:
            del _cache[k]
    wall = time.time()
    _cache[key] = (now, value, wall)
    return value, wall, False


def normalize(a: dict) -> dict | None:
    """One aircraft in the shape the page uses, or None if it has no usable position."""
    lat, lon = a.get("lat"), a.get("lon")
    if lat is None or lon is None or not a.get("hex"):
        return None
    seen = a.get("seen_pos")
    if seen is not None and seen > STALE_S:
        return None
    alt = a.get("alt_baro")
    squawk = a.get("squawk")
    emergency = EMERGENCY_TEXT.get(a.get("emergency"), a.get("emergency")) if a.get("emergency") not in (None, "none") else None
    return {
        "hex": a["hex"], "callsign": (a.get("flight") or "").strip(), "reg": a.get("r"), "type": a.get("t"), "desc": a.get("desc"),
        "alt": "ground" if alt == "ground" else (int(alt) if isinstance(alt, (int, float)) else None),
        "gs": round(a["gs"]) if isinstance(a.get("gs"), (int, float)) else None,
        "track": a.get("track") if isinstance(a.get("track"), (int, float)) else None,
        "lat": lat, "lon": lon, "squawk": squawk,
        "alert": SQUAWKS.get(squawk) or emergency,  # None for a normal flight
        "mil": bool((a.get("dbFlags") or 0) & 1),
    }


def _many(data) -> list[dict]:
    return [n for n in (normalize(a) for a in (data or {}).get("ac", [])) if n][:MAX_AIRCRAFT]


async def in_area(lat: float, lon: float, nm: float) -> dict:
    """Aircraft within nm of a point. Rounded so nearby views share one upstream request."""
    nm = max(10, min(MAX_RADIUS_NM, round(nm / 10) * 10))
    key = f"area:{round(lat, 1)}:{round(lon, 1)}:{nm}"
    value, at, stale = await _cached(key, 15, lambda: _fetch_area(round(lat, 1), round(lon, 1), nm))
    return {"aircraft": value, "as_of": at, "stale": stale}


async def _fetch_area(lat: float, lon: float, nm: int) -> list[dict]:
    return _many(await _get(f"{BASE}/point/{lat}/{lon}/{nm}"))


async def watch() -> dict:
    """Worldwide: aircraft squawking an emergency code, and military-flagged aircraft. Slow poll."""
    value, at, stale = await _cached("watch", 120, _build_watch, stale_for=900)
    return {**value, "as_of": at, "stale": stale}


async def _build_watch() -> dict:
    emergencies: dict[str, dict] = {}
    for code in SQUAWKS:
        for ac in _many(await _get(f"{BASE}/sqk/{code}")):
            if ac["alert"] not in ROUTINE_ALERTS:
                emergencies[ac["hex"]] = ac
    military = [m for m in _many(await _get(f"{BASE}/mil")) if m["alt"] != "ground"]
    return {"emergencies": list(emergencies.values()), "military": military, "as_of": time.time()}


async def route(callsign: str) -> dict:
    """Airline, origin and destination for a callsign. Cached a day, a miss for an hour."""
    cs = callsign.strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{2,8}", cs):
        raise AircraftError("That does not look like a callsign.")
    hit = _cache.get(f"route:{cs}")
    ttl = 86400 if hit and hit[1].get("found") else 3600
    if hit and time.monotonic() - hit[0] < ttl:
        return hit[1]
    data = await _get(f"{ROUTES}/{cs}")
    fr = ((data or {}).get("response") or {})
    fr = fr.get("flightroute") if isinstance(fr, dict) else None
    if not fr or not fr.get("origin") or not fr.get("destination"):
        result = {"found": False, "callsign": cs}
    else:
        def airport(x):
            return {"name": x.get("name"), "iata": x.get("iata_code"), "icao": x.get("icao_code"), "city": x.get("municipality"),
                    "country": x.get("country_name"), "lat": x.get("latitude"), "lon": x.get("longitude")}
        result = {"found": True, "callsign": cs, "airline": (fr.get("airline") or {}).get("name"),
                  "origin": airport(fr["origin"]), "destination": airport(fr["destination"])}
    _cache[f"route:{cs}"] = (time.monotonic(), result, time.time())
    return result


async def trace(hex_code: str) -> dict:
    """The path an aircraft has flown in roughly the last half hour, from adsb.lol's recent trace file.

    A static file per aircraft, so it is fetched only when someone clicks one, never for everything on screen.
    Each point is [seconds, lat, lon, altitude, ground speed, track, ...]. We keep lon, lat and altitude and
    thin it to MAX_TRACE_POINTS, which is plenty to draw a line.
    """
    hx = hex_code.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{6}", hx):
        raise AircraftError("That does not look like an aircraft address.")

    async def build():
        data = await _get(f"{TRACES}/{hx[-2:]}/trace_recent_{hx}.json", _static)
        pts = []
        for p in (data or {}).get("trace", []):
            if len(p) >= 3 and isinstance(p[1], (int, float)) and isinstance(p[2], (int, float)):
                alt = p[3] if len(p) > 3 else None
                pts.append([round(p[2], 4), round(p[1], 4), alt if isinstance(alt, (int, float)) else None])
        if len(pts) > MAX_TRACE_POINTS:
            step = len(pts) / MAX_TRACE_POINTS
            pts = [pts[int(i * step)] for i in range(MAX_TRACE_POINTS)] + [pts[-1]]
        minutes = round(((data or {}).get("trace", [[0]])[-1][0] - (data or {}).get("trace", [[0]])[0][0]) / 60) if pts else 0
        return {"hex": hx, "points": pts, "minutes": minutes}

    value, _, _ = await _cached(f"trace:{hx}", 60, build)
    return value


async def traces(hexes: list[str]) -> dict:
    """Recent tracks for a few aircraft at once, to seed the trails on screen. Sequential through the same gate as
    everything else (a second apart), and capped, so a busy view never turns into a burst of requests."""
    out = {}
    for hx in hexes[:MAX_BATCH]:
        try:
            out[hx.lower()] = (await trace(hx))["points"]
        except AircraftError:
            out[hx.lower()] = []
    return out
