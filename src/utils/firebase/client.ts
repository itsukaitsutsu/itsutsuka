import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

// Firebase is now used for ONE thing only: Authentication (Option A).
//   * The browser signs in with Firebase and gets a short-lived ID token.
//   * Every /api request sends that token; the Worker verifies it.
//   * All data lives in Cloudflare D1 — Firestore is gone.
// getFirestore() was removed: nothing imports it any more, and dropping it
// keeps the Firestore SDK out of your bundle.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
