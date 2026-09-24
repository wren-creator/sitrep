// Weather: tropical storms and the areas where one may form (National Hurricane Center and Central Pacific
// Hurricane Center), and forecast heavy rain (Weather Prediction Center). Loaded after app.js, shares its
// helpers and map. On by default, it is the thing you want to see before you fly.
//
// What is drawn, and how to read it:
//   - a storm is a ringed dot with its name. Its cone (white) is where the CENTRE is expected to go about two
//     thirds of the time, NOT how big the storm is, wind and rain reach well outside it. The dashed line is the
//     forecast track with the forecast wind at each day, and the dotted line is where it has been.
//   - the thick coloured lines on the coast are watches and warnings
//   - a dashed yellow, orange or red blob is an area NHC expects a storm to form in, and the chance it will
//   - a white area is forecast snow, brighter with a strong outline where heavy snow is possible (empty out of season)
//   - a purple L is a low pressure centre with its pressure in millibars, the dashed line is WPC's forecast path
//     for the next day or so with the forecast pressure at each stop. A falling number is a strengthening storm.
//   - a blue or purple area is forecast heavy rain that could flood (Slight risk or worse, days 1 to 5)
//   - orange, teal, pale blue, green and violet areas are National Weather Service watches and warnings for wind,
//     coastal flood, winter storm, flash flood and rough seas. Dashed outline means a watch (possible), solid a warning

const WX_SEV = { low: '#f2c14e', medium: '#ff9f43', high: '#ff4d4d', critical: '#ff4d4d' };   // outlook areas
const WX_RAIN = { medium: '#3b82f6', high: '#8b5cf6', critical: '#ec4899' };
const WX_ALERT = { wind: '#ff9f43', coastal: '#2dd4bf', winter: '#bfdbfe', flash: '#22c55e', seas: '#a78bfa' };
const WX_WW = { TWA: '#ffe066', TWR: '#3b82f6', HWA: '#ff8fd1', HWR: '#ff3b30' };
const WX_WW_TEXT = { TWA: 'Tropical storm watch', TWR: 'Tropical storm warning', HWA: 'Hurricane watch', HWR: 'Hurricane warning' };
const WX_CAT = ['#6ec1ff', '#ffe066', '#ffb347', '#ff7a45', '#ff3b30', '#d63384'];   // tropical storm, then Category 1 to 5
const WX_LOW = '#c084fc';
const WX_LAYERS = ['sitrep-wx-snow', 'sitrep-wx-snow-line', 'sitrep-wx-lowtrack', 'sitrep-wx-lowf', 'sitrep-wx-lowf-label', 'sitrep-wx-low', 'sitrep-wx-low-label', 'sitrep-wx-alert', 'sitrep-wx-alert-line', 'sitrep-wx-alert-watch', 'sitrep-wx-rain', 'sitrep-wx-rain-line', 'sitrep-wx-outlook', 'sitrep-wx-outlook-line', 'sitrep-wx-cone', 'sitrep-wx-cone-line',
  'sitrep-wx-past', 'sitrep-wx-track', 'sitrep-wx-ww', 'sitrep-wx-fcst', 'sitrep-wx-fcst-label', 'sitrep-wx-storm', 'sitrep-wx-storm-label'];
const WX_CLICK = ['sitrep-wx-snow', 'sitrep-wx-alert', 'sitrep-wx-rain', 'sitrep-wx-outlook'];

const wxIs = (part) => ['==', ['get', 'part'], part];

