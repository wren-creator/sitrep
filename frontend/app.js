const LAYER_LABELS = { disaster: 'Disasters', conflict: 'Unrest', aviation: 'Flights', health: 'Health', embassy: '★ US embassies' };
const SEV_COLOR = { low: '#4aa3ff', medium: '#f2c14e', high: '#ff8a3d', critical: '#ff4d4d' };
const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';

const state = { features: [], byId: new Map(), layers: new Set(), hidden: new Set() };

// State Department Overseas Citizens Services, staffed around the clock.
const OCS_ABROAD = '+1 202-501-4444';
const OCS_US = '1-888-407-4747';
const el = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Source links come from third-party feeds, so only ever emit http(s) URLs.
function safeUrl(u) {
  return /^https?:\/\//i.test(u || '') ? u : '#';
}

const map = new maplibregl.Map({
  container: 'map',
  style: STYLE_URL,
  center: [-30, 20],
  zoom: 1.6,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');
map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');

// Look up a ["match", severity, ...] expression by severity.
const bySeverity = (critical, high, medium, low) =>
  ['match', ['get', 'severity'], 'critical', critical, 'high', high, 'medium', medium, low];

// The dark style paints water near-black grey, which reads as muddy on the globe. Make it blue.
const WATER = '#14497a';
function tintWater() {
  const set = (id, prop, value) => map.getLayer(id) && map.setPaintProperty(id, prop, value);
  set('water', 'fill-color', WATER);
  set('waterway', 'line-color', '#1d63a0');
  set('water_name', 'text-color', '#b4d4ee');
  set('water_name', 'text-halo-color', '#0b2a47');
}

function addBoundaries() {
  // Hide the style's own faint boundary lines, we draw stronger ones below.
  ['boundary_state', 'boundary_country_z0-4', 'boundary_country_z5-'].forEach((id) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
  });
  // Keep the lines under the place labels so names stay readable.
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  const line = (id, filter, paint, minzoom = 0) =>
    map.addLayer({
      id, type: 'line', source: 'openmaptiles', 'source-layer': 'boundary', filter, minzoom,
      layout: { 'line-join': 'round', 'line-cap': 'round' }, paint,
    }, firstSymbol);

  // Maritime lines are drawn in the tiles too, skip them.
  const land = ['!=', ['get', 'maritime'], 1];
  line('sitrep-state', ['all', ['==', ['get', 'admin_level'], 4], land], {
    'line-color': '#8aa0b8', 'line-opacity': 0.9, 'line-dasharray': [3, 2],
    'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.6, 8, 1.6],
  }, 2);
  line('sitrep-country', ['all', ['==', ['get', 'admin_level'], 2], land], {
    'line-color': '#c7d6e6', 'line-opacity': 0.95,
    'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.8, 8, 2.2],
  });
}

// The basemap tiles stop at states and provinces (admin level 4), so US county lines
// come from the Census boundaries in vendor/ (us-atlas). mesh() keeps only the shared
// borders between counties, so each line is drawn once.
async function addCounties() {
  try {
    const topo = await (await fetch('vendor/counties-10m.json')).json();
    const lines = topojson.mesh(topo, topo.objects.counties, (a, b) => a !== b);
    const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    map.addSource('sitrep-counties', { type: 'geojson', data: { type: 'Feature', geometry: lines, properties: {} } });
    map.addLayer({
      id: 'sitrep-county', type: 'line', source: 'sitrep-counties', minzoom: 4.5,
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': '#6b829b',
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 4.5, 0.35, 7, 0.8],
        'line-width': ['interpolate', ['linear'], ['zoom'], 4.5, 0.4, 10, 1.2],
      },
    }, firstSymbol);
  } catch (err) {
    console.error('county lines failed to load', err);
  }
}

