# Sitrep

A personal world map for travel. Spin the globe, zoom in, and see what is going on where you are headed: disasters, unrest, health alerts, State Dept warnings, elections, and more. The sidebar shows headlines for whatever part of the world is in view, and the search bar flies you anywhere.

I travel for work, and the information I need before I fly is spread over a dozen sites. This puts it on one screen and keeps it fresh.

## Run it

```
./start.sh    # sets up the venv on first run, then runs in the background
./stop.sh
```

Open http://localhost:8765 (set `SITREP_PORT` to change it). Log is `data/server.log`. The first fetch of each source happens in the first few seconds.

## How it works

- `frontend/`: globe.gl (Three.js) globe, layer toggles, sidebar, search. Plain JS, no build step.
- `backend/main.py`: FastAPI. Runs each plugin on its own TTL, stores normalized features in SQLite (`data/sitrep.db`), and serves them. The browser only talks to this server, never to upstream APIs, so rate limits and API keys stay on the backend.
- `backend/plugins/`: one file per data source.
- If a source fails, its last good data stays and `/api/plugins` reports the error. Stale but labeled beats blank.

Endpoints: `/api/features`, `/api/headlines?west&south&east&north`, `/api/geocode?q=`, `/api/plugins`.

## Adding a data source

Drop a file in `backend/plugins/` with a class named `Plugin` that extends `SitrepPlugin` (`backend/plugin_base.py`). Set `name`, `layer`, `cache_ttl_seconds`, then write `fetch()` and `normalize()`. Normalize into GeoJSON features with `id, layer, severity (low|medium|high|critical), title, summary, timestamp, source_url`. Country-level sources set `iso2` and can leave geometry empty. Restart and it is live. `usgs.py` is the shortest example.

## Status

Live: USGS earthquakes, GDACS disasters (floods, cyclones, quakes, volcanoes, drought, wildfire), GDELT unrest and conflict.

### About the Unrest layer

This layer comes from the GDELT events export, which machine-codes news articles every 15 minutes. It measures how many independent outlets are reporting violence in a place over the last 24 hours. It does not verify that anything happened. Severity is a count of outlets (5, 10 and 20 outlets are the steps), not a danger score.

Things to know when reading it:
- Places are where the news is datelined, so capitals such as Washington, London and Moscow get pulled up. Treat those as "in the news" and read the source.
- Country-level locations are dropped on purpose, they would pin a dot to the middle of a country.
- Coercion events (sanctions, arrests, political pressure) are excluded. They were the biggest group and nearly all political news.
- The first run backfills 24 hours (about 95 small files, a couple of seconds). After that it only fetches new files.
- GDELT redirects plain http, so the plugin uses https, and the newest file often 404s for a few minutes. That is treated as "not yet", not as an error.

## Roadmap

- [x] GDELT headlines for unrest and conflict, filtered by visible area
- [ ] Unrest layer: fetch real article titles for the top places, and cut the capital-city dateline skew
- [ ] Country cards: State Dept advisory level and alerts (red banner at Level 3 or 4), UK FCDO
- [ ] Trans traveler safety: Equaldex legal framework plus curated social climate notes, no single score
- [ ] Vaccine and entry requirements per country (CDC Travelers' Health, WHO)
- [ ] Health and outbreak alerts (WHO Disease Outbreak News, CDC travel notices)
- [ ] Elections calendar (IFES ElectionGuide, Wikidata, hand-curated overrides), flag anything inside 30 days
- [ ] Currency and dollar strength per country (Frankfurter/ECB), 30 and 90 day trend
- [ ] Trip view: save destinations and dates, get a one-screen briefing per stop with warnings sorted to the top
- [ ] Airport delays (FAA NAS status), live flights optional
- [ ] Local Ollama summaries of each trip briefing
- [ ] Trip alerts: notify me when a saved trip's advisory level changes
- [ ] Per-city traffic (TomTom/HERE free tiers)
- [ ] Vendor globe.gl and textures locally so it runs offline

## Notes on data

Safety information about people is subjective and uneven. City and countryside can be worlds apart, so this shows sources and dates rather than a single score. Check each source's terms before relying on it, and confirm health and entry requirements with the CDC or the embassy before you fly.
