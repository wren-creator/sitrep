"""Heavy rain forecasts from NOAA's Weather Prediction Center: the Excessive Rainfall Outlook, days 1 to 5.

This is the layer that shows a big coastal storm building days ahead, a nor'easter for instance, as an area
of flash flood risk over the region before it arrives. Each area is the chance that rain heavy enough to
cause flash flooding falls within 25 miles of any point in it: Marginal 5%, Slight 15%, Moderate 40%, High 70%.

What to know before changing it:
  - Only Slight and above are kept. Marginal is common (a 1 in 20 chance) and would bury the map and the
    sidebar. Change MIN_LEVEL if that is wrong for you.
  - The map service's layer ids are looked up by name ("Excessive Rainfall Day 3") each refresh.
  - It says where heavy rain is forecast, not what kind of storm is causing it and not wind or snow.
    Wind, snow and coastal flood alerts come from the National Weather Service and are not in this layer yet.
"""
import asyncio
from datetime import datetime, timezone

import httpx

from geo import ring_center
from plugin_base import SitrepPlugin

SERVICE = "https://mapservices.weather.noaa.gov/vector/rest/services/hazards/wpc_precip_hazards/MapServer"
HEADERS = {"User-Agent": "sitrep-personal/0.1 (personal travel tool; britleyhoff@britleyhoffconsulting.com)"}
LEVELS = {"Slight": ("medium", 15), "Moderate": ("high", 40), "High": ("critical", 70)}  # Marginal is left out on purpose
DAYS = range(1, 6)


class Plugin(SitrepPlugin):
    name = "wpc_rain"
    layer = "weather"
    cache_ttl_seconds = 3600

    async def fetch(self):
        async with httpx.AsyncClient(timeout=30, headers=HEADERS) as client:
            meta = await client.get(SERVICE, params={"f": "json"})
            meta.raise_for_status()
            ids = {layer["name"]: layer["id"] for layer in meta.json().get("layers", [])}
            out = {}
            for d in DAYS:
                name = f"Excessive Rainfall Day {d}"
                if name not in ids:
                    raise RuntimeError(f"WPC layer {name!r} not found, the service may have changed")
                await asyncio.sleep(0.3)
                q = await client.get(f"{SERVICE}/{ids[name]}/query", params={
                    "where": "1=1", "outFields": "*", "f": "geojson", "outSR": 4326, "geometryPrecision": 2})
                q.raise_for_status()
                body = q.json()
                if "error" in body:
                    raise RuntimeError(f"WPC {name}: {body['error'].get('message')}")
                out[d] = body.get("features", [])
            return out

    def normalize(self, raw):
        out = []
        for day, feats in raw.items():
            for i, f in enumerate(feats):
                p = f["properties"]
                level = str(p.get("outlook", "")).split(" ")[0]
                if level not in LEVELS or not f.get("geometry"):
                    continue
                sev, pct = LEVELS[level]
                lon, lat = ring_center(f["geometry"])
                issued = str(p.get("issue_time", "")).replace(" ", "T")
                out.append({
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [round(lon, 2), round(lat, 2)]},
                    "properties": {
                        "id": f"wpc-rain:d{day}:{level}:{i}", "layer": self.layer, "kind": "rain", "severity": sev,
                        "title": f"{level} risk of flooding rain, day {day}",
                        "summary": f"At least a {pct}% chance of rain heavy enough to cause flash flooding within 25 miles "
                                   f"of any point in this area. Valid {p.get('valid_time')} (UTC). From the Weather "
                                   f"Prediction Center's Excessive Rainfall Outlook.",
                        "timestamp": (issued + "+00:00") if issued else datetime.now(timezone.utc).isoformat(),
                        "source_url": "https://www.wpc.ncep.noaa.gov/qpf/excessive_rainfall_outlook_ero.php",
                        "_shape": [{"geometry": f["geometry"], "properties": {"part": "rain", "day": day}}],
                    },
                })
        return out
