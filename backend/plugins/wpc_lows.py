"""Low pressure centres from the Weather Prediction Center's coded surface bulletins: where each low is now, its
pressure in millibars, and where WPC forecasts it to be over the next day or so.

A nor'easter is a coastal low that deepens quickly, so pressure and its trend are the point here. A falling
number is a strengthening storm.

Where it comes from: two plain text bulletins on NWS's file server.
  - asus01 is the current surface analysis, HIGHS and LOWS as "pressure position" pairs
  - fsus02 is the forecast, 12 and 24 hour "PROG" blocks in the same format. That is only about 30 hours out,
    so a storm three days off shows in the rain and alert layers first and here later.
A position is latitude in whole degrees followed by west longitude, "3470" is 34N 70W and "64145" is 64N 145W.
Both bulletins cover the Americas and their oceans, so longitudes here are all west.

What to know before changing it:
  - Only lows that reach 1004 mb or lower somewhere along their track are kept. The analysis has 20-odd lows at any
    time and most are shallow heat lows over the Rockies that mean nothing to a traveller. Change MAX_MB if that is wrong.
  - Lows are linked from one map to the next by nearest position (at most 90 km/h, and a pressure change of no
    more than 25 mb). That is a guess, WPC does not number its lows, so a track can break or, rarely, jump to the
    wrong low. The popup lists the pressures in order so a bad link is visible.
  - The month and year are not in the bulletins' valid times, so they are taken as the nearest date to now.
  - A bulletin that stops parsing (no LOWS found) raises, so a format change shows as an error and not an empty map.
"""
import math
import re
from datetime import datetime, timedelta, timezone

import httpx

from geo import haversine_km
from plugin_base import SitrepPlugin

ANALYSIS = "https://tgftp.nws.noaa.gov/data/raw/as/asus01.kwbc.cod.sus.txt"
FORECAST = "https://tgftp.nws.noaa.gov/data/raw/fs/fsus02.kwbc.cod.srp.txt"
HEADERS = {"User-Agent": "sitrep-personal/0.1 (personal travel tool; britleyhoff@britleyhoffconsulting.com)"}
MAX_MB = 1004
MAX_KMH = 90
MAX_DELTA_MB = 25


def _nearest(day, hour, minute, now):
    """The datetime with this day, hour and minute closest to now, trying last, this and next month."""
    best = None
    for shift in (-1, 0, 1):
        y, m = now.year, now.month + shift
        y, m = y + (m - 1) // 12, (m - 1) % 12 + 1
        try:
            d = datetime(y, m, day, hour, minute, tzinfo=timezone.utc)
        except ValueError:
            continue
        if best is None or abs(d - now) < abs(best - now):
            best = d
    return best


def parse_lows(section):
    """Pairs of pressure and position from the text after LOWS, as [(mb, lat, lon_west_negative)]."""
    tok = section.split()
    out = []
    for i in range(0, len(tok) - 1, 2):
        p, pos = tok[i], tok[i + 1]
        if not (p.isdigit() and pos.isdigit() and len(pos) in (4, 5)):
            continue
        mb, lat, lon = int(p), int(pos[:2]), int(pos[2:])
        if 870 <= mb <= 1100 and 5 <= lat <= 89 and 0 <= lon <= 180:
            out.append((mb, float(lat), -float(lon)))
    return out


def parse_frames(analysis, forecast, now=None):
    """[(valid datetime, lows)] in time order: the analysis, then each forecast block."""
    now = now or datetime.now(timezone.utc)
    frames = []
    m = re.search(r"VALID (\d\d)(\d\d)(\d\d)Z\s+HIGHS.*?LOWS((?:[\s\d])+)", analysis, re.S)
    if not m:
        raise RuntimeError("WPC surface analysis: no LOWS found, the bulletin format may have changed")
    frames.append((_nearest(int(m.group(2)), int(m.group(3)), 0, now), parse_lows(m.group(4))))
    blocks = re.findall(r"\d+HR PROG VALID (\d\d)(\d\d)(\d\d)Z(.*?)(?=\d+HR PROG VALID|\Z)", forecast, re.S)
    if not blocks:
        raise RuntimeError("WPC surface forecast: no PROG blocks found, the bulletin format may have changed")
    for day, hour, minute, body in blocks:
        lm = re.search(r"LOWS((?:[\s\d])+)", body)
        if lm:
            frames.append((_nearest(int(day), int(hour), int(minute), now), parse_lows(lm.group(1))))
    return sorted(frames, key=lambda f: f[0])


