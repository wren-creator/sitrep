"""LGBT+ information for a country, from three sources shown side by side.

There is deliberately no composite "safety score" made up here. Each source measures something
different, and averaging them would produce a precise-looking number that means nothing:

  Equaldex Equality Index   laws and public attitudes, 0 to 100. Open JSON, no key. Terms: credit and link
                            Equaldex, no storing data more than 30 days (we cache 7 and purge at 25), no
                            commercial use, and "do not track the index over time or publish comparisons of
                            historical scores". So only current values are kept, never a history.
  Legal gender change       Wikipedia's "Legal status of transgender people" (partly Spartacus Gay Travel
                            Index data), CC BY-SA 4.0.
  UK FCDO advice            the "LGBT+ travellers" section of the Foreign Office's travel advice, quoted as
                            written. Open Government Licence.

None of them measures the risk to you on a given street. City and countryside differ, and a good legal
score does not make every place safe. The page says so next to the numbers.

This provider caches its own pieces (each source has its own TTL and its own retry), so it is not cached
again as a whole, and one failing source does not hide the other two.
"""
import asyncio
import html
import re

import httpx

from . import cache, names
from .errors import FactsError

CACHED_INTERNALLY = True

HEADERS = {"User-Agent": "sitrep-personal/0.1 (personal travel tool; britleyhoff@britleyhoffconsulting.com)"}
TTL = 7 * 24 * 3600
EQ_URL = "https://www.equaldex.com/api/equality-index?format=json"
EQ_PAGE = "https://www.equaldex.com/equality-index"
EQ_MAX_AGE = 25 * 24 * 3600          # purge well inside Equaldex's 30 day storage limit, see purge_old()
WIKI_API = "https://en.wikipedia.org/w/api.php"
WIKI_TRANS_PAGE = "Legal status of transgender people"
WIKI_TRANS_URL = "https://en.wikipedia.org/wiki/Legal_status_of_transgender_people"
FCDO_INDEX = "https://www.gov.uk/api/content/foreign-travel-advice"
FCDO_PAGE = "https://www.gov.uk/foreign-travel-advice/"
FCDO_ALIASES = {"israel and the occupied palestinian territories": ("IL", "PS")}


def purge_old() -> None:
    """Never keep Equaldex data past its 30 day limit, even for a country nobody has opened since."""
    cache.purge("equaldex_index", EQ_MAX_AGE)


async def _get_json(url: str, params: dict | None = None, timeout: int = 60):
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, headers=HEADERS) as c:
            r = await c.get(url, params=params)
            r.raise_for_status()
            return r.json()
    except (httpx.HTTPError, ValueError) as e:
        raise FactsError(f"Could not reach {httpx.URL(url).host} ({type(e).__name__}).") from e


async def _cached_index(provider: str, build, ttl: float = TTL) -> dict:
    """One shared table (all countries) fetched at most once per ttl. A failure is remembered for 15 minutes."""
    row = cache.get("*", provider)
    if cache.fresh(row, ttl):
        if not row["ok"]:
            raise FactsError(row["data"].get("error", "unavailable"))
        return row["data"]
    try:
        data = await build()
    except FactsError as e:
        cache.put("*", provider, False, {"error": str(e)})
        raise
    cache.put("*", provider, True, data)
    return data


# ---------------------------------------------------------------- Equaldex

async def _build_equaldex() -> dict:
    rows = await _get_json(EQ_URL, timeout=30)
    out = {}
    for r in rows if isinstance(rows, list) else []:
        try:
            iso2 = str(r["region_id"]).upper()
            index, legal, rank = int(r["ei"]), int(r["ei_legal"]), int(r["rank"])
            # About 22 countries (Tajikistan, North Korea, Fiji...) have no public opinion data. Equaldex
            # then scores them on the legal side alone, so opinion is None, not zero and not dropped.
            opinion = int(r["ei_po"]) if r.get("ei_po") is not None else None
        except (KeyError, TypeError, ValueError):
            continue
        scores = [index, legal] + ([opinion] if opinion is not None else [])
        if len(iso2) == 2 and all(0 <= v <= 100 for v in scores):
            out[iso2] = {"name": r.get("name", iso2), "index": index, "legal": legal, "opinion": opinion, "rank": rank}
    if len(out) < 100:  # the format changed, do not show a half-empty table as truth
        raise FactsError(f"Equaldex's index looked wrong ({len(out)} countries), not using it.")
    return {"rows": out, "of": len(out)}


async def equaldex_index() -> dict:
    return await _cached_index("equaldex_index", _build_equaldex)


async def _equaldex(iso2: str) -> dict:
    idx = await equaldex_index()
    row = idx["rows"].get(iso2)
    if not row:
        raise FactsError(f"Equaldex has no index for {names.display_name(iso2)}.")
    return {**row, "of": idx["of"], "source_url": EQ_PAGE}


# ---------------------------------------------------------------- Legal gender change (Wikipedia)

