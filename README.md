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

- `frontend/`: MapLibre GL JS with the globe projection, layer toggles, sidebar, search. Plain JS, no build step. Spin it as a globe, zoom to street level. Country and state lines come from the basemap tiles, US county lines from `frontend/vendor/counties-10m.json`.
- `backend/main.py`: FastAPI. Runs each plugin on its own TTL, stores normalized features in SQLite (`data/sitrep.db`), and serves them. The browser only talks to this server, never to upstream APIs, so rate limits and API keys stay on the backend.
- `backend/plugins/`: one file per data source.
- If a source fails, its last good data stays and `/api/plugins` reports the error. Stale but labeled beats blank.

Endpoints: `/api/features`, `/api/headlines?west&south&east&north`, `/api/advisories`, `/api/nearest-embassy?lat&lon&n`, `/api/brief?id=`, `/api/geocode?q=`, `/api/plugins`.

## Adding a data source

Drop a file in `backend/plugins/` with a class named `Plugin` that extends `SitrepPlugin` (`backend/plugin_base.py`). Set `name`, `layer`, `cache_ttl_seconds`, then write `fetch()` and `normalize()`. Normalize into GeoJSON features with `id, layer, severity (low|medium|high|critical), title, summary, timestamp, source_url`. Country-level sources set `iso2` and can leave geometry empty. Restart and it is live. `usgs.py` is the shortest example.

## Status

Live: USGS earthquakes, GDACS disasters (floods, cyclones, quakes, volcanoes, drought, wildfire), GDELT unrest (civil) and conflict (military), US embassies, State Department travel advisories.

### About the Unrest and Conflict layers

Both come from the GDELT events export, which machine-codes news articles every 15 minutes. They measure how many independent outlets are reporting something in a place over the last 24 hours. They do not verify that anything happened, and severity is a count of outlets (5, 10 and 20 are the steps), not a danger score.

They are split by who is acting, because event type alone was badly wrong. Only about 14% of GDELT "fight" events and 9% of "assault" events involve any military or armed-group actor, the rest are governments, police, courts and civilians, and the first version of this layer was mostly politics and ordinary crime (a robbery arrest showed up as "armed clashes").

