// /api/webhook.js — versión pulida
// - Reset con “hola”, “buenas” o “egreso” desde cualquier estado
// - Confirmación compacta y más legible (acepta sí/1/guardar y no/2/cancelar)
// - Mensaje final personalizado por número (Rebeca/Vicente)
// - Sigue guardando en Firestore con los campos que usa tu web: 
//   { amount:number, date:"YYYY-MM-DD", category:string, note:string, createdAt:serverTimestamp }

const axios = require("axios");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
dayjs.extend(utc);

// Personalización por número (sin +)
const NAME_BY_PHONE = {
  "56965741027": "Rebeca",
  "56961068305": "Vicente",
};

const fmtCLP = new Intl.NumberFormat("es-CL");

// Resetea el flujo si se detecta cualquiera de estas palabras
const RESET_RE = /^(hola|buenas|egreso)$/i;

async function sendWpp(to, text) {
  const url = `https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    { messaging_product: "whatsapp", to, text: { body: text } },
    { headers: { Authorization: `Bearer ${process.env.META_TOKEN}` } }
  );
}

// Montos: admite 21.990, 21 990, 21990, etc.
function parseMonto(raw) {
  const clean = String(raw || "").replace(/[.\s,$]/g, "");
  const n = Number(clean);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 1=Racional, 2=Negocio, 3=Rebeca
function normCat(input) {
  const t = (input || "").toString().trim().toLowerCase();
  if (["1", "racional", "ra"].includes(t)) return "Racional";
  if (["2", "negocio", "ne"].includes(t)) return "Negocio";
  if (["3", "rebeca", "re", "rebe"].includes(t)) return "Rebeca";
  return null;
}

// YYYY-MM-DD en Chile
function ymdChile(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

module.exports = async (req, res) => {
  // Verificación GET
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method === "POST") {
    // Cargamos Firebase solo en POST
    const { db, admin } = require("../libfirebase");

    try {
      const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msg) return res.status(200).end();

      const allowed = (process.env.ALLOWED_PHONES || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const phone = msg.from; // ej: 56961068305
      if (!allowed.includes(phone)) return res.status(200).end();

      const text = (msg.text?.body || "").trim();

      // --- Sesiones ---
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

      // Reset caliente (hola/buenas/egreso) desde cualquier estado
      if (RESET_RE.test(text)) {
        session = { step: "ask_monto", draft: {} };
        await setSession(phone, session);
        const name = NAME_BY_PHONE[phone] ? `, ${NAME_BY_PHONE[phone]}` : "";
        await sendWpp(
          phone,
          `Hola${name}!\n\n💸 ¿Monto del egreso? (ej: 21.990)\nEscribe “cancelar” para salir.`
        );
        return res.status(200).end();
      }

      // Activación inicial cuando está idle
      if (session.step === "idle") {
        session = { step: "ask_monto", draft: {} };
        await setSession(phone, session);
        const name = NAME_BY_PHONE[phone] ? `, ${NAME_BY_PHONE[phone]}` : "";
        await sendWpp(
          phone,
          `Hola${name}!\n\n💸 ¿Monto del egreso? (ej: 21.990)\nEscribe “cancelar” para salir.`
        );
        return res.status(200).end();
      }

      // Cancelar en cualquier momento
      if (/^cancel(ar)?$/i.test(text)) {
        await setSession(phone, { step: "idle", draft: {} });
        await sendWpp(phone, "🛑 Cancelado. Manda cualquier mensaje para registrar otro.");
        return res.status(200).end();
      }

      // Paso 1: monto
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
          "🏷️ Categoría (responde con número):\n1) Racional\n2) Negocio\n3) Rebeca"
        );
        return res.status(200).end();
      }

      // Paso 2: categoría
      if (session.step === "ask_cat") {
        const cat = normCat(text);
        if (!cat) {
          await sendWpp(phone, "Elige 1, 2 o 3:\n1) Racional\n2) Negocio\n3) Rebeca");
          return res.status(200).end();
        }
        session.draft.categoria = cat;
        session.step = "ask_desc";
        await setSession(phone, session);
        await sendWpp(phone, "📝 Descripción (opcional). Escribe “-” para omitir.");
        return res.status(200).end();
      }

      // Paso 3: descripción
      if (session.step === "ask_desc") {
        const desc = text === "-" ? "" : text;
        session.draft.descripcion = desc;
        session.draft.dateYMD = ymdChile();
        session.step = "confirm";
        await setSession(phone, session);

        const resumen =
          `Por favor confirma:\n` +
          `• 💵 Monto: $${fmtCLP.format(session.draft.monto)}\n` +
          `• 🏷️ Categoría: ${session.draft.categoria}\n` +
          `• 🗓️ Fecha: ${session.draft.dateYMD}\n` +
          `• 📝 Nota: ${desc || "(sin descripción)"}\n\n` +
          `Responde *1* para Guardar o *2* para Cancelar.`;

        await sendWpp(phone, resumen);
        return res.status(200).end();
      }

      // Paso 4: confirmación
      if (session.step === "confirm") {
        const t = text.toLowerCase();
        const ok = /^s[ií]$/.test(t) || t === "1" || /guardar/i.test(t);
        const cancel = /^no$/.test(t) || t === "2" || /cancelar/i.test(t);

        if (ok) {
          const ymd = session.draft.dateYMD || ymdChile();
          await db.collection("egresos").add({
            amount: session.draft.monto,
            date: ymd,                         // STRING YYYY-MM-DD (como tu web)
            category: session.draft.categoria,
            note: session.draft.descripcion || "",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          const nombre = NAME_BY_PHONE[phone];
          const detalle =
            `✅ Listo${nombre ? ", " + nombre : ""}! ` +
            `Se registró el egreso de $${fmtCLP.format(session.draft.monto)} ` +
            `en “${session.draft.categoria}”` +
            `${session.draft.descripcion ? ` — “${session.draft.descripcion}”` : ""} ` +
            `para la fecha ${ymd}.\n` +
            `Ya aparece en la web (actualización en vivo).`;

          await setSession(phone, { step: "idle", draft: {} });
          await sendWpp(phone, detalle);
          return res.status(200).end();
        }

        if (cancel) {
          await setSession(phone, { step: "idle", draft: {} });
          await sendWpp(phone, "❌ Cancelado. Manda cualquier mensaje si quieres empezar de nuevo.");
          return res.status(200).end();
        }

        // Si responde otra cosa, reenvío el menú de confirmación
        await sendWpp(
          phone,
          `Responde *1* para Guardar o *2* para Cancelar.`
        );
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

  return res.status(405).send("Method Not Allowed");
};
