#!/usr/bin/env node
// Image pipeline — display variants for the photos already in the bucket.
//
// New uploads get their WebP display variants at upload time
// (controllers/uploadController.js). This script renders the same set for
// every listing photo and profile picture the database references, straight
// from each sanitised master in the bucket (never the CDN copy), and stores
// them under `<master key>/<set>/w<width>.webp` (services/storage.js).
//
// Owner-run. The database is only read. Dry run by default: nothing is
// written to the bucket without --apply, nothing is deleted without
// --prune --apply. Resumable and idempotent: a state file remembers finished
// and failed masters, an interrupted run (Ctrl-C) finishes the photos in
// flight, saves and exits, and a rerun picks up where it stopped; variants
// that already exist are never re-rendered (a LIST per master), so running
// it twice does no work the second time.
//
//   node scripts/image-variants-backfill.js [--uri="<DB_URI>"] [--apply] [--limit=N]
//        [--concurrency=2] [--state=./image-variants-backfill.state.json]
//        [--report=./image-variants-backfill.report.json] [--retry] [--recheck]
//        [--prune] [--only=<key substring>] [--quiet]
//
//   --apply        write the missing variants (default: report only)
//   --limit=N      stop after N masters that needed work
//   --concurrency  masters processed at the same time (default 2; each master
//                  renders its variants one at a time)
//   --state        progress file (created/updated; safe to delete to start over)
//   --retry        process only the masters recorded as failed in the state file
//   --recheck      ignore the state file's "done" list and re-verify every master
//   --prune        list the whole bucket and report variant objects whose master
//                  is no longer referenced (or that belong to an older set);
//                  with --apply they are deleted. Never touches masters.
//   --only=<s>     restrict to master keys containing <s> (smoke tests)
//   --urls=<file>  take the references from a JSON file (an array of photo /
//                  profile-picture URLs, or of { url, owner } objects) instead
//                  of the database — for an operator without database access
//                  (the list can come from the API); the database is not opened
//
//   env: DB_URI (or --uri), DO_SPACES_KEY / DO_SPACES_SECRET / DO_SPACES_BUCKET / REGION
//   Nothing secret is ever printed.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const sharp = require("sharp");
const storage = require("../services/storage");
const { makeVariants, hasMetadata } = require("../services/imageSanitizer");

function parseArgs(argv) {
  const args = argv.slice(2);
  const opt = (name) => {
    const a = args.find((x) => x.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : undefined;
  };
  return {
    uri: opt("uri") || process.env.DB_URI,
    apply: args.includes("--apply"),
    prune: args.includes("--prune"),
    retry: args.includes("--retry"),
    recheck: args.includes("--recheck"),
    quiet: args.includes("--quiet"),
    limit: Number(opt("limit") || 0),
    concurrency: Math.max(1, Number(opt("concurrency") || 2)),
    state: opt("state") || path.join(process.cwd(), "image-variants-backfill.state.json"),
    report: opt("report") || "",
    only: opt("only") || "",
    urls: opt("urls") || "",
  };
}

// Legacy masters predate the upload guard (40 MP); this runs on the owner's
// machine, so a 100 MP ceiling only rules out corrupt or hostile objects.
const BACKFILL_MAX_PIXELS = 100_000_000;

function md5(buf) {
  return crypto.createHash("md5").update(buf).digest("hex");
}

// --- state file (atomic writes) --------------------------------------------
function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (s && s.set === storage.VARIANT_SET && s.done && s.failed) return s;
  } catch {
    /* no state yet */
  }
  return { version: 1, set: storage.VARIANT_SET, startedAt: new Date().toISOString(), done: {}, failed: {} };
}
function saveState(file, state) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
}

