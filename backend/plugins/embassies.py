"""US embassies from OpenStreetMap, for the "nearest safe harbor" stars.

OSM tags diplomatic posts with country=US (the country represented) and target=<host
country>. We keep real embassies only. The raw data also holds ambassador residences,
missions to the UN and EU, USAID offices, cultural centers and annexes. None of those
are places to walk into during an emergency, and residences are private addresses.

OSM cannot say whether an embassy is open. Status comes from backend/data/embassy_status.json,
a hand-kept list of embassies that are suspended. Everything else shows as active, and the
popup says the status is not checked live.
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import httpx

from geo import haversine_km
from plugin_base import SitrepPlugin

# Public Overpass servers. The main one is often overloaded, so we try the others too.
MIRRORS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]
QUERY = '[out:json][timeout:60];nwr["diplomatic"="embassy"]["country"="US"];out center tags;'
STATUS_FILE = Path(__file__).resolve().parent.parent / "data" / "embassy_status.json"
CACHE_FILE = Path(__file__).resolve().parents[2] / "data" / "embassies_raw.json"  # last good Overpass download
DIRECTORY = "https://www.usembassy.gov/"

# Street number before the street name in these countries, after it almost everywhere else.
NUMBER_FIRST = {"US", "GB", "CA", "AU", "NZ", "IE", "PH", "IN", "ZA", "SG", "MY", "NG", "KE", "GH", "JM", "TT", "BB", "BS"}
NOT_AN_EMBASSY = re.compile(r"agency for international development|cultural|education foundation|american cent(er|re)", re.I)


def _statuses() -> dict:
    try:
        return json.loads(STATUS_FILE.read_text()).get("countries", {})
    except (OSError, ValueError):
        return {}


def _phones(tags: dict) -> list[str]:
    raw = tags.get("phone") or tags.get("contact:phone") or ""
    out = []
    for p in raw.split(";"):
        p = re.sub(r"[^0-9+()\-. x]", "", p).strip()  # third-party text, keep only phone characters
        if len(re.sub(r"\D", "", p)) >= 6:
            out.append(p)
    return out[:3]


def _address(tags: dict) -> str:
    if tags.get("addr:full"):
        return tags["addr:full"]
    street, num = tags.get("addr:street", ""), tags.get("addr:housenumber", "")
    if street and num:
        line = f"{num} {street}" if tags.get("addr:country") in NUMBER_FIRST else f"{street} {num}"
    else:
        line = street or tags.get("addr:place", "")
    parts = [line, tags.get("addr:suburb"), " ".join(x for x in (tags.get("addr:postcode"), tags.get("addr:city")) if x),
             tags.get("addr:country")]
    return ", ".join(p for p in parts if p)


def _website(tags: dict) -> str:
    url = tags.get("website") or tags.get("contact:website") or ""
    return url if re.match(r"^https?://", url, re.I) else ""


class Plugin(SitrepPlugin):
    name = "embassies"
    layer = "embassy"
    cache_ttl_seconds = 7 * 24 * 3600

    async def fetch(self):
        last = None
        async with httpx.AsyncClient(timeout=90, headers={"User-Agent": "sitrep-personal/0.1 (personal travel tool)"}) as client:
            for url in MIRRORS:
                try:
                    r = await client.post(url, data={"data": QUERY})
                    r.raise_for_status()
                    elements = r.json().get("elements", [])
                    if elements:
                        CACHE_FILE.write_text(json.dumps(elements))
                        return elements
                except (httpx.HTTPError, ValueError) as e:
                    last = e
        # The public Overpass servers are often down. Embassies barely change, so the last
        # good download is far better than an empty map, or an empty map after a restart.
        if CACHE_FILE.exists():
            return json.loads(CACHE_FILE.read_text())
        raise RuntimeError(f"all Overpass mirrors failed and there is no saved copy: {last}")

    def normalize(self, raw):
        statuses = _statuses()
        now = datetime.now(timezone.utc).isoformat()
        cands = []
        for e in raw:
            t = e.get("tags", {})
            if t.get("embassy") not in ("yes", None):  # drops residence, mission, branch_embassy, ...
                continue
            name = t.get("name:en") or t.get("name") or ""
            if NOT_AN_EMBASSY.search(name):
                continue
            lat, lon = (e["lat"], e["lon"]) if "lat" in e else (e["center"]["lat"], e["center"]["lon"])
            host = (t.get("target") or t.get("addr:country") or "").upper() or None
            if host is None:
                # Most embassy sites are <iso2>.usembassy.gov, use that when the tags say nothing.
                m = re.match(r"^https?://([a-z]{2})\.usembassy\.gov", _website(t), re.I)
                host = m.group(1).upper() if m else None
            cands.append((t, lat, lon, host, e))

        # The same embassy is often mapped twice (the compound and a point, or an old and new
        # compound). Fullest entry wins. Two posts never share a compound, so anything within
        # 1.5 km is one embassy, and within 8 km it is one embassy if the host country matches.
        cands.sort(key=lambda c: len(c[0]), reverse=True)
        kept: list = []
        for c in cands:
            close = any(
                (d := haversine_km(c[1], c[2], k[1], k[2])) < 1.5 or (d < 8 and c[3] and c[3] == k[3])
                for k in kept
            )
            if not close:
                kept.append(c)

        out = []
        for (t, lat, lon, host, e) in kept:
            st = statuses.get(host or "", {})
            city = t.get("addr:city", "")
            if not st:  # some entries have no host country, let a status entry match by city name
                text = f"{city} {t.get('addr:full', '')} {t.get('addr:street', '')}".lower()
                st = next((s for s in statuses.values() if s.get("city") and s["city"].lower() in text), {})
            title = t.get("name:en") or "U.S. Embassy"
            # "Embassy of the United States" alone is ambiguous, add the city when the name lacks it.
            if city and city.lower() not in title.lower():
                title = f"{title}, {city}"
            site = _website(t)
            out.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "id": f"embassy:osm:{e['type']}{e['id']}",
                    "layer": self.layer,
                    "severity": "low",
                    "title": title,
                    "summary": "U.S. embassy",
                    "timestamp": now,
                    "source_url": site or DIRECTORY,
                    "iso2": host,
                    "address": _address(t),
                    "phones": _phones(t),
                    "website": site,
                    "status": st.get("status", "active"),
                    "status_note": st.get("note", ""),
                },
            })
        return out
