// SyncGuard runtime switches (docs/syncguard.md §5), stored in the existing
// `opsflags` collection so they flip without a redeploy
// (scripts/syncguard-flags.js). Cached per instance for OPS_FLAG_CACHE_MS.
//
// Unlike the booking-write gate these fail OPEN: a database blip must not
// stop calendar protection — the switches only ever *reduce* activity.
//   calendar_sync_paused      → no fetches; imported blocks stay as they are;
//                               feeds keep serving the last known state.
//   calendar_propagation_off  → destination feeds carry Majestic-native
//                               events only (no OTA → OTA propagation).
const OpsFlag = require("../../models/OpsFlag");

const SYNC_PAUSED = "calendar_sync_paused";
const PROPAGATION_OFF = "calendar_propagation_off";
const cacheMs = () => (process.env.OPS_FLAG_CACHE_MS !== undefined && Number.isFinite(Number(process.env.OPS_FLAG_CACHE_MS)) ? Number(process.env.OPS_FLAG_CACHE_MS) : 10_000);

const cache = new Map(); // id → { value, at }

async function read(id, now = Date.now()) {
  const hit = cache.get(id);
  if (hit && now - hit.at < cacheMs()) return hit.value;
  try {
    const flag = await OpsFlag.findById(id).maxTimeMS(2_000).lean();
    const value = !!(flag && flag.enabled);
    cache.set(id, { value, at: now });
    return value;
  } catch (err) {
    console.error(`[syncguard] flag ${id} read failed; assuming off`, err.message);
    cache.set(id, { value: hit ? hit.value : false, at: now });
    return hit ? hit.value : false;
  }
}

const syncPaused = () => read(SYNC_PAUSED);
const propagationOff = () => read(PROPAGATION_OFF);
function resetCache() {
  cache.clear();
}

module.exports = { SYNC_PAUSED, PROPAGATION_OFF, syncPaused, propagationOff, resetCache };
