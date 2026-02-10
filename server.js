const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const Database = require("better-sqlite3");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const PRICE_ID = process.env.STRIPE_PRICE_ID;
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;
const TRIAL_DAYS = 7;

const db = new Database("heimdall.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY, stripe_customer_id TEXT,
    subscription_status TEXT DEFAULT 'none',
    trial_start TEXT, trial_end TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS promo_codes (
    code TEXT PRIMARY KEY, free_days INTEGER DEFAULT 30,
    max_uses INTEGER DEFAULT 1, times_used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS promo_redemptions (
    email TEXT, code TEXT,
    redeemed_at TEXT DEFAULT (datetime('now')), expires_at TEXT,
    PRIMARY KEY (email, code)
  );
`);

app.post("/webhook", express.raw({ type: "application/json" }), handleWebhook);
app.use(cors());
app.use(express.json());

app.post("/check-access", (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  const userEmail = email.toLowerCase();
  let user = db.prepare("SELECT * FROM users WHERE email = ?").get(userEmail);
  if (!user) {
    const now = new Date();
    const trialEnd = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    db.prepare("INSERT INTO users (email, subscription_status, trial_start, trial_end) VALUES (?, 'trialing', ?, ?)").run(userEmail, now.toISOString(), trialEnd.toISOString());
    return res.json({ access: true, status: "trialing", trial_days_left: TRIAL_DAYS, message: `Welcome! Your ${TRIAL_DAYS}-day free trial has started.` });
  }
  if (user.subscription_status === "active") {
    return res.json({ access: true, status: "active", message: "Subscription active" });
  }
  if (user.trial_end) {
    const now = new Date();
    const trialEnd = new Date(user.trial_end);
    if (now < trialEnd) {
      const daysLeft = Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24));
      return res.json({ access: true, status: "trialing", trial_days_left: daysLeft, message: `Trial: ${daysLeft} day${daysLeft !== 1 ? 's' : ''} left` });
    }
  }
  const promo = db.prepare("SELECT * FROM promo_redemptions WHERE email = ? AND expires_at > datetime('now') ORDER BY expires_at DESC LIMIT 1").get(userEmail);
  if (promo) {
    const expiresAt = new Date(promo.expires_at);
    const daysLeft = Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24));
    return res.json({ access: true, status: "promo", days_left: daysLeft, message: `Promo active: ${daysLeft} day${daysLeft !== 1 ? 's' : ''} left` });
  }
  return res.json({ access: false, status: "expired", message: "Trial expired. Subscribe to continue using Heimdall." });
});

app.post("/create-checkout", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  const userEmail = email.toLowerCase();
  try {
    let user = db.prepare("SELECT * FROM users WHERE email = ?").get(userEmail);
    let customerId = user?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: userEmail });
      customerId = customer.id;
      db.prepare("UPDATE users SET stripe_customer_id = ? WHERE email = ?").run(customerId, userEmail);
    }
    const session = await stripe.checkout.sessions.create({
      customer: customerId, payment_method_types: ["card"], mode: "subscription",
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      subscription_data: { trial_period_days: TRIAL_DAYS },
      success_url: `${SERVER_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SERVER_URL}/payment-cancel`,
      allow_promotion_codes: true,
    });
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error("Checkout error:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

app.post("/redeem-code", (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: "Email and code required" });
  const userEmail = email.toLowerCase();
  const promoCode = code.toUpperCase().trim();
  const promo = db.prepare("SELECT * FROM promo_codes WHERE code = ?").get(promoCode);
  if (!promo) return res.status(404).json({ error: "Invalid promo code" });
  if (promo.times_used >= promo.max_uses) return res.status(400).json({ error: "This promo code has been fully redeemed" });
  const existing = db.prepare("SELECT * FROM promo_redemptions WHERE email = ? AND code = ?").get(userEmail, promoCode);
  if (existing) return res.status(400).json({ error: "You've already used this code" });
  let user = db.prepare("SELECT * FROM users WHERE email = ?").get(userEmail);
  if (!user) { db.prepare("INSERT INTO users (email, subscription_status) VALUES (?, 'none')").run(userEmail); }
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + promo.free_days);
  db.prepare("INSERT INTO promo_redemptions (email, code, expires_at) VALUES (?, ?, ?)").run(userEmail, promoCode, expiresAt.toISOString());
  db.prepare("UPDATE promo_codes SET times_used = times_used + 1 WHERE code = ?").run(promoCode);
  res.json({ success: true, free_days: promo.free_days, expires_at: expiresAt.toISOString(), message: `Code redeemed! You have ${promo.free_days} free days.` });
});

app.post("/admin/create-promo", (req, res) => {
  const { admin_key, code, free_days, max_uses } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  const promoCode = (code || crypto.randomBytes(4).toString("hex")).toUpperCase();
  const days = free_days || 30;
  const uses = max_uses || 1;
  try {
    db.prepare("INSERT INTO promo_codes (code, free_days, max_uses) VALUES (?, ?, ?)").run(promoCode, days, uses);
    res.json({ code: promoCode, free_days: days, max_uses: uses });
  } catch (err) { res.status(400).json({ error: "Code already exists" }); }
});

app.get("/payment-success", (req, res) => {
  res.send('<html><head><title>Welcome to Heimdall Pro!</title></head><body style="background:#000;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;"><div><h1 style="font-size:48px;margin-bottom:8px;">⚔️</h1><h2>Welcome to Heimdall Pro!</h2><p style="color:#888;">Your subscription is active. You can close this tab.</p></div></body></html>');
});

app.get("/payment-cancel", (req, res) => {
  res.send('<html><head><title>Payment Cancelled</title></head><body style="background:#000;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;"><div><h2>Payment Cancelled</h2><p style="color:#888;">No worries! Subscribe anytime from the Heimdall extension.</p></div></body></html>');
});

app.get("/", (req, res) => { res.json({ status: "Heimdall server running", version: "1.0.0" }); });

async function handleWebhook(req, res) {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    if (endpointSecret) { event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret); }
    else { event = JSON.parse(req.body); }
  } catch (err) {
    console.error("Webhook error:", err.message);
    return res.status(400).send("Webhook Error: " + err.message);
  }
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object;
      const cust = await stripe.customers.retrieve(sub.customer);
      const email = cust.email?.toLowerCase();
      if (email) { db.prepare("UPDATE users SET subscription_status = ?, stripe_customer_id = ? WHERE email = ?").run(sub.status, sub.customer, email); }
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const cust = await stripe.customers.retrieve(sub.customer);
      const email = cust.email?.toLowerCase();
      if (email) { db.prepare("UPDATE users SET subscription_status = 'canceled' WHERE email = ?").run(email); }
      break;
    }
    case "invoice.payment_failed": {
      const inv = event.data.object;
      const cust = await stripe.customers.retrieve(inv.customer);
      const email = cust.email?.toLowerCase();
      if (email) { db.prepare("UPDATE users SET subscription_status = 'past_due' WHERE email = ?").run(email); }
      break;
    }
  }
  res.json({ received: true });
}

app.listen(PORT, () => {
  console.log("Heimdall server running on port " + PORT);
  console.log("Stripe Price: " + PRICE_ID);
});