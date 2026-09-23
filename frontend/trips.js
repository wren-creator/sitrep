// Trips: saved destinations and dates, one briefing card per stop with the warnings ranked worst first,
// and alerts when a stop's country changes. Loaded after app.js and shares its helpers (esc, safeUrl,
// advisoryBanner, airspaceBlock, renderTravel, renderLgbt, fmtDay, telLink, map).

const tripsUi = { list: [], currentId: null, found: null };
const $ = (id) => document.getElementById(id);

const WARN_SOURCE = {
  advisory: 'State Dept', airspace: 'Airspace', embassy: 'Embassy', conflict: 'Conflict',
  unrest: 'Unrest', disaster: 'Disaster', place: 'Place',
};

async function tripApi(method, path, body) {
  const res = await fetch(path, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = 'Something went wrong, check the details and try again.';
    try { const j = await res.json(); if (typeof j.detail === 'string') msg = j.detail; } catch { /* keep the default */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

function setBadge(n) {
  const b = $('trips-badge');
  b.hidden = !n;
  b.textContent = n || '';
}

async function refreshBadge() {
  try { setBadge((await tripApi('GET', '/api/trips')).unseen_alerts); } catch { /* the badge is a convenience */ }
}

function openTrips() {
  $('trips').hidden = false;
  loadTrips();
}

function closeTrips() {
  $('trips').hidden = true;
  refreshBadge();
}

async function loadTrips() {
  const d = await tripApi('GET', '/api/trips');
  tripsUi.list = d.trips;
  setBadge(d.unseen_alerts);
  renderTripList();
  if (tripsUi.currentId && tripsUi.list.some((t) => t.id === tripsUi.currentId)) selectTrip(tripsUi.currentId);
  else if (tripsUi.list.length) selectTrip(tripsUi.list[0].id);
  else $('trip-main').innerHTML = '<div class="pop-note">No trips yet. Create one on the left, then add the places you are going.</div>';
}

function renderTripList() {
  $('trip-items').innerHTML = tripsUi.list.map((t) => {
    const dates = t.start ? `${fmtDay(t.start)} to ${fmtDay(t.end)}` : 'no dates';
    return `<li data-id="${t.id}" class="${t.id === tripsUi.currentId ? 'on' : ''}">
      <div class="t-name">${esc(t.name)}${t.unseen_alerts ? ` <span class="badge">${t.unseen_alerts}</span>` : ''}</div>
      <div class="pop-meta">${esc(dates)} · ${t.stops.length} stop${t.stops.length === 1 ? '' : 's'} · ${esc(t.status)}</div></li>`;
  }).join('');
}

async function selectTrip(id) {
  tripsUi.currentId = id;
  renderTripList();
  try {
    renderBriefing(await tripApi('GET', `/api/trips/${id}/briefing`));
  } catch (err) {
    $('trip-main').innerHTML = `<div class="pop-note stale">${esc(err.message)}</div>`;
  }
}

// ------------------------------------------------------------------ rendering

const WHEN_TEXT = (sb) => (sb.when === 'upcoming' ? `in ${sb.days_to_start} day${sb.days_to_start === 1 ? '' : 's'}`
  : sb.when === 'now' ? 'now' : sb.when === 'past' ? 'past' : 'no dates');

function stopCard(sb) {
  const s = sb.stop;
  const dates = s.arrive || s.depart ? `${fmtDay(s.arrive)} to ${fmtDay(s.depart || s.arrive)}` : 'no dates set';
  const warnings = sb.warnings.length
    ? `<ul class="warns">${sb.warnings.map((w) => `<li class="w w-${w.level}"><span class="w-src">${esc(WARN_SOURCE[w.source] || w.source)}</span>
        ${esc(w.text)}${w.url ? ` <a href="${esc(safeUrl(w.url))}" target="_blank" rel="noopener noreferrer">source</a>` : ''}</li>`).join('')}</ul>`
    : '<div class="pop-note">Nothing flagged for this stop in the data we hold. That is not a guarantee.</div>';

  const a = sb.advisory;
  const advisory = a
    ? `${advisoryBanner(a)}${a.summary ? `<div class="pop-row">${esc(a.summary)}</div>` : ''}
       ${(a.reasons || []).length ? `<div class="chips">${a.reasons.map((r) => `<span class="chip">${esc(r)}</span>`).join('')}</div>` : ''}
       <div class="pop-note">US State Department, <a href="${esc(safeUrl(a.source_url))}" target="_blank" rel="noopener noreferrer">read the full advisory</a>.</div>`
    : '<div class="pop-note">No State Dept advisory matched this stop.</div>';

  const embassies = sb.embassies.length
    ? sb.embassies.map((e) => `<div class="pop-row"><b>${esc(e.title)}</b> · ${e.km.toLocaleString()} km straight-line
        <div>${e.address ? esc(e.address) : 'Address not in the map data'}${(e.phones || []).length ? ' · ' + e.phones.map(telLink).join(', ') : ''}
        ${e.website ? ` · <a href="${esc(safeUrl(e.website))}" target="_blank" rel="noopener noreferrer">website</a>` : ''}</div></div>`).join('') +
      `<div class="pop-note"><b>State Dept 24/7</b> ${telLink(OCS_ABROAD)} from abroad, ${telLink(OCS_US)} from the US or Canada. Details come from OpenStreetMap and are not checked live.</div>`
    : '<div class="pop-note">No operating US embassy in the data.</div>';

  const nearby = sb.nearby.length
    ? sb.nearby.map((n) => `<div class="nb nb-${esc(n.severity)}">${esc(n.title)} <span class="pop-meta">${esc(n.layer)} · ${esc(n.severity)} · ${n.km} km${n.source_url ? ` · <a href="${esc(safeUrl(n.source_url))}" target="_blank" rel="noopener noreferrer">source</a>` : ''}</span></div>`).join('')
    : '<div class="pop-note">Nothing reported within 150 km in the data we hold.</div>';

  const iso = esc(s.iso2 || '');
  const lazy = s.iso2 ? `
    <details data-lazy="health" data-iso="${iso}"><summary>Vaccines and entry requirements</summary><div class="lazy pop-note">Opens and loads the first time.</div></details>
    <details data-lazy="lgbt" data-iso="${iso}"><summary>LGBT+ safety</summary><div class="lazy pop-note">Opens and loads the first time.</div></details>` : '';

  return `<article class="stop w-top-${sb.worst}" data-stop="${s.id}">
    <header><div><h3>${esc(s.label)}</h3>
      <div class="pop-meta">${esc(sb.country || 'country unknown')} · ${esc(dates)} · <b>${esc(WHEN_TEXT(sb))}</b></div></div>
      <div class="stop-actions"><button type="button" class="hdr-btn" data-act="show" data-lat="${s.lat}" data-lon="${s.lon}">Show on map</button>
      <button type="button" class="hdr-btn danger" data-act="remove-stop" data-id="${s.id}">Remove</button></div></header>
    ${warnings}
    <details open><summary>State Dept advisory and airspace</summary>${advisory}${airspaceBlock(sb.airspace)}</details>
    <details><summary>Nearest US embassies</summary>${embassies}</details>
    <details><summary>Reports within 150 km (${sb.nearby.length})</summary>${nearby}</details>
    ${lazy}
  </article>`;
}

function renderBriefing(b) {
  const t = b.trip;
  const unseen = b.alerts.filter((x) => !x.seen);
  const alerts = b.alerts.length
    ? `<section class="alerts"><div class="alerts-head"><b>Changes since you added these stops</b>
        ${unseen.length ? `<button type="button" class="hdr-btn" data-act="seen">Mark all seen</button>` : ''}</div>
       ${b.alerts.slice(0, 12).map((x) => `<div class="alert a-${esc(x.severity)} ${x.seen ? 'seen' : ''}">
         <span class="pop-meta">${esc(new Date(x.created_at * 1000).toLocaleString())}</span> ${esc(x.text)}</div>`).join('')}</section>` : '';
  const worstBanner = b.worst === 'critical' || b.worst === 'high'
    ? `<div class="adv-banner adv-${b.worst === 'critical' ? 4 : 3}">${b.worst === 'critical' ? '⚠ SERIOUS WARNINGS ON THIS TRIP' : '⚠ WARNINGS ON THIS TRIP'}, see the stops below</div>` : '';

  $('trip-main').innerHTML = `
    <div class="trip-head"><div><h2>${esc(t.name)}</h2>
      <div class="pop-meta">${t.start ? esc(fmtDay(t.start)) + ' to ' + esc(fmtDay(t.end)) : 'no dates'} · ${esc(t.status)} · briefing built ${esc(new Date(b.as_of).toLocaleTimeString())}</div>
      ${t.notes ? `<div class="pop-note">${esc(t.notes)}</div>` : ''}</div>
      <div class="stop-actions"><button type="button" class="hdr-btn" data-act="rename">Rename</button>
      <button type="button" class="hdr-btn" data-act="print">Print</button>
      <button type="button" class="hdr-btn danger" data-act="delete-trip">Delete trip</button></div></div>
    ${worstBanner}${alerts}
    <form id="stop-form" class="stop-form" autocomplete="off">
      <div class="sf-row"><input id="sf-place" placeholder="Add a stop: a city or place, e.g. Amman" aria-label="Place to add">
        <button type="button" class="hdr-btn" data-act="find">Find</button></div>
      <div id="sf-found" class="pop-note">Search first, check that the place it finds is the one you mean.</div>
      <div class="sf-row"><label>Arrive <input id="sf-arrive" type="date"></label><label>Depart <input id="sf-depart" type="date"></label>
        <button type="button" class="hdr-btn primary" data-act="add-stop" id="sf-add" disabled>Add stop</button></div>
    </form>
    ${b.stops.length ? b.stops.map(stopCard).join('') : '<div class="pop-note">No stops yet. Add the first place above.</div>'}
    <div class="pop-note">Built from the map's own data, so it is only as good as those sources, and it says nothing about places it has no data for.
      Health, entry and LGBT+ details load when you open them and are cached. Confirm anything that matters with the State Department, the CDC and the destination's embassy.</div>`;
}

// ------------------------------------------------------------------ actions

async function findPlace() {
  const q = $('sf-place').value.trim();
  const out = $('sf-found');
  tripsUi.found = null;
  $('sf-add').disabled = true;
  if (!q) { out.textContent = 'Type a place first.'; return; }
  out.textContent = 'Searching...';
  try {
    const hit = await (await fetch('/api/geocode?q=' + encodeURIComponent(q))).json();
    if (hit.lat == null) { out.innerHTML = `<span class="stale">No match for "${esc(q)}".</span>`; return; }
    const short = (hit.name || q).split(',')[0].trim();
    const label = hit.country && !short.includes(hit.country) ? `${short}, ${hit.country}` : short;
    tripsUi.found = { label, lat: hit.lat, lon: hit.lon, iso2: hit.iso2 };
    out.innerHTML = `Found: <b>${esc(hit.name)}</b>${hit.iso2 ? '' : ' <span class="stale">(no country code, advisories cannot be matched)</span>'}`;
    $('sf-add').disabled = false;
  } catch (err) {
    out.innerHTML = '<span class="stale">The search failed, try again in a moment.</span>';
  }
}

async function addStop() {
  const f = tripsUi.found;
  if (!f || !tripsUi.currentId) return;
  const arrive = $('sf-arrive').value || null, depart = $('sf-depart').value || null;
  try {
    await tripApi('POST', `/api/trips/${tripsUi.currentId}/stops`, { label: f.label, lat: f.lat, lon: f.lon, iso2: f.iso2 || null, arrive, depart });
    tripsUi.found = null;
    await loadTrips();
  } catch (err) {
    $('sf-found').innerHTML = `<span class="stale">${esc(err.message)}</span>`;
  }
}

async function onMainClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  try {
    if (act === 'find') await findPlace();
    else if (act === 'add-stop') await addStop();
    else if (act === 'print') window.print();
    else if (act === 'show') {
      closeTrips();
      map.flyTo({ center: [+btn.dataset.lon, +btn.dataset.lat], zoom: 8, duration: 1400 });
    } else if (act === 'remove-stop') {
      if (confirm('Remove this stop from the trip?')) { await tripApi('DELETE', `/api/stops/${btn.dataset.id}`); await loadTrips(); }
    } else if (act === 'delete-trip') {
      if (confirm('Delete this whole trip, its stops and its alerts?')) {
        await tripApi('DELETE', `/api/trips/${tripsUi.currentId}`);
        tripsUi.currentId = null;
        await loadTrips();
      }
    } else if (act === 'rename') {
      const cur = tripsUi.list.find((t) => t.id === tripsUi.currentId);
      const name = prompt('Trip name', cur?.name || '');
      if (name && name.trim()) { await tripApi('PUT', `/api/trips/${cur.id}`, { name: name.trim(), notes: cur.notes || '' }); await loadTrips(); }
    } else if (act === 'seen') {
      await tripApi('POST', '/api/alerts/seen', { trip_id: tripsUi.currentId });
      await loadTrips();
    }
  } catch (err) {
    alert(err.message);
  }
}

// Health, entry and LGBT+ details load the first time their section is opened, then stay.
async function onToggle(e) {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.open || !d.dataset.lazy || d.dataset.loaded) return;
  d.dataset.loaded = '1';
  const box = d.querySelector('.lazy');
  box.textContent = 'Loading, the first look-up for a country can take a few seconds...';
  const url = d.dataset.lazy === 'health' ? '/api/travel-info?iso2=' : '/api/lgbt?iso2=';
  try {
    const res = await fetch(url + encodeURIComponent(d.dataset.iso));
    if (!res.ok) throw new Error(res.status);
    box.className = 'lazy';
    box.innerHTML = (d.dataset.lazy === 'health' ? renderTravel : renderLgbt)(await res.json());
  } catch (err) {
    d.dataset.loaded = '';
    box.innerHTML = '<span class="stale">Could not load this. Close and reopen it to try again.</span>';
  }
}

$('trips-btn').addEventListener('click', openTrips);
$('trips-close').addEventListener('click', closeTrips);
$('trip-items').addEventListener('click', (e) => { const li = e.target.closest('li[data-id]'); if (li) selectTrip(+li.dataset.id); });
$('trip-main').addEventListener('click', onMainClick);
$('trip-main').addEventListener('toggle', onToggle, true);
$('trip-main').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'sf-place') { e.preventDefault(); findPlace(); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('trips').hidden) closeTrips(); });
$('trip-new').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = e.target.elements.name;
  try {
    const t = await tripApi('POST', '/api/trips', { name: input.value.trim(), notes: '' });
    input.value = '';
    tripsUi.currentId = t.id;
    await loadTrips();
  } catch (err) {
    alert(err.message);
  }
});
window.addEventListener('beforeprint', () => document.querySelectorAll('#trip-main details:not([data-lazy])').forEach((d) => { d.open = true; }));

refreshBadge();
setInterval(refreshBadge, 60 * 1000);
