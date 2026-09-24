"""National Weather Service watches and warnings that matter for a storm: the wind, coastal flood, storm surge,
winter storm and flash flood alerts. This is the other half of a nor'easter, the WPC rain layer says where it
will rain and this says where it will blow, flood the coast and snow.

Where the polygons come from: api.weather.gov alerts mostly carry a list of forecast zones and no shape of
their own, which would need hundreds of extra requests. NOAA's WWA map service publishes every active alert
already drawn as polygons, so that is what this reads, in one request.

What to know before changing it:
  - Only a chosen list of event types is kept (KEEP). Advisories (small craft, fog, frost, surf), statements
    and river flood alerts are left out on purpose, there are hundreds and they are not what this layer is for.
    Tropical storm and hurricane watches and warnings are left out because the NHC layer already draws them.
  - Gale warnings alone are over 200 marine zones. Alerts are grouped by event type and 10 degree grid cell,
    one feature per group, so the sidebar shows "Coastal Flood Warning, 49 zones" and not 49 rows. The shapes of a
    group are merged into one MultiPolygon. Geometry is simplified to about 5 km to keep the payload near 700 KB.
  - The point that places a group in the sidebar is the mean of its zones, which for a group spanning a coast
    can land at sea. It is a marker for the list, the polygons are the truth.
  - Alerts expire and get reissued every few hours in a storm, so this refreshes every 10 minutes.
"""
from collections import defaultdict
from datetime import datetime, timezone

import httpx

from geo import ring_center
from plugin_base import SitrepPlugin

LAYER = "https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1"
HEADERS = {"User-Agent": "sitrep-personal/0.1 (personal travel tool; britleyhoff@britleyhoffconsulting.com)"}

# event -> (severity, group for colour, plain meaning). Meanings are the standard NWS definitions in short form.
KEEP = {
    "Hurricane Force Wind Warning": ("critical", "wind", "Sustained winds of 64 knots (74 mph) or more expected at sea."),
    "Extreme Wind Warning": ("critical", "wind", "Extreme winds expected soon, seek shelter."),
    "Storm Surge Warning": ("critical", "coastal", "Life-threatening flooding from storm surge is expected."),
    "Blizzard Warning": ("critical", "winter", "Heavy snow or blowing snow and strong wind, near-zero visibility."),
    "Ice Storm Warning": ("critical", "winter", "Ice accumulation likely to bring down trees and power lines."),
    "Storm Warning": ("high", "wind", "Sustained winds of 48 to 63 knots (55 to 72 mph) expected at sea."),
    "High Wind Warning": ("high", "wind", "Damaging winds expected on land."),
    "Coastal Flood Warning": ("high", "coastal", "Flooding of coastal areas from storm surge or high tides is expected."),
    "Flash Flood Warning": ("high", "flash", "Flash flooding is happening or about to."),
    "Winter Storm Warning": ("high", "winter", "Heavy snow, sleet or ice expected, travel will be difficult or dangerous."),
    "Hazardous Seas Warning": ("high", "seas", "Waves or seas hazardous to vessels are expected."),
    "Storm Surge Watch": ("medium", "coastal", "Life-threatening storm surge flooding is possible."),
    "Storm Watch": ("medium", "wind", "Storm force winds (48 knots or more) are possible at sea within about 48 hours."),
    "High Wind Watch": ("medium", "wind", "Damaging winds are possible on land."),
    "Coastal Flood Watch": ("medium", "coastal", "Coastal flooding is possible."),
    "Winter Storm Watch": ("medium", "winter", "Heavy snow, sleet or ice is possible."),
    "Hurricane Force Wind Watch": ("medium", "wind", "Hurricane force winds are possible at sea."),
    "Gale Warning": ("low", "wind", "Sustained winds of 34 to 47 knots (39 to 54 mph) expected at sea."),
    "Gale Watch": ("low", "wind", "Gale force winds (34 knots or more) are possible at sea within about 48 hours."),
}
CELL = 10  # degrees


def _utc(s):
    try:
        return datetime.fromisoformat(s).astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


class Plugin(SitrepPlugin):
    name = "nws_alerts"
    layer = "weather"
    cache_ttl_seconds = 600

    async def fetch(self):
        where = "prod_type IN (" + ",".join("'" + k + "'" for k in KEEP) + ")"
        async with httpx.AsyncClient(timeout=60, headers=HEADERS) as client:
            r = await client.get(f"{LAYER}/query", params={
                "where": where, "outFields": "prod_type,issuance,expiration", "f": "geojson", "outSR": 4326,
                "geometryPrecision": 2, "maxAllowableOffset": 0.06})
            r.raise_for_status()
            body = r.json()
            if "error" in body:
                raise RuntimeError(f"NWS alerts: {body['error'].get('message')}")
            return body.get("features", [])

    def normalize(self, raw):
        groups = defaultdict(list)
        for f in raw:
            event = f["properties"].get("prod_type")
            if event not in KEEP or not f.get("geometry"):
                continue
            lon, lat = ring_center(f["geometry"])
            groups[(event, int(lon // CELL), int(lat // CELL))].append((lon, lat, f))
        out = []
        for (event, cx, cy), members in groups.items():
            sev, group, meaning = KEEP[event]
            lon = sum(m[0] for m in members) / len(members)
            lat = sum(m[1] for m in members) / len(members)
            polys = []
            for _, _, f in members:
                g = f["geometry"]
                polys += [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
            issued = [t for t in (_utc(m[2]["properties"].get("issuance")) for m in members) if t]
            expires = [t for t in (_utc(m[2]["properties"].get("expiration")) for m in members) if t]
            n = len(members)
            span = ""
            if expires and min(expires) == max(expires):
                span = f" Expires {min(expires):%a %H:%M} UTC."
            elif expires:
                span = f" Expires between {min(expires):%a %H:%M} and {max(expires):%a %H:%M} UTC."
            out.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(lon, 2), round(lat, 2)]},
                "properties": {
                    "id": f"nws:{event.lower().replace(' ', '-')}:{cx}:{cy}", "layer": self.layer, "kind": "alert",
                    "severity": sev, "title": f"{event}, {n} area{'s' if n != 1 else ''}, around {abs(round(lat))}°{'N' if lat >= 0 else 'S'} {abs(round(lon))}°{'E' if lon >= 0 else 'W'}",
                    "summary": f"{meaning}{span}",
                    "timestamp": max(issued).isoformat() if issued else datetime.now(timezone.utc).isoformat(),
                    "source_url": "https://alerts.weather.gov",
                    "_shape": [{"geometry": {"type": "MultiPolygon", "coordinates": polys},
                                "properties": {"part": "alert", "group": group, "watch": event.endswith(("Watch",))}}],
                },
            })
        return out
