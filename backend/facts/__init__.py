"""Per-country facts fetched on demand and cached: health (CDC) and entry rules (visa table).

A country's facts are looked up when someone opens it, not crawled on a schedule. Each provider
result is cached in SQLite, a week for good results and 15 minutes for failures so a blocked or
broken source is retried soon but never in a tight loop.
"""
import asyncio

from . import cache, cdc, entry, names
from .errors import FactsError

PROVIDERS = {"health": cdc, "entry": entry}
TTL = 7 * 24 * 3600
_locks: dict[tuple, asyncio.Lock] = {}


async def _provider(kind: str, iso2: str) -> dict:
    row = cache.get(iso2, kind)
    if cache.fresh(row, TTL):
        return row
    lock = _locks.setdefault((kind, iso2), asyncio.Lock())
    async with lock:  # two people opening the same country should not make two requests
        row = cache.get(iso2, kind)
        if cache.fresh(row, TTL):
            return row
        try:
            return cache.put(iso2, kind, True, await PROVIDERS[kind].fetch(iso2))
        except FactsError as e:
            return cache.put(iso2, kind, False, {"error": str(e)})


async def travel_info(iso2: str) -> dict:
    health, entry_rules = await asyncio.gather(_provider("health", iso2), _provider("entry", iso2))
    shape = lambda r: ({"ok": True, "fetched_at": r["fetched_at"], **r["data"]} if r["ok"]  # noqa: E731
                       else {"ok": False, "fetched_at": r["fetched_at"], "error": r["data"].get("error", "unavailable")})
    return {"iso2": iso2, "country": names.display_name(iso2), "health": shape(health), "entry": shape(entry_rules)}
