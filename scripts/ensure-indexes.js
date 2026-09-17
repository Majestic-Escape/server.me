#!/usr/bin/env node
// Creates the Batch A2 + Batch P indexes (create-only — never syncIndexes(),
// which drops what the schema does not declare) and proves they are used:
// kyclogs {userId,type,createdAt}, adminauditlogs {targetId,createdAt},
// listingproperties {status,createdAt} / {host} / {hostEmail}.
//
//   node scripts/ensure-indexes.js            create + list
//   node scripts/ensure-indexes.js --explain  also explain() the admin KYC
//                                             document query and the home
//                                             catalogue query; fail unless
//                                             both winning plans use their
//                                             index without a blocking sort
//   node scripts/ensure-indexes.js --dry-run  list only, create nothing
//
// Uses DB_URI (or --uri=...). Read-only apart from index creation. Runs in
// seconds on the small kyclogs / adminauditlogs collections (M0 included).
require("dotenv").config();
const mongoose = require("mongoose");
const KycLogs = require("../models/KycLogs");
const AdminAuditLog = require("../models/AdminAuditLog");
const ListingProperty = require("../models/ListingProperty");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
};
const KYC_INDEX = "userId_1_type_1_createdAt_-1";
// Batch P: the public catalogue lists ({status} sorted by createdAt desc).
const CATALOGUE_INDEX = "status_1_createdAt_-1__id_-1";

function winningStages(plan, out = []) {
  if (!plan) return out;
  out.push(plan.stage + (plan.indexName ? `(${plan.indexName})` : ""));
  if (plan.inputStage) winningStages(plan.inputStage, out);
  if (Array.isArray(plan.inputStages)) plan.inputStages.forEach((s) => winningStages(s, out));
  return out;
}

// Runs against the current mongoose connection.
async function ensureIndexes({ dryRun = false, explain = false, log = console.log } = {}) {
  const report = { created: !dryRun, indexes: {}, explain: null };
  if (!dryRun) {
    const started = Date.now();
    await KycLogs.createIndexes();
    await AdminAuditLog.createIndexes();
    await ListingProperty.createIndexes(); // Batch P: {status,createdAt}, {host}, {hostEmail}
    report.createMs = Date.now() - started;
    log(`[indexes] createIndexes() done in ${report.createMs} ms`);
  }
  for (const Model of [KycLogs, AdminAuditLog, ListingProperty]) {
    const names = (await Model.collection.indexes()).map((i) => `${i.name} ${JSON.stringify(i.key)}`);
    report.indexes[Model.collection.collectionName] = names;
    log(`[indexes] ${Model.collection.collectionName}: ${names.join(" | ")}`);
  }
  if (explain) {
    const sample = await KycLogs.findOne({ type: "OCR" }).select("userId").lean();
    const userId = sample ? sample.userId : new mongoose.Types.ObjectId();
    const explain = await KycLogs.collection
      .find({ userId, type: "OCR" }, { projection: { createdAt: 1 } })
      .sort({ createdAt: -1 })
      .limit(21)
      .explain("executionStats");
    const plan = explain.queryPlanner.winningPlan;
    const stages = winningStages(plan.queryPlan || plan);
    const stats = explain.executionStats || {};
    report.explain = { stages, docsExamined: stats.totalDocsExamined, keysExamined: stats.totalKeysExamined, returned: stats.nReturned, ms: stats.executionTimeMillis };
    log(`[indexes] explain kyclogs {userId,type:"OCR"} sort createdAt desc: ${stages.join(" ← ")}  docsExamined=${stats.totalDocsExamined} keysExamined=${stats.totalKeysExamined} returned=${stats.nReturned} ms=${stats.executionTimeMillis}`);
    const usesIndex = stages.some((s) => s.startsWith("IXSCAN") && s.includes(KYC_INDEX));
    const noBlockingSort = !stages.some((s) => s.startsWith("SORT"));
    if (!usesIndex || !noBlockingSort) {
      throw new Error(`winning plan does not use ${KYC_INDEX} without an in-memory sort: ${stages.join(" ← ")}`);
    }
    log(`[indexes] OK — IXSCAN on ${KYC_INDEX}, no blocking sort`);

    // Batch P: the home-page list. {status:{$in}} + createdAt desc is served
    // by one IXSCAN per status value merged in order (SORT_MERGE) — only a
    // blocking in-memory SORT stage is a failure.
    const cat = await ListingProperty.collection
      .find({ status: { $in: ["active", "completed"] } }, { projection: { _id: 1 } })
      .sort({ createdAt: -1, _id: -1 })
      .limit(16)
      .explain("executionStats");
    const catPlan = cat.queryPlanner.winningPlan;
    const catStages = winningStages(catPlan.queryPlan || catPlan);
    const catStats = cat.executionStats || {};
    report.catalogueExplain = { stages: catStages, docsExamined: catStats.totalDocsExamined, keysExamined: catStats.totalKeysExamined, returned: catStats.nReturned, ms: catStats.executionTimeMillis };
    log(`[indexes] explain listingproperties {status $in} sort createdAt desc: ${catStages.join(" ← ")}  docsExamined=${catStats.totalDocsExamined} keysExamined=${catStats.totalKeysExamined} returned=${catStats.nReturned} ms=${catStats.executionTimeMillis}`);
    const catUsesIndex = catStages.some((s) => s.startsWith("IXSCAN") && s.includes(CATALOGUE_INDEX));
    const catBlockingSort = catStages.some((s) => s === "SORT" || s.startsWith("SORT("));
    if (!catUsesIndex || catBlockingSort) {
      throw new Error(`catalogue plan does not use ${CATALOGUE_INDEX} without a blocking sort: ${catStages.join(" ← ")}`);
    }
    log(`[indexes] OK — IXSCAN on ${CATALOGUE_INDEX}, no blocking sort`);
  }
  return report;
}

async function main() {
  const uri = opt("uri") || process.env.DB_URI;
  if (!uri) throw new Error("DB_URI (or --uri) is required");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  console.log(`[indexes] database: ${mongoose.connection.db.databaseName}`);
  await ensureIndexes({ dryRun: has("--dry-run"), explain: has("--explain") });
}

module.exports = { ensureIndexes, KYC_INDEX, CATALOGUE_INDEX };

if (require.main === module) {
  main()
    .catch((err) => {
      console.error("[indexes] failed:", err.message);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}
