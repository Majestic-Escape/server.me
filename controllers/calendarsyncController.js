// Calendar sync HTTP layer (SyncGuard — docs/syncguard.md).
//
// Every host endpoint resolves ownership server-side: a connection id is
// loaded, its listing is loaded, and the caller must be that listing's host
// (or an admin). A connection of another listing answers 404 — no oracle.
// The client-supplied propertyId is never trusted for authorisation.
//
// Logging rule: never log a calendar URL, an export token, a request body
// or a request path of the .ics route — they are credentials.
const ListingProperty = require("../models/ListingProperty");
const ExternalCalendar = require("../models/ExternalCalendar");
const authz = require("../middleware/authz");
const { isObjectId } = require("../middleware/validateObjectId");
const calendarSync = require("../services/calendarSync");

const { connections } = calendarSync;

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ success: false, code, message, statusCode: status, ...extra });
}
function handle(res, err, what) {
  if (err instanceof connections.ConnError) {
    if (err.extra && err.extra.retryAfterSeconds) res.set("Retry-After", String(err.extra.retryAfterSeconds));
    return fail(res, err.status, err.code, err.message, err.extra);
  }
  console.error(`[syncguard] ${what} failed:`, err && (err.code || err.name), err && err.message ? String(err.message).slice(0, 200) : "");
  return fail(res, 500, "SERVER_ERROR", "Something went wrong. Please try again.");
}

const LISTING_FIELDS = "host hostEmail title status";

// For routes guarded by requireListingHostOrAdmin("propertyId").
async function propertyFor(req, res) {
  const listing = await ListingProperty.findById(req.params.propertyId).select(LISTING_FIELDS).lean();
  if (!listing) {
    fail(res, 404, "NOT_FOUND", "Listing not found");
    return null;
  }
  return listing;
}

// Loads :connectionId and checks the caller owns its listing (404 otherwise).
async function loadOwnedConnection(req, res, next) {
  try {
    const actor = await authz.resolveActor(req);
    if (!actor) return fail(res, 401, "AUTH_REQUIRED", "Authentication required");
    const id = req.params.connectionId;
    if (!isObjectId(id)) return fail(res, 404, "NOT_FOUND", "Connection not found");
    const conn = await ExternalCalendar.findOne({ _id: id, kind: "import" }).lean();
    if (!conn) return fail(res, 404, "NOT_FOUND", "Connection not found");
    const listing = await ListingProperty.findById(conn.propertyId).select(LISTING_FIELDS).lean();
    if (!listing || !(authz.isAdmin(actor) || authz.isListingHost(actor, listing))) return fail(res, 404, "NOT_FOUND", "Connection not found");
    req.syncConn = conn;
    req.syncListing = listing;
    req.syncActorId = actor.id;
    next();
  } catch (err) {
    handle(res, err, "load connection");
  }
}

// --- legacy: POST /calendarSync/saveCalendar {propertyId, url?, kind} ----------
// Used by the old web calendar page and the mobile app; response shape kept:
// { success, message, url?, secret? }.
exports.saveCalendarUrl = async (req, res) => {
  try {
    const { propertyId, url, kind } = req.body || {};
    const listing = await ListingProperty.findById(propertyId).select(LISTING_FIELDS).lean();
    if (!listing) return fail(res, 404, "NOT_FOUND", "Listing not found");
    const actor = await authz.resolveActor(req);
    if (kind === "export") {
      const r = await connections.legacyExport({ listing, req });
      return res.json({ success: true, ...(r.existing ? { message: "Export calendar already exists" } : {}), url: r.url, secret: r.secret });
    }
    if (kind === "import") {
      const r = await connections.legacyImport({ listing, actorId: actor && actor.id, url });
      return res.json({
        success: true,
        message: r.replaced ? "Calendar link updated: the old link no longer worked, so it was replaced. We will keep checking for updates." : r.existing ? "Calendar already synced. We will keep checking for updates." : "Calendar sync has started. Please wait a few minutes and refresh the page.",
      });
    }
    return fail(res, 400, "VALIDATION", 'kind must be "import" or "export"');
  } catch (err) {
    if (err instanceof connections.ConnError) {
      // The clients of this endpoint (old web page, the mobile app) show
      // `message` only for a 2xx `{success:false}` — on a 4xx they print a
      // generic "Request failed…". A refused link (not https, not public,
      // not a calendar, rate limited…) is an answer to show, so it is
      // returned that way. Auth/ownership failures keep their status.
      if ([400, 409, 422, 429].includes(err.status)) {
        if (err.extra && err.extra.retryAfterSeconds) res.set("Retry-After", String(err.extra.retryAfterSeconds));
        return res.status(200).json({ success: false, code: err.code, message: err.message });
      }
      return res.status(err.status).json({ success: false, code: err.code, message: err.message });
    }
    return handle(res, err, "saveCalendar");
  }
};

