// ═══════════════════════════════════════════════════════════════
//  Eternal Paws — server.js  (production-ready)
//  Stack: Express 5 · Stripe Checkout · Nodemailer
// ═══════════════════════════════════════════════════════════════

const express    = require("express");
const cors       = require("cors");
const nodemailer = require("nodemailer");
const path       = require("path");

// ── Stripe (chave vem de variável de ambiente em produção) ──────
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app  = express();
const PORT = process.env.PORT || 3000;

// ── URLs base ───────────────────────────────────────────────────
const BASE_URL = process.env.BASE_URL || "https://eternal-paws-original-production.up.railway.app";

// ── Email ───────────────────────────────────────────────────────
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_TO   = process.env.EMAIL_TO;

// ── Webhook ─────────────────────────────────────────────────────
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// ═══════════════════════════════════════════════════════════════
//  PLANOS — preços em centavos (USD)
// ═══════════════════════════════════════════════════════════════

const PLANS = {
  memory: {
    name:   "🐾 Memory — Pet Memorial Tribute",
    amount: 2900,          // $29
    label:  "Memory ($29)"
  },
  tribute: {
    name:   "💛 Tribute — Emotional Reunion Package",
    amount: 4900,         // $49
    label:  "Tribute ($49)"
  },
};

// ═══════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

app.use(cors());

// ⚠️ Webhook precisa receber body RAW — vem ANTES do express.json()
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  handleWebhook
);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ═══════════════════════════════════════════════════════════════
//  ROTA: /create-checkout
// ═══════════════════════════════════════════════════════════════

app.post("/create-checkout", async (req, res) => {
  try {
    const { plan = "memory" } = req.body;

    if (!PLANS[plan]) {
      return res.status(400).json({ error: "Invalid plan." });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: PLANS[plan].name },
            unit_amount:  PLANS[plan].amount,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${BASE_URL}/success`,
      cancel_url:  `${BASE_URL}/?cancel=true`,
      metadata: { plan },
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error("❌ create-checkout error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  ROTA: /success  (página de confirmação — success.html)
//  ⚠️ Precisa vir ANTES do catch-all, senão o catch-all sempre
//  devolve index.html e a página de confirmação nunca aparece.
// ═══════════════════════════════════════════════════════════════

app.get("/success", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "success.html"));
});

// ═══════════════════════════════════════════════════════════════
//  WEBHOOK: /webhook
// ═══════════════════════════════════════════════════════════════

async function handleWebhook(req, res) {
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error("⚠️  Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    const customerEmail = session.customer_details?.email || "—";
    const customerName  = session.customer_details?.name  || "—";
    const plan          = session.metadata?.plan          || "memory";
    const planLabel     = PLANS[plan]?.label              || plan;
    const amountPaid    = `$${(session.amount_total / 100).toFixed(2)}`;

    console.log(`✅ Sale confirmed: ${customerName} | ${customerEmail} | ${planLabel}`);

    const results = await Promise.allSettled([
      sendOwnerNotification({ customerName, customerEmail, planLabel, amountPaid }),
      sendCustomerConfirmation({ customerName, customerEmail, planLabel }),
    ]);

    // ── Visible fallback: log any email failures so they appear in Railway logs ──
    const [ownerResult, customerResult] = results;
    if (ownerResult.status === "rejected") {
      console.error("🚨 OWNER EMAIL FAILED — check Gmail credentials in Railway env vars");
      console.error("   Customer:", customerEmail, "| Plan:", planLabel, "| Amount:", amountPaid);
      console.error("   Reason:", ownerResult.reason?.message || ownerResult.reason);
    }
    if (customerResult.status === "rejected") {
      console.error("🚨 CUSTOMER EMAIL FAILED — confirmation not sent to:", customerEmail);
      console.error("   Reason:", customerResult.reason?.message || customerResult.reason);
    }
    if (ownerResult.status === "fulfilled" && customerResult.status === "fulfilled") {
      console.log("✅ Both emails sent successfully.");
    }
  }

  res.json({ received: true });
}

// ═══════════════════════════════════════════════════════════════
//  EMAIL HELPERS
// ═══════════════════════════════════════════════════════════════

function createTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  });
}

async function sendOwnerNotification({ customerName, customerEmail, planLabel, amountPaid }) {
  try {
    const transporter = createTransporter();
    await transporter.sendMail({
      from:    `"Eternal Paws" <${EMAIL_USER}>`,
      to:      EMAIL_TO,
      subject: `🐾 New sale! ${planLabel} — ${amountPaid}`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:auto;background:#0B0D1A;color:#E8E4F8;padding:32px;border-radius:12px;">
          <h2 style="color:#C8B96A;font-family:Georgia,serif;font-weight:300;">🐾 New sale received</h2>
          <hr style="border:none;border-top:1px solid #252B52;margin:16px 0;"/>
          <p><b>Customer:</b> ${customerName}</p>
          <p><b>Email:</b> <a href="mailto:${customerEmail}" style="color:#7B6FD4;">${customerEmail}</a></p>
          <p><b>Package:</b> ${planLabel}</p>
          <p><b>Amount paid:</b> ${amountPaid}</p>
          <hr style="border:none;border-top:1px solid #252B52;margin:16px 0;"/>
          <p style="color:#A89ED4;font-size:13px;">Reply to the customer's email to request their pet photos and get started.</p>
        </div>
      `,
    });
    console.log("📧 Owner notification sent to:", EMAIL_TO);
  } catch (err) {
    console.error("❌ Error sending owner email:", err.message);
  }
}

