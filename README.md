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

Endpoints: `/api/features`, `/api/headlines?west&south&east&north`, `/api/advisories`, `/api/airspace`, `/api/aircraft`, `/api/aircraft/watch`, `/api/aircraft/route`, `/api/trips`, `/api/alerts`, `/api/travel-info?iso2=`, `/api/lgbt?iso2=`, `/api/lgbt-index`, `/api/nearest-embassy?lat&lon&n`, `/api/brief?id=`, `/api/geocode?q=`, `/api/plugins`.

## Adding a data source

Drop a file in `backend/plugins/` with a class named `Plugin` that extends `SitrepPlugin` (`backend/plugin_base.py`). Set `name`, `layer`, `cache_ttl_seconds`, then write `fetch()` and `normalize()`. Normalize into GeoJSON features with `id, layer, severity (low|medium|high|critical), title, summary, timestamp, source_url`. Country-level sources set `iso2` and can leave geometry empty. Restart and it is live. `usgs.py` is the shortest example.

## Status

Live: USGS earthquakes, GDACS disasters (floods, cyclones, quakes, volcanoes, drought, wildfire), GDELT unrest (civil) and conflict (military), US embassies, State Department travel advisories, EASA airspace bulletins.

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

### About vaccines and entry requirements

Open any country card or embassy popup and press "Vaccines and entry requirements". It fetches that one country and shows two things.

**Entry for US citizens**: the visa requirement, the allowed stay and the notes (an eVisa, a 90 day limit, a note that Cuba tourism is prohibited under US law). Source is Wikipedia's "Visa requirements for United States citizens", credited with its licence (CC BY-SA 4.0) and the revision it was read from. I used it because the State Department's own country pages return 403 to anything but a browser, and working around that quietly is not something to do. It is crowd-edited, so it is a starting point and the destination's embassy decides. Passport validity rules (often six months beyond your stay) are usually not in the table, the popup says so.

**Health (CDC)**: the CDC's Travelers' Health page for that destination. The yellow fever entry requirement gets its own box, since it is the one that can stop you at a border, then the CDC's current travel health notices, then every vaccine and medicine as an expandable row with the CDC's own text. The tag beside each (Recommended, Consider, Not recommended, Depends on your trip) is read from the first line of each paragraph. When paragraphs disagree, for example Japanese encephalitis is recommended for some travelers, consider for others and not recommended for the rest, it says "Depends on your trip", never whichever line came first. The tags are a scanning aid, the CDC text is always one click away and nothing is paraphrased.

How it behaves, and why:
- **On demand, cached for a week.** Nothing is crawled on a schedule. There are 244 CDC destination pages at about 400 KB each and I have already been rate limited once by another agency doing less. Requests to the CDC are at least 3 seconds apart, a 403 or 429 stops and is not retried in a loop, and a failure is remembered for 15 minutes so a broken source is retried soon but not hammered. Wikipedia's whole table is one request.
- **Country names are matched exactly, never fuzzily.** Both sources name countries in prose, and a wrong match would show one country's health advice on another. Names are normalised and matched against pycountry, Natural Earth and a short alias table (`backend/facts/names.py`). Checked by hand against the ambiguous ones: Georgia, Niger and Nigeria, both Congos, the Guineas, both Sudans, both Koreas. Anything unmatched has no result and says so. Regions such as Sudan - Darfur or Crimea are skipped on purpose.
- **A layout change fails loudly.** If the CDC page structure changes, or Wikipedia's table parses to fewer than 100 countries, the provider reports an error instead of showing a half-empty result as truth.
- **The CDC covers Israel, the West Bank and Gaza on one page**, so Palestine shows the same page as Israel.
- Adding another fact source (WHO, a country's own rules) is one file in `backend/facts/` with an async `fetch(iso2)`, registered in `backend/facts/__init__.py`.

### About the LGBT+ information

Press "LGBT+ safety" in any country card or embassy popup, or turn on the "LGBT+ index" layer to tint the whole map. It shows three sources side by side, and it deliberately does not add them into one made-up "safety score". Each measures something different, so an average would be a precise-looking number that means nothing.

- **Equaldex Equality Index** (0 to 100): laws and public attitudes, shown as its two parts plus a rank. Equaldex publishes it as open JSON. About 22 countries (Tajikistan, North Korea, Fiji, the Vatican) have no public opinion data, so their score is laws only, and the card says so.
- **Legal gender change**: Wikipedia's "Legal status of transgender people" table (partly from the Spartacus Gay Travel Index). Values like "permitted, with sterilization" show it is about whether a person can change legal gender. **It does not say whether living or dressing as your gender is tolerated or safe on the street**, and the card says that too. Crowd-edited, so treat it as a lead.
- **UK Foreign Office advice**: the "LGBT+ travellers" section of the FCDO's travel advice, quoted as written (Open Government Licence). It states the legal position plainly, for example Uganda's Anti-Homosexuality Act and its penalties. It is written for UK travellers, and about a third of countries have no dedicated section, which the card says without implying nothing applies.

None of these measures the risk to you on a given street. City and countryside differ, and a good score does not make every place safe or a low one every place dangerous.

Equaldex's terms, which the code is built around: credit and link Equaldex wherever the index is shown (the layer's legend and the card both do), non-commercial use only, **do not store its data more than 30 days** (it is cached 7 days and anything older than 25 is deleted at startup, `facts/lgbt.py`), and **do not track the index over time or publish comparisons of historical scores**, because scores shift as their public opinion data improves, not because equality changed. So only the current value is kept, never a history. Their per-issue data (criminalisation of gender expression, for example) needs an API key and is not used yet.

