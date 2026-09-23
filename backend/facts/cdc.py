"""CDC Travelers' Health: vaccines, medicines and travel health notices for one destination.

Fetched only when someone opens a country, then cached for a week. Crawling all 244 destination
pages (about 400 KB each) on a schedule would be hard on the CDC's servers and I have already been
rate limited once by another agency doing less. Requests are spaced at least MIN_GAP apart, and a
403 or 429 is treated as "stop and try later", never retried in a loop.

We quote the CDC's own recommendation text and never paraphrase medical advice. The stance tag
(recommended, consider, not recommended) is read from the first sentence only and is a convenience
for scanning, the full CDC text is always shown beside it.
"""
import asyncio
import html
import re
import time

import httpx

from . import cache, names
from .errors import FactsError

BASE = "https://wwwnc.cdc.gov/travel/destinations/traveler/none"
LIST_URL = "https://wwwnc.cdc.gov/travel/destinations/list"
HEADERS = {"User-Agent": "sitrep-personal/0.1 (personal travel tool)"}
MIN_GAP = 3.0                      # seconds between requests to the CDC
INDEX_TTL = 30 * 24 * 3600
# Sub-country pages (islands and regions with their own CDC page). They would need a parent country
# and a wrong guess is worse than no result.
SKIP_SLUGS = {"azores", "canary-islands", "easter-island", "madeira-islands", "wake-island",
              "bonaire", "saba", "sint-eustatius"}

_gate = asyncio.Lock()
_last = 0.0


async def _get(url: str) -> str:
    global _last
    async with _gate:
        wait = MIN_GAP - (time.monotonic() - _last)
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            async with httpx.AsyncClient(timeout=30, follow_redirects=True, headers=HEADERS) as client:
                r = await client.get(url)
        except httpx.HTTPError as e:
            raise FactsError(f"Could not reach the CDC ({type(e).__name__}).") from e
        finally:
            _last = time.monotonic()
    if r.status_code in (403, 429):
        raise FactsError("The CDC is rate limiting or blocking requests right now. Try again later.")
    if r.status_code == 404:
        raise FactsError("The CDC has no page for this destination.")
    if r.status_code != 200:
        raise FactsError(f"The CDC answered with HTTP {r.status_code}.")
    return r.text


def _text(fragment: str) -> str:
    """HTML to plain text, keeping paragraph breaks and list bullets."""
    s = re.sub(r"<(script|style|sup)\b.*?</\1>", "", fragment, flags=re.S)  # sup: footnote markers
    s = re.sub(r"</p>|<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"<li\b[^>]*>", "\n• ", s, flags=re.I)
    s = html.unescape(re.sub(r"<[^>]+>", " ", s)).replace("\xa0", " ")
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in s.split("\n")]
    return "\n".join(ln for ln in lines if ln)


def _line_stance(sentence: str) -> str | None:
    s = sentence.lower()
    if "not recommended" in s:
        return "not_recommended"
    if s.startswith("consider") or "may be considered" in s or "consider " in s:
        return "consider"
    if "recommended" in s or "recommends" in s:
        return "recommended"
    return None


def _stance(name: str, text: str, bullets: bool = False) -> str:
    """recommended, consider, not_recommended, varies, routine or info.

    Read from the first sentence of each paragraph. When paragraphs disagree (recommended for
    some travelers, consider for others, not recommended for the rest) the honest answer is
    "varies", not whichever came first or last. Only a convenience for scanning, the full CDC
    text is always shown beside it.
    """
    if name.lower().startswith("routine"):
        return "routine"
    found = set()
    for line in text.split("\n"):
        if line.startswith("•") and not bullets:
            continue
        first = re.split(r"(?<=[.!?])\s", line.lstrip("• ").strip(), maxsplit=1)[0]
        st = _line_stance(first)
        if st:
            found.add(st)
    if len(found) == 1:
        return found.pop()
    return "varies" if found else "info"