async function sendCustomerConfirmation({ customerName, customerEmail, planLabel }) {
  const firstName = customerName.split(" ")[0] || "there";
  try {
    const transporter = createTransporter();
    await transporter.sendMail({
      from:    `"Eternal Paws" <${EMAIL_USER}>`,
      to:      customerEmail,
      subject: `Your tribute is on its way 🐾 — Eternal Paws`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:auto;background:#0B0D1A;color:#E8E4F8;padding:40px;border-radius:12px;">
          <h1 style="font-family:Georgia,serif;font-weight:300;color:#C8B96A;font-size:32px;">Eternal <em>Paws</em> ✦</h1>
          <hr style="border:none;border-top:1px solid #252B52;margin:24px 0;"/>
          <h2 style="font-family:Georgia,serif;font-weight:300;font-size:24px;">Thank you, ${firstName}.</h2>
          <p style="color:#A89ED4;line-height:1.7;margin-top:12px;">
            We received your order for <strong style="color:#E8E4F8;">${planLabel}</strong>.<br/>
            Now we need your pet's photos to get started.
          </p>
          <div style="background:#1A1F3A;border:1px solid #252B52;border-radius:10px;padding:24px;margin:28px 0;">
            <h3 style="font-family:Georgia,serif;font-weight:300;color:#C8B96A;margin-bottom:12px;">📸 Next step — send your photos</h3>
            <p style="color:#A89ED4;font-size:14px;line-height:1.7;">
              Simply <b style="color:#E8E4F8;">reply to this email</b> and attach your favorite photos of your pet.<br/>
              The more photos you share, the more personal your tribute will be.
            </p>
            <ul style="color:#A89ED4;font-size:14px;line-height:2;margin-top:8px;padding-left:20px;">
              <li>✦ Any format: JPG, PNG, HEIC</li>
              <li>✦ Send 5–20 photos for best results</li>
              <li>✦ Include close-ups of their face, eyes, and fur</li>
            </ul>
          </div>
          <p style="color:#A89ED4;font-size:14px;line-height:1.7;">
            Your tribute will be ready within <strong style="color:#E8E4F8;">24 hours</strong> of receiving your photos.
          </p>
          <hr style="border:none;border-top:1px solid #252B52;margin:28px 0;"/>
          <p style="color:#7B6FD4;font-size:12px;text-align:center;">
            Questions? Just reply to this email.<br/>
            Eternal Paws — crafted with love, one pet at a time 🐾
          </p>
        </div>
      `,
    });
    console.log("📧 Customer confirmation sent to:", customerEmail);
  } catch (err) {
    console.error("❌ Error sending customer email:", err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
//  CATCH-ALL
// ═══════════════════════════════════════════════════════════════

app.get(/(.*)/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ═══════════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`
  ✦ Eternal Paws running
  ─────────────────────────────────
  Local:   http://localhost:${PORT}
  Webhook: http://localhost:${PORT}/webhook
  `);
});
