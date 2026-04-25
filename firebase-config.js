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

/* Firestore with full offline persistence */
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
});

/*
 * Auth persistence — browserLocalPersistence stores the session in localStorage.
 * This survives app restarts, device reboots, and offline periods on iOS PWA.
 * setPersistence() returns a Promise; since browserLocalPersistence is the web
 * default, it resolves synchronously and any subsequent auth calls are safe.
 */
export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch((err) =>
  console.error("[Auth] Could not set persistence:", err),
);

/* Google SSO — redirect avoids popup-blocker issues on GitHub Pages / mobile */
const googleProvider = new GoogleAuthProvider();
export const signInWithGoogle = () => signInWithRedirect(auth, googleProvider);


/* Call on every page-load to capture the result when returning from a redirect */
export const handleRedirectResult = () => getRedirectResult(auth);

export const logoutUser = () => signOut(auth);

/* Re-export Auth helpers so app.js imports from one place */
export { signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, sendPasswordResetEmail };
