#!/usr/bin/env node
// Contact lock-down — legacy content shadow scan (release gate).
//
// Read-only by default: runs the contact detector over every piece of public
// text already stored (host about / languages / first names, listing title /
// description / rules / safety notes incl. the listing's own exact address,
// review text) and, with --chat-uri, over the chat database (participant last
// names, message text — per sender and conversation, in sequence, so split
// identifiers are counted too). Prints counts per detector kind and redacted
// samples ("98765•••••") — never a full identifier, never an email address.
//
// Everything found here is already unexposed at read time (utils/
// sanitizeResponse.js masks public text; the chat server masks legacy
// history), so the gate is informational. --apply (owner-run, after reading a
// dry run) rewrites the masked text into the profile / listing / review
// documents and unsets participants.lastName in the chat database; chat
// messages are never rewritten.
//
//   node scripts/pii-shadow-scan.js --uri="<DB_URI>" [--chat-uri="<CHAT_URI>"] [--apply] [--sample=5]
require("dotenv").config();
const mongoose = require("mongoose");
const { detectContact, detectContactInParts, maskContactInfoParts, maskContactInfo, buildAddressTokens, isAcceptableName } = require("../utils/contactModeration");

const args = process.argv.slice(2);
const opt = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
};
const APPLY = args.includes("--apply");
const SAMPLE = Number(opt("sample") || 5);

function redact(text, hits) {
  // keep the first 3 characters of each hit, mask the rest; clip the sample
  let out = "";
  let p = 0;
  for (const h of [...hits].sort((a, b) => a.start - b.start)) {
    if (h.start < p) continue;
    out += text.slice(p, h.start) + text.slice(h.start, h.start + 3) + "•".repeat(Math.max(1, Math.min(h.end - h.start - 3, 12)));
    p = h.end;
  }
  out += text.slice(p);
  return out.length > 140 ? out.slice(0, 140) + "…" : out;
}

