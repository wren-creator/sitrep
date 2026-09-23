"""EASA Conflict Zone Information Bulletins (CZIBs): the European regulator's airspace warnings.

A CZIB tells airlines that the airspace over somewhere has become dangerous for civil aircraft, and what to
do about it ("not operate", "exercise caution"). They are dated, and when one appears or is revised it
means EASA's assessment of the risk just changed, which makes them the most useful official signal for
"something may be about to happen". They are a signal, not a prediction: several are long-running
(Afghanistan since 2017, Ukraine since 2022) and they reflect risk to aircraft, not to people on the ground.

How it works:
  - The list page (one request, about 33 rows) is read every refresh. It has every bulletin, active and withdrawn.
  - Each active bulletin's own page has the structured fields: the affected countries as an explicit list,
    the affected FIRs, the situation, and the recommendations. A detail page (about 290 KB) is fetched only
    when the bulletin is new or its revision date changed, then kept in data/easa_czib.json. The first run
    reads about 15 pages, three seconds apart, and after that almost nothing.
  - Affected countries come from that explicit list and go through the exact name matcher, so a regional
    bulletin ("the Persian Gulf and Gulf of Oman") never needs a guess about which countries it covers.
  - A bulletin that covers part of a country ("Pakistan - Baluchistan and Khyber Pakhtunkhwa provinces") is
    marked partial so the map does not outline the whole country for it.
  - The recommendation text is quoted, never paraphrased. The kind (do not operate, caution) is read from it.
"""
import asyncio
import html
import json
import logging
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

from facts import names
from plugin_base import SitrepPlugin

log = logging.getLogger("sitrep.easa")

SITE = "https://www.easa.europa.eu"
LIST_URL = f"{SITE}/en/domains/air-operations/czibs"
CACHE_FILE = Path(__file__).resolve().parents[2] / "data" / "easa_czib.json"
HEADERS = {"User-Agent": "sitrep-personal/0.1 (personal travel tool; britleyhoff@britleyhoffconsulting.com)"}
GAP = 3.0  # seconds between page requests

# Labels on a bulletin page, in order. The text between two labels is the first one's value.
LABELS = ["Status", "CZIB number", "Issue date", "Revision date", "Revision description", "Valid until",
          "Referenced publication(s):", "Affected Airspace", "Affected Countries", "Applicability",
          "Applicability Description", "Description", "Recommendation(s)", "Contact us"]


