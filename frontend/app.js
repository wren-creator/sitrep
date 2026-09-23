const LAYER_LABELS = { disaster: 'Disasters', unrest: 'Unrest', conflict: 'Conflict', aviation: 'Flights', health: 'Health', embassy: '★ US embassies', advisory: 'Advisories' };
const SEV_COLOR = { low: '#4aa3ff', medium: '#f2c14e', high: '#ff8a3d', critical: '#ff4d4d' };
const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';

const state = { features: [], byId: new Map(), layers: new Set(), hidden: new Set(), advisories: {} };

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
const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '320px', offset: 10, focusAfterOpen: false });

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

// State Department advisories. Countries at Level 3 and 4 are tinted (lower levels stay clear, so the map is not
// a wall of colour) and clicking any country opens its advisory. Polygons are Natural Earth's, vendored
// by scripts/build_country_data.py, so they are a little coarser than the basemap borders.
// Level 4 is a solid red tint. Level 3 is orange hatching like caution tape, because any translucent orange
// on dark land turns to brown mud. Level 2 is deliberately not drawn, it covers 80-odd countries (France,
// Mexico) and it still shows in each country's card.
const LEVEL_FILL = { 4: 'rgba(255,77,77,0.34)' };
const ADV_LAYERS = ['sitrep-advisory-fill', 'sitrep-advisory-hatch'];

function hatchImage() {
  const n = 16, c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(255,150,40,0.85)';
  g.lineWidth = 2.5;
  g.beginPath();  // three diagonals so the stripes tile with no seams
  for (const o of [-n, 0, n]) { g.moveTo(o, n); g.lineTo(o + n, 0); }
  g.stroke();
  return g.getImageData(0, 0, n, n);
}
const LEVEL_NAME = { 1: 'Exercise normal precautions', 2: 'Exercise increased caution', 3: 'Reconsider travel', 4: 'Do not travel' };

function advisoryColorExpr() {
  const stops = [];
  for (const [iso2, a] of Object.entries(state.advisories)) {
    if (LEVEL_FILL[a.level]) stops.push(iso2, LEVEL_FILL[a.level]);
  }
  return stops.length ? ['match', ['get', 'iso2'], ...stops, 'rgba(0,0,0,0)'] : 'rgba(0,0,0,0)';
}

async function loadAdvisories() {
  try {
    const data = await (await fetch('/api/advisories')).json();
    state.advisories = data.items || {};
    if (map.getLayer('sitrep-advisory-fill')) map.setPaintProperty('sitrep-advisory-fill', 'fill-color', advisoryColorExpr());
    if (map.getLayer('sitrep-advisory-hatch')) {
      const level3 = Object.entries(state.advisories).filter(([, a]) => a.level === 3).map(([iso2]) => iso2);
      map.setFilter('sitrep-advisory-hatch', ['in', ['get', 'iso2'], ['literal', level3]]);
    }
    refreshAdvisoryCard();
  } catch (err) {
    console.error('advisory load failed', err);
  }
}

async function addAdvisoryLayer() {
  try {
    const data = await (await fetch('vendor/countries.geojson')).json();
    map.addSource('sitrep-countries', { type: 'geojson', data });
    map.addLayer({
      id: 'sitrep-advisory-fill', type: 'fill', source: 'sitrep-countries',
      paint: {
        'fill-color': advisoryColorExpr(),
        // Natural Earth is coarser than the basemap, fade the tint out as you zoom in so mismatch never shows.
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 1, 9, 0.25],
      },
    }, map.getLayer('sitrep-state') ? 'sitrep-state' : undefined);
    map.addImage('hatch-l3', hatchImage(), { pixelRatio: 2 });
    map.addLayer({
      id: 'sitrep-advisory-hatch', type: 'fill', source: 'sitrep-countries',
      filter: ['in', ['get', 'iso2'], ['literal', []]],
      paint: { 'fill-pattern': 'hatch-l3', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 1, 9, 0.25] },
    }, map.getLayer('sitrep-state') ? 'sitrep-state' : undefined);
    // A marker or embassy under the click wins, the country card is for the ground between them.
    map.on('click', (e) => {
      if (state.hidden.has('advisory')) return;
      if (map.queryRenderedFeatures(e.point, { layers: ['sitrep-dot', 'sitrep-embassy'] }).length) return;
      const hit = map.queryRenderedFeatures(e.point, { layers: ADV_LAYERS })[0];
      const a = hit && state.advisories[hit.properties.iso2];
      if (!a) return;
      popup.setLngLat(e.lngLat).setHTML(advisoryPopup(a)).addTo(map);
      wireTravel(popup);
      popup.sitrepId = a.id;
      keepPopupInView(popup);
    });
    if (state.hidden.has('advisory')) ADV_LAYERS.forEach((id) => map.setLayoutProperty(id, 'visibility', 'none'));
    loadAdvisories();  // now the hatch layer exists, apply the Level 3 list
  } catch (err) {
    console.error('country polygons failed to load', err);
  }
}