class Tally {
  constructor() {
    this.kinds = {};
    this.docs = 0;
    this.hitDocs = 0;
    this.samples = [];
  }
  add(id, texts, res) {
    this.docs += 1;
    if (res.status !== "blocked") return;
    this.hitDocs += 1;
    for (const k of res.kinds) this.kinds[k] = (this.kinds[k] || 0) + 1;
    if (this.samples.length < SAMPLE) {
      const first = res.hits[0];
      const text = texts[first.part !== undefined ? first.part : 0];
      this.samples.push({ id: String(id), kinds: res.kinds, sample: redact(text, res.hits.filter((h) => (h.part || 0) === (first.part || 0))) });
    }
  }
  report(label) {
    console.log(`\n[${label}] documents ${this.docs}, with contact/address content ${this.hitDocs}`);
    for (const [k, n] of Object.entries(this.kinds).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${n}`);
    for (const s of this.samples) console.log(`  · ${s.id} [${s.kinds.join(",")}] ${JSON.stringify(s.sample)}`);
  }
}

async function scanUsers(apply) {
  const User = require("../models/User");
  const ListingProperty = require("../models/ListingProperty");
  const tally = new Tally();
  let badNames = 0;
  let rewritten = 0;
  const cursor = User.find({}).select("firstName lastName about languages role").lean().cursor();
  for await (const u of cursor) {
    if (u.firstName && !isAcceptableName(u.firstName)) badNames += 1;
    const listings = await ListingProperty.find({ host: u._id }).select("address line1 line2").lean();
    const address = listings.map((l) => buildAddressTokens({ street: l.address?.street, line1: l.line1, line2: l.line2, city: l.address?.city, district: l.address?.district, state: l.address?.state }));
    const parts = [u.about || "", ...(u.languages || []).map(String)];
    const res = detectContactInParts(parts, { address });
    tally.add(u._id, parts, res);
    if (apply && res.status === "blocked") {
      const masked = maskContactInfoParts(parts, { address });
      await User.updateOne({ _id: u._id }, { $set: { about: masked[0], languages: masked.slice(1) } });
      rewritten += 1;
    }
  }
  tally.report("users: about + languages (+ own listing addresses)");
  console.log(`  first names failing the name policy: ${badNames} (masked on read; rename via the admin Users page)`);
  if (apply) console.log(`  rewritten: ${rewritten}`);
}

async function scanListings(apply) {
  const ListingProperty = require("../models/ListingProperty");
  const tally = new Tally();
  let rewritten = 0;
  const cursor = ListingProperty.find({}).select("title description customRules safetyFeatures address line1 line2 status").lean().cursor();
  for await (const l of cursor) {
    const address = buildAddressTokens({ street: l.address?.street, line1: l.line1, line2: l.line2, city: l.address?.city, district: l.address?.district, state: l.address?.state });
    const keys = [];
    const parts = [];
    if (typeof l.title === "string") (keys.push(["title"]), parts.push(l.title));
    if (typeof l.description === "string") (keys.push(["description"]), parts.push(l.description));
    (l.customRules || []).forEach((r, i) => typeof r === "string" && (keys.push(["customRules", i]), parts.push(r)));
    for (const [name, f] of Object.entries(l.safetyFeatures || {})) if (f && typeof f.description === "string") (keys.push(["safetyFeatures", name]), parts.push(f.description));
    if (!parts.length) continue;
    const res = detectContactInParts(parts, { address });
    tally.add(`${l._id} (${l.status})`, parts, res);
    if (apply && res.status === "blocked") {
      const masked = maskContactInfoParts(parts, { address });
      const set = {};
      keys.forEach((k, i) => {
        if (masked[i] === parts[i]) return;
        if (k[0] === "title" || k[0] === "description") set[k[0]] = masked[i];
        else if (k[0] === "customRules") set[`customRules.${k[1]}`] = masked[i];
        else set[`safetyFeatures.${k[1]}.description`] = masked[i];
      });
      if (Object.keys(set).length) {
        await ListingProperty.updateOne({ _id: l._id }, { $set: set });
        rewritten += 1;
      }
    }
  }
  tally.report("listings: title + description + rules + safety notes (+ own address)");
  if (apply) console.log(`  rewritten: ${rewritten}`);
}

async function scanReviews(apply) {
  const ListingProperty = require("../models/ListingProperty");
  for (const [label, Model] of [
    ["property reviews", require("../models/Review")],
    ["host reviews", require("../models/HostReview")],
  ]) {
    const tally = new Tally();
    let rewritten = 0;
    const cursor = Model.find({}).select("content property").lean().cursor();
    for await (const r of cursor) {
      if (typeof r.content !== "string" || !r.content) continue;
      const listing = r.property ? await ListingProperty.findById(r.property).select("address line1 line2").lean() : null;
      const address = listing ? buildAddressTokens({ street: listing.address?.street, line1: listing.line1, line2: listing.line2, city: listing.address?.city, district: listing.address?.district, state: listing.address?.state }) : undefined;
      const res = detectContact(r.content, address ? { address } : {});
      tally.add(r._id, [r.content], res);
      if (apply && res.status === "blocked") {
        await Model.updateOne({ _id: r._id }, { $set: { content: maskContactInfo(r.content, address ? { address } : {}) } });
        rewritten += 1;
      }
    }
    tally.report(label);
    if (apply) console.log(`  rewritten: ${rewritten}`);
  }
}

async function scanChat(chatUri, apply) {
  const conn = await mongoose.createConnection(chatUri).asPromise();
  const conversations = conn.collection("conversations");
  const messages = conn.collection("messages");
  const withLastName = await conversations.countDocuments({ "participants.lastName": { $exists: true, $ne: null } });
  console.log(`\n[chat] conversations with participants.lastName stored: ${withLastName} (never returned; ${apply ? "unsetting" : "use --apply to unset"})`);
  if (apply && withLastName) {
    const r = await conversations.updateMany({ "participants.lastName": { $exists: true } }, { $unset: { "participants.$[].lastName": "" } });
    console.log(`  unset on ${r.modifiedCount} conversations`);
  }
  const tally = new Tally();
  let legacyRows = 0;
  let total = 0;
  const convIds = await messages.distinct("conversationId");
  for (const conversationId of convIds) {
    const rows = await messages.find({ conversationId }).project({ senderId: 1, "content.text": 1, "moderation.version": 1, createdAt: 1 }).sort({ createdAt: 1, _id: 1 }).toArray();
    total += rows.length;
    legacyRows += rows.filter((r) => !r.moderation || !r.moderation.version).length;
    const bySender = new Map();
    for (const r of rows) (bySender.get(r.senderId) || bySender.set(r.senderId, []).get(r.senderId)).push(r);
    for (const [senderId, list] of bySender) {
      const texts = list.map((r) => (r.content && r.content.text) || "");
      const res = detectContactInParts(texts);
      tally.add(`${conversationId}/${senderId}`, texts, res);
    }
  }
  console.log(`[chat] messages ${total}, legacy (no moderation.version) ${legacyRows} — legacy rows are masked history-aware on every read; messages are never rewritten`);
  tally.report("chat: per sender+conversation sequences");
  await conn.close();
}

async function main() {
  const uri = opt("uri") || process.env.DB_URI;
  if (!uri) throw new Error("--uri or DB_URI required");
  if (APPLY) console.log("[apply] rewriting masked profile / listing / review text and unsetting chat last names");
  else console.log("[dry run] nothing is written");
  await mongoose.connect(uri);
  await scanUsers(APPLY);
  await scanListings(APPLY);
  await scanReviews(APPLY);
  const chatUri = opt("chat-uri");
  if (chatUri) await scanChat(chatUri, APPLY);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
