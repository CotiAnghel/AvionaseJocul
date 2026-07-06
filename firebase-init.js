// firebase-init.js
// Loaded as an ES module directly from Google's CDN — no npm/bundler needed,
// which keeps this deployable as-is on GitHub Pages.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDOlCY12Auhd085OhAX0w-Y8YJ4ULoSwZY",
  authDomain: "avionase-jocul.firebaseapp.com",
  projectId: "avionase-jocul",
  storageBucket: "avionase-jocul.firebasestorage.app",
  messagingSenderId: "503533798411",
  appId: "1:503533798411:web:409934765c7519be76f30e",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

/**
 * Resolves once we have an anonymous Firebase Auth user.
 * We need this (not just a typed username) so Firestore security rules can
 * tell players apart and stop each player from reading the other's ship
 * placement directly from the database.
 */
export function ensureSignedIn() {
  return new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) {
        unsub();
        resolve(user);
      }
    }, reject);
    signInAnonymously(auth).catch(reject);
  });
}