// The banner is the point: Level 3 and 4 must not be missed. Levels 1 and 2 stay quiet.
function advisoryBanner(a) {
  const loud = a.level >= 3;
  return `<div class="adv-banner adv-${a.level}">${loud ? '⚠ ' : ''}${esc(LEVEL_NAME[a.level].toUpperCase())} · LEVEL ${a.level}</div>`;
}

// Vaccines, health notices and entry rules for a country. Fetched when you ask, the server caches it.
const ENTRY_LABEL = {
  visa_free: 'ok', on_arrival: 'maybe', electronic: 'maybe', on_arrival_or_electronic: 'maybe',
  visa_required: 'warn', permit: 'bad', restricted: 'bad', other: 'plain',
};
const STANCE_LABEL = {
  recommended: 'Recommended', consider: 'Consider', varies: 'Depends on your trip',
  not_recommended: 'Not recommended', routine: 'Routine', info: 'Read CDC text',
};
const STANCE_ORDER = ['recommended', 'varies', 'consider', 'info', 'routine', 'not_recommended'];

function renderTravel(t) {
  const when = (ts) => (ts ? new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
  let html = '';

  const e = t.entry;
  html += '<div class="pop-sub">Entry for US citizens</div>';
  if (e.ok) {
    html += `<div class="entry entry-${ENTRY_LABEL[e.category] || 'plain'}"><b>${esc(e.requirement)}</b>${e.allowed_stay ? ' · ' + esc(e.allowed_stay) : ''}</div>
      ${e.notes ? `<div class="pop-note">${esc(e.notes)}</div>` : ''}
      <div class="pop-note">Passport validity rules vary, often six months beyond your stay, and this table rarely says. Confirm with the destination's embassy.
        Source: <a href="${esc(safeUrl(e.source_url))}" target="_blank" rel="noopener noreferrer">Wikipedia</a> (${esc(e.license)}), revision ${esc(e.revid)}.</div>`;
  } else {
    html += `<div class="pop-note stale">Entry rules unavailable: ${esc(e.error)}</div>`;
  }

  const h = t.health;
  html += '<div class="pop-sub">Health (CDC)</div>';
  if (!h.ok) return html + `<div class="pop-note stale">Health information unavailable: ${esc(h.error)}</div>`;

  if (h.yellow_fever) {
    html += `<div class="yf"><b>Yellow fever</b>
      <div><span>CDC</span> ${esc(h.yellow_fever.cdc)}</div>
      <div><span>Entry requirement</span> ${esc(h.yellow_fever.entry)}</div></div>`;
  }
  for (const n of h.notices || []) {
    html += `<div class="hnotice hn-${n.level}"><a href="${esc(safeUrl(n.url))}" target="_blank" rel="noopener noreferrer">Level ${n.level}: ${esc(n.title)}</a>
      <span class="pop-meta">${esc(n.date)}</span></div>`;
  }
  const vaccines = [...h.vaccines].sort((a, b) => STANCE_ORDER.indexOf(a.stance) - STANCE_ORDER.indexOf(b.stance));
  html += '<div class="vax">' + vaccines.map((v) => `<details class="vax-${v.stance}">
      <summary>${esc(v.name)} <span class="chip chip-${v.stance}">${esc(STANCE_LABEL[v.stance] || v.stance)}</span></summary>
      <div class="vax-text">${esc(v.text)}</div>
      ${v.url ? `<a href="${esc(safeUrl(v.url))}" target="_blank" rel="noopener noreferrer">CDC disease page</a>` : ''}
    </details>`).join('') + '</div>';
  html += `<div class="pop-note">The tags summarize the first line of the CDC's text, and conditions often apply, so open a vaccine to read all of it.
    See a doctor or travel clinic at least a month before you go. Source:
    <a href="${esc(safeUrl(h.source_url))}" target="_blank" rel="noopener noreferrer">CDC Travelers' Health</a>, fetched ${esc(when(h.fetched_at))}.</div>`;
  return html;
}

function travelSectionHtml(iso2) {
  return iso2 ? `<div class="pop-travel" data-iso="${esc(iso2)}"><button type="button" class="linkish">Vaccines and entry requirements</button></div>` : '';
}

// Attach the button in the open popup. The request is made only when it is clicked.
function wireTravel(popupObj) {
  const box = popupObj.getElement()?.querySelector('.pop-travel');
  if (!box) return;
  box.querySelector('button').addEventListener('click', async () => {
    const iso2 = box.dataset.iso;
    box.innerHTML = '<div class="pop-note">Loading, the first look-up for a country can take a few seconds...</div>';
    try {
      const res = await fetch('/api/travel-info?iso2=' + encodeURIComponent(iso2));
      if (!res.ok) throw new Error(res.status);
      box.innerHTML = renderTravel(await res.json());
    } catch (err) {
      box.innerHTML = '<div class="pop-note stale">Could not load this. Try again in a moment.</div>';
    }
    box.scrollIntoView({ block: 'start', behavior: 'smooth' });  // the section is far down a long popup
    keepPopupInView(popupObj);
  });
}

// The State Dept's own sentence about embassy staffing or suspension, quoted. We do not turn it into a status.
function embassyNoticeHtml(a) {
  if (!a || !a.embassy_notice) return '';
  // Say which advisory the sentence comes from. An old one may since have been replaced.
  const date = a.timestamp ? new Date(a.timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  return `<div class="pop-note notice"><b>State Dept advisory${date ? ' of ' + esc(date) : ''} says</b> “${esc(a.embassy_notice)}”</div>`;
}

// If the live feed has been unreachable, say so. A stale advisory must not pass as current.
function staleNoticeHtml(a) {
  if (!a || !a.as_of) return '';
  const hours = (Date.now() - Date.parse(a.as_of)) / 3.6e6;
  if (!(hours > 12)) return '';
  const when = new Date(a.as_of).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `<div class="pop-note stale">The State Dept feed has been unreachable since ${esc(when)}. This may be out of date, check travel.state.gov.</div>`;
}

function advisoryPopup(a) {
  const date = a.timestamp ? new Date(a.timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  const chips = (a.reasons || []).map((r) => `<span class="chip">${esc(r)}</span>`).join('');
  const others = (a.entries || []).length > 1
    ? `<div class="pop-row"><b>Separate advisories</b> ${a.entries.map((e) =>
        `<a href="${esc(safeUrl(e.link))}" target="_blank" rel="noopener noreferrer">${esc(e.name)}</a>, Level ${e.level}`).join('; ')}</div>` : '';
  return `<div class="pop-title">${esc(a.country)}</div>
    ${advisoryBanner(a)}
    ${a.summary ? `<div class="pop-row">${esc(a.summary)}</div>` : ''}
    ${chips ? `<div class="chips">${chips}</div>` : ''}
    ${a.changes ? `<div class="pop-note"><b>Latest update</b> ${esc(a.changes.length > 300 ? a.changes.slice(0, 300).replace(/\s\S*$/, '') + '...' : a.changes)}</div>` : ''}
    ${a.excerpt ? `<div class="pop-note">${esc(a.excerpt)}</div>` : ''}
    ${others}
    ${embassyNoticeHtml(a)}
    ${staleNoticeHtml(a)}
    ${travelSectionHtml(a.iso2)}
    <div class="pop-note">US State Department${date ? ', updated ' + esc(date) : ''} ·
      <a href="${esc(safeUrl(a.source_url))}" target="_blank" rel="noopener noreferrer">read the full advisory</a></div>`;
}

// Sidebar card for the country under the middle of the map.
function refreshAdvisoryCard() {
  const box = el('advisory');
  if (!box || !map.getLayer('sitrep-advisory-fill') || state.hidden.has('advisory')) { if (box) box.hidden = true; return; }
  const c = map.getContainer();
  const hit = map.queryRenderedFeatures([c.clientWidth / 2, c.clientHeight / 2], { layers: ADV_LAYERS })[0];
  const a = hit && state.advisories[hit.properties.iso2];
  if (!a) { box.hidden = true; return; }
  box.hidden = false;
  box.className = `adv-card adv-card-${a.level}`;
  box.innerHTML = `<div class="n-label">State Dept advisory</div>
    <div class="n-name">${esc(a.country)}</div>
    ${advisoryBanner(a)}`;
  box.onclick = () => {
    popup.setLngLat(map.getCenter()).setHTML(advisoryPopup(a)).addTo(map);
    wireTravel(popup);
    popup.sitrepId = a.id;
    keepPopupInView(popup);
  };
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
    wireTravel(popup);
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

// A popup grows when its content loads and can run off the top or bottom of the map. Nudge the map so
// the whole popup is on screen, without pushing the top edge out to fix the bottom.
function keepPopupInView(popup) {
  const pr = popup.getElement()?.getBoundingClientRect();
  if (!pr) return;
  const mr = map.getContainer().getBoundingClientRect();
  const top = mr.top + 8, bottom = mr.bottom - 8;
  if (pr.top < top) {
    map.panBy([0, -(top - pr.top)], { duration: 300 });                 // popup is above the edge, move it down
  } else if (pr.bottom > bottom) {
    map.panBy([0, Math.min(pr.bottom - bottom, pr.top - top)], { duration: 300 });  // below the edge, move it up
  }
}

const telHref = (n) => 'tel:' + String(n).replace(/[^\d+]/g, '');
const telLink = (n) => `<a href="${esc(telHref(n))}">${esc(n)}</a>`;

function incidentPopup(p) {
  const when = p.timestamp ? new Date(p.timestamp).toLocaleString() : '';
  return `<div class="pop-title">${esc(p.title)}</div>
    <div class="pop-meta">${esc(p.layer)} · ${esc(p.severity)} · ${esc(when)} ·
      <a href="${esc(safeUrl(p.source_url))}" target="_blank" rel="noopener noreferrer">source</a></div>
    ${['conflict', 'unrest'].includes(p.layer) ? '' : `<div class="pop-note">${esc(p.summary)}</div>`}
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
    ${state.advisories[p.iso2] ? `<div class="pop-row"><b>State Dept advisory</b>${advisoryBanner(state.advisories[p.iso2])}</div>${embassyNoticeHtml(state.advisories[p.iso2])}${staleNoticeHtml(state.advisories[p.iso2])}` : ''}
    <div class="pop-row"><b>Address</b> ${p.address ? esc(p.address) : 'not in the map data'}</div>
    <div class="pop-row"><b>Phone</b> ${phones.length ? phones.map(telLink).join(', ') : 'not in the map data'}${site ? ' · ' + site : ''}</div>
    <div class="pop-row"><b>State Dept, 24/7</b> ${telLink(OCS_ABROAD)} from abroad, ${telLink(OCS_US)} from the US or Canada</div>
    ${travelSectionHtml(p.iso2)}
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
  [...new Set([...state.layers, 'advisory'])].sort().forEach((layer) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !state.hidden.has(layer);
    cb.addEventListener('change', () => {
      cb.checked ? state.hidden.delete(layer) : state.hidden.add(layer);
      if (layer === 'advisory') {
        ADV_LAYERS.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', cb.checked ? 'visible' : 'none'));
      }
      applyLayerFilter();
      refreshAdvisoryCard();
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
    refreshAdvisoryCard();
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
  addAdvisoryLayer();
  loadAdvisories();
  addCounties();
  addFeatureLayers();
  loadFeatures();
});
map.on('moveend', refreshSidebar);
map.on('error', (e) => console.error('map error', e.error?.message || e));

setInterval(loadFeatures, 5 * 60 * 1000);
setInterval(loadAdvisories, 30 * 60 * 1000);
