const LAYER_LABELS = { disaster: 'Disasters', unrest: 'Unrest', conflict: 'Conflict', aviation: 'Flights', health: 'Health', embassy: '★ US embassies', advisory: 'Advisories', lgbt: 'LGBT+ index', airspace: '✈ Airspace', aircraft: '✈ Aircraft (live)', military: 'Military aircraft', weather: '🌀 Weather' };
const SEV_COLOR = { low: '#4aa3ff', medium: '#f2c14e', high: '#ff8a3d', critical: '#ff4d4d' };
const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';

const state = { features: [], byId: new Map(), layers: new Set(), hidden: new Set(['lgbt', 'aircraft', 'military']), advisories: {}, lgbtIndex: null, airspace: { items: [], byIso: {} } };

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
    addLgbtLayer();
    addAirspaceLayers();
    loadAirspace().then(() => setAirspaceVisible(!state.hidden.has('airspace')));
    map.on('click', (e) => {
      if (markerUnder(e.point)) return;
      if (!state.hidden.has('lgbt')) {  // the index layer is on, a click opens its country
        const lg = map.queryRenderedFeatures(e.point, { layers: ['sitrep-lgbt-fill'] })[0];
        if (lg && lg.properties.iso2) {
          popup.setLngLat(e.lngLat).setHTML(`<div class="pop-title">${esc(countryName(lg.properties.iso2) || lg.properties.name)}</div>` +
            `<div class="pop-lgbt" data-iso="${esc(lg.properties.iso2)}"></div>`).addTo(map);
          wireTravel(popup);
          popup.getElement().querySelector('.pop-lgbt').loadNow?.();
          popup.sitrepId = 'lgbt:' + lg.properties.iso2;
        }
        return;
      }
      if (state.hidden.has('advisory')) return;
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

// EASA airspace bulletins (conflict zone information bulletins): the European regulator telling airlines that
// the airspace over somewhere is dangerous for civil aircraft, and what to do about it. Outlines, not fills,
// because the country already carries an advisory tint. A signal about risk to aircraft, not a prediction, and
// not a measure of risk on the ground. Recently issued or revised bulletins are the ones worth a second look.
const AIR_COLOR = { do_not_operate: '#e040fb', caution: '#7dd3fc' };
const AIR_LABEL = { do_not_operate: 'DO NOT OPERATE', caution: 'CAUTION' };
const AIR_LAYERS = ['sitrep-airspace-line', 'sitrep-airspace-partial'];

function airspaceStyle() {
  // Per country, the worst kind wins. Whole-country and part-country bulletins are drawn differently.
  const worst = { full: {}, part: {} };
  for (const b of state.airspace.items) {
    for (const iso2 of b.countries) {
      const bucket = b.partial ? worst.part : worst.full;
      if (bucket[iso2] !== 'do_not_operate') bucket[iso2] = b.kind;
    }
  }
  const colorExpr = (bucket) => {
    const stops = Object.entries(bucket).flatMap(([iso2, kind]) => [iso2, AIR_COLOR[kind]]);
    return stops.length ? ['match', ['get', 'iso2'], ...stops, 'rgba(0,0,0,0)'] : 'rgba(0,0,0,0)';
  };
  return { full: worst.full, part: worst.part, fullColor: colorExpr(worst.full), partColor: colorExpr(worst.part) };
}

function applyAirspace() {
  if (!map.getLayer('sitrep-airspace-line')) return;
  const st = airspaceStyle();
  map.setFilter('sitrep-airspace-line', ['in', ['get', 'iso2'], ['literal', Object.keys(st.full)]]);
  map.setFilter('sitrep-airspace-partial', ['in', ['get', 'iso2'], ['literal', Object.keys(st.part)]]);
  map.setPaintProperty('sitrep-airspace-line', 'line-color', st.fullColor);
  map.setPaintProperty('sitrep-airspace-partial', 'line-color', st.partColor);
}

function addAirspaceLayers() {
  const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  const fade = ['interpolate', ['linear'], ['zoom'], 6, 1, 10, 0.15];  // Natural Earth shapes are coarse up close
  map.addLayer({ id: 'sitrep-airspace-line', type: 'line', source: 'sitrep-countries',
    filter: ['in', ['get', 'iso2'], ['literal', []]],
    layout: { 'line-join': 'round', visibility: state.hidden.has('airspace') ? 'none' : 'visible' },
    paint: { 'line-color': 'rgba(0,0,0,0)', 'line-opacity': fade, 'line-dasharray': [2, 1.2],
      'line-width': ['interpolate', ['linear'], ['zoom'], 1, 1.6, 6, 3.4] } }, before);
  map.addLayer({ id: 'sitrep-airspace-partial', type: 'line', source: 'sitrep-countries',
    filter: ['in', ['get', 'iso2'], ['literal', []]],
    layout: { 'line-join': 'round', visibility: state.hidden.has('airspace') ? 'none' : 'visible' },
    paint: { 'line-color': 'rgba(0,0,0,0)', 'line-opacity': fade, 'line-dasharray': [0.6, 1.8],
      'line-width': ['interpolate', ['linear'], ['zoom'], 1, 1, 6, 2] } }, before);
  applyAirspace();
}

async function loadAirspace() {
  try {
    const data = await (await fetch('/api/airspace')).json();
    state.airspace.items = data.items || [];
    state.airspace.byIso = {};
    for (const b of state.airspace.items) for (const iso2 of b.countries) (state.airspace.byIso[iso2] ||= []).push(b);
    applyAirspace();
    refreshAdvisoryCard();
  } catch (err) {
    console.error('airspace load failed', err);
  }
}

function setAirspaceVisible(on) {
  AIR_LAYERS.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));
  const box = el('legend-air');
  box.hidden = !on || !state.airspace.items.length;
  if (!box.hidden) {
    box.innerHTML = `<div class="lg-legend-title">✈ EASA airspace bulletins</div>
      <div class="air-key"><span style="border-color:${AIR_COLOR.do_not_operate}"></span>Airlines advised not to operate</div>
      <div class="air-key"><span style="border-color:${AIR_COLOR.caution}"></span>Caution advised</div>
      <div class="air-key"><span class="dotted" style="border-color:${AIR_COLOR.do_not_operate}"></span>Part of a country only</div>
      <div class="lg-legend-note">Risk to aircraft, not a prediction and not a measure of risk on the ground. Click a country, and look for NEW or REVISED. Source: <a href="https://www.easa.europa.eu/en/domains/air-operations/czibs" target="_blank" rel="noopener noreferrer">EASA</a>.</div>`;
  }
}

