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
  OAuthProvider,
  signInWithPopup,
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

/* Auth — Sprint 33: force LOCAL persistence so iOS PWA keeps session */
export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence);

export const CURRENT_TENANT_ID = "king-insulation-001";

/* Google SSO */
const googleProvider = new GoogleAuthProvider();
export const signInWithGoogle = () => signInWithPopup(auth, googleProvider);

/* Apple SSO */
const appleProvider = new OAuthProvider("apple.com");
appleProvider.addScope("email");
appleProvider.addScope("name");
export const signInWithApple = () => signInWithPopup(auth, appleProvider);

/* Re-export Auth helpers so app.js imports from one place */
export { signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged };
