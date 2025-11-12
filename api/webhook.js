// api/webhook.js (actualizado: carga Firebase solo en POST)
const axios = require("axios");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc"); dayjs.extend(utc);

const fmtCLP = new Intl.NumberFormat("es-CL");

async function sendWpp(to, text) {
  const url = `https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    { messaging_product: "whatsapp", to, text: { body: text } },
    { headers: { Authorization: `Bearer ${process.env.META_TOKEN}` } }
  );
}

function parseMonto(raw) {
  const clean = String(raw || "").replace(/[.$,\s]/g, "");
  const n = Number(clean);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Orden: 1 Racional, 2 Negocio, 3 Rebeca
function normCat(input) {
  const t = (input || "").toString().trim().toLowerCase();
  if (["1","racional","ra"].includes(t)) return "Racional";
  if (["2","negocio","ne"].includes(t)) return "Negocio";
  if (["3","rebeca","re","rebe"].includes(t)) return "Rebeca";
  return null;
}

async function recalcAfterInsert() { return true; }

module.exports = async (req, res) => {
  // GET: verificación del webhook (no depende de Firebase)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  // POST: mensajes entrantes (cargamos Firebase aquí para no romper la verificación GET)
  if (req.method === "POST") {
    // Cargar Firebase solo cuando se necesita
    const { db } = require("../libfirebase");

    try {
      const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msg) return res.status(200).end();

      const allowed = (process.env.ALLOWED_PHONES || "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);

      const phone = msg.from;
      if (!allowed.includes(phone)) return res.status(200).end();

      const text = (msg.text?.body || "").trim();

      // Sesiones en Firestore
      async function getSession(phone) {
        const ref = db.collection("wh_sessions").doc(phone);
        const snap = await ref.get();
        return snap.exists ? snap.data() : { step: "idle", draft: {} };
      }
      async function setSession(phone, data) {
        const ref = db.collection("wh_sessions").doc(phone);
        await ref.set(data, { merge: true });
      }

      let session = await getSession(phone);

      // Activación con cualquier mensaje si está idle
      if (session.step === "idle" || /^egreso$/i.test(text)) {
        session = { step: "ask_monto", draft: {} };
        await setSession(phone, session);
        await sendWpp(phone, "💸 ¿Monto del egreso? (ej: 21.990)\nEscribe “cancelar” para salir.");
        return res.status(200).end();
      }

      // Cancelar
      if (/^cancel(ar)?$/i.test(text)) {
        await setSession(phone, { step: "idle", draft: {} });
        await sendWpp(phone, "🛑 Cancelado. Manda cualquier mensaje para registrar otro.");
        return res.status(200).end();
      }

      // Paso 1: Monto
      if (session.step === "ask_monto") {
        const monto = parseMonto(text);
        if (!monto) {
          await sendWpp(phone, "Monto inválido 🙈. Prueba con 21.990 o 21990.");
          return res.status(200).end();
        }
        session.draft.monto = monto;
        session.step = "ask_cat";
        await setSession(phone, session);
        await sendWpp(
          phone,
          "🏷️ Categoría (responde con número):\n1. Racional\n2. Negocio\n3. Rebeca"
        );
        return res.status(200).end();
      }

      // Paso 2: Categoría
      if (session.step === "ask_cat") {
        const cat = normCat(text);
        if (!cat) {
          await sendWpp(phone, "Elige 1, 2 o 3:\n1. Racional\n2. Negocio\n3. Rebeca");
          return res.status(200).end();
        }
        session.draft.categoria = cat;
        session.step = "ask_desc";
        await setSession(phone, session);
        await sendWpp(phone, "📝 Descripción (opcional). Escribe “-” para omitir.");
        return res.status(200).end();
      }

      // Paso 3: Descripción
      if (session.step === "ask_desc") {
        const desc = text === "-" ? "" : text;
        const fechaISO = dayjs().utc().toISOString();
        session.draft.descripcion = desc;
        session.draft.fecha = fechaISO;
        session.step = "confirm";
        await setSession(phone, session);

        const resumen =
          `Confirma:\n` +
          `• Monto: $${fmtCLP.format(session.draft.monto)}\n` +
          `• Categoría: ${session.draft.categoria}\n` +
          `• Desc: ${desc || "(sin descripción)"}`;
        await sendWpp(phone, `${resumen}\n\n¿Guardo? Responde “sí” o “no”.`);
        return res.status(200).end();
      }

      // Paso 4: Confirmación
      if (session.step === "confirm") {
        if (/^s[ií]$/i.test(text)) {
          const now = dayjs().utc().toISOString();
          await db.collection("egresos").add({
            created_at: now,
            fecha: session.draft.fecha || now,
            fuente: "whatsapp",
            phone,
            monto: session.draft.monto,
            categoria: session.draft.categoria,
            descripcion: session.draft.descripcion || "",
          });
          await setSession(phone, { step: "idle", draft: {} });
          await recalcAfterInsert(session.draft.fecha || now);
          await sendWpp(phone, "✅ Guardado. Manda cualquier mensaje para registrar otro.");
        } else {
          await setSession(phone, { step: "idle", draft: {} });
          await sendWpp(phone, "❌ Cancelado. Manda cualquier mensaje si quieres empezar de nuevo.");
        }
        return res.status(200).end();
      }

      // Fallback
      await sendWpp(
        phone,
        "Hola 👋 Manda cualquier mensaje para registrar un egreso.\nFlujo: monto → (1/2/3) → descripción → confirmar."
      );
      return res.status(200).end();
    } catch (e) {
      console.error("Webhook error:", e?.response?.data || e);
      return res.status(200).end();
    }
  }

  // Otros métodos
  return res.status(405).send("Method Not Allowed");
};
