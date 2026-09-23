#!/usr/bin/env python3
"""Build the country data the advisory layer needs, from Natural Earth (public domain).

Writes two files:
  frontend/vendor/countries.geojson  country polygons for the map, properties {iso2, name} only
  backend/data/countries.json        [{iso2, iso3, fips, name}], used to turn State Dept FIPS codes into ISO

State Dept tags advisories with FIPS 10-4 codes (Iraq is IZ, Ukraine is UP), everything else on the
map uses ISO, so we need the table. Natural Earth leaves FIPS blank for a handful of countries, those
are patched below. Run: python3 scripts/build_country_data.py
"""
import json
import urllib.request
from pathlib import Path

URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson"
ROOT = Path(__file__).resolve().parent.parent

# Natural Earth has -99 for these FIPS codes. ISO2 -> FIPS 10-4.
FIPS_PATCH = {"IL": "IS", "NO": "NO", "PS": "WE", "XK": "KV", "SS": "OD"}


def clean(v):
    return None if v in (None, "", "-99") else v


def round_ring(ring, nd=2):
    """Round to about 1 km and drop the repeated points rounding creates. Plenty for a country tint."""
    out = []
    for lon, lat in ring:
        pt = [round(lon, nd), round(lat, nd)]
        if not out or pt != out[-1]:
            out.append(pt)
    return out if len(out) >= 4 else None


def round_geom(g):
    if g["type"] == "Polygon":
        rings = [r for r in map(round_ring, g["coordinates"]) if r]
        return {"type": "Polygon", "coordinates": rings} if rings else None
    polys = []
    for poly in g["coordinates"]:
        rings = [r for r in map(round_ring, poly) if r]
        if rings:
            polys.append(rings)
    return {"type": "MultiPolygon", "coordinates": polys} if polys else None


def main():
    print("downloading", URL)
    with urllib.request.urlopen(URL, timeout=120) as r:
        src = json.load(r)

    # A few territories reuse their parent's ISO code (the Indian Ocean Territories carry Australia's
    # AU). Keep the code on the row whose own code matches, and drop it from the others.
    owners = {}
    for f in src["features"]:
        p = f["properties"]
        iso2 = clean(p.get("ISO_A2_EH")) or clean(p.get("ISO_A2"))
        if iso2 and (iso2 not in owners or p.get("ADM0_A3") == (clean(p.get("ISO_A3_EH")) or clean(p.get("ISO_A3")))):
            owners[iso2] = p["NAME"]

    table, feats = [], []
    for f in src["features"]:
        p = f["properties"]
        iso2 = clean(p.get("ISO_A2_EH")) or clean(p.get("ISO_A2"))
        if iso2 and owners.get(iso2) != p["NAME"]:
            iso2 = None
        iso3 = clean(p.get("ISO_A3_EH")) or clean(p.get("ISO_A3"))
        fips = clean(p.get("FIPS_10")) or FIPS_PATCH.get(iso2)
        name = p["NAME"]
        geom = round_geom(f["geometry"])
        if geom:
            feats.append({"type": "Feature", "properties": {"iso2": iso2, "name": name}, "geometry": geom})
        if iso2:
            table.append({"iso2": iso2, "iso3": iso3, "fips": fips, "name": name})

    (ROOT / "frontend/vendor/countries.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))
    (ROOT / "backend/data/countries.json").write_text(json.dumps(table, ensure_ascii=False, indent=0))
    size = (ROOT / "frontend/vendor/countries.geojson").stat().st_size
    print(f"{len(feats)} polygons ({size/1e6:.2f} MB), {len(table)} table rows, "
          f"{sum(1 for t in table if not t['fips'])} without a FIPS code")


if __name__ == "__main__":
    main()