function addWeatherLayers() {
  const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  const vis = state.hidden.has('weather') ? 'none' : 'visible';
  map.addSource('sitrep-weather', { type: 'geojson', data: emptyFc() });
  const add = (layer, beforeId = before) => map.addLayer({ source: 'sitrep-weather', ...layer, layout: { visibility: vis, ...(layer.layout || {}) } }, beforeId);
  const rainColor = ['match', ['get', 'severity'], 'critical', WX_RAIN.critical, 'high', WX_RAIN.high, WX_RAIN.medium];
  const outlookColor = ['match', ['get', 'severity'], 'high', WX_SEV.high, 'medium', WX_SEV.medium, WX_SEV.low];

  const alertColor = ['match', ['get', 'group'], ...Object.entries(WX_ALERT).flat(), '#ff9f43'];
  const isAlert = wxIs('alert');
  add({ id: 'sitrep-wx-alert', type: 'fill', filter: isAlert, paint: { 'fill-color': alertColor, 'fill-opacity': 0.2 } });
  add({ id: 'sitrep-wx-alert-line', type: 'line', filter: ['all', isAlert, ['==', ['get', 'watch'], false]], paint: { 'line-color': alertColor, 'line-width': 1.4, 'line-opacity': 0.9 } });
  add({ id: 'sitrep-wx-alert-watch', type: 'line', filter: ['all', isAlert, ['==', ['get', 'watch'], true]], paint: { 'line-color': alertColor, 'line-width': 1.4, 'line-dasharray': [2, 1.6] } });
  add({ id: 'sitrep-wx-rain', type: 'fill', filter: wxIs('rain'), paint: { 'fill-color': rainColor, 'fill-opacity': 0.24 } });
  add({ id: 'sitrep-wx-rain-line', type: 'line', filter: wxIs('rain'), paint: { 'line-color': rainColor, 'line-width': 1.6, 'line-opacity': 0.85 } });
  add({ id: 'sitrep-wx-snow', type: 'fill', filter: wxIs('snow'),
    paint: { 'fill-color': '#f1f5f9', 'fill-opacity': ['case', ['get', 'heavy'], 0.42, 0.22] } });
  add({ id: 'sitrep-wx-snow-line', type: 'line', filter: wxIs('snow'),
    paint: { 'line-color': '#ffffff', 'line-width': ['case', ['get', 'heavy'], 2.4, 1.2], 'line-opacity': 0.9 } });
  add({ id: 'sitrep-wx-outlook', type: 'fill', filter: wxIs('outlook'), paint: { 'fill-color': outlookColor, 'fill-opacity': 0.16 } });
  add({ id: 'sitrep-wx-outlook-line', type: 'line', filter: wxIs('outlook'),
    paint: { 'line-color': outlookColor, 'line-width': 2, 'line-dasharray': [2, 1.4] } });
  add({ id: 'sitrep-wx-cone', type: 'fill', filter: wxIs('cone'), paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.13 } });
  add({ id: 'sitrep-wx-cone-line', type: 'line', filter: wxIs('cone'), paint: { 'line-color': '#ffffff', 'line-width': 1.2, 'line-opacity': 0.6 } });
  add({ id: 'sitrep-wx-past', type: 'line', filter: wxIs('past'), layout: { 'line-cap': 'round' },
    paint: { 'line-color': '#c9d6e4', 'line-width': 2, 'line-opacity': 0.75, 'line-dasharray': [0.5, 1.8] } });
  add({ id: 'sitrep-wx-track', type: 'line', filter: wxIs('track'), paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [2, 1.4] } });
  add({ id: 'sitrep-wx-ww', type: 'line', filter: wxIs('warning'), layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['match', ['get', 'tcww'], ...Object.entries(WX_WW).flat(), '#ffffff'], 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 3.5, 7, 7] } });
  add({ id: 'sitrep-wx-fcst', type: 'circle', filter: wxIs('fcst'), paint: {
    'circle-color': ['step', ['get', 'cat'], WX_CAT[0], 1, WX_CAT[1], 2, WX_CAT[2], 3, WX_CAT[3], 4, WX_CAT[4], 5, WX_CAT[5]],
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 3, 8, 6], 'circle-stroke-color': '#0b0f14', 'circle-stroke-width': 1 } });
  add({ id: 'sitrep-wx-fcst-label', type: 'symbol', filter: ['all', wxIs('fcst'), ['!=', ['get', 'label'], '']], minzoom: 3,
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-allow-overlap': false },
    paint: { 'text-color': '#ffffff', 'text-halo-color': '#0b1a26', 'text-halo-width': 1.6 } }, undefined);

  add({ id: 'sitrep-wx-lowtrack', type: 'line', filter: wxIs('lowtrack'), paint: { 'line-color': WX_LOW, 'line-width': 2, 'line-dasharray': [2, 1.4] } }, undefined);
  add({ id: 'sitrep-wx-lowf', type: 'circle', filter: wxIs('lowf'), paint: { 'circle-color': '#1e1033', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 3.5, 8, 6],
    'circle-stroke-color': WX_LOW, 'circle-stroke-width': 2 } }, undefined);
  add({ id: 'sitrep-wx-lowf-label', type: 'symbol', filter: wxIs('lowf'), minzoom: 3,
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top' },
    paint: { 'text-color': '#e9d5ff', 'text-halo-color': '#0b1a26', 'text-halo-width': 1.6 } }, undefined);
  add({ id: 'sitrep-wx-low', type: 'circle', filter: wxIs('low'), paint: { 'circle-color': '#7c3aed', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 5, 8, 10],
    'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2, 'circle-pitch-alignment': 'map' } }, undefined);
  add({ id: 'sitrep-wx-low-label', type: 'symbol', filter: wxIs('low'), minzoom: 2.5,
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-allow-overlap': true },
    paint: { 'text-color': '#f3e8ff', 'text-halo-color': '#0b1a26', 'text-halo-width': 2 } }, undefined);

  // The storm itself comes from the main feature source, so it is clickable and listed in the sidebar like the rest.
  map.addLayer({ id: 'sitrep-wx-storm', type: 'circle', source: 'sitrep', filter: ['all', ['==', ['get', 'kind'], 'storm']],
    layout: { visibility: vis }, paint: {
      'circle-color': bySeverity(SEV_COLOR.critical, SEV_COLOR.high, SEV_COLOR.medium, SEV_COLOR.low),
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 6, 8, 13], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5,
      'circle-pitch-alignment': 'map' } });
  map.addLayer({ id: 'sitrep-wx-storm-label', type: 'symbol', source: 'sitrep', filter: ['==', ['get', 'kind'], 'storm'],
    layout: { visibility: vis, 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 13, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-allow-overlap': true },
    paint: { 'text-color': '#ffffff', 'text-halo-color': '#0b1a26', 'text-halo-width': 2 } });

  map.on('click', 'sitrep-wx-storm', (e) => showWeather(e.features[0].properties.id, e.features[0].geometry.coordinates));
  for (const id of WX_CLICK) {
    map.on('click', id, (e) => {
      if (map.queryRenderedFeatures(e.point, { layers: ['sitrep-wx-storm'] }).length) return;
      showWeather(e.features[0].properties.id, e.lngLat);
    });
  }
  for (const id of ['sitrep-wx-low', 'sitrep-wx-lowf']) {
    map.on('click', id, (e) => showWeather(e.features[0].properties.id, e.features[0].geometry.coordinates));
  }
  for (const id of ['sitrep-wx-storm', 'sitrep-wx-low', 'sitrep-wx-lowf', ...WX_CLICK]) {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
}

const WX_NOTE = {
  storm: 'The white cone is where the centre is expected to go about two thirds of the time. It is not the size of the storm, wind, surge and rain reach well outside it. Dashed line: forecast track and the forecast wind each day. Dotted line: where it has been.',
  outlook: 'Nothing has formed yet. The shaded area is where the National Hurricane Center expects a storm to form, and the percentage is its chance of doing so. Forecasts this far out change often.',
  alert: 'These are National Weather Service watches and warnings, grouped by type and region. A warning means it is happening or expected, a watch means it is possible. Zones are drawn simplified, so edges are approximate. Read the alert text at alerts.weather.gov for your exact location.',
  snow: 'This shows where snow is forecast, not how much or when. NWS winter storm watches and warnings, where there are any, are in the alert areas. WPC forecasts these one to three days out.',
  low: 'A low pressure centre, with its pressure in millibars. The lower the number, the stronger the storm, and a number that falls fast means one that is strengthening. The dashed line is WPC\'s forecast path for about the next day, which is as far as its map goes. The winds and rain around a low are shown by the alert and rain areas.',
  rain: 'This is where flash flooding is forecast to be a risk. It does not say what is causing the rain, and does not cover wind or snow.',
};

function showWeather(id, at) {
  const f = state.byId.get(id);
  if (!f) return;
  const p = f.properties;
  const when = p.timestamp ? new Date(p.timestamp).toLocaleString() : '';
  const disc = p.discussion_url ? ` · <a href="${esc(safeUrl(p.discussion_url))}" target="_blank" rel="noopener noreferrer">forecast discussion</a>` : '';
  popup.setLngLat(at).setHTML(`<div class="pop-title">${esc(p.title)}</div>
    <div class="pop-meta">weather · ${esc(p.severity)} · updated ${esc(when)} ·
      <a href="${esc(safeUrl(p.source_url))}" target="_blank" rel="noopener noreferrer">${p.kind === 'storm' ? 'advisory' : 'source'}</a>${disc}</div>
    <div class="pop-note">${esc(p.summary)}</div>
    <div class="pop-note">${esc(WX_NOTE[p.kind] || '')}</div>`).addTo(map);
  popup.sitrepId = id;
  keepPopupInView(popup);
}

async function loadWeather() {
  try {
    const data = await (await fetch('/api/weather')).json();
    state.weather = data;
    map.getSource('sitrep-weather')?.setData(data);
    renderWeatherLegend();
  } catch (err) {
    console.error('weather load failed', err);
  }
}

function setWeatherVisible(on) {
  WX_LAYERS.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));
  renderWeatherLegend();
}

