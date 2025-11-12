// lib/firebase.js
const admin = require("firebase-admin");

let app;

// Evita inicializar más de una vez (Vercel ejecuta funciones varias veces)
if (!admin.apps.length) {
  app = admin.initializeApp({
    credential: admin.credential.cert({
      projectId: "egresos-mach-negocio",
      clientEmail: "firebase-adminsdk-fbsvc@egresos-mach-negocio.iam.gserviceaccount.com",
      // IMPORTANTE: reemplaza los saltos de línea correctamente al subir a Vercel
      privateKey: process.env.FIREBASE_PRIVATE_KEY
        ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
        : undefined,
    }),
  });
} else {
  app = admin.app();
}

const db = admin.firestore();

module.exports = { admin, db };
