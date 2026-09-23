// Live aircraft (adsb.lol community receivers), a worldwide watch for emergency squawks and military-flagged
// aircraft, and the route of an aircraft you click. Loaded after app.js, shares its helpers and map.
//
// What this cannot see, and the legend says so: only aircraft near a community receiver, so thin coverage
// over oceans, deserts and conflict zones. An empty patch of sky is NOT evidence that airspace is closed.
// Military aircraft mostly do not broadcast, the ones shown are those flagged military, mostly Western.

const AC = { timer: null, watchTimer: null, mapTimer: null, watch: null, lastArea: 0 };
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
  ['sitrep-aircraft', 'sitrep-military', 'sitrep-ac-alert', 'sitrep-route'].forEach((id) => map.addSource(id, { type: 'geojson', data: emptyFc() }));

  const size = ['interpolate', ['linear'], ['zoom'], 3, 0.42, 6, 0.7, 10, 1.05];
  const hidden = (which) => ({ visibility: acVisible(which) ? 'visible' : 'none' });
  map.addLayer({ id: 'sitrep-ac-route-line', type: 'line', source: 'sitrep-route',
    layout: { 'line-join': 'round' }, paint: { 'line-color': '#7dd3fc', 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.9 } });
  map.addLayer({ id: 'sitrep-military', type: 'symbol', source: 'sitrep-military',
    layout: { ...hidden('military'), 'icon-image': 'plane-mil', 'icon-size': size, 'icon-rotate': ['coalesce', ['get', 'track'], 0],
      'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
  map.addLayer({ id: 'sitrep-aircraft', type: 'symbol', source: 'sitrep-aircraft',
    layout: { ...hidden('aircraft'), 'icon-image': ['case', ['get', 'mil'], 'plane-mil', ['!=', ['get', 'alert'], null], 'plane-alert', 'plane-civil'],
      'icon-size': size, 'icon-rotate': ['coalesce', ['get', 'track'], 0], 'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true, 'icon-ignore-placement': true } });
  map.addLayer({ id: 'sitrep-ac-alert-halo', type: 'circle', source: 'sitrep-ac-alert',
    paint: { 'circle-radius': 16, 'circle-color': 'rgba(255,77,77,0.28)', 'circle-stroke-color': '#ff4d4d', 'circle-stroke-width': 1.5 } });
  map.addLayer({ id: 'sitrep-ac-alert', type: 'symbol', source: 'sitrep-ac-alert',
    layout: { 'icon-image': 'plane-alert', 'icon-size': 0.65, 'icon-rotate': ['coalesce', ['get', 'track'], 0],
      'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true } });

  ['sitrep-aircraft', 'sitrep-military', 'sitrep-ac-alert'].forEach((id) => {
    map.on('click', id, (e) => {
      const f = e.features[0];
      popup.setLngLat(f.geometry.coordinates).setHTML(aircraftPopup(f.properties)).addTo(map);
      popup.sitrepId = 'ac:' + f.properties.hex;
      wireRoute(popup, f.properties);
      keepPopupInView(popup);
    });
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  });
  popup.on('close', () => map.getSource('sitrep-route')?.setData(emptyFc()));
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
  }
}

async function refreshAircraft() {
  if (!acVisible('aircraft')) return;
  const c = map.getCenter(), b = map.getBounds();
  const nm = kmToNm(kmBetween(c.lat, c.lng, b.getNorth(), b.getEast()));
  if (map.getZoom() < AC_MIN_ZOOM || nm > AC_MAX_NM * 1.1) {
    map.getSource('sitrep-aircraft')?.setData(emptyFc());
    setAcNote('Zoom in to see live aircraft. Live data covers a 250 nautical mile circle, about the size of a country.');
    return;
  }
  try {
    const res = await fetch(`/api/aircraft?lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}&nm=${Math.min(AC_MAX_NM, Math.ceil(nm / 10) * 10)}`);
    if (!res.ok) throw new Error(res.status);
    const d = await res.json();
    map.getSource('sitrep-aircraft')?.setData(acFc(d.aircraft));
    setAcNote(`${d.aircraft.length} aircraft in view, updated ${new Date(d.as_of * 1000).toLocaleTimeString()}.`);
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

function setAircraftVisible(which, on) {
  const id = which === 'aircraft' ? 'sitrep-aircraft' : 'sitrep-military';
  if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  clearInterval(AC.timer); clearInterval(AC.watchTimer);
  if (acVisible('aircraft')) { refreshAircraft(); AC.timer = setInterval(refreshAircraft, 15000); }
  else map.getSource('sitrep-aircraft')?.setData(emptyFc());
  if (acVisible('aircraft') || acVisible('military')) { refreshWatch(); AC.watchTimer = setInterval(refreshWatch, 60000); }
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
          <div class="pop-note">The great circle between the airports, not the exact path flown. Route data: adsbdb.com.</div>`;
        map.getSource('sitrep-route')?.setData({ type: 'Feature', properties: {},
          geometry: { type: 'MultiLineString', coordinates: greatCircle([o.lon, o.lat], [d.lon, d.lat]) } });
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
