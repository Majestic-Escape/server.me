// Single Razorpay client for the app (controllers used to construct their own
// instances inline). When RAZORPAY_MOCK=1 (tests only — never set in any
// deployment) an in-memory fake with the same surface is used so the payment
// state machine can be exercised without network access or real money.
const Razorpay = require("razorpay");

function realClient() {
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

function mockClient() {
  const orders = new Map();
  const payments = new Map();
  const refunds = new Map();
  let seq = 0;
  const fail = { ordersCreate: false, paymentsRefund: false, paymentsFetch: false };
  const calls = { ordersCreate: 0, paymentsFetch: 0, paymentsRefund: 0 };
  return {
    key_id: process.env.RAZORPAY_KEY_ID || "rzp_test_mock",
    key_secret: process.env.RAZORPAY_KEY_SECRET || "mock_secret",
    __mock: { orders, payments, refunds, fail, calls },
    orders: {
      async create({ amount, currency, receipt }) {
        calls.ordersCreate += 1;
        if (fail.ordersCreate) throw new Error("mock: razorpay orders.create failed");
        if (!Number.isInteger(amount)) throw new Error("mock: amount must be integer paise");
        const id = `order_mock${String(++seq).padStart(6, "0")}`;
        const order = { id, entity: "order", amount, amount_paid: 0, currency, receipt, status: "created" };
        orders.set(id, order);
        return order;
      },
      async fetch(id) {
        const o = orders.get(id);
        if (!o) throw Object.assign(new Error("mock: order not found"), { statusCode: 400 });
        return o;
      },
    },
    payments: {
      async fetch(id) {
        calls.paymentsFetch += 1;
        if (fail.paymentsFetch) throw new Error("mock: razorpay payments.fetch failed");
        const p = payments.get(id);
        if (!p) throw Object.assign(new Error("mock: payment not found"), { statusCode: 400 });
        return p;
      },
      async refund(paymentId, { amount }) {
        calls.paymentsRefund += 1;
        if (fail.paymentsRefund) throw new Error("mock: razorpay payments.refund failed");
        const p = payments.get(paymentId);
        if (!p) throw Object.assign(new Error("mock: payment not found"), { statusCode: 400 });
        const already = [...refunds.values()].filter((r) => r.payment_id === paymentId).reduce((a, r) => a + r.amount, 0);
        if (already + amount > p.amount) throw Object.assign(new Error("mock: refund exceeds payment"), { statusCode: 400 });
        const id = `rfnd_mock${String(++seq).padStart(6, "0")}`;
        const refund = { id, entity: "refund", payment_id: paymentId, amount, status: "processed" };
        refunds.set(id, refund);
        return refund;
      },
    },
    // Test helper: register a payment as Razorpay would report it.
    __registerPayment({ id, order_id, amount, currency = "INR", status = "captured", method = "upi" }) {
      const p = { id, entity: "payment", order_id, amount, currency, status, method };
      payments.set(id, p);
      return p;
    },
  };
}

let client = null;
function getRazorpay() {
  if (!client) client = process.env.RAZORPAY_MOCK === "1" ? mockClient() : realClient();
  return client;
}

module.exports = { getRazorpay };
