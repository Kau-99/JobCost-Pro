/* ─── DOM helpers ────────────────────────────────────────── */
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

/* ─── Generators ─────────────────────────────────────────── */
export const uid = () =>
  `id_${Date.now()}_${Math.random().toString(36).slice(2)}`;

/* ─── String / HTML ──────────────────────────────────────── */
export const esc = (v) =>
  String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/* ─── Number / Date formatters ───────────────────────────── */
export const fmt = (n) =>
  Number(n || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });

/* formatCurrency: rounds to 2dp BEFORE localizing — prevents 10.99999 display bugs */
export const formatCurrency = (v) => {
  const n = Math.round((Number(v) || 0) * 100) / 100;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
};

/* safeNum: casts any input to a finite number (0 on failure) */
export const safeNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const fmtDate = (ts) =>
  ts ? new Date(ts).toLocaleDateString("en-US") : "—";

export const fmtDateInput = (ts) => {
  if (!ts) return "";
  const d = new Date(ts);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
};

export const parseDate = (s) => {
  if (!s) return null;
  /* Date-only strings (YYYY-MM-DD) must be treated as local midnight,
     not UTC midnight, so US users don't see dates shifted back one day. */
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, mo, d] = s.split("-").map(Number);
    return new Date(y, mo - 1, d).getTime();
  }
  return new Date(s).getTime();
};

export const fmtDuration = (ms) => {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
};

/* ─── Domain helpers ─────────────────────────────────────── */
export const jobCost = (job) =>
  (job.costs || []).reduce((s, c) => s + (c.qty || 0) * (c.unitCost || 0), 0);

/* ─── LocalStorage wrapper ───────────────────────────────── */
export const ls = (key, defs = {}) => ({
  load: () => {
    try {
      return { ...defs, ...(JSON.parse(localStorage.getItem(key)) || {}) };
    } catch {
      return { ...defs };
    }
  },
  save: (v) => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
      return true;
    } catch (err) {
      console.error("[ls] Failed to save settings:", err);
      return false;
    }
  },
});
