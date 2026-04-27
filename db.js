import {
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { db, auth } from "./firebase-config.js";

/* Convert Firestore Timestamps → JS milliseconds */
function toJS(data) {
  const out = { ...data };
  for (const k of Object.keys(out)) {
    if (out[k] && typeof out[k].toMillis === "function") {
      out[k] = out[k].toMillis();
    }
  }
  return out;
}

/* ── Limits por collection ─────────────────────────────────
   Define quantos documentos cada collection carrega no boot.
   Collections "pequenas" (crew, inventory) carregam tudo.
   Collections "grandes" (jobs, timeLogs) têm limite padrão.
   Aumente conforme seu negócio crescer.
─────────────────────────────────────────────────────────── */
const COLLECTION_LIMITS = {
  jobs:        500,   /* Últimos 500 jobs ordenados por data */
  timeLogs:    1000,  /* Últimos 1000 registros de horas */
  estimates:   300,   /* Últimos 300 estimates */
  mileageLogs: 500,   /* Últimos 500 registros de km */
  clients:     null,  /* Sem limite */
  crew:        null,  /* Sem limite */
  inventory:   null,  /* Sem limite */
  templates:   null,  /* Sem limite */
  equipment:   null,  /* Sem limite */
  pricebook:   null,  /* Sem limite */
  materials:   null,  /* Sem limite */
};

/* ── Campo de ordenação por collection ────────────────────
   Define qual campo usar para ordenar (mais recente primeiro).
   Collections sem campo de data não têm ordenação server-side.
─────────────────────────────────────────────────────────── */
const ORDER_FIELD = {
  jobs:        "date",
  timeLogs:    "date",
  estimates:   "date",
  mileageLogs: "date",
};

export function createIDB(_APP) {
  return {
    open: () => Promise.resolve(),

    /* ── getAll — carrega documentos do usuário ────────────
       Aplica orderBy e limit quando configurado para a collection.
       Usa cache offline do Firestore automaticamente.
    ────────────────────────────────────────────────────── */
    getAll: async (store) => {
      const uid = auth?.currentUser?.uid;
      if (!uid) return [];

      try {
        const constraints = [where("ownerId", "==", uid)];

        /* Add server-side ordering if field is defined */
        if (ORDER_FIELD[store]) {
          constraints.push(orderBy(ORDER_FIELD[store], "desc"));
        }

        /* Add limit if defined */
        if (COLLECTION_LIMITS[store]) {
          constraints.push(limit(COLLECTION_LIMITS[store]));
        }

        const snap = await getDocs(
          query(collection(db, store), ...constraints)
        );
        return snap.docs.map((d) => toJS(d.data()));
      } catch (err) {
        /* Fallback: query sem orderBy (índice pode não existir ainda) */
        console.warn(`[DB] Ordered query failed for ${store}, falling back:`, err.code);
        const snap = await getDocs(
          query(collection(db, store), where("ownerId", "==", uid))
        );
        return snap.docs.map((d) => toJS(d.data()));
      }
    },

    /* ── getRecent — busca apenas os N mais recentes ───────
       Útil para o dashboard: mostrar últimos 20 jobs sem
       carregar todos os 500.
       Uso: idb.getRecent(APP.stores.jobs, 20)
    ────────────────────────────────────────────────────── */
    getRecent: async (store, n = 20) => {
      const uid = auth?.currentUser?.uid;
      if (!uid) return [];

      const field = ORDER_FIELD[store] || "updatedAt";
      try {
        const snap = await getDocs(
          query(
            collection(db, store),
            where("ownerId", "==", uid),
            orderBy(field, "desc"),
            limit(n),
          )
        );
        return snap.docs.map((d) => toJS(d.data()));
      } catch (err) {
        console.warn(`[DB] getRecent failed for ${store}:`, err.code);
        return [];
      }
    },

    /* ── getByField — busca por campo específico ───────────
       Útil para: timeLogs de um jobId específico,
       jobs de um clientId específico.
       Uso: idb.getByField(APP.stores.timeLogs, "jobId", job.id)
    ────────────────────────────────────────────────────── */
    getByField: async (store, field, value) => {
      const uid = auth?.currentUser?.uid;
      if (!uid) return [];

      try {
        const snap = await getDocs(
          query(
            collection(db, store),
            where("ownerId", "==", uid),
            where(field, "==", value),
          )
        );
        return snap.docs.map((d) => toJS(d.data()));
      } catch (err) {
        console.warn(`[DB] getByField failed for ${store}.${field}:`, err.code);
        return [];
      }
    },

    /* ── getByStatus — busca jobs/estimates por status ─────
       Uso: idb.getByStatus(APP.stores.jobs, "Active")
    ────────────────────────────────────────────────────── */
    getByStatus: async (store, status) => {
      const uid = auth?.currentUser?.uid;
      if (!uid) return [];

      try {
        const snap = await getDocs(
          query(
            collection(db, store),
            where("ownerId", "==", uid),
            where("status", "==", status),
            orderBy(ORDER_FIELD[store] || "updatedAt", "desc"),
          )
        );
        return snap.docs.map((d) => toJS(d.data()));
      } catch (err) {
        console.warn(`[DB] getByStatus failed for ${store}:`, err.code);
        return [];
      }
    },

    /* ── put — salva ou atualiza documento ─────────────────
       Sempre adiciona ownerId, updatedAt, createdAt.
    ────────────────────────────────────────────────────── */
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

    /* ── del — deleta documento ────────────────────────────
    ────────────────────────────────────────────────────── */
    del: async (store, id) => {
      if (!auth?.currentUser?.uid) {
        throw new Error("User not authenticated. Cannot delete data.");
      }
      await deleteDoc(doc(db, store, String(id)));
    },
  };
}
