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
MIN_GAP = 1.0          # seconds between any two upstream requests
MAX_RADIUS_NM = 250    # the API's limit
MAX_AIRCRAFT = 900
STALE_S = 60           # a position older than this is dropped

SQUAWKS = {"7500": "hijack code", "7600": "radio failure", "7700": "general emergency"}
# The ADS-B emergency status field. "lifeguard" is an air ambulance, routine, so it is labelled but kept out of the watch list.
EMERGENCY_TEXT = {"general": "general emergency", "lifeguard": "medical flight", "minfuel": "minimum fuel", "nordo": "no radio",
                  "unlawful": "unlawful interference (possible hijack)", "downed": "aircraft down"}
ROUTINE_ALERTS = {"medical flight"}


class AircraftError(Exception):
    """The message is shown to the user, so keep it plain."""


_gate = asyncio.Lock()
_last = 0.0
_cache: dict[str, tuple[float, object]] = {}


async def _get(url: str):
    global _last
    async with _gate:
        wait = MIN_GAP - (time.monotonic() - _last)
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            async with httpx.AsyncClient(timeout=20, headers=HEADERS) as client:
                r = await client.get(url)
        except httpx.HTTPError as e:
            raise AircraftError(f"Could not reach the aircraft data service ({type(e).__name__}).") from e
        finally:
            _last = time.monotonic()
    if r.status_code == 404:
        return None
    if r.status_code == 429:
        raise AircraftError("The aircraft data service is rate limiting us. Try again in a minute.")
    if r.status_code != 200:
        raise AircraftError(f"The aircraft data service answered HTTP {r.status_code}.")
    try:
        return r.json()
    except ValueError as e:
        raise AircraftError("The aircraft data service sent something unreadable.") from e


async def _cached(key: str, ttl: float, build):
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < ttl:
        return hit[1]
    value = await build()
    if len(_cache) > 300:  # never grow without bound
        cutoff = time.monotonic() - 3600
        for k in [k for k, (t, _) in _cache.items() if t < cutoff]:
            del _cache[k]
    _cache[key] = (time.monotonic(), value)
    return value


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


async def in_area(lat: float, lon: float, nm: float) -> list[dict]:
    """Aircraft within nm of a point. Rounded so nearby views share one upstream request."""
    nm = max(10, min(MAX_RADIUS_NM, round(nm / 10) * 10))
    key = f"area:{round(lat, 1)}:{round(lon, 1)}:{nm}"
    return await _cached(key, 12, lambda: _fetch_area(round(lat, 1), round(lon, 1), nm))


async def _fetch_area(lat: float, lon: float, nm: int) -> list[dict]:
    return _many(await _get(f"{BASE}/point/{lat}/{lon}/{nm}"))


async def watch() -> dict:
    """Worldwide: aircraft squawking an emergency code, and military-flagged aircraft. Slow poll."""
    return await _cached("watch", 60, _build_watch)


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
    _cache[f"route:{cs}"] = (time.monotonic(), result)
    return result