function addFeatureLayers() {
  map.addSource('sitrep', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const color = ['match', ['get', 'severity'],
    'critical', SEV_COLOR.critical, 'high', SEV_COLOR.high, 'medium', SEV_COLOR.medium, SEV_COLOR.low];
  // Higher severity draws on top.
  const sort = ['-', 0, bySeverity(3, 2, 1, 0)];
  map.addLayer({
    id: 'sitrep-glow', type: 'circle', source: 'sitrep',
    layout: { 'circle-sort-key': sort },
    paint: {
      'circle-color': color, 'circle-opacity': 0.22, 'circle-blur': 0.8,
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        1, bySeverity(12, 10, 8, 6), 8, bySeverity(34, 28, 22, 16)],
      'circle-pitch-alignment': 'map',
    },
  });
  map.addLayer({
    id: 'sitrep-dot', type: 'circle', source: 'sitrep',
    layout: { 'circle-sort-key': sort },
    paint: {
      'circle-color': color, 'circle-opacity': 0.95,
      'circle-stroke-color': '#0b0f14', 'circle-stroke-width': 1,
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        1, bySeverity(5, 4, 3.5, 3), 8, bySeverity(11, 9, 8, 6)],
      'circle-pitch-alignment': 'map',
    },
  });
  // Golden star for an embassy that is operating, grey for one that is suspended or unclear.
  map.addImage('star-active', starImage('#ffc83d', '#7a5200'), { pixelRatio: 2 });
  map.addImage('star-inactive', starImage('#6d7885', '#2a323b'), { pixelRatio: 2 });
  map.addLayer({
    id: 'sitrep-embassy', type: 'symbol', source: 'sitrep',
    layout: {
      'icon-image': ['match', ['get', 'status'], 'active', 'star-active', 'star-inactive'],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.45, 5, 0.7, 10, 0.95],
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
    },
  });
  applyLayerFilter();

  const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '320px', offset: 10, focusAfterOpen: false });
  map.on('click', 'sitrep-dot', (e) => {
    const f = e.features[0];
    popup.setLngLat(f.geometry.coordinates).setHTML(incidentPopup(f.properties)).addTo(map);
    popup.sitrepId = f.properties.id;
    loadBrief(popup, f.properties.id);
  });
  map.on('click', 'sitrep-embassy', (e) => {
    const f = e.features[0];
    // MapLibre flattens list properties (phones) to strings, so use our own copy of the feature.
    const full = state.byId.get(f.properties.id)?.properties || f.properties;
    popup.setLngLat(f.geometry.coordinates).setHTML(embassyPopup(full)).addTo(map);
    popup.sitrepId = f.properties.id;
    keepPopupInView(popup);
  });
  ['sitrep-dot', 'sitrep-embassy'].forEach((id) => {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  });
}

function starImage(fill, stroke) {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.translate(size / 2, size / 2 + 2);
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 27 : 11.5;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  g.fillStyle = fill; g.fill();
  g.lineWidth = 3; g.lineJoin = 'round'; g.strokeStyle = stroke; g.stroke();
  return g.getImageData(0, 0, size, size);
}

// "UA" -> "Ukraine". Some embassies have no city in the map data, the country is what tells them apart.
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
function countryName(iso2) {
  try { return iso2 ? regionNames.of(iso2) : ''; } catch { return iso2 || ''; }
}

// A popup grows upward when the summary loads and can end up above the map edge. Nudge the map down.
function keepPopupInView(popup) {
  const pr = popup.getElement()?.getBoundingClientRect();
  if (!pr) return;
  const over = map.getContainer().getBoundingClientRect().top + 8 - pr.top;
  if (over > 0) map.panBy([0, -over], { duration: 300 });
}

const telHref = (n) => 'tel:' + String(n).replace(/[^\d+]/g, '');
const telLink = (n) => `<a href="${esc(telHref(n))}">${esc(n)}</a>`;

function incidentPopup(p) {
  const when = p.timestamp ? new Date(p.timestamp).toLocaleString() : '';
  return `<div class="pop-title">${esc(p.title)}</div>
    <div class="pop-meta">${esc(p.layer)} · ${esc(p.severity)} · ${esc(when)} ·
      <a href="${esc(safeUrl(p.source_url))}" target="_blank" rel="noopener noreferrer">source</a></div>
    ${p.layer === 'conflict' ? '' : `<div class="pop-note">${esc(p.summary)}</div>`}
    <div class="pop-brief pop-note">Loading summary...</div>`;
}

