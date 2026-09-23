"""Visa and entry rules for US citizens, from Wikipedia's "Visa requirements for United States citizens".

The State Department's own country pages return 403 to anything but a browser, and working around
that is not something to do quietly, so this uses Wikipedia instead. It is crowd-edited, kept up
to date by many hands, and licensed CC BY-SA 4.0, so it is attributed wherever it is shown along
with the revision it was read from. It is a starting point, not an authority: the destination's
embassy decides, and passport validity rules (often six months beyond your stay) are usually not in
the table at all.

One request fetches the whole page (about 1.7 MB), then it is cached for a week and every country
is looked up from that copy. Rows for regions (Sudan - Darfur, Crimea) are skipped because they
do not resolve to a whole country.
"""
import html
import re

import httpx

from . import cache, names
from .errors import FactsError

PAGE = "Visa requirements for United States citizens"
API = "https://en.wikipedia.org/w/api.php"
SOURCE_URL = "https://en.wikipedia.org/wiki/Visa_requirements_for_United_States_citizens"
HEADERS = {"User-Agent": "sitrep-personal/0.1 (personal travel tool; britleyhoff@britleyhoffconsulting.com)"}
TTL = 7 * 24 * 3600


def _cells(tr: str) -> list[str]:
    out = []
    for _attrs, body in re.findall(r"<t[dh]\b([^>]*)>(.*?)</t[dh]>", tr, re.S):
        body = re.sub(r"<(sup|style)\b.*?</\1>", "", body, flags=re.S)  # citation markers and inline CSS
        out.append(re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", body))).strip())
    return out


def _category(req: str) -> str:
    r = req.lower()
    if "not required" in r or "freedom of movement" in r:
        return "visa_free"
    if "refused" in r or "prohibit" in r or "not permitted" in r:
        return "restricted"
    electronic = "evisa" in r or "e-visa" in r or "electronic" in r
    if "on arrival" in r:
        return "on_arrival_or_electronic" if electronic else "on_arrival"
    if electronic:
        return "electronic"
    if "permit" in r or "permission" in r:
        return "permit"
    if "visa required" in r:
        return "visa_required"
    return "other"


def parse(page_html: str) -> tuple[dict, list[str]]:
    rows: dict[str, dict] = {}
    unresolved: list[str] = []
    for table in re.findall(r"<table.*?</table>", page_html, re.S):
        head = " ".join(_cells(re.search(r"<tr\b.*?</tr>", table, re.S).group(0))) if "<tr" in table else ""
        if "Visa requirement" not in head or "Allowed stay" not in head:
            continue
        for tr in re.findall(r"<tr\b.*?</tr>", table, re.S)[1:]:
            c = _cells(tr)
            if len(c) < 4 or not c[0]:
                continue
            iso2 = names.resolve(c[0])
            if not iso2:
                unresolved.append(c[0])
                continue
            notes = re.sub(r"\[\s*\d+\s*\]", "", c[3]).strip()
            if len(notes) > 700:
                notes = notes[:700].rsplit(". ", 1)[0] + "."
            rows.setdefault(iso2, {"requirement": c[1], "category": _category(c[1]), "allowed_stay": c[2], "notes": notes})
    return rows, unresolved


async def _index() -> dict:
    row = cache.get("*", "wiki_visa_index")
    if cache.fresh(row, TTL):
        if not row["ok"]:
            raise FactsError(row["data"].get("error", "Wikipedia's visa table is unavailable."))
        return row["data"]
    try:
        async with httpx.AsyncClient(timeout=60, headers=HEADERS) as client:
            r = await client.get(API, params={"action": "parse", "page": PAGE, "prop": "text|revid",
                                              "format": "json", "formatversion": 2})
            r.raise_for_status()
            parsed = r.json()["parse"]
    except (httpx.HTTPError, KeyError, ValueError) as e:
        msg = f"Could not read Wikipedia's visa table ({type(e).__name__})."
        cache.put("*", "wiki_visa_index", False, {"error": msg})
        raise FactsError(msg) from e
    rows, unresolved = parse(parsed["text"])
    if len(rows) < 100:  # the page layout changed, do not serve a half-empty table as truth
        msg = f"Wikipedia's visa table looked wrong ({len(rows)} countries found), not using it."
        cache.put("*", "wiki_visa_index", False, {"error": msg})
        raise FactsError(msg)
    data = {"rows": rows, "revid": parsed.get("revid"), "unresolved": sorted(set(unresolved))}
    cache.put("*", "wiki_visa_index", True, data)
    return data


async def fetch(iso2: str) -> dict:
    idx = await _index()
    row = idx["rows"].get(iso2)
    if not row:
        raise FactsError(f"No entry rule for {names.display_name(iso2)} in the visa table.")
    return {**row, "revid": idx["revid"], "source_url": SOURCE_URL, "license": "CC BY-SA 4.0"}