// --- public feed: GET /calendarSync/ics/:secret.ics -------------------------------
exports.exportCalendar = async (req, res) => {
  try {
    const out = await calendarSync.exportFeed.serve(req.params.secret, { userAgent: req.get("user-agent"), ifNoneMatch: req.get("if-none-match") });
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.set("Referrer-Policy", "no-referrer");
    if (out.status === 404) return res.status(404).type("text/plain").send("Not found");
    // Revalidate on every use (the default no-store would defeat the ETag).
    res.set("Cache-Control", "private, no-cache, max-age=0");
    res.removeHeader("Pragma");
    res.removeHeader("Expires");
    res.removeHeader("Surrogate-Control");
    res.set("ETag", out.etag);
    if (out.status === 304) return res.status(304).end();
    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Content-Disposition", 'inline; filename="majestic-escape.ics"');
    return res.status(200).send(out.body);
  } catch (err) {
    console.error("[syncguard] feed failed:", err && (err.code || err.name));
    return res.status(500).type("text/plain").send("Server error");
  }
};

// --- host API ----------------------------------------------------------------------
exports.listConnections = async (req, res) => {
  try {
    const listing = await propertyFor(req, res);
    if (!listing) return;
    const data = await connections.list({ listing, req });
    return res.json({ success: true, data });
  } catch (err) {
    return handle(res, err, "list connections");
  }
};

exports.createConnection = async (req, res) => {
  try {
    const listing = await propertyFor(req, res);
    if (!listing) return;
    const actor = await authz.resolveActor(req);
    const { channel, name, url } = req.body || {};
    const r = await connections.connect({ listing, actorId: actor && actor.id, channel, name, url });
    const data = await connections.list({ listing, req });
    return res.status(r.reconnected ? 200 : 201).json({ success: true, id: String(r.id), test: r.test, syncState: r.syncState, reconnected: !!r.reconnected, data });
  } catch (err) {
    return handle(res, err, "connect");
  }
};

exports.explain = async (req, res) => {
  try {
    const listing = await propertyFor(req, res);
    if (!listing) return;
    return res.json({ success: true, data: await connections.explain({ listing, date: req.query.date }) });
  } catch (err) {
    return handle(res, err, "explain");
  }
};

exports.revokeLegacyFeed = async (req, res) => {
  try {
    const listing = await propertyFor(req, res);
    if (!listing) return;
    const actor = await authz.resolveActor(req);
    return res.json({ success: true, ...(await connections.revokeLegacy({ listing, actorId: actor && actor.id })) });
  } catch (err) {
    return handle(res, err, "revoke legacy feed");
  }
};

async function respondWithList(req, res, extra) {
  const data = await connections.list({ listing: req.syncListing, req });
  return res.json({ success: true, ...extra, data });
}

exports.updateConnection = [
  loadOwnedConnection,
  async (req, res) => {
    try {
      if (req.syncConn.status === "disconnected") return fail(res, 404, "NOT_FOUND", "Connection not found");
      const { name, channel, url } = req.body || {};
      const r = await connections.update({ conn: req.syncConn, listing: req.syncListing, actorId: req.syncActorId, name, channel, url });
      return respondWithList(req, res, { test: r.test });
    } catch (err) {
      return handle(res, err, "update connection");
    }
  },
];