function renderWeatherLegend() {
  const box = el('legend-wx');
  const feats = state.weather?.features || [];
  box.hidden = state.hidden.has('weather') || !feats.length;
  if (box.hidden) return;
  const has = (part) => feats.some((f) => f.properties.part === part);
  const dot = (c) => `<span class="wx-dot" style="background:${c}"></span>`;
  const line = (c) => `<span class="wx-line" style="background:${c}"></span>`;
  const rows = [];
  if (has('cone')) rows.push(`<div class="air-key">${dot('#fff')}Storm and its forecast cone (centre only)</div>`);
  if (has('warning')) rows.push(`<div class="air-key">${Object.entries(WX_WW).map(([k, c]) => line(c) ).join('')}Watches and warnings (yellow, blue, pink, red)</div>`);
  if (has('outlook')) rows.push(`<div class="air-key"><span class="wx-dash" style="border-color:${WX_SEV.high}"></span>Area where a storm may form</div>`);
  if (has('alert')) rows.push(`<div class="air-key">${Object.values(WX_ALERT).map((c) => dot(c)).join('')}NWS wind, coastal flood, winter, flash flood, seas (dashed: watch)</div>`);
  if (has('low')) rows.push(`<div class="air-key">${dot('#7c3aed')}L: low pressure, millibars, and its forecast path</div>`);
  if (has('snow')) rows.push(`<div class="air-key">${dot('#f1f5f9')}Snow forecast (bright: heavy snow possible)</div>`);
  if (has('rain')) rows.push(`<div class="air-key">${dot(WX_RAIN.medium)}Heavy rain, flood risk (days 1 to 5)</div>`);
  const lastFetch = Math.min(...(state.weather.sources || []).map((s) => s.fetched_at || 0));
  const stale = (state.weather.sources || []).some((s) => !s.ok);
  box.innerHTML = `<div class="lg-legend-title">🌀 Weather</div>${rows.join('')}
    <div class="lg-legend-note">${stale ? '<span class="pop-warn">A weather source is failing, showing its last good data.</span> ' : ''}Forecasts change, and this is a map, not a warning service. Read the full advisory before you act on it. Sources: <a href="https://www.nhc.noaa.gov" target="_blank" rel="noopener noreferrer">NHC</a>, <a href="https://alerts.weather.gov" target="_blank" rel="noopener noreferrer">NWS</a>, <a href="https://www.wpc.ncep.noaa.gov/qpf/excessive_rainfall_outlook_ero.php" target="_blank" rel="noopener noreferrer">WPC</a> (NOAA).
    ${lastFetch ? `Checked ${new Date(lastFetch * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''}</div>`;
}

map.on('style.load', () => {
  addWeatherLayers();
  loadWeather();
});
setInterval(loadWeather, 15 * 60 * 1000);
