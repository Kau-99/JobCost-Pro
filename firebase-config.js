import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  browserLocalPersistence,
  setPersistence,
  GoogleAuthProvider,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject,
  listAll,
  getMetadata,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import {
  initializeAppCheck,
  ReCaptchaV3Provider,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app-check.js";

const firebaseConfig = {
  apiKey: "AIzaSyDvmZ4ed_uuhiYZkO-sYmGgTIw4BCeiRo4",
  authDomain: "jobcost-pro-4301f.firebaseapp.com",
  projectId: "jobcost-pro-4301f",
  storageBucket: "jobcost-pro-4301f.firebasestorage.app",
  messagingSenderId: "495616892669",
  appId: "1:495616892669:web:9a2d6ca2e3facd0a222894",
  measurementId: "G-6SFQXDQF9Y",
};

const app = initializeApp(firebaseConfig);

/* ─── App Check — reCAPTCHA v3 ──────────────────────────
   Protege o Firebase contra uso não autorizado da API Key.
   isTokenAutoRefreshEnabled: true renova o token automaticamente.
─────────────────────────────────────────────────────────── */
initializeAppCheck(app, {
  provider: new ReCaptchaV3Provider("6Lf0hs0sAAAAAOuxSspdmhCTuxsgdDipMtrkImFk"),
  isTokenAutoRefreshEnabled: true,
});

/* ─── Firestore com persistência offline completa ──────── */
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
});

/* ─── Auth ──────────────────────────────────────────────── */
export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch((err) =>
  console.error("[Auth] Could not set persistence:", err),
);

/* ─── Google SSO ────────────────────────────────────────── */
const googleProvider = new GoogleAuthProvider();
export const signInWithGoogle = () => signInWithRedirect(auth, googleProvider);

export const handleRedirectResult = () => getRedirectResult(auth);
export const logoutUser = () => signOut(auth);

export { signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, sendPasswordResetEmail };

/* ─── Firebase Storage ──────────────────────────────────── */
export const storage = getStorage(app);
export { ref, uploadBytes, getDownloadURL, deleteObject, listAll, getMetadata };