// A short, facts-only summary from /api/brief: how widely it was reported, the lead headline,
// what else is nearby, and the nearest operating embassy.
async function loadBrief(popup, id) {
  const put = (html) => {
    const box = popup.getElement()?.querySelector('.pop-brief');
    if (box && popup.sitrepId === id) { box.className = 'pop-brief'; box.innerHTML = html; keepPopupInView(popup); }
  };
  try {
    const res = await fetch('/api/brief?id=' + encodeURIComponent(id));
    if (!res.ok) throw new Error(res.status);
    const b = await res.json();
    const lead = b.headline
      ? `<div class="pop-lead">Lead coverage: <a href="${esc(safeUrl(b.headline.url))}" target="_blank" rel="noopener noreferrer">${esc(b.headline.title)}</a>
           <span class="pop-meta">${esc(b.headline.domain)}</span></div>` : '';
    const lines = [...b.lines];
    // Slot the embassy in before the closing caveat.
    const emb = b.embassy
      ? `Nearest operating US embassy: ${b.embassy.title}${b.embassy.iso2 ? ', ' + countryName(b.embassy.iso2) : ''}, ${b.embassy.km.toLocaleString()} km straight-line.`
      : 'No operating US embassy in the data.';
    lines.splice(lines.length - 1, 0, emb);
    put(`<div class="pop-sub">Situation</div>${lead}<ul class="pop-lines">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`);
  } catch (err) {
    put('<div class="pop-note">Summary unavailable.</div>');
  }
}

const STATUS_TEXT = {
  active: 'Listed as operating (not checked live)',
  suspended: 'Operations suspended',
  check: 'Status unclear, confirm with the State Department',
};

function embassyPopup(p) {
  const phones = Array.isArray(p.phones) ? p.phones : [];
  const site = p.website
    ? `<a href="${esc(safeUrl(p.website))}" target="_blank" rel="noopener noreferrer">embassy website</a>` : '';
  return `<div class="pop-title">★ ${esc(p.title)}</div>
    <div class="pop-meta ${p.status === 'active' ? '' : 'pop-warn'}">${esc(countryName(p.iso2))}${p.iso2 ? ' · ' : ''}${esc(STATUS_TEXT[p.status] || p.status)}</div>
    ${p.status_note ? `<div class="pop-note">${esc(p.status_note)}</div>` : ''}
    <div class="pop-row"><b>Address</b> ${p.address ? esc(p.address) : 'not in the map data'}</div>
    <div class="pop-row"><b>Phone</b> ${phones.length ? phones.map(telLink).join(', ') : 'not in the map data'}${site ? ' · ' + site : ''}</div>
    <div class="pop-row"><b>State Dept, 24/7</b> ${telLink(OCS_ABROAD)} from abroad, ${telLink(OCS_US)} from the US or Canada</div>
    <div class="pop-note">Details come from OpenStreetMap and are not checked live. Confirm on the embassy website or travel.state.gov before you rely on them.</div>`;
}

function applyLayerFilter() {
  const notHidden = state.hidden.size ? [['!', ['in', ['get', 'layer'], ['literal', [...state.hidden]]]]] : [];
  const isEmbassy = ['==', ['get', 'layer'], 'embassy'];
  const setFilter = (id, ...parts) => map.getLayer(id) && map.setFilter(id, ['all', ...parts, ...notHidden]);
  setFilter('sitrep-glow', ['!', isEmbassy]);
  setFilter('sitrep-dot', ['!', isEmbassy]);
  setFilter('sitrep-embassy', isEmbassy);
}

function renderLayers() {
  const box = el('layers');
  box.innerHTML = '';
  [...state.layers].sort().forEach((layer) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !state.hidden.has(layer);
    cb.addEventListener('change', () => {
      cb.checked ? state.hidden.delete(layer) : state.hidden.add(layer);
      applyLayerFilter();
      refreshSidebar();
    });
    label.append(cb, ' ', LAYER_LABELS[layer] || layer);
    box.append(label);
  });
}