def _plain(fragment: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", fragment))).strip()


def _date(s: str) -> str | None:
    """dd/mm/yyyy -> yyyy-mm-dd, or None."""
    m = re.match(r"\s*(\d{2})/(\d{2})/(\d{4})", s or "")
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None


def parse_list(page: str) -> list[dict]:
    rows = []
    for tr in re.findall(r"<tr\b.*?</tr>", page, re.S):
        tds = re.findall(r"<td\b[^>]*>(.*?)</td>", tr, re.S)
        href = re.search(r'href="(/en/domains/air-operations/czibs/[^"]+)"', tr)
        if len(tds) < 4 or not href:
            continue
        subject = _plain(tds[3])
        status = "Active" if re.search(r"\bActive\s*$", subject) else "Withdrawn" if re.search(r"\bWithdrawn\s*$", subject) else None
        if not status:
            continue
        subject = re.sub(r"\s*\b(Active|Withdrawn)\s*$", "", subject)
        # CZIB-2026-08-R1, CZIB-2018-02R21, SIB 2014-21R1, 2025-01 R3, 2026-03-R14
        number = re.search(r"\b((?:(?:CZIB|SIB)[- ])?\d{4}-\d{2}(?:[-\s]?R\d+)?)\s*$", subject)
        title = subject[:number.start()].strip() if number else subject
        rows.append({"slug": href.group(1).rsplit("/", 1)[-1], "url": SITE + href.group(1), "title": title,
                     "number": number.group(1).strip() if number else "", "status": status,
                     "issued": _date(_plain(tds[0])), "revised": _date(_plain(tds[1])), "until": _date(_plain(tds[2]))})
    return rows


def parse_detail(page: str) -> dict:
    """The structured fields of one bulletin page. Raises ValueError if the layout is not what we expect."""
    page = re.sub(r"<script.*?</script>|<style.*?</style>|<!--.*?-->", "", page, flags=re.S)
    main = page[page.find("<main"):] if "<main" in page else page
    lines = [ln.strip() for ln in re.sub(r"[ \t]+", " ", html.unescape(re.sub(r"<[^>]+>", "\n", main))).split("\n") if ln.strip()]
    at, pos = {}, 0
    for label in LABELS:
        try:
            pos = lines.index(label, pos)
        except ValueError:
            continue
        at[label] = pos
        pos += 1
    if "Recommendation(s)" not in at or "Description" not in at:
        raise ValueError("bulletin page layout changed")

    def section(label):
        if label not in at:
            return []
        start = at[label] + 1
        later = sorted(v for k, v in at.items() if v > at[label])
        return lines[start:later[0] if later else len(lines)]

    bullets = lambda ls: [re.sub(r"^[-•]\s*", "", x).strip() for x in ls if x.strip()]  # noqa: E731
    return {
        "revision_description": " ".join(section("Revision description")),
        "airspace": bullets(section("Affected Airspace"))[:12],
        "countries": [x for x in section("Affected Countries") if x],
        "description": "\n".join(section("Description"))[:3500],
        "recommendations": [x for x in bullets(section("Recommendation(s)")) if not x.endswith("should:")][:10],
    }


def kind_of(recommendations: list[str]) -> str:
    """do_not_operate if any recommendation tells operators not to operate, else caution. Quoted text stays as is."""
    text = " ".join(recommendations).lower()
    # "not operate", "not to operate", "not to fly" (Sudan's wording), "should not overfly", "avoid operating"
    if re.search(r"\bnot (?:to )?(?:operate|fly|overfly)\b|\bavoid (?:operat|fly|overfly)|\bno operations\b", text):
        return "do_not_operate"
    return "caution"


def _place(title: str) -> tuple[list[str], bool, str]:
    """Countries named in a title, whether it covers only part of a country, and the part."""
    t = re.sub(r"^Airspace of (?:the )?", "", title, flags=re.I)
    t = re.sub(r"\s+and neighbouring airspace$", "", t, flags=re.I)
    paren = re.search(r"\(([^)]*)\)", t)
    if paren:  # "Middle East (Iran, Iraq, Israel, Jordan and Lebanon)"
        found = [names.resolve(x.strip()) for x in re.split(r",| and ", paren.group(1))]
        return [c for c in found if c], False, ""
    partial = re.split(r"\s+[–-]\s+", t, maxsplit=1)
    iso2 = names.resolve(partial[0].strip())
    return ([iso2] if iso2 else []), len(partial) > 1, partial[1].strip() if len(partial) > 1 else ""


def _regions(title: str) -> set[str]:
    return {r for r in ("persian gulf", "middle east") if r in title.lower()}


def _load_cache() -> dict:
    try:
        return json.loads(CACHE_FILE.read_text())
    except (OSError, ValueError):
        return {}


class Plugin(SitrepPlugin):
    name = "easa_czib"
    layer = "airspace"
    cache_ttl_seconds = 6 * 3600

    async def fetch(self):
        cache = _load_cache()
        details = cache.get("details", {})
        rows = None
        try:
            async with httpx.AsyncClient(timeout=40, follow_redirects=True, headers=HEADERS) as client:
                r = await client.get(LIST_URL)
                r.raise_for_status()
                rows = parse_list(r.text)
                if len(rows) < 10:
                    raise ValueError(f"the list looked wrong ({len(rows)} bulletins)")
                active = [x for x in rows if x["status"] == "Active"]
                for row in active:
                    have = details.get(row["slug"])
                    if have and have.get("revised") == row["revised"] and have.get("ok"):
                        continue  # unchanged since we last read it
                    await asyncio.sleep(GAP)
                    try:
                        page = await client.get(row["url"])
                        page.raise_for_status()
                        details[row["slug"]] = {"ok": True, "revised": row["revised"], **parse_detail(page.text)}
                    except (httpx.HTTPError, ValueError) as e:
                        log.warning("EASA: could not read %s (%s), using its list entry only", row["slug"], e)
                        details[row["slug"]] = {"ok": False, "revised": row["revised"]}
                details = {k: v for k, v in details.items() if k in {x["slug"] for x in active}}
            CACHE_FILE.write_text(json.dumps({"rows": rows, "details": details, "last_success": time.time()}))
        except (httpx.HTTPError, ValueError) as e:
            # An old list beats no list for a safety layer, but it must say so. as_of carries the real age.
            if not cache.get("rows"):
                raise RuntimeError(f"EASA feed failed and there is no saved copy: {e}") from e
            log.warning("EASA feed failed (%s), using the last saved copy", e)
            rows = cache["rows"]
        return {"rows": rows, "details": details, "as_of": _load_cache().get("last_success")}

    def normalize(self, raw):
        rows, details = raw["rows"], raw["details"]
        as_of = datetime.fromtimestamp(raw["as_of"], tz=timezone.utc).isoformat() if raw.get("as_of") else None
        withdrawn = [x for x in rows if x["status"] == "Withdrawn"]
        out = []
        for row in (x for x in rows if x["status"] == "Active"):
            d = details.get(row["slug"], {})
            place_codes, partial, scope = _place(row["title"])
            resolved, unresolved = [], []
            for name in d.get("countries", []):
                iso2 = names.resolve(name)
                (resolved if iso2 else unresolved).append(iso2 or name)
            countries = sorted(set(resolved or place_codes))
            if unresolved:
                log.warning("EASA %s: countries not matched: %s", row["number"], unresolved)
            kind = kind_of(d.get("recommendations", []))
            # Earlier bulletins for the same countries, most recent first, as context for the timeline.
            # A withdrawn bulletin belongs if it named one of the same countries, or shares a region phrase in its
            # title ("Persian Gulf"), since a regional title names no country. Only the titles' own words are used.
            history = []
            regions = _regions(row["title"])
            for w in sorted(withdrawn, key=lambda x: x["issued"] or "", reverse=True):
                if set(_place(w["title"])[0]) & set(countries) or (regions & _regions(w["title"])):
                    history.append({k: w[k] for k in ("title", "number", "issued", "revised", "until", "url")})
            when = row["revised"] or row["issued"] or ""
            out.append({
                "type": "Feature", "geometry": None,
                "properties": {
                    "id": f"czib:{row['slug']}", "layer": self.layer,
                    "severity": "high" if kind == "do_not_operate" else "medium",
                    "title": f"{row['title']}: EASA airspace bulletin",
                    "summary": (d.get("recommendations") or ["Airspace warning for civil aircraft."])[0],
                    "timestamp": f"{when}T00:00:00+00:00" if when else datetime.now(timezone.utc).isoformat(),
                    "source_url": row["url"], "as_of": as_of,
                    "number": row["number"], "subject": row["title"], "kind": kind,
                    "issued": row["issued"], "revised": row["revised"], "valid_until": row["until"],
                    "countries": countries, "partial": partial or (not countries), "scope": scope,
                    "airspace": d.get("airspace", []), "revision_description": d.get("revision_description", ""),
                    "description": d.get("description", ""), "recommendations": d.get("recommendations", []),
                    "detail_ok": bool(d.get("ok")), "history": history[:6],
                },
            })
        return out
