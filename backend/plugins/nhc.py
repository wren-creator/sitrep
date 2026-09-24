"""Tropical cyclones and development areas from the National Hurricane Center (Atlantic, Eastern Pacific)
and the Central Pacific Hurricane Center (Hawaii). One source, both centers, because NHC publishes both.

What it gives the map:
  - every active storm as a point, with its forecast cone, forecast track and points, past track, and any
    watch or warning lines along the coast
  - the seven-day outlook areas, the shaded blobs where a storm is likely to form and the odds of it

How it works, and what to know before changing it:
  - CurrentStorms.json lists the active storms. Each has a "bin" (AT1, EP2, CP1...) and NHC's ArcGIS service
    has a set of layers per bin, named "<bin> Forecast Cone" and so on. Layer ids shift when NHC reworks the
    service, so they are looked up by name each refresh, never hard coded.
  - The cone is where the CENTRE is expected to go about two thirds of the time. It is not the size of the
    storm and impacts (wind, surge, rain) reach well outside it. The popup says so.
  - Geometry is rounded to 0.01 degrees (about a kilometre) to keep the cone small.
  - Tropical cyclones elsewhere in the world (West Pacific typhoons, Indian Ocean) are not NHC's job, and are
    covered by the GDACS disaster layer.
  - The shapes ride along in each feature's `_shape`, which /api/weather flattens for the map. They are
    stripped from /api/features and /api/headlines.
"""
import asyncio
from datetime import datetime, timezone

import httpx

from geo import ring_center
from plugin_base import SitrepPlugin

CURRENT = "https://www.nhc.noaa.gov/CurrentStorms.json"
SERVICE = "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer"
HEADERS = {"User-Agent": "sitrep-personal/0.1 (personal travel tool; britleyhoff@britleyhoffconsulting.com)"}
OUTLOOK_LAYER = "Seven-Day: Potential Development Region"
KIND = {"TD": "Tropical depression", "TS": "Tropical storm", "HU": "Hurricane", "STD": "Subtropical depression",
        "STS": "Subtropical storm", "PTC": "Potential tropical cyclone", "PC": "Post-tropical cyclone"}
RISK_SEV = {"low": "low", "medium": "medium", "high": "high"}
COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


def category(kt: float) -> int:
    """Saffir-Simpson category from sustained wind in knots, 0 below hurricane strength."""
    for n, floor in ((5, 137), (4, 113), (3, 96), (2, 83), (1, 64)):
        if kt >= floor:
            return n
    return 0


def storm_severity(kt: float) -> str:
    if kt >= 96:
        return "critical"
    if kt >= 64:
        return "high"
    if kt >= 34:
        return "medium"
    return "low"


def _mph(kt: float) -> int:
    return round(kt * 1.15078)


def _iso(ms) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat() if ms else ""