- **Conflict** is military: armed clashes, attacks and posturing, but only when a military, rebel, insurgent, separatist or other armed-force actor is involved. Mass violence is included either way. This layer is in good shape, the lead articles are missile strikes, attacks on shipping and the fighting around Gaza, Ukraine and Iran.
- **Unrest** is civil: demonstrations, strikes, blockades and riots that involve civilians, labour, students, opposition or farmers, violent repression of civilians by police, military or government, and curfews or emergency rule. Generic "political dissent" (a politician's speech) and a government acting alone are excluded, they were coded as protest and were most of the noise.

Things to know when reading them:
- **Unrest is thin and only partly right.** This feed captures civil unrest poorly. Expect a dozen or so markers, roughly a third of them solid and the rest incidental mentions. Read the lead headline in the popup. The real fix is a better source, see the roadmap.
- Places are where the news is datelined, so capitals such as Washington, London and Moscow get pulled up. Treat those as "in the news".
- Country-level locations are dropped on purpose, they would pin a dot to the middle of a country.
- Coercion events other than violent repression and curfews (sanctions, arrests, political pressure) are excluded, they were the biggest group and nearly all political news.
- The first run backfills 24 hours (about 95 small files, a couple of seconds). After that it only fetches new files.
- GDELT redirects plain http, so the plugin uses https, and the newest file often 404s for a few minutes. That is treated as "not yet", not as an error.

### About the situation summary

Click any incident marker and the popup fills in a short summary: how many outlets reported it and when, the lead headline from the source article, what else is reported within 150 km, and the nearest operating US embassy.

It is not written by a language model, on purpose. The data behind a marker is thin (a place, an outlet count, an article link), so a model would mostly reword it and could invent detail, and this is a safety tool. Every line is a fact we hold. The lead headline is fetched from the article itself, which is also how you can tell a real conflict from a mislabelled one (a robbery arrest coded as "armed clashes" reads as one the moment you see the headline).

Notes:
- The headline fetch only follows public addresses. Article links come from a third-party feed, so anything that resolves to a private, loopback or link-local address (including through a redirect) is refused. Known gap: the address is checked and then the HTTP client resolves the name again, so a hostile DNS server could in theory race the check. The server only listens on localhost, so that is acceptable today. Pin the resolved address before exposing this beyond your own machine.
- Several event types at the same place share coordinates and stack on top of each other, so a click opens the top one. The sidebar lists all of them and the summary's "Nearby" line names the rest.
- An optional local Ollama pass to smooth the wording is possible later. It would only rephrase these facts.

### About the State Dept advisories

Every country's State Department advisory, from travel.state.gov. Level 4 countries are tinted red. Level 3 countries are hatched orange like caution tape (any translucent orange on dark land turns brown). Level 1 and 2 are not drawn, Level 2 alone covers 80-odd countries including France and Mexico, but they show in the country card. Click any country for a card with the level, the headline sentence, the reasons the advisory gives (quoted, not paraphrased), the latest update note, and a link to the full text. A card at the top of the sidebar shows the advisory for the country under the middle of the map, and embassy popups show their host country's level.

Where the advisory text mentions embassy staffing ("ordered departure", "suspended operations"), that sentence is quoted next to the embassy with the advisory's date. It is deliberately not turned into a status, the wording varies too much and a wrong automatic call on an embassy is worse than none. Compare it with `backend/data/embassy_status.json`.

Things that will bite you if you touch this:
- **The State Dept API is inconsistent.** Back-to-back requests return different payloads (216 to 225 entries) and alternate between a current state and one that is months old, apparently from replicas holding different data. The plugin asks four times per refresh, merges every advisory by its link keeping the newest `Updated`, merges that into the saved copy in `data/state_dept_raw.json`, and then keeps only the newest entry per country and name. Data only moves forward. It can take a couple of refreshes to see the newest copy of every advisory, and a freshly deleted `state_dept_raw.json` starts from whatever the first responses hold.
- **It rate-limits.** Cloudflare answers 429 ("Just a moment...") if you hammer it. Each refresh is 4 requests of about 1 MB, spaced 4 seconds apart, every 6 hours, and it stops at the first 429. Do not loop it while testing. When the feed is unreachable the saved copy is served and every advisory carries an `as_of` time, the popup warns after 12 hours.
- **Codes are FIPS, not ISO** (Iraq is IZ, Ukraine UP). `backend/data/countries.json` maps them and is built by `scripts/build_country_data.py` from Natural Earth. A few entries are patched by hand there because Natural Earth leaves FIPS blank.
- **Sub-regions are separate advisories.** Gaza and the West Bank are tagged as Israel in the feed, and taking the highest level per tag would paint all of Israel Level 4, so they are matched by name and shown on the Palestine polygon. Israel stays at its own level. Hong Kong, Macau and a few Caribbean territories get the same treatment. Anything that cannot be placed is skipped and logged, never guessed.
- **Polygons are Natural Earth 50m**, rounded to about 1 km. They are coarser than the basemap borders, so the tint fades out as you zoom in past zoom 5. Natural Earth's disputed-border choices are Natural Earth's.

### About the embassy stars

Every operating US embassy is a gold star. Click one for the address, phone numbers, the embassy website and the State Department's 24/7 lines (+1 202-501-4444 from abroad, 1-888-407-4747 from the US or Canada). The card at the top of the sidebar shows the nearest operating embassy to the middle of the map. That distance is straight-line, not a route, so a river, a border or a closed road can make the real trip much longer.

Where it comes from and what to distrust:
- The list comes from OpenStreetMap through the Overpass API (`backend/plugins/embassies.py`), refreshed weekly. Ambassador residences, UN and EU missions, USAID offices and cultural centers are filtered out. About 170 embassies remain.
- Phone numbers and addresses are whatever volunteers entered. About four in five embassies have a phone, and the rest say "not in the map data" and point to the website. Nothing is filled in by guessing. Confirm before you rely on any of it.
- OpenStreetMap cannot tell whether an embassy is open. `backend/data/embassy_status.json` is a hand-kept list of embassies that are suspended or unclear (Afghanistan, Syria, Libya, Yemen, Belarus, Sudan, Venezuela). Those show as grey stars and are skipped by the nearest-embassy card. Everything else shows gold and the popup says "not checked live". That file was seeded from public announcements up to early 2026 and needs a review against travel.state.gov. Ordered departures and newer closures are not in it.
- Known data quirks: a few entries carry the wrong host country or are consulates tagged as embassies (Guayaquil, for one), and a few countries show two posts (Israel has Jerusalem and Tel Aviv).

## Roadmap

- [x] GDELT headlines for unrest and conflict, filtered by visible area
- [ ] Unrest: a better source. GDELT's themed article index (GKG, PROTEST and RIOT themes) has far better recall than the events feed, ACLED is the other option (registration and terms to check). Also cut the capital-city dateline skew
- [ ] Embassies: the advisory's staffing sentence is now quoted beside each embassy, but the status file is still hand-kept. Add consulates general, and check the phone numbers against usembassy.gov
- [x] State Dept advisories: level tint, country card, red banner at Level 3 and 4
- [ ] Advisories: place Gaza, West Bank and other sub-regions as their own areas, and add State Dept Alerts (the separate alert feed), plus UK FCDO as a second opinion
- [ ] Trans traveler safety: Equaldex legal framework plus curated social climate notes, no single score
- [ ] Vaccine and entry requirements per country (CDC Travelers' Health, WHO)
- [ ] Health and outbreak alerts (WHO Disease Outbreak News, CDC travel notices)
- [ ] Elections calendar (IFES ElectionGuide, Wikidata, hand-curated overrides), flag anything inside 30 days
- [ ] Currency and dollar strength per country (Frankfurter/ECB), 30 and 90 day trend
- [ ] Trip view: save destinations and dates, get a one-screen briefing per stop with warnings sorted to the top
- [ ] Airport delays (FAA NAS status), live flights optional
- [ ] Stacked markers: markers at the same place overlap, let a click cycle through them or list them all
- [ ] Local Ollama summaries of each trip briefing (rewording verified facts only, never adding any)
- [ ] Trip alerts: notify me when a saved trip's advisory level changes
- [ ] Per-city traffic (TomTom/HERE free tiers)
- [ ] Self-host the basemap (Protomaps PMTiles, about 15 GB for North America) so it runs offline. Needs a different style, the Protomaps schema is not OpenMapTiles.
- [ ] Second-level boundaries outside the US (districts, counties elsewhere), geoBoundaries ADM2 is the likely source

## Notes on data

Safety information about people is subjective and uneven. City and countryside can be worlds apart, so this shows sources and dates rather than a single score. Check each source's terms before relying on it, and confirm health and entry requirements with the CDC or the embassy before you fly.

## Data credits

- Basemap tiles: [OpenFreeMap](https://openfreemap.org), OpenMapTiles schema, data from OpenStreetMap contributors. The map needs internet for now.
- US county boundaries: US Census cartographic boundaries via [us-atlas](https://github.com/topojson/us-atlas) (ISC licence), decoded with topojson-client (ISC). Both are vendored in `frontend/vendor/`.
- Country polygons: [Natural Earth](https://www.naturalearthdata.com) (public domain), simplified by `scripts/build_country_data.py`.
- Travel advisories: US Department of State, travel.state.gov.
- Earthquakes: USGS. Disasters: GDACS. Unrest: the GDELT Project. Embassies: OpenStreetMap contributors (ODbL) via Overpass.
