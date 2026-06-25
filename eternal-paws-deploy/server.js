// ═══════════════════════════════════════════════════════════════
//  Eternal Paws — server.js
//  Stack: Express 5 · Stripe Checkout Sessions · Nodemailer
// ═══════════════════════════════════════════════════════════════

const express    = require("express");
const cors       = require("cors");
const nodemailer = require("nodemailer");
const path       = require("path");
const stripe     = require("stripe")(process.env.STRIPE_SECRET_KEY || "sk_test_51TlITA7t4PODQi76IPgXoS9EsQ6vP66eLHkT4RCx0uP0mq5MhVexZoHCTXZy5EF0b1q5pyONYU8ctGg8DCDEHJy800ryqdioTI");

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── URLs base (troque quando for para produção) ──────────────
const BASE_URL = process.env.BASE_URL || "eternal-paws-original-production.up.railway.app";
//               ↑ em produção: "eternal-paws-original-production.up.railway.app"

// ─── Email (Gmail) ─────────────────────────────────────────────
//  1. Ative "Verificação em duas etapas" na sua conta Google
//  2. Acesse: myaccount.google.com/apppasswords
//  3. Crie uma App Password para "Mail" → cole abaixo
const EMAIL_USER = process.env.EMAIL_USER || "contadosfudidotl@gmail.com";
const EMAIL_PASS = process.env.EMAIL_PASS || "czhv jznp pcaq bvdm"; // App Password (16 chars)
const EMAIL_TO   = process.env.EMAIL_TO   || "contadosfudidotl@gmail.com";  // onde você recebe as vendas

// ─── Webhook Secret ────────────────────────────────────────────
//  Após instalar Stripe CLI, rode:
//    stripe listen --forward-to localhost:3000/webhook
//  Ele imprime "webhook signing secret" → whsec_... → cole abaixo
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_8a69cb7591d697a0a3eabe07464f19eed09d9a5eb47a8110efc0615ef248cef3";

// ═══════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

app.use(cors());

// ⚠️  O webhook PRECISA receber o body como Buffer RAW (não JSON)
//     Por isso ele fica ANTES do express.json()
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  handleWebhook
);

app.use(express.json());

// Serve o index.html e assets da pasta public/
app.use(express.static(path.join(__dirname, "public")));

// ═══════════════════════════════════════════════════════════════
//  PLANOS
// ═══════════════════════════════════════════════════════════════

const PLANS = {
  basic: {
    name:   "Pet Tribute Basic",
    amount: 2900,           // centavos → $29.00
    label:  "Package A — Basic ($29)"
  },
  premium: {
    name:   "Pet Tribute Premium (Complete Memorial)",
    amount: 4900,           // centavos → $49.00
    label:  "Package B — Premium ($49)"
  }
};

// ═══════════════════════════════════════════════════════════════
//  ROTA: /create-checkout
//  Recebe { plan } do frontend e retorna { url } do Stripe
// ═══════════════════════════════════════════════════════════════

