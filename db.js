import {
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  query,
  where,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { db, auth } from "./firebase-config.js";

/* Convert Firestore Timestamps → JS milliseconds so app.js stays unchanged */
function toJS(data) {
  const out = { ...data };
  for (const k of Object.keys(out)) {
    if (out[k] && typeof out[k].toMillis === "function") {
      out[k] = out[k].toMillis();
    }
  }
  return out;
}

/* Adapter — same contract as the old createIDB(APP) */
export function createIDB(_APP) {
  return {
    /* Kept for compatibility — Firestore needs no explicit open step */
    open: () => Promise.resolve(),

    /* Returns ONLY documents owned by the authenticated user (strict UID isolation) */
    getAll: async (store) => {
      const uid = auth?.currentUser?.uid;
      if (!uid) return [];
      const snap = await getDocs(
        query(
          collection(db, store),
          where("ownerId", "==", uid),
        ),
      );
      return snap.docs.map((d) => toJS(d.data()));
    },

    /* Upserts a document — ownerId is the sole isolation key, no hardcoded tenant */
    put: async (store, data) => {
      const user = auth?.currentUser;
      if (!user || !user.uid) {
        throw new Error("User not authenticated. Cannot save data.");
      }
      const ownerId = user.uid;
      const { createdAt, ...payload } = data;
      const enriched = {
        ...payload,
        ownerId,
        updatedAt: serverTimestamp(),
        createdBy: payload.createdBy || ownerId,
        ...(!createdAt ? { createdAt: serverTimestamp() } : {}),
      };
      await setDoc(
        doc(db, store, String(data.id)),
        enriched,
        { merge: true },
      );
      return data;
    },

    del: async (store, id) => {
      await deleteDoc(doc(db, store, String(id)));
    },
  };
}