// --- references --------------------------------------------------------------
// Every master key referenced by a listing photo or a profile picture — from
// the database, or from a JSON list of URLs (`--urls`).
async function referencedMasters(urlsFile) {
  const refs = new Map(); // master key → { owners: [...], urls: Set }
  const add = (url, owner) => {
    const key = storage.keyFromUrl(url);
    if (!key) return "foreign";
    const master = storage.masterKeyOf(key);
    const r = refs.get(master) || { owners: [], urls: new Set() };
    r.owners.push(owner);
    r.urls.add(url);
    refs.set(master, r);
    return "ours";
  };
  let foreign = 0;
  let total = 0;
  if (urlsFile) {
    const list = JSON.parse(fs.readFileSync(urlsFile, "utf8"));
    for (const item of Array.isArray(list) ? list : []) {
      const url = typeof item === "string" ? item : item && item.url;
      if (!url) continue;
      total += 1;
      if (add(url, (item && item.owner) || "list") === "foreign") foreign += 1;
    }
    return { refs, total, foreign };
  }
  const ListingProperty = require("../models/ListingProperty");
  const User = require("../models/User");
  for (const l of await ListingProperty.find({ photos: { $exists: true, $ne: [] } }).select("photos status").lean()) {
    for (const url of l.photos || []) {
      total += 1;
      if (add(url, `listing ${l._id} (${l.status})`) === "foreign") foreign += 1;
    }
  }
  for (const u of await User.find({ profilePicture: { $exists: true, $ne: null } }).select("profilePicture").lean()) {
    if (!u.profilePicture) continue;
    total += 1;
    if (add(u.profilePicture, `user ${u._id}`) === "foreign") foreign += 1;
  }
  return { refs, total, foreign };
}

