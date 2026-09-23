"""Sitrep backend. The browser only talks to this server, never to upstream APIs."""
import asyncio
import importlib
import json
import logging
import pkgutil
import sqlite3
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from datetime import date

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field, model_validator
from fastapi.staticfiles import StaticFiles

import brief
import facts
import lookup
import trips
import plugins as plugins_pkg
from facts import cache as facts_cache
from geo import haversine_km

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "sitrep.db"
FRONTEND = ROOT / "frontend"

log = logging.getLogger("sitrep")
SEV_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")  # so deleting a trip removes its stops, snapshots and alerts
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
        CREATE TABLE IF NOT EXISTS country_facts (
            iso2 TEXT, provider TEXT, fetched_at REAL, ok INTEGER, json TEXT, PRIMARY KEY (iso2, provider)
        );
        """ + trips.SCHEMA)


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
        try:
            trips.check_alerts()  # only reads local rows
        except Exception:  # noqa: BLE001, a bad trip row must never stop the data refresh
            log.exception("trip alert check failed")
        await asyncio.sleep(30)


@asynccontextmanager
async def lifespan(_app):
    init_db()
    facts_cache.set_db(db)
    lookup.set_db(db)
    trips.set_db(db)
    facts.lgbt.purge_old()  # Equaldex's terms cap how long we may keep its data
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
    # Country-level records (advisories) have no point on the map, they have their own endpoint.
    sql, args = "SELECT json FROM features WHERE lat IS NOT NULL", []
    if wanted:
        sql += f" AND layer IN ({','.join('?' * len(wanted))})"
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


@app.get("/api/travel-info")
async def travel_info(iso2: str = Query(..., pattern="^[A-Za-z]{2}$")):
    """Vaccines, health notices and entry rules for one country, fetched on demand and cached."""
    return await facts.travel_info(iso2.upper())


@app.get("/api/airspace")
def airspace():
    """Active EASA conflict zone bulletins, worst first. Country-level, so they have no point of their own."""
    with db() as c:
        rows = c.execute("SELECT json FROM features WHERE layer = 'airspace'").fetchall()
        st = c.execute("SELECT fetched_at, ok, error FROM plugin_state WHERE name = 'easa_czib'").fetchone()
    items = [json.loads(r["json"])["properties"] for r in rows]
    items.sort(key=lambda p: (p["kind"] != "do_not_operate", -(int((p.get("revised") or "0").replace("-", "")))))
    return {"items": items, "fetched_at": st["fetched_at"] if st else None,
            "ok": bool(st["ok"]) if st else False, "error": st["error"] if st else None}


@app.get("/api/lgbt")
async def lgbt(iso2: str = Query(..., pattern="^[A-Za-z]{2}$")):
    """LGBT+ information for one country: Equaldex index, trans legal status, UK FCDO advice."""
    return await facts.lgbt_info(iso2.upper())


@app.get("/api/lgbt-index")
async def lgbt_index():
    """Equaldex Equality Index for every country, for the map layer. Current values only, no history."""
    try:
        return await facts.lgbt.equaldex_index()
    except facts.FactsError as e:
        raise HTTPException(status_code=503, detail=str(e))


@app.get("/api/advisories")
def advisories():
    """State Department travel advisories keyed by ISO country code."""
    with db() as c:
        rows = c.execute("SELECT json FROM features WHERE layer = 'advisory'").fetchall()
        st = c.execute("SELECT fetched_at, ok, error FROM plugin_state WHERE name = 'state_dept'").fetchone()
    items = {}
    for r in rows:
        p = json.loads(r["json"])["properties"]
        items[p["iso2"]] = p
    return {"items": items, "fetched_at": st["fetched_at"] if st else None,
            "ok": bool(st["ok"]) if st else False, "error": st["error"] if st else None}


nearest_embassies = lookup.nearest_embassies


@app.get("/api/nearest-embassy")
def nearest_embassy(lat: float, lon: float, n: int = Query(1, ge=1, le=5)):
    return {"items": nearest_embassies(lat, lon, n)}


@app.get("/api/brief")
async def brief_for(id: str):
    """A short, facts-only summary for one marker, with the nearest operating embassy."""
    with db() as c:
        row = c.execute("SELECT json FROM features WHERE id = ?", (id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="unknown feature")
    f = json.loads(row["json"])
    p = f["properties"]
    lon, lat = f["geometry"]["coordinates"]

    nearby = lookup.nearby(lat, lon, brief.NEARBY_KM, exclude_id=id)

    title = await brief.page_title(p["source_url"]) if p["layer"] in brief.NEWS_LAYERS else None
    emb = nearest_embassies(lat, lon, 1)
    return brief.build(p, title, nearby, emb[0] if emb else None)


@app.get("/api/geocode")
async def geocode(q: str):
    """Proxy Nominatim (needs a User-Agent, max 1 req/s). Result cached in memory."""
    key = q.strip().lower()
    if key in GEOCODE_CACHE:
        return GEOCODE_CACHE[key]
    async with httpx.AsyncClient(timeout=15, headers={"User-Agent": "sitrep-personal/0.1"}) as client:
        r = await client.get("https://nominatim.openstreetmap.org/search",
                             params={"q": q, "format": "jsonv2", "limit": 1, "addressdetails": 1,
                                     "accept-language": "en"})  # else Amman comes back as عمان
        r.raise_for_status()
        hits = r.json()
    if not hits:
        return {"lat": None, "lon": None}
    h = hits[0]
    # Nominatim gives [south, north, west, east]. The map wants [west, south, east, north]
    # so a country, a state and a city each fit the screen at their own size.
    s, n, w, e = (float(x) for x in h["boundingbox"])
    addr = h.get("address") or {}
    result = {"lat": float(h["lat"]), "lon": float(h["lon"]), "name": h.get("display_name"),
              "bbox": [w, s, e, n], "iso2": (addr.get("country_code") or "").upper() or None, "country": addr.get("country")}
    GEOCODE_CACHE[key] = result
    return result


class TripIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    notes: str = Field("", max_length=2000)


class StopIn(BaseModel):
    label: str = Field(min_length=1, max_length=160)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    iso2: str | None = Field(None, pattern="^[A-Za-z]{2}$")
    arrive: date | None = None
    depart: date | None = None

    @model_validator(mode="after")
    def _in_order(self):
        if self.arrive and self.depart and self.depart < self.arrive:
            raise ValueError("depart is before arrive")
        return self


class StopEdit(BaseModel):
    label: str = Field(min_length=1, max_length=160)
    arrive: date | None = None
    depart: date | None = None

    @model_validator(mode="after")
    def _in_order(self):
        if self.arrive and self.depart and self.depart < self.arrive:
            raise ValueError("depart is before arrive")
        return self


def _iso(d: date | None) -> str | None:
    return d.isoformat() if d else None


@app.get("/api/trips")
def trips_list():
    return {"trips": trips.list_trips(), "unseen_alerts": len(trips.list_alerts(unseen_only=True))}


@app.post("/api/trips", status_code=201)
def trips_create(body: TripIn):
    return trips.get_trip(trips.create_trip(body.name, body.notes))


@app.put("/api/trips/{trip_id}")
def trips_update(trip_id: int, body: TripIn):
    if not trips.update_trip(trip_id, body.name, body.notes):
        raise HTTPException(status_code=404, detail="no such trip")
    return trips.get_trip(trip_id)


@app.delete("/api/trips/{trip_id}", status_code=204)
def trips_delete(trip_id: int):
    if not trips.delete_trip(trip_id):
        raise HTTPException(status_code=404, detail="no such trip")


@app.get("/api/trips/{trip_id}/briefing")
def trips_briefing(trip_id: int):
    """Everything the map knows about each stop, warnings ranked worst first. Local data only, so it is fast."""
    result = trips.briefing(trip_id)
    if not result:
        raise HTTPException(status_code=404, detail="no such trip")
    return result


@app.post("/api/trips/{trip_id}/stops", status_code=201)
def stops_add(trip_id: int, body: StopIn):
    stop_id = trips.add_stop(trip_id, body.label, body.lat, body.lon, body.iso2, _iso(body.arrive), _iso(body.depart))
    if stop_id is None:
        raise HTTPException(status_code=404, detail="no such trip")
    return trips.get_trip(trip_id)


@app.put("/api/stops/{stop_id}")
def stops_update(stop_id: int, body: StopEdit):
    if not trips.update_stop(stop_id, body.label, _iso(body.arrive), _iso(body.depart)):
        raise HTTPException(status_code=404, detail="no such stop")
    return {"ok": True}


@app.delete("/api/stops/{stop_id}", status_code=204)
def stops_delete(stop_id: int):
    if not trips.delete_stop(stop_id):
        raise HTTPException(status_code=404, detail="no such stop")


@app.get("/api/alerts")
def alerts_list(unseen: bool = False):
    return {"alerts": trips.list_alerts(unseen_only=unseen)}


class SeenIn(BaseModel):
    ids: list[int] | None = None
    trip_id: int | None = None


@app.post("/api/alerts/seen")
def alerts_seen(body: SeenIn):
    """Mark alerts seen: the given ids, or every alert of a trip, or all of them."""
    return {"marked": trips.mark_seen(body.ids, body.trip_id)}


app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
