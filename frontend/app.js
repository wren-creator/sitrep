const LAYER_LABELS = { disaster: 'Disasters', conflict: 'Unrest', aviation: 'Flights', health: 'Health' };
const SEV_COLOR = { low: '#4aa3ff', medium: '#f2c14e', high: '#ff8a3d', critical: '#ff4d4d' };
const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';

const state = { features: [], layers: new Set(), hidden: new Set() };
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
  applyLayerFilter();

  const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '300px', offset: 10 });
  map.on('click', 'sitrep-dot', (e) => {
    const f = e.features[0];
    const p = f.properties;
    const when = p.timestamp ? new Date(p.timestamp).toLocaleString() : '';
    popup.setLngLat(f.geometry.coordinates).setHTML(
      `<div class="pop-title">${esc(p.title)}</div>
       <div class="pop-meta">${esc(p.layer)} · ${esc(p.severity)} · ${esc(when)} ·
         <a href="${esc(safeUrl(p.source_url))}" target="_blank" rel="noopener noreferrer">source</a></div>
       <div class="pop-note">${esc(p.summary)}</div>`).addTo(map);
  });
  map.on('mouseenter', 'sitrep-dot', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'sitrep-dot', () => { map.getCanvas().style.cursor = ''; });
}

function applyLayerFilter() {
  const hidden = [...state.hidden];
  const filter = hidden.length ? ['!', ['in', ['get', 'layer'], ['literal', hidden]]] : null;
  ['sitrep-glow', 'sitrep-dot'].forEach((id) => map.getLayer(id) && map.setFilter(id, filter));
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
  addBoundaries();
  addCounties();
  addFeatureLayers();
  loadFeatures();
});
map.on('moveend', refreshSidebar);
map.on('error', (e) => console.error('map error', e.error?.message || e));

setInterval(loadFeatures, 5 * 60 * 1000);
