import httpx

from plugin_base import SitrepPlugin

FEED = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP"
LEVELS = {"green": "low", "orange": "high", "red": "critical"}


class Plugin(SitrepPlugin):
    name = "gdacs"
    layer = "disaster"
    cache_ttl_seconds = 600

    async def fetch(self):
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get(FEED)
            r.raise_for_status()
            return r.json()

    def normalize(self, raw):
        out = []
        for f in raw.get("features", []):
            p = f.get("properties", {})
            geom = f.get("geometry") or {}
            if geom.get("type") != "Point":
                continue
            level = str(p.get("alertlevel", "green")).lower()
            out.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": geom["coordinates"][:2]},
                "properties": {
                    "id": f"gdacs:{p.get('eventtype')}{p.get('eventid')}",
                    "layer": self.layer,
                    "severity": LEVELS.get(level, "low"),
                    "title": p.get("name") or p.get("eventname") or "GDACS event",
                    "summary": p.get("description", ""),
                    "timestamp": p.get("fromdate", ""),
                    "source_url": (p.get("url") or {}).get("report", "https://www.gdacs.org"),
                },
            })
        return out