The map layer is a country tint like the advisories, so turning one on hides the other and turning it off brings them back.

### About the airspace layer

EASA, the European aviation regulator, issues Conflict Zone Information Bulletins (CZIBs) when the airspace over somewhere becomes dangerous for civil aircraft, and tells airlines what to do about it. Countries under an active bulletin get a dashed outline, magenta where airlines are advised not to operate and light blue where they are advised to take caution, with a thinner dotted outline when a bulletin covers only part of a country (Pakistan's Baluchistan and Khyber Pakhtunkhwa, Yemen's Sana'a region). Click the country for the bulletin: EASA's recommendations quoted as written, the full text, the revision history, and the earlier bulletins for that place, which reads as a timeline (for Iran, five since 2020).

Why it is worth having: a new or revised bulletin means EASA's assessment of the risk just changed. Popups tag a bulletin **NEW** if it was issued in the last 30 days and **REVISED n DAYS AGO** if it was revised in that time. Right now the five Middle East bulletins (Jordan, the Gulf states, Lebanon, Iraq, Iran) were all revised on 31 August, and that is the thing to notice.

What it is not: a prediction. It is a signal about risk **to aircraft**, not to people on the ground, and several bulletins are long-running (Afghanistan since 2017, Ukraine since 2022). EASA's own disclaimer says its pages are "not necessarily comprehensive, complete, accurate or up to date". Reproduction is authorised with the source acknowledged, which the legend and every popup do.

How it works, and what to know before changing it (`backend/plugins/easa_czib.py`):
- The list page is read every 6 hours (one request). A bulletin's own page (about 290 KB) is fetched only when it is new or its revision date changed, then kept in `data/easa_czib.json`. The first run reads about 15 pages three seconds apart, after that almost nothing.
- Affected countries come from the bulletin's own explicit "Affected Countries" list, matched exactly, so a regional bulletin ("the Persian Gulf and Gulf of Oman") never needs a guess about which countries it covers.
- **"Do not operate" versus "caution" is read from the recommendation text, and my first pattern got Sudan wrong.** Sudan's bulletin says EASA "recommends not to fly", the pattern only knew "not operate", and a do-not-fly bulletin was labelled caution. It now covers operate, fly and overfly, with regression tests for the wordings seen, including "does not recommend cancelling flights", which must stay caution. If EASA changes its phrasing, check this first. The quoted text is always shown, so a wrong label is visible next to the words.
- A bulletin that partly restricts (Lebanon: not operate, except to and from Beirut under conditions) is labelled do not operate and the exception is in the quoted text.
- If the feed is unreachable the saved copy is served and carries an `as_of` time, the popup warns after 24 hours.
- Earlier bulletins are matched by shared country or a shared region phrase in the title ("Persian Gulf"), using only the titles' own words.

### About trips

Press **Trips** in the header. A trip is a list of stops, each a place with arrive and depart dates. Search for a place, check that the one it found is the one you mean (it shows the full name it matched), and add it. Each stop then gets a card, built from the map's own data and ranked so the thing to worry about is at the top:

- **Warnings, worst first**: the State Dept level and its reasons, EASA airspace bulletins (with "issued in the last 30 days" or "revised n days ago" called out), an embassy that is suspended or a note about its staffing, a nearest operating embassy more than 300 km away, and serious military conflict, civil unrest or disaster reports within 150 km. If nothing is flagged it says so, and adds that this is not a guarantee.
- **Sections** you open when you want them: the advisory and airspace detail, the nearest embassies with address and phone, the reports within 150 km, and the vaccines and entry requirements and the LGBT+ information. Those last two load the first time you open them, so opening a trip does not fire a dozen slow requests, and they are cached.
- **Print** gives a plain briefing to take with you.

**Alerts.** Each stop's country is snapshotted (State Dept level, EASA bulletins, the advisory's embassy note, embassy status), and every 30 seconds the runner compares the latest with the last snapshot for any trip that has not ended. When something changes an alert is recorded, and the Trips button shows a red count until you mark them seen. It only reads rows already in the database, so it costs nothing. In-app only for now, there is no push, email or Slack.

It is built not to cry wolf. A layer that has not loaded yet after a restart is left out of the comparison, so "not loaded" can never read as "the advisory was removed", and a cleared embassy note is not an alert. Ten cases covering this are worth re-running if you change `backend/trips.py` (`_diff`).

Privacy: trips live only in your local SQLite file (`data/sitrep.db`, ignored by git). The only thing that leaves the machine is the place name sent to the OpenStreetMap geocoder when you search, requested in English so "Amman" is not stored as its Arabic spelling.