const daysAgo = (d) => (d ? Math.floor((Date.now() - Date.parse(d)) / 864e5) : null);
const fmtDay = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

// NEW when issued within 30 days, REVISED when revised within 30 days. Those are the ones that may mean something changed.
function airTag(b) {
  const issued = daysAgo(b.issued), revised = daysAgo(b.revised);
  if (issued != null && issued <= 30) return '<span class="air-tag">NEW</span>';
  if (revised != null && revised <= 30) return `<span class="air-tag">REVISED ${revised === 0 ? 'TODAY' : revised + ' DAYS AGO'}</span>`;
  return '';
}

function airspaceHtml(iso2) {
  return airspaceBlock(state.airspace.byIso[iso2] || []);
}

// Also used by the trip view, which already has the bulletins for a stop.
function airspaceBlock(bulletins) {
  return bulletins.map((b) => {
    const clip = (r, n) => (r.length > n ? r.slice(0, n - 3) + '...' : r);
    const first = b.recommendations.slice(0, 2).map((r) => `<div class="air-rec">“${esc(clip(r, 320))}”</div>`).join('');
    const rest = b.recommendations.slice(2).map((r) => `<div class="air-rec">“${esc(r)}”</div>`).join('');
    const more = `<details class="air-more"><summary>Full bulletin text</summary>
      ${b.revision_description ? `<div class="pop-note"><b>Latest revision</b> ${esc(b.revision_description)}</div>` : ''}
      <div class="air-desc">${esc(b.description)}</div>${rest}
      ${b.airspace.length ? `<div class="pop-note"><b>Affected airspace</b> ${esc(b.airspace.join(' '))}</div>` : ''}</details>`;
    const hist = b.history.length ? `<details class="air-more"><summary>Earlier bulletins (${b.history.length})</summary>` +
      b.history.map((h) => `<div class="air-hist"><a href="${esc(safeUrl(h.url))}" target="_blank" rel="noopener noreferrer">${esc(h.title)} ${esc(h.number)}</a>
        <span class="pop-meta">issued ${esc(fmtDay(h.issued))}${h.until ? ', valid until ' + esc(fmtDay(h.until)) : ''}, withdrawn</span></div>`).join('') + '</details>' : '';
    return `<div class="airspace air-${b.kind}">
      <div class="air-head">✈ EASA AIRSPACE · ${AIR_LABEL[b.kind]} ${airTag(b)}</div>
      <div class="pop-row">${esc(b.subject)}${b.partial && b.scope ? ` <span class="pop-meta">(part of the country: ${esc(b.scope)})</span>` : ''}</div>
      ${first}${more}${hist}
      <div class="pop-meta">${esc(b.number)} · issued ${esc(fmtDay(b.issued))} · revised ${esc(fmtDay(b.revised))} · valid until ${esc(fmtDay(b.valid_until))} ·
        <a href="${esc(safeUrl(b.source_url))}" target="_blank" rel="noopener noreferrer">EASA</a></div>
      ${staleNoticeHtml(b, 'EASA')}</div>`;
  }).join('');
}