exports.syncNow = [
  loadOwnedConnection,
  async (req, res) => {
    try {
      if (req.syncConn.status === "disconnected") return fail(res, 404, "NOT_FOUND", "Connection not found");
      const r = await connections.syncNow({ conn: req.syncConn });
      return respondWithList(req, res, { syncState: r.state, result: r.result ? { ok: !!r.result.ok, code: r.result.code || null } : null });
    } catch (err) {
      return handle(res, err, "sync now");
    }
  },
];

exports.rotateExport = [
  loadOwnedConnection,
  async (req, res) => {
    try {
      if (req.syncConn.status === "disconnected") return fail(res, 404, "NOT_FOUND", "Connection not found");
      await connections.rotate({ conn: req.syncConn, listing: req.syncListing, actorId: req.syncActorId });
      return respondWithList(req, res, {});
    } catch (err) {
      return handle(res, err, "rotate export");
    }
  },
];

// Stops the Majestic link of a disconnected import (POST /connections/:id/stop-export).
exports.stopExport = [
  loadOwnedConnection,
  async (req, res) => {
    try {
      if (req.syncConn.status !== "disconnected" || req.syncConn.kind !== "import") return fail(res, 409, "STILL_CONNECTED", "Disconnect the calendar first, or replace the link instead.");
      await connections.stopExport({ conn: req.syncConn, listing: req.syncListing, actorId: req.syncActorId });
      return respondWithList(req, res, {});
    } catch (err) {
      return handle(res, err, "stop export");
    }
  },
];

exports.confirmExport = [
  loadOwnedConnection,
  async (req, res) => {
    try {
      await connections.confirmExport({ conn: req.syncConn });
      return respondWithList(req, res, {});
    } catch (err) {
      return handle(res, err, "confirm export");
    }
  },
];

exports.disconnect = [
  loadOwnedConnection,
  async (req, res) => {
    try {
      if (req.syncConn.status === "disconnected") return fail(res, 404, "NOT_FOUND", "Connection not found");
      const { acknowledge, releaseBlocks } = req.body || {};
      const r = await connections.disconnect({ conn: req.syncConn, listing: req.syncListing, actorId: req.syncActorId, acknowledge, releaseBlocks });
      return respondWithList(req, res, { result: r });
    } catch (err) {
      return handle(res, err, "disconnect");
    }
  },
];

exports.releaseBlocks = [
  loadOwnedConnection,
  async (req, res) => {
    try {
      const r = await connections.releaseBlocks({ conn: req.syncConn, listing: req.syncListing, actorId: req.syncActorId, acknowledge: (req.body || {}).acknowledge });
      return respondWithList(req, res, { result: r });
    } catch (err) {
      return handle(res, err, "release blocks");
    }
  },
];

// --- operations -------------------------------------------------------------------
// GET /calendarSync/cron/sweep[?mode=full] — Vercel cron (daily, full) and
// any external clock (scoped secret). Idempotent; overlapping calls are safe.
exports.cronSweep = async (req, res) => {
  try {
    const full = req.query.mode === "full";
    const source = req.get("x-vercel-cron-schedule") ? "vercel_cron" : String(req.query.source || "external_clock").replace(/[^a-z0-9_-]/gi, "").slice(0, 30);
    if (full) await calendarSync.alertIfClockStale().catch((err) => console.error("[syncguard] clock alert failed", err.message));
    const summary = await calendarSync.runDue({ budgetMs: full ? 240_000 : 50_000, full, reason: full ? "daily_full" : "clock", source });
    return res.json({ success: true, summary });
  } catch (err) {
    return handle(res, err, "sweep");
  }
};

exports.adminOverview = async (req, res) => {
  try {
    return res.json({ success: true, data: await calendarSync.adminOverview() });
  } catch (err) {
    return handle(res, err, "admin overview");
  }
};