async function loadFeatures() {
  try {
    const res = await fetch('/api/features');
    const data = await res.json();
    state.features = data.features;
    state.byId = new Map(data.features.map((f) => [f.properties.id, f]));
    state.layers = new Set(state.features.map((f) => f.properties.layer));
    renderLayers();
    map.getSource('sitrep')?.setData(data);
    refreshSidebar();
  } catch (err) {
    console.error('feature load failed', err);
  }
}

// The sidebar lists what is inside the current map window.
function viewBox() {
  const b = map.getBounds();
  let west = b.getWest(), east = b.getEast();
  if (east - west >= 360) return { west: -180, east: 180, south: -90, north: 90 };
  const wrap = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
  west = wrap(west); east = wrap(east);
  return { west, east, south: Math.max(-90, b.getSouth()), north: Math.min(90, b.getNorth()) };
}

let sideTimer;
function refreshSidebar() {
  clearTimeout(sideTimer);
  sideTimer = setTimeout(async () => {
    refreshNearest();
    const q = new URLSearchParams({ ...viewBox(), limit: 100 });
    const res = await fetch('/api/headlines?' + q);
    const data = await res.json();
    const items = data.items.filter((i) => !state.hidden.has(i.layer));
    el('side-meta').textContent = `${items.length} in view`;
    const ul = el('headlines');
    ul.innerHTML = items.length ? '' : '<li class="empty">Nothing reported in this area.</li>';
    items.forEach((i) => {
      const li = document.createElement('li');
      li.className = i.severity;
      const when = i.timestamp ? new Date(i.timestamp).toLocaleString() : '';
      li.innerHTML = `<div class="h-title">${esc(i.title)}</div>
        <div class="h-meta">${esc(i.layer)} · ${esc(i.severity)} · ${esc(when)} ·
        <a href="${esc(safeUrl(i.source_url))}" target="_blank" rel="noopener noreferrer">source</a></div>`;
      li.addEventListener('click', (e) => {
        if (e.target.tagName === 'A' || !i._geo) return;
        map.flyTo({ center: i._geo.coordinates, zoom: Math.max(map.getZoom(), 6), duration: 1200 });
      });
      ul.append(li);
    });
  }, 250);
}

// The closest operating US embassy to the middle of the map. Straight-line distance, not a route.
async function refreshNearest() {
  const box = el('nearest');
  try {
    const c = map.getCenter();
    const res = await fetch(`/api/nearest-embassy?lat=${c.lat}&lon=${c.lng}`);
    const hit = (await res.json()).items[0];
    if (!hit) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<div class="n-label">★ Nearest operating US embassy</div>
      <div class="n-name">${esc(hit.title)}</div>
      <div class="n-meta">${esc(hit.km.toLocaleString())} km straight-line from the middle of the map${hit.iso2 ? ' · ' + esc(countryName(hit.iso2)) : ''}</div>`;
    box.onclick = () => map.flyTo({ center: [hit.lon, hit.lat], zoom: 11, duration: 1400 });
  } catch (err) {
    box.hidden = true;
  }
}

// Search goes through our backend, which proxies the geocoder.
el('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = el('search').value.trim();
  if (!q) return;
  const res = await fetch('/api/geocode?q=' + encodeURIComponent(q));
  const hit = await res.json();
  if (hit.lat == null) {
    el('side-meta').textContent = `No match for "${q}".`;
    return;
  }
  const [w, s, ea, n] = hit.bbox;
  // A point-sized box (an address, a building) has nothing to fit, so pick a street-level zoom.
  if (ea - w < 0.002 && n - s < 0.002) map.flyTo({ center: [hit.lon, hit.lat], zoom: 14, duration: 1500 });
  else map.fitBounds([[w, s], [ea, n]], { padding: 60, maxZoom: 12, duration: 1500 });
});

map.on('style.load', () => {
  map.setProjection({ type: 'globe' });
  tintWater();
  addBoundaries();
  addCounties();
  addFeatureLayers();
  loadFeatures();
});
map.on('moveend', refreshSidebar);
map.on('error', (e) => console.error('map error', e.error?.message || e));

setInterval(loadFeatures, 5 * 60 * 1000);
