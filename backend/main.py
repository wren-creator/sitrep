"""Sitrep backend. The browser only talks to this server, never to upstream APIs."""
import asyncio
import importlib
import json
import pkgutil
import sqlite3
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Query
from fastapi.staticfiles import StaticFiles

import plugins as plugins_pkg
from geo import haversine_km

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "sitrep.db"
FRONTEND = ROOT / "frontend"

SEV_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS features (
            id TEXT PRIMARY KEY, plugin TEXT, layer TEXT, severity TEXT,
            lon REAL, lat REAL, iso2 TEXT, timestamp TEXT, json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_features_geo ON features(lat, lon);
        CREATE INDEX IF NOT EXISTS idx_features_layer ON features(layer);
        CREATE TABLE IF NOT EXISTS plugin_state (
            name TEXT PRIMARY KEY, fetched_at REAL, ok INTEGER, error TEXT, count INTEGER
        );
        """)


def load_plugins() -> list:
    found = []
    for mod in pkgutil.iter_modules(plugins_pkg.__path__):
        m = importlib.import_module(f"plugins.{mod.name}")
        if hasattr(m, "Plugin"):
            found.append(m.Plugin())
    return found


PLUGINS: list = []
GEOCODE_CACHE: dict = {}


async def refresh(plugin) -> None:
    """Fetch and store one plugin. On failure, keep the old rows (stale but labeled)."""
    try:
        feats = plugin.normalize(await plugin.fetch())
        with db() as c:
            c.execute("DELETE FROM features WHERE plugin = ?", (plugin.name,))
            for f in feats:
                p = f["properties"]
                g = f.get("geometry")
                lon, lat = (g["coordinates"][0], g["coordinates"][1]) if g else (None, None)
                c.execute(
                    "INSERT OR REPLACE INTO features VALUES (?,?,?,?,?,?,?,?,?)",
                    (p["id"], plugin.name, p["layer"], p["severity"], lon, lat,
                     p.get("iso2"), p.get("timestamp"), json.dumps(f)),
                )
            c.execute("INSERT OR REPLACE INTO plugin_state VALUES (?,?,?,?,?)",
                      (plugin.name, time.time(), 1, None, len(feats)))
    except Exception as e:  # noqa: BLE001, one bad source must not stop the rest
        # Retry in about 5 minutes (sooner if the TTL is shorter). Not every 30 seconds,
        # which would hammer a struggling source, and not a full TTL, which for a weekly
        # plugin would mean a week of nothing after one bad request.
        retry_at = time.time() - plugin.cache_ttl_seconds + min(plugin.cache_ttl_seconds, 300)
        with db() as c:
            c.execute(
                "INSERT INTO plugin_state (name, fetched_at, ok, error, count) VALUES (?,?,?,?,0) "
                "ON CONFLICT(name) DO UPDATE SET fetched_at=excluded.fetched_at, ok=0, error=excluded.error",
                (plugin.name, retry_at, 0, str(e)[:300]),
            )


RUNNING: dict[str, asyncio.Task] = {}


async def runner() -> None:
    """Honor each plugin's TTL. Checks every 30 seconds.

    Each refresh runs as its own task, so a slow source (Overpass can take over a minute)
    does not hold up the fast ones. A plugin that is still running is not started twice.
    """
    while True:
        with db() as c:
            state = {r["name"]: r["fetched_at"] for r in c.execute("SELECT name, fetched_at FROM plugin_state")}
        for p in PLUGINS:
            due = time.time() - (state.get(p.name) or 0) >= p.cache_ttl_seconds
            if due and p.name not in RUNNING:
                task = asyncio.create_task(refresh(p))
                RUNNING[p.name] = task
                task.add_done_callback(lambda _t, name=p.name: RUNNING.pop(name, None))
        await asyncio.sleep(30)


@asynccontextmanager
async def lifespan(_app):
    init_db()
    PLUGINS.extend(load_plugins())
    task = asyncio.create_task(runner())
    yield
    task.cancel()


app = FastAPI(title="Sitrep", lifespan=lifespan)


@app.get("/api/plugins")
def plugin_status():
    with db() as c:
        rows = [dict(r) for r in c.execute("SELECT * FROM plugin_state")]
    return {"plugins": [{"name": p.name, "layer": p.layer, "ttl": p.cache_ttl_seconds} for p in PLUGINS],
            "state": rows}


@app.get("/api/features")
def features(layers: str = "", limit: int = 2000):
    wanted = [x for x in layers.split(",") if x]
    sql, args = "SELECT json FROM features", []
    if wanted:
        sql += f" WHERE layer IN ({','.join('?' * len(wanted))})"
        args = wanted
    with db() as c:
        rows = c.execute(sql + " LIMIT ?", (*args, limit)).fetchall()
    return {"type": "FeatureCollection", "features": [json.loads(r["json"]) for r in rows]}


@app.get("/api/headlines")
def headlines(west: float = Query(-180), south: float = Query(-90),
              east: float = Query(180), north: float = Query(90), limit: int = 50):
    """Features inside the visible box, worst severity first, then newest."""
    lon_clause = "lon BETWEEN ? AND ?" if west <= east else "(lon >= ? OR lon <= ?)"
    with db() as c:
        # Embassies are reference points on the map, not news, so they stay out of the headlines.
        rows = c.execute(
            f"SELECT json, severity, timestamp FROM features WHERE layer != 'embassy' "
            f"AND lat BETWEEN ? AND ? AND {lon_clause}",
            (south, north, west, east),
        ).fetchall()
    items = [json.loads(r["json"])["properties"] | {"_geo": json.loads(r["json"])["geometry"]} for r in rows]
    items.sort(key=lambda p: (SEV_RANK.get(p["severity"], 0), p.get("timestamp") or ""), reverse=True)
    return {"items": items[:limit], "total": len(items)}


def nearest_embassies(lat: float, lon: float, n: int = 1) -> list[dict]:
    """Closest embassies that are operating, straight-line distance (not a driving route)."""
    with db() as c:
        rows = c.execute("SELECT json FROM features WHERE layer = 'embassy'").fetchall()
    found = []
    for r in rows:
        f = json.loads(r["json"])
        p = f["properties"]
        if p.get("status") != "active":
            continue
        elon, elat = f["geometry"]["coordinates"]
        found.append({**p, "lat": elat, "lon": elon, "km": round(haversine_km(lat, lon, elat, elon))})
    found.sort(key=lambda x: x["km"])
    return found[:n]


@app.get("/api/nearest-embassy")
def nearest_embassy(lat: float, lon: float, n: int = Query(1, ge=1, le=5)):
    return {"items": nearest_embassies(lat, lon, n)}


@app.get("/api/geocode")
async def geocode(q: str):
    """Proxy Nominatim (needs a User-Agent, max 1 req/s). Result cached in memory."""
    key = q.strip().lower()
    if key in GEOCODE_CACHE:
        return GEOCODE_CACHE[key]
    async with httpx.AsyncClient(timeout=15, headers={"User-Agent": "sitrep-personal/0.1"}) as client:
        r = await client.get("https://nominatim.openstreetmap.org/search",
                             params={"q": q, "format": "jsonv2", "limit": 1})
        r.raise_for_status()
        hits = r.json()
    if not hits:
        return {"lat": None, "lon": None}
    h = hits[0]
    # Nominatim gives [south, north, west, east]. The map wants [west, south, east, north]
    # so a country, a state and a city each fit the screen at their own size.
    s, n, w, e = (float(x) for x in h["boundingbox"])
    result = {"lat": float(h["lat"]), "lon": float(h["lon"]), "name": h.get("display_name"),
              "bbox": [w, s, e, n]}
    GEOCODE_CACHE[key] = result
    return result


app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
