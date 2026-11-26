import { initializeApp, getApps, getApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

/** Vercel stores multi-line secrets with literal "\n" sequences and sometimes wraps them in quotes. */
export function normalizePrivateKey(raw) {
  let key = String(raw || '').trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
  return key.replace(/\\n/g, '\n');
}

let services = null;
/** Lazily initialises the Admin SDK once per serverless instance. Throws (names only, never values) when misconfigured. */
export function getServices() {
  if (services) return services;
  const emulator = process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const projectId = process.env.FIREBASE_PROJECT_ID, clientEmail = process.env.FIREBASE_CLIENT_EMAIL, privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);
  let app;
  if (getApps().length) app = getApp();
  else if (projectId && clientEmail && privateKey) app = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId });
  else if (emulator && projectId) app = initializeApp({ projectId });
  else {
    const missing = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'].filter(k => !process.env[k]);
    throw new Error(`Firebase Admin is not configured. Missing environment variables: ${missing.join(', ')}`);
  }
  const db = getFirestore(app);
  try { db.settings({ ignoreUndefinedProperties: true }); } catch { /* already configured */ }
  services = { db, auth: getAuth(app) };
  return services;
}
