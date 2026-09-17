// Single seam for every call to the KYC provider (Digitap). Real mode
// delegates to the existing axios clients; KYC_PROVIDER_MOCK=1 (tests only —
// never set in any deployment) answers with canned payloads whose shape is
// the one recorded in KycLogs.responseData, selected per test through
// KYC_PROVIDER_MOCK_MODE:
//   success   provider verified the document / GST
//   mismatch  document active, name does not match (PAN name_match=false)
//   negative  provider says not found / inactive
//   ambiguous 200 without any validity field
//   failure   provider error (throws)
//   timeout   provider timeout (throws after a short delay)
// The mock also counts calls so tests can prove the abuse guard lets exactly
// one request through.
const axios = require("axios");

const calls = { ocr: 0, status: 0, gstPan: 0, gst: 0 };
function resetCalls() {
  for (const k of Object.keys(calls)) calls[k] = 0;
}
function isMock() {
  return process.env.KYC_PROVIDER_MOCK === "1";
}
function mode() {
  return process.env.KYC_PROVIDER_MOCK_MODE || "success";
}
const MOCK_GSTIN = "27ABCDE1234F1Z5";
const MOCK_PAN = "ABCDE1234F";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function mockGate() {
  const m = mode();
  if (m === "timeout") {
    await sleep(Number(process.env.KYC_PROVIDER_MOCK_TIMEOUT_MS || 30));
    const err = new Error("timeout of 30ms exceeded");
    err.code = "ECONNABORTED";
    throw err;
  }
  if (m === "failure") {
    const err = new Error("Request failed with status code 502");
    err.response = { status: 502, data: { error: "provider unavailable" } };
    throw err;
  }
}

function getAuthHeader() {
  const credentials = `${process.env.DIGITAP_CLIENT_ID}:${process.env.DIGITAP_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

// --- OCR + status (PAN / voter / passport) ---------------------------------
async function ocr(imageBase64, clientRefId, doc) {
  calls.ocr += 1;
  if (isMock()) {
    await mockGate();
    const name = process.env.KYC_PROVIDER_MOCK_NAME || "TEST USER";
    const details =
      doc === "pan"
        ? { name: { value: name }, father: { value: "TEST FATHER" }, date: { value: "01/01/1990" }, pan_no: { value: MOCK_PAN } }
        : doc === "voterId"
          ? { name: { value: name }, voterid: { value: "ABC1234567" } }
          : { name: { value: name }, passport_num: { value: "N1234567" }, dob: { value: "01/01/1990" } };
    return { status: "success", statusCode: "200", result: [{ type: doc, details }], ocrReqId: "mock-ocr", clientRefId };
  }
  const { performOCR } = require("./panKycService");
  return performOCR(imageBase64, clientRefId, doc);
}

async function statusCheck(requestData, doc) {
  calls.status += 1;
  if (isMock()) {
    await mockGate();
    const m = mode();
    if (m === "negative") return { http_response_code: 200, client_ref_num: requestData.client_ref_num, message: "No Records Found for the Given ID or Combination of Inputs" };
    if (m === "ambiguous") return { http_response_code: 200, client_ref_num: requestData.client_ref_num, result: { name: "TEST USER" } };
    const name = process.env.KYC_PROVIDER_MOCK_NAME || "TEST USER";
    if (doc === "pan") {
      return {
        http_response_code: 200,
        client_ref_num: requestData.client_ref_num,
        request_id: "mock-status",
        result_code: 101,
        result: { pan: MOCK_PAN, name, pan_display_name: name, status: "Active", seeding_status: "Y", name_validated: name, name_match: m !== "mismatch", name_match_score: m === "mismatch" ? 20 : 100 },
      };
    }
    // Voter / passport status APIs answer with the document status and the
    // holder's name; there is no provider-side name match for them.
    return { http_response_code: 200, client_ref_num: requestData.client_ref_num, request_id: "mock-status", result_code: 101, result: { status: "Active", name: m === "mismatch" ? "SOMEBODY ELSE" : name } };
  }
  const { performStatusCheck } = require("./panKycService");
  return performStatusCheck(requestData, doc);
}

// --- GST -------------------------------------------------------------------
async function gstPanSearch(requestData) {
  calls.gstPan += 1;
  if (isMock()) {
    await mockGate();
    if (mode() === "negative") return { http_response_code: 200, result_code: 102, result: { count: 0, gstinResList: [] } };
    return { http_response_code: 200, result_code: 101, result: { count: 1, gstinResList: [{ gstin: MOCK_GSTIN, authStatus: mode() === "mismatch" ? "Cancelled" : "Active", stateCd: "27", state: "Maharashtra" }] } };
  }
  const response = await axios.post(`${process.env.STATUS_GST}/gstpansearch`, requestData, {
    headers: { "Content-Type": "application/json", Authorization: getAuthHeader() },
  });
  return response.data;
}

async function gstCheck(requestData) {
  calls.gst += 1;
  if (isMock()) {
    await mockGate();
    if (mode() === "ambiguous") return { http_response_code: 200, result: {} };
    return { http_response_code: 200, result_code: 101, result: { taxpayerDetails: { gstin: requestData.gstin, sts: "Active", lgnm: "Test Private Limited", tradeNam: "Test" } } };
  }
  const response = await axios.post(`${process.env.STATUS_GST}/gst`, requestData, {
    headers: { "Content-Type": "application/json", Authorization: getAuthHeader() },
  });
  return response.data;
}

module.exports = { ocr, statusCheck, gstPanSearch, gstCheck, calls, resetCalls, MOCK_GSTIN, MOCK_PAN };
