"""Forecast snow from the Weather Prediction Center's national forecast chart, days 1 to 3: where snow is
forecast, and where heavy snow is possible.

What to know before changing it:
  - It is empty most of the year. Outside winter the service returns one placeholder feature with no shape, which is
    skipped, so an empty map here means no snow is forecast and not that it failed.
  - Layer ids are looked up by name ("Day 2 Heavy Snow Possible") each refresh, since NOAA renumbers them.
  - It says where snow falls, not how much. For amounts and timing read WPC's winter weather pages, linked in the popup.
  - Snow ends up as pale areas and heavy snow as brighter ones with a strong outline. NWS winter storm watches and
    warnings are in the alerts layer, which is the better guide to what to do.
"""
import asyncio
import re

import httpx

from geo import ring_center
from plugin_base import SitrepPlugin

SERVICE = "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/natl_fcst_wx_chart/MapServer"
HEADERS = {"User-Agent": "sitrep-personal/0.1 (personal travel tool; britleyhoff@britleyhoffconsulting.com)"}
KINDS = (("Snow", "medium", "Snow is forecast in this area"), ("Heavy Snow Possible", "high", "Heavy snow is possible in this area"))
DAYS = (1, 2, 3)


def _iso(ms):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat() if ms else ""


class Plugin(SitrepPlugin):
    name = "wpc_snow"
    layer = "weather"
    cache_ttl_seconds = 3600

    async def fetch(self):
        async with httpx.AsyncClient(timeout=30, headers=HEADERS) as client:
            meta = await client.get(SERVICE, params={"f": "json"})
            meta.raise_for_status()
            ids = {layer["name"]: layer["id"] for layer in meta.json().get("layers", [])}
            out = []
            for day in DAYS:
                for label, sev, text in KINDS:
                    name = f"Day {day} {label}"
                    if name not in ids:
                        raise RuntimeError(f"WPC layer {name!r} not found, the service may have changed")
                    await asyncio.sleep(0.3)
                    q = await client.get(f"{SERVICE}/{ids[name]}/query", params={
                        "where": "1=1", "outFields": "*", "f": "geojson", "outSR": 4326, "geometryPrecision": 2})
                    q.raise_for_status()
                    body = q.json()
                    if "error" in body:
                        raise RuntimeError(f"WPC {name}: {body['error'].get('message')}")
                    out += [{"day": day, "heavy": label != "Snow", "sev": sev, "text": text, "f": f} for f in body.get("features", [])]
            return out

    def normalize(self, raw):
        out = []
        for i, r in enumerate(raw):
            f = r["f"]
            if not f.get("geometry"):
                continue  # the placeholder the service returns when there is none
            p = f["properties"]
            lon, lat = ring_center(f["geometry"])
            valid = re.search(r"Valid through: ([^<]*)", p.get("popupconte", ""))
            out.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(lon, 2), round(lat, 2)]},
                "properties": {
                    "id": f"wpc-snow:d{r['day']}:{'heavy' if r['heavy'] else 'snow'}:{i}", "layer": self.layer, "kind": "snow",
                    "severity": r["sev"], "title": f"{'Heavy snow possible' if r['heavy'] else 'Snow forecast'}, day {r['day']}",
                    "summary": f"{r['text']}" + (f", valid through {valid.group(1).strip()}." if valid else ".")
                               + " From the Weather Prediction Center's national forecast chart. It shows where, not how much.",
                    "timestamp": _iso(p.get("idp_filedate")),
                    "source_url": "https://www.wpc.ncep.noaa.gov/wwd/winter_wx.shtml",
                    "_shape": [{"geometry": f["geometry"], "properties": {"part": "snow", "heavy": r["heavy"], "day": r["day"]}}],
                },
            })
        return out