function airspaceCardHtml(iso2) {
  return (state.airspace.byIso[iso2] || []).map((b) =>
    `<div class="air-card air-${b.kind}">✈ Airspace: ${AIR_LABEL[b.kind].toLowerCase()} (EASA)${b.partial ? ', part' : ''} ${airTag(b)}</div>`).join('');
}

// LGBT+ index layer: Equaldex Equality Index, laws and public attitudes. Off by default. It is a country
// tint like the advisories, so turning it on hides them and the other way round, two competing tints
// would be unreadable. Current values only, Equaldex's terms ask that scores are not compared over time.
const LGBT_BANDS = [[20, 'rgba(220,60,50,0.52)'], [40, 'rgba(235,130,40,0.5)'], [60, 'rgba(240,200,60,0.42)'],
  [80, 'rgba(120,180,90,0.46)'], [101, 'rgba(50,190,110,0.52)']];

function lgbtColorExpr() {
  const rows = state.lgbtIndex?.rows;
  if (!rows) return 'rgba(0,0,0,0)';
  const stops = [];
  for (const [iso2, r] of Object.entries(rows)) stops.push(iso2, LGBT_BANDS.find(([max]) => r.index < max)[1]);
  return ['match', ['get', 'iso2'], ...stops, 'rgba(0,0,0,0)'];
}

function addLgbtLayer() {
  map.addLayer({
    id: 'sitrep-lgbt-fill', type: 'fill', source: 'sitrep-countries', layout: { visibility: 'none' },
    paint: { 'fill-color': lgbtColorExpr(), 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 1, 9, 0.3] },
  }, map.getLayer('sitrep-state') ? 'sitrep-state' : undefined);
}

function lgbtLegendHtml() {
  const names = ['0-19', '20-39', '40-59', '60-79', '80-100'];
  return `<div class="lg-legend-title">LGBT+ Equality Index</div>
    <div class="lg-legend-bar">${LGBT_BANDS.map(([, c], i) => `<span style="background:${c.replace(/0\.\d+\)/, '0.9)')}">${names[i]}</span>`).join('')}</div>
    <div class="lg-legend-note">Laws and public attitudes, current values. Not a safety score, and it does not show risk on the street.
      Data: <a href="https://www.equaldex.com/equality-index" target="_blank" rel="noopener noreferrer">Equaldex</a>. Click a country for detail.</div>`;
}

async function setLgbtVisible(on) {
  const box = el('legend');
  if (on && !state.lgbtIndex) {
    try {
      state.lgbtIndex = await (await fetch('/api/lgbt-index')).json();
      if (map.getLayer('sitrep-lgbt-fill')) map.setPaintProperty('sitrep-lgbt-fill', 'fill-color', lgbtColorExpr());
    } catch (err) {
      console.error('LGBT+ index failed to load', err);
      box.hidden = false;
      box.innerHTML = '<div class="lg-legend-note">The Equaldex index could not be loaded right now. Try again in a moment.</div>';
      return;
    }
  }
  if (map.getLayer('sitrep-lgbt-fill')) map.setLayoutProperty('sitrep-lgbt-fill', 'visibility', on ? 'visible' : 'none');
  box.hidden = !on;
  if (on) box.innerHTML = lgbtLegendHtml();
}

function setAdvisoryVisible(on) {
  ADV_LAYERS.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));
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

// LGBT+ information. Three sources side by side, deliberately not merged into one made-up score.
function scoreBar(label, value) {
  if (value == null) return `<div class="lg-row"><span>${esc(label)}</span><i class="lg-none">no data</i></div>`;
  const tone = value < 34 ? 'low' : value < 67 ? 'mid' : 'high';
  return `<div class="lg-row"><span>${esc(label)}</span><div class="lg-bar"><div class="lg-fill lg-${tone}" style="width:${value}%"></div></div><b>${value}</b></div>`;
}

