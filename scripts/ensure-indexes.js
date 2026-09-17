#!/usr/bin/env node
// Creates the Batch A2 indexes (create-only — never syncIndexes(), which
// drops what the schema does not declare) and proves they are used.
//
//   node scripts/ensure-indexes.js            create + list
//   node scripts/ensure-indexes.js --explain  also explain() the admin KYC
//                                             document query and fail unless
//                                             the winning plan is an IXSCAN
//                                             on the {userId,type,createdAt}
//                                             index
//   node scripts/ensure-indexes.js --dry-run  list only, create nothing
//
// Uses DB_URI (or --uri=...). Read-only apart from index creation. Runs in
// seconds on the small kyclogs / adminauditlogs collections (M0 included).
require("dotenv").config();
const mongoose = require("mongoose");
const KycLogs = require("../models/KycLogs");
const AdminAuditLog = require("../models/AdminAuditLog");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
};
const KYC_INDEX = "userId_1_type_1_createdAt_-1";

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
    report.createMs = Date.now() - started;
    log(`[indexes] createIndexes() done in ${report.createMs} ms`);
  }
  for (const Model of [KycLogs, AdminAuditLog]) {
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

module.exports = { ensureIndexes, KYC_INDEX };

if (require.main === module) {
  main()
    .catch((err) => {
      console.error("[indexes] failed:", err.message);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}
