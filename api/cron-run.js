"use strict";

module.exports = (req, res) => {
  try {
    const now = new Date().toISOString();
    const message = `Server.me dummy cron executed at ${now}`;
    // Minimal work: write to logs and return JSON
    console.log(message);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, message, timestamp: now }));
  } catch (err) {
    console.error('cron-run error', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: String(err) }));
  }
};