function renderLgbt(d) {
  let html = '<div class="pop-sub">LGBT+ (three sources, not a safety score)</div>';
  const e = d.equaldex;
  if (e.ok) {
    html += `<div class="lg-box"><div class="lg-title">Equaldex Equality Index <b>${e.index}</b><small>/100</small></div>
      ${scoreBar('Laws', e.legal)}${scoreBar('Public attitudes', e.opinion)}
      <div class="pop-meta">Rank ${e.rank} of ${e.of}${e.opinion == null ? ' · no public opinion data for this country, the score is laws only' : ''}</div>
      <div class="pop-meta">Data: <a href="${esc(safeUrl(e.source_url))}" target="_blank" rel="noopener noreferrer">Equaldex</a>. Current values, not a trend.</div></div>`;
  } else {
    html += `<div class="pop-note stale">Equaldex index unavailable: ${esc(e.error)}</div>`;
  }

  const t = d.trans_legal;
  if (t.ok) {
    html += `<div class="pop-row"><b>Legal gender change</b><span class="chip">${esc(t.status)}</span></div>
      <div class="pop-note">From Wikipedia's <a href="${esc(safeUrl(t.source_url))}" target="_blank" rel="noopener noreferrer">legal status of transgender people</a>
        (${esc(t.license)}, revision ${esc(t.revid)}), partly from the Spartacus Gay Travel Index. It is about whether a person can change legal gender.
        It does not say whether living or dressing as your gender is tolerated or safe on the street.</div>`;
  } else {
    html += `<div class="pop-note stale">Legal gender change unavailable: ${esc(t.error)}</div>`;
  }

  const f = d.fcdo;
  if (f.ok) {
    const upd = f.updated ? new Date(f.updated).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
    if (f.paragraphs.length) {
      html += `<div class="pop-sub">UK Foreign Office advice for LGBT+ travellers</div><div class="fcdo">` +
        f.paragraphs.map((p) => (p.kind === 'li' ? `<div class="fc-li">• ${esc(p.text)}</div>` : `<p>${esc(p.text)}</p>`)).join('') +
        `</div><div class="pop-note">Quoted from the <a href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener noreferrer">UK FCDO travel advice</a>${upd ? ', updated ' + esc(upd) : ''}. It is written for UK travellers. Open Government Licence.</div>`;
    } else {
      html += `<div class="pop-note">The UK FCDO has no dedicated LGBT+ section for this country${upd ? ' (advice updated ' + esc(upd) + ')' : ''}. That is not a statement that nothing applies, read its <a href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener noreferrer">full advice</a>.</div>`;
    }
  } else {
    html += `<div class="pop-note stale">UK FCDO advice unavailable: ${esc(f.error)}</div>`;
  }
  return html + `<div class="pop-note">None of these measures the risk to you on a given street. City and countryside differ, and a good score does not make every place safe or a low one every place dangerous. Check recent local reports before you go.</div>`;
}

function travelSectionHtml(iso2) {
  if (!iso2) return '';
  return `<div class="pop-travel" data-iso="${esc(iso2)}"><button type="button" class="linkish">Vaccines and entry requirements</button></div>
    <div class="pop-lgbt" data-iso="${esc(iso2)}"><button type="button" class="linkish">LGBT+ safety</button></div>`;
}

// Attach the buttons in the open popup. Nothing is requested until one is pressed.
function wireTravel(popupObj) {
  const root = popupObj.getElement();
  const hook = (selector, url, render) => {
    const box = root?.querySelector(selector);
    if (!box) return;
    const load = async () => {
      box.innerHTML = '<div class="pop-note">Loading, the first look-up for a country can take a few seconds...</div>';
      try {
        const res = await fetch(url + encodeURIComponent(box.dataset.iso));
        if (!res.ok) throw new Error(res.status);
        box.innerHTML = render(await res.json());
      } catch (err) {
        box.innerHTML = '<div class="pop-note stale">Could not load this. Try again in a moment.</div>';
      }
      box.scrollIntoView({ block: 'start', behavior: 'smooth' });  // the section is far down a long popup
      keepPopupInView(popupObj);
    };
    box.querySelector('button')?.addEventListener('click', load);
    box.loadNow = load;
  };
  hook('.pop-travel', '/api/travel-info?iso2=', renderTravel);
  hook('.pop-lgbt', '/api/lgbt?iso2=', renderLgbt);
}

