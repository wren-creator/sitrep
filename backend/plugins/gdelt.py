"""Unrest and conflict from the GDELT 2.0 events export.

GDELT publishes a coded events file every 15 minutes: who did what, where, with
a CAMEO event code, a location, and the source article. The old GEO API is gone
and the DOC API has no coordinates, so this reads the export directly.

We keep a rolling window of parsed files in memory, fetch only the new ones each
run, and aggregate by place and event type so one street fight reported once
does not show up as a headline. Country-level geocodes are dropped on purpose,
they pin the dot to the middle of the country and imply precision that is not
there. Everything here is machine-coded from news, so places and types can be
wrong. The source link is always included.
"""
import asyncio
import csv
import io
import zipfile
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import httpx

from plugin_base import SitrepPlugin

BASE = "https://data.gdeltproject.org/gdeltv2"
WINDOW_HOURS = 24
MAX_FEATURES = 400

# CAMEO root code: (label, minimum distinct outlets to show, severity bump)
# Root 17 (coercion: sanctions, arrests, political pressure) is left out on purpose.
# It was the largest group and almost all political news datelined from capitals.
ROOTS = {
    "14": ("Protests", 4, 0),
    "15": ("Military posturing", 4, 0),
    "18": ("Attacks", 3, 0),
    "19": ("Armed clashes", 3, 0),
    "20": ("Mass violence", 2, 1),
}
LEVELS = ["low", "medium", "high", "critical"]


def _severity(outlets: int, bump: int) -> str:
    # Severity is how many independent outlets are reporting it, not a measure of
    # danger. Raw mention counts were dominated by one outlet repeating itself.
    base = 3 if outlets >= 20 else 2 if outlets >= 10 else 1 if outlets >= 5 else 0
    return LEVELS[min(base + bump, 3)]
# 3 US city, 4 world city, 5 world state/province. 0/1/2 are unknown/country/US state.
GOOD_GEO = {"3", "4", "5"}

# Parsed events by file timestamp. Kept between runs so we only fetch what is new.
_files: dict[str, list[tuple]] = {}


def _stamps(now: datetime) -> list[str]:
    end = now.replace(minute=now.minute - now.minute % 15, second=0, microsecond=0)
    return [(end - timedelta(minutes=15 * i)).strftime("%Y%m%d%H%M%S") for i in range(WINDOW_HOURS * 4)]


def _parse(data: bytes) -> list[tuple]:
    z = zipfile.ZipFile(io.BytesIO(data))
    rows = csv.reader(io.TextIOWrapper(z.open(z.namelist()[0]), encoding="utf-8", errors="replace"), delimiter="\t")
    out = []
    for r in rows:
        if len(r) < 61 or r[28] not in ROOTS or r[51] not in GOOD_GEO or not r[56] or not r[57]:
            continue
        try:
            out.append((r[28], float(r[56]), float(r[57]), r[52], int(r[31] or 0), int(r[33] or 0), r[60], r[59]))
        except ValueError:
            continue
    return out


class Plugin(SitrepPlugin):
    name = "gdelt"
    layer = "conflict"
    cache_ttl_seconds = 900

    async def fetch(self):
        wanted = _stamps(datetime.now(timezone.utc))
        for old in [k for k in _files if k not in wanted]:
            del _files[old]
        missing = [s for s in wanted if s not in _files]
        sem = asyncio.Semaphore(4)

        async with httpx.AsyncClient(timeout=30, follow_redirects=True,
                                     headers={"User-Agent": "sitrep-personal/0.1"}) as client:
            async def one(stamp: str):
                async with sem:
                    try:
                        r = await client.get(f"{BASE}/{stamp}.export.CSV.zip")
                    except httpx.HTTPError:
                        return
                    # The newest file is advertised before it is served, and GDELT
                    # skips a slot now and then. Not an error, retry next run.
                    if r.status_code == 200 and r.content:
                        _files[stamp] = _parse(r.content)

            await asyncio.gather(*(one(s) for s in missing))

        if not _files:
            raise RuntimeError("no GDELT files could be fetched")
        return [ev for evs in _files.values() for ev in evs]

    def normalize(self, raw):
        groups = defaultdict(list)
        for ev in raw:
            groups[(ev[0], round(ev[1], 2), round(ev[2], 2))].append(ev)

        scored = []
        for (root, lat, lon), evs in groups.items():
            label, min_outlets, bump = ROOTS[root]
            outlets = {urlparse(e[6]).netloc.removeprefix("www.") for e in evs}
            if len(outlets) < min_outlets:
                continue
            severity = _severity(len(outlets), bump)
            top = max(evs, key=lambda e: e[4])
            stamp = max(e[7] for e in evs)
            ts = datetime.strptime(stamp, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc).isoformat()
            scored.append((LEVELS.index(severity), len(outlets), {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "id": f"gdelt:{root}:{lat}:{lon}",
                    "layer": self.layer,
                    "severity": severity,
                    "kind": label,
                    "outlets": len(outlets),
                    "title": f"{label} reported near {top[3]}",
                    "summary": f"{len(outlets)} outlets in the last {WINDOW_HOURS}h. Machine-coded from news "
                               f"and datelined places can skew toward capitals, so verify at the source.",
                    "timestamp": ts,
                    "source_url": top[6],
                },
            }))
        scored.sort(key=lambda s: (s[0], s[1]), reverse=True)
        return [s[2] for s in scored[:MAX_FEATURES]]
