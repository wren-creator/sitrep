"""Facts-only situation briefs for a clicked marker.

Deliberately not written by a language model. The data behind a marker is thin (a place, an
outlet count, one article link), so a model would mostly reword it and could invent detail,
and this is a safety tool. A brief is the facts we hold, each one traceable to its source:
what was reported and how widely, the lead headline from the source article, what else is
happening nearby, and the nearest operating embassy (returned as data, the page words it).
"""
import asyncio
import html
import ipaddress
import re
import socket
import time
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse

import httpx

NEARBY_KM = 150
NEWS_LAYERS = ("conflict", "unrest")  # machine-coded from news: outlet counts and an article to quote
SEV_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}
TITLE_TTL = 6 * 3600
_titles: dict[str, tuple[float, str | None]] = {}


def _public_host(host: str) -> bool:
    """True only if every address the name resolves to is a public one."""
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    return bool(infos) and all(ipaddress.ip_address(i[4][0]).is_global for i in infos)


def _extract_title(text: str) -> str | None:
    m = (re.search(r'<meta[^>]+property=["\']og:title["\'][^>]*content=["\']([^"\']+)', text, re.I)
         or re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:title', text, re.I)
         or re.search(r"<title[^>]*>(.*?)</title>", text, re.I | re.S))
    if not m:
        return None
    return html.unescape(re.sub(r"\s+", " ", m.group(1))).strip()[:200] or None


async def _fetch_title(url: str) -> str | None:
    # The URLs come from a third-party feed, so never let one point this server at an internal
    # address, including through a redirect. Redirects are followed by hand and checked each hop.
    async with httpx.AsyncClient(timeout=6, follow_redirects=False,
                                 headers={"User-Agent": "Mozilla/5.0 (compatible; sitrep-personal/0.1)"}) as client:
        for _ in range(4):
            u = urlparse(url)
            if u.scheme not in ("http", "https") or not u.hostname:
                return None
            if not await asyncio.to_thread(_public_host, u.hostname):
                return None
            async with client.stream("GET", url) as r:
                if r.is_redirect:
                    loc = r.headers.get("location")
                    if not loc:
                        return None
                    url = urljoin(url, loc)
                    continue
                if r.status_code != 200 or "html" not in r.headers.get("content-type", ""):
                    return None
                buf = b""
                async for chunk in r.aiter_bytes():
                    buf += chunk
                    if len(buf) > 200_000 or b"</head>" in buf.lower():
                        break
                return _extract_title(buf.decode(r.encoding or "utf-8", "replace"))
    return None


async def page_title(url: str) -> str | None:
    hit = _titles.get(url)
    if hit and time.time() - hit[0] < TITLE_TTL:
        return hit[1]
    try:
        title = await _fetch_title(url)
    except (httpx.HTTPError, ValueError, OSError):
        title = None
    _titles[url] = (time.time(), title)
    return title


def _age(ts: str | None) -> str | None:
    if not ts:
        return None
    try:
        t = datetime.fromisoformat(ts)
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    mins = int((datetime.now(timezone.utc) - t).total_seconds() // 60)
    if mins < 2:
        return "just now"
    if mins < 90:
        return f"{mins} minutes ago"
    if mins < 60 * 36:
        return f"{round(mins / 60)} hours ago"
    return f"{round(mins / 1440)} days ago"


def build(p: dict, title: str | None, nearby: list[dict], embassy: dict | None) -> dict:
    """p is the marker's properties. nearby items: {title, severity, km}. embassy: nearest operating one."""
    lines = []
    age = _age(p.get("timestamp"))
    if p.get("layer") in NEWS_LAYERS:
        n = p.get("outlets")
        if n:
            lines.append(f"{n} outlet{'s' if n != 1 else ''} reported this in the last 24 hours.")
        if age:
            lines.append(f"Most recent report: {age}.")
    else:
        lines.append(f"Alert level: {p.get('severity', 'unknown')}.")
        if age:
            lines.append(f"Started {age}.")

    if nearby:
        serious = [x for x in nearby if SEV_RANK.get(x["severity"], 0) >= 2]
        line = f"{len(nearby)} other report{'s' if len(nearby) != 1 else ''} within {NEARBY_KM} km"
        line += f", {len(serious)} rated high or critical." if serious else "."
        lines.append(line)
        top = sorted(nearby, key=lambda x: (-SEV_RANK.get(x["severity"], 0), x["km"]))[:3]
        lines.append("Nearby: " + "; ".join(f"{x['title']} ({x['km']} km)" for x in top) + ".")
    else:
        lines.append(f"No other reports within {NEARBY_KM} km in the data we hold.")

    lines.append("This is machine-coded from news, and datelined places skew toward capitals, so verify at the source."
                 if p.get("layer") in NEWS_LAYERS
                 else "Alert levels come from automated feeds (USGS, GDACS). Verify at the source.")

    headline = None
    if title:
        domain = urlparse(p.get("source_url", "")).netloc.removeprefix("www.")
        headline = {"title": title, "domain": domain, "url": p.get("source_url")}
    near = {k: embassy.get(k) for k in ("title", "km", "iso2", "lat", "lon")} if embassy else None
    return {"headline": headline, "lines": lines, "embassy": near}
