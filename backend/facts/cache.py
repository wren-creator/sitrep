"""SQLite cache for per-country facts, shared by every provider. Table: country_facts."""
import json
import time

_db = None


def set_db(factory) -> None:
    global _db
    _db = factory


def get(iso2: str, provider: str) -> dict | None:
    with _db() as c:
        row = c.execute("SELECT fetched_at, ok, json FROM country_facts WHERE iso2 = ? AND provider = ?",
                        (iso2, provider)).fetchone()
    if not row:
        return None
    return {"fetched_at": row["fetched_at"], "ok": bool(row["ok"]), "data": json.loads(row["json"])}


def put(iso2: str, provider: str, ok: bool, data: dict) -> dict:
    now = time.time()
    with _db() as c:
        c.execute("INSERT OR REPLACE INTO country_facts VALUES (?,?,?,?,?)", (iso2, provider, now, int(ok), json.dumps(data)))
    return {"fetched_at": now, "ok": ok, "data": data}


def fresh(row: dict | None, ttl: float, error_ttl: float = 900) -> bool:
    """A good result lives for ttl. A failure only for error_ttl, so we retry soon but not in a tight loop."""
    if not row:
        return False
    return time.time() - row["fetched_at"] < (ttl if row["ok"] else error_ttl)


def purge(provider: str, max_age: float) -> int:
    """Delete rows for a provider older than max_age seconds. Used where a source limits how long data may be kept."""
    with _db() as c:
        cur = c.execute("DELETE FROM country_facts WHERE provider = ? AND fetched_at < ?", (provider, time.time() - max_age))
        return cur.rowcount