def parse_destination(page: str) -> dict:
    page = re.sub(r"<script.*?</script>|<!--.*?-->", "", page, flags=re.S)
    m = re.search(r'id="vaccines-and-medicines"(.*?)id="non-vaccine', page, re.S)
    if not m:
        raise FactsError("The CDC page layout has changed, so its vaccine list could not be read.")

    vaccines, yellow_fever = [], None
    for tr in re.findall(r"<tr\b.*?</tr>", m.group(1), re.S):
        tds = re.findall(r"<td\b[^>]*>(.*?)</td>", tr, re.S)
        if len(tds) < 2:
            continue  # the header row uses th
        name, text = _text(tds[0]).replace("\n", " ").strip(), _text(tds[1])
        if not name or not text:
            continue
        link = re.search(r'href="(https?://[^"]+)"', tds[0])
        item = {"name": name, "stance": _stance(name, text), "text": text[:1500], "url": link.group(1) if link else None}
        if name.lower() == "yellow fever":
            flat = text.replace("\n", " ")
            rec = re.search(r"CDC recommendations:\s*(.*?)(?=Country entry requirements:|$)", flat, re.S)
            req = re.search(r"Country entry requirements:\s*(.*?)(?=\s*Updated\b|$)", flat, re.S)
            if rec and req:
                yellow_fever = {"cdc": rec.group(1).strip(), "entry": req.group(1).strip()}
                item["stance"] = _stance(name, rec.group(1).replace("•", "\n•"), bullets=True)
        vaccines.append(item)
    if not vaccines:
        raise FactsError("The CDC page had no vaccine table.")

    notices = []
    n = re.search(r'id="travel-notices"(.*?)id="vaccines-and-medicines"', page, re.S)
    if n:
        level = None
        for chunk in re.split(r"(?=<h4 class=\"notice-typename)", n.group(1)):
            lv = re.search(r"notice-typename-level(\d)", chunk)
            if lv:
                level = int(lv.group(1))
            for li in re.findall(r"<li\b.*?</li>", chunk, re.S):
                a = re.search(r'<a href="([^"]+)">(.*?)</a>', li, re.S)
                if a and level:
                    date = re.search(r'class="date">(.*?)<', li)
                    summ = re.search(r'class="summary">(.*?)</span>', li, re.S)
                    notices.append({"level": level, "title": _text(a.group(2)), "url": "https://wwwnc.cdc.gov" + a.group(1),
                                    "date": _text(date.group(1)) if date else "", "summary": _text(summ.group(1)) if summ else ""})
    return {"vaccines": vaccines, "yellow_fever": yellow_fever, "notices": notices}


async def _slugs() -> dict[str, str]:
    row = cache.get("*", "cdc_index")
    if cache.fresh(row, INDEX_TTL):
        if not row["ok"]:
            raise FactsError(row["data"].get("error", "The CDC destination list is unavailable."))
        return row["data"]["slugs"]
    try:
        page = await _get(LIST_URL)
    except FactsError as e:
        cache.put("*", "cdc_index", False, {"error": str(e)})
        raise
    slugs: dict[str, str] = {}
    unresolved = []
    for slug, name in re.findall(r'href="/travel/destinations/traveler/none/([a-z0-9\-]+)"[^>]*>([^<]+)<', page):
        if slug in SKIP_SLUGS:
            continue
        iso2 = names.resolve(html.unescape(name).strip())
        if iso2:
            slugs.setdefault(iso2, slug)
        else:
            unresolved.append(name.strip())
    if "IL" in slugs:
        slugs["PS"] = slugs["IL"]  # the CDC covers Israel, the West Bank and Gaza on one page
    cache.put("*", "cdc_index", True, {"slugs": slugs, "unresolved": sorted(set(unresolved))})
    return slugs


async def fetch(iso2: str) -> dict:
    slug = (await _slugs()).get(iso2)
    if not slug:
        raise FactsError(f"No CDC destination page matches {names.display_name(iso2)}.")
    data = parse_destination(await _get(f"{BASE}/{slug}"))
    data["source_url"] = f"{BASE}/{slug}"
    return data