class Plugin(SitrepPlugin):
    name = "nhc"
    layer = "weather"
    cache_ttl_seconds = 1800

    async def fetch(self):
        async with httpx.AsyncClient(timeout=30, headers=HEADERS) as client:
            r = await client.get(CURRENT)
            r.raise_for_status()
            storms = r.json().get("activeStorms", [])
            meta = await client.get(SERVICE, params={"f": "json"})
            meta.raise_for_status()
            ids = {layer["name"]: layer["id"] for layer in meta.json().get("layers", [])}

            async def query(name):
                if name not in ids:
                    raise RuntimeError(f"NHC layer {name!r} not found, the service may have changed")
                await asyncio.sleep(0.3)  # gentle, this is a public government service
                q = await client.get(f"{SERVICE}/{ids[name]}/query", params={
                    "where": "1=1", "outFields": "*", "f": "geojson", "outSR": 4326, "geometryPrecision": 2})
                q.raise_for_status()
                body = q.json()
                if "error" in body:
                    raise RuntimeError(f"NHC {name}: {body['error'].get('message')}")
                return body.get("features", [])

            shapes = {}
            for s in storms:
                b = s["binNumber"]
                shapes[b] = {part: await query(f"{b} {label}") for part, label in (
                    ("cone", "Forecast Cone"), ("track", "Forecast Track"), ("points", "Forecast Points"),
                    ("warnings", "Watch-Warning"), ("past", "Past Track"))}
            return {"storms": storms, "shapes": shapes, "outlook": await query(OUTLOOK_LAYER)}

    def normalize(self, raw):
        out = []
        for s in raw["storms"]:
            out.append(self._storm(s, raw["shapes"].get(s["binNumber"], {})))
        for i, a in enumerate(raw["outlook"]):
            f = self._outlook(a, i)
            if f:
                out.append(f)
        return out

    def _storm(self, s, sh):
        kt = float(s.get("intensity") or 0)
        cat = category(kt)
        kind = KIND.get(s.get("classification"), "Tropical cyclone")
        label = f"{kind} {s['name']}" + (f" (Category {cat})" if cat else "")
        moving = ""
        if s.get("movementSpeed") not in (None, "") and s.get("movementDir") not in (None, ""):
            moving = f" Moving {COMPASS[round(float(s['movementDir']) / 22.5) % 16]} at {s['movementSpeed']} mph."
        pressure = f", pressure {s['pressure']} mb" if s.get("pressure") else ""
        warned = sorted({f["properties"].get("tcww") for f in sh.get("warnings", [])})
        ww = []
        if "HWR" in warned:
            ww.append("hurricane warning")
        if "HWA" in warned:
            ww.append("hurricane watch")
        if "TWR" in warned:
            ww.append("tropical storm warning")
        if "TWA" in warned:
            ww.append("tropical storm watch")
        parts = []
        for f in sh.get("cone", []):
            parts.append({"geometry": f["geometry"], "properties": {"part": "cone"}})
        for f in sh.get("past", []):
            parts.append({"geometry": f["geometry"], "properties": {"part": "past"}})
        for f in sh.get("track", []):
            parts.append({"geometry": f["geometry"], "properties": {"part": "track"}})
        for f in sh.get("warnings", []):
            parts.append({"geometry": f["geometry"], "properties": {"part": "warning", "tcww": f["properties"].get("tcww")}})
        for f in sh.get("points", []):
            p = f["properties"]
            if not p.get("tau"):
                continue  # tau 0 is the storm's own position, which is the marker
            day = (p.get("datelbl") or "").split(" ")[-1]
            parts.append({"geometry": f["geometry"], "properties": {
                "part": "fcst", "wind": p.get("maxwind"), "cat": category(p.get("maxwind") or 0),
                "label": f"{day} {p['maxwind']} kt" if p["tau"] % 24 == 0 and p.get("maxwind") else ""}})
        return {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [s["longitudeNumeric"], s["latitudeNumeric"]]},
            "properties": {
                "id": f"nhc:{s['id']}", "layer": self.layer, "kind": "storm", "severity": storm_severity(kt),
                "name": s["name"], "title": label,
                "summary": f"Sustained winds {kt:.0f} kt ({_mph(kt)} mph){pressure}.{moving}"
                           + (f" In effect: {', '.join(ww)}." if ww else ""),
                "timestamp": s.get("lastUpdate", ""),
                "source_url": (s.get("publicAdvisory") or {}).get("url", "https://www.nhc.noaa.gov"),
                "discussion_url": (s.get("forecastDiscussion") or {}).get("url", ""),
                "_shape": parts,
            },
        }

    def _outlook(self, a, i):
        p = a["properties"]
        risks = [str(p.get("risk2day", "")).lower(), str(p.get("risk7day", "")).lower()]
        sev = max((RISK_SEV.get(r, "low") for r in risks), key=["low", "medium", "high"].index)
        lon, lat = ring_center(a["geometry"])
        if p.get("basin") == "Atlantic":
            where = "Atlantic"
        else:
            where = "Eastern Pacific" if lon > -140 else "Central Pacific"
        return {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(lon, 2), round(lat, 2)]},
            "properties": {
                "id": f"nhc-outlook:{p.get('basin')}:{i}", "layer": self.layer, "kind": "outlook", "severity": sev,
                "title": f"{where}: area to watch for a tropical storm, {p.get('prob7day')} chance in 7 days",
                "summary": f"NHC gives this area a {p.get('prob2day')} chance of forming a tropical cyclone in the next 2 days "
                           f"({p.get('risk2day')}) and {p.get('prob7day')} in the next 7 days ({p.get('risk7day')}). "
                           f"Nothing has formed yet, the shaded area is where it is expected to.",
                "timestamp": _iso(p.get("idp_filedate")),
                "source_url": "https://www.nhc.noaa.gov/gtwo.php",
                "_shape": [{"geometry": a["geometry"], "properties": {"part": "outlook"}}],
            },
        }