def link(frames):
    """Chain lows across frames by nearest position. Returns tracks, each a list of (time, mb, lat, lon)."""
    done, live = [], []
    for t, lows in frames:
        taken, nxt = set(), []
        for track in live:
            lt, _, la, lo = track[-1]
            hours = (t - lt).total_seconds() / 3600
            best = None
            for j, (mb, lat, lon) in enumerate(lows):
                if j in taken or abs(mb - track[-1][1]) > MAX_DELTA_MB:
                    continue
                d = haversine_km(la, lo, lat, lon)
                if d <= MAX_KMH * hours and (best is None or d < best[0]):
                    best = (d, j)
            if best:
                taken.add(best[1])
                mb, lat, lon = lows[best[1]]
                track.append((t, mb, lat, lon))
                nxt.append(track)
            else:
                done.append(track)
        for j, (mb, lat, lon) in enumerate(lows):
            if j not in taken:
                nxt.append([(t, mb, lat, lon)])  # a low that first appears in this map
        live = nxt
    return done + live


def severity(mb):
    return "high" if mb <= 980 else "medium" if mb <= 992 else "low"


class Plugin(SitrepPlugin):
    name = "wpc_lows"
    layer = "weather"
    cache_ttl_seconds = 1800

    async def fetch(self):
        async with httpx.AsyncClient(timeout=30, headers=HEADERS, follow_redirects=True) as client:
            a = await client.get(ANALYSIS)
            a.raise_for_status()
            f = await client.get(FORECAST)
            f.raise_for_status()
            return {"analysis": a.text, "forecast": f.text}

    def normalize(self, raw):
        out = []
        for i, track in enumerate(link(parse_frames(raw["analysis"], raw["forecast"]))):
            low = min(p[1] for p in track)
            if low > MAX_MB:
                continue
            t0, mb0, lat0, lon0 = track[0]
            parts = [{"geometry": {"type": "Point", "coordinates": [lon0, lat0]},
                      "properties": {"part": "low", "label": f"L {mb0}"}}]
            for t, mb, lat, lon in track[1:]:
                parts.append({"geometry": {"type": "Point", "coordinates": [lon, lat]},
                              "properties": {"part": "lowf", "label": str(mb)}})
            if len(track) > 1:
                parts.append({"geometry": {"type": "LineString", "coordinates": [[p[3], p[2]] for p in track]},
                              "properties": {"part": "lowtrack"}})
            steps = ", ".join(f"{mb} mb {t:%a %H}Z" for t, mb, _, _ in track)
            trend = ""
            if len(track) > 1:
                d = track[-1][1] - mb0
                trend = f" {'Deepening' if d <= -4 else 'Filling' if d >= 4 else 'Holding steady'}, {abs(d)} mb over the forecast." if abs(d) >= 4 else " Holding steady."
            out.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon0, lat0]},
                "properties": {
                    "id": f"wpc-low:{i}", "layer": self.layer, "kind": "low", "severity": severity(low),
                    "title": f"Low pressure, {mb0} mb" + (f", forecast to reach {low} mb" if low <= mb0 - 4 else ""),
                    "summary": f"Centre pressure by time: {steps}.{trend} A lower number is a stronger storm.",
                    "timestamp": t0.isoformat(),
                    "source_url": "https://www.wpc.ncep.noaa.gov/html/sfc-zoomer.shtml",
                    "_shape": parts,
                },
            })
        return out
