// Decision table: provider Status payload → verdict for the host's identity
// document. Built from the response shapes recorded in KycLogs (PAN status:
// `{ http_response_code, result: { pan, name, status, name_match,
// name_match_score, … } }`; "not found": `{ http_response_code: 200,
// message: "No Records Found …" }` with no `result`).
//
//   verified      provider answered 200, the document is active/valid AND the
//                 holder's name matches the account holder (PAN: the
//                 provider's own fuzzy name_match; voter/passport: a local
//                 token match against the OCR/status name — those APIs do no
//                 name matching)
//   needs_review  document active but the name does not match, or a 200
//                 whose validity fields are missing/unknown — never verified
//                 automatically; an admin reviews the upload and may mark it
//   failed        provider error, no record, inactive/invalid document
//
// Only `verified` sets documentInfo.isVerified = true.
const ACTIVE = new Set(["active", "valid", "verified", "success", "y", "yes", "true"]);
const INACTIVE = new Set(["inactive", "invalid", "deleted", "cancelled", "canceled", "deactivated", "fake", "n", "no", "false", "not found", "notfound"]);

function norm(v) {
  if (v === undefined || v === null) return undefined;
  return String(v).trim().toLowerCase();
}

function nameTokens(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[^\p{L}\s]/gu, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

// Every token of the shorter name must appear in the longer one (an initial
// matches a token starting with it). A single-token name against a
// multi-token one is not enough evidence.
function namesMatch(a, b) {
  const A = nameTokens(a);
  const B = nameTokens(b);
  if (!A.length || !B.length) return false;
  const [short, long] = A.length <= B.length ? [A, B] : [B, A];
  if (short.length === 1 && long.length > 1) return false;
  return short.every((t) => long.some((u) => u === t || (t.length === 1 && u.startsWith(t)) || (u.length === 1 && t.startsWith(u))));
}

function documentVerdict(statusResult, { doc, accountName, ocrName } = {}) {
  if (!statusResult || typeof statusResult !== "object") return { verdict: "failed", reason: "PROVIDER_NO_RESPONSE", message: "The verification service did not answer" };
  if (Number(statusResult.http_response_code) !== 200) {
    return { verdict: "failed", reason: "PROVIDER_ERROR", message: statusResult.message || statusResult.error || "The verification service rejected the request" };
  }
  const result = statusResult.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { verdict: "failed", reason: "NOT_FOUND", message: statusResult.message || "No record was found for this document" };
  }
  const status = norm(result.status ?? result.pan_status ?? result.epic_status ?? result.passport_status ?? result.document_status);
  if (status === undefined || status === "") return { verdict: "needs_review", reason: "STATUS_UNKNOWN", message: "The verification service did not report the document status" };
  if (INACTIVE.has(status)) return { verdict: "failed", reason: "DOCUMENT_INACTIVE", message: `The document is reported as ${result.status ?? status}` };
  if (!ACTIVE.has(status)) return { verdict: "needs_review", reason: "STATUS_UNRECOGNISED", message: `Unrecognised document status "${result.status ?? status}"` };

  // Name evidence
  if (typeof result.name_match === "boolean") {
    if (result.name_match) return { verdict: "verified", reason: "OK", nameMatch: true, nameMatchScore: result.name_match_score };
    return { verdict: "needs_review", reason: "NAME_MISMATCH", nameMatch: false, nameMatchScore: result.name_match_score, message: "The name on the document does not match the account name" };
  }
  if (doc && doc !== "pan") {
    const docName = result.name ?? ocrName;
    if (docName && accountName && namesMatch(accountName, docName)) return { verdict: "verified", reason: "OK", nameMatch: true };
    if (docName && accountName) return { verdict: "needs_review", reason: "NAME_MISMATCH", nameMatch: false, message: "The name on the document does not match the account name" };
  }
  return { verdict: "needs_review", reason: "NAME_MATCH_UNKNOWN", message: "The holder's name could not be matched automatically" };
}

module.exports = { documentVerdict, namesMatch, nameTokens };
