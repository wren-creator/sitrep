"""US State Department travel advisories (Level 1 to 4), one record per country.

The feed is travel.state.gov's own JSON. It is messier than it looks, so the resolver is
careful about it:
  - Country tags are FIPS codes (Iraq IZ, Ukraine UP), not ISO. backend/data/countries.json
    maps them, built by scripts/build_country_data.py.
  - Gaza and the West Bank are tagged as Israel. Taking the highest level per tag would paint
    all of Israel Level 4 because of Gaza, so sub-regions are resolved by name first.
  - Hong Kong and Macau have their own advisories, some with no tag at all.
  - A few Caribbean islands share a made-up tag, and one Israel title repeats "Level 3".
Anything that still cannot be placed is skipped and logged, never guessed.

The text is written by the State Department. We pull out the headline sentence and the reasons
it gives ("due to terrorism, kidnapping...") and quote them, we do not paraphrase.
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

log = logging.getLogger("sitrep.state_dept")

FEED = "https://cadataapi.state.gov/api/TravelAdvisories"
COUNTRIES = Path(__file__).resolve().parent.parent / "data" / "countries.json"
CACHE_FILE = Path(__file__).resolve().parents[2] / "data" / "state_dept_raw.json"  # last good download

SAMPLES = 4                       # requests per refresh, see fetch(). Each is about 1 MB and Cloudflare rate-limits
RETIRE_AFTER = 14 * 24 * 3600     # drop an advisory nobody has returned for two weeks


def _load_store() -> dict:
    """The saved merge of every advisory seen so far: {link: {"entry": ..., "seen": timestamp}}."""
    try:
        saved = json.loads(CACHE_FILE.read_text())
    except (OSError, ValueError):
        return {}
    if isinstance(saved, dict) and saved.get("version") == 2:
        return saved["entries"]
    if isinstance(saved, list):  # the first version saved the raw feed
        return {(e.get("Link") or e.get("Title")): {"entry": e, "seen": time.time()} for e in saved}
    return {}


def _last_success() -> str | None:
    """When the feed was last actually reached, as ISO time. Shown on every advisory so a stale copy is visible."""
    try:
        saved = json.loads(CACHE_FILE.read_text())
        ts = saved.get("last_success") if isinstance(saved, dict) else None
        ts = ts or CACHE_FILE.stat().st_mtime
    except (OSError, ValueError):
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


LEVELS = {
    1: ("low", "Exercise Normal Precautions"),
    2: ("medium", "Exercise Increased Caution"),
    3: ("high", "Reconsider Travel"),
    4: ("critical", "Do Not Travel"),
}
# Sub-regions with their own advisory. Resolved by name before the tag, because the tag is the parent's.
NAME_OVERRIDES = {"gaza": "PS", "west bank": "PS", "hong kong": "HK", "macau": "MO",
                  "bonaire": "BQ", "saba": "BQ", "sint eustatius": "BQ",
                  "french guiana": "GF", "french west indies": "GP", "guadeloupe": "GP", "martinique": "MQ",
                  "saint barthelemy": "BL", "saba and sint eustatius": "BQ"}
HEADLINE = re.compile(r"(Do not travel|Reconsider travel|Exercise increased caution|Exercise normal precautions)\b[^.]*\.", re.I)


def _plain(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s or "")
    s = re.sub(r"\s+", " ", html.unescape(s).replace("\xa0", " ")).strip()
    return re.sub(r"\s+([.,;:!?])", r"\1", s)  # tags leave "unrest ." behind


EMBASSY_NOTICE = re.compile(
    r"ordered departure|authorized departure|suspended (?:its |all )?(?:embassy |routine )?(?:consular )?operations"
    r"|operations (?:were|was|have been) suspended|suspended operations", re.I)


def _embassy_notice(raw: str) -> str:
    """The advisory's own sentence about embassy staffing or suspension, if it has one.

    The wording varies too much to turn into a yes or no, and a wrong automatic call on an embassy's
    status is worse than none. So we quote the sentence and let the reader judge.
    """
    text = _plain(raw).replace("U.S.", "U_S_")
    for sentence in re.split(r"(?<=[.!?])\s+(?=[A-Z“])", text):
        if EMBASSY_NOTICE.search(sentence):
            sentence = sentence.replace("U_S_", "U.S.").strip()
            return sentence if len(sentence) <= 260 else sentence[:257].rstrip() + "..."
    return ""


def _parse_text(raw: str) -> dict:
    """Pull the headline sentence, the reasons it lists, any change note, and a short excerpt."""
    text = _plain(raw)
    safe = text.replace("U.S.", "U_S_")  # so "U.S. government" does not end a sentence
    # The change note often quotes the level ("shift to Level 2 “Exercise increased caution”"), skip
    # matches inside quotation marks and take the real advisory sentence.
    m = next((x for x in HEADLINE.finditer(safe)
              if not (x.start() and safe[x.start() - 1] in "“\"‘") and "”" not in x.group(0)), None)
    if not m:
        return {"headline": "", "reasons": [], "changes": "", "excerpt": text[:400].replace("U_S_", "U.S.")}
    back = lambda x: x.replace("U_S_", "U.S.")  # noqa: E731
    headline = back(m.group(0)).strip()
    reasons = []
    r = re.search(r"\b(?:due to|because of)\s+(.*)\.$", m.group(0), re.I)
    if r:
        parts = re.split(r",|\band\b", back(r.group(1)))
        reasons = [p.strip() for p in parts if p.strip()][:8]
    before, after = safe[:m.start()], safe[m.end():]
    changes = back(before).strip()
    changes = "" if len(changes) > 400 else changes  # a long preface is advisory body, not a change note
    excerpt = re.sub(r"^(advisory\s+)?summary:?\s*", "", back(after).strip(), flags=re.I)
    if len(excerpt) > 600:
        excerpt = excerpt[:600].rsplit(". ", 1)[0] + "."
    reasons = [r if len(r) <= 90 else r[:87].rstrip() + "..." for r in reasons]
    return {"headline": headline, "reasons": reasons, "changes": changes, "excerpt": excerpt}


class Plugin(SitrepPlugin):
    name = "state_dept"
    layer = "advisory"
    cache_ttl_seconds = 6 * 3600

    async def fetch(self):
        """Ask several times and keep the newest version of every advisory.

        The State Dept API does not give one consistent answer. Back-to-back requests return
        different payloads (216 to 225 entries) and flip between a current state and one that is
        months old, apparently from replicas holding different data. Trusting one response would
        make the map flip between current and stale advisories, and a stale one can show a lower
        level than the truth. So every entry is merged by its link and the newest Updated wins,
        across all the responses and the saved copy. Data can only move forward.
        """
        responses = []
        async with httpx.AsyncClient(timeout=60, headers={"User-Agent": "sitrep-personal/0.1"}) as client:
            blocked = False

            async def one():
                nonlocal blocked
                try:
                    r = await client.get(FEED)
                    if r.status_code == 429:  # rate limited, keep asking and we stay blocked longer
                        blocked = True
                        log.warning("State Dept feed rate-limited us (429), stopping for this refresh")
                        return None
                    r.raise_for_status()
                    data = r.json()
                    return data if isinstance(data, list) and data else None
                except (httpx.HTTPError, ValueError):
                    return None
            # One at a time with a pause. Six at once failed together, the API seems to throttle a burst.
            for i in range(SAMPLES):
                if i:
                    await asyncio.sleep(4)
                d = await one()
                if blocked:
                    break
                if d:
                    responses.append(d)

        store = _load_store()
        if not responses and not store:
            raise RuntimeError("State Dept feed failed and there is no saved copy")
        if not responses:
            log.warning("State Dept feed failed, using the last saved copy")
        now = time.time()
        for data in responses:
            for e in data:
                key = e.get("Link") or e.get("Title")
                if not key:
                    continue
                cur = store.get(key)
                if cur is None or (e.get("Updated") or "") >= (cur["entry"].get("Updated") or ""):
                    store[key] = {"entry": e, "seen": now}
                else:
                    cur["seen"] = now
        if responses:
            # An advisory no response has mentioned for two weeks was retired upstream.
            store = {k: v for k, v in store.items() if now - v["seen"] < RETIRE_AFTER}
            CACHE_FILE.write_text(json.dumps({"version": 2, "last_success": now, "entries": store}))
        return [v["entry"] for v in store.values()]

    def normalize(self, raw):
        table = json.loads(COUNTRIES.read_text())
        by_iso2 = {r["iso2"]: r for r in table}
        by_fips = {r["fips"]: r for r in table if r["fips"]}
        by_iso3 = {r["iso3"]: r for r in table if r["iso3"]}
        by_name = {r["name"].lower(): r for r in table}

        groups: dict[str, list[dict]] = {}
        skipped = []
        for e in raw:
            m = re.match(r"^(.*?)\s+-\s+Level\s+(\d)", e.get("Title", ""))
            if not m or int(m.group(2)) not in LEVELS:
                skipped.append(e.get("Title", "?"))
                continue
            name = re.sub(r"\s+", " ", m.group(1).replace("\xa0", " ")).strip()  # some titles end in a non-breaking space
            name = re.sub(r"\s+Travel Advisory$", "", name, flags=re.I)
            level = int(m.group(2))

            iso2 = NAME_OVERRIDES.get(name.lower())
            if not iso2:
                for code in e.get("Category") or []:
                    if code in by_fips:
                        iso2 = by_fips[code]["iso2"]
                        break
            if not iso2:
                dest = re.search(r"destination\.([a-z]{3})\.html", e.get("Link", ""))
                if dest and dest.group(1).upper() in by_iso3:
                    iso2 = by_iso3[dest.group(1).upper()]["iso2"]
            if not iso2 and name.lower() in by_name:
                iso2 = by_name[name.lower()]["iso2"]
            if not iso2:
                skipped.append(e["Title"])
                continue
            groups.setdefault(iso2, []).append({
                "name": name, "level": level, "link": e.get("Link", ""), "updated": e.get("Updated") or e.get("Published") or "",
                "summary": e.get("Summary", ""),
            })
        if skipped:
            log.warning("State Dept: %d advisories could not be placed on a country: %s", len(skipped), skipped)

        as_of = _last_success()
        out = []
        for iso2, entries in groups.items():
            # Replicas link the same advisory under different URLs, so a stale copy of an advisory can sit
            # beside the current one. Same country and same name means the same advisory, newest wins. If a
            # stale copy with a higher level survived, it would paint the country wrongly.
            newest: dict[str, dict] = {}
            for x in entries:
                k = x["name"].lower()
                if k not in newest or x["updated"] >= newest[k]["updated"]:
                    newest[k] = x
            entries = list(newest.values())
            # What remains are genuinely separate advisories (West Bank and Gaza, the Caribbean Netherlands).
            # Colour the country by the worst one and list every entry in the card.
            primary = max(entries, key=lambda x: (x["level"], x["updated"]))
            sev, level_text = LEVELS[primary["level"]]
            country = names.display_name(iso2) if iso2 in by_iso2 else primary["name"]
            parsed = _parse_text(primary["summary"])
            out.append({
                "type": "Feature",
                "geometry": None,
                "properties": {
                    "id": f"advisory:{iso2}",
                    "layer": self.layer,
                    "severity": sev,
                    "title": f"{country}: Level {primary['level']}, {level_text}",
                    "summary": parsed["headline"] or f"Level {primary['level']}: {level_text}.",
                    "timestamp": primary["updated"] or datetime.now(timezone.utc).isoformat(),
                    "source_url": primary["link"] or "https://travel.state.gov/",
                    "iso2": iso2,
                    "country": country,
                    "level": primary["level"],
                    "level_text": level_text,
                    "reasons": parsed["reasons"],
                    "changes": parsed["changes"],
                    "embassy_notice": _embassy_notice(primary["summary"]),
                    "as_of": as_of,
                    "excerpt": parsed["excerpt"],
                    "entries": [{"name": x["name"], "level": x["level"], "link": x["link"], "updated": x["updated"]}
                                for x in sorted(entries, key=lambda x: -x["level"])],
                },
            })
        return out
