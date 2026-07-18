// ═══════════════════════════════════════════════════════════════
//  Eternal Paws — server.js  (production-ready)
//  Stack: Express 5 · Stripe Checkout · Resend (email API)
// ═══════════════════════════════════════════════════════════════

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const crypto  = require("crypto");
const { Resend } = require("resend");

// ── Stripe (chave vem de variável de ambiente em produção) ──────
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// ── Resend (API de e-mail via HTTPS, sem depender de porta SMTP) ─
const resend = new Resend(process.env.RESEND_API_KEY);

const app  = express();
const PORT = process.env.PORT || 3000;

// ── URLs base ───────────────────────────────────────────────────
const BASE_URL = process.env.BASE_URL || "https://eternal-paws-original-production.up.railway.app";

// ── Email ───────────────────────────────────────────────────────
const EMAIL_TO   = process.env.EMAIL_TO;
const EMAIL_FROM = process.env.EMAIL_FROM || "Eternal Paws <onboarding@resend.dev>";

// ── Webhook ─────────────────────────────────────────────────────
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// ── Meta Conversions API ──────────────────────────────────────
const META_PIXEL_ID   = process.env.META_PIXEL_ID;
const META_CAPI_TOKEN  = process.env.META_CAPI_ACCESS_TOKEN;

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
//  ROTA TEMPORÁRIA DE TESTE — Meta CAPI
//  ⚠️ REMOVER depois de confirmar que está funcionando!
//  Acesse: https://SEU-DOMINIO/test-meta-event
// ═══════════════════════════════════════════════════════════════

app.get("/test-meta-event", async (req, res) => {
  try {
    await sendMetaPurchaseEvent({
      req,
      customerEmail: "teste@eternalpawstribute.shop",
      amountPaid: "$29.00",
      planLabel: "Memory ($29) — TESTE",
      eventId: `test-${Date.now()}`,
    });
    res.json({ ok: true, message: "Evento de teste enviado. Confira os logs do Railway e o Events Manager da Meta." });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
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
    const plan           = session.metadata?.plan          || "memory";
    const planLabel      = PLANS[plan]?.label               || plan;
    const amountPaid     = `$${(session.amount_total / 100).toFixed(2)}`;

    console.log(`✅ Sale confirmed: ${customerName} | ${customerEmail} | ${planLabel}`);

    // ── Responde ao Stripe IMEDIATAMENTE — evita timeout ──────
    res.json({ received: true });

    // ── Envia os e-mails DEPOIS, sem o Stripe esperar por isso ──
    Promise.allSettled([
      sendOwnerNotification({ customerName, customerEmail, planLabel, amountPaid }),
      sendCustomerConfirmation({ customerName, customerEmail, planLabel }),
      sendMetaPurchaseEvent({ req, customerEmail, amountPaid, planLabel, eventId: session.id }),
    ]).then(([ownerResult, customerResult, metaResult]) => {
      if (ownerResult.status === "rejected") {
        console.error("🚨 OWNER EMAIL FAILED:", ownerResult.reason?.message || ownerResult.reason);
      }
      if (customerResult.status === "rejected") {
        console.error("🚨 CUSTOMER EMAIL FAILED — confirmation not sent to:", customerEmail);
        console.error("   Reason:", customerResult.reason?.message || customerResult.reason);
      }
      if (metaResult.status === "rejected") {
        console.error("🚨 META CAPI EVENT FAILED:", metaResult.reason?.message || metaResult.reason);
      }
      if (ownerResult.status === "fulfilled" && customerResult.status === "fulfilled") {
        console.log("✅ Both emails sent successfully.");
      }
    });

    return; // já respondemos ao Stripe, encerra aqui
  }

  res.json({ received: true });
}

// ═══════════════════════════════════════════════════════════════
//  META CONVERSIONS API  (envia o evento Purchase pro servidor da Meta)
//  Isso funciona mesmo se o usuário tiver ad blocker ou for iOS —
//  não depende do pixel do navegador.
// ═══════════════════════════════════════════════════════════════

function sha256(value) {
  return crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

async function sendMetaPurchaseEvent({ req, customerEmail, amountPaid, planLabel, eventId }) {
  if (!META_PIXEL_ID || !META_CAPI_TOKEN) {
    console.warn("⚠️  META_PIXEL_ID ou META_CAPI_ACCESS_TOKEN não configurados — evento Purchase não enviado.");
    return;
  }

  const payload = {
    data: [
      {
        event_name: "Purchase",
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId, // mesmo ID usado no pixel do navegador evita evento duplicado
        action_source: "website",
        event_source_url: BASE_URL,
        user_data: {
          em: [sha256(customerEmail)],
          client_ip_address: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
          client_user_agent: req.headers["user-agent"],
        },
        custom_data: {
          currency: "usd",
          value: Number(amountPaid.replace("$", "")),
          content_name: planLabel,
        },
      },
    ],
  };

  const url = `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events?access_token=${META_CAPI_TOKEN}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (result.error) {
      console.error("🚨 Meta CAPI error:", result.error.message);
    } else {
      console.log("📊 Meta Purchase event sent:", result.events_received, "event(s) received");
    }
  } catch (err) {
    console.error("🚨 Meta CAPI request failed:", err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
//  EMAIL HELPERS  (via Resend API — HTTPS, sem bloqueio de porta)
// ═══════════════════════════════════════════════════════════════

async function sendOwnerNotification({ customerName, customerEmail, planLabel, amountPaid }) {
  const { data, error } = await resend.emails.send({
    from:    EMAIL_FROM,
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

  if (error) throw new Error(error.message || JSON.stringify(error));
  console.log("📧 Owner notification sent to:", EMAIL_TO, "| id:", data?.id);
}

async function sendCustomerConfirmation({ customerName, customerEmail, planLabel }) {
  const firstName = customerName.split(" ")[0] || "there";

  const { data, error } = await resend.emails.send({
    from:    EMAIL_FROM,
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

  if (error) throw new Error(error.message || JSON.stringify(error));
  console.log("📧 Customer confirmation sent to:", customerEmail, "| id:", data?.id);
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
