"""Country name to ISO code, exact matching only.

CDC and Wikipedia name countries in prose. A wrong match would show one country's health advice
on another, so there is no fuzzy matching. A name either matches exactly (after normalising) or
through the alias table below, or it is left unresolved and the country simply has no result.
Checked by hand against the ambiguous cases: Georgia, Niger and Nigeria, both Congos, the Guineas,
both Sudans and both Koreas.
"""
import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

import pycountry

COUNTRIES = Path(__file__).resolve().parent.parent / "data" / "countries.json"

# Names the sources use that neither pycountry nor Natural Earth spell the same way.
ALIASES = {
    "the bahamas": "BS", "bahamas, the": "BS", "cape verde": "CV", "burma": "MM",
    "democratic republic of the congo": "CD", "vatican city": "VA", "the gambia": "GM", "gambia, the": "GM",
    "macau": "MO", "macau sar": "MO", "netherlands, the": "NL", "pitcairn islands": "PN",
    "israel, the west bank and gaza": "IL", "u s virgin islands": "VI", "united states virgin islands": "VI",
}


def norm(name: str) -> str:
    n = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    n = re.sub(r"\(.*?\)", "", n)            # "Burma (Myanmar)" -> "burma"
    n = re.sub(r"[^a-z0-9 ,]", " ", n)
    return re.sub(r"\s+", " ", n).strip()


@lru_cache(maxsize=1)
def _index() -> tuple[dict, dict]:
    idx: dict[str, str] = {}

    def add(name, iso2):
        if name:
            idx.setdefault(norm(name), iso2)

    for c in pycountry.countries:
        for attr in ("name", "official_name", "common_name"):
            add(getattr(c, attr, None), c.alpha_2)
    table = json.loads(COUNTRIES.read_text())
    for r in table:
        add(r["name"], r["iso2"])
    for name, iso2 in ALIASES.items():
        idx[norm(name)] = iso2
    display = {}
    for r in table:
        name = r["name"]
        if "." in name:  # Natural Earth abbreviates ("Dem. Rep. Congo", "S. Sudan"), spell those out
            c = pycountry.countries.get(alpha_2=r["iso2"])
            name = (getattr(c, "common_name", None) or c.name) if c else name
        display[r["iso2"]] = name
    for c in pycountry.countries:
        display.setdefault(c.alpha_2, getattr(c, "common_name", None) or c.name)
    return idx, display


def resolve(name: str) -> str | None:
    idx, _ = _index()
    k = norm(name)
    if k in idx:
        return idx[k]
    if "," in k:  # "Korea, South" -> "south korea", "Virgin Islands, British" -> "british virgin islands"
        a, b = (x.strip() for x in k.split(",", 1))
        return idx.get(f"{b} {a}")
    return None


def display_name(iso2: str) -> str:
    return _index()[1].get(iso2, iso2)
