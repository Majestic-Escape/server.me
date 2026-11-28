// Which optional sections of the customer site are switched on (admin
// Settings: Experiences / Services). One SiteSetting document, "site_sections":
// { experiences, services, version, updatedBy, updatedAt }.
//
// The site reads the public view when it generates pages (header tabs, the
// sections' own routes, sitemap.xml) and never per visitor; every admin save
// purges its "site-sections" tag so the change shows on the next page load.
// A save that changes nothing still sends the purge: saving again is how an
// admin retries a refresh that did not go through. It is audited too
// (refreshOnly), since every purge regenerates every page of the site.
//
// Never saved, or a stored value that is not a boolean = DEFAULTS
// (Experiences on, Services off). The site falls back to the same values.
// Every change and its audit row are written in one transaction (fail
// closed: no audit row, no change).
const mongoose = require("mongoose");
const SiteSetting = require("../models/SiteSetting");
const adminAudit = require("./adminAudit");
const { notifyTags } = require("./listingChanged");

const DOC_ID = "site_sections";
const TAG = "site-sections";
const KEYS = ["experiences", "services"];
const DEFAULTS = Object.freeze({ experiences: true, services: false });

const coll = () => SiteSetting.collection;

function view(doc) {
  const out = {};
  for (const k of KEYS) out[k] = doc && typeof doc[k] === "boolean" ? doc[k] : DEFAULTS[k];
  return out;
}

async function getPublic() {
  return view(await coll().findOne({ _id: DOC_ID }, { projection: { experiences: 1, services: 1 } }));
}

async function getAdmin() {
  const doc = await coll().findOne({ _id: DOC_ID }, { projection: { experiences: 1, services: 1, updatedAt: 1 }, readPreference: "primary" });
  return { sections: view(doc), updatedAt: (doc && doc.updatedAt) || null };
}

// Own keys from the allow-list only, real booleans only, at least one.
function parsePatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (!keys.length || !keys.every((k) => KEYS.includes(k) && typeof body[k] === "boolean")) return null;
  const patch = {};
  for (const k of keys) patch[k] = body[k];
  return patch;
}

// The singleton exists before the transaction, so the transaction never upserts.
async function ensureDoc() {
  try {
    await coll().updateOne({ _id: DOC_ID }, { $setOnInsert: { ...DEFAULTS, version: 0, updatedBy: null, updatedAt: null } }, { upsert: true });
  } catch (err) {
    if (!(err && err.code === 11000)) throw err; // a concurrent first save created it
  }
}

// The site's pages + data cache and the backend's CDN entry; per-channel status for the admin UI.
async function notifySite() {
  try {
    const s = await notifyTags([TAG], "sections");
    return { site: (s.site && s.site.status) || "unknown", cdn: (s.cdn && s.cdn.status) || "unknown" };
  } catch (err) {
    return { site: "error", cdn: "error" };
  }
}

function result(status, body) {
  return { status, body };
}

/** PATCH /site/admin/sections  { experiences?: boolean, services?: boolean } */
async function update(req, actor, body) {
  const patch = parsePatch(body);
  if (!patch) {
    return result(400, { success: false, code: "INVALID_FIELDS", message: "Send experiences and/or services as true or false", statusCode: 400 });
  }
  let saved = null;
  let session = null;
  try {
    await ensureDoc();
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const doc = await coll().findOne({ _id: DOC_ID }, { session });
      const before = view(doc);
      const after = { ...before, ...patch };
      if (KEYS.every((k) => before[k] === after[k])) {
        // nothing changes, but the whole site is still refreshed: keep a trail of who did it
        await adminAudit.record(req, "site.sections.update", { targetType: "SiteSetting", targetKey: DOC_ID }, { before, after, refreshOnly: true }, { session });
        saved = { changed: false, sections: before, updatedAt: (doc && doc.updatedAt) || null };
        return;
      }
      const at = new Date();
      await coll().updateOne(
        { _id: DOC_ID },
        { $set: { ...after, updatedBy: new mongoose.Types.ObjectId(String(actor.id)), updatedAt: at }, $inc: { version: 1 } },
        { session },
      );
      await adminAudit.record(req, "site.sections.update", { targetType: "SiteSetting", targetKey: DOC_ID }, { before, after }, { session });
      saved = { changed: true, sections: after, updatedAt: at };
    });
  } catch (err) {
    // Rolled back, or (rarely) committed without confirmation: the admin UI re-reads either way.
    console.error("[site-sections] save failed", err && (err.code || err.name || err.message));
    return result(503, { success: false, code: "SECTIONS_SAVE_FAILED", message: "Couldn't save the change. Check the current setting and try again.", statusCode: 503 });
  } finally {
    if (session) await session.endSession().catch(() => {});
  }
  const notified = await notifySite();
  return result(200, { success: true, ...saved, notified });
}

module.exports = { DOC_ID, TAG, DEFAULTS, getPublic, getAdmin, update };
