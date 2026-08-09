/* Shared helpers: both the dashboard and the comparison page use these. */

const POINTS = ["N","NNA","NA","ANA","A","ASA","SA","SSA",
                "S","SSV","SV","VSV","V","VNV","NV","NNV"];
const DAYS = ["sunnudagur","mánudagur","þriðjudagur","miðvikudagur",
              "fimmtudagur","föstudagur","laugardagur"];

const compass = d => (d === null || d === undefined) ? "—"
  : POINTS[Math.round(((d % 360) / 22.5)) % 16];
const hhmm = d => String(d.getUTCHours()).padStart(2, "0") + ":00";
const round = (v, n = 0) => (v === null || v === undefined) ? null : Number(v.toFixed(n));

function skyWord(cloud, precip) {
  if (precip > 0.6) return "Rigning";
  if (precip > 0.1) return "Skúrir";
  if (cloud === null || cloud === undefined) return "—";
  if (cloud < 15) return "Heiðskírt";
  if (cloud < 40) return "Léttskýjað";
  if (cloud < 70) return "Skýjað að hluta";
  if (cloud < 90) return "Skýjað";
  return "Alskýjað";
}

/* --- symbols ------------------------------------------------------------ */

const SUN = `<circle cx="23" cy="21" r="9" fill="var(--sun)"/>` +
  [0, 45, 90, 135, 180, 225, 270, 315].map(a => {
    const r = a * Math.PI / 180;
    const x1 = 23 + Math.cos(r) * 12, y1 = 21 + Math.sin(r) * 12;
    const x2 = 23 + Math.cos(r) * 15.5, y2 = 21 + Math.sin(r) * 15.5;
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}"
      y2="${y2.toFixed(1)}" stroke="var(--sun)" stroke-width="2.6" stroke-linecap="round"/>`;
  }).join("");

const MOON = `<path d="M28 24a10 10 0 1 1-9-13 8 8 0 0 0 9 13z" fill="#C3CEDE"/>`;

const cloudPath = (fill, dx = 0, dy = 0) =>
  `<path transform="translate(${dx} ${dy})" fill="${fill}"
    d="M20 44c-6 0-11-4.6-11-10.4 0-5.3 4.2-9.7 9.6-10.3C20.6 17.6 26 13.6 32.4 13.6
       c7.7 0 14 5.8 14.7 13.2 4.9.5 8.7 4.4 8.7 9.2C55.8 41.2 51 45 45.2 45H20z"/>`;

function symbol(cloud, precip, night) {
  const c = cloud === null || cloud === undefined ? 50 : cloud;
  let inner;
  if (precip > 0.1) {
    inner = cloudPath("var(--cloud-dark)", 0, -2) +
      [22, 32, 42].map((x, i) =>
        `<line x1="${x}" y1="${46 + (i % 2)}" x2="${x - 4}" y2="${54 + (i % 2)}"
          stroke="var(--rain)" stroke-width="3" stroke-linecap="round"/>`).join("");
  } else if (c < 18) {
    inner = night ? MOON : SUN;
  } else if (c < 62) {
    inner = (night ? MOON : SUN) + cloudPath("var(--cloud)", 4, 4);
  } else if (c < 88) {
    inner = cloudPath("var(--cloud)", 0, 0) + cloudPath("#D6DEE9", -6, 6);
  } else {
    inner = cloudPath("var(--cloud-dark)", 2, -3) + cloudPath("var(--cloud)", -4, 4);
  }
  return `<svg class="sym" viewBox="0 0 64 62" aria-hidden="true">${inner}</svg>`;
}

/* Arrow points the way the wind is going, like the arrows on vedur.is. */
function arrow(dir) {
  if (dir === null || dir === undefined) return "";
  // The drawn arrow points south, i.e. bearing 180. Rotating it clockwise by
  // the wind direction lands it on dir+180 — the way the wind is travelling.
  const rot = ((dir % 360) + 360) % 360;
  return `<svg class="arrow" viewBox="0 0 16 16" aria-hidden="true">
    <g transform="rotate(${rot.toFixed(0)} 8 8)">
      <path d="M8 1.5 L8 14.5 M8 14.5 L4.4 10.6 M8 14.5 L11.6 10.6"
        stroke="currentColor" stroke-width="1.8" fill="none"
        stroke-linecap="round" stroke-linejoin="round"/>
    </g></svg>`;
}

const DAY_SHORT = ["sun", "mán", "þri", "mið", "fim", "fös", "lau"];

/* --- forecasts for any point -------------------------------------------- */

/* The same seven global models the build fetches for the home town, in one
   request. Labels match the ones on the comparison page. */
const OM_MODELS = [
  ["ecmwf_ifs025", "ECMWF IFS", "Evrópska reiknimiðstöðin"],
  ["knmi_seamless", "HARMONIE", "KNMI"],
  ["icon_seamless", "ICON", "DWD"],
  ["ukmo_seamless", "UKMO", "Breska veðurstofan"],
  ["meteofrance_seamless", "AROME/ARPEGE", "Météo-France"],
  ["gfs_seamless", "GFS", "NOAA"],
  ["gem_seamless", "GEM", "Umhverfisstofnun Kanada"],
];

const OM_FIELDS = ["temperature_2m", "relative_humidity_2m", "wind_speed_10m",
                   "wind_direction_10m", "wind_gusts_10m", "cloud_cover",
                   "precipitation"];

const median = xs => {
  const v = xs.filter(x => x !== null && x !== undefined).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/* Directions are averaged through their vector, so forecasts either side of
   north do not come out as south. The resultant length measures agreement. */
function directionMedian(dirs) {
  const v = dirs.filter(d => d !== null && d !== undefined);
  if (!v.length) return { dir: null, agree: 0 };
  let x = 0, y = 0;
  v.forEach(d => { x += Math.cos(d * Math.PI / 180); y += Math.sin(d * Math.PI / 180); });
  return {
    dir: (Math.atan2(y / v.length, x / v.length) * 180 / Math.PI + 360) % 360,
    agree: Math.hypot(x, y) / v.length,
  };
}

function buildMedianSeries(sources, limit = 49) {
  const index = sources.map(s => {
    const m = {};
    s.hours.forEach(h => { m[h.valid] = h; });
    return m;
  });
  const grid = (sources[0] ? sources[0].hours : []).slice(0, limit).map(h => h.valid);
  return grid.map(valid => {
    const rows = index.map(m => m[valid]).filter(Boolean);
    const temps = rows.map(r => r.t).filter(t => t !== null && t !== undefined);
    const t = median(temps);
    const { dir, agree } = directionMedian(rows.map(r => r.dir));
    return {
      valid, t, n: rows.length, dir, dir_agree: agree,
      spd: median(rows.map(r => r.spd)),
      precip: median(rows.map(r => r.precip)),
      cloud: median(rows.map(r => r.cloud)),
      rh: median(rows.map(r => r.rh)),
      t_low: temps.length ? Math.min(...temps) : null,
      t_high: temps.length ? Math.max(...temps) : null,
      spread: temps.length ? Math.max(...temps) - Math.min(...temps) : 0,
    };
  }).filter(m => m.t !== null);
}

/* Every forecast available for one station: the models, plus Veðurvakt's own
   member, which is the median pulled toward what the station is measuring now
   — the same correction the home forecast gets. */
async function fetchStationEnsemble(st) {
  const url = "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${st.lat.toFixed(4)}&longitude=${st.lon.toFixed(4)}` +
    `&hourly=${OM_FIELDS.join(",")}&wind_speed_unit=ms&timezone=UTC` +
    `&forecast_days=8&models=${OM_MODELS.map(m => m[0]).join(",")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status);
  const h = (await res.json()).hourly;
  const from = Math.floor(Date.now() / 3600e3) * 3600e3;

  const keep = [];
  h.time.forEach((t, i) => {
    if (new Date(t + "Z").getTime() >= from) keep.push(i);
  });
  const rows = keep.slice(0, 169);

  const sources = OM_MODELS.map(([key, label, provider]) => {
    const at = f => h[`${f}_${key}`] || [];
    const hours = rows.map(i => ({
      valid: new Date(h.time[i] + "Z").toISOString(),
      t: at("temperature_2m")[i], rh: at("relative_humidity_2m")[i],
      spd: at("wind_speed_10m")[i], dir: at("wind_direction_10m")[i],
      gust: at("wind_gusts_10m")[i], cloud: at("cloud_cover")[i],
      precip: at("precipitation")[i],
    })).filter(x => x.t !== null && x.t !== undefined);
    return { key, label, provider, fetched: new Date().toISOString(),
             stale: false, hours };
  }).filter(s => s.hours.length);

  if (!sources.length) throw new Error("engin spá");

  const own = correctToStation(buildMedianSeries(sources, 169), st);
  const all = sources.concat([{
    key: "vakt", label: "Veðurvakt", provider: "leiðrétt með mælingum stöðvarinnar",
    fetched: new Date().toISOString(), stale: false, hours: own,
  }]);
  return { sources: all, median: buildMedianSeries(all, 49), hours: own };
}

/* Blend the first hours toward the station's own measurements, the weight
   fading over about eight hours — step one of the home correction. */
function correctToStation(rows, st) {
  const now = Date.now();
  return rows.map(r => {
    const lead = Math.max(0, (Date.parse(r.valid) - now) / 3600e3);
    const w = Math.exp(-lead / 2.5);
    const out = { valid: r.valid, t: r.t, spd: r.spd, dir: r.dir,
                  cloud: r.cloud, precip: r.precip, rh: r.rh, gust: null };
    if (st.t !== null && st.t !== undefined && r.t !== null) {
      out.t = Math.round((r.t * (1 - w) + st.t * w) * 10) / 10;
    }
    if (st.spd !== null && st.spd !== undefined && r.spd !== null) {
      out.spd = Math.round((r.spd * (1 - w) + st.spd * w) * 10) / 10;
    }
    if (st.dir !== null && st.dir !== undefined && r.dir !== null) {
      const delta = ((st.dir - r.dir + 180) % 360 + 360) % 360 - 180;
      out.dir = (r.dir + delta * w + 360) % 360;
    }
    out.gust = out.spd === null ? null : Math.round(out.spd * 1.45 * 10) / 10;
    return out;
  });
}

/* Sun angle, needed to judge how much warmer than the air a sunlit road
   surface ought to be. Same approximation the Python side uses — good to about
   a degree, which is plenty. */
function solarElevation(lat, lon, date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const day = Math.floor((date.getTime() - start) / 86400e3);
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
  const rad = x => x * Math.PI / 180;
  const decl = rad(23.44) * Math.sin(rad(360 / 365.24 * (day - 81)));
  const ha = rad(15 * (hour + lon / 15 - 12));
  const p = rad(lat);
  const sinEl = Math.sin(p) * Math.sin(decl) +
                Math.cos(p) * Math.cos(decl) * Math.cos(ha);
  return Math.asin(Math.max(-1, Math.min(1, sinEl))) * 180 / Math.PI;
}
