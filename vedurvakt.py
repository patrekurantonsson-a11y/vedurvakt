#!/usr/bin/env python3
"""
Veðurvakt — a local weather watch that forecasts on its own.

Core idea: Vegagerðin's open observation network (≈200 stations, 10-minute
updates) is the ground truth. The app stores every snapshot in a local SQLite
database, derives an analysis from it (pressure field, geostrophic wind,
sunshine from road-surface heating, sea-breeze state), blends that with an
optional NWP baseline, scores its own past forecasts and corrects its bias.

Standard library only. No API keys. Everything stays on this machine.

  python3 vedurvakt.py collect     fetch one observation snapshot
  python3 vedurvakt.py forecast    build a forecast and print it
  python3 vedurvakt.py serve       dashboard at http://localhost:8787
  python3 vedurvakt.py run         collect + forecast + serve, forever
  python3 vedurvakt.py verify      how good have the forecasts been?
  python3 vedurvakt.py config      show or change settings
"""

import argparse
import json
import math
import os
import re
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP_DIR = Path(os.environ.get("VEDURVAKT_HOME", Path.home() / ".vedurvakt"))
DB_PATH = APP_DIR / "vedurvakt.db"
CONFIG_PATH = APP_DIR / "config.json"

VG_OBS_URL = "https://gagnaveita.vegagerdin.is/api/vedur2014_1"
SJOLAG_URL = "https://sjolag.is/"
IMO_TEXT_URL = "https://xmlweather.vedur.is/?op_w=xml&type=txt&lang=is&view=xml&ids=6"
OPEN_METEO_URL = (
    "https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
    "&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,"
    "wind_gusts_10m,cloud_cover,precipitation,pressure_msl&wind_speed_unit=ms"
    "&timezone=UTC&forecast_days=8"
)

# One request covers many coordinates, so the whole station network costs a
# handful of calls rather than one per station.
FIELD_URL = (
    "https://api.open-meteo.com/v1/forecast?latitude={lats}&longitude={lons}"
    "&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,precipitation"
    "&wind_speed_unit=ms"
    "&timezone=UTC&forecast_days=8"
)

DEFAULT_CONFIG = {
    "name": "Þorlákshöfn",
    "lat": 63.8583,
    "lon": -21.3833,
    # Direction the open sea lies in, as a compass bearing from the town.
    # Onshore wind blows FROM roughly this direction.
    "sea_bearing": 185,
    "buoy_id": 14104,
    "radius_km": 45,
    "port": 8787,
    "use_nwp_baseline": True,
    # Eigið lén, t.d. "vedur.example.is". Sé það sett skrifar build CNAME-skrá
    # í hverri keyrslu, svo lénið tapist ekki þótt Pages sé endurstillt.
    "domain": "",
    # Full slóð síðunnar fyrir forskoðun á hlekkjum, t.d. "https://vedurvakt.is".
    # Sé hún tóm er hún leidd af domain.
    "site_url": "",
    # Forecast for every station, so the map follows the slider. Cached for
    # three hours: refetching all of them every 20 minutes would be rude.
    "station_field": True,
    "field_max_age_hours": 3,
    "collect_minutes": 10,
    "forecast_minutes": 30,
}

# --------------------------------------------------------------------------
# plumbing
# --------------------------------------------------------------------------


def now_utc():
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def load_config():
    APP_DIR.mkdir(parents=True, exist_ok=True)
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError) as exc:
            log(f"næ ekki að lesa stillingar, nota sjálfgefið ({exc})")
    return cfg


def save_config(cfg):
    APP_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")


def log(msg):
    print(f"[{now_utc().strftime('%H:%M:%S')}] {msg}", flush=True)


