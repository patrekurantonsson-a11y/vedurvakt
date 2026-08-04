/* Veðurvakt — front end. Reads data/latest.json and draws everything.
   Iceland runs on UTC all year, so every time here is UTC. */

/* --- station map -------------------------------------------------------- */

/* Drawn without map tiles — used only if Leaflet cannot be reached. */
function drawMapFallback(data) {
  const stations = (data.stations || [])
    .filter(s => s.km <= (data.radius_km || 45));
  const maxKm = Math.max(20, ...stations.map(s => s.km));
  const W = 640, H = 400, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 34;
  let out = `<svg viewBox="0 0 ${W} ${H}" role="img"
    aria-label="Veðurstöðvar í kringum ${data.place}">
    <rect width="${W}" height="${H}" rx="8" fill="#FAF8F3"/>`;

  [1 / 3, 2 / 3, 1].forEach(f => {
    out += `<circle cx="${cx}" cy="${cy}" r="${(R * f).toFixed(1)}" fill="none"
      stroke="#E3DED3" stroke-width="1"/>`;
    out += `<text x="${cx + 4}" y="${(cy - R * f + 13).toFixed(1)}" fill="#9A968D"
      font-size="10">${Math.round(maxKm * f)} km</text>`;
  });
  [["N", 0], ["A", 90], ["S", 180], ["V", 270]].forEach(([lab, a]) => {
    const r = a * Math.PI / 180;
    out += `<text x="${(cx + Math.sin(r) * (R + 18)).toFixed(1)}"
      y="${(cy - Math.cos(r) * (R + 18) + 4).toFixed(1)}" fill="#9A968D" font-size="11"
      text-anchor="middle">${lab}</text>`;
  });

  const placed = [];
  stations.forEach((s, i) => {
    const a = s.bearing * Math.PI / 180;
    const rr = R * Math.min(1, s.km / maxKm);
    const x = cx + Math.sin(a) * rr, y = cy - Math.cos(a) * rr;
    const spd = s.spd === null ? 0 : s.spd;
    const colour = spd < 8 ? "#4E8F79" : spd < 15 ? "#C98A33" : "#A8442A";
    if (s.dir !== null && s.dir !== undefined) {
      const w = (s.dir + 180) % 360 * Math.PI / 180;
      const len = 9 + Math.min(17, spd * 1.5);
      out += `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}"
        x2="${(x + Math.sin(w) * len).toFixed(1)}" y2="${(y - Math.cos(w) * len).toFixed(1)}"
        stroke="${colour}" stroke-width="1.8" stroke-linecap="round"/>`;
    }
    out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${colour}">
      <title>${s.name}: ${compass(s.dir)} ${spd.toFixed(1)} m/s, ${s.km} km</title></circle>`;
    // Label the closest handful, skipping any that would collide.
    if (i < 7 && s.t !== null && s.t !== undefined) {
      const lx = x + 8, ly = y - 20;
      if (!placed.some(p => Math.abs(p[0] - lx) < 76 && Math.abs(p[1] - ly) < 26)) {
        placed.push([lx, ly]);
        const label = `${Math.round(s.t)}°  ${s.name}`;
        out += `<g transform="translate(${lx.toFixed(1)} ${ly.toFixed(1)})">
          <rect x="0" y="0" rx="5" width="${28 + label.length * 5.6}" height="21"
            fill="#fff" stroke="#E3DED3"/>
          <text x="9" y="15" font-size="11.5" fill="#23262A">${label}</text></g>`;
      }
    }
  });

  out += `<circle cx="${cx}" cy="${cy}" r="6" fill="#15514E"/>
    <circle cx="${cx}" cy="${cy}" r="11" fill="none" stroke="#15514E" stroke-opacity=".35"/>
    <text x="${cx}" y="${cy + 26}" font-size="12" font-weight="600" fill="#15514E"
      text-anchor="middle">${data.place}</text></svg>`;
  return out;
}

/* --- real map ----------------------------------------------------------- */

let MAP = null, MARKERS = null, HOME = null, ENTRIES = [], FITTED = false;

/* VIEW is whatever the panels are describing: the home town, or a station the
   user has picked on the map. Station forecasts come straight from the model. */
let VIEW = null, SELECTED = null, FIELD = null;
const STN_CACHE = {};
const raf = fn => (typeof requestAnimationFrame === "function"
  ? requestAnimationFrame(fn) : fn());

/* The model forecast at every station, so the whole map follows the slider.
   Frames are hourly for a day and three-hourly after; values in between are
   interpolated, wind direction through its vector so it turns the short way. */
function buildField(d) {
  FIELD = (d.field && d.field.stations && d.field.stations.length)
    ? { times: d.field.times.map(t => Date.parse(t)),
        byNr: new Map(d.field.stations.map(r => [r.nr, r])),
        derived: !!d.field.derived }
    : null;
}

function fieldAt(nr, ms) {
  if (!FIELD) return null;
  const row = FIELD.byNr.get(nr);
  if (!row) return null;
  const T = FIELD.times;
  let i = 0;
  while (i < T.length - 1 && T[i + 1] <= ms) i++;
  const j = Math.min(i + 1, T.length - 1);
  const span = T[j] - T[i];
  const f = span > 0 ? Math.max(0, Math.min(1, (ms - T[i]) / span)) : 0;
  const lerp = (a, b) => (a == null ? b : b == null ? a : a + (b - a) * f);
  const a = row.dir[i], b = row.dir[j];
  let dir = a == null ? b : b == null ? a : null;
  if (dir === null) {
    const rad = x => x * Math.PI / 180;
    const x = Math.cos(rad(a)) * (1 - f) + Math.cos(rad(b)) * f;
    const y = Math.sin(rad(a)) * (1 - f) + Math.sin(rad(b)) * f;
    dir = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  return { t: lerp(row.t[i], row.t[j]), spd: lerp(row.spd[i], row.spd[j]), dir,
           precip: row.precip ? lerp(row.precip[i], row.precip[j]) : null };
}

const liveHour = () => SEL === 0;

function selectedTime() {
  const h = VIEW && VIEW.hours[SEL];
  return h ? Date.parse(h.valid) : Date.now();
}

/* What a station shows right now: its measurements at hour 0, the model after. */
function stationValues(s) {
  if (liveHour()) return { t: s.t, spd: s.spd, dir: s.dir, live: true };
  return fieldAt(s.nr, selectedTime()) || { t: null, spd: null, dir: null };
}

let stationsQueued = false;
function refreshStations() {
  if (!MAP || !ENTRIES.length || stationsQueued) return;
  stationsQueued = true;
  raf(() => {
    stationsQueued = false;
    ENTRIES.forEach(e => {
      const v = stationValues(e.group[0]);
      e.badge = entryBadge(e.group, e.selected, v);
      e.dot = dotIcon(windColour(v.spd));
      e.marker.setIcon(e.mode === "badge" ? e.badge : e.dot);
    });
  });
}

const OM_URL = "https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}" +
  "&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m," +
  "wind_gusts_10m,cloud_cover,precipitation&wind_speed_unit=ms&timezone=UTC" +
  "&forecast_days=8";

function homeView(d) {
  return { key: "home", name: d.place, lat: d.lat, lon: d.lon,
           now: d.now, hours: d.hours, station: null,
           median: d.median, sources: d.sources };
}

/* A station reports measurements, not the derived fields the town panel has. */
function stationView(s, hours) {
  return {
    key: "stn:" + s.nr, name: s.name, lat: s.lat, lon: s.lon, station: s,
    hours: hours || [],
    now: { t: s.t, dir: s.dir, spd: s.spd, gust: s.gust, rh: s.rh, td: null,
           p: null, cloud: null, ts: s.ts, station: s.name },
  };
}

async function fetchStationForecast(s) {
  const url = OM_URL.replace("{lat}", s.lat.toFixed(4)).replace("{lon}", s.lon.toFixed(4));
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status);
  const h = (await res.json()).hourly;
  const from = Math.floor(Date.now() / 3600e3) * 3600e3;
  const out = [];
  h.time.forEach((t, i) => {
    const dt = new Date(t + "Z");
    if (dt.getTime() < from) return;
    out.push({ valid: dt.toISOString(), t: h.temperature_2m[i],
               spd: h.wind_speed_10m[i], gust: h.wind_gusts_10m[i],
               dir: h.wind_direction_10m[i], cloud: h.cloud_cover[i],
               precip: h.precipitation[i], rh: h.relative_humidity_2m[i] });
  });
  return out.slice(0, 169);
}

async function selectStation(st) {
  const cached = STN_CACHE[st.nr];
  VIEW = stationView(st, cached ? cached.hours : null);
  if (cached) { VIEW.median = cached.median; VIEW.sources = cached.sources; }
  VIEW.loading = !cached;
  SELECTED = st.nr;
  SEL = 0;
  markSelection();
  paintView();
  if (cached) return;
  try {
    const ens = await fetchStationEnsemble(st);
    STN_CACHE[st.nr] = ens;
    if (VIEW.key !== "stn:" + st.nr) return;   // user has moved on already
    VIEW.hours = ens.hours;
    VIEW.median = ens.median;
    VIEW.sources = ens.sources;
  } catch (err) {
    if (VIEW.key !== "stn:" + st.nr) return;
    VIEW.error = true;
  }
  VIEW.loading = false;
  paintView();
}

function goHome() {
  if (!DATA) return;
  VIEW = homeView(DATA);
  SELECTED = null;
  SEL = 0;
  markSelection();
  paintView();
}

/* Redraw only the badges whose selected state changed. */
function markSelection() {
  ENTRIES.forEach(e => {
    const on = e.group.some(x => x.nr === SELECTED);
    if (on === e.selected) return;
    e.selected = on;
    e.badge = entryBadge(e.group, on);
    if (e.mode === "badge") e.marker.setIcon(e.badge);
  });
}

const windColour = spd =>
  spd === null || spd === undefined ? "#8C8A82"
  : spd < 8 ? "#4E8F79" : spd < 15 ? "#C98A33" : "#A8442A";

/* Small arrow drawn inside a badge, pointing where the wind is going. */
function badgeArrow(dir, colour) {
  if (dir === null || dir === undefined) return "";
  return `<svg class="b-arrow" viewBox="0 0 16 16" aria-hidden="true">
    <g transform="rotate(${(((dir % 360) + 360) % 360).toFixed(0)} 8 8)">
      <path d="M8 2 L8 14 M8 14 L4.8 10.4 M8 14 L11.2 10.4" stroke="${colour}"
        stroke-width="2" fill="none" stroke-linecap="round"
        stroke-linejoin="round"/></g></svg>`;
}

/* Kilometres apart — flat-earth maths is plenty over these distances. */
function kmApart(a, b) {
  const dy = (a.lat - b.lat) * 110.57;
  const dx = (a.lon - b.lon) * 111.32 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(dx, dy);
}

/* Vegagerðin often runs more than one sensor on the same stretch of road, so
   stations within 1.5 km share a single badge and are explained in its card. */
function clusterStations(stations) {
  const groups = [];
  stations.forEach(s => {
    const near = groups.find(g => kmApart(g[0], s) < 1.5);
    if (near) near.push(s); else groups.push([s]);
  });
  return groups;
}

function badgeHtml(t, spd, dir, colour, cls, count) {
  return `<div class="stn ${cls || ""}">
    <span class="stn-t">${t === null || t === undefined ? "—" : Math.round(t) + "°"}</span>
    <span class="stn-w">${badgeArrow(dir, colour)}${
      spd === null || spd === undefined ? "" : Math.round(spd)}</span>
    ${count > 1 ? `<span class="stn-n">${count}</span>` : ""}
  </div><span class="stn-dot" style="background:${colour}"></span>`;
}

function stationRows(s) {
  return [
    ["Vindur", s.spd == null ? null : `${compass(s.dir)} ${Math.round(s.spd)} m/s`],
    ["Vindhviður", s.gust == null ? null : `${Math.round(s.gust)} m/s`],
    ["Hiti", s.t == null ? null : `${Number(s.t).toFixed(1)}°C`],
    ["Veghiti", s.troad == null ? null : `${Number(s.troad).toFixed(1)}°C`],
    ["Rakastig", s.rh == null ? null : `${Math.round(s.rh)}%`],
    ["Hæð yfir sjó", s.alt == null ? null : `${Math.round(s.alt)} m`],
    ["Fjarlægð", s.km == null ? null : `${s.km} km`],
  ].filter(r => r[1] !== null && r[1] !== undefined)
   .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
}

function groupPopup(g) {
  const when = g[0].ts ? hhmm(new Date(g[0].ts)) : "";
  const at = liveHour() ? "" : hhmm(new Date(selectedTime()));
  const pick = s => `<button class="pop-pick" data-nr="${s.nr}" type="button"
    >Sýna spá fyrir ${s.name}</button>`;
  const forecast = s => {
    const v = fieldAt(s.nr, selectedTime());
    if (!v || v.t === null) return "";
    return `<div class="pop-fcst"><h5>Spá kl. ${at}</h5>
      <dl><dt>Hiti</dt><dd>${v.t.toFixed(1)}°C</dd>
      <dt>Vindur</dt><dd>${compass(v.dir)} ${Math.round(v.spd)} m/s</dd></dl></div>`;
  };
  const block = s => `${liveHour() ? "" : forecast(s)}
    <h5 class="pop-obs">Mælt kl. ${when}</h5><dl>${stationRows(s)}</dl>${pick(s)}`;

  if (g.length === 1) {
    return `<div class="pop"><div class="pop-h"><strong>${g[0].name}</strong>
        <span>${liveHour() ? when : "spá " + at}</span></div>${block(g[0])}</div>`;
  }
  return `<div class="pop pop-multi">
    <div class="pop-h"><strong>${g.length} stöðvar á sama stað</strong>
      <span>${liveHour() ? when : "spá " + at}</span></div>
    ${g.map(s => `<div class="pop-stn"><h4>${s.name}</h4>${block(s)}</div>`).join("")}
    <p class="pop-note">Vegagerðin rekur oft fleiri en einn mæli á sama vegkafla —
      sitt hvorum megin vegar, í ólíkri hæð eða á brú. Þess vegna geta tölurnar
      verið mismunandi þótt staðurinn líti eins út á kortinu. Hæðin yfir sjó og
      fjarlægðin hér að ofan segja til um hvor stöðin er hvor.</p></div>`;
}

function homeBadge(d, i) {
  const h = d.hours[i] || {};
  const live = i === 0;
  const t = live ? d.now.t : h.t;
  const spd = live ? d.now.spd : h.spd;
  const dir = live ? d.now.dir : h.dir;
  return badgeHtml(t, spd, dir, "#15514E", "home") .replace(
    'class="stn-dot"', 'class="stn-dot home"');
}

function homePopup(d, i) {
  const h = d.hours[i] || {};
  const live = i === 0;
  const n = d.now;
  const rows = [
    ["Vindur", (live ? n.spd : h.spd) == null ? null :
      `${compass(live ? n.dir : h.dir)} ${Math.round(live ? n.spd : h.spd)} m/s`],
    ["Veður", skyWord(live ? n.cloud : h.cloud, live ? 0 : (h.precip || 0))],
    ["Hiti", (live ? n.t : h.t) == null ? null :
      `${Number(live ? n.t : h.t).toFixed(1)}°C`],
    ["Úrkoma / klst", h.precip == null ? "Ekki mæld" : `${h.precip.toFixed(1)} mm`],
    ["Loftþrýstingur", live && n.p != null ? `${Number(n.p).toFixed(0)} hPa` : null],
  ].filter(r => r[1] !== null && r[1] !== undefined);
  const when = h.valid ? hhmm(new Date(h.valid)) : hhmm(new Date(d.issued));
  return `<div class="pop"><div class="pop-h"><strong>${d.place}</strong>
      <span>${when}${live ? "" : " · spá"}</span></div>
    <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl></div>`;
}

const dotIcon = colour => L.divIcon({
  className: "stn-wrap",
  html: `<span class="stn-dot lone" style="background:${colour}"></span>`,
  iconSize: [11, 11], iconAnchor: [5, 5],
});

/* Badges that would overlap at this zoom shrink to a dot; the card still
   opens on hover, so nothing is lost, and zooming in brings them back. */
function layout() {
  if (!MAP || !ENTRIES.length) return;
  const boxes = [];
  const reserve = (p, w, h) => {
    const box = { x: p.x - w / 2, y: p.y - h, w, h };
    const clash = boxes.some(b => !(box.x + box.w < b.x || b.x + b.w < box.x ||
                                    box.y + box.h < b.y || b.y + b.h < box.y));
    if (!clash) boxes.push(box);
    return !clash;
  };
  if (HOME) reserve(MAP.latLngToContainerPoint(HOME.getLatLng()), 70, 34);
  ENTRIES.forEach(e => {
    const p = MAP.latLngToContainerPoint(e.marker.getLatLng());
    const room = reserve(p, 64, 32);
    const want = room ? "badge" : "dot";
    if (e.mode !== want) {
      e.marker.setIcon(want === "badge" ? e.badge : e.dot);
      e.mode = want;
    }
  });
}

/* Hovering opens the card, but the card sits above the marker: without a grace
   period, moving the pointer onto it counts as leaving the marker, the card
   closes, the pointer is back on the marker and it reopens — a flicker loop.
   The delay also makes the button inside the card reachable. */
function hoverPopup(marker) {
  let timer = null;
  const hold = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const release = () => { hold(); timer = setTimeout(() => marker.closePopup(), 200); };
  marker.on("mouseover", () => { hold(); marker.openPopup(); });
  marker.on("mouseout", release);
  marker.on("popupopen", ev => {
    const el = ev.popup.getElement();
    if (!el) return;
    el.addEventListener("mouseenter", hold);
    el.addEventListener("mouseleave", release);
  });
  marker.on("popupclose", hold);
  return marker;
}

/* Expand the map to the whole window, and refit it to the stations. */
function toggleFullMap(force) {
  const on = force === undefined
    ? !document.body.classList.contains("mapfull") : force;
  document.body.classList.toggle("mapfull", on);
  const btn = document.querySelector(".map-btn.expand");
  if (btn) {
    btn.innerHTML = on ? "&#10532;" : "&#10530;";
    btn.title = on ? "Minnka kortið" : "Stækka kortið";
  }
  setTimeout(() => {
    if (!MAP) return;
    MAP.invalidateSize();
    queueField();
    layout();
  }, 80);
}

function mapControls() {
  const c = L.control({ position: "topright" });
  c.onAdd = () => {
    const box = L.DomUtil.create("div", "map-tools");
    const expand = L.DomUtil.create("button", "map-btn expand", box);
    expand.innerHTML = "&#10530;";
    expand.title = "Stækka kortið";
    const fit = L.DomUtil.create("button", "map-btn", box);
    fit.innerHTML = "&#8982;";
    fit.title = "Passa kortið að stöðvunum";
    L.DomEvent.on(expand, "click", ev => { L.DomEvent.stop(ev); toggleFullMap(); });
    L.DomEvent.on(fit, "click", ev => { L.DomEvent.stop(ev); fitToStations(); });
    L.DomEvent.disableClickPropagation(box);
    return box;
  };
  return c;
}

function fitToStations() {
  if (!MAP || !ENTRIES.length || !DATA) return;
  // Open on the stations around the town; the rest of the country is a zoom out.
  const near = ENTRIES.filter(e => e.group[0].km <= (DATA.radius_km || 45));
  const pts = (near.length ? near : ENTRIES).map(e => e.marker.getLatLng())
    .concat(HOME ? [HOME.getLatLng()] : []);
  MAP.fitBounds(L.latLngBounds(pts).pad(0.12), { maxZoom: 10, animate: false });
}

function entryBadge(g, selected, v) {
  const val = v || stationValues(g[0]);
  const cls = (selected ? "sel" : "") + (val.live === true ? "" : " fcst");
  const LAYER = badgeLayer();
  if (LAYER === "stodvar") {
    return L.divIcon({ className: "stn-wrap",
      html: badgeHtml(val.t, val.spd, val.dir, windColour(val.spd), cls, g.length),
      iconSize: [58, 22], iconAnchor: [29, 26] });
  }
  // Over a colour field one number is enough; the shading carries the pattern.
  const x = LAYER === "precip" ? (fieldAt(g[0].nr, selectedTime()) || {}).precip
          : LAYER === "t" ? val.t : val.spd;
  const text = x === null || x === undefined ? "—"
    : LAYER === "t" ? `${Math.round(x)}°`
    : LAYER === "spd" ? `${Math.round(x)}`
    : `${x.toFixed(1)}`;
  const arrowSvg = LAYER === "spd" ? badgeArrow(val.dir, "#23262A") : "";
  return L.divIcon({ className: "stn-wrap",
    html: `<div class="stn one ${cls}">${arrowSvg}<span>${text}</span></div>
      <span class="stn-dot" style="background:#23262A"></span>`,
    iconSize: [40, 20], iconAnchor: [20, 24] });
}

function renderMap(d) {
  const host = document.getElementById("map");
  if (typeof L === "undefined") {          // tiles unreachable — draw it ourselves
    host.innerHTML = drawMapFallback(d);
    return;
  }
  const stations = (d.stations || []).filter(s => s.lat && s.lon);
  buildField(d);

  if (!MAP) {
    MAP = L.map(host, { scrollWheelZoom: true, minZoom: 4, maxZoom: 14 })
      .setView([d.lat, d.lon], 9);
    // Three layers of base map: a plain drawing, relief shading over it for
    // depth, and place names on a pane above the weather colours so they stay
    // readable no matter what is painted on top.
    MAP.createPane("relief").style.zIndex = 250;
    MAP.createPane("labels").style.zIndex = 450;
    MAP.getPane("relief").style.pointerEvents = "none";
    MAP.getPane("labels").style.pointerEvents = "none";

    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
      subdomains: "abcd", maxZoom: 18, className: "warm-tiles",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; CARTO, hæðarskygging Esri',
    }).addTo(MAP);
    L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/Elevation/" +
                "World_Hillshade/MapServer/tile/{z}/{y}/{x}", {
      pane: "relief", maxZoom: 16, opacity: 0.5, className: "relief-tiles",
    }).addTo(MAP);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png", {
      subdomains: "abcd", maxZoom: 18, pane: "labels",
    }).addTo(MAP);
    MARKERS = L.layerGroup().addTo(MAP);
    mapControls().addTo(MAP);
    MAP.on("zoomend moveend", layout);
  }
  MARKERS.clearLayers();
  ENTRIES = [];

  clusterStations(stations).forEach(g => {
    const s = g[0];
    const selected = g.some(x => x.nr === SELECTED);
    const badge = entryBadge(g, selected);
    const marker = L.marker([s.lat, s.lon], { icon: badge, riseOnHover: true })
      .bindPopup(() => groupPopup(g), { closeButton: false, offset: [0, -18],
                                        autoPan: false,
                                        maxWidth: g.length > 1 ? 300 : 260 });
    hoverPopup(marker);
    // A click picks the station; a hover only peeks at its measurements.
    marker.on("click", () => selectStation(g[0]));
    marker.on("popupopen", ev => {
      ev.popup.getElement().querySelectorAll(".pop-pick").forEach(b =>
        b.addEventListener("click", cev => {
          cev.stopPropagation();
          selectStation(g.find(x => String(x.nr) === b.dataset.nr) || g[0]);
        }));
    });
    MARKERS.addLayer(marker);
    ENTRIES.push({ marker, badge, dot: dotIcon(windColour(s.spd)),
                   mode: "badge", group: g, selected });
  });

  HOME = L.marker([d.lat, d.lon], {
    icon: L.divIcon({ className: "stn-wrap", html: homeBadge(d, homeIndex()),
                      iconSize: [62, 24], iconAnchor: [31, 28] }),
    zIndexOffset: 1000,
  }).bindPopup(homePopup(d, homeIndex()),
               { closeButton: false, offset: [0, -20], autoPan: false });
  hoverPopup(HOME);
  HOME.on("click", goHome);
  MARKERS.addLayer(HOME);

  if (!FITTED) { fitToStations(); FITTED = true; }
  MAP.invalidateSize();
  ensureCanvas();
  queueField();
  drawLegend();
  layout();
}

const homeIndex = () => (VIEW && VIEW.key === "home" ? SEL : 0);

function updateHome(d, i) {
  if (!HOME || typeof L === "undefined") return;
  HOME.setIcon(L.divIcon({ className: "stn-wrap", html: homeBadge(d, homeIndex()),
                           iconSize: [62, 24], iconAnchor: [31, 28] }));
  HOME.setPopupContent(homePopup(d, homeIndex()));
}

/* --- colour fields ------------------------------------------------------
   Not a model raster: the shading is interpolated from the station network
   itself, inverse-distance weighted in screen space, and it fades out where
   there is no station within reach — so it never claims to know what is
   happening far offshore. Palettes are our own. */

const LAYERS = {
  stodvar: { label: "Stöðvar" },
  t:       { label: "Hiti", unit: "°C" },
  spd:     { label: "Vindur", unit: "m/s" },
  precip:  { label: "Úrkoma", unit: "mm/klst" },
};
/* Each layer is simply on or off; click to add it, click again to remove it.
   Sheets are painted in this order, so rain always ends up on top. */
const ON = { t: false, spd: false, precip: false };
const SHEET_ORDER = ["t", "spd", "precip"];
const activeSheets = () => SHEET_ORDER.filter(k => ON[k]);
// Badges show the first active layer, or everything when none is on.
const badgeLayer = () => activeSheets()[0] || "stodvar";
let CANVAS = null, WIND = null, LEGEND = null;
let PARTICLES = [], FLOW = null, ANIM = null, FIELD_QUEUED = false;

/* stop, r, g, b */
const RAMPS = {
  // Basalt through sea-green and sand to ember: cold end reads as wet stone,
  // warm end as the colour of the sun on it.
  t: [[-12, 46, 62, 78], [-6, 56, 96, 108], [0, 74, 130, 128],
      [5, 110, 158, 138], [10, 168, 186, 142], [14, 224, 204, 150],
      [18, 219, 158, 85], [23, 194, 87, 31], [29, 138, 48, 34]],
  // Still water to storm: pale sand, sage, teal, petrol, deep plum.
  spd: [[0, 244, 240, 231], [4, 205, 219, 200], [8, 150, 190, 180],
        [13, 96, 154, 162], [18, 62, 110, 132], [25, 58, 74, 108],
        [33, 56, 46, 78]],
  // Rain in mint-to-ink rather than the usual blue-to-purple.
  precip: [[0.05, 219, 234, 222], [0.4, 166, 210, 196], [1.2, 96, 172, 168],
           [3, 46, 126, 138], [6, 38, 84, 106], [12, 46, 52, 84]],
};

function rampColour(kind, v) {
  const r = RAMPS[kind];
  if (v === null || v === undefined) return null;
  if (v <= r[0][0]) return r[0].slice(1);
  for (let i = 1; i < r.length; i++) {
    if (v <= r[i][0]) {
      const f = (v - r[i - 1][0]) / (r[i][0] - r[i - 1][0]);
      return [1, 2, 3].map(k => Math.round(r[i - 1][k] + (r[i][k] - r[i - 1][k]) * f));
    }
  }
  return r[r.length - 1].slice(1);
}

function valueOf(st, kind) {
  if (kind === "precip") {
    const f = fieldAt(st.nr, selectedTime());
    return f ? f.precip : null;                 // no station measures rain
  }
  const v = stationValues(st);
  return kind === "t" ? v.t : v.spd;
}

function valueOf(st, kind) {
  if (kind === "precip") {
    const f = fieldAt(st.nr, selectedTime());
    return f ? f.precip : null;                 // no station measures rain
  }
  const v = stationValues(st);
  return kind === "t" ? v.t : v.spd;
}

function collectPoints(kind) {
  const pts = [];
  (DATA.stations || []).forEach(st => {
    if (!st.lat || !st.lon) return;
    const v = valueOf(st, kind);
    if (v === null || v === undefined) return;
    const p = MAP.latLngToContainerPoint([st.lat, st.lon]);
    const w = stationValues(st);
    pts.push({ x: p.x, y: p.y, v,
               dir: w.dir !== null && w.dir !== undefined ? w.dir
                    : (fieldAt(st.nr, selectedTime()) || {}).dir });
  });
  return pts;
}

/* One interpolated sheet of colour, painted onto the given context. */
function paintSheet(ctx, kind, pts, size, reach, alpha) {
  const reach2 = reach * reach;
  const step = 6;
  const cols = Math.ceil(size.x / step), rows = Math.ceil(size.y / step);
  const small = document.createElement("canvas");
  small.width = cols; small.height = rows;
  const sctx = small.getContext("2d");
  const img = sctx.createImageData(cols, rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = i * step + step / 2, y = j * step + step / 2;
      let wsum = 0, vsum = 0, nearest = Infinity;
      for (let k = 0; k < pts.length; k++) {
        const dx = pts[k].x - x, dy = pts[k].y - y;
        const d2 = dx * dx + dy * dy;
        if (d2 > reach2) continue;
        if (d2 < nearest) nearest = d2;
        const w = 1 / (Math.pow(d2, 1.5) + 60);
        wsum += w; vsum += w * pts[k].v;
      }
      const o = (j * cols + i) * 4;
      if (!wsum) { img.data[o + 3] = 0; continue; }
      const value = vsum / wsum;
      const c = rampColour(kind, value);
      if (!c || (kind === "precip" && value < 0.05)) { img.data[o + 3] = 0; continue; }
      const fade = 1 - Math.min(1, Math.sqrt(nearest) / reach);
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
      img.data[o + 3] = Math.round(alpha * Math.pow(fade, 0.55));
    }
  }
  sctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(small, 0, 0, size.x, size.y);
}

function collectPoints(kind) {
  const pts = [];
  (DATA.stations || []).forEach(st => {
    if (!st.lat || !st.lon) return;
    const v = valueOf(st, kind);
    if (v === null || v === undefined) return;
    const p = MAP.latLngToContainerPoint([st.lat, st.lon]);
    const w = stationValues(st);
    pts.push({ x: p.x, y: p.y, v,
               dir: w.dir !== null && w.dir !== undefined ? w.dir
                    : (fieldAt(st.nr, selectedTime()) || {}).dir });
  });
  return pts;
}

/* One interpolated sheet of colour, painted onto the given context. */
function paintSheet(ctx, kind, pts, size, reach, alpha) {
  const reach2 = reach * reach;
  const step = 6;
  const cols = Math.ceil(size.x / step), rows = Math.ceil(size.y / step);
  const small = document.createElement("canvas");
  small.width = cols; small.height = rows;
  const sctx = small.getContext("2d");
  const img = sctx.createImageData(cols, rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = i * step + step / 2, y = j * step + step / 2;
      let wsum = 0, vsum = 0, nearest = Infinity;
      for (let k = 0; k < pts.length; k++) {
        const dx = pts[k].x - x, dy = pts[k].y - y;
        const d2 = dx * dx + dy * dy;
        if (d2 > reach2) continue;
        if (d2 < nearest) nearest = d2;
        const w = 1 / (Math.pow(d2, 1.5) + 60);
        wsum += w; vsum += w * pts[k].v;
      }
      const o = (j * cols + i) * 4;
      if (!wsum) { img.data[o + 3] = 0; continue; }
      const value = vsum / wsum;
      const c = rampColour(kind, value);
      if (!c || (kind === "precip" && value < 0.05)) { img.data[o + 3] = 0; continue; }
      const fade = 1 - Math.min(1, Math.sqrt(nearest) / reach);
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
      img.data[o + 3] = Math.round(alpha * Math.pow(fade, 0.55));
    }
  }
  sctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(small, 0, 0, size.x, size.y);
}

function ensureCanvas() {
  if (!LEGEND) LEGEND = document.getElementById("map-legend-scale");
  if (CANVAS || !MAP) return;
  CANVAS = L.DomUtil.create("canvas", "field-canvas leaflet-zoom-hide");
  WIND = L.DomUtil.create("canvas", "field-canvas wind-canvas leaflet-zoom-hide");
  MAP.getPanes().overlayPane.appendChild(CANVAS);
  MAP.getPanes().overlayPane.appendChild(WIND);
  MAP.on("move zoom resize viewreset", queueField);
}

function queueField() {
  if (FIELD_QUEUED) return;
  FIELD_QUEUED = true;
  raf(() => { FIELD_QUEUED = false; drawField(); });
}

/* Metres per pixel here, so the blend covers a fixed distance on the ground
   rather than a fixed number of pixels. */
function metresPerPixel() {
  const lat = MAP.getCenter().lat * Math.PI / 180;
  return 40075016.686 * Math.cos(lat) / Math.pow(2, MAP.getZoom() + 8);
}

function drawField() {
  if (!MAP || !CANVAS) return;
  const ctx = CANVAS.getContext("2d");
  const size = MAP.getSize();
  [CANVAS, WIND].forEach(c => {
    c.width = size.x; c.height = size.y;
    L.DomUtil.setPosition(c, MAP.containerPointToLayerPoint([0, 0]));
  });
  ctx.clearRect(0, 0, size.x, size.y);
  WIND.getContext("2d").clearRect(0, 0, size.x, size.y);
  stopWind();
  if (!DATA) return;

  // 55 km of influence, weighted by 1/d³ so nearby stations dominate and local
  // contrast survives instead of everything averaging to the same colour.
  const reach = Math.max(60, 55000 / metresPerPixel());
  const sheets = activeSheets();

  sheets.forEach((kind, i) => {
    const pts = collectPoints(kind);
    if (pts.length < 3) return;
    // Rain is transparent where it is dry, so it never needs thinning; a second
    // full-coverage sheet does, or it would simply bury the first.
    const alpha = kind === "precip" ? 165 : i === 0 ? 150 : 105;
    paintSheet(ctx, kind, pts, size, reach, alpha);
  });

  if (ON.spd) {
    const flow = collectPoints("spd");
    if (flow.length >= 3) startWind(flow, reach * reach, size);
  }
}

/* --- moving wind ---------------------------------------------------------
   A coarse velocity grid is interpolated once, then particles are carried
   along it and their trails faded a little each frame. */
function buildFlow(pts, reach2, size) {
  const cell = 14;
  const cols = Math.ceil(size.x / cell) + 1, rows = Math.ceil(size.y / cell) + 1;
  const u = new Float32Array(cols * rows), v = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = i * cell, y = j * cell;
      let wsum = 0, us = 0, vs = 0;
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k];
        if (p.dir === null || p.dir === undefined) continue;
        const dx = p.x - x, dy = p.y - y;
        const d2 = dx * dx + dy * dy;
        if (d2 > reach2) continue;
        const w = 1 / (Math.pow(d2, 1.5) + 60);
        // Bearings say where wind comes from; particles go the other way.
        const to = (p.dir + 180) * Math.PI / 180;
        wsum += w;
        us += w * p.v * Math.sin(to);
        vs += w * p.v * -Math.cos(to);
      }
      const o = j * cols + i;
      u[o] = wsum ? us / wsum : 0;
      v[o] = wsum ? vs / wsum : 0;
    }
  }
  return { u, v, cols, rows, cell };
}

function sampleFlow(x, y) {
  if (!FLOW) return null;
  const gx = x / FLOW.cell, gy = y / FLOW.cell;
  const i = Math.floor(gx), j = Math.floor(gy);
  if (i < 0 || j < 0 || i >= FLOW.cols - 1 || j >= FLOW.rows - 1) return null;
  const fx = gx - i, fy = gy - j;
  const at = (a, b) => b * FLOW.cols + a;
  const mix = (arr) =>
    arr[at(i, j)] * (1 - fx) * (1 - fy) + arr[at(i + 1, j)] * fx * (1 - fy) +
    arr[at(i, j + 1)] * (1 - fx) * fy + arr[at(i + 1, j + 1)] * fx * fy;
  return { u: mix(FLOW.u), v: mix(FLOW.v) };
}

function startWind(pts, reach2, size) {
  FLOW = buildFlow(pts, reach2, size);
  const n = Math.round(Math.min(1400, size.x * size.y / 480));
  PARTICLES = [];
  for (let i = 0; i < n; i++) {
    PARTICLES.push({ x: Math.random() * size.x, y: Math.random() * size.y,
                     age: Math.random() * 90 });
  }
  const ctx = WIND.getContext("2d");
  // Wind at true scale would barely crawl across the screen, so the motion is
  // exaggerated: about 10 m/s reads as 40 pixels a second.
  const stepScale = 0.07 * (1 + Math.max(-0.4, (MAP.getZoom() - 7) * 0.12));
  const tick = () => {
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,0.09)";                        // fade old trails
    ctx.fillRect(0, 0, size.x, size.y);
    ctx.globalCompositeOperation = "source-over";
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = "rgba(255,250,240,0.88)";
    ctx.beginPath();
    PARTICLES.forEach(p => {
      const f = sampleFlow(p.x, p.y);
      p.age += 1;
      if (!f || p.age > 110) {
        p.x = Math.random() * size.x; p.y = Math.random() * size.y; p.age = 0;
        return;
      }
      const nx = p.x + f.u * stepScale, ny = p.y + f.v * stepScale;
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(nx, ny);
      p.x = nx; p.y = ny;
    });
    ctx.stroke();
    ANIM = requestAnimationFrame(tick);
  };
  stopWind();
  ANIM = requestAnimationFrame(tick);
}

function stopWind() {
  if (ANIM) { cancelAnimationFrame(ANIM); ANIM = null; }
}

function drawLegend() {
  if (!LEGEND) LEGEND = document.getElementById("map-legend-scale");
  if (!LEGEND) return;
  const scale = kind => {
    const r = RAMPS[kind];
    const lo = r[0][0], hi = r[r.length - 1][0];
    const stops = r.map(x =>
      `rgb(${x.slice(1).join(",")}) ${((x[0] - lo) / (hi - lo) * 100).toFixed(1)}%`)
      .join(",");
    const ticks = r.filter((_, i) => i % 2 === 0 || i === r.length - 1)
      .map(x => `<span>${x[0]}</span>`).join("");
    return `<div class="lg-one"><div class="lg-title">${LAYERS[kind].label}
        <em>${LAYERS[kind].unit}</em></div>
      <div class="lg-bar" style="background:linear-gradient(90deg,${stops})"></div>
      <div class="lg-ticks">${ticks}</div></div>`;
  };
  let out = activeSheets().map(scale).join("");
  if (ON.spd) out += `<div class="lg-one lg-note">Hvítu agnirnar fylgja vindinum.</div>`;
  LEGEND.innerHTML = out;
}

function toggleLayer(name) {
  ON[name] = !ON[name];
  syncLayerButtons();
  drawLegend();
  queueField();
  refreshStations();
}

function syncLayerButtons() {
  document.querySelectorAll(".layer-btn").forEach(b =>
    b.classList.toggle("on", !!ON[b.dataset.layer]));
}

/* --- the hour slider ---------------------------------------------------- */

let SEL = 0;

/* The thumb of a range input travels from half its width to width minus half,
   so day names and ticks are positioned the same way to line up with it. */
const scrubPos = (i, n) => `calc(9px + (100% - 18px) * ${(i / (n - 1)).toFixed(5)})`;

function buildScrub(view) {
  const hrs = view.hours, n = hrs.length;
  const card = document.getElementById("scrub-card");
  card.classList.toggle("hidden", n < 2);
  if (n < 2) return;
  const input = document.getElementById("scrub");
  input.max = String(n - 1);
  if (SEL > n - 1) SEL = 0;
  input.value = String(SEL);

  const days = [];
  hrs.forEach((h, i) => {
    const key = h.valid.slice(0, 10);
    const last = days[days.length - 1];
    if (!last || last.key !== key) days.push({ key, from: i, to: i, dt: new Date(h.valid) });
    else last.to = i;
  });
  const today = new Date().toISOString().slice(0, 10);
  const narrow = window.innerWidth < 760;   // full day names do not fit on a phone
  document.getElementById("scrub-days").innerHTML = days.map((g, k) => {
    const mid = Math.round((g.from + g.to) / 2);
    const name = g.key === today ? "Í dag"
      : narrow ? DAY_SHORT[g.dt.getUTCDay()] : DAYS[g.dt.getUTCDay()];
    return (k ? `<span class="sep" style="left:${scrubPos(g.from, n)}"></span>` : "") +
      `<button class="dayname" data-hour="${mid}" style="left:${scrubPos(mid, n)}"
        >${name}</button>`;
  }).join("");

  document.getElementById("scrub-ticks").innerHTML = hrs.map((h, i) => {
    const hh = new Date(h.valid).getUTCHours();
    if (hh % 6) return "";
    return `<span class="tick${hh % 12 ? " minor" : ""}"
      style="left:${scrubPos(i, n)}">${String(hh).padStart(2, "0")}</span>`;
  }).join("");
}

/* --- panels ------------------------------------------------------------- */

/* Hour 0 shows what the stations are measuring; later hours show the forecast. */
function renderConditions(i) {
  const d = DATA, v = VIEW;
  const home = v.key === "home";
  const live = i === 0;
  const n = v.now, h = v.hours[i] || {};
  const ts = live ? (n.ts ? new Date(n.ts) : new Date(d.issued)) : new Date(h.valid);
  const cloud = live ? n.cloud : h.cloud;
  const precip = live ? 0 : (h.precip || 0);
  const night = ts.getUTCHours() < 4 || ts.getUTCHours() > 21;

  document.getElementById("place-name").textContent = v.name;
  const back = document.getElementById("back-home");
  back.classList.toggle("hidden", home);
  back.textContent = "← " + d.place;
  document.getElementById("now-title").textContent = live ? "Veðrið núna" : "Spáin";
  document.getElementById("now-time").textContent = "Kl. " + hhmm(ts);
  document.getElementById("now-symbol").innerHTML =
    cloud == null && live ? "" : symbol(cloud, precip, night);
  document.getElementById("now-word").textContent =
    cloud == null && live ? "" : skyWord(cloud, precip);

  const marine = home ? (d.analysis.marine || {}) : {};
  const rows = live ? [
    ["Vindur", n.spd == null ? "—" :
      `${arrow(n.dir)}${compass(n.dir)} ${Math.round(n.spd)} m/s`],
    ["Hiti", n.t == null ? "—" : `${round(n.t, 1)}°C`],
    ["Vindhviður", n.gust == null ? null : `${Math.round(n.gust)} m/s`],
    ["Veghiti", v.station && v.station.troad != null ?
      `${round(v.station.troad, 1)}°C` : null],
    ["Rakastig", n.rh == null ? null : `${Math.round(n.rh)}%`],
    ["Skýjahula", n.cloud == null ? null : `${n.cloud}%`],
    ["Loftþrýstingur", n.p == null ? null : `${round(n.p, 1)} hPa`],
    ["Hæð yfir sjó", v.station && v.station.alt != null ?
      `${Math.round(v.station.alt)} m` : null],
    ["Sjávarhiti", marine.sst == null ? null : `${round(marine.sst, 1)}°C`],
    ["Ölduhæð", marine.hs == null ? null : `${round(marine.hs, 1)} m`],
  ] : [
    ["Vindur", h.spd == null ? "—" :
      `${arrow(h.dir)}${compass(h.dir)} ${Math.round(h.spd)} m/s`],
    ["Hiti", h.t == null ? "—" : `${round(h.t, 1)}°C`],
    ["Vindhviður", h.gust == null ? null : `${Math.round(h.gust)} m/s`],
    ["Rakastig", h.rh == null ? null : `${Math.round(h.rh)}%`],
    ["Skýjahula", h.cloud == null ? null : `${Math.round(h.cloud)}%`],
    ["Úrkoma / klst", h.precip == null ? null : `${h.precip.toFixed(1)} mm`],
  ];
  document.getElementById("now-list").innerHTML = rows
    .filter(r => r[1] !== null && r[1] !== undefined)
    .map(([k, v2]) => `<dt>${k}</dt><dd>${v2}</dd>`).join("");

  const obsAt = n.ts ? new Date(n.ts) : new Date(d.issued);
  const age = (Date.now() - obsAt.getTime()) / 60000;
  document.getElementById("map-sub").textContent =
    `${d.stations.length} stöðvar`;
  const mapAt = v.hours[i] ? hhmm(new Date(v.hours[i].valid)) : "";
  const where = home ? "" :
    `Valin stöð: <strong>${v.name}</strong>, ${v.station.km} km frá ${d.place}. `;
  document.getElementById("map-legend").innerHTML = where + (live
    ? "Kortið sýnir mælingar frá stöðvum Vegagerðarinnar. Smelltu á stöð til að fá spá fyrir hana."
    : FIELD
      ? (FIELD.derived
        ? `Kortið sýnir spá fyrir stöðvarnar kl. ${mapAt}, leidda af mælingum ` +
          `þeirra og spánni fyrir ${d.place} — reiknilíkanið náðist ekki í bili.`
        : `Kortið sýnir spá reiknilíkans fyrir allar stöðvar kl. ${mapAt}.`)
      : `Kortið sýnir mælingar kl. ${hhmm(obsAt)} — spá fyrir stöðvarnar er ekki tiltæk.`);

  let notice =
    `Spáin er reiknuð sjálfvirkt á mæligögnum og reiknilíkani og er ekki ` +
    `yfirfarin af veðurfræðingi. Opinberar spár og viðvaranir eru á ` +
    `<a href="https://www.vedur.is">vedur.is</a>.`;
  if (v.loading) notice += "<br>Sæki spár fyrir stöðina…";
  if (v.error) notice += `<br><span class="stale">Náði ekki í spá fyrir þessa stöð. ` +
    `Mælingarnar hér að ofan eru samt réttar.</span>`;
  if (live && age > 60) notice +=
    `<br><span class="stale">Mæligögn eru ${Math.round(age)} mín gömul.</span>`;
  document.getElementById("notice-text").innerHTML = notice;
}

function renderChip(view) {
  const med = ((view && view.median) || []).filter(m => m.t !== null);
  const chip = document.getElementById("ensemble-chip");
  if (!med.length) { chip.style.display = "none"; return; }
  chip.style.display = "";
  chip.href = view.station ? `samanburdur.html?stn=${view.station.nr}`
                           : "samanburdur.html";
  const now = Date.now();
  const m = med.find(x => new Date(x.valid).getTime() >= now - 1800e3) || med[0];
  document.getElementById("chip-temp").textContent = `${m.t.toFixed(1)}°`;
  document.getElementById("chip-wind").innerHTML =
    `${arrow(m.dir)}${Math.round(m.spd)} m/s`;
  document.getElementById("chip-sub").textContent =
    `miðgildi ${m.n} spáa · bil ${m.t_low.toFixed(0)}–${m.t_high.toFixed(0)}°`;
}

function renderHours(from) {
  const hrs = VIEW.hours;
  const body = document.getElementById("hours-body");
  if (!hrs.length) {
    body.innerHTML = `<tr><td colspan="6" class="muted">${
      VIEW.loading ? "Sæki spá fyrir stöðina…" : "Engin spá tiltæk fyrir þessa stöð."
    }</td></tr>`;
    return;
  }
  const rows = hrs.slice(from, from + 24).map(h => ({ ...h, d: new Date(h.valid) }));
  body.innerHTML = rows.map((h, k) => {
    const night = h.d.getUTCHours() < 4 || h.d.getUTCHours() > 21;
    const rh = h.rh == null ? "—" : `${Math.round(h.rh)} <span class="unit">%</span>`;
    const label = h.d.getUTCHours() === 0
      ? `${DAY_SHORT[h.d.getUTCDay()]} ${hhmm(h.d)}` : hhmm(h.d);
    return `<tr class="${k === 0 ? "sel" : ""}" data-hour="${from + k}">
      <td class="time">${label}</td>
      <td>${symbol(h.cloud, h.precip || 0, night)}</td>
      <td class="num temp">${round(h.t, 0)} °C</td>
      <td class="wind">${arrow(h.dir)}${Math.round(h.spd)} <span class="unit">m/s</span></td>
      <td class="num pcp">${(h.precip || 0).toFixed(1)} <span class="unit">mm</span></td>
      <td class="num rh">${rh}</td>
    </tr>`;
  }).join("");
}

function renderDays(view) {
  const byDay = new Map();
  view.hours.forEach(h => {
    const dt = new Date(h.valid);
    const key = dt.toISOString().slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push({ ...h, d: dt });
  });
  const today = new Date().toISOString().slice(0, 10);
  const out = [...byDay.entries()]
    // Drop a trailing part-day so the last row is not built from three hours.
    .filter(([key, hs]) => hs.length >= 6 || key === today)
    .slice(0, 7)
    .map(([key, hs]) => {
      const temps = hs.map(h => h.t).filter(t => t !== null);
      const hi = Math.max(...temps), lo = Math.min(...temps);
      const windiest = hs.reduce((a, b) => (a.spd > b.spd ? a : b));
      // Daytime hours describe the day better than a flat 24-hour mean.
      const day = hs.filter(h => h.d.getUTCHours() >= 8 && h.d.getUTCHours() <= 20);
      const sample = day.length ? day : hs;
      const cloud = sample.reduce((a, h) => a + (h.cloud || 0), 0) / sample.length;
      const rain = hs.reduce((a, h) => a + (h.precip || 0), 0);
      const dt = hs[0].d;
      const name = key === today ? "Í dag" : DAYS[dt.getUTCDay()];
      const date = `${dt.getUTCDate()}.${dt.getUTCMonth() + 1}.`;
      return `<div class="day">
        <div class="name">${name}<span class="date">${date}</span></div>
        <div>${symbol(cloud, rain / hs.length, false)}</div>
        <div>
          <span class="range"><span class="hi">${Math.round(hi)}°</span>
            <span class="lo">/ ${Math.round(lo)}°</span></span>
          <span class="detail"> · ${skyWord(cloud, rain / hs.length)} ·
            mest ${compass(windiest.dir)} ${Math.round(windiest.spd)} m/s${
              rain > 0.3 ? ` · ${rain.toFixed(1)} mm` : ""}</span>
        </div></div>`;
    });
  document.getElementById("days-body").innerHTML = out.join("") +
    `<p class="legend days-note">Spá lengra en sólarhring fram í tímann kemur frá
      reiknilíkani og er ekki leiðrétt með mælingum að sama marki og næstu klukkustundir.</p>`;
}

/* The Greining tab. For the home town it comes from the analysis the build
   wrote; for a station it is worked out here from that station's own
   measurements plus the network-wide pressure field. */
function stationNotes(view, d) {
  const st = view.station, a = d.analysis, lines = [];
  const num = (v, n = 1) => v.toFixed(n).replace(".", ",");
  const bits = [];
  if (st.t != null) bits.push(`hiti ${num(st.t)} °C`);
  if (st.spd != null) bits.push(`vindur ${compass(st.dir)} ${num(st.spd)} m/s`);
  if (st.rh != null) bits.push(`rakastig ${num(st.rh, 0)}%`);
  lines.push(`Núna á stöðinni ${st.name}: ${bits.join(", ")} — mælt kl. ` +
    `${hhmm(new Date(st.ts))}, ${st.km} km frá ${d.place}.`);

  if (a.gradient) {
    lines.push(`Þrýstisvið yfir landinu: ${num(a.gradient.grad_hpa_per_100km)} ` +
      `hPa á 100 km, sem gefur þrýstivind af ${compass(a.gradient.dir)}, um ` +
      `${num(a.gradient.speed, 0)} m/s (reiknað úr ${a.gradient.n} loftvogum).`);
  }
  const sun = stationSun(view);
  if (sun) {
    lines.push(`Vegyfirborðið á stöðinni mælist ${num(sun.excess)} °C hlýrra en ` +
      `loftið, sem bendir til þess að nú sé ${skyWord(sun.cloud, 0).toLowerCase()}.`);
  }
  if (st.alt != null) {
    lines.push(`Stöðin stendur í ${Math.round(st.alt)} m hæð yfir sjó, sem skýrir ` +
      `oft muninn á henni og nálægum stöðvum.`);
  }
  if (a.tendency && a.tendency.p) {
    const v = a.tendency.p.per_hour;
    const word = v > 0.15 ? "fer hækkandi" : v < -0.15 ? "fer lækkandi" : "stendur í stað";
    lines.push(`Loftþrýstingur ${word}, ${(v > 0 ? "+" : "") + num(v, 2)} hPa á klst.`);
  }
  const day = view.hours.slice(0, 16).filter(h => h.t !== null);
  if (day.length) {
    const hi = Math.max(...day.map(h => h.t)), lo = Math.min(...day.map(h => h.t));
    const peak = day.reduce((x, y) => (x.spd > y.spd ? x : y));
    lines.push(`Næstu 15 klukkustundir: hiti ${num(lo, 0)} til ${num(hi, 0)} °C, ` +
      `mestur vindur ${compass(peak.dir)} ${num(peak.spd, 0)} m/s um kl. ` +
      `${hhmm(new Date(peak.valid))}.`);
  }
  const n = view.sources ? view.sources.length : 0;
  if (n) {
    lines.push(`Spáin er miðgildi ${n} reiknilíkana, dregin að mælingum ` +
      `stöðvarinnar fyrstu klukkustundirnar.`);
  }
  return lines;
}

/* Road surface warmer than the air means sun on it; how much warmer it should
   be depends on how high the sun is. */
function stationSun(view) {
  const st = view.station;
  if (!st || st.troad == null || st.t == null) return null;
  const el = solarElevation(st.lat, st.lon, st.ts ? new Date(st.ts) : new Date());
  if (el < 5) return null;
  const expected = 6.5 * Math.sin(el * Math.PI / 180);
  const excess = st.troad - st.t;
  const index = Math.max(0, Math.min(1, excess / expected));
  return { excess, index, cloud: Math.round(100 * (1 - index)) };
}

function renderWhy(view) {
  const d = DATA, a = d.analysis;
  const home = view.key === "home";
  document.getElementById("why-body").innerHTML =
    (home ? (a.notes || []) : stationNotes(view, d))
      .map(n => `<li>${n}</li>`).join("");

  const cells = [];
  if (a.gradient) {
    cells.push(["Þrýstivindur",
      `${compass(a.gradient.dir)} ${Math.round(a.gradient.speed)} m/s`]);
    cells.push(["Þrýstibratti",
      `${a.gradient.grad_hpa_per_100km.toFixed(1)} hPa/100 km`]);
  }
  const sun = home ? (a.sun && a.sun.index != null ? { index: a.sun.index } : null)
                   : stationSun(view);
  if (sun) cells.push(["Sólstuðull", `${Math.round(sun.index * 100)}%`]);
  if (home && a.breeze)
    cells.push(["Hafgola", `${Math.round(a.breeze.probability * 100)}%`]);
  if (!home && view.station.alt != null)
    cells.push(["Hæð yfir sjó", `${Math.round(view.station.alt)} m`]);
  if (a.tendency && a.tendency.p)
    cells.push(["Þrýstibreyting", `${a.tendency.p.per_hour.toFixed(2)} hPa/klst`]);
  if (home && a.marine && a.marine.hs != null)
    cells.push(["Kennialda", `${a.marine.hs.toFixed(1)} m`]);
  if (!home && view.median && view.median.length)
    cells.push(["Spár að baki", `${view.median[0].n}`]);
  document.getElementById("why-grid").innerHTML = cells
    .map(([k, v]) => `<div><span>${k}</span><strong>${v}</strong></div>`).join("");
}

function renderScore(d) {
  const v = d.verification || {};
  const intro = document.getElementById("score-intro");
  const body = document.getElementById("score-body");
  if (!v.pairs) {
    intro.textContent = "Spár eru bornar saman við mælingar eftir á. " +
      "Fyrstu niðurstöður birtast eftir um sólarhring.";
    body.innerHTML = "";
    return;
  }
  intro.textContent = `Meðalskekkja Veðurvaktar síðustu 30 daga, byggð á ` +
    `${v.pairs} samanburðum spáa við mælingar. Skekkjan er dregin frá næstu spá.`;
  body.innerHTML = Object.entries(v.leads).map(([lead, s]) => `<tr>
    <td class="time">${lead.replace("h", " klst")}</td>
    <td class="num">${s.temp_mae} °C</td>
    <td class="num">${s.wind_mae === null ? "—" : s.wind_mae + " m/s"}</td>
    <td class="num">${s.n}</td></tr>`).join("");
}

/* --- wiring ------------------------------------------------------------- */

function relativeHumidity(t, td) {
  if (t === null || td === null || t === undefined || td === undefined) return null;
  const es = x => 6.112 * Math.exp(17.62 * x / (243.12 + x));
  return Math.max(5, Math.min(100, 100 * es(td) / es(t)));
}

let DATA = null;

/* Everything that depends on which hour the slider is on. */
function applySelection() {
  if (!DATA || !VIEW) return;
  const hrs = VIEW.hours;
  const i = hrs.length ? Math.max(0, Math.min(SEL, hrs.length - 1)) : 0;
  SEL = i;
  const input = document.getElementById("scrub");
  if (input) input.value = String(i);
  if (hrs.length) {
    const dt = new Date(hrs[i].valid);
    const today = new Date().toISOString().slice(0, 10);
    const name = hrs[i].valid.slice(0, 10) === today ? "Í dag" : DAYS[dt.getUTCDay()];
    document.getElementById("scrub-when").innerHTML =
      `<strong>${name}</strong> ${dt.getUTCDate()}.${dt.getUTCMonth() + 1}. kl. ${hhmm(dt)}` +
      `<span class="muted"> · ${i === 0 ? "mælingar" : "spá"}</span>`;
  }
  document.getElementById("scrub-now").classList.toggle("on", i === 0);
  document.querySelectorAll(".dayname").forEach(b =>
    b.classList.toggle("on", b.dataset.hour == String(i)));
  renderConditions(i);
  renderHours(i);
  updateHome(DATA, i);
  refreshStations();
  queueField();
}

/* Everything that changes when the place changes. */
function paintView() {
  buildScrub(VIEW);
  applySelection();
  renderDays(VIEW);
  renderChip(VIEW);
  renderWhy(VIEW);
}

function render(d) {
  // The physics fallback has no humidity forecast; derive it from the dew point.
  const td = d.now.td;
  d.hours.forEach(h => { if (h.rh == null) h.rh = relativeHumidity(h.t, td); });
  DATA = d;

  // Keep the picked station across the five-minute refresh.
  const keep = VIEW && VIEW.station
    ? d.stations.find(s => s.nr === VIEW.station.nr) : null;
  VIEW = keep ? stationView(keep, STN_CACHE[keep.nr]) : homeView(d);
  SELECTED = keep ? keep.nr : null;

  renderMap(d);
  paintView();
  renderScore(d);

  const issued = new Date(d.issued);
  document.getElementById("foot").innerHTML =
    `Spá gefin út ${String(issued.getUTCDate()).padStart(2, "0")}.` +
    `${String(issued.getUTCMonth() + 1).padStart(2, "0")}. kl. ${hhmm(issued)}. ` +
    `Mæligögn: <a href="https://gagnaveita.vegagerdin.is">Gagnaveita Vegagerðarinnar</a>` +
    ` og <a href="https://sjolag.is">Sjólag</a>.<br>` +
    `Veðurvakt reiknar spána sjálfvirkt og leiðréttir sig eftir eigin skekkju. ` +
    `Ekki nota hana í stað opinberra viðvarana.<br>` +
    `<a href="skilmalar.html">Skilmálar</a> · ` +
    `<a href="personuvernd.html">Persónuvernd</a> · ` +
    `<a href="heimildir.html">Heimildir</a>`;
}

function switchTab(name) {
  document.querySelectorAll(".tab").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === name));
  ["today", "days", "why", "score"].forEach(p =>
    document.getElementById("panel-" + p).classList.toggle("hidden", p !== name));
}

document.querySelectorAll(".tab").forEach(b =>
  b.addEventListener("click", () => switchTab(b.dataset.tab)));

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (DATA) { buildScrub(DATA); applySelection(); layout(); }
  }, 200);
});

document.getElementById("scrub").addEventListener("input", ev => {
  SEL = Number(ev.target.value);
  applySelection();
});
document.getElementById("scrub-now").addEventListener("click", () => {
  SEL = 0;
  applySelection();
});
document.getElementById("back-home").addEventListener("click", goHome);
document.querySelectorAll(".layer-btn").forEach(b =>
  b.addEventListener("click", () => toggleLayer(b.dataset.layer)));
document.getElementById("scrub-days").addEventListener("click", ev => {
  const b = ev.target.closest(".dayname");
  if (!b) return;
  SEL = Number(b.dataset.hour);
  applySelection();
});
// Clicking a row in the table moves the slider to that hour.
document.getElementById("hours-body").addEventListener("click", ev => {
  const tr = ev.target.closest("tr[data-hour]");
  if (!tr) return;
  SEL = Number(tr.dataset.hour);
  applySelection();
});
// Left/right arrows step through the forecast from anywhere on the page.
document.addEventListener("keydown", ev => {
  if (ev.key === "Escape" && document.body.classList.contains("mapfull")) {
    toggleFullMap(false);
    return;
  }
  if (ev.target.tagName === "INPUT" || !DATA) return;
  if (ev.key === "ArrowRight") { SEL += 1; applySelection(); }
  else if (ev.key === "ArrowLeft") { SEL -= 1; applySelection(); }
});

/* On the first visit, open on the station nearest the visitor — if they say
   yes to the browser's location prompt. Refused or unavailable, the home town
   stands. Asked once per session only. */
let ASKED_LOCATION = false;

function openNearest(payload) {
  if (ASKED_LOCATION || SELECTED || typeof navigator === "undefined" ||
      !navigator.geolocation) return;
  ASKED_LOCATION = true;
  navigator.geolocation.getCurrentPosition(pos => {
    const found = nearestStation(payload, pos.coords.latitude, pos.coords.longitude);
    // Only worth switching if it is genuinely near; otherwise the home town stands.
    if (found && found.km < 120 && !SELECTED) selectStation(found.st);
  }, () => {}, { timeout: 8000, maximumAge: 600000 });
}

function nearestStation(payload, lat, lon) {
  let best = null, bestKm = Infinity;
  (payload.stations || []).forEach(st => {
    if (!st.lat || !st.lon) return;
    const km = kmApart({ lat, lon }, st);
    if (km < bestKm) { bestKm = km; best = st; }
  });
  return best ? { st: best, km: bestKm } : null;
}

async function load() {
  try {
    const res = await fetch("data/latest.json?t=" + Date.now());
    if (!res.ok) throw new Error(res.status);
    const payload = await res.json();
    render(payload);
    // Coming back from the comparison page: index.html#stn=NR reopens a station.
    const wanted = new URLSearchParams(location.hash.slice(1)).get("stn");
    if (wanted && !SELECTED) {
      const st = (payload.stations || []).find(x => String(x.nr) === wanted);
      if (st) selectStation(st);
    } else {
      openNearest(payload);
    }
  } catch (err) {
    document.getElementById("place-name").textContent = "Engin gögn";
    document.getElementById("notice-text").textContent =
      "Náði ekki í data/latest.json. Keyrðu 'python3 vedurvakt.py build' eða bíddu " +
      "eftir næstu sjálfvirku uppfærslu.";
  }
}

load();
setInterval(load, 5 * 60 * 1000);
