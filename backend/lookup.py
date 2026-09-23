"""Shared reads over the features table, used by the endpoints and by trip briefings."""
import json
import math

from geo import haversine_km

_db = None
SEV_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}


def set_db(factory) -> None:
    global _db
    _db = factory


def _props(layer: str) -> list[dict]:
    with _db() as c:
        return [json.loads(r["json"])["properties"] for r in c.execute("SELECT json FROM features WHERE layer = ?", (layer,))]


def have(layer: str) -> bool:
    """True if the layer has any rows. Used to tell 'no advisory' from 'advisories have not loaded yet'."""
    with _db() as c:
        return c.execute("SELECT 1 FROM features WHERE layer = ? LIMIT 1", (layer,)).fetchone() is not None


def advisory(iso2: str | None) -> dict | None:
    return next((p for p in _props("advisory") if p.get("iso2") == iso2), None) if iso2 else None


def airspace(iso2: str | None) -> list[dict]:
    return [p for p in _props("airspace") if iso2 in p.get("countries", [])] if iso2 else []


def embassies_in(iso2: str | None) -> list[dict]:
    return [p for p in _props("embassy") if p.get("iso2") == iso2] if iso2 else []


def nearest_embassies(lat: float, lon: float, n: int = 1) -> list[dict]:
    """Closest embassies that are operating, straight-line distance (not a driving route)."""
    with _db() as c:
        rows = c.execute("SELECT json FROM features WHERE layer = 'embassy'").fetchall()
    found = []
    for r in rows:
        f = json.loads(r["json"])
        p = f["properties"]
        if p.get("status") != "active":
            continue
        elon, elat = f["geometry"]["coordinates"]
        found.append({**p, "lat": elat, "lon": elon, "km": round(haversine_km(lat, lon, elat, elon))})
    found.sort(key=lambda x: x["km"])
    return found[:n]


def nearby(lat: float, lon: float, km: float = 150, exclude_id: str | None = None) -> list[dict]:
    """Markers within km of a point (not embassies), worst first then closest."""
    dlat = km / 111.0
    dlon = km / (111.0 * max(math.cos(math.radians(lat)), 0.1))
    sql = "SELECT json FROM features WHERE layer != 'embassy' AND lat BETWEEN ? AND ?"
    args = [lat - dlat, lat + dlat]
    if -180 <= lon - dlon and lon + dlon <= 180:  # near the antimeridian skip the cheap box, the exact check follows
        sql += " AND lon BETWEEN ? AND ?"
        args += [lon - dlon, lon + dlon]
    with _db() as c:
        rows = c.execute(sql, args).fetchall()
    out = []
    for r in rows:
        f = json.loads(r["json"])
        p = f["properties"]
        if exclude_id and p["id"] == exclude_id:
            continue
        glon, glat = f["geometry"]["coordinates"]
        d = haversine_km(lat, lon, glat, glon)
        if d <= km:
            out.append({"id": p["id"], "title": p["title"], "layer": p["layer"], "severity": p["severity"],
                        "km": round(d), "source_url": p.get("source_url"), "timestamp": p.get("timestamp")})
    out.sort(key=lambda x: (-SEV_RANK.get(x["severity"], 0), x["km"]))
    return out