def _cell(c: str) -> str:
    c = re.sub(r"<(sup|style)\b.*?</\1>", "", c, flags=re.S)
    c = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", c))).strip()
    return re.sub(r"\s*\[\s*\w*\s*\d*\s*\]", "", c).strip()  # leftover footnote markers like "[ 79 ]"


async def _build_trans() -> dict:
    parsed = (await _get_json(WIKI_API, {"action": "parse", "page": WIKI_TRANS_PAGE, "prop": "text|revid",
                                         "format": "json", "formatversion": 2, "redirects": 1}))["parse"]
    rows: dict[str, str] = {}
    for table in re.findall(r"<table.*?</table>", parsed["text"], re.S):
        trs = re.findall(r"<tr\b.*?</tr>", table, re.S)
        head = [_cell(c) for c in re.findall(r"<t[dh]\b[^>]*>(.*?)</t[dh]>", trs[0], re.S)] if trs else []
        if head[:2] != ["Country", "Status"] or len(trs) < 150:
            continue
        for tr in trs[1:]:
            c = [_cell(x) for x in re.findall(r"<t[dh]\b[^>]*>(.*?)</t[dh]>", tr, re.S)]
            iso2 = names.resolve(c[0]) if len(c) >= 2 else None
            if iso2 and c[1]:
                rows.setdefault(iso2, c[1])
    if len(rows) < 100:
        raise FactsError(f"Wikipedia's trans legal status table looked wrong ({len(rows)} countries), not using it.")
    return {"rows": rows, "revid": parsed.get("revid")}


async def _trans(iso2: str) -> dict:
    idx = await _cached_index("wiki_trans_index", _build_trans)
    status = idx["rows"].get(iso2)
    if not status:
        raise FactsError(f"No entry for {names.display_name(iso2)} in the trans legal status table.")
    return {"status": status, "revid": idx["revid"], "source_url": WIKI_TRANS_URL, "license": "CC BY-SA 4.0"}


# ---------------------------------------------------------------- UK FCDO travel advice

async def _build_fcdo_index() -> dict:
    data = await _get_json(FCDO_INDEX)
    slugs: dict[str, str] = {}
    for child in data.get("links", {}).get("children", []):
        country = (child.get("details") or {}).get("country") or {}
        name, slug = country.get("name", ""), country.get("slug")
        if not slug:
            continue
        codes = FCDO_ALIASES.get(names.norm(name)) or ((names.resolve(name),) if names.resolve(name) else ())
        for code in codes:
            slugs.setdefault(code, slug)
    if len(slugs) < 150:
        raise FactsError(f"The FCDO index looked wrong ({len(slugs)} countries), not using it.")
    return {"slugs": slugs}


def _extract_lgbt_section(parts: list[dict]) -> list[dict]:
    """The paragraphs and bullets under the heading "LGBT+ travellers", up to the next heading."""
    for part in parts:
        body = part.get("body") or ""
        tokens = list(re.finditer(r"<(h[2-4])\b[^>]*>(.*?)</\1>|<(p|li)\b[^>]*>(.*?)</\3>", body, re.S))
        for i, m in enumerate(tokens):
            if not (m.group(1) and re.match(r"\s*LGBT", _cell(m.group(2)), re.I)):
                continue
            level, out = int(m.group(1)[1]), []
            for n in tokens[i + 1:]:
                if n.group(1):
                    if int(n.group(1)[1]) <= level:
                        break
                    continue
                text = _cell(n.group(4))
                if text and not text.lower().startswith("read more advice"):  # a link back to the general LGBT+ page
                    out.append({"kind": n.group(3), "text": text})
            if out:
                return out
    return []


async def _fcdo(iso2: str) -> dict:
    idx = await _cached_index("fcdo_index", _build_fcdo_index, ttl=30 * 24 * 3600)
    slug = idx["slugs"].get(iso2)
    if not slug:
        raise FactsError(f"The FCDO has no travel advice page for {names.display_name(iso2)}.")
    row = cache.get(iso2, "fcdo_lgbt")
    if not cache.fresh(row, TTL):
        try:
            page = await _get_json(f"{FCDO_INDEX}/{slug}")
            data = {"paragraphs": _extract_lgbt_section(page.get("details", {}).get("parts", [])),
                    "updated": page.get("public_updated_at"), "url": FCDO_PAGE + slug}
            row = cache.put(iso2, "fcdo_lgbt", True, data)
        except FactsError as e:
            row = cache.put(iso2, "fcdo_lgbt", False, {"error": str(e)})
    if not row["ok"]:
        raise FactsError(row["data"]["error"])
    return row["data"]


# ---------------------------------------------------------------- put together

async def fetch(iso2: str) -> dict:
    out = {}
    results = await asyncio.gather(_equaldex(iso2), _trans(iso2), _fcdo(iso2), return_exceptions=True)
    for key, res in zip(("equaldex", "trans_legal", "fcdo"), results):
        if isinstance(res, FactsError):
            out[key] = {"ok": False, "error": str(res)}
        elif isinstance(res, Exception):
            out[key] = {"ok": False, "error": f"Unexpected error ({type(res).__name__})."}
        else:
            out[key] = {"ok": True, **res}
    return out