// --- one master ----------------------------------------------------------------
// Resolves to { status, ... }: "complete" (nothing missing), "generated",
// "master-missing", "master-invalid", "failed".
async function processMaster(master, opts, log) {
  const expected = storage.variantKeys(master);
  const existing = new Map();
  for (const o of await storage.listKeys(`${master}/${storage.VARIANT_SET}/`)) existing.set(o.key, o);
  // an object with no bytes is a failed upload: treat as missing
  const missing = expected.filter((k) => !existing.has(k) || existing.get(k).size === 0);
  const strays = [...existing.keys()].filter((k) => !expected.includes(k));
  if (!missing.length) return { status: "complete", existing: existing.size, strays };

  const widths = missing.map((k) => Number(k.match(/\/w([0-9]+)\.webp$/)[1]));
  if (!opts.apply) return { status: "would-generate", missing: widths, existing: existing.size, strays };

  const obj = await storage.getObject(master);
  if (!obj) return { status: "master-missing", missing: widths };
  let meta;
  try {
    meta = await sharp(obj.body, { failOn: "error", limitInputPixels: BACKFILL_MAX_PIXELS }).metadata();
    if (!meta.width || !meta.height) throw new Error("no dimensions");
  } catch (err) {
    return { status: "master-invalid", error: String(err && err.message), missing: widths };
  }
  const masterMeta = await hasMetadata(obj.body).catch(() => false);

  const written = [];
  const failures = [];
  let bytes = 0;
  let reused = 0;
  const { errors } = await makeVariants(obj.body, {
    widths,
    limitInputPixels: BACKFILL_MAX_PIXELS,
    onVariant: async (v) => {
      const key = storage.variantKey(master, v.width);
      await storage.putObject(key, v.buffer, storage.VARIANT_CONTENT_TYPE);
      // validate what the bucket holds: size and MD5 (single-part PUT ETag)
      const head = await storage.headObject(key);
      const etag = head && String(head.etag || "").replace(/"/g, "");
      if (!head || head.size !== v.buffer.length || (etag && !etag.includes("-") && etag !== md5(v.buffer))) {
        throw new Error(`stored object does not match (size ${head && head.size} vs ${v.buffer.length})`);
      }
      if (head.contentType && head.contentType !== storage.VARIANT_CONTENT_TYPE) throw new Error(`stored content-type ${head.contentType}`);
      written.push(v.width);
      bytes += v.buffer.length;
      if (v.reused) reused += 1;
    },
  });
  for (const e of errors) failures.push(`w${e.width}: ${e.error}`);
  if (failures.length) return { status: "failed", error: failures.join("; "), written, bytes, masterMeta, master: { w: meta.width, h: meta.height, format: meta.format } };
  log(`  ✓ ${master} → ${written.length} variant(s), ${(bytes / 1024).toFixed(0)} KB${reused ? ` (${reused} reused: master narrower)` : ""}${masterMeta ? " [master still carries metadata → strip-image-metadata.js]" : ""}`);
  return { status: "generated", written, bytes, reused, masterMeta, master: { w: meta.width, h: meta.height, format: meta.format }, strays };
}

// --- prune ---------------------------------------------------------------------
async function prune(refs, opts, log) {
  const all = await storage.listKeys("");
  const orphans = [];
  let variants = 0;
  let masters = 0;
  let unreferencedMasters = 0;
  let bytes = 0;
  for (const o of all) {
    if (storage.isVariantKey(o.key)) {
      variants += 1;
      const master = storage.masterKeyOf(o.key);
      const set = o.key.match(/\/(v[0-9]+)\/w[0-9]+\.webp$/)[1];
      if (!refs.has(master) || set !== storage.VARIANT_SET) {
        orphans.push(o.key);
        bytes += o.size;
      }
    } else {
      masters += 1;
      if (!refs.has(o.key)) unreferencedMasters += 1;
    }
  }
  log(`[prune] bucket: ${all.length} objects (${masters} masters, ${variants} variants); ${orphans.length} orphan variant(s) (${(bytes / 1024 / 1024).toFixed(1)} MB); ${unreferencedMasters} master(s) not referenced by any listing or profile (reported only — masters are never pruned here)`);
  let deleted = 0;
  let failed = [];
  if (opts.apply && orphans.length) {
    const r = await storage.deleteObjects(orphans);
    deleted = r.deleted.length;
    failed = r.failed;
    log(`[prune] deleted ${deleted} orphan variant(s)${failed.length ? `, ${failed.length} failed` : ""}`);
  } else if (orphans.length) {
    log(`[prune] dry run — re-run with --prune --apply to delete them`);
  }
  return { objects: all.length, masters, variants, orphans: orphans.length, orphanBytes: bytes, unreferencedMasters, deleted, failed: failed.length, sample: orphans.slice(0, 10) };
}

// --- main ------------------------------------------------------------------------
async function run(opts, log = console.log) {
  if (!opts.uri && !opts.urls) throw new Error("--uri or DB_URI required (or --urls=<file>)");
  if ((opts.apply || opts.prune) && !(process.env.DO_SPACES_KEY && process.env.DO_SPACES_SECRET) && process.env.SPACES_MOCK !== "1") {
    throw new Error("DO_SPACES_KEY / DO_SPACES_SECRET are required for --apply / --prune");
  }
  const state = loadState(opts.state);
  // in-process callers (tests) may already hold the connection; a URL list needs none
  const ownConnection = !opts.urls && mongoose.connection.readyState !== 1;
  if (ownConnection) await mongoose.connect(opts.uri);
  let stopping = false;
  const onSigint = () => {
    if (stopping) process.exit(130);
    stopping = true;
    log("\n[backfill] stopping after the masters in flight — state is saved, re-run to resume");
  };
  process.on("SIGINT", onSigint);
  const summary = {
    set: storage.VARIANT_SET,
    widths: storage.VARIANT_WIDTHS,
    apply: opts.apply,
    references: 0,
    foreign: 0,
    masters: 0,
    considered: 0,
    skippedDone: 0,
    complete: 0,
    wouldGenerate: 0,
    generated: 0,
    variantsWritten: 0,
    bytesWritten: 0,
    reused: 0,
    mastersWithMetadata: 0,
    masterMissing: 0,
    masterInvalid: 0,
    failed: 0,
    strays: 0,
    interrupted: false,
    prune: null,
  };
  try {
    const { refs, total, foreign } = await referencedMasters(opts.urls);
    summary.references = total;
    summary.foreign = foreign;
    summary.masters = refs.size;
    let keys = [...refs.keys()].sort();
    if (opts.only) keys = keys.filter((k) => k.includes(opts.only));
    if (opts.retry) keys = keys.filter((k) => state.failed[k]);
    log(`[backfill] ${total} references (${foreign} outside our bucket) → ${refs.size} unique master(s)${opts.only ? `, ${keys.length} matching --only` : ""}${opts.retry ? `, ${keys.length} to retry` : ""}; set ${storage.VARIANT_SET}, widths ${storage.VARIANT_WIDTHS.join("/")}; ${opts.apply ? "APPLY" : "dry run"}`);

    let next = 0;
    let worked = 0;
    const failures = [];
    const worker = async () => {
      while (!stopping && next < keys.length) {
        if (opts.limit && worked >= opts.limit) return;
        const master = keys[next++];
        if (!opts.recheck && !opts.retry && state.done[master]) {
          summary.skippedDone += 1;
          continue;
        }
        summary.considered += 1;
        let r;
        try {
          r = await processMaster(master, opts, log);
        } catch (err) {
          r = { status: "failed", error: String((err && err.message) || err) };
        }
        if (r.strays && r.strays.length) summary.strays += r.strays.length;
        switch (r.status) {
          case "complete":
            summary.complete += 1;
            state.done[master] = { at: new Date().toISOString(), existing: r.existing };
            delete state.failed[master];
            break;
          case "would-generate":
            summary.wouldGenerate += 1;
            worked += 1;
            break;
          case "generated":
            summary.generated += 1;
            summary.variantsWritten += r.written.length;
            summary.bytesWritten += r.bytes;
            summary.reused += r.reused || 0;
            if (r.masterMeta) summary.mastersWithMetadata += 1;
            state.done[master] = { at: new Date().toISOString(), written: r.written, bytes: r.bytes, master: r.master };
            delete state.failed[master];
            worked += 1;
            break;
          case "master-missing":
            summary.masterMissing += 1;
            state.failed[master] = { at: new Date().toISOString(), error: "master missing (dangling reference)", owners: refs.get(master).owners.slice(0, 5) };
            failures.push(`${master}: master missing — referenced by ${refs.get(master).owners.slice(0, 3).join(", ")}`);
            worked += 1;
            break;
          case "master-invalid":
            summary.masterInvalid += 1;
            state.failed[master] = { at: new Date().toISOString(), error: `master not decodable: ${r.error}`, owners: refs.get(master).owners.slice(0, 5) };
            failures.push(`${master}: master not decodable (${r.error})`);
            worked += 1;
            break;
          default: {
            summary.failed += 1;
            const prev = state.failed[master] || { attempts: 0 };
            state.failed[master] = { at: new Date().toISOString(), error: r.error, attempts: (prev.attempts || 0) + 1, written: r.written || [] };
            failures.push(`${master}: ${r.error}`);
            worked += 1;
          }
        }
        if (summary.considered % 25 === 0) {
          saveState(opts.state, state);
          if (!opts.quiet) log(`[backfill] ${summary.considered}/${keys.length - summary.skippedDone} considered — complete ${summary.complete}, generated ${summary.generated}${opts.apply ? "" : `, would generate ${summary.wouldGenerate}`}, failed ${summary.failed + summary.masterMissing + summary.masterInvalid}`);
        }
      }
    };
    await Promise.all(Array.from({ length: opts.concurrency }, worker));
    summary.interrupted = stopping;
    saveState(opts.state, state);

    if (opts.prune) summary.prune = await prune(refs, opts, log);

    log(`[backfill] masters ${summary.masters}: already complete ${summary.complete}, skipped (done earlier) ${summary.skippedDone}, ${opts.apply ? `generated ${summary.generated} (${summary.variantsWritten} variants, ${(summary.bytesWritten / 1024 / 1024).toFixed(1)} MB, ${summary.reused} reused)` : `would generate ${summary.wouldGenerate}`}, master missing ${summary.masterMissing}, master invalid ${summary.masterInvalid}, failed ${summary.failed}${summary.strays ? `, stray objects under masters ${summary.strays} (see --prune)` : ""}${summary.mastersWithMetadata ? `; ${summary.mastersWithMetadata} master(s) still carry metadata → run scripts/strip-image-metadata.js --apply` : ""}${summary.interrupted ? " — INTERRUPTED, re-run to resume" : ""}`);
    for (const f of failures.slice(0, 50)) log(`  ✗ ${f}`);
    if (failures.length > 50) log(`  … ${failures.length - 50} more in the state file`);
    if (!opts.apply && summary.wouldGenerate) log(`[backfill] dry run — re-run with --apply to write the variants`);
    if (opts.report) fs.writeFileSync(opts.report, JSON.stringify({ at: new Date().toISOString(), summary, failures }, null, 1));
  } finally {
    process.off("SIGINT", onSigint);
    if (ownConnection) await mongoose.disconnect().catch(() => {});
    else if (opts.urls && mongoose.connection.readyState !== 1) { /* nothing was opened */ }
  }
  return summary;
}

if (require.main === module) {
  run(parseArgs(process.argv)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { run, parseArgs, processMaster, referencedMasters, prune, loadState };
