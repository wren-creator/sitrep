// Live aircraft (adsb.lol community receivers), a worldwide watch for emergency squawks and military-flagged
// aircraft, and the route of an aircraft you click. Loaded after app.js, shares its helpers and map.
//
// What this cannot see, and the legend says so: only aircraft near a community receiver, so thin coverage
// over oceans, deserts and conflict zones. An empty patch of sky is NOT evidence that airspace is closed.
// Military aircraft mostly do not broadcast, the ones shown are those flagged military, mostly Western.

const AC = { timer: null, watchTimer: null, mapTimer: null, watch: null, trails: new Map(), seeding: new Set(), seedPausedUntil: 0, selected: null, pathPts: [], legendCollapsed: false };
const AC_COLOR = { civil: '#cfe8ff', mil: '#ff9f43', alert: '#ff4d4d' };
const AC_MIN_ZOOM = 4;          // below this the view is far larger than the 250 nautical mile query the API allows
const AC_MAX_NM = 250;

function planeImage(fill, stroke) {
  const size = 48, c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.translate(size / 2, size / 2);
  g.beginPath();  // pointing up, so a heading of 0 is north
  [[0, -20], [3, -8], [19, 6], [19, 9], [3, 4], [2, 14], [8, 18], [8, 20], [0, 18], [-8, 20], [-8, 18], [-2, 14], [-3, 4], [-19, 9], [-19, 6], [-3, -8]]
    .forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.fillStyle = fill; g.fill();
  g.lineWidth = 2; g.lineJoin = 'round'; g.strokeStyle = stroke; g.stroke();
  return g.getImageData(0, 0, size, size);
}

const kmToNm = (km) => km / 1.852;
function kmBetween(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

const emptyFc = () => ({ type: 'FeatureCollection', features: [] });
const acFeature = (a) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lon, a.lat] }, properties: a });
const acFc = (list) => ({ type: 'FeatureCollection', features: list.map(acFeature) });
const acVisible = (which) => !state.hidden.has(which);

