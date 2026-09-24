#!/usr/bin/env node
// Builds data/places/places.json — the place gazetteer behind location search
// (utils/places.js) — from a GeoNames India dump plus the hand-curated
// data/places/overrides.json. Dev-time only: production never downloads
// anything, it loads the committed JSON.
//
//   curl -fsSLO https://download.geonames.org/export/dump/IN.zip && unzip IN.zip
//   curl -fsSLO https://download.geonames.org/export/dump/admin1CodesASCII.txt
//   curl -fsSLO https://download.geonames.org/export/dump/admin2Codes.txt
//   node scripts/build-places.js --src <that dir> [--min-pop 5000]
//
// GeoNames data is CC BY 4.0 (https://www.geonames.org/) — attribution is in
// data/places/README.md and on the customer site. Ids are GeoNames ids
// (gn:<id>, stable across dumps) or the curated state slugs (st:<slug>), so a
// rebuild never changes a place's id. The output is deterministic (sorted).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { normalizePlaceText, compactKey } = require("../utils/placeText");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "data", "places", "places.json");
const OVERRIDES = path.join(ROOT, "data", "places", "overrides.json");
const GOA_A1 = "33";
const SKIP_PPL = new Set(["PPLQ", "PPLH", "PPLW", "PPLCH", "PPLR"]);
const MAX_ALIASES = 6;
// Places sent to the customer site's suggestion index (utils/places.js
// clientIndex): states, districts, Goa talukas, every Goa place, cities of
// 50k+, curated names and the curated popular destinations. The server
// resolves the whole file.
const CLIENT_MIN_POP = 50000;

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const km = (a, b) => {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// Latin-script alternate names only (the site searches in Latin script), no
// airport/station codes, nothing that normalises to the name itself.
function usableAlias(s) {
  if (!s || s.length < 3 || s.length > 40) return false;
  if (!/^[A-Z]/.test(s.normalize("NFKD"))) return false;
  if (/^[A-Z0-9]{2,5}$/.test(s)) return false;
  const stripped = s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  return /^[A-Za-z][A-Za-z .'\-()]*$/.test(stripped) && !/\(/.test(stripped);
}

function localityType(fcode, pop, fclass) {
  if (fclass === "T" && fcode === "BCH") return "beach";
  if (fclass === "T") return "island";
  if (fcode === "PPLX") return "area";
  if (fcode === "PPLC" || fcode === "PPLA" || pop >= 100000) return "city";
  if (pop >= 5000) return "town";
  return "village";
}

// Membership radius for a locality: ~4.7 km for Panaji (71k), ~5.3 km for
// Vasco (100k), 1.5 km floor for villages, 25 km cap for metros.
function radiusKm(pop) {
  return round(Math.min(25, 1.5 + 1.2 * Math.sqrt(Math.max(pop, 0) / 10000)), 1);
}

async function main() {
  const src = arg("src");
  const minPop = Number(arg("min-pop", "5000"));
  if (!src) throw new Error("usage: node scripts/build-places.js --src <geonames dir> [--min-pop 5000]");
  const files = { places: path.join(src, "IN.txt"), admin1: path.join(src, "admin1CodesASCII.txt"), admin2: path.join(src, "admin2Codes.txt") };
  for (const f of Object.values(files)) if (!fs.existsSync(f)) throw new Error(`missing ${f}`);
  const ov = JSON.parse(fs.readFileSync(OVERRIDES, "utf8"));
  const include = new Set(ov.include || []);
  const exclude = new Set(ov.exclude || []);
  const stateByA1 = new Map(ov.states.map((s) => [s.a1, s]));
  const a1ByState = new Map(ov.states.map((s) => [s.id, s.a1]));
  // popular destinations by (state a1, compact name) — matched on the name,
  // the ASCII name or any alternate name while streaming
  const popularWanted = new Map();
  for (const p of ov.popular || []) {
    const a1 = a1ByState.get(p.state);
    if (!a1) throw new Error(`popular ${p.name}: unknown state ${p.state}`);
    popularWanted.set(`${a1}|${compactKey(normalizePlaceText(p.name))}`, p);
  }
  const popularFound = new Map(); // wanted key -> best base

  // admin2 code → district geonameid
  const adm2Ids = new Map();
  for (const line of fs.readFileSync(files.admin2, "utf8").split("\n")) {
    const [code, , , gid] = line.split("\t");
    if (code && code.startsWith("IN.") && gid) adm2Ids.set(code.slice(3), gid.trim());
  }
  const adm2GeonameIds = new Set(adm2Ids.values());

  const states = new Map(); // a1 -> {lat,lng}
  const districts = new Map(); // gid -> place
  const talukas = new Map(); // a3 -> place (Goa)
  const localities = [];

  const rl = readline.createInterface({ input: fs.createReadStream(files.places, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    const c = line.split("\t");
    if (c.length < 15) continue;
    const [gid, name, ascii, alt, latS, lngS, fclass, fcode, , , a1, a2, a3] = c;
    const pop = Number(c[14]) || 0;
    const lat = Number(latS);
    const lng = Number(lngS);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const id = `gn:${gid}`;
    if (exclude.has(id)) continue;
    const base = { gid, id, name, ascii, alt, lat, lng, fclass, fcode, a1, a2, a3, pop };
    if (fclass === "A" && fcode === "ADM1") {
      if (stateByA1.has(a1)) states.set(a1, { lat, lng, pop });
    } else if (fclass === "A" && fcode === "ADM2" && adm2GeonameIds.has(gid)) {
      districts.set(gid, base);
    } else if (fclass === "A" && fcode === "ADM3" && a1 === GOA_A1) {
      talukas.set(a3, base);
    } else if (fclass === "P" && !SKIP_PPL.has(fcode)) {
      for (const nm of [ascii, name, ...String(alt || "").split(",")]) {
        const wk = `${a1}|${compactKey(normalizePlaceText(nm))}`;
        if (!popularWanted.has(wk)) continue;
        const prev = popularFound.get(wk);
        if (!prev || pop > prev.pop) popularFound.set(wk, base);
      }
      const goa = a1 === GOA_A1;
      const big = pop >= minPop || fcode === "PPLC" || fcode === "PPLA" || fcode === "PPLA2";
      if (goa || big || include.has(id)) localities.push(base);
    } else if (fclass === "T" && (fcode === "BCH" || fcode === "ISL") && a1 === GOA_A1) {
      localities.push(base);
    }
  }

  const popularIds = new Set();
  const missing = [...popularWanted].filter(([wk]) => !popularFound.has(wk)).map(([, p]) => `${p.name} (${p.state})`);
  if (missing.length) throw new Error(`popular destinations not found in the dump: ${missing.join(", ")}`);
  for (const [wk] of popularWanted) {
    const hit = popularFound.get(wk);
    popularIds.add(hit.id);
    if (!localities.some((x) => x.id === hit.id)) localities.push(hit);
  }

  // Goa settlements without district / taluka codes inherit them from the
  // nearest coded Goa settlement.
  const coded = localities.filter((p) => p.a1 === GOA_A1 && p.a2 && p.a3);
  for (const p of localities) {
    if (p.a1 !== GOA_A1 || (p.a2 && p.a3)) continue;
    let best = null;
    for (const q of coded) {
      const d = km(p, q);
      if (!best || d < best.d) best = { d, q };
    }
    if (best && best.d <= 15) {
      p.a2 = p.a2 || best.q.a2;
      p.a3 = p.a3 || best.q.a3;
    }
  }

  // A settlement's alternate name that equals a state ("Goa" for Mormugao)
  // would hijack the state search: never an alias of a non-state place.
  const stateKeys = new Set(ov.states.flatMap((st) => [st.name, ...(st.aliases || [])]).map((x) => compactKey(normalizePlaceText(x))));
  function aliasesFor(p, displayName, extra = []) {
    const seen = new Set([compactKey(normalizePlaceText(displayName)), ...stateKeys]);
    const out = [];
    const push = (s) => {
      const k = compactKey(normalizePlaceText(s));
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push(s);
    };
    for (const s of extra) push(s);
    const cands = [p.ascii, p.name, ...String(p.alt || "").split(",")].filter(usableAlias);
    for (const s of cands) {
      if (out.length >= MAX_ALIASES) break;
      push(s.normalize("NFKD").replace(/[̀-ͯ]/g, ""));
    }
    return out;
  }

  const out = [];
  const stateOut = [];
  for (const s of ov.states) {
    const geo = states.get(s.a1);
    if (!geo) throw new Error(`no ADM1 feature for ${s.name} (${s.a1})`);
    stateOut.push({ id: s.id, n: s.name, a: s.aliases || [], t: "state", lat: round(geo.lat, 4), lng: round(geo.lng, 4) });
  }
  const stateIdOf = (a1) => (stateByA1.get(a1) || {}).id || null;

  for (const d of districts.values()) {
    const sid = stateIdOf(d.a1);
    if (!sid) continue;
    const o = (ov.names || {})[d.id] || {};
    let n = o.name || d.ascii.replace(/\s+district$/i, "");
    out.push({ id: d.id, n, a: aliasesFor(d, n, [...(o.aliases || []), d.ascii]), t: "district", s: sid, lat: round(d.lat, 4), lng: round(d.lng, 4), p: d.pop || undefined });
  }
  for (const k of talukas.values()) {
    const o = (ov.names || {})[k.id] || {};
    const n = o.name || k.ascii;
    const dg = adm2Ids.get(`${k.a1}.${k.a2}`);
    out.push({ id: k.id, n, a: aliasesFor(k, n, o.aliases || []), t: "taluka", s: stateIdOf(k.a1), d: dg ? `gn:${dg}` : undefined, lat: round(k.lat, 4), lng: round(k.lng, 4), p: k.pop || undefined });
  }

  // One locality per (district, name): GeoNames repeats some settlements.
  const byKey = new Map();
  for (const p of localities) {
    const sid = stateIdOf(p.a1);
    if (!sid) continue;
    const o = (ov.names || {})[p.id] || {};
    const n = o.name || p.ascii;
    const key = `${p.a1}.${p.a2}|${compactKey(normalizePlaceText(n))}`;
    const prev = byKey.get(key);
    const rank = (x) => (include.has(x.id) || popularIds.has(x.id) || (ov.names || {})[x.id] ? 1e12 : 0) + x.pop;
    if (prev && rank(prev) >= rank(p)) continue;
    byKey.set(key, p);
  }
  for (const p of byKey.values()) {
    const o = (ov.names || {})[p.id] || {};
    const n = o.name || p.ascii;
    const dg = adm2Ids.get(`${p.a1}.${p.a2}`);
    const t = localityType(p.fcode, p.pop, p.fclass);
    const k = p.a1 === GOA_A1 && talukas.get(p.a3) ? talukas.get(p.a3).id : undefined;
    const v = p.a1 === GOA_A1 || p.pop >= CLIENT_MIN_POP || popularIds.has(p.id) || include.has(p.id) || !!(ov.names || {})[p.id] ? 1 : undefined;
    out.push({ id: p.id, n, a: aliasesFor(p, n, o.aliases || []), t, s: stateIdOf(p.a1), d: dg ? `gn:${dg}` : undefined, k, lat: round(p.lat, 4), lng: round(p.lng, 4), p: p.pop || undefined, r: radiusKm(p.pop), v, fav: popularIds.has(p.id) ? 1 : undefined });
  }

  for (const id of Object.keys(ov.names || {})) {
    if (!out.some((p) => p.id === id)) throw new Error(`override for ${id} matched no place`);
  }
  out.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  for (const p of out) if (!p.a.length) delete p.a;
  const doc = {
    version: 1,
    source: {
      name: "GeoNames (https://www.geonames.org/), CC BY 4.0",
      files: { "IN.txt": sha256(files.places), "admin1CodesASCII.txt": sha256(files.admin1), "admin2Codes.txt": sha256(files.admin2) },
      overrides: sha256(OVERRIDES),
      minPop,
    },
    redirects: ov.redirects || {},
    states: stateOut,
    places: out,
  };
  const json = JSON.stringify(doc);
  fs.writeFileSync(OUT, json + "\n");
  const counts = out.reduce((m, p) => ((m[p.t] = (m[p.t] || 0) + 1), m), {});
  const gz = require("zlib").gzipSync(json).length;
  console.log(`wrote ${path.relative(ROOT, OUT)}: ${stateOut.length} states, ${JSON.stringify(counts)}; ${(json.length / 1024).toFixed(0)} KB raw, ${(gz / 1024).toFixed(0)} KB gzip`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