// The State Dept's own sentence about embassy staffing or suspension, quoted. We do not turn it into a status.
function embassyNoticeHtml(a) {
  if (!a || !a.embassy_notice) return '';
  // Say which advisory the sentence comes from. An old one may since have been replaced.
  const date = a.timestamp ? new Date(a.timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  return `<div class="pop-note notice"><b>State Dept advisory${date ? ' of ' + esc(date) : ''} says</b> “${esc(a.embassy_notice)}”</div>`;
}

// If the live feed has been unreachable, say so. A stale advisory must not pass as current.
function staleNoticeHtml(a, source = 'State Dept') {
  if (!a || !a.as_of) return '';
  const hours = (Date.now() - Date.parse(a.as_of)) / 3.6e6;
  if (!(hours > 12)) return '';
  const when = new Date(a.as_of).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `<div class="pop-note stale">The ${esc(source)} feed has been unreachable since ${esc(when)}. This may be out of date, check the source.</div>`;
}

function advisoryPopup(a) {
  const date = a.timestamp ? new Date(a.timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  const chips = (a.reasons || []).map((r) => `<span class="chip">${esc(r)}</span>`).join('');
  const others = (a.entries || []).length > 1
    ? `<div class="pop-row"><b>Separate advisories</b> ${a.entries.map((e) =>
        `<a href="${esc(safeUrl(e.link))}" target="_blank" rel="noopener noreferrer">${esc(e.name)}</a>, Level ${e.level}`).join('; ')}</div>` : '';
  return `<div class="pop-title">${esc(a.country)}</div>
    ${advisoryBanner(a)}
    ${airspaceHtml(a.iso2)}
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
    ${advisoryBanner(a)}${airspaceCardHtml(a.iso2)}`;
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

// Markers that win a click over the country card underneath them. Aircraft layers exist only once aircraft.js has run.
const MARKER_LAYERS = ['sitrep-dot', 'sitrep-embassy', 'sitrep-wx-storm', 'sitrep-wx-alert', 'sitrep-wx-rain', 'sitrep-wx-outlook', 'sitrep-aircraft', 'sitrep-military', 'sitrep-ac-alert', 'sitrep-ac-selected'];
function markerUnder(point) {
  const layers = MARKER_LAYERS.filter((id) => map.getLayer(id));
  return layers.length ? map.queryRenderedFeatures(point, { layers }).length : 0;
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
    ${airspaceHtml(p.iso2)}
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
  const isWeather = ['==', ['get', 'layer'], 'weather'];  // weather draws its own storm markers and areas (weather.js)
  setFilter('sitrep-glow', ['!', isEmbassy], ['!', isWeather]);
  setFilter('sitrep-dot', ['!', isEmbassy], ['!', isWeather]);
  setFilter('sitrep-embassy', isEmbassy);
}

function renderLayers() {
  const box = el('layers');
  box.innerHTML = '';
  [...new Set([...state.layers, 'advisory', 'lgbt', 'airspace', 'aircraft', 'military'])].sort().forEach((layer) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !state.hidden.has(layer);
    cb.addEventListener('change', () => {
      cb.checked ? state.hidden.delete(layer) : state.hidden.add(layer);
      if (layer === 'advisory') {
        if (cb.checked) { state.hidden.add('lgbt'); setLgbtVisible(false); }   // one country tint at a time
        setAdvisoryVisible(cb.checked);
      }
      if (layer === 'lgbt') {
        if (cb.checked) {
          state.advisoriesHiddenByLgbt = !state.hidden.has('advisory');  // remember to bring them back
          state.hidden.add('advisory'); setAdvisoryVisible(false);
        } else if (state.advisoriesHiddenByLgbt) {
          state.advisoriesHiddenByLgbt = false;
          state.hidden.delete('advisory'); setAdvisoryVisible(true);
        }
        setLgbtVisible(cb.checked);
      }
      if (layer === 'airspace') setAirspaceVisible(cb.checked);
      if (layer === 'weather') setWeatherVisible(cb.checked);
      if (layer === 'aircraft' || layer === 'military') setAircraftVisible(layer, cb.checked);
      if (layer === 'advisory' || layer === 'lgbt') renderLayers();           // keep both checkboxes honest
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
setInterval(loadAirspace, 30 * 60 * 1000);
