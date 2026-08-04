/* Samanburður spáa — every source side by side, with the median. */

const METRICS = {
  t:      { label: "Hiti °C",      digits: 1, unit: "" },
  spd:    { label: "Vindur m/s",   digits: 1, unit: "" },
  precip: { label: "Úrkoma mm",    digits: 1, unit: "" },
  cloud:  { label: "Skýjahula %",  digits: 0, unit: "" },
};

let DATA = null;
let metric = "t";

/* Median line with the min–max band of all sources behind it. */
function spreadChart(median) {
  const rows = median.slice(0, 37).filter(m => m.t !== null);
  if (rows.length < 3) return "";
  const W = 620, H = 200, padL = 34, padR = 12, padT = 14, padB = 30;
  const w = W - padL - padR, h = H - padT - padB;
  const lo = Math.min(...rows.map(r => r.t_low)) - 1;
  const hi = Math.max(...rows.map(r => r.t_high)) + 1;
  const px = i => padL + w * i / (rows.length - 1);
  const py = v => padT + h * (1 - (v - lo) / (hi - lo));

  const band = rows.map((r, i) => `${px(i).toFixed(1)},${py(r.t_high).toFixed(1)}`)
    .concat(rows.slice().reverse().map((r, i) =>
      `${px(rows.length - 1 - i).toFixed(1)},${py(r.t_low).toFixed(1)}`)).join(" ");
  const line = rows.map((r, i) => `${px(i).toFixed(1)},${py(r.t).toFixed(1)}`).join(" ");

  let g = `<svg viewBox="0 0 ${W} ${H}" role="img"
    aria-label="Miðgildi hitaspár og bil milli spáa">`;
  [0, 0.5, 1].forEach(f => {
    const y = padT + h * f;
    g += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#EAE4D9"/>
      <text x="4" y="${y + 4}" font-size="10" fill="#9A968D">${
        (lo + (hi - lo) * (1 - f)).toFixed(0)}°</text>`;
  });
  g += `<polygon points="${band}" fill="#3E7E8C" fill-opacity=".14"/>`;
  g += `<polyline points="${line}" fill="none" stroke="#C2571F" stroke-width="2.4"/>`;
  rows.forEach((r, i) => {
    if (i % 6) return;
    g += `<text x="${px(i).toFixed(1)}" y="${H - 8}" font-size="10" fill="#9A968D"
      text-anchor="middle">${hhmm(new Date(r.valid))}</text>`;
  });
  return g + "</svg>";
}

function renderSummary(d) {
  const med = d.median;
  document.getElementById("place-name").textContent = `Samanburður spáa · ${d.place}`;
  const back = document.getElementById("back-link");
  if (back && d.stationNr) back.href = `index.html#stn=${d.stationNr}`;
  const n = Math.max(...med.map(m => m.n));
  const worst = med.slice(0, 25).reduce((a, b) => (a.spread > b.spread ? a : b), med[0]);
  document.getElementById("spread-intro").innerHTML =
    `${n} spár bornar saman. Rauða línan er miðgildið, bláa svæðið sýnir hvar ` +
    `hæsta og lægsta spáin liggja. Mestur munur næsta sólarhringinn er ` +
    `<strong>${worst.spread.toFixed(1)}°C</strong> kl. ${hhmm(new Date(worst.valid))}.`;
  document.getElementById("spread-chart").innerHTML = spreadChart(med);

  document.getElementById("median-body").innerHTML = med.slice(0, 12).map(m => {
    const dt = new Date(m.valid);
    const night = dt.getUTCHours() < 4 || dt.getUTCHours() > 21;
    return `<tr>
    <td class="time">${hhmm(dt)}</td>
    <td>${symbol(m.cloud, m.precip || 0, night)}</td>
    <td class="num temp">${m.t === null ? "—" : m.t.toFixed(1)} °C</td>
    <td class="num"><span class="unit">${m.t_low.toFixed(0)}–${m.t_high.toFixed(0)}°</span></td>
    <td class="wind">${arrow(m.dir)}${Math.round(m.spd)} <span class="unit">m/s</span>
      <span class="agree" title="Samræmi um vindátt: ${Math.round((m.dir_agree || 0) * 100)}%"
        ><i style="width:${Math.round((m.dir_agree || 0) * 100)}%"></i></span></td>
  </tr>`;
  }).join("");
}

function renderMatrix(d) {
  const sources = d.sources;
  const hours = d.median.slice(0, 25).map(m => m.valid);
  const cfg = METRICS[metric];

  document.getElementById("matrix-head").innerHTML =
    `<th>Tími</th><th class="med">Veður</th><th class="med">Miðgildi</th>` +
    sources.map(s => `<th class="src" data-key="${s.key}">${s.label}</th>`).join("");

  const index = {};
  sources.forEach(s => {
    index[s.key] = {};
    s.hours.forEach(h => { index[s.key][h.valid] = h; });
  });
  const medIndex = {};
  d.median.forEach(m => { medIndex[m.valid] = m; });

  const fmt = v => (v === null || v === undefined) ? "—" : v.toFixed(cfg.digits);

  document.getElementById("matrix-body").innerHTML = hours.map(key => {
    const dt = new Date(key);
    const label = dt.getUTCHours() === 0
      ? `${DAY_SHORT[dt.getUTCDay()]} ${hhmm(dt)}` : hhmm(dt);
    const med = medIndex[key] || {};
    const night = dt.getUTCHours() < 4 || dt.getUTCHours() > 21;
    return `<tr><td class="time">${label}</td>
      <td class="med sym-cell">${symbol(med.cloud, med.precip || 0, night)}</td>
      <td class="med">${fmt(med[metric])}</td>` +
      sources.map(s => {
        const h = index[s.key][key];
        return `<td>${h ? fmt(h[metric]) : "—"}</td>`;
      }).join("") + "</tr>";
  }).join("");
}

function renderSources(d) {
  document.getElementById("srclist").innerHTML = d.sources.map(s => {
    const when = s.fetched ? new Date(s.fetched) : null;
    return `<div><strong>${s.label}</strong>
      <span>${s.provider}${s.stale ? " · eldri gögn" : ""}${
        when ? " · sótt kl. " + hhmm(when) : ""}</span></div>`;
  }).join("");
  document.getElementById("foot").innerHTML =
    "Miðgildið er reiknað klukkustund fyrir klukkustund úr öllum spám sem náðist í. " +
    "Vindátt er reiknuð úr þáttum vindvigursins svo spár sitt hvorum megin við norður " +
    "skekki ekki niðurstöðuna. Ekkert af þessu kemur í stað opinberra viðvarana á " +
    '<a href="https://www.vedur.is">vedur.is</a>.<br>' +
    '<a href="skilmalar.html">Skilmálar</a> · ' +
    '<a href="personuvernd.html">Persónuvernd</a> · ' +
    '<a href="heimildir.html">Heimildir</a>';
}

document.querySelectorAll(".metric").forEach(b => b.addEventListener("click", () => {
  metric = b.dataset.metric;
  document.querySelectorAll(".metric").forEach(x => x.classList.toggle("on", x === b));
  if (DATA) renderMatrix(DATA);
}));

/* index.html links here with ?stn=NR when a station is selected there; then the
   whole comparison is built for that station instead of the home town. */
async function load() {
  const wanted = new URLSearchParams(location.search).get("stn");
  try {
    const res = await fetch("data/latest.json?t=" + Date.now());
    const payload = await res.json();
    if (wanted) {
      const st = (payload.stations || []).find(s => String(s.nr) === wanted);
      if (!st) throw new Error("stöð fannst ekki");
      document.getElementById("spread-intro").textContent =
        `Sæki spár fyrir ${st.name}…`;
      const ens = await fetchStationEnsemble(st);
      DATA = { place: st.name, stationNr: st.nr, median: ens.median,
               sources: ens.sources, hours: ens.hours };
    } else {
      DATA = payload;
    }
    renderSummary(DATA);
    renderMatrix(DATA);
    renderSources(DATA);
  } catch (err) {
    document.getElementById("spread-intro").textContent = wanted
      ? "Náði ekki í spár fyrir þessa stöð. Reyndu aftur eftir andartak."
      : "Náði ekki í gögn. Keyrðu 'python3 vedurvakt.py build' eða bíddu eftir næstu uppfærslu.";
  }
}

load();
setInterval(load, 5 * 60 * 1000);
