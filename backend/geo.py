import math


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Straight-line (great circle) distance in kilometres."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


def ring_center(geom: dict) -> tuple[float, float]:
    """A point inside-ish a Polygon or MultiPolygon: the mean of the biggest outer ring's corners.
    Good enough to pin a marker to an area, not a true centroid."""
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    ring = max((p[0] for p in polys), key=len)[:-1] or polys[0][0]
    return (sum(c[0] for c in ring) / len(ring), sum(c[1] for c in ring) / len(ring))
