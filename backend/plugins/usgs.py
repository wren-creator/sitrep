from datetime import datetime, timezone

import httpx

from plugin_base import SitrepPlugin

FEED = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson"


def _severity(mag: float) -> str:
    if mag >= 7:
        return "critical"
    if mag >= 6:
        return "high"
    if mag >= 5:
        return "medium"
    return "low"


class Plugin(SitrepPlugin):
    name = "usgs"
    layer = "disaster"
    cache_ttl_seconds = 300

    async def fetch(self):
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(FEED)
            r.raise_for_status()
            return r.json()

    def normalize(self, raw):
        out = []
        for f in raw.get("features", []):
            p = f["properties"]
            mag = p.get("mag") or 0
            ts = datetime.fromtimestamp(p["time"] / 1000, tz=timezone.utc).isoformat()
            out.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": f["geometry"]["coordinates"][:2]},
                "properties": {
                    "id": f"usgs:{f['id']}",
                    "layer": self.layer,
                    "severity": _severity(mag),
                    "title": f"M{mag:.1f} earthquake, {p.get('place', 'unknown')}",
                    "summary": p.get("title", ""),
                    "timestamp": ts,
                    "source_url": p.get("url", "https://earthquake.usgs.gov"),
                },
            })
        return out