function addAircraftLayers() {
  map.addImage('plane-civil', planeImage(AC_COLOR.civil, '#0b1a26'), { pixelRatio: 2 });
  map.addImage('plane-mil', planeImage(AC_COLOR.mil, '#3a1a00'), { pixelRatio: 2 });
  map.addImage('plane-alert', planeImage(AC_COLOR.alert, '#3a0000'), { pixelRatio: 2 });
  ['sitrep-aircraft', 'sitrep-military', 'sitrep-ac-alert', 'sitrep-route', 'sitrep-path', 'sitrep-ac-trails', 'sitrep-selected', 'sitrep-route-pts'].forEach((id) => map.addSource(id, { type: 'geojson', data: emptyFc() }));

  const size = ['interpolate', ['linear'], ['zoom'], 3, 0.42, 6, 0.7, 10, 1.05];
  const hidden = (which) => ({ visibility: acVisible(which) ? 'visible' : 'none' });
  // Trails of every aircraft in view, built from our own polls, so they grow as you watch.
  map.addLayer({ id: 'sitrep-ac-trails', type: 'line', source: 'sitrep-ac-trails',
    layout: { ...hidden('aircraft'), 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ['case', ['get', 'mil'], '#ff9f43', '#cfe8ff'], 'line-opacity': 0.5,
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1, 8, 2] } });
  // The route from the airline's flight plan (dashed), then the path actually flown (solid white), on top.
  map.addLayer({ id: 'sitrep-ac-route-line', type: 'line', source: 'sitrep-route',
    layout: { 'line-join': 'round' }, paint: { 'line-color': '#7dd3fc', 'line-width': 2.5, 'line-dasharray': [2, 2], 'line-opacity': 0.95 } });
  map.addLayer({ id: 'sitrep-ac-path-line', type: 'line', source: 'sitrep-path',
    layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 3, 'line-opacity': 0.95 } });
  map.addLayer({ id: 'sitrep-ac-route-pts', type: 'circle', source: 'sitrep-route-pts',
    paint: { 'circle-radius': 6, 'circle-color': '#0b0f14', 'circle-stroke-color': '#7dd3fc', 'circle-stroke-width': 2.5 } });
  map.addLayer({ id: 'sitrep-military', type: 'symbol', source: 'sitrep-military',
    layout: { ...hidden('military'), 'icon-image': 'plane-mil', 'icon-size': size, 'icon-rotate': ['coalesce', ['get', 'track'], 0],
      'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
  map.addLayer({ id: 'sitrep-aircraft', type: 'symbol', source: 'sitrep-aircraft',
    layout: { ...hidden('aircraft'), 'icon-image': ['case', ['get', 'mil'], 'plane-mil', ['!=', ['get', 'alert'], null], 'plane-alert', 'plane-civil'],
      'icon-size': size, 'icon-rotate': ['coalesce', ['get', 'track'], 0], 'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true, 'icon-ignore-placement': true } });
  // The aircraft you clicked stays on the map even when zooming out for its route would hide the live layer.
  map.addLayer({ id: 'sitrep-ac-selected-halo', type: 'circle', source: 'sitrep-selected',
    paint: { 'circle-radius': 17, 'circle-color': 'rgba(255,255,255,0.12)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 } });
  map.addLayer({ id: 'sitrep-ac-selected', type: 'symbol', source: 'sitrep-selected',
    layout: { 'icon-image': 'plane-civil', 'icon-size': 0.8, 'icon-rotate': ['coalesce', ['get', 'track'], 0],
      'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
  map.addLayer({ id: 'sitrep-ac-alert-halo', type: 'circle', source: 'sitrep-ac-alert',
    paint: { 'circle-radius': 16, 'circle-color': 'rgba(255,77,77,0.28)', 'circle-stroke-color': '#ff4d4d', 'circle-stroke-width': 1.5 } });
  map.addLayer({ id: 'sitrep-ac-alert', type: 'symbol', source: 'sitrep-ac-alert',
    layout: { 'icon-image': 'plane-alert', 'icon-size': 0.65, 'icon-rotate': ['coalesce', ['get', 'track'], 0],
      'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true } });

  ['sitrep-aircraft', 'sitrep-military', 'sitrep-ac-alert'].forEach((id) => {
    map.on('click', id, (e) => {
      const f = e.features[0];
      clearRoute();
      popup.setLngLat(f.geometry.coordinates).setHTML(aircraftPopup(f.properties)).addTo(map);
      popup.sitrepId = 'ac:' + f.properties.hex;
      AC.selected = { props: f.properties, coords: f.geometry.coordinates };
      map.getSource('sitrep-selected')?.setData(acFc([{ ...f.properties, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }]));
      wireRoute(popup, f.properties);
      loadPath(popup, f.properties);
      keepPopupInView(popup);
    });
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  });
  popup.on('close', clearRoute);
  map.on('moveend', () => { clearTimeout(AC.mapTimer); AC.mapTimer = setTimeout(refreshAircraft, 700); });
}

// ------------------------------------------------------------------ data

function setAcNote(html) {
  const box = el('legend-ac');
  const on = acVisible('aircraft') || acVisible('military');
  box.hidden = !on;
  if (on) {
    box.innerHTML = `<div class="lg-legend-title">✈ Live aircraft</div>${html ? `<div class="ac-status">${html}</div>` : ''}
      <div class="ac-keys"><span><i class="ac-dot" style="background:${AC_COLOR.civil}"></i>Civil</span>
        <span><i class="ac-dot" style="background:${AC_COLOR.mil}"></i>Flagged military</span>
        <span><i class="ac-dot" style="background:${AC_COLOR.alert}"></i>Emergency squawk</span></div>
      <div class="lg-legend-note"><b>An empty sky is not evidence that airspace is closed.</b> Coverage is thin over oceans, deserts and conflict zones, and most
        military aircraft do not appear. Not for navigation. Data: <a href="https://adsb.lol" target="_blank" rel="noopener noreferrer">adsb.lol</a> (ODbL), routes adsbdb.com.</div>`;
    box.classList.toggle('collapsed', AC.legendCollapsed);
  }
}

// Each poll adds a point to every aircraft's trail, and two new aircraft per poll are seeded with their real recent
// track (about half an hour), so the screen fills with true trails within a couple of minutes instead of growing from
// nothing. At most two per poll and one request per second upstream, so a busy view never becomes a burst.
function drawTrails() {
  const features = [...AC.trails.entries()].filter(([, t]) => t.pts.length > 1)
    .map(([hex, t]) => ({ type: 'Feature', properties: { hex, mil: t.mil }, geometry: { type: 'LineString', coordinates: t.pts } }));
  map.getSource('sitrep-ac-trails')?.setData({ type: 'FeatureCollection', features });
}

function updateTrails(list) {
  const seen = new Set();
  for (const a of list) {
    if (a.alt === 'ground') continue;
    seen.add(a.hex);
    const t = AC.trails.get(a.hex) || { pts: [], mil: a.mil, seeded: false };
    const last = t.pts[t.pts.length - 1];
    if (!last || last[0] !== a.lon || last[1] !== a.lat) t.pts.push([a.lon, a.lat]);
    if (t.pts.length > 90) t.pts.shift();
    AC.trails.set(a.hex, t);
  }
  for (const hex of [...AC.trails.keys()]) if (!seen.has(hex)) AC.trails.delete(hex);
  drawTrails();
  seedTrails(list);
}

async function seedTrails(list) {
  if (Date.now() < AC.seedPausedUntil) return;  // the service pushed back recently, leave it alone
  const c = map.getCenter();
  const need = list.filter((a) => a.alt !== 'ground' && !AC.trails.get(a.hex)?.seeded && !AC.seeding.has(a.hex))
    .sort((a, b) => kmBetween(c.lat, c.lng, a.lat, a.lon) - kmBetween(c.lat, c.lng, b.lat, b.lon)).slice(0, 2);
  if (!need.length) return;
  need.forEach((a) => AC.seeding.add(a.hex));
  try {
    const res = await fetch('/api/aircraft/traces?hexes=' + need.map((a) => a.hex).join(','));
    if (!res.ok) throw new Error(res.status);
    const { traces } = await res.json();
    for (const a of need) {
      const t = AC.trails.get(a.hex);
      const pts = (traces[a.hex] || []).map((q) => [q[0], q[1]]);
      if (t && pts.length > 1) t.pts = [...pts, [a.lon, a.lat]];  // the real track, ending at the current position
      if (t) t.seeded = true;
    }
    drawTrails();
  } catch (err) {
    AC.seedPausedUntil = Date.now() + 120000;  // not marked seeded, they are tried again after the pause
  } finally {
    need.forEach((a) => AC.seeding.delete(a.hex));
  }
}

async function refreshAircraft() {
  if (!acVisible('aircraft')) return;
  const c = map.getCenter(), b = map.getBounds();
  const nm = kmToNm(kmBetween(c.lat, c.lng, b.getNorth(), b.getEast()));
  if (map.getZoom() < AC_MIN_ZOOM || nm > AC_MAX_NM * 1.1) {
    map.getSource('sitrep-aircraft')?.setData(emptyFc());
    AC.trails.clear();
    map.getSource('sitrep-ac-trails')?.setData(emptyFc());
    setAcNote('Zoom in to see live aircraft. Live data covers a 250 nautical mile circle, about the size of a country.');
    return;
  }
  try {
    const res = await fetch(`/api/aircraft?lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}&nm=${Math.min(AC_MAX_NM, Math.ceil(nm / 10) * 10)}`);
    if (!res.ok) {
      // The server explains itself ("asked us to slow down, trying again in 45 seconds"), so say that instead of a generic error.
      const why = (await res.json().catch(() => ({}))).detail;
      setAcNote(`<span class="stale">${esc(why || 'Aircraft data unavailable right now.')}</span>`);
      return;
    }
    const d = await res.json();
    map.getSource('sitrep-aircraft')?.setData(acFc(d.aircraft));
    updateTrails(d.aircraft);
    const ago = Math.round(Date.now() / 1000 - d.as_of);
    setAcNote(d.stale
      ? `<span class="stale">${d.aircraft.length} aircraft, positions ${ago} seconds old. The data service asked us to slow down, so this is the last good picture.</span>`
      : `${d.aircraft.length} aircraft in view, updated ${new Date(d.as_of * 1000).toLocaleTimeString()}.`);
  } catch (err) {
    setAcNote('<span class="stale">Aircraft data unavailable right now.</span>');
  }
}

async function refreshWatch() {
  if (!acVisible('aircraft') && !acVisible('military')) return;
  try {
    const res = await fetch('/api/aircraft/watch');
    if (!res.ok) throw new Error(res.status);
    AC.watch = await res.json();
    map.getSource('sitrep-military')?.setData(acVisible('military') ? acFc(AC.watch.military) : emptyFc());
    map.getSource('sitrep-ac-alert')?.setData(acFc(AC.watch.emergencies));
    renderAlertBanner();
    if (!acVisible('aircraft')) setAcNote(milNote());  // military only: the note was written before the data came
  } catch (err) {
    console.error('aircraft watch failed', err);
  }
}

// A worldwide strip when any aircraft is squawking an emergency code. Most are medical or technical, not events.
function renderAlertBanner() {
  const box = el('air-alert');
  const list = AC.watch?.emergencies || [];
  if (!list.length || !(acVisible('aircraft') || acVisible('military'))) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<b>✈ ${list.length} aircraft squawking an emergency code right now</b> ` +
    list.slice(0, 4).map((a) => `<a href="#" data-lat="${a.lat}" data-lon="${a.lon}">${esc(a.callsign || a.hex)} (${esc(a.squawk || '')} ${esc(a.alert || '')})</a>`).join(' · ') +
    ` <span class="pop-meta">Most are medical or technical problems, not events. A hijack code is rare.</span>`;
  box.querySelectorAll('a').forEach((a) => a.addEventListener('click', (ev) => {
    ev.preventDefault();
    map.flyTo({ center: [+a.dataset.lon, +a.dataset.lat], zoom: 7, duration: 1400 });
  }));
}

const milNote = () => (AC.watch ? `${AC.watch.military.length} military-flagged aircraft in the air worldwide right now.` : 'Loading...');

// The live query covers a 250 nautical mile circle, so a world view has nothing to show. When you turn the layer on
// from one, zoom in for you, by exactly as much as it takes, instead of leaving a message you may not read.
function zoomForAircraft() {
  const c = map.getCenter(), b = map.getBounds();
  const nm = kmToNm(kmBetween(c.lat, c.lng, b.getNorth(), b.getEast()));
  if (nm <= AC_MAX_NM * 0.95 && map.getZoom() >= AC_MIN_ZOOM) return false;
  const zoom = Math.min(9, Math.max(AC_MIN_ZOOM, map.getZoom() + Math.log2(nm / (AC_MAX_NM * 0.85))));
  map.flyTo({ center: c, zoom: Math.ceil(zoom * 10) / 10, duration: 1200 });
  return true;
}

function setAircraftVisible(which, on) {
  const id = which === 'aircraft' ? 'sitrep-aircraft' : 'sitrep-military';
  if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  if (which === 'aircraft') {
    if (map.getLayer('sitrep-ac-trails')) map.setLayoutProperty('sitrep-ac-trails', 'visibility', on ? 'visible' : 'none');
    if (on && zoomForAircraft()) setTimeout(refreshAircraft, 1500);
    if (!on) { AC.trails.clear(); map.getSource('sitrep-ac-trails')?.setData(emptyFc()); }
  }
  clearInterval(AC.timer); clearInterval(AC.watchTimer);
  if (acVisible('aircraft')) { refreshAircraft(); AC.timer = setInterval(refreshAircraft, 20000); }
  else map.getSource('sitrep-aircraft')?.setData(emptyFc());
  if (acVisible('aircraft') || acVisible('military')) { refreshWatch(); AC.watchTimer = setInterval(refreshWatch, 120000); }
  else { map.getSource('sitrep-ac-alert')?.setData(emptyFc()); map.getSource('sitrep-military')?.setData(emptyFc()); }
  if (!acVisible('aircraft') && !acVisible('military')) { el('legend-ac').hidden = true; el('air-alert').hidden = true; }
  else setAcNote(acVisible('aircraft') ? '' : milNote());
}

// ------------------------------------------------------------------ popup and route

const fmtAlt = (a) => (a === 'ground' ? 'on the ground' : a == null ? 'unknown' : a >= 18000 ? `FL${Math.round(a / 100)}` : `${a.toLocaleString()} ft`);

function aircraftPopup(p) {
  const bits = [p.type ? esc(p.type) : '', p.desc ? esc(p.desc) : '', p.reg ? esc(p.reg) : ''].filter(Boolean).join(' · ');
  return `<div class="pop-title">✈ ${esc(p.callsign || p.hex)}${p.mil === true || p.mil === 'true' ? ' <span class="air-tag">MILITARY-FLAGGED</span>' : ''}</div>
    ${bits ? `<div class="pop-meta">${bits}</div>` : ''}
    <div class="pop-row"><b>Altitude and speed</b> ${esc(fmtAlt(p.alt === 'ground' ? 'ground' : p.alt == null || p.alt === 'null' ? null : +p.alt))}${p.gs && p.gs !== 'null' ? ` · ${esc(p.gs)} kt` : ''}${p.track && p.track !== 'null' ? ` · heading ${Math.round(+p.track)}°` : ''}</div>
    ${p.alert && p.alert !== 'null' ? `<div class="pop-note stale"><b>${esc(p.squawk || 'Alert')}: ${esc(p.alert)}.</b> Most are medical or technical problems, not events.</div>` : ''}
    <div class="ac-path pop-note">Loading the path flown...</div>
    <div class="pop-lgbt ac-route"><button type="button" class="linkish">Show route</button></div>
    <div class="pop-note">Live position from adsb.lol community receivers, a few seconds old. Not for navigation.</div>`;
}

// Great circle between two airports, split where it crosses the antimeridian so it does not streak across the map.
function greatCircle(a, b, n = 72) {
  const r = Math.PI / 180, [lo1, la1] = [a[0] * r, a[1] * r], [lo2, la2] = [b[0] * r, b[1] * r];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
  if (!d) return [[a, b]];
  const lines = [[]];
  let prev = null;
  for (let i = 0; i <= n; i++) {
    const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
    const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
    const z = A * Math.sin(la1) + B * Math.sin(la2);
    const pt = [Math.atan2(y, x) / r, Math.atan2(z, Math.hypot(x, y)) / r];
    if (prev && Math.abs(pt[0] - prev[0]) > 180) lines.push([]);
    lines[lines.length - 1].push(pt);
    prev = pt;
  }
  return lines.filter((l) => l.length > 1);
}

// Everything that draws one aircraft's route is cleared together when its popup closes.
function clearRoute() {
  AC.selected = null; AC.pathPts = [];
  ['sitrep-route', 'sitrep-path', 'sitrep-selected', 'sitrep-route-pts'].forEach((id) => map.getSource(id)?.setData(emptyFc()));
}

// The path this aircraft has flown in about the last half hour, from its recent trace. Drawn as soon as you click.
async function loadPath(popupObj, p) {
  const note = () => popupObj.getElement()?.querySelector('.ac-path');
  try {
    const res = await fetch('/api/aircraft/trace?hex=' + encodeURIComponent(p.hex));
    if (!res.ok) throw new Error(res.status);
    const t = await res.json();
    if (!AC.selected || AC.selected.props.hex !== p.hex) return;  // clicked something else meanwhile
    if (t.points.length < 2) { if (note()) note().textContent = 'No recent track on record for this aircraft.'; return; }
    AC.pathPts = t.points.map((q) => [q[0], q[1]]);
    map.getSource('sitrep-path')?.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [...AC.pathPts, AC.selected.coords] } });
    if (note()) note().innerHTML = `<b>White line:</b> the path flown over roughly the last ${t.minutes} minutes.`;
  } catch (err) {
    if (note()) note().innerHTML = '<span class="stale">Could not load the recent track.</span>';
  }
}

function fitToFlight(popupObj, extra = []) {
  const b = new maplibregl.LngLatBounds();
  [...AC.pathPts, ...extra, ...(AC.selected ? [AC.selected.coords] : [])].forEach((c) => b.extend(c));
  if (b.isEmpty()) return;
  map.fitBounds(b, { padding: { top: 90, bottom: 90, left: 90, right: 90 }, maxZoom: 8.5, duration: 1200 });
  map.once('moveend', () => keepPopupInView(popupObj));
}

function wireRoute(popupObj, p) {
  const box = popupObj.getElement()?.querySelector('.ac-route');
  if (!box) return;
  const btn = box.querySelector('button');
  if (!p.callsign || p.callsign === 'null') { box.innerHTML = '<div class="pop-note">No callsign, so no route can be looked up.</div>'; return; }
  btn.addEventListener('click', async () => {
    box.innerHTML = '<div class="pop-note">Looking up the route...</div>';
    try {
      const res = await fetch('/api/aircraft/route?callsign=' + encodeURIComponent(p.callsign));
      if (!res.ok) throw new Error(res.status);
      const r = await res.json();
      if (!r.found) {
        box.innerHTML = '<div class="pop-note">No route on record for this callsign. Private, military and some cargo flights have none.</div>';
      } else {
        const o = r.origin, d = r.destination;
        const place = (x) => `${esc(x.city || x.name)}${x.iata ? ` (${esc(x.iata)})` : ''}${x.country ? ', ' + esc(x.country) : ''}`;
        box.innerHTML = `<div class="pop-row"><b>Route${r.airline ? ' · ' + esc(r.airline) : ''}</b>${place(o)}<br>to ${place(d)}</div>
          <div class="pop-note"><b>Dashed blue line:</b> the great circle between the airports, not the exact path flown. Route data: adsbdb.com.</div>`;
        const lines = greatCircle([o.lon, o.lat], [d.lon, d.lat]);
        map.getSource('sitrep-route')?.setData({ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } });
        map.getSource('sitrep-route-pts')?.setData({ type: 'FeatureCollection', features: [o, d].map((x) => ({ type: 'Feature', properties: { name: x.iata || '' },
          geometry: { type: 'Point', coordinates: [x.lon, x.lat] } })) });
        fitToFlight(popupObj, lines.flat());  // show the whole route, it usually runs far off the current view
      }
    } catch (err) {
      box.innerHTML = '<div class="pop-note stale">Could not look up the route right now.</div>';
    }
    keepPopupInView(popupObj);
  });
}

map.on('style.load', () => {
  addAircraftLayers();
  if (acVisible('aircraft') || acVisible('military')) { setAircraftVisible('aircraft', acVisible('aircraft')); }
});

// Legends are useful once and in the way after that, click a title to fold one up.
el('legends').addEventListener('click', (e) => {
  const title = e.target.closest('.lg-legend-title');
  if (!title) return;
  const box = title.parentElement;
  box.classList.toggle('collapsed');
  if (box.id === 'legend-ac') AC.legendCollapsed = box.classList.contains('collapsed');
});