def http_get(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": "vedurvakt/1.0 (local)"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def db():
    APP_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS obs (
            ts TEXT, nr INTEGER, name TEXT, lat REAL, lon REAL, alt REAL,
            dir REAL, spd REAL, gust REAL, t REAL, troad REAL, rh REAL,
            td REAL, p REAL, sea REAL,
            PRIMARY KEY (ts, nr));
        CREATE INDEX IF NOT EXISTS obs_nr_ts ON obs (nr, ts);
        CREATE TABLE IF NOT EXISTS marine (
            ts TEXT, buoy INTEGER, hs REAL, period REAL, wavelen REAL, sst REAL,
            PRIMARY KEY (ts, buoy));
        CREATE TABLE IF NOT EXISTS fcst (
            issue TEXT, valid TEXT, lead INTEGER, t REAL, spd REAL, gust REAL,
            dir REAL, cloud REAL, precip REAL, source TEXT,
            PRIMARY KEY (issue, valid));
        CREATE INDEX IF NOT EXISTS fcst_valid ON fcst (valid);
        CREATE TABLE IF NOT EXISTS analysis (
            issue TEXT PRIMARY KEY, payload TEXT);
        """
    )
    return conn


# --------------------------------------------------------------------------
# geometry and small physics helpers
# --------------------------------------------------------------------------


def haversine(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def bearing(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def compass(deg):
    if deg is None:
        return "—"
    pts = ["N", "NNA", "NA", "ANA", "A", "ASA", "SA", "SSA",
           "S", "SSV", "SV", "VSV", "V", "VNV", "NV", "NNV"]
    return pts[int((deg % 360) / 22.5 + 0.5) % 16]


def angle_diff(a, b):
    """Smallest absolute difference between two bearings, 0–180."""
    return abs((a - b + 180) % 360 - 180)


def circ_mean(degrees):
    vals = [d for d in degrees if d is not None]
    if not vals:
        return None
    x = sum(math.cos(math.radians(d)) for d in vals)
    y = sum(math.sin(math.radians(d)) for d in vals)
    if x == 0 and y == 0:
        return None
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def to_uv(dir_from, spd):
    """Compass direction the wind blows FROM, to eastward/northward components."""
    a = math.radians(dir_from)
    return -spd * math.sin(a), -spd * math.cos(a)


def from_uv(u, v):
    """Back to (speed, direction it blows FROM)."""
    spd = math.hypot(u, v)
    if spd < 1e-6:
        return 0.0, 0.0
    return spd, (270 - math.degrees(math.atan2(v, u))) % 360


def solar_elevation(lat, lon, dt):
    """Rough solar elevation in degrees. Good to about a degree, plenty here."""
    day = dt.timetuple().tm_yday
    hour = dt.hour + dt.minute / 60.0
    decl = math.radians(23.44) * math.sin(math.radians(360 / 365.24 * (day - 81)))
    hour_angle = math.radians(15 * (hour + lon / 15.0 - 12))
    p = math.radians(lat)
    sin_el = math.sin(p) * math.sin(decl) + math.cos(p) * math.cos(decl) * math.cos(hour_angle)
    return math.degrees(math.asin(max(-1.0, min(1.0, sin_el))))


def slope_per_hour(points):
    """Least-squares slope of (datetime, value) pairs, per hour."""
    pts = [(t, v) for t, v in points if v is not None]
    if len(pts) < 3:
        return None
    t0 = pts[0][0]
    xs = [(t - t0).total_seconds() / 3600.0 for t, _ in pts]
    ys = [v for _, v in pts]
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    den = sum((x - mx) ** 2 for x in xs)
    if den < 1e-9:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den


# --------------------------------------------------------------------------
# collection
# --------------------------------------------------------------------------


def fetch_vegagerdin():
    raw = json.loads(http_get(VG_OBS_URL))
    out = []
    for s in raw:
        try:
            ts = datetime.strptime(s["Dags"], "%d.%m.%Y %H:%M:%S").replace(tzinfo=timezone.utc)
        except (KeyError, ValueError, TypeError):
            continue
        if s.get("Breidd") is None or s.get("Lengd") is None:
            continue
        out.append({
            "ts": ts, "nr": s.get("Nr"), "name": s.get("Nafn"),
            "lat": s.get("Breidd"), "lon": s.get("Lengd"), "alt": s.get("Haed"),
            "dir": s.get("Vindatt"), "spd": s.get("Vindhradi"), "gust": s.get("Vindhvida"),
            "t": s.get("Hiti"), "troad": s.get("Veghiti"), "rh": s.get("Raki"),
            "td": s.get("Daggarmark"), "p": s.get("Loftthrystingur"), "sea": s.get("Sjavarhaed"),
        })
    return out


def fetch_buoy(buoy_id):
    """Wave data from Vegagerðin's Sjólag site (embedded in the page payload)."""
    html = http_get(SJOLAG_URL, timeout=30).replace('\\"', '"')
    key = f'"id":{buoy_id}'
    i = html.find(key)
    if i < 0:
        return None
    start = html.rfind("{", 0, i)
    depth, j = 0, start
    while j < len(html):
        if html[j] == "{":
            depth += 1
        elif html[j] == "}":
            depth -= 1
            if depth == 0:
                break
        j += 1
    try:
        blob = json.loads(html[start:j + 1])
    except json.JSONDecodeError:
        return None

    def num(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    ts = blob.get("date", "").replace(".000Z", "Z")
    try:
        ts = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        ts = now_utc()
    return {
        "ts": ts, "buoy": buoy_id, "hs": num(blob.get("waveHeight")),
        "period": num(blob.get("peakPeriod")), "wavelen": num(blob.get("waveLength")),
        "sst": num(blob.get("seaTemperature")), "name": blob.get("name"),
    }


def collect(cfg):
    conn = db()
    stations = fetch_vegagerdin()
    rows = [(iso(s["ts"]), s["nr"], s["name"], s["lat"], s["lon"], s["alt"], s["dir"],
             s["spd"], s["gust"], s["t"], s["troad"], s["rh"], s["td"], s["p"], s["sea"])
            for s in stations]
    conn.executemany("INSERT OR REPLACE INTO obs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)

    marine = None
    try:
        marine = fetch_buoy(cfg["buoy_id"])
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        log(f"náði ekki í duflið: {exc}")
    if marine:
        conn.execute("INSERT OR REPLACE INTO marine VALUES (?,?,?,?,?,?)",
                     (iso(marine["ts"]), marine["buoy"], marine["hs"],
                      marine["period"], marine["wavelen"], marine["sst"]))
    conn.commit()
    conn.close()
    log(f"sótti {len(rows)} stöðvar" + (", dufl í lagi" if marine else ""))
    return len(rows)


def prune(days=400):
    conn = db()
    cutoff = iso(now_utc() - timedelta(days=days))
    conn.execute("DELETE FROM obs WHERE ts < ?", (cutoff,))
    conn.commit()
    conn.close()


# --------------------------------------------------------------------------
# analysis — what the network is telling us right now
# --------------------------------------------------------------------------


def latest_obs(conn, within_minutes=90):
    cutoff = iso(now_utc() - timedelta(minutes=within_minutes))
    rows = conn.execute(
        "SELECT * FROM obs WHERE ts >= ? ORDER BY ts", (cutoff,)).fetchall()
    best = {}
    for r in rows:
        best[r["nr"]] = dict(r)
    return list(best.values())


def series(conn, nr, hours=6):
    cutoff = iso(now_utc() - timedelta(hours=hours))
    rows = conn.execute(
        "SELECT * FROM obs WHERE nr = ? AND ts >= ? ORDER BY ts", (nr, cutoff)).fetchall()
    return [dict(r) for r in rows]


def pressure_field(obs, lat0):
    """Fit a plane to sea-level pressure, then read off the geostrophic wind."""
    pts = [(o["lat"], o["lon"], o["p"]) for o in obs if o["p"] is not None]
    if len(pts) < 6:
        return None
    # Local flat-earth coordinates in km, centred on the mean station position.
    mlat = sum(p[0] for p in pts) / len(pts)
    mlon = sum(p[1] for p in pts) / len(pts)
    data = []
    for la, lo, p in pts:
        x = (lo - mlon) * 111.32 * math.cos(math.radians(mlat))
        y = (la - mlat) * 111.32
        data.append((x, y, p))
    # Trim the worst outliers: uncalibrated barometers are common in this network.
    for _ in range(2):
        coef = _plane_fit(data)
        if coef is None:
            return None
        a, b, c = coef
        resid = [(abs(p - (a + b * x + c * y)), (x, y, p)) for x, y, p in data]
        resid.sort(key=lambda r: r[0])
        keep = max(6, int(len(resid) * 0.85))
        data = [r[1] for r in resid[:keep]]
    coef = _plane_fit(data)
    if coef is None:
        return None
    a, b, c = coef  # hPa per km in x (east) and y (north)
    grad = math.hypot(b, c)
    f = 2 * 7.2921e-5 * math.sin(math.radians(lat0))
    # 1 hPa/km = 0.1 Pa/m; V = (1/(rho f)) * |grad P|
    speed = (grad * 0.1) / (1.25 * f)
    # Geostrophic wind vector is (1/(rho f)) * k x grad(P) -> (-c, b)
    vx, vy = -c, b
    direction = (270 - math.degrees(math.atan2(vy, vx))) % 360  # direction it blows FROM
    return {"grad_hpa_per_100km": grad * 100, "speed": speed, "dir": direction,
            "n": len(data), "mean_p": a}


def _plane_fit(data):
    n = len(data)
    if n < 4:
        return None
    sx = sum(d[0] for d in data)
    sy = sum(d[1] for d in data)
    sxx = sum(d[0] * d[0] for d in data)
    syy = sum(d[1] * d[1] for d in data)
    sxy = sum(d[0] * d[1] for d in data)
    sp = sum(d[2] for d in data)
    spx = sum(d[2] * d[0] for d in data)
    spy = sum(d[2] * d[1] for d in data)
    m = [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]]
    v = [sp, spx, spy]
    return _solve3(m, v)


def _solve3(m, v):
    a = [row[:] + [v[i]] for i, row in enumerate(m)]
    for col in range(3):
        piv = max(range(col, 3), key=lambda r: abs(a[r][col]))
        if abs(a[piv][col]) < 1e-9:
            return None
        a[col], a[piv] = a[piv], a[col]
        for r in range(3):
            if r == col:
                continue
            factor = a[r][col] / a[col][col]
            for k in range(col, 4):
                a[r][k] -= factor * a[col][k]
    return [a[i][3] / a[i][i] for i in range(3)]


def sunshine_index(obs, cfg, when):
    """Road surface warmer than the air means sun on the tarmac. Cheap radiometer."""
    el = solar_elevation(cfg["lat"], cfg["lon"], when)
    if el < 8:
        return {"index": None, "elevation": el, "n": 0}
    diffs = []
    for o in obs:
        if o["troad"] is None or o["t"] is None:
            continue
        if haversine(cfg["lat"], cfg["lon"], o["lat"], o["lon"]) > 70:
            continue
        diffs.append(o["troad"] - o["t"])
    if not diffs:
        return {"index": None, "elevation": el, "n": 0}
    diffs.sort()
    # Take the upper quartile, not the median: wet, shaded and coastal sensors drag
    # the middle down even when the sky is open.
    excess = diffs[int(0.75 * (len(diffs) - 1))]
    # Normalise by how high the sun is: the same clear sky heats less at low elevation.
    # 6.5 °C of tarmac excess at zenith matches clear-sky days on this network.
    expected_clear = max(0.8, 6.5 * math.sin(math.radians(el)))
    return {"index": max(0.0, min(1.0, excess / expected_clear)),
            "median_excess": excess, "elevation": el, "n": len(diffs)}


def sea_breeze_state(obs, cfg, gradient, sun):
    """Coastal stations onshore while inland stations are not: a sea breeze."""
    coastal, inland = [], []
    for o in obs:
        d = haversine(cfg["lat"], cfg["lon"], o["lat"], o["lon"])
        if d > cfg["radius_km"] or o["dir"] is None:
            continue
        if (o["alt"] or 0) < 80 and d < 25:
            coastal.append(o)
        elif (o["alt"] or 0) >= 120 or d > 25:
            inland.append(o)
    cd = circ_mean([o["dir"] for o in coastal])
    idir = circ_mean([o["dir"] for o in inland])
    onshore = None
    if cd is not None:
        onshore = math.cos(math.radians(angle_diff(cd, cfg["sea_bearing"])))
    contrast = None
    inland_t = [o["t"] for o in inland if o["t"] is not None]
    coast_t = [o["t"] for o in coastal if o["t"] is not None]
    if inland_t and coast_t:
        contrast = max(inland_t) - min(coast_t)

    weak_gradient = 1.0
    if gradient:
        weak_gradient = max(0.0, min(1.0, (11.0 - gradient["speed"]) / 8.0))
    sunny = sun["index"] if sun["index"] is not None else 0.35
    heating = 0.5 if contrast is None else max(0.0, min(1.0, contrast / 4.0))
    veering = 0.0
    if cd is not None and idir is not None:
        veering = max(0.0, min(1.0, angle_diff(cd, idir) / 90.0))

    prob = 0.35 * weak_gradient + 0.3 * sunny + 0.2 * heating + 0.15 * veering
    active = onshore is not None and onshore > 0.3 and veering > 0.3
    return {"probability": round(prob, 2), "active": bool(active),
            "coastal_dir": cd, "inland_dir": idir, "onshore": onshore,
            "land_sea_contrast": contrast}


def local_now(conn, obs, cfg):
    """Conditions at the point itself: the town station if it reports, else IDW."""
    ranked = sorted(
        ((haversine(cfg["lat"], cfg["lon"], o["lat"], o["lon"]), o) for o in obs),
        key=lambda x: x[0])
    if not ranked:
        return None
    d, near = ranked[0]
    if d < 5:
        out = dict(near)
        out["distance_km"] = round(d, 1)
        out["method"] = "station"
    else:
        out = {"name": cfg["name"], "method": "interpolated", "distance_km": round(d, 1)}
        for field in ("t", "spd", "gust", "rh", "td", "p"):
            num, den = 0.0, 0.0
            for dist, o in ranked[:5]:
                if o[field] is None:
                    continue
                w = 1.0 / max(1.0, dist) ** 2
                num += w * o[field]
                den += w
            out[field] = round(num / den, 1) if den else None
        out["dir"] = circ_mean([o["dir"] for _, o in ranked[:5]])
        out["ts"] = ranked[0][1]["ts"]
    # fill the gaps the harbour station leaves (it reports no humidity)
    for field in ("rh", "td", "troad"):
        if out.get(field) is None:
            for dist, o in ranked[:6]:
                if o.get(field) is not None:
                    out[field] = o[field]
                    break
    return out


def tendencies(conn, obs, cfg):
    """Three-hour trends at the closest stations that carry each variable."""
    out = {}
    ranked = sorted(
        ((haversine(cfg["lat"], cfg["lon"], o["lat"], o["lon"]), o) for o in obs),
        key=lambda x: x[0])[:6]
    for field in ("p", "t", "spd"):
        for dist, o in ranked:
            hist = series(conn, o["nr"], hours=3)
            pts = [(parse_iso(h["ts"]), h[field]) for h in hist]
            s = slope_per_hour(pts)
            if s is not None:
                out[field] = {"per_hour": round(s, 3), "station": o["name"],
                              "samples": len(pts)}
                break
    return out


def analyse(conn, cfg):
    obs = latest_obs(conn)
    when = now_utc()
    if not obs:
        return None
    gradient = pressure_field(obs, cfg["lat"])
    sun = sunshine_index(obs, cfg, when)
    breeze = sea_breeze_state(obs, cfg, gradient, sun)
    here = local_now(conn, obs, cfg)
    tend = tendencies(conn, obs, cfg)
    everywhere = sorted(
        ({"nr": o["nr"], "name": o["name"],
          "km": round(haversine(cfg["lat"], cfg["lon"], o["lat"], o["lon"]), 1),
          "bearing": round(bearing(cfg["lat"], cfg["lon"], o["lat"], o["lon"])),
          "lat": o["lat"], "lon": o["lon"],
          "dir": o["dir"], "spd": o["spd"], "gust": o["gust"], "t": o["t"],
          "troad": o["troad"], "rh": o["rh"], "alt": o["alt"], "ts": o["ts"]}
         for o in obs if o["lat"] and o["lon"]),
        key=lambda x: x["km"])
    nearby = [s for s in everywhere if s["km"] <= cfg["radius_km"]]
    row = conn.execute("SELECT * FROM marine ORDER BY ts DESC LIMIT 1").fetchone()
    marine = dict(row) if row else None
    return {"issued": iso(when), "here": here, "gradient": gradient, "sun": sun,
            "breeze": breeze, "tendency": tend, "nearby": nearby,
            "everywhere": everywhere, "marine": marine,
            "station_count": len(obs)}


# --------------------------------------------------------------------------
# forecast
# --------------------------------------------------------------------------


def nwp_baseline(cfg, hours=168):
    url = OPEN_METEO_URL.format(lat=cfg["lat"], lon=cfg["lon"])
    data = json.loads(http_get(url, timeout=25))
    h = data["hourly"]
    rows = []
    start = now_utc().replace(minute=0, second=0)
    for i, tstr in enumerate(h["time"]):
        t = datetime.strptime(tstr, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)
        if t < start or t > start + timedelta(hours=hours):
            continue
        rows.append({
            "valid": t,
            "t": h["temperature_2m"][i],
            "spd": h["wind_speed_10m"][i],
            "gust": h["wind_gusts_10m"][i],
            "dir": h["wind_direction_10m"][i],
            "cloud": h["cloud_cover"][i],
            "precip": h["precipitation"][i],
            "rh": h["relative_humidity_2m"][i],
        })
    return rows


def physics_baseline(analysis, cfg, hours=168):
    """No model available: build the forecast from the observation network alone."""
    here = analysis["here"] or {}
    grad = analysis["gradient"]
    sun = analysis["sun"]["index"]
    cloud_now = 100 * (1 - sun) if sun is not None else 55
    t_now = here.get("t") or 8.0
    base_spd = (grad["speed"] * 0.6) if grad else (here.get("spd") or 4.0)
    base_dir = grad["dir"] - 25 if grad else (here.get("dir") or 180)
    # Diurnal swing scales with how clear it is and how much daylight there is.
    start = now_utc().replace(minute=0, second=0)
    noon_el = solar_elevation(cfg["lat"], cfg["lon"], start.replace(hour=13))
    amplitude = (2.0 + 4.5 * max(0.0, math.sin(math.radians(max(noon_el, 0))))) * \
                (0.45 + 0.55 * (1 - cloud_now / 100.0))
    # Anchor the daily mean on the current temperature, undoing today's phase.
    phase_now = math.cos(2 * math.pi * ((start.hour - 15) % 24) / 24)
    mean_t = t_now - amplitude * phase_now
    p_trend = analysis["tendency"].get("p", {}).get("per_hour", 0.0) or 0.0
    rows = []
    for i in range(hours + 1):
        valid = start + timedelta(hours=i)
        phase = math.cos(2 * math.pi * ((valid.hour - 15) % 24) / 24)
        # Falling pressure -> more cloud, damped warming.
        cloud = max(0.0, min(100.0, cloud_now - p_trend * 22 * min(i, 12)))
        t = mean_t + amplitude * phase * (0.5 + 0.5 * (1 - cloud / 100.0))
        rows.append({"valid": valid, "t": round(t, 1), "spd": round(base_spd, 1),
                     "gust": round(base_spd * 1.45, 1), "dir": base_dir % 360,
                     "cloud": round(cloud), "precip": 0.0})
    return rows


def apply_sea_breeze(rows, analysis, cfg):
    """A sea breeze is a local effect that coarse models routinely miss."""
    breeze = analysis["breeze"]
    if breeze["probability"] < 0.5:
        return rows, None
    onset, peak, decay = 11, 16, 21
    note = None
    for r in rows:
        hour = r["valid"].hour
        el = solar_elevation(cfg["lat"], cfg["lon"], r["valid"])
        if el < 5 or not (onset <= hour <= decay):
            continue
        strength = math.sin(math.pi * (hour - onset) / max(1, decay - onset))
        weight = breeze["probability"] * strength
        if weight < 0.25:
            continue
        target = cfg["sea_bearing"]
        # A sea breeze is a circulation added on top of the larger-scale flow, so
        # add it as a vector. Opposing flows cancel; aligned ones reinforce.
        u, v = to_uv(r["dir"], r["spd"])
        bu, bv = to_uv(target, 4.5 * weight)
        r["spd"], r["dir"] = from_uv(u + bu, v + bv)
        r["spd"] = round(max(r["spd"], 1.5), 1)
        r["gust"] = max(r["spd"] * 1.35, min(r.get("gust") or 0, r["spd"] * 2.0))
        # Onshore flow off a 12 °C sea caps the afternoon temperature.
        sst = (analysis["marine"] or {}).get("sst")
        if sst:
            r["t"] = min(r["t"], sst + 4.5 - 1.5 * weight + 0.0)
        note = f"sea breeze {peak - 1}–{peak + 2}, onshore {compass(target)}"
    return rows, note


def _bias_from_rows(rows):
    buckets = {}
    for r in rows:
        if r["ot"] is None or r["ft"] is None:
            continue
        b = buckets.setdefault(min(r["lead"] // 6, 5), {"t": [], "s": []})
        b["t"].append(r["ft"] - r["ot"])
        if r["fs"] is not None and r["os"] is not None:
            b["s"].append(r["fs"] - r["os"])
    out = {}
    for k, v in buckets.items():
        if len(v["t"]) >= 12:
            mt = sorted(v["t"])[len(v["t"]) // 2]
            ms = sorted(v["s"])[len(v["s"]) // 2] if len(v["s"]) >= 12 else 0.0
            out[k] = {"t": max(-3.0, min(3.0, mt)), "spd": max(-3.0, min(3.0, ms)),
                      "n": len(v["t"])}
    return out


def target_station_nr(conn, cfg):
    rows = latest_obs(conn)
    if not rows:
        return None
    best = min(rows, key=lambda o: haversine(cfg["lat"], cfg["lon"], o["lat"], o["lon"]))
    return best["nr"] if haversine(cfg["lat"], cfg["lon"], best["lat"], best["lon"]) < 8 else None


def verification_pairs(conn, cfg, days=30):
    nr = target_station_nr(conn, cfg)
    if nr is None:
        return []
    cutoff = iso(now_utc() - timedelta(days=days))
    end = iso(now_utc())
    fc = conn.execute(
        "SELECT lead, t, spd, valid FROM fcst WHERE valid >= ? AND valid <= ?",
        (cutoff, end)).fetchall()
    ob = conn.execute(
        "SELECT ts, t, spd FROM obs WHERE nr = ? AND ts >= ? ORDER BY ts",
        (nr, cutoff)).fetchall()
    if not fc or not ob:
        return []
    # Stations report on their own schedule, so pair each forecast hour with the
    # closest observation inside a 25-minute window.
    obs_by_time = [(parse_iso(o["ts"]), o) for o in ob]
    pairs = []
    for f in fc:
        target = parse_iso(f["valid"])
        best = min(obs_by_time, key=lambda x: abs((x[0] - target).total_seconds()))
        if abs((best[0] - target).total_seconds()) > 25 * 60:
            continue
        pairs.append({"lead": f["lead"], "ft": f["t"], "fs": f["spd"],
                      "valid": f["valid"], "ot": best[1]["t"], "os": best[1]["spd"]})
    return pairs


def make_forecast(cfg, hours=168):
    conn = db()
    analysis = analyse(conn, cfg)
    if analysis is None:
        conn.close()
        raise RuntimeError("engar mælingar í gagnagrunninum — keyrðu 'collect' fyrst")

    source = "physics"
    rows = None
    if cfg.get("use_nwp_baseline", True):
        try:
            rows = nwp_baseline(cfg, hours)
            source = "nwp+vegagerdin"
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
                OSError, KeyError, ValueError) as exc:
            log(f"reiknilíkan ekki tiltækt ({exc}); spái út frá mælingum eingöngu")
    if not rows:
        rows = physics_baseline(analysis, cfg, hours)

    here = analysis["here"] or {}
    start = now_utc()

    # 1. Blend the first hours toward what is actually happening right now.
    t_trend = analysis["tendency"].get("t", {}).get("per_hour", 0.0) or 0.0
    for r in rows:
        lead = max(0.0, (r["valid"] - start).total_seconds() / 3600.0)
        w = math.exp(-lead / 2.5)  # persistence weight, gone by ~8 hours
        if here.get("t") is not None and r["t"] is not None:
            persisted = here["t"] + t_trend * min(lead, 2.0)
            r["t"] = round(r["t"] * (1 - w) + persisted * w, 1)
        if here.get("spd") is not None and r["spd"] is not None:
            r["spd"] = round(r["spd"] * (1 - w) + here["spd"] * w, 1)
        if here.get("dir") is not None and r["dir"] is not None:
            delta = (here["dir"] - r["dir"] + 180) % 360 - 180
            r["dir"] = (r["dir"] + delta * w) % 360
        gust = r.get("gust") or 0
        r["gust"] = round(max(r["spd"] * 1.35, min(gust, r["spd"] * 2.0)), 1)

    # 2. Local sea-breeze correction.
    rows, breeze_note = apply_sea_breeze(rows, analysis, cfg)

    # 3. Correct for our own past bias.
    pairs = verification_pairs(conn, cfg)
    bias = _bias_from_rows(pairs)
    for r in rows:
        lead = int(max(0.0, (r["valid"] - start).total_seconds() / 3600.0))
        b = bias.get(min(lead // 6, 5))
        if b:
            r["t"] = round(r["t"] - b["t"], 1)
            r["spd"] = round(max(0.0, r["spd"] - b["spd"]), 1)

    issue = iso(start)
    conn.executemany(
        "INSERT OR REPLACE INTO fcst VALUES (?,?,?,?,?,?,?,?,?,?)",
        [(issue, iso(r["valid"].replace(minute=0, second=0)),
          int(round((r["valid"] - start).total_seconds() / 3600.0)),
          r["t"], r["spd"], r["gust"], r["dir"], r.get("cloud"), r.get("precip"), source)
         for r in rows
         if (r["valid"] - start).total_seconds() <= 40 * 3600])
    analysis["source"] = source
    analysis["bias_applied"] = {str(k): v for k, v in bias.items()}
    analysis["breeze_note"] = breeze_note
    conn.execute("INSERT OR REPLACE INTO analysis VALUES (?,?)",
                 (issue, json.dumps(analysis, ensure_ascii=False, default=str)))
    conn.commit()
    conn.close()
    return analysis, rows


# --------------------------------------------------------------------------
# words
# --------------------------------------------------------------------------


def describe_cloud(cloud):
    if cloud is None:
        return "óþekkt skýjahula"
    if cloud < 15:
        return "heiðskírt"
    if cloud < 40:
        return "léttskýjað"
    if cloud < 70:
        return "skýjað að hluta"
    if cloud < 90:
        return "skýjað"
    return "alskýjað"


def num(value, digits=1, sign=False):
    """Icelandic number formatting: comma for the decimal point."""
    if value is None:
        return "—"
    text = f"{value:+.{digits}f}" if sign else f"{value:.{digits}f}"
    return text.replace(".", ",")


def narrative(analysis, rows, cfg):
    """The Greining tab. Written in Icelandic, like the rest of the page."""
    here = analysis["here"] or {}
    lines = []
    g = analysis["gradient"]
    sun = analysis["sun"]
    breeze = analysis["breeze"]

    now_bits = []
    if here.get("t") is not None:
        now_bits.append(f"hiti {num(here['t'])} °C")
    if here.get("spd") is not None:
        now_bits.append(f"vindur {compass(here.get('dir'))} {num(here['spd'])} m/s")
    if here.get("rh") is not None:
        now_bits.append(f"rakastig {num(here['rh'], 0)}%")
    lines.append(
        f"Núna í {cfg['name']}: " + ", ".join(now_bits) +
        f" — {analysis['station_count']} stöðvar senda mælingar.")

    if g:
        lines.append(
            f"Þrýstisvið: {num(g['grad_hpa_per_100km'])} hPa á 100 km, sem gefur "
            f"þrýstivind af {compass(g['dir'])}, um {num(g['speed'], 0)} m/s "
            f"(reiknað úr {g['n']} loftvogum).")
    if sun["index"] is not None:
        lines.append(
            f"Vegyfirborð mælist {num(sun['median_excess'])} °C hlýrra en loftið, "
            f"sem bendir til þess að nú sé {describe_cloud(100 * (1 - sun['index']))}.")
    if breeze["probability"] >= 0.5:
        state = "er þegar komin af stað" if breeze["active"] else "er líkleg til að myndast"
        lines.append(
            f"Hafgola {state} (stuðull {num(breeze['probability'], 2)}): við ströndina "
            f"blæs af {compass(breeze['coastal_dir'])} en inn til landsins af "
            f"{compass(breeze['inland_dir'])}.")
    p = analysis["tendency"].get("p")
    if p:
        word = ("fer hækkandi" if p["per_hour"] > 0.15
                else "fer lækkandi" if p["per_hour"] < -0.15 else "stendur í stað")
        lines.append(
            f"Loftþrýstingur {word}, {num(p['per_hour'], 2, sign=True)} hPa á klst.")
    m = analysis.get("marine")
    if m and m.get("hs") is not None:
        bits = [f"kennialda {num(m['hs'])} m"]
        if m.get("period") is not None:
            bits.append(f"sveiflutími {num(m['period'])} s")
        if m.get("sst") is not None:
            bits.append(f"sjávarhiti {num(m['sst'])} °C")
        lines.append("Sjólag við Þorlákshöfn: " + ", ".join(bits) + ".")

    day = [r for r in rows if 0 <= (r["valid"] - now_utc()).total_seconds() / 3600 <= 15]
    if day:
        hi = max(r["t"] for r in day)
        lo = min(r["t"] for r in day)
        peak = max(day, key=lambda r: r["spd"])
        lines.append(
            f"Næstu 15 klukkustundir: hiti {num(lo, 0)} til {num(hi, 0)} °C, mestur "
            f"vindur {compass(peak['dir'])} {num(peak['spd'], 0)} m/s "
            f"(hviður {num(peak['gust'], 0)}) um kl. {peak['valid'].strftime('%H:%M')}.")
    return lines


# --------------------------------------------------------------------------
# verification
# --------------------------------------------------------------------------


def verify(cfg, days=30):
    conn = db()
    pairs = verification_pairs(conn, cfg, days)
    conn.close()
    if not pairs:
        return {"pairs": 0, "note": "engar spár hafa enn verið bornar saman við mælingar"}
    buckets = {}
    for r in pairs:
        if r["ot"] is None or r["ft"] is None:
            continue
        key = min(r["lead"] // 6, 5)
        b = buckets.setdefault(key, {"t": [], "s": []})
        b["t"].append(abs(r["ft"] - r["ot"]))
        if r["fs"] is not None and r["os"] is not None:
            b["s"].append(abs(r["fs"] - r["os"]))
    out = {"pairs": len(pairs), "leads": {}}
    for k in sorted(buckets):
        v = buckets[k]
        out["leads"][f"{k * 6}-{k * 6 + 5}h"] = {
            "n": len(v["t"]),
            "temp_mae": round(sum(v["t"]) / len(v["t"]), 2),
            "wind_mae": round(sum(v["s"]) / len(v["s"]), 2) if v["s"] else None,
        }
    return out


# --------------------------------------------------------------------------
# other people's forecasts, for comparison and for the median
# --------------------------------------------------------------------------

IMO_STATIONS_URL = "https://api.vedur.is/weather/stations?format=json"
IMO_FORECAST_URL = ("https://xmlweather.vedur.is/?op_w=xml&type=forec&lang=is"
                    "&view=xml&ids={ids}")
YR_URL = ("https://api.met.no/weatherapi/locationforecast/2.0/compact"
          "?lat={lat}&lon={lon}")
OM_MODELS = [
    ("ecmwf_ifs025", "ECMWF IFS", "Evrópska reiknimiðstöðin"),
    ("gfs_seamless", "GFS", "NOAA, Bandaríkjunum"),
    ("icon_seamless", "ICON", "DWD, Þýskalandi"),
    ("ukmo_seamless", "UKMO", "Met Office, Bretlandi"),
    ("meteofrance_seamless", "AROME/ARPEGE", "Météo-France"),
    ("gem_seamless", "GEM", "Environment Canada"),
    ("knmi_seamless", "HARMONIE", "KNMI, Hollandi"),
]
OM_MULTI_URL = (
    "https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
    "&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,"
    "precipitation,cloud_cover&wind_speed_unit=ms&timezone=UTC&forecast_days=3"
    "&models=" + ",".join(m[0] for m in OM_MODELS)
)

IS_POINTS = {"N": 0, "NNA": 22.5, "NA": 45, "ANA": 67.5, "A": 90, "ASA": 112.5,
             "SA": 135, "SSA": 157.5, "S": 180, "SSV": 202.5, "SV": 225,
             "VSV": 247.5, "V": 270, "VNV": 292.5, "NV": 315, "NNV": 337.5}

# Veðurstofan's worded sky states, turned into a cloud fraction we can average.
IS_SKY = {"heiðskírt": 3, "léttskýjað": 20, "skýjað að hluta": 45, "hálfskýjað": 50,
          "skýjað": 75, "alskýjað": 98, "þokumóða": 90, "þoka": 95}
IS_WET = ("rign", "skúr", "súld", "él", "snjó", "slydd", "úrkom")


def _hour_key(dt):
    return iso(dt.replace(minute=0, second=0, microsecond=0))


def fetch_yr(cfg):
    """MET Norway / yr.no. Their terms require an identifying User-Agent."""
    url = YR_URL.format(lat=round(cfg["lat"], 4), lon=round(cfg["lon"], 4))
    req = urllib.request.Request(url, headers={
        "User-Agent": "vedurvakt/1.0 (local weather watch; github.com/vedurvakt)"})
    with urllib.request.urlopen(req, timeout=25) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    hours = []
    for entry in data["properties"]["timeseries"]:
        t = datetime.strptime(entry["time"], "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=timezone.utc)
        d = entry["data"]["instant"]["details"]
        nxt = entry["data"].get("next_1_hours", {}).get("details", {})
        hours.append({
            "valid": _hour_key(t),
            "t": d.get("air_temperature"),
            "spd": d.get("wind_speed"),
            "dir": d.get("wind_from_direction"),
            "rh": d.get("relative_humidity"),
            "cloud": d.get("cloud_area_fraction"),
            "precip": nxt.get("precipitation_amount"),
        })
    return {"key": "yr", "label": "Yr", "provider": "MET Norway", "hours": hours}


def find_imo_forecast_station(cfg):
    """Veðurstofan publish point forecasts for a subset of their stations.
    Find the closest one that actually returns data, and remember it."""
    if cfg.get("imo_station"):
        return cfg["imo_station"], cfg.get("imo_station_name", "")
    stations = json.loads(http_get(IMO_STATIONS_URL, timeout=30))
    live = [s for s in stations
            if s.get("ending") is None and s.get("lat") and s.get("station")]
    live.sort(key=lambda s: haversine(cfg["lat"], cfg["lon"], s["lat"], s["lon"]))
    candidates = live[:12]
    ids = ";".join(str(s["station"]) for s in candidates)
    xml = http_get(IMO_FORECAST_URL.format(ids=ids), timeout=30)
    available = set(re.findall(r'<station id="(\d+)"', xml))
    for s in candidates:
        if str(s["station"]) in available and "<forecast>" in xml:
            cfg["imo_station"] = s["station"]
            cfg["imo_station_name"] = s["name"]
            save_config(cfg)
            return s["station"], s["name"]
    return None, ""


def fetch_imo(cfg):
    station, name = find_imo_forecast_station(cfg)
    if not station:
        raise ValueError("no Veðurstofan forecast point nearby")
    xml = http_get(IMO_FORECAST_URL.format(ids=station), timeout=25)
    hours = []
    for m in re.finditer(
            r"<ftime>(.*?)</ftime><F>(.*?)</F><D>(.*?)</D><T>(.*?)</T><W>(.*?)</W>", xml):
        t = datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        word = m.group(5).strip().lower()
        cloud = None
        for key, val in IS_SKY.items():
            if key in word:
                cloud = val
                break
        if cloud is None:
            cloud = 90 if any(w in word for w in IS_WET) else None
        hours.append({
            "valid": _hour_key(t),
            "t": float(m.group(4)),
            "spd": float(m.group(2)),
            "dir": IS_POINTS.get(m.group(3).strip().upper()),
            "cloud": cloud,
            "precip": None,
            "word": m.group(5).strip(),
        })
    return {"key": "imo", "label": "Veðurstofan",
            "provider": f"vedur.is · {name}", "hours": hours}


def fetch_open_meteo_models(cfg):
    url = OM_MULTI_URL.format(lat=round(cfg["lat"], 4), lon=round(cfg["lon"], 4))
    h = json.loads(http_get(url, timeout=30))["hourly"]
    times = [datetime.strptime(x, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)
             for x in h["time"]]
    out = []
    for key, label, provider in OM_MODELS:
        def col(field):
            return h.get(f"{field}_{key}") or [None] * len(times)
        temp, rh = col("temperature_2m"), col("relative_humidity_2m")
        spd, wdir = col("wind_speed_10m"), col("wind_direction_10m")
        pcp, cld = col("precipitation"), col("cloud_cover")
        hours = [{"valid": _hour_key(t), "t": temp[i], "rh": rh[i], "spd": spd[i],
                  "dir": wdir[i], "precip": pcp[i], "cloud": cld[i]}
                 for i, t in enumerate(times) if temp[i] is not None]
        if hours:
            out.append({"key": key, "label": label, "provider": provider,
                        "hours": hours})
    return out


def field_times(start, hours=168):
    """Hourly through the first day, three-hourly after — the map does not need
    more than that, and it keeps the page a fifth of the size."""
    return [start + timedelta(hours=i) for i in range(hours + 1)
            if i <= 24 or i % 3 == 0]


def fetch_field(stations, start, chunk=40):
    """Model forecast at every station, sampled onto the frame times."""
    frames = field_times(start)
    keys = [t.strftime("%Y-%m-%dT%H:00") for t in frames]
    out = []
    for i in range(0, len(stations), chunk):
        part = stations[i:i + chunk]
        url = FIELD_URL.format(
            lats=",".join(f"{s['lat']:.4f}" for s in part),
            lons=",".join(f"{s['lon']:.4f}" for s in part))
        data = json.loads(http_get(url, timeout=40))
        if isinstance(data, dict):
            data = [data]
        for st, res in zip(part, data):
            h = res.get("hourly") or {}
            at = {t: j for j, t in enumerate(h.get("time", []))}
            row = {"nr": st["nr"], "t": [], "spd": [], "dir": [], "precip": []}
            for k in keys:
                j = at.get(k)
                row["t"].append(None if j is None or h["temperature_2m"][j] is None
                                else round(h["temperature_2m"][j], 1))
                row["spd"].append(None if j is None or h["wind_speed_10m"][j] is None
                                  else round(h["wind_speed_10m"][j]))
                row["dir"].append(None if j is None or h["wind_direction_10m"][j] is None
                                  else round(h["wind_direction_10m"][j] / 5) * 5)
                row["precip"].append(None if j is None or h["precipitation"][j] is None
                                     else round(h["precipitation"][j], 1))
            out.append(row)
    return {"times": [iso(t) for t in frames], "stations": out}


def derived_field(rows, analysis, stations):
    """Fallback when the model will not answer: carry each station's present
    difference from home forward along the home forecast. Crude beyond a few
    hours, but it is measured, it is honest, and it beats an empty map."""
    here = analysis.get("here") or {}
    if not rows or here.get("t") is None:
        return None
    frames = [r for i, r in enumerate(rows) if i <= 24 or i % 3 == 0]
    out = []
    for st in stations:
        dt = None if st.get("t") is None else st["t"] - here["t"]
        dspd = (None if st.get("spd") is None or here.get("spd") is None
                else st["spd"] - here["spd"])
        row = {"nr": st["nr"], "t": [], "spd": [], "dir": [], "precip": []}
        for r in frames:
            row["t"].append(None if r["t"] is None or dt is None
                            else round(r["t"] + dt, 1))
            row["spd"].append(None if r["spd"] is None else
                              max(0, round(r["spd"] + (dspd or 0))))
            row["dir"].append(None if r["dir"] is None else round(r["dir"] / 5) * 5)
            row["precip"].append(None if r.get("precip") is None
                                 else round(r["precip"], 1))
        out.append(row)
    return {"times": [iso(r["valid"]) for r in frames], "stations": out,
            "derived": True}


def station_field(conn, cfg, stations, rows=None, analysis=None):
    """Cached so a build every 20 minutes does not mean a fetch every 20."""
    if not cfg.get("station_field", True) or not stations:
        return None
    conn.execute(
        """CREATE TABLE IF NOT EXISTS sources (
             key TEXT PRIMARY KEY, fetched TEXT, payload TEXT)""")
    cutoff = iso(now_utc() - timedelta(hours=cfg.get("field_max_age_hours", 3)))
    row = conn.execute("SELECT * FROM sources WHERE key='field' AND fetched >= ?",
                       (cutoff,)).fetchone()
    if row:
        cached = json.loads(row["payload"])
        # A cache written before a field was added is worse than no cache: it
        # looks fresh and silently answers None for the missing one.
        first = (cached.get("stations") or [{}])[0]
        if all(k in first for k in ("t", "spd", "dir", "precip")):
            return cached
        log("eldri útgáfa af spá fyrir stöðvar í skyndiminni — sæki upp á nýtt")
    # After a refusal, wait before asking again — retrying on every build is
    # what gets us rate-limited in the first place.
    cooling = conn.execute(
        "SELECT * FROM sources WHERE key='field_wait' AND fetched >= ?",
        (iso(now_utc() - timedelta(minutes=20)),)).fetchone()
    if cooling:
        log("bíð með að sækja spá fyrir stöðvar (of margar fyrirspurnir nýlega)")
        return derived_field(rows, analysis, stations) if rows else None
    try:
        field = fetch_field(stations, now_utc().replace(minute=0, second=0, microsecond=0))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
            OSError, KeyError, ValueError, IndexError) as exc:
        log(f"spá fyrir stöðvarnar ekki tiltæk: {exc}")
        old = conn.execute("SELECT * FROM sources WHERE key='field'").fetchone()
        if not old:
            return None
        conn.execute("INSERT OR REPLACE INTO sources VALUES ('field_wait',?,'')",
                     (iso(now_utc()),))
        conn.commit()
        if old:
            stale = json.loads(old["payload"])
            first = (stale.get("stations") or [{}])[0]
            if all(k in first for k in ("t", "spd", "dir", "precip")):
                return stale      # older, but the right shape — better than nothing
        return derived_field(rows, analysis, stations) if rows else None
    conn.execute("INSERT OR REPLACE INTO sources VALUES (?,?,?)",
                 ("field", iso(now_utc()), json.dumps(field, ensure_ascii=False)))
    conn.commit()
    log(f"spá fyrir stöðvar: {len(field['stations'])} stöðvar, {len(field['times'])} tímapunktar")
    return field


def cache_source(conn, source):
    conn.execute(
        """CREATE TABLE IF NOT EXISTS sources (
             key TEXT PRIMARY KEY, fetched TEXT, payload TEXT)""")
    conn.execute("INSERT OR REPLACE INTO sources VALUES (?,?,?)",
                 (source["key"], iso(now_utc()),
                  json.dumps(source, ensure_ascii=False)))
    conn.commit()


def cached_sources(conn, max_age_hours=4):
    conn.execute(
        """CREATE TABLE IF NOT EXISTS sources (
             key TEXT PRIMARY KEY, fetched TEXT, payload TEXT)""")
    cutoff = iso(now_utc() - timedelta(hours=max_age_hours))
    # 'field' shares this table but is a map layer, not a forecast source.
    rows = conn.execute(
        "SELECT * FROM sources WHERE fetched >= ? AND key != 'field'",
        (cutoff,)).fetchall()
    out = {}
    for r in rows:
        try:
            src = json.loads(r["payload"])
            src["fetched"] = r["fetched"]
            src["stale"] = True
            out[r["key"]] = src
        except json.JSONDecodeError:
            continue
    return out


NET_ERRORS = (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError,
              ValueError, KeyError, TypeError, json.JSONDecodeError)


def gather_sources(cfg, conn):
    """Every forecast we can reach. A source that fails falls back to its last
    good copy, so one outage never empties the comparison."""
    collected = {}
    for fetcher in (fetch_imo, fetch_yr):
        try:
            src = fetcher(cfg)
            src["fetched"] = iso(now_utc())
            collected[src["key"]] = src
            cache_source(conn, src)
        except NET_ERRORS as exc:
            log(f"spágjafinn {fetcher.__name__} er ekki tiltækur: {exc}")
    try:
        for src in fetch_open_meteo_models(cfg):
            src["fetched"] = iso(now_utc())
            collected[src["key"]] = src
            cache_source(conn, src)
    except NET_ERRORS as exc:
        log(f"reiknilíkönin eru ekki tiltæk: {exc}")

    for key, src in cached_sources(conn).items():
        collected.setdefault(key, src)
    return collected


def median(values):
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None
    mid = len(vals) // 2
    return vals[mid] if len(vals) % 2 else (vals[mid - 1] + vals[mid]) / 2


def median_direction(dirs):
    """Median of the wind vector components, then back to a bearing. Averaging
    the angles themselves breaks when they straddle north."""
    pairs = [to_uv(d, 1.0) for d in dirs if d is not None]
    if not pairs:
        return None
    u = median([p[0] for p in pairs])
    v = median([p[1] for p in pairs])
    strength, direction = from_uv(u, v)
    if strength < 0.05:
        return None, 0.0
    return round(direction, 1), round(strength, 2)


def build_median(sources, own_rows, hours=48):
    """The middle of every forecast we have, hour by hour."""
    members = dict(sources)
    if own_rows:
        members["vedurvakt"] = {
            "key": "vedurvakt", "label": "Veðurvakt", "provider": "þessi síða",
            "hours": [{"valid": _hour_key(r["valid"]), "t": r["t"], "spd": r["spd"],
                       "dir": r["dir"], "precip": r.get("precip"),
                       "cloud": r.get("cloud")} for r in own_rows],
        }
    start = now_utc().replace(minute=0, second=0, microsecond=0)
    grid = [start + timedelta(hours=i) for i in range(hours + 1)]
    index = {k: {h["valid"]: h for h in v["hours"]} for k, v in members.items()}

    out = []
    for t in grid:
        key = _hour_key(t)
        picks = [index[k][key] for k in index if key in index[k]]
        if len(picks) < 2:
            continue
        temps = [p.get("t") for p in picks if p.get("t") is not None]
        md_dir, md_agree = median_direction([p.get("dir") for p in picks])
        out.append({
            "valid": key,
            "t": round(median(temps), 1) if temps else None,
            "spd": round(median([p.get("spd") for p in picks]), 1),
            "dir": md_dir,
            "dir_agree": md_agree,
            "precip": round(median([p.get("precip") for p in picks]) or 0, 2),
            "cloud": median([p.get("cloud") for p in picks]),
            "rh": median([p.get("rh") for p in picks]),
            "n": len(picks),
            "t_low": round(min(temps), 1) if temps else None,
            "t_high": round(max(temps), 1) if temps else None,
            "spread": round(max(temps) - min(temps), 1) if len(temps) > 1 else 0.0,
        })
    return members, out


# --------------------------------------------------------------------------
# payload for the web front end
# --------------------------------------------------------------------------


def trim_hours(hours, limit=48):
    start = _hour_key(now_utc() - timedelta(hours=1))
    out = []
    for h in hours:
        if h["valid"] < start:
            continue
        out.append({k: (round(v, 1) if isinstance(v, float) else v)
                    for k, v in h.items() if k != "word"})
        if len(out) >= limit + 1:
            break
    return out


def payload(cfg):
    analysis, rows = make_forecast(cfg)
    here = analysis["here"] or {}
    scores = verify(cfg)
    conn = db()
    try:
        sources = gather_sources(cfg, conn)
    except sqlite3.Error as exc:
        log(f"náði ekki í spágjafa: {exc}")
        sources = {}
    members, med = build_median(sources, rows)
    try:
        field = station_field(conn, cfg, analysis["everywhere"], rows, analysis)
    except sqlite3.Error as exc:
        log(f"spá fyrir stöðvar mistókst: {exc}")
        field = None
    conn.close()
    source_list = [{
        "key": s["key"], "label": s["label"], "provider": s.get("provider", ""),
        "fetched": s.get("fetched"), "stale": bool(s.get("stale")),
        "hours": trim_hours(s["hours"]),
    } for s in sorted(members.values(), key=lambda s: s["label"].lower())]
    return {
        "sources": source_list,
        "median": med,
        "issued": analysis["issued"],
        "source": analysis["source"],
        "place": cfg["name"],
        "lat": cfg["lat"],
        "lon": cfg["lon"],
        "now": {
            "t": here.get("t"), "dir": here.get("dir"), "spd": here.get("spd"),
            "gust": here.get("gust"), "rh": here.get("rh"), "td": here.get("td"),
            "p": here.get("p"), "sea": here.get("sea"),
            "ts": here.get("ts"), "station": here.get("name"),
            "cloud": None if analysis["sun"]["index"] is None
                     else round(100 * (1 - analysis["sun"]["index"])),
        },
        "analysis": {
            "gradient": analysis["gradient"],
            "sun": analysis["sun"],
            "breeze": analysis["breeze"],
            "tendency": analysis["tendency"],
            "marine": analysis["marine"],
            "station_count": analysis["station_count"],
            "notes": narrative(analysis, rows, cfg),
        },
        "stations": analysis["everywhere"],
        "field": field,
        "radius_km": cfg["radius_km"],
        "hours": [{
            "valid": iso(r["valid"].replace(minute=0, second=0)),
            "t": r["t"], "spd": r["spd"], "gust": r["gust"], "dir": r["dir"],
            "cloud": r.get("cloud"), "precip": r.get("precip"), "rh": r.get("rh"),
        } for r in rows],
        "verification": scores,
    }


def write_site_data(cfg, root):
    root = Path(root)
    data_dir = root / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    # Compact: with a forecast for every station, pretty-printing costs more
    # bytes than the data itself.
    body = json.dumps(payload(cfg), ensure_ascii=False, default=str,
                      separators=(",", ":"))
    (data_dir / "latest.json").write_text(body, encoding="utf-8")
    return data_dir / "latest.json"


OG_FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial.ttf",
]


def og_font(size):
    from PIL import ImageFont
    for path in OG_FONTS:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def write_og_image(cfg, root, data):
    """The picture that shows up when the link is pasted into a message.
    Drawn fresh every build, so the preview carries the current weather."""
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        log("sleppi forskoðunarmynd (Pillow ekki uppsett)")
        return None

    W, H = 1200, 630
    PETROL, EMBER, PAPER, SEA = (21, 81, 78), (232, 163, 61), (244, 241, 234), (63, 130, 124)
    img = Image.new("RGB", (W, H), PETROL)
    d = ImageDraw.Draw(img)

    now = data["now"]
    hours = data["hours"]
    t = now.get("t")
    spd = now.get("spd")

    d.text((70, 62), "VEÐURVAKT", font=og_font(30), fill=EMBER)
    d.text((70, 112), data["place"], font=og_font(74), fill=PAPER)

    big = "—" if t is None else f"{t:.1f}".replace(".", ",") + "°"
    d.text((70, 214), big, font=og_font(180), fill=EMBER)

    line = []
    if spd is not None:
        line.append(f"{compass(now.get('dir'))} {spd:.0f} m/s")
    if now.get("gust") is not None:
        line.append(f"hviður {now['gust']:.0f}")
    if now.get("rh") is not None:
        line.append(f"raki {now['rh']:.0f}%")
    d.text((74, 424), "   ·   ".join(line), font=og_font(38), fill=PAPER)

    # the next few hours along the bottom
    y = 512
    step = (W - 140) // 6
    for i, h in enumerate(hours[1:7]):
        x = 74 + i * step
        when = h["valid"][11:16]
        d.text((x, y), when, font=og_font(26), fill=(150, 178, 172))
        val = "—" if h.get("t") is None else f"{h['t']:.0f}°"
        d.text((x, y + 34), val, font=og_font(40), fill=PAPER)

    d.rectangle([0, H - 8, W, H], fill=EMBER)
    stamp = data["issued"][11:16]
    d.text((W - 300, 74), f"kl. {stamp}", font=og_font(30), fill=SEA)

    out = Path(root) / "og.png"
    img.save(out)
    return out


def site_url(cfg):
    url = (cfg.get("site_url") or "").strip()
    if not url and cfg.get("domain"):
        url = "https://" + cfg["domain"].strip()
    return url.rstrip("/")


def write_og_tags(cfg, root):
    """Point the preview tags at the real address; scrapers need absolute URLs."""
    base = site_url(cfg)
    if not base:
        return
    page = Path(root) / "index.html"
    if not page.exists():
        return
    html = page.read_text(encoding="utf-8")
    tags = (
        f'<meta property="og:type" content="website">\n'
        f'<meta property="og:site_name" content="Veðurvakt">\n'
        f'<meta property="og:locale" content="is_IS">\n'
        f'<meta property="og:title" content="Veðrið í {cfg["name"]}">\n'
        f'<meta property="og:description" content="Sjálfvirk veðurspá úr mæligögnum '
        f'Vegagerðarinnar. Uppfærð á tuttugu mínútna fresti.">\n'
        f'<meta property="og:url" content="{base}/">\n'
        f'<meta property="og:image" content="{base}/og.png">\n'
        f'<meta property="og:image:width" content="1200">\n'
        f'<meta property="og:image:height" content="630">\n'
        f'<meta name="twitter:card" content="summary_large_image">'
    )
    new = re.sub(r"<!--og-->.*?<!--/og-->", "<!--og-->\n" + tags + "\n<!--/og-->",
                 html, flags=re.S)
    if new != html:
        page.write_text(new, encoding="utf-8")


def build(cfg, root):
    """One CI pass: collect, forecast, write the JSON the static site reads."""
    collect(cfg)
    out = write_site_data(cfg, root)
    try:
        data = json.loads(out.read_text(encoding="utf-8"))
        if write_og_image(cfg, root, data):
            write_og_tags(cfg, root)
    except Exception as exc:                      # a preview is never worth a failed build
        log(f"forskoðunarmynd mistókst: {exc}")
    domain = (cfg.get("domain") or "").strip()
    if domain:
        # GitHub Pages reads this file from the published site; writing it every
        # build means the custom domain survives a redeploy.
        (Path(root) / "CNAME").write_text(domain + "\n", encoding="utf-8")
        log(f"lén: {domain}")
    prune(days=60)
    log(f"skrifaði {out}")
    return out


# --------------------------------------------------------------------------
# local server: the same static site, served from this machine
# --------------------------------------------------------------------------

SITE_DIR = Path(__file__).resolve().parent / "site"

MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
        ".png": "image/png", ".ico": "image/x-icon"}


class Handler(BaseHTTPRequestHandler):
    cfg = None
    cache = {"at": 0, "body": None}

    def log_message(self, *args):
        pass

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/data/latest.json", "/api"):
            return self._send_data()
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        target = (SITE_DIR / rel).resolve()
        if not str(target).startswith(str(SITE_DIR)) or not target.is_file():
            return self._send(404, b"not found", "text/plain")
        self._send(200, target.read_bytes(), MIME.get(target.suffix, "text/plain"))

    def _send_data(self):
        cache = Handler.cache
        if cache["body"] and time.time() - cache["at"] < 240:
            return self._send(200, cache["body"], MIME[".json"])
        try:
            body = json.dumps(payload(Handler.cfg), ensure_ascii=False,
                              default=str).encode("utf-8")
        except (RuntimeError, sqlite3.Error, ValueError) as exc:
            return self._send(503, json.dumps({"error": str(exc)}).encode(),
                              MIME[".json"])
        Handler.cache = {"at": time.time(), "body": body}
        self._send(200, body, MIME[".json"])

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve(cfg, port=None):
    Handler.cfg = cfg
    port = port or cfg["port"]
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    log(f"mælaborðið er á http://localhost:{port}")
    srv.serve_forever()


def run_forever(cfg):
    def loop():
        last_forecast = 0
        while True:
            try:
                collect(cfg)
                if time.time() - last_forecast > cfg["forecast_minutes"] * 60:
                    Handler.cache = {"at": 0, "body": None}
                    write_site_data(cfg, SITE_DIR)
                    last_forecast = time.time()
                    log("spá uppfærð")
                prune()
            except (urllib.error.URLError, TimeoutError, OSError, sqlite3.Error,
                    ValueError, KeyError, RuntimeError) as exc:
                log(f"umferðin mistókst, reyni aftur á næsta hring: {exc}")
            time.sleep(cfg["collect_minutes"] * 60)

    threading.Thread(target=loop, daemon=True).start()
    serve(cfg)


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------


def cmd_forecast(cfg, args):
    analysis, rows = make_forecast(cfg)
    print(f"\n  {cfg['name']} — gefin út {analysis['issued']}  [{analysis['source']}]\n")
    for line in narrative(analysis, rows, cfg):
        print(f"  {line}")
    print()
    print("  tími         °C   vindur        hviða  veður")
    # strftime speaks whatever locale the shell has, so name the days here.
    days = ["mán", "þri", "mið", "fim", "fös", "lau", "sun"]
    for r in rows[:24]:
        stamp = f"{days[r['valid'].weekday()]} {r['valid'].strftime('%H:%M')}"
        print(f"  {stamp}  {num(r['t']):>5}  "
              f"{compass(r['dir']):>3} {num(r['spd']):>4} m/s  {r['gust']:4.0f}  "
              f"{describe_cloud(r.get('cloud'))}")
    print()


def cmd_config(cfg, args):
    if args.set:
        for pair in args.set:
            if "=" not in pair:
                print(f"sleppi '{pair}' — notaðu lykill=gildi")
                continue
            k, v = pair.split("=", 1)
            if k not in DEFAULT_CONFIG:
                print(f"óþekkt stilling '{k}'")
                continue
            old = DEFAULT_CONFIG[k]
            cfg[k] = type(old)(v) if not isinstance(old, bool) else v.lower() in ("1", "true", "yes")
        save_config(cfg)
        print("vistað")
    print(json.dumps(cfg, indent=2, ensure_ascii=False))
    print(f"\ngagnagrunnur: {DB_PATH}")


def main():
    p = argparse.ArgumentParser(description="Veðurvakt — sjálfvirk veðurspá úr mæligögnum")
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("collect", help="sækja eina mælingu frá öllum stöðvum")
    sub.add_parser("forecast", help="reikna spá og prenta hana")
    s = sub.add_parser("serve", help="keyra mælaborðið")
    s.add_argument("--port", type=int)
    b = sub.add_parser("build", help="skrifa site/data/latest.json (notað í CI)")
    b.add_argument("--out", default=str(Path(__file__).resolve().parent / "site"))
    sub.add_parser("run", help="sækja, spá og þjóna samfellt")
    v = sub.add_parser("verify", help="bera fyrri spár saman við mælingar")
    v.add_argument("--days", type=int, default=30)
    c = sub.add_parser("config", help="skoða eða breyta stillingum")
    c.add_argument("--set", nargs="*", metavar="lykill=gildi")
    args = p.parse_args()
    cfg = load_config()

    if args.cmd == "collect":
        collect(cfg)
    elif args.cmd == "forecast":
        cmd_forecast(cfg, args)
    elif args.cmd == "serve":
        serve(cfg, args.port)
    elif args.cmd == "build":
        build(cfg, args.out)
    elif args.cmd == "run":
        run_forever(cfg)
    elif args.cmd == "verify":
        print(json.dumps(verify(cfg, args.days), indent=2, ensure_ascii=False))
    elif args.cmd == "config":
        cmd_config(cfg, args)
    else:
        p.print_help()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print()
