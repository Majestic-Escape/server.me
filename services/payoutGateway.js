// RazorpayX payout calls used by services/payouts.js. Real HTTP when
// deployed; an in-memory fake with the same surface when RAZORPAY_MOCK=1
// (tests only — never set in any deployment) so duplicate-payout defences can
// be exercised against injected timeouts, 5xx and rejections.
const axios = require("axios");
const { getRazorpay } = require("./razorpayClient");

const BASE = "https://api.razorpay.com/v1";

function authHeader() {
  const rp = getRazorpay();
  return `Basic ${Buffer.from(`${rp.key_id.trim()}:${rp.key_secret.trim()}`).toString("base64")}`;
}

// Error classification the service relies on:
//   { kind: "rejected", message }  the gateway answered with a 4xx — the
//                                  payout was not created;
//   { kind: "ambiguous", message } no answer / 5xx — the payout may exist.
function classify(error) {
  if (error.response) {
    const status = error.response.status;
    const desc = error.response.data?.error?.description || error.response.data?.error?.code || `HTTP ${status}`;
    return { kind: status >= 500 ? "ambiguous" : "rejected", message: desc, status };
  }
  return { kind: "ambiguous", message: error.message || "no response from gateway" };
}

function realGateway() {
  const timeout = () => Number(process.env.PAYOUT_HTTP_TIMEOUT_MS) || 20_000;
  return {
    async createPayout(body, idempotencyKey) {
      try {
        const res = await axios.post(`${BASE}/payouts`, body, {
          headers: {
            "Content-Type": "application/json",
            "X-Payout-Idempotency": idempotencyKey,
            Authorization: authHeader(),
          },
          timeout: timeout(),
        });
        return res.data;
      } catch (error) {
        throw Object.assign(new Error("payout create failed"), classify(error));
      }
    },
    // Payouts previously created for a reference_id (RazorpayX filters the
    // payout list by reference_id and account_number).
    async findByReference(accountNumber, referenceId) {
      const res = await axios.get(`${BASE}/payouts`, {
        params: { account_number: accountNumber, reference_id: referenceId, count: 20 },
        headers: { Authorization: authHeader() },
        timeout: timeout(),
      });
      return Array.isArray(res.data?.items) ? res.data.items : [];
    },
  };
}

function mockGateway() {
  const payouts = new Map();
  let seq = 0;
  // fail.create: null | "rejected" | "ambiguous" | "ambiguous-created"
  const fail = { create: null, find: false };
  const calls = { create: 0, find: 0 };
  return {
    __mock: {
      payouts,
      fail,
      calls,
      reset() {
        payouts.clear();
        fail.create = null;
        fail.find = false;
        calls.create = 0;
        calls.find = 0;
      },
    },
    async createPayout(body, idempotencyKey) {
      calls.create += 1;
      if (fail.create === "rejected") {
        throw Object.assign(new Error("payout create failed"), { kind: "rejected", message: "mock: insufficient balance", status: 400 });
      }
      if (fail.create === "ambiguous") {
        throw Object.assign(new Error("payout create failed"), { kind: "ambiguous", message: "mock: timeout" });
      }
      const existing = [...payouts.values()].find((p) => p.idempotencyKey === idempotencyKey);
      if (existing) return existing;
      if (!Number.isInteger(body.amount) || body.amount <= 0) {
        throw Object.assign(new Error("payout create failed"), { kind: "rejected", message: "mock: bad amount", status: 400 });
      }
      const p = {
        id: `pout_mock${String(++seq).padStart(6, "0")}`,
        entity: "payout",
        amount: body.amount,
        currency: body.currency,
        fund_account_id: body.fund_account_id,
        reference_id: body.reference_id,
        status: "processing",
        idempotencyKey,
      };
      payouts.set(p.id, p);
      if (fail.create === "ambiguous-created") {
        throw Object.assign(new Error("payout create failed"), { kind: "ambiguous", message: "mock: response lost after creation" });
      }
      return p;
    },
    async findByReference(accountNumber, referenceId) {
      calls.find += 1;
      if (fail.find) throw new Error("mock: payouts list failed");
      return [...payouts.values()].filter((p) => p.reference_id === referenceId);
    },
  };
}

let gateway = null;
function getPayoutGateway() {
  if (!gateway) gateway = process.env.RAZORPAY_MOCK === "1" ? mockGateway() : realGateway();
  return gateway;
}

module.exports = { getPayoutGateway };
