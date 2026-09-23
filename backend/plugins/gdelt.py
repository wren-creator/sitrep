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

# Two layers, split by who is acting, not just by event type:
#   unrest   civil: protests and riots, violent repression of civilians, curfews and emergency rule
#   conflict military: armed forces, rebels and insurgents fighting, attacking, or posturing
# The armed test matters. Only about 14% of "fight" events (CAMEO 19) and 9% of "assault" events
# (18) have any military or armed-group actor. The rest are governments, police, courts and
# civilians, which is politics and ordinary crime, and it flooded the first version of this layer.
ARMED = {"MIL", "REB", "INS", "SEP", "UAF", "IMG"}  # military, rebels, insurgents, separatists, other armed forces
ACTOR1_TYPES = (12, 13, 14)                         # Actor1 type code columns
ACTOR2_TYPES = (22, 23, 24)                         # Actor2 type code columns
CIVIL = {"CVL", "LAB", "EDU", "OPP", "AGR"}         # civilians, labour, students, opposition, farmers
STATE_FORCE = {"COP", "MIL", "GOV"}                 # police, military, government

# kind: (layer, label, minimum distinct outlets to show, severity bump)
KINDS = {
    # Civil unrest is covered by far fewer outlets than a war, so its bar is lower. Even so this feed
    # captures it thinly, expect a dozen or so markers and check the headline in each popup.
    "protest":    ("unrest", "Protests", 2, 0),
    "repression": ("unrest", "Violent repression of civilians", 2, 1),
    "curfew":     ("unrest", "Curfew or emergency rule", 2, 1),
    "posture":    ("conflict", "Military posturing", 4, 0),
    "clash":      ("conflict", "Armed clashes", 3, 0),
    "attack":     ("conflict", "Attacks by armed groups", 3, 0),
    "mass":       ("conflict", "Mass violence", 2, 1),
}
LEVELS = ["low", "medium", "high", "critical"]


def _severity(outlets: int, bump: int) -> str:
    # Severity is how many independent outlets are reporting it, not a measure of
    # danger. Raw mention counts were dominated by one outlet repeating itself.
    base = 3 if outlets >= 20 else 2 if outlets >= 10 else 1 if outlets >= 5 else 0
    return LEVELS[min(base + bump, 3)]


def _kind(root: str, code: str, t1: set, t2: set) -> str | None:
    """Which kind of event this is, or None if it is neither civil unrest nor military conflict.

    t1 and t2 are the actor type codes on each side. Event type alone is not enough: a government
    "boycotting" a song contest, or a politician giving a speech, is coded as protest, and a
    migrants story is coded as violent repression.
    """
    if root == "14":
        # 141 demonstrate, 142 hunger strike, 143 strike or boycott, 144 obstruct, 145 riot. Code 140 is
        # "engage in political dissent", a speech and not people in the street. And it needs a civil-society
        # actor, a government acting alone is not a protest.
        return "protest" if code != "140" and (t1 | t2) & CIVIL else None
    if code == "175":
        return "repression" if t1 & STATE_FORCE and t2 & CIVIL else None  # state forces against civilians
    if code in ("1723", "1724"):
        return "curfew"                  # impose curfew, state of emergency or martial law
    if root == "20":
        return "mass"                    # mass killings and similar, armed or not
    if not (t1 | t2) & ARMED:
        return None                      # the rest only counts when an armed actor is involved
    return {"15": "posture", "19": "clash", "18": "attack"}.get(root)


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
        if len(r) < 61 or r[51] not in GOOD_GEO or not r[56] or not r[57]:
            continue
        kind = _kind(r[28], r[26], {r[i] for i in ACTOR1_TYPES if r[i]}, {r[i] for i in ACTOR2_TYPES if r[i]})
        if not kind:
            continue
        try:
            out.append((kind, float(r[56]), float(r[57]), r[52], int(r[31] or 0), int(r[33] or 0), r[60], r[59]))
        except ValueError:
            continue
    return out


class Plugin(SitrepPlugin):
    name = "gdelt"
    layer = "conflict"  # the main one, features carry their own layer (unrest or conflict)
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
        for (kind, lat, lon), evs in groups.items():
            layer, label, min_outlets, bump = KINDS[kind]
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
                    "id": f"gdelt:{kind}:{lat}:{lon}",
                    "layer": layer,
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