Limits worth knowing: the briefing is only as good as the layers behind it and says nothing about places they have no data for. A stop with no country code (a spot in open water, say) cannot be matched to an advisory and the card says so. Elections and currency are not in the briefing yet because those layers do not exist yet.

### About live aircraft

Turn on **Aircraft (live)** and zoom to about the size of a country. Aircraft appear as planes pointing along their heading, and clicking one shows its callsign, registration, type, altitude, speed and squawk code. **Show route** looks up the airline and where it is flying from and to, and draws the great circle between the two airports (the route, not the exact path flown). **Military aircraft** is a separate layer showing every aircraft currently flagged military worldwide.

There is also a worldwide watch for aircraft squawking an emergency code (7500 hijack, 7600 radio failure, 7700 general emergency). When any exist a red strip appears with a link to each. **Most are medical or technical problems, not events**, and a hijack code is rare. Air ambulance flights are labelled but kept out of the watch, they are routine.

**What this cannot see, and the layer says so:**
- **Empty sky is not evidence that airspace is closed.** Positions come from ADS-B receivers that volunteers run, so coverage is thin over oceans, deserts and conflict zones. Compare with the EASA outlines for what is officially advised, not with an empty patch on this map.
- **Military aircraft mostly do not appear.** The ones flagged military are those that do broadcast, mostly Western, so a count is not a measure of military activity anywhere, and I have deliberately not built any "surge" detection on it.
- Not for navigation or anything safety-critical.

Where the data comes from and how it is used (`backend/aircraft.py`): [adsb.lol](https://adsb.lol) for positions, whose API is open under ODbL 1.0 (credited in the legend), and adsbdb.com for routes by callsign. It is a community service, so every upstream request goes through one gate at least a second apart, area results are cached 12 seconds, the worldwide watch is cached a minute, routes a day, and the area query is capped at the 250 nautical mile radius the API allows. The page asks for a circle sized from what you are looking at and simply says "zoom in" when the view is too large, instead of making a request that cannot be satisfied. Polling only happens while a layer is on.

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
- [x] LGBT+ information: Equaldex Equality Index, legal gender change, UK FCDO advice, no single score
- [ ] Trans-specific: Equaldex per-issue data (needs a free API key) for criminalisation of gender expression and passport marker rules, plus Canada and Australia travel advice as further sources
- [x] Vaccine and entry requirements per country (CDC Travelers' Health, Wikipedia visa table)
- [ ] Entry: passport validity and blank pages from a sourced dataset, and the State Department's country pages if a permitted route exists
- [ ] Health and outbreak alerts as a map layer (CDC notices are already listed per country in the card, the RSS feed and WHO Disease Outbreak News would put them on the globe)
- [ ] Elections calendar (IFES ElectionGuide, Wikidata, hand-curated overrides), flag anything inside 30 days
- [ ] Currency and dollar strength per country (Frankfurter/ECB), 30 and 90 day trend
- [x] Trip view: save destinations and dates, get a briefing per stop with warnings sorted to the top, and print it
- [x] Airspace early warning: EASA Conflict Zone Information Bulletins as a layer, with NEW and REVISED tags and the history of earlier bulletins
- [x] Live aircraft, routes on click, worldwide emergency squawk watch and military-flagged aircraft (adsb.lol, adsbdb.com)
- [ ] Aircraft: short trails behind each aircraft from our own polls, and an emergency squawk near a saved trip stop as a trip alert
- [ ] Airspace emptiness: compare live traffic over a region with our own rolling baseline to spot airlines rerouting. Needs days of samples first, and cannot tell a closure from missing receivers, so treat as the weakest signal
- [ ] Airport delays and ground stops (FAA NAS status). Not available without registration: FAA NOTAMs. Blocked to non-browsers (403): the FAA prohibitions page
- [ ] Stacked markers: markers at the same place overlap, let a click cycle through them or list them all
- [ ] Local Ollama summaries of each trip briefing (rewording verified facts only, never adding any)
- [x] Trip alerts: in-app, when a saved trip's advisory level, EASA bulletins, or embassy note change
- [ ] Trip alerts beyond the app: push, email or Slack, and a per-trip choice of which changes matter
- [ ] "Add to trip" straight from a country card or embassy popup on the map, and dragging stops into order
- [ ] Elections and currency in the trip briefing, once those layers exist, with the trip dates deciding what counts as "during your stay"
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
- Airspace bulletins: European Union Aviation Safety Agency (EASA), easa.europa.eu, reproduced with the source acknowledged.
- LGBT+ Equality Index: Equaldex (equaldex.com), used under its non-commercial API terms. Advice text: UK Foreign, Commonwealth and Development Office, Open Government Licence v3.0.
- Vaccines and health notices: CDC Travelers' Health (wwwnc.cdc.gov/travel). Entry rules: Wikipedia contributors, CC BY-SA 4.0. Country name matching: pycountry.
- Aircraft positions: adsb.lol contributors (ODbL 1.0). Routes and airlines: adsbdb.com.
- Earthquakes: USGS. Disasters: GDACS. Unrest: the GDELT Project. Embassies: OpenStreetMap contributors (ODbL) via Overpass.