app.post("/create-checkout", async (req, res) => {
  try {
    const { plan = "basic" } = req.body;

    if (!PLANS[plan]) {
      return res.status(400).json({ error: "Plano inválido." });
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

      // Stripe redireciona para cá após pagamento
      success_url: `${BASE_URL}/?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${BASE_URL}/?cancel=true`,

      // Permite recuperar os dados depois no webhook
      metadata: { plan },
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error("❌ create-checkout error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  WEBHOOK: /webhook
//  Stripe chama esta rota quando o pagamento é confirmado.
//  Este é o lugar SEGURO para acionar emails — não o success_url,
//  porque o cliente pode fechar o navegador antes de ser redirecionado.
// ═══════════════════════════════════════════════════════════════

async function handleWebhook(req, res) {
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error("⚠️  Webhook signature inválida:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Só processa pagamentos confirmados
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    const customerEmail = session.customer_details?.email || "—";
    const customerName  = session.customer_details?.name  || "—";
    const plan          = session.metadata?.plan          || "basic";
    const planLabel     = PLANS[plan]?.label              || plan;
    const amountPaid    = `$${(session.amount_total / 100).toFixed(2)}`;

    console.log(`✅ Pagamento confirmado: ${customerName} | ${customerEmail} | ${planLabel}`);

    // Envia os dois emails em paralelo
    await Promise.allSettled([
      sendOwnerNotification({ customerName, customerEmail, planLabel, amountPaid }),
      sendCustomerConfirmation({ customerName, customerEmail, planLabel }),
    ]);
  }

  res.json({ received: true });
}

// ═══════════════════════════════════════════════════════════════
//  EMAIL HELPERS
// ═══════════════════════════════════════════════════════════════

function createTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS,   // App Password do Google (não a senha normal)
    },
  });
}

// Email para VOCÊ — aviso de nova venda
async function sendOwnerNotification({ customerName, customerEmail, planLabel, amountPaid }) {
  try {
    const transporter = createTransporter();
    await transporter.sendMail({
      from:    `"Eternal Paws" <${EMAIL_USER}>`,
      to:      EMAIL_TO,
      subject: `🐾 Nova venda! ${planLabel} — ${amountPaid}`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:auto;background:#0B0D1A;color:#E8E4F8;padding:32px;border-radius:12px;">
          <h2 style="color:#C8B96A;font-family:Georgia,serif;font-weight:300;">🐾 Nova venda recebida</h2>
          <hr style="border:none;border-top:1px solid #252B52;margin:16px 0;"/>
          <p><b>Cliente:</b> ${customerName}</p>
          <p><b>Email:</b> <a href="mailto:${customerEmail}" style="color:#7B6FD4;">${customerEmail}</a></p>
          <p><b>Pacote:</b> ${planLabel}</p>
          <p><b>Total pago:</b> ${amountPaid}</p>
          <hr style="border:none;border-top:1px solid #252B52;margin:16px 0;"/>
          <p style="color:#A89ED4;font-size:13px;">Responda ao email do cliente pedindo as fotos do pet para começar o tribute.</p>
        </div>
      `,
    });
    console.log("📧 Email de venda enviado para:", EMAIL_TO);
  } catch (err) {
    console.error("❌ Erro ao enviar email de venda:", err.message);
  }
}

// Email para o CLIENTE — confirmação + próximo passo
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
              The more photos you share, the more personal and accurate your tribute will be.
            </p>
            <ul style="color:#A89ED4;font-size:14px;line-height:2;margin-top:8px;padding-left:20px;">
              <li>✦ Any format works: JPG, PNG, HEIC</li>
              <li>✦ Share 5–20 photos for best results</li>
              <li>✦ Include close-ups of their face, eyes, and fur</li>
            </ul>
          </div>

          <p style="color:#A89ED4;font-size:14px;line-height:1.7;">
            Your tribute will be ready within <strong style="color:#E8E4F8;">24 hours</strong> of receiving your photos.
            We'll send it directly to this email address.
          </p>

          <hr style="border:none;border-top:1px solid #252B52;margin:28px 0;"/>
          <p style="color:#7B6FD4;font-size:12px;text-align:center;">
            Questions? Just reply to this email.<br/>
            Eternal Paws — crafted with love, one pet at a time 🐾
          </p>
        </div>
      `,
    });
    console.log("📧 Email de confirmação enviado para:", customerEmail);
  } catch (err) {
    console.error("❌ Erro ao enviar email de confirmação:", err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
//  ROTA CATCH-ALL — serve o index.html para qualquer rota
//  (importante para quando o Stripe redirecionar com ?success=true)
// ═══════════════════════════════════════════════════════════════


app.get(/(.*)/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ═══════════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`
  ✦ Eternal Paws servidor rodando
  ─────────────────────────────────
  Local:    http://localhost:${PORT}
  Webhook:  http://localhost:${PORT}/webhook
  ─────────────────────────────────
  Lembre de rodar em outro terminal:
  stripe listen --forward-to localhost:${PORT}/webhookmkdir public
  `);
});