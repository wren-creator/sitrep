const COLORS = { low: '#4aa3ff', medium: '#f2c14e', high: '#ff8a3d', critical: '#ff4d4d' };
const LAYER_LABELS = { disaster: 'Disasters', conflict: 'Unrest', aviation: 'Flights', health: 'Health' };

const state = { features: [], layers: new Set(), hidden: new Set() };
const el = (id) => document.getElementById(id);

const globe = Globe()(el('globe'))
  .globeImageUrl('https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-night.jpg')
  .backgroundColor('#0b0f14')
  .pointLat((d) => d.geometry.coordinates[1])
  .pointLng((d) => d.geometry.coordinates[0])
  .pointColor((d) => COLORS[d.properties.severity] || COLORS.low)
  .pointAltitude((d) => ({ low: 0.01, medium: 0.03, high: 0.06, critical: 0.1 }[d.properties.severity] || 0.01))
  .pointRadius((d) => (d.properties.severity === 'critical' ? 0.5 : 0.3))
  .pointLabel((d) => `<b>${esc(d.properties.title)}</b><br>${esc(d.properties.severity)}`)
  .onPointClick((d) => flyTo(d.geometry.coordinates[1], d.geometry.coordinates[0], 1.2));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function resize() {
  const box = el('globe');
  globe.width(box.clientWidth).height(box.clientHeight);
}
new ResizeObserver(resize).observe(el('globe'));
resize();
globe.pointOfView({ lat: 20, lng: -30, altitude: 1.9 });

function flyTo(lat, lng, altitude = 1.5) {
  globe.pointOfView({ lat, lng, altitude }, 1200);
}

function visibleFeatures() {
  return state.features.filter((f) => f.geometry && !state.hidden.has(f.properties.layer));
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
      globe.pointsData(visibleFeatures());
      refreshSidebar();
    });
    label.append(cb, ' ', LAYER_LABELS[layer] || layer);
    box.append(label);
  });
}

async function loadFeatures() {
  const res = await fetch('/api/features');
  const data = await res.json();
  state.features = data.features;
  state.layers = new Set(state.features.map((f) => f.properties.layer));
  renderLayers();
  globe.pointsData(visibleFeatures());
  refreshSidebar();
}

// Sidebar: headlines inside the visible box, filtered by active layers.
let sideTimer;
function refreshSidebar() {
  clearTimeout(sideTimer);
  sideTimer = setTimeout(async () => {
    const pov = globe.pointOfView();
    // Rough visible span from altitude: closer in means a smaller box.
    const span = Math.min(180, 30 + pov.altitude * 45);
    const south = Math.max(-90, pov.lat - span / 2);
    const north = Math.min(90, pov.lat + span / 2);
    let west = pov.lng - span, east = pov.lng + span;
    const wrap = (x) => ((x + 540) % 360) - 180;
    west = wrap(west); east = wrap(east);
    const q = new URLSearchParams({ west, south, east, north, limit: 100 });
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
        <a href="${esc(i.source_url)}" target="_blank" rel="noopener noreferrer">source</a></div>`;
      li.addEventListener('click', (e) => {
        if (e.target.tagName === 'A' || !i._geo) return;
        flyTo(i._geo.coordinates[1], i._geo.coordinates[0], 0.8);
      });
      ul.append(li);
    });
  }, 250);
}

globe.onZoom(refreshSidebar);

// Search goes through our backend, which proxies the geocoder.
el('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = el('search').value.trim();
  if (!q) return;
  const res = await fetch('/api/geocode?q=' + encodeURIComponent(q));
  const hit = await res.json();
  if (hit.lat != null) flyTo(hit.lat, hit.lon, hit.altitude ?? 0.9);
  else el('side-meta').textContent = `No match for "${q}".`;
});

loadFeatures();
setInterval(loadFeatures, 5 * 60 * 1000);
