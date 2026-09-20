// One list-query contract for the admin dashboard tables.
//
//   ?page=1&limit=10          page-based (limit alias: pageSize; legacy ?skip= is
//                             honoured when ?page= is absent)
//   ?sort=field:desc          one allow-listed key, "field:asc" | "field:desc",
//                             "-field" or "field" (asc); anything else → default
//
// Every paginated response adds { page, limit, total, totalPages, hasMore, sort }
// next to the endpoint's existing fields, so older clients keep working.
//
// An endpoint that used to return everything passes `defaultLimit: 0`: without
// ?page= / ?limit= it still returns everything (limit 0 = unbounded) and only a
// caller that asks for a page gets one.

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {object} query           req.query
 * @param {object} options
 * @param {Record<string,string>} options.sortable  key → Mongo path (allow-list)
 * @param {string} options.defaultSort               e.g. "-updatedAt" or "checkIn:asc"
 * @param {number} [options.maxLimit=100]
 * @param {number} [options.defaultLimit=10]         0 = unbounded unless the caller asks
 * @param {string} [options.tiebreak="_id"]          appended so paging is stable
 */
function parseListQuery(query, { sortable, defaultSort, maxLimit = 100, defaultLimit = 10, tiebreak = "_id" }) {
  const q = query || {};
  const explicitLimit = q.limit !== undefined && q.limit !== "" ? q.limit : q.pageSize;
  const askedForPage = q.page !== undefined && q.page !== "";
  let limit;
  if (explicitLimit !== undefined && explicitLimit !== "") limit = toInt(explicitLimit, defaultLimit);
  else if (askedForPage && defaultLimit === 0) limit = 10;
  else limit = defaultLimit;
  if (limit < 0) limit = defaultLimit;
  if (limit > maxLimit) limit = maxLimit;

  let page = Math.max(toInt(q.page, 1), 1);
  let skip;
  if (!askedForPage && q.skip !== undefined && q.skip !== "") {
    skip = Math.max(toInt(q.skip, 0), 0);
    page = limit > 0 ? Math.floor(skip / limit) + 1 : 1;
  } else {
    skip = limit > 0 ? (page - 1) * limit : 0;
  }

  const parsed = parseSort(q.sort, sortable) || parseSort(defaultSort, sortable) || { key: tiebreak, dir: -1, path: tiebreak };
  const sort = { [parsed.path]: parsed.dir };
  if (parsed.path !== tiebreak) sort[tiebreak] = -1;
  return { page, limit, skip, sort, sortKey: `${parsed.key}:${parsed.dir === 1 ? "asc" : "desc"}` };
}

function parseSort(raw, sortable) {
  if (!raw || typeof raw !== "string") return null;
  let key = raw.trim();
  let dir = 1;
  if (key.startsWith("-")) {
    dir = -1;
    key = key.slice(1);
  }
  const m = key.match(/^([A-Za-z0-9_.]+)(?::(asc|desc))?$/i);
  if (!m) return null;
  key = m[1];
  if (m[2]) dir = m[2].toLowerCase() === "desc" ? -1 : 1;
  const path = sortable && Object.prototype.hasOwnProperty.call(sortable, key) ? sortable[key] : null;
  if (!path) return null;
  return { key, dir, path };
}

/** The response block every paginated admin list carries. */
function listMeta({ page, limit, total, sortKey }) {
  const totalPages = limit > 0 ? Math.max(Math.ceil(total / limit), 1) : 1;
  return {
    page: limit > 0 ? page : 1,
    limit,
    total,
    totalPages,
    hasMore: limit > 0 ? page < totalPages : false,
    sort: sortKey,
  };
}

/** $skip/$limit stages for a facet; an unbounded list gets no $limit. */
function pageStages({ skip, limit }) {
  const stages = [];
  if (skip > 0) stages.push({ $skip: skip });
  if (limit > 0) stages.push({ $limit: limit });
  return stages;
}

/** Case-insensitive regex from user input, bounded so it cannot become a ReDoS vector. */
function searchRegex(term) {
  const s = String(term || "").trim().slice(0, 100);
  if (!s) return null;
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

module.exports = { parseListQuery, parseSort, listMeta, pageStages, searchRegex };
