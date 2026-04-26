import { checkSubscription, showSubscriptionWall } from "./subscription.js";
import { APP, T, ATTIC_DEFAULT_BAG_COST } from "./config.js";
import {
  $,
  $$,
  uid,
  esc,
  fmt,
  formatCurrency,
  safeNum,
  fmtDate,
  fmtDateInput,
  parseDate,
  jobCost,
  fmtDuration,
  ls,
} from "./utils.js";
import { createIDB } from "./db.js";
import {
  auth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithGoogle,
  handleRedirectResult,
  logoutUser,
  sendPasswordResetEmail,
} from "./firebase-config.js";

/* Restore demo mode flag after page reload */
if (localStorage.getItem("demoMode") === "1") {
  window.__demoMode = true;
}

/* ─── Translation helper (needs state — lives here) ─────── */
function t(key) {
  const lang = state?.settings?.language ?? "en";
  return T[lang]?.[key] ?? T.en[key] ?? key;
}

/* ─── PWA Install Prompt ─────────────────────── */
let deferredPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = document.getElementById("btnInstallApp");
  if (btn) btn.style.display = "flex";
});

window.addEventListener("appinstalled", () => {
  console.log("JobCost Pro installed successfully.");
  deferredPrompt = null;
  const btn = document.getElementById("btnInstallApp");
  if (btn) btn.style.display = "none";
});

/* iOS Safari: no beforeinstallprompt — show manual instruction banner */
(function showIOSInstallBanner() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.navigator.standalone === true;
  const dismissed = localStorage.getItem("iosBannerDismissed");
  if (!isIOS || isStandalone || dismissed) return;

  const banner = document.createElement("div");
  banner.className = "iosBanner";
  banner.id = "iosBanner";
  banner.innerHTML = `
    <div class="iosBanner__icon">📲</div>
    <div class="iosBanner__body">
      <div class="iosBanner__title">Install JobCost Pro</div>
      <div class="iosBanner__text">
        Tap <span>Share ⬆</span> in Safari, then choose
        <span>"Add to Home Screen"</span> to install the app.
      </div>
    </div>
    <button class="iosBanner__close" id="iosBannerClose" aria-label="Dismiss">✕</button>
  `;
  document.body.appendChild(banner);

  document.getElementById("iosBannerClose").addEventListener("click", () => {
    banner.remove();
    localStorage.setItem("iosBannerDismissed", "1");
  });
})();

/* ─── State ──────────────────────────────────── */
const state = {
  route: "dashboard",
  jobs: [],
  timeLogs: [],
  templates: [],
  clients: [],
  crew: [],
  inventory: [],
  estimates: [],
  settings: ls(APP.lsKey, {
    role: "admin",
    theme: "dark",
    company: "",
    invoicePrefix: "INV",
    invoiceCounter: 1,
    estimateCounter: 1,
    defaultMarkup: 0,
    minMargin: 30,
    monthlyGoal: 0,
    mileageRate: 0.67,
    mpg: 15,
    gasPrice: 3.5,
    notificationsEnabled: false,
    language: "en",
    companyAddress: "",
    companyPhone: "",
    companyEmail: "",
    licenseNumber: "",
    licenseExpiry: null,
    glInsuranceExpiry: null,
    wcExpiry: null,
    logoDataUrl: null,
    googleReviewUrl: "",
    defaultTravelFee: 0,
    travelRatePerMile: 0,
    googleMapsApiKey: "",
    defaultTaxRate: 0,
    estimateValidDays: 30,
    defaultPaymentTerms: "Due upon receipt",
    companyWebsite: "",
  }).load(),
  mileageLogs: [],
  equipment: [],
  pricebook: [],
  materials: [],
  fieldSession: { active: false, data: null },
  search: "",
  sort: { col: "date", dir: "desc" },
  filter: "all",
  tagFilter: "",
  dateFilter: { from: null, to: null },
  liveTimer: null,
};

/* ─── IndexedDB ──────────────────────────────── */
const idb = createIDB(APP);

/* ─── Voice Input (Web Speech API) ─────────────────────── */
function attachVoiceToAll(container) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  container.querySelectorAll("textarea:not([data-no-voice])").forEach((ta) => {
    /* avoid double-attaching if modal is re-rendered */
    if (ta.parentElement.classList.contains("voiceFieldWrap")) return;

    /* Wrap textarea */
    const wrap = document.createElement("div");
    wrap.className = "voiceFieldWrap";
    ta.parentNode.insertBefore(wrap, ta);
    wrap.appendChild(ta);

    const micSVG = `<svg viewBox="0 0 24 24" fill="none" width="16" height="16">
        <rect x="9" y="2" width="6" height="12" rx="3" stroke="currentColor" stroke-width="1.7"/>
        <path d="M5 11a7 7 0 0 0 14 0" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        <line x1="12" y1="18" x2="12" y2="22" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
      </svg>`;

    /* Mic button */
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "voiceMicBtn";
    btn.innerHTML = micSVG;
    wrap.appendChild(btn);

    const isSecure =
      location.protocol === "https:" ||
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1";
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

    if (!SR || !isSecure || isIOS) {
      btn.disabled = true;
      btn.classList.add("voiceMicBtn--disabled");
      btn.title = isIOS
        ? "Voice input not supported on iOS Safari. Use Chrome on Android or desktop."
        : !isSecure
          ? "Voice input requires HTTPS. Open the app from its published URL."
          : "Voice input not supported in this browser. Use Chrome or Edge.";
      btn.setAttribute("aria-label", "Voice input unavailable");
      return;
    }

    btn.title = "Speak to type";
    btn.setAttribute("aria-label", "Voice input");

    const origPlaceholder = ta.placeholder;
    let recognition = null;
    let listening = false;

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      if (listening) {
        recognition?.stop();
        return;
      }

      recognition = new SR();
      recognition.lang =
        state.settings.language === "es"
          ? "es-ES"
          : navigator.language || "en-US";
      recognition.interimResults = true;
      recognition.continuous = true;
      recognition.maxAlternatives = 1;

      let baseText = ta.value;

      recognition.onstart = () => {
        listening = true;
        baseText = ta.value;
        btn.classList.add("voiceMicBtn--active");
        btn.title = "Click to stop";
        ta.placeholder = "🎙 Listening… speak now";
      };

      recognition.onresult = (ev) => {
        let finalChunk = "";
        let interimChunk = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const t = ev.results[i][0].transcript;
          if (ev.results[i].isFinal) finalChunk += t;
          else interimChunk += t;
        }
        if (finalChunk) {
          baseText = baseText
            ? baseText.trimEnd() + " " + finalChunk.trim()
            : finalChunk.trim();
          ta.value = baseText;
          ta.dispatchEvent(new Event("input", { bubbles: true }));
        } else if (interimChunk) {
          ta.value = baseText
            ? baseText.trimEnd() + " " + interimChunk
            : interimChunk;
        }
      };

      const resetVoiceState = () => {
        listening = false;
        btn.classList.remove("voiceMicBtn--active");
        btn.title = "Speak to type";
        ta.placeholder = origPlaceholder;
        ta.value = baseText;
        recognition = null;
      };

      recognition.onerror = (ev) => {
        const permanent = [
          "network",
          "service-not-allowed",
          "audio-capture",
          "language-not-supported",
        ];
        const msgs = {
          "not-allowed": [
            "Microphone blocked",
            "Allow mic access in your browser settings, then try again.",
          ],
          "service-not-allowed": [
            "HTTPS required",
            "Voice input only works when the app is served over HTTPS or localhost.",
          ],
          network: [
            "Voice unavailable",
            "Chrome's speech API requires an active connection to Google's servers. Use the app on its published HTTPS URL in Google Chrome.",
          ],
          "audio-capture": [
            "No microphone",
            "No microphone was found. Plug one in or check device settings.",
          ],
          "language-not-supported": [
            "Language not supported",
            "Try switching the app language to English in Settings.",
          ],
        };
        if (ev.error === "no-speech" || ev.error === "aborted") return;
        const [title, msg] = msgs[ev.error] || [
          "Voice error",
          `Error: ${ev.error}.`,
        ];
        toast.warn(title, msg);
        resetVoiceState();
        if (permanent.includes(ev.error)) {
          btn.disabled = true;
          btn.classList.add("voiceMicBtn--disabled");
          btn.title = title;
        }
      };

      recognition.onend = () => {
        resetVoiceState();
      };

      recognition.start();
    });
  });
}

/* ─── Toast ──────────────────────────────────── */
const toast = (() => {
  function show(type, title, msg, ms = 4200) {
    const c = $("#toasts");
    if (c.children.length >= 4) c.firstChild.remove();
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.innerHTML = `
        <div class="dot"></div>
        <div class="tMain">
          <div class="tTitle">${esc(title)}</div>
          ${msg ? `<div class="tMsg">${esc(msg)}</div>` : ""}
        </div>
        <button type="button" class="tX" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </button>`;
    const kill = () => {
      el.style.opacity = "0";
      el.style.transform = "translateY(8px)";
      setTimeout(() => el.remove(), 200);
    };
    el.querySelector(".tX").addEventListener("click", kill);
    c.appendChild(el);
    if (ms > 0) setTimeout(kill, ms);
  }
  function showAction(type, title, msg, btnLabel, onBtn) {
    const c = $("#toasts");
    if (c.children.length >= 4) c.firstChild.remove();
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.innerHTML = `
        <div class="dot"></div>
        <div class="tMain">
          <div class="tTitle">${esc(title)}</div>
          ${msg ? `<div class="tMsg">${esc(msg)}</div>` : ""}
          <button type="button" class="btn primary" style="margin-top:8px;font-size:12px;padding:4px 12px;">${esc(btnLabel)}</button>
        </div>
        <button type="button" class="tX" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </button>`;
    const kill = () => {
      el.style.opacity = "0";
      el.style.transform = "translateY(8px)";
      setTimeout(() => el.remove(), 200);
    };
    el.querySelector(".tX").addEventListener("click", kill);
    el.querySelector(".btn").addEventListener("click", () => {
      kill();
      onBtn();
    });
    c.appendChild(el);
    /* ms=0 → persists until dismissed */
  }
  return {
    success: (t, m) => show("success", t, m),
    error: (t, m) => show("error", t, m),
    warn: (t, m) => show("warn", t, m),
    info: (t, m) => show("info", t, m),
    action: (t, m, lbl, fn) => showAction("info", t, m, lbl, fn),
  };
})();

/* showToast(message, type) — simple API used throughout the app */
function showToast(message, type = "success") {
  const fn =
    {
      success: toast.success,
      error: toast.error,
      warning: toast.warn,
      warn: toast.warn,
      info: toast.info,
    }[type] || toast.info;
  fn(message, "");
}

/* ─── Modal ──────────────────────────────────── */
const modal = (() => {
  let stack = [];
  const root = () => $("#modalRoot");

  function open(html, onClose) {
    const r = root();
    r.innerHTML = `<div class="modalOverlay"></div><div class="modal">${html}</div>`;
    r.style.pointerEvents = "auto";
    stack.push(onClose || null);
    r.querySelector(".modalOverlay").addEventListener("click", close);
    r.querySelectorAll(".closeX").forEach((x) =>
      x.addEventListener("click", close),
    );
    setTimeout(() => {
      const first = r.querySelector(
        "input:not([type=file]):not([type=date]), select, textarea",
      );
      first?.focus();
    }, 60);
    const modalEl = r.querySelector(".modal");
    attachVoiceToAll(modalEl);
    return modalEl;
  }

  function close() {
    const r = root();
    r.innerHTML = "";
    r.style.pointerEvents = "none";
    stack.pop()?.();
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && stack.length) close();
  });

  return { open, close };
})();

/* ─── Confirm helper ─────────────────────────── */
function confirm(title, body, danger, onOk) {
  const m = modal.open(`
      <div class="modalHd">
        <div><h2>${esc(title)}</h2><p>${esc(body)}</p></div>
        <button type="button" class="closeX" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
      <div class="modalBd"><p class="muted">This action cannot be undone.</p></div>
      <div class="modalFt">
        <button type="button" class="btn" id="cCancel">Cancel</button>
        <button type="button" class="btn danger" id="cOk">${esc(danger)}</button>
      </div>`);
  m.querySelector("#cCancel").addEventListener("click", modal.close);
  m.querySelector("#cOk").addEventListener("click", () => {
    modal.close();
    onOk();
  });
}

/* ── Pending sync check ── */
async function checkPendingSync() {
  if (!navigator.onLine) return;
  try {
    const sw = await navigator.serviceWorker?.ready;
    if (sw) sw.active?.postMessage({ action: "checkSync" });
  } catch { /* silent fail */ }
}

/* ─── Demo Mode helpers ───────────────────────── */
function injectDemoBanner() {
  const banner = document.createElement("div");
  banner.id = "demoBanner";
  banner.innerHTML = `
    <div class="demoBanner__inner">
      <span class="demoBanner__ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></span>
      <span class="demoBanner__text">
        <strong>Explore Mode</strong> — You're viewing demo data. Actions are disabled.
      </span>
      <button class="demoBanner__cta" id="demoUpgradeBtn" type="button">
        Subscribe to Unlock — $19/mo
      </button>
    </div>`;
  document.body.prepend(banner);

  document.getElementById("demoUpgradeBtn").addEventListener("click", () => {
    window.__demoMode = false;
    localStorage.removeItem("demoMode");
    banner.remove();
    showSubscriptionWall(() => {
      window.__demoMode = false;
      init();
    });
  });
}

function demoBlock() {
  if (!window.__demoMode) return false;
  modal.open(`
    <div class="modalHd">
      <div>
        <h2>Subscribe to Use This Feature</h2>
        <p>You're in Explore Mode. Subscribe to unlock all features.</p>
      </div>
      <button type="button" class="closeX" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="modalBd" style="text-align:center;padding:24px 0;">
      <div style="margin-bottom:16px;color:var(--primary);">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="11" width="18" height="11" rx="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>
      <div style="font-size:32px;font-weight:900;letter-spacing:-.02em;margin-bottom:4px;">$19<span style="font-size:16px;font-weight:500;color:var(--muted)">/month</span></div>
      <p style="color:var(--muted);font-size:14px;margin-bottom:0;">Unlimited jobs, clients, crew and more.</p>
    </div>
    <div class="modalFt">
      <button type="button" class="btn" id="demoBlockCancel">Keep Exploring</button>
      <button type="button" class="btn primary" id="demoBlockSubscribe">Subscribe Now</button>
    </div>`);

  document
    .getElementById("demoBlockCancel")
    .addEventListener("click", modal.close);
  document
    .getElementById("demoBlockSubscribe")
    .addEventListener("click", () => {
      modal.close();
      window.__demoMode = false;
      localStorage.removeItem("demoMode");
      document.getElementById("demoBanner")?.remove();
      showSubscriptionWall(() => {
        window.__demoMode = false;
        init();
      });
    });
  return true;
}

/* ─── Boot ───────────────────────────────────── */
async function init() {
  document.body.setAttribute("data-role", state.settings.role);
  applyTheme(state.settings.theme);

  /* ── Demo Mode: load fake data instead of Firestore ── */
  if (window.__demoMode) {
    const { DEMO_DATA } = await import("./demoData.js");
    state.jobs = DEMO_DATA.jobs;
    state.clients = DEMO_DATA.clients;
    state.crew = DEMO_DATA.crew;
    state.timeLogs = DEMO_DATA.timeLogs;
    state.inventory = DEMO_DATA.inventory;
    state.estimates = DEMO_DATA.estimates;
    state.templates = [];
    state.mileageLogs = [];
    state.equipment = [];
    state.pricebook = [];
    state.materials = [];
    bindUI();
    routeTo(location.hash.replace("#", "") || "dashboard", false);
    injectDemoBanner();
    return;
  }

  const wrap = $("#appContent");
  if (wrap)
    wrap.innerHTML = `<div class="loadingPage"><div class="spinner"></div><span>Loading…</span></div>`;
  try {
    await idb.open();
    [
      state.jobs,
      state.timeLogs,
      state.templates,
      state.clients,
      state.crew,
      state.inventory,
      state.estimates,
      state.mileageLogs,
      state.equipment,
      state.pricebook,
      state.materials,
    ] = await Promise.all([
      idb.getAll(APP.stores.jobs),
      idb.getAll(APP.stores.timeLogs),
      idb.getAll(APP.stores.templates),
      idb.getAll(APP.stores.clients),
      idb.getAll(APP.stores.crew),
      idb.getAll(APP.stores.inventory),
      idb.getAll(APP.stores.estimates),
      idb.getAll(APP.stores.mileageLogs),
      idb.getAll(APP.stores.equipment),
      idb.getAll(APP.stores.pricebook),
      idb.getAll(APP.stores.materials),
    ]);
    bindUI();
    /* QR clock-in deep link: ?clockin=JOB_ID */
    const clockinId = new URLSearchParams(location.search).get("clockin");
    if (clockinId && state.jobs.find((j) => j.id === clockinId)) {
      state.fieldSession._pendingJobId = clockinId;
      routeTo("field", false);
    } else {
      routeTo(location.hash.replace("#", "") || "dashboard", false);
    }
    setTimeout(checkDeadlines, 1200);
    setTimeout(checkPendingSync, 3000);
    registerSW();
    /* Pre-load US holidays for current + next year */
    const yr = new Date().getFullYear();
    fetchUSHolidays(yr, (h) => {
      _holidays = h;
    });
    fetchUSHolidays(yr + 1, (h) => {
      _holidays = [..._holidays, ...h];
    });
    /* Request notification permission if previously enabled */
    if (
      state.settings.notificationsEnabled &&
      Notification.permission === "default"
    ) {
      Notification.requestPermission();
    }

    /* ── Welcome message for brand new users (no data yet) ── */
    const isNewUser = !localStorage.getItem("hasSeenWelcome");
    if (isNewUser && state.jobs.length === 0 && !window.__demoMode) {
      localStorage.setItem("hasSeenWelcome", "1");
      setTimeout(() => {
        toast.success(
          "Welcome to JobCost Pro! 🎉",
          "Start by creating your first job. Tap the + New Job button to get started."
        );
      }, 1800);
    }
  } catch (e) {
    console.error(e);
    toast.error("Database error", "Failed to load local data.");
    if (wrap)
      wrap.innerHTML = `<div class="empty">Failed to load. Please reload the page.</div>`;
  }
}

function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .register("sw.js")
    .then((reg) => {
      /* Listen for a new SW found after the page is already controlled */
      reg.addEventListener("updatefound", () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          if (
            newWorker.state === "installed" &&
            navigator.serviceWorker.controller
          ) {
            /* A new version is waiting — prompt the user */
            toast.action(
              "Update available",
              "A new version of the app is ready.",
              "Reload now",
              () => {
                reg.waiting?.postMessage({ action: "skipWaiting" });
              },
            );
          }
        });
      });
    })
    .catch((err) => {
      console.warn(
        "[SW] Registration failed — offline support unavailable.",
        err,
      );
    });

  /* Reload once the new SW takes control */
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!refreshing) {
      refreshing = true;
      window.location.reload();
    }
  });
}

function checkDeadlines() {
  const now = Date.now();
  const soon = now + 3 * 24 * 60 * 60 * 1000;
  const overdue = state.jobs.filter(
    (j) =>
      j.deadline &&
      j.deadline < now &&
      !["Completed", "Invoiced"].includes(j.status),
  );
  const upcoming = state.jobs.filter(
    (j) =>
      j.deadline &&
      j.deadline >= now &&
      j.deadline <= soon &&
      !["Completed", "Invoiced"].includes(j.status),
  );
  if (overdue.length) {
    toast.error(
      "Deadline overdue",
      `${overdue.length} job(s) past their deadline.`,
    );
    pushNotify(
      "JobCost Pro — Overdue",
      `${overdue.length} job(s) past their deadline.`,
    );
  }
  if (upcoming.length) {
    toast.warn("Deadline soon", `${upcoming.length} job(s) due within 3 days.`);
    pushNotify(
      "JobCost Pro — Due Soon",
      `${upcoming.length} job(s) due within 3 days.`,
    );
  }
  /* Warn if any active job's deadline falls on a US federal holiday */
  state.jobs
    .filter((j) => j.deadline && !["Completed", "Invoiced"].includes(j.status))
    .forEach((j) => {
      const hol = isUSHoliday(j.deadline);
      if (hol)
        toast.warn(
          "Deadline on holiday",
          `"${j.name}" deadline falls on ${hol.localName}.`,
        );
    });

  /* Check upcoming inspections (within 30 days) */
  const in30 = now + 30 * 24 * 60 * 60 * 1000;
  state.jobs
    .filter(
      (j) =>
        j.nextInspectionDate &&
        j.nextInspectionDate >= now &&
        j.nextInspectionDate <= in30,
    )
    .forEach((j) => {
      toast.info(
        "Inspection Due",
        `"${j.name}" inspection due ${fmtDate(j.nextInspectionDate)}.`,
      );
    });

  /* Check license / insurance expiry within 60 days */
  const in60 = now + 60 * 24 * 60 * 60 * 1000;
  const s = state.settings;
  if (s.licenseExpiry && s.licenseExpiry >= now && s.licenseExpiry <= in60)
    toast.warn(
      "License Expiring",
      `Contractor license expires ${fmtDate(s.licenseExpiry)}.`,
    );
  if (
    s.glInsuranceExpiry &&
    s.glInsuranceExpiry >= now &&
    s.glInsuranceExpiry <= in60
  )
    toast.warn(
      "Insurance Expiring",
      `General Liability insurance expires ${fmtDate(s.glInsuranceExpiry)}.`,
    );
  if (s.wcExpiry && s.wcExpiry >= now && s.wcExpiry <= in60)
    toast.warn("WC Expiring", `Workers' Comp expires ${fmtDate(s.wcExpiry)}.`);
}

/* ─── State Cleansing (Sprint 37) ────────────────────────── */
function clearUIState() {
  /* Zero every data array — nothing from the previous user stays in RAM */
  state.jobs = [];
  state.timeLogs = [];
  state.templates = [];
  state.clients = [];
  state.crew = [];
  state.inventory = [];
  state.estimates = [];
  state.mileageLogs = [];
  state.equipment = [];
  state.pricebook = [];
  state.materials = [];
  /* Reset UI helpers */
  state.fieldSession = { active: false, data: null };
  state.search = "";
  state.filter = "all";
  state.tagFilter = "";
  state.sort = { col: "date", dir: "desc" };
  /* Stop timers */
  if (state.liveTimer) {
    clearInterval(state.liveTimer);
    state.liveTimer = null;
  }
  /* Close any open modal */
  modal.close();
  /* Wipe rendered content */
  const content = document.getElementById("appContent");
  if (content) content.innerHTML = "";
  const toasts = document.getElementById("toasts");
  if (toasts) toasts.innerHTML = "";
}

function bindUI() {
  /* Nav */
  $$(".navItem").forEach((btn) =>
    btn.addEventListener("click", () => routeTo(btn.dataset.route)),
  );

  /* Sidebar user email */
  const emailEl = document.getElementById("sidebarUserEmail");
  if (emailEl && auth.currentUser) {
    const email =
      auth.currentUser.email || auth.currentUser.displayName || "Signed in";
    emailEl.textContent = email.length > 22 ? email.slice(0, 20) + "…" : email;
    emailEl.title = auth.currentUser.email || "";
  }

  /* Logout */
  document.getElementById("btnLogout")?.addEventListener("click", async () => {
    clearUIState();
    await logoutUser();
    /* onAuthStateChanged(null) fires → auth overlay re-appears automatically */
  });

  /* Theme */
  $("#btnTheme")?.addEventListener("click", () => {
    state.settings.theme = state.settings.theme === "dark" ? "light" : "dark";
    ls(APP.lsKey).save(state.settings);
    applyTheme(state.settings.theme);
  });

  /* Offline / online indicator */
  const offlineEl = document.getElementById("offlineIndicator");
  const setNetworkStatus = () => {
    if (!offlineEl) return;
    const online = navigator.onLine;
    offlineEl.className = `offlineIndicator ${online ? "offlineIndicator--online" : "offlineIndicator--offline"}`;
    offlineEl.title = online ? "Online" : "Offline — changes saved locally";
    offlineEl.setAttribute(
      "aria-label",
      `Connection status: ${online ? "online" : "offline"}`,
    );

    /* ── Offline banner ── */
    const banner = document.getElementById("offlineBanner");
    if (banner) banner.classList.toggle("visible", !online);

    if (!online)
      toast.warn(
        "Working Offline",
        "No internet connection. Jobs, costs and time logs are saved locally and will sync automatically when you reconnect.",
      );
  };
  setNetworkStatus();
  window.addEventListener("online", () => {
    setNetworkStatus();
    setTimeout(() => {
      toast.success(
        "Back online",
        "Connection restored — your data is syncing with the cloud."
      );
      checkPendingSync();
    }, 1500);
  });
  window.addEventListener("offline", setNetworkStatus);

  window.addEventListener("hashchange", () =>
    routeTo(location.hash.replace("#", "") || "dashboard", false),
  );

  /* Mobile sidebar */
  const sidebar = $("#sidebar"),
    overlay = $("#drawerOverlay");
  $("#btnMobileMenu")?.addEventListener("click", () => {
    sidebar.classList.toggle("open");
    overlay.hidden = !overlay.hidden;
  });
  overlay?.addEventListener("click", () => {
    sidebar.classList.remove("open");
    overlay.hidden = true;
  });

  /* Topbar actions */
  $("#btnNewJob")?.addEventListener("click", () => {
    if (demoBlock()) return;
    openJobModal(null);
  });
  $("#btnNewTemplate")?.addEventListener("click", () => {
    if (demoBlock()) return;
    openTemplateModal(null);
  });
  $("#btnExportAll")?.addEventListener("click", () => {
    if (demoBlock()) return;
    doExport();
  });

  /* Search */
  const si = $("#globalSearch"),
    cl = $("#btnClearSearch");
  cl.hidden = true;
  let searchDebounce = null;
  si?.addEventListener("input", () => {
    cl.hidden = !si.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.search = si.value.trim().toLowerCase();
      if (["jobs", "dashboard"].includes(state.route)) render();
    }, 300);
  });
  cl?.addEventListener("click", () => {
    si.value = "";
    state.search = "";
    cl.hidden = true;
    si.focus();
    render();
  });

  /* Keyboard shortcuts */
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "k") {
      e.preventDefault();
      si?.focus();
    }
    if (
      (e.ctrlKey || e.metaKey) &&
      e.key === "n" &&
      !$("#modalRoot").children.length
    ) {
      e.preventDefault();
      openJobModal(null);
    }
  });
}

function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
}

function routeTo(route, push = true) {
  const valid = [
    "dashboard",
    "jobs",
    "clients",
    "field",
    "views",
    "settings",
    "templates",
    "estimates",
    "crew",
    "inventory",
    "kanban",
    "calendar",
  ];
  state.route = valid.includes(route) ? route : "dashboard";
  if (
    state.settings.role === "field" &&
    !["dashboard", "field"].includes(state.route)
  ) {
    state.route = "field";
  }
  if (push) location.hash = state.route;
  $$(".navItem").forEach((btn) =>
    btn.setAttribute(
      "aria-current",
      btn.dataset.route === state.route ? "page" : "false",
    ),
  );
  /* Clean up live timer when leaving field */
  if (state.liveTimer) {
    clearInterval(state.liveTimer);
    state.liveTimer = null;
  }

  /* ── Dynamic page title ── */
  const pageTitles = {
    dashboard: "Dashboard", jobs: "Jobs", clients: "Clients",
    field: "Field", views: "Analytics", settings: "Settings",
    templates: "Templates", estimates: "Estimates", crew: "Crew",
    inventory: "Inventory", kanban: "Pipeline", calendar: "Calendar",
  };
  document.title = `${pageTitles[state.route] || "Dashboard"} — JobCost Pro`;

  render();
}

function render() {
  const wrap = $("#appContent");
  if (!wrap) return;
  wrap.innerHTML = "";
  wrap.scrollTop = 0;
  window.scrollTo(0, 0);
  const views = {
    dashboard: renderDashboard,
    jobs: renderJobs,
    clients: renderClients,
    templates: renderTemplates,
    field: renderFieldApp,
    views: renderBI,
    settings: renderSettings,
    estimates: renderEstimates,
    crew: renderCrew,
    inventory: renderInventory,
    kanban: renderKanban,
    calendar: renderCalendar,
  };
  (views[state.route] || renderDashboard)(wrap);
}

/* ─── Export JSON backup ─────────────────────── */
function doExport() {
  const data = {
    _v: 2,
    _exported: Date.now(),
    jobs: state.jobs,
    timeLogs: state.timeLogs,
    templates: state.templates,
    estimates: state.estimates,
    clients: state.clients,
    crew: state.crew,
    inventory: state.inventory,
    mileageLogs: state.mileageLogs,
    equipment: state.equipment,
    settings: state.settings,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `jobcost_backup_${Date.now()}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
  toast.success(
    "Backup exported",
    `${state.jobs.length} jobs · ${state.clients.length} clients · settings included.`,
  );
}

/* ─── CSV Export ─────────────────────────────── */
function exportCSV() {
  if (!state.jobs.length) {
    toast.warn("No data", "No jobs to export.");
    return;
  }
  const rows = [
    [
      "Job Name",
      "Client",
      "Status",
      "Tags",
      "Est. Value",
      "Total Cost",
      "Margin",
      "Margin %",
      "Mileage",
      "Miles Deduction",
      "Payment Status",
      "Paid Date",
      "Invoice #",
      "Start Date",
      "Deadline",
      "Created",
      "Hours",
      "Notes",
    ],
  ];
  state.jobs.forEach((j) => {
    const tc = jobCost(j);
    const margin = (j.value || 0) - tc;
    const pct = j.value ? ((margin / j.value) * 100).toFixed(1) : "";
    const hrs = state.timeLogs
      .filter((l) => l.jobId === j.id)
      .reduce((s, l) => s + (l.hours || 0), 0);
    const milesDeduction = (
      (j.mileage || 0) * (state.settings.mileageRate || 0.67)
    ).toFixed(2);
    rows.push([
      j.name,
      j.client || "",
      j.status,
      (j.tags || []).join("; "),
      (j.value || 0).toFixed(2),
      tc.toFixed(2),
      margin.toFixed(2),
      pct,
      j.mileage || 0,
      milesDeduction,
      j.paymentStatus || "Unpaid",
      j.paidDate ? fmtDate(j.paidDate) : "",
      j.invoiceNumber || "",
      j.startDate ? fmtDate(j.startDate) : "",
      j.deadline ? fmtDate(j.deadline) : "",
      fmtDate(j.date),
      hrs.toFixed(2),
      String(j.notes || "").replace(/"/g, '""'),
    ]);
  });
  const csv = rows.map((r) => r.map((v) => `"${v}"`).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `jobcost_export_${Date.now()}.csv`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
  toast.success("CSV exported", `${state.jobs.length} jobs.`);
}

/* ─── Invoice Number ─────────────────────────── */
function getNextInvoiceNumber() {
  const yr = new Date().getFullYear();
  const prefix = state.settings.invoicePrefix || "INV";
  const n = String(state.settings.invoiceCounter || 1).padStart(4, "0");
  state.settings.invoiceCounter = (state.settings.invoiceCounter || 1) + 1;
  ls(APP.lsKey).save(state.settings);
  return `${prefix}-${yr}-${n}`;
}

function getNextInvoiceNumberPreview() {
  const yr = new Date().getFullYear();
  const prefix = state.settings.invoicePrefix || "INV";
  const n = String(state.settings.invoiceCounter || 1).padStart(4, "0");
  return `${prefix}-${yr}-${n}`;
}

function getNextEstimateNumber() {
  const yr = new Date().getFullYear();
  const n = String(state.settings.estimateCounter || 1).padStart(4, "0");
  state.settings.estimateCounter = (state.settings.estimateCounter || 1) + 1;
  ls(APP.lsKey).save(state.settings);
  return `EST-${yr}-${n}`;
}

/* ─── QR Code Clock-In ───────────────────────── */
function showQRModal(job) {
  const base = location.href.split("?")[0].split("#")[0];
  const url = `${base}?clockin=${job.id}`;
  const m = modal.open(`
      <div class="modalHd">
        <div><h2>Clock-In QR Code</h2><p>${esc(job.name)}</p></div>
        <button type="button" class="closeX" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modalBd" style="display:flex;flex-direction:column;align-items:center;gap:14px;padding:24px 16px;">
        <canvas id="qrCanvas"></canvas>
        <p id="qrCanvasMsg" class="small muted" style="text-align:center;max-width:280px;">Field worker scans this to open the app and clock into <strong>${esc(job.name)}</strong> directly.</p>
        <button class="btn" id="btnCopyQR">Copy Link</button>
      </div>
      <div class="modalFt"><button class="btn" id="bjQRClose">Close</button></div>`);
  setTimeout(() => {
    const canvas = document.getElementById("qrCanvas");
    const msg = document.getElementById("qrCanvasMsg");
    if (!canvas) return;
    if (!window.QRCode) {
      if (msg)
        msg.textContent =
          "QR library not loaded. Check your connection and try again.";
      return;
    }
    QRCode.toCanvas(canvas, url, { width: 220, margin: 2 }, (err) => {
      if (err && msg) msg.textContent = "Could not generate QR code.";
    });
  }, 80);
  m.querySelector("#btnCopyQR").addEventListener("click", () => {
    navigator.clipboard
      ?.writeText(url)
      .then(() => toast.info("Copied", "Clock-in link copied."))
      .catch(() => toast.warn("Copy failed", "Use the link manually: " + url));
  });
  m.querySelector("#bjQRClose").addEventListener("click", modal.close);
}

/* ─── QR Code Job Share ──────────────────────── */
function showJobShareQR(job) {
  /* Slim payload — no photos/timeLogs to stay within QR capacity (~2KB) */
  let payload;
  try {
    const slim = {
      _v: 1,
      id: job.id,
      name: job.name,
      client: job.client || "",
      status: job.status,
      value: job.value || 0,
      date: job.date,
      zip: job.zip || "",
      city: job.city || "",
      state: job.state || "",
      notes: (job.notes || "").slice(0, 200),
      tags: job.tags || [],
      costs: (job.costs || []).slice(0, 15).map((c) => ({
        d: c.description || "",
        q: Number(c.qty) || 0,
        u: Number(c.unitCost) || 0,
        cat: c.category || "",
      })),
    };
    payload = JSON.stringify(slim);
  } catch {
    toast.error("QR Error", "Could not serialize job data.");
    return;
  }

  const m = modal.open(`
    <div class="modalHd">
      <div><h2>Share Job via QR</h2><p>${esc(job.name)}</p></div>
      <button type="button" class="closeX" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="modalBd" style="display:flex;flex-direction:column;align-items:center;gap:14px;padding:24px 16px;">
      <div id="shareQRWrap" style="display:flex;align-items:center;justify-content:center;min-height:60px;">
        <canvas id="shareQRCanvas"></canvas>
      </div>
      <p class="small muted" style="text-align:center;max-width:300px;">
        Scan with another device running JobCost Pro to import this job.<br>
        <span style="font-size:11px;">Photos &amp; time logs are not included to keep the QR scannable.</span>
      </p>
      <div style="display:flex;gap:8px;">
        <button class="btn" id="btnDlShareQR">⬇ Download PNG</button>
      </div>
    </div>
    <div class="modalFt"><button class="btn closeX">Close</button></div>`);

  setTimeout(() => {
    const canvas = document.getElementById("shareQRCanvas");
    const wrap = document.getElementById("shareQRWrap");
    if (!canvas || !wrap) return;
    if (!window.QRCode) {
      wrap.innerHTML = `<p class="small muted" style="color:#ff5a7a;">QR library not loaded. Check your connection and try again.</p>`;
      return;
    }
    QRCode.toCanvas(
      canvas,
      payload,
      { width: 240, margin: 2, errorCorrectionLevel: "M" },
      (err) => {
        if (err) {
          wrap.innerHTML = `<p class="small" style="color:#ff5a7a;">Job data too large for QR. Try reducing the number of cost items or shortening the notes.</p>`;
        }
      },
    );
  }, 80);

  m.querySelector("#btnDlShareQR")?.addEventListener("click", () => {
    const canvas = document.getElementById("shareQRCanvas");
    if (!canvas || !canvas.width) {
      toast.warn("Not ready", "Wait for the QR code to finish generating.");
      return;
    }
    const a = document.createElement("a");
    a.download = `job_${job.name.replace(/[^a-z0-9]/gi, "_").slice(0, 30)}_QR.png`;
    a.href = canvas.toDataURL("image/png");
    a.click();
  });
}

/* ─── QR Scanner ─────────────────────────────── */
function openQRScanner() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast.warn(
      "Camera unavailable",
      "Camera access requires HTTPS and a supported browser.",
    );
    return;
  }

  let stream = null;
  let rafId = null;
  let cameraTimeout = null;

  const stopScan = () => {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (cameraTimeout) {
      clearTimeout(cameraTimeout);
      cameraTimeout = null;
    }
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  };

  const m = modal.open(
    `
    <div class="modalHd">
      <div><h2>📷 Scan Job QR</h2><p>Point camera at a JobCost Pro Share QR code.</p></div>
      <button type="button" class="closeX" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="modalBd" style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:16px;">
      <div style="position:relative;width:100%;max-width:320px;">
        <video id="qrVideo" autoplay playsinline muted style="width:100%;border-radius:10px;background:#000;"></video>
        <canvas id="qrScanCanvas" style="display:none;"></canvas>
        <div style="position:absolute;inset:0;border:2px solid var(--primary);border-radius:10px;pointer-events:none;"></div>
      </div>
      <p id="qrScanStatus" class="small muted">Initializing camera…</p>
    </div>
    <div class="modalFt"><button class="btn closeX" id="btnQRScanClose">Cancel</button></div>`,
    stopScan,
  );

  const statusEl = document.getElementById("qrScanStatus");
  const video = document.getElementById("qrVideo");
  const scanCanvas = document.getElementById("qrScanCanvas");

  const setStatus = (msg, isError = false) => {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color = isError ? "#ff5a7a" : "";
  };

  if (!video || !scanCanvas) {
    setStatus("Scanner failed to initialize.", true);
    return;
  }

  /* ── Detect best available scanner engine ── */
  let useBarcode = false;
  let detector = null;
  if ("BarcodeDetector" in window) {
    try {
      detector = new BarcodeDetector({ formats: ["qr_code"] });
      useBarcode = true;
    } catch {
      /* BarcodeDetector constructor failed — fall through to jsQR */
    }
  }
  const hasJsQR = typeof window.jsQR === "function";

  if (!useBarcode && !hasJsQR) {
    setStatus(
      "QR scanning library not loaded. Check your connection and try again.",
      true,
    );
    return;
  }

  const handlePayload = (data) => {
    stopScan();
    try {
      const obj = JSON.parse(data);
      if (obj._v !== 1 || !obj.id || !obj.name) {
        toast.error("Invalid QR", "This QR code is not a JobCost Pro job.");
        modal.close();
        return;
      }
      const imported = {
        id: obj.id,
        name: obj.name,
        client: obj.client || "",
        status: obj.status || "Lead",
        value: Number(obj.value) || 0,
        date: obj.date || Date.now(),
        zip: obj.zip || "",
        city: obj.city || "",
        state: obj.state || "",
        notes: obj.notes || "",
        tags: Array.isArray(obj.tags) ? obj.tags : [],
        costs: (obj.costs || []).map((c) => ({
          id: uid(),
          description: c.d || "",
          qty: Number(c.q) || 0,
          unitCost: Number(c.u) || 0,
          category: c.cat || "",
        })),
        photos: [],
        crewIds: [],
        paymentStatus: "Unpaid",
        paidDate: null,
        invoiceNumber: null,
        _importedViaQR: true,
      };
      if (state.jobs.find((j) => j.id === imported.id)) {
        toast.info(
          "Already exists",
          `"${imported.name}" is already in your jobs.`,
        );
        modal.close();
        return;
      }
      saveJob(imported)
        .then(() => {
          toast.success("Job imported!", imported.name);
          modal.close();
          render();
        })
        .catch(() => {
          toast.error("Import failed", "Could not save the imported job.");
          modal.close();
        });
    } catch {
      toast.error("Scan error", "Could not parse QR data.");
      modal.close();
    }
  };

  /* ── 15-second timeout if camera never starts ── */
  cameraTimeout = setTimeout(() => {
    if (!stream) {
      setStatus(
        "Camera did not start. Allow camera permission and try again.",
        true,
      );
    }
  }, 15000);

  navigator.mediaDevices
    .getUserMedia({ video: { facingMode: "environment" }, audio: false })
    .then((s) => {
      clearTimeout(cameraTimeout);
      cameraTimeout = null;
      stream = s;
      video.srcObject = s;
      setStatus(useBarcode ? "Scanning…" : "Scanning… (jsQR fallback)");

      const tick = async () => {
        if (!stream) return; /* modal was closed */
        if (!video.videoWidth) {
          rafId = requestAnimationFrame(tick);
          return;
        }

        scanCanvas.width = video.videoWidth;
        scanCanvas.height = video.videoHeight;
        const ctx = scanCanvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(video, 0, 0);

        try {
          if (useBarcode) {
            const results = await detector.detect(video);
            if (results.length) {
              handlePayload(results[0].rawValue);
              return;
            }
          } else {
            const img = ctx.getImageData(
              0,
              0,
              scanCanvas.width,
              scanCanvas.height,
            );
            const code = window.jsQR(img.data, img.width, img.height, {
              inversionAttempts: "dontInvert",
            });
            if (code) {
              handlePayload(code.data);
              return;
            }
          }
        } catch (err) {
          /* BarcodeDetector may fail on some frames — fall back to jsQR silently */
          if (useBarcode && hasJsQR) {
            useBarcode = false;
            setStatus("Scanning… (jsQR fallback)");
          } else {
            console.warn("[QR] Scan frame error:", err);
          }
        }
        rafId = requestAnimationFrame(tick);
      };

      video.onloadedmetadata = () => {
        rafId = requestAnimationFrame(tick);
      };
    })
    .catch((err) => {
      clearTimeout(cameraTimeout);
      const msg =
        err?.name === "NotAllowedError"
          ? "Camera permission denied. Allow camera access in your browser settings."
          : err?.name === "NotFoundError"
            ? "No camera found on this device."
            : "Camera access failed. Try again.";
      setStatus(msg, true);
    });
}

/* ─── Save Client ─────────────────────────────── */
async function saveClient(client) {
  if (demoBlock()) return;
  await idb.put(APP.stores.clients, client);
  const i = state.clients.findIndex((c) => c.id === client.id);
  if (i !== -1) state.clients[i] = client;
  else state.clients.push(client);
}

async function saveEstimate(est) {
  if (demoBlock()) return;
  await idb.put(APP.stores.estimates, est);
  const i = state.estimates.findIndex((e) => e.id === est.id);
  if (i !== -1) state.estimates[i] = est;
  else state.estimates.push(est);
}

async function saveCrewMember(member) {
  if (demoBlock()) return;
  await idb.put(APP.stores.crew, member);
  const i = state.crew.findIndex((c) => c.id === member.id);
  if (i !== -1) state.crew[i] = member;
  else state.crew.push(member);
}

async function saveInventoryItem(item) {
  if (demoBlock()) return;
  await idb.put(APP.stores.inventory, item);
  const i = state.inventory.findIndex((x) => x.id === item.id);
  if (i !== -1) state.inventory[i] = item;
  else state.inventory.push(item);
}

async function saveEquipment(item) {
  if (demoBlock()) return;
  await idb.put(APP.stores.equipment, item);
  const i = state.equipment.findIndex((x) => x.id === item.id);
  if (i !== -1) state.equipment[i] = item;
  else state.equipment.push(item);
}

async function savePricebookItem(item) {
  if (demoBlock()) return;
  await idb.put(APP.stores.pricebook, item);
  const i = state.pricebook.findIndex((x) => x.id === item.id);
  if (i !== -1) state.pricebook[i] = item;
  else state.pricebook.push(item);
}

async function deletePricebookItem(id) {
  if (demoBlock()) return;
  await idb.del(APP.stores.pricebook, id);
  state.pricebook = state.pricebook.filter((x) => x.id !== id);
}

async function saveMaterial(item) {
  if (demoBlock()) return;
  await idb.put(APP.stores.materials, item);
  const i = state.materials.findIndex((x) => x.id === item.id);
  if (i !== -1) state.materials[i] = item;
  else state.materials.push(item);
}
async function deleteMaterial(id) {
  if (demoBlock()) return;
  await idb.del(APP.stores.materials, id);
  state.materials = state.materials.filter((x) => x.id !== id);
}

/* ─── Push Notification helper ───────────────── */
function pushNotify(title, body) {
  if (!state.settings.notificationsEnabled) return;
  if (Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

/* ═══════════════════════════════════════════════════════
   PDF ENGINE — shared by every export function
   ═══════════════════════════════════════════════════════ */
function _pdf(docType, docId, opts = {}) {
  if (!window.jspdf) {
    toast.error("PDF Error", "jsPDF not loaded.");
    return null;
  }
  if (!window.jspdf.jsPDF.prototype.autoTable) {
    toast.error("PDF Error", "AutoTable plugin not loaded.");
    return null;
  }
  const { jsPDF } = window.jspdf;
  const isLand = !!opts.landscape;
  const doc = new jsPDF(isLand ? { orientation: "landscape" } : {});
  const LM = 20;
  const RM = isLand ? 277 : 190;
  const PW = RM - LM;
  const FY = 272;
  const s = state.settings;
  const co = s.company || "Your Company";

  /* ── Universal Footer (called on every page by autoTable didDrawPage) ── */
  function drawFooter() {
    const n = doc.internal.getCurrentPageInfo().pageNumber;
    doc.setFillColor(18, 18, 18);
    doc.rect(0, FY, isLand ? 297 : 210, 25, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(7.5);
    doc.setFont("helvetica", "normal");
    const ftxt =
      [
        co,
        s.companyPhone,
        s.companyEmail,
        s.licenseNumber ? `Lic: ${s.licenseNumber}` : null,
      ]
        .filter(Boolean)
        .join("  ·  ") || "JobCost Pro — Valid for 30 days";
    doc.text(ftxt, (isLand ? 297 : 210) / 2, FY + 8, { align: "center" });
    doc.text(`Page ${n}`, RM, FY + 8, { align: "right" });
    doc.setTextColor(0);
  }

  /* ── Logo helper — auto-detects PNG vs JPEG ── */
  function addLogo(x, y, w, h) {
    if (!s.logoDataUrl) return;
    try {
      const fmt = s.logoDataUrl.startsWith("data:image/png") ? "PNG" : "JPEG";
      doc.addImage(s.logoDataUrl, fmt, x, y, w, h);
    } catch (err) {
      console.warn("[PDF] Logo render failed:", err);
    }
  }

  /* ── Universal Header bar ── */
  doc.setFillColor(18, 18, 18);
  doc.rect(0, 0, isLand ? 297 : 210, 38, "F");
  addLogo(LM, 5, 26, 26);
  const hx = s.logoDataUrl ? LM + 30 : LM;
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(co, hx, 18);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  [
    s.companyAddress,
    s.companyPhone ? `Tel: ${s.companyPhone}` : null,
    s.companyEmail,
  ]
    .filter(Boolean)
    .forEach((l, i) => doc.text(l, hx, 25 + i * 5));
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.text(docType, RM, 20, { align: "right" });
  if (docId) {
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.text(`#${String(docId)}`, RM, 28, { align: "right" });
  }
  if (s.licenseNumber) {
    doc.setFontSize(7.5);
    doc.text(`Lic: ${s.licenseNumber}`, RM, 34, { align: "right" });
  }
  doc.setTextColor(0);

  /* ── AutoTable wrapper — positions dynamically, no fixed y ── */
  function tbl(head, body, startY, colStyles = {}) {
    doc.autoTable({
      startY,
      head: [head],
      body,
      theme: "plain",
      styles: {
        font: "helvetica",
        fontSize: 8.5,
        cellPadding: 2.8,
        textColor: [0, 0, 0],
        lineColor: [210, 210, 210],
        lineWidth: 0.2,
      },
      headStyles: {
        fillColor: [30, 30, 30],
        textColor: [255, 255, 255],
        fontStyle: "bold",
        fontSize: 8,
        cellPadding: 3,
      },
      alternateRowStyles: { fillColor: [247, 247, 247] },
      columnStyles: colStyles,
      margin: { left: LM, right: isLand ? 17 : 20 },
      didDrawPage: drawFooter,
    });
    return doc.lastAutoTable.finalY;
  }

  /* ── Info label block ── */
  function infoBlock(title, lines, x, y) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(130);
    doc.text(title.toUpperCase(), x, y);
    doc.setTextColor(0);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    let cy = y + 6;
    lines
      .filter((v) => v != null && String(v).trim() !== "")
      .forEach((l) => {
        doc.text(String(l), x, cy);
        cy += 5;
      });
    return cy;
  }

  /* ── Section title with rule ── */
  function section(text, y) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(0);
    doc.text(text, LM, y);
    doc.setDrawColor(180);
    doc.setLineWidth(0.3);
    doc.line(LM, y + 2, RM, y + 2);
    doc.setLineWidth(0.5);
    return y + 9;
  }

  /* ── Totals block (right-aligned, below finalY) ── */
  function totals(rows, y) {
    rows.forEach(([lbl, val, bold]) => {
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setFontSize(bold ? 11 : 9);
      if (bold) {
        doc.setFillColor(18, 18, 18);
        doc.rect(LM + PW * 0.55, y - 5, PW * 0.45, 8, "F");
        doc.setTextColor(255, 255, 255);
      }
      doc.text(lbl, RM - 38, y, { align: "right" });
      doc.text(val, RM, y, { align: "right" });
      if (bold) doc.setTextColor(0);
      y += bold ? 10 : 6;
    });
    return y;
  }

  /* ── Save helper ── */
  function save(filename) {
    drawFooter();
    showToast("PDF Downloaded! ✓", "success");
    doc.save(filename);
  }

  return {
    doc,
    tbl,
    drawFooter,
    infoBlock,
    section,
    totals,
    save,
    LM,
    RM,
    PW,
    FY,
    s,
    co,
  };
}

/* ─── PDF: Job Report ───────────────────────── */
function exportJobPDF(job) {
  const e = _pdf("JOB REPORT", job.name);
  if (!e) return;
  const { doc, tbl, infoBlock, section, totals, save, LM, RM } = e;
  let y = 46;

  /* Info block */
  y = infoBlock("Job", [job.name], LM, y);
  y = Math.max(y, infoBlock("Client", [job.client || "N/A"], LM + 90, 46));
  y += 4;

  /* Job details grid */
  const details = [
    ["Status", job.status || "N/A"],
    ["Created", fmtDate(job.date)],
    ["Start Date", job.startDate ? fmtDate(job.startDate) : "N/A"],
    ["Deadline", job.deadline ? fmtDate(job.deadline) : "N/A"],
    ["Est. Value", formatCurrency(job.value || 0)],
    ["Est. Hours", job.estimatedHours ? `${job.estimatedHours}h` : "N/A"],
  ];
  const realHrs = state.timeLogs
    .filter((l) => l.jobId === job.id)
    .reduce((s, l) => s + (l.hours || 0), 0);
  if (realHrs > 0) details.push(["Actual Hours", `${realHrs.toFixed(2)}h`]);
  if (job.notes) details.push(["Notes", job.notes.slice(0, 80)]);

  y = tbl(
    ["Field", "Value"],
    details.map((r) => r),
    y,
    { 0: { cellWidth: 45, fontStyle: "bold" }, 1: { cellWidth: PW - 45 } },
  );
  y += 8;

  /* Costs table */
  const costs = job.costs || [];
  if (costs.length) {
    y = section("Cost Breakdown", y);
    const tc = jobCost(job);
    y = tbl(
      ["Description", "Category", "Qty", "Unit Cost", "Line Total"],
      costs.map((c) => [
        c.name || c.description || "N/A",
        c.category || "—",
        c.qty || 0,
        formatCurrency(c.unitCost),
        formatCurrency((c.qty || 0) * (c.unitCost || 0)),
      ]),
      y,
      {
        0: { cellWidth: 60 },
        1: { cellWidth: 38 },
        2: { cellWidth: 18, halign: "right" },
        3: { cellWidth: 38, halign: "right" },
        4: { cellWidth: 36, halign: "right" },
      },
    );
    y += 4;
    const margin = (job.value || 0) - tc;
    const pct = job.value ? ((margin / job.value) * 100).toFixed(1) : "N/A";
    y = totals(
      [
        ["Total Cost:", formatCurrency(tc), false],
        ["Est. Value:", formatCurrency(job.value || 0), false],
        [`Profit / Loss (${pct}%):`, formatCurrency(margin), true],
      ],
      y,
    );
  }

  /* Time logs table */
  const logs = state.timeLogs
    .filter((l) => l.jobId === job.id)
    .sort((a, b) => b.date - a.date);
  if (logs.length) {
    y = section("Time Logs", y + 4);
    y = tbl(
      ["Date", "Hours", "Note"],
      logs.map((l) => [
        fmtDate(l.date),
        `${(l.hours || 0).toFixed(2)}h`,
        l.note || "—",
      ]),
      y,
      {
        0: { cellWidth: 38 },
        1: { cellWidth: 22, halign: "right" },
        2: { cellWidth: PW - 60 },
      },
    );
    const totalHrs = logs.reduce((s, l) => s + (l.hours || 0), 0);
    y += 4;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text(`Total Hours: ${totalHrs.toFixed(2)}h`, RM, y, { align: "right" });
  }

  save(`${job.name.replace(/[^a-z0-9]/gi, "_").slice(0, 48)}_report.pdf`);
}

/* ─── PDF: Full Report ───────────────────────── */
function exportAllPDF() {
  if (!state.jobs.length) {
    toast.warn("No data", "No jobs to export.");
    return;
  }
  const e = _pdf("FULL REPORT", fmtDate(Date.now()), { landscape: true });
  if (!e) return;
  const { tbl, infoBlock, totals, save, LM, RM, PW, s } = e;
  let y = 46;

  const totalVal = state.jobs.reduce((s, j) => s + (j.value || 0), 0);
  const totalCost = state.jobs.reduce((s, j) => s + jobCost(j), 0);
  const totalHrs = state.timeLogs.reduce((s, l) => s + (l.hours || 0), 0);

  infoBlock(
    "Summary",
    [
      `Jobs: ${state.jobs.length}`,
      `Total Value: ${formatCurrency(totalVal)}`,
      `Total Cost: ${formatCurrency(totalCost)}`,
      `Hours Logged: ${totalHrs.toFixed(1)}h`,
    ],
    LM,
    y,
  );
  y += 42;

  y = tbl(
    [
      "Job Name",
      "Client",
      "Status",
      "Est. Value",
      "Total Cost",
      "Margin",
      "Deadline",
    ],
    [...state.jobs]
      .sort((a, b) => b.date - a.date)
      .map((j) => {
        const tc = jobCost(j),
          m = (j.value || 0) - tc;
        return [
          j.name.length > 38 ? j.name.slice(0, 37) + "…" : j.name,
          (j.client || "—").length > 28 ? (j.client || "—").slice(0, 27) + "…" : (j.client || "—"),
          j.status,
          formatCurrency(j.value),
          formatCurrency(tc),
          formatCurrency(m),
          j.deadline ? fmtDate(j.deadline) : "—",
        ];
      }),
    y,
    {
      0: { cellWidth: 60 },
      1: { cellWidth: 48 },
      2: { cellWidth: 26 },
      3: { cellWidth: 34, halign: "right" },
      4: { cellWidth: 34, halign: "right" },
      5: { cellWidth: 34, halign: "right" },
      6: { cellWidth: 24 },
    },
  );

  save(`jobcost_full_report_${Date.now()}.pdf`);
}

/* ─── PDF: Invoice (Professional) ───────────── */
function exportInvoicePDF(job) {
  const e = _pdf("INVOICE", job.invoiceNumber || "TBD");
  if (!e) return;
  const { doc, tbl, infoBlock, section, totals, save, LM, RM, PW, s } = e;
  let y = 46;

  /* Bill To + Invoice meta */
  infoBlock(
    "BILL TO",
    [
      job.client || "N/A",
      [job.city, job.state, job.zip].filter(Boolean).join(", ") || "N/A",
      job.phone ? `Tel: ${job.phone}` : null,
      job.email || null,
    ],
    LM,
    y,
  );
  infoBlock(
    "INVOICE DETAILS",
    [
      `Date: ${fmtDate(Date.now())}`,
      `Invoice #: ${job.invoiceNumber || "TBD"}`,
      `Ref: ${job.name.slice(0, 38)}`,
      `Due: Upon receipt`,
    ],
    LM + 100,
    y,
  );
  y += 46;

  /* Job spec row */
  const spec = [
    job.insulationType,
    job.areaType,
    job.sqft ? `${job.sqft} sq ft` : null,
    job.rValueAchieved ? `R-${job.rValueAchieved}` : null,
  ]
    .filter(Boolean)
    .join("  ·  ");
  if (spec) {
    y = section("Job Details", y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(spec, LM, y);
    y += 8;
  }

  /* Costs table */
  const costs = job.costs || [];
  if (costs.length) {
    y = section("Itemized Services", y);
    let subtotal = 0;
    y = tbl(
      ["Description", "Category", "Qty", "Unit Price", "Total"],
      costs.map((c) => {
        const ct = (c.qty || 0) * (c.unitCost || 0);
        subtotal += ct;
        return [
          c.name || c.description || "N/A",
          c.category || "—",
          c.qty || 0,
          formatCurrency(c.unitCost),
          formatCurrency(ct),
        ];
      }),
      y,
      {
        0: { cellWidth: 62 },
        1: { cellWidth: 38 },
        2: { cellWidth: 18, halign: "right" },
        3: { cellWidth: 34, halign: "right" },
        4: { cellWidth: 38, halign: "right" },
      },
    );
    const markup =
      job.value && subtotal ? Math.max(0, job.value - subtotal) : 0;
    const taxRate = job.taxRate || 0;
    const taxAmt = (subtotal + markup) * (taxRate / 100);
    const grand = subtotal + markup + taxAmt;
    const totRows = [["Subtotal:", formatCurrency(subtotal), false]];
    if (markup > 0)
      totRows.push(["Service Fee:", formatCurrency(markup), false]);
    if (taxRate > 0)
      totRows.push([`Tax (${taxRate}%):`, formatCurrency(taxAmt), false]);
    totRows.push(["TOTAL DUE:", formatCurrency(grand), true]);
    y = totals(totRows, y + 6);
  } else {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text("Services rendered as agreed.", LM, y);
    y += 14;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text(`TOTAL DUE: ${formatCurrency(job.value || 0)}`, RM, y, {
      align: "right",
    });
    y += 12;
  }

  /* Payment terms */
  y += 6;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text("Payment Terms: ", LM, y);
  doc.setFont("helvetica", "normal");
  doc.text("Due upon receipt · Check / Zelle / Venmo accepted", LM + 34, y);
  y += 8;

  if (job.notes) {
    y = section("Notes", y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc
      .splitTextToSize(job.notes, PW)
      .slice(0, 6)
      .forEach((l) => {
        doc.text(l, LM, y);
        y += 5;
      });
  }

  save(`invoice_${job.name.replace(/[^a-z0-9]/gi, "_").slice(0, 40)}.pdf`);
}

/* ─── PDF: Work Order / Dispatch Sheet ──────── */
function exportWorkOrderPDF(job) {
  const e = _pdf("WORK ORDER", job.name);
  if (!e) return;
  const { doc, tbl, infoBlock, section, save, LM, RM, PW, s } = e;
  let y = 46;

  /* Job info blocks */
  infoBlock("JOB", [job.name, `Status: ${job.status}`], LM, y);
  infoBlock(
    "CLIENT",
    [
      job.client || "N/A",
      [job.city, job.state, job.zip].filter(Boolean).join(", ") || "N/A",
      job.phone ? `Tel: ${job.phone}` : null,
    ],
    LM + 90,
    y,
  );
  y += 36;

  /* Specs table */
  y = section("Job Specifications", y);
  const crewNames = (job.crewIds || [])
    .map((id) => {
      const m = state.crew.find((c) => c.id === id);
      return m ? m.name : null;
    })
    .filter(Boolean);
  y = tbl(
    ["Field", "Value"],
    [
      ["Scheduled Date", job.startDate ? fmtDate(job.startDate) : "TBD"],
      ["Insulation Type", job.insulationType || "N/A"],
      ["Area Type", job.areaType || "N/A"],
      ["Square Footage", job.sqft ? `${job.sqft} sq ft` : "N/A"],
      ["R-Value Target", job.rValueTarget ? `R-${job.rValueTarget}` : "N/A"],
      ["Crew Assigned", crewNames.length ? crewNames.join(", ") : "TBD"],
    ],
    y,
    { 0: { cellWidth: 50, fontStyle: "bold" }, 1: { cellWidth: PW - 50 } },
  );
  y += 6;

  /* Materials */
  const matCosts = (job.costs || []).filter((c) => c.category === "Materials");
  if (matCosts.length) {
    y = section("Materials", y);
    y = tbl(
      ["Material", "Qty", "Unit"],
      matCosts.map((c) => [c.name || c.description || "N/A", c.qty || 0, c.unit || "—"]),
      y,
      {
        0: { cellWidth: PW - 60 },
        1: { cellWidth: 22, halign: "right" },
        2: { cellWidth: 38 },
      },
    );
    y += 6;
  }

  /* Pre-job checklist */
  y = section("Pre-Job Checklist", y);
  [
    "PPE checked (respirator, goggles, gloves)",
    "Equipment tested and operational",
    "Attic/area access confirmed",
    "Materials quantity verified",
    "Customer briefed on process",
  ].forEach((item) => {
    doc.setLineWidth(0.4);
    doc.setDrawColor(100);
    doc.rect(LM + 2, y - 4, 4, 4);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(item, LM + 10, y);
    y += 7;
  });

  if (job.notes) {
    y = section("Special Instructions / Access Notes", y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc
      .splitTextToSize(job.notes, PW)
      .slice(0, 8)
      .forEach((l) => {
        doc.text(l, LM, y);
        y += 5;
      });
  }

  save(`work_order_${job.name.replace(/[^a-z0-9]/gi, "_").slice(0, 40)}.pdf`);
}

/* ─── PDF: Warranty Certificate ─────────────── */
function exportWarrantyCertPDF(job) {
  const e = _pdf("WARRANTY", job.name);
  if (!e) return;
  const { doc, tbl, infoBlock, section, save, LM, RM, PW, s } = e;
  const co = s.company || "Your Company";
  let y = 46;

  const installDate = job.startDate || job.date || Date.now();
  const matExp = new Date(installDate);
  matExp.setFullYear(matExp.getFullYear() + 10);
  const laborExp = new Date(installDate);
  laborExp.setFullYear(laborExp.getFullYear() + 2);

  /* Certificate title */
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(0);
  doc.text("LIMITED WARRANTY CERTIFICATE", 105, y, { align: "center" });
  doc.setDrawColor(0);
  doc.setLineWidth(0.5);
  doc.line(40, y + 3, 170, y + 3);
  y += 14;

  /* Installation info */
  y = section("Installation Details", y);
  y = tbl(
    ["Field", "Value"],
    [
      ["Issued To", job.client || "N/A"],
      [
        "Property Address",
        [job.city, job.state, job.zip].filter(Boolean).join(", ") || "N/A",
      ],
      ["Job Name", job.name],
      ["Installation Date", fmtDate(installDate)],
      ["Insulation Type", job.insulationType || "N/A"],
      ["Area", job.areaType || "N/A"],
      [
        "R-Value Achieved",
        job.rValueAchieved
          ? `R-${job.rValueAchieved}`
          : job.rValueTarget
            ? `R-${job.rValueTarget}`
            : "N/A",
      ],
      ["Square Footage", job.sqft ? `${job.sqft} sq ft` : "N/A"],
    ],
    y,
    { 0: { cellWidth: 52, fontStyle: "bold" }, 1: { cellWidth: PW - 52 } },
  );
  y += 10;

  /* Warranty terms */
  y = section("Warranty Terms", y);
  y = tbl(
    ["Coverage", "Duration", "Expiry", "Scope"],
    [
      [
        "Material",
        "10 Years",
        fmtDate(matExp.getTime()),
        "Manufacturer defects in insulation material",
      ],
      [
        "Labor",
        "2 Years",
        fmtDate(laborExp.getTime()),
        "Installation workmanship defects",
      ],
    ],
    y,
    {
      0: { cellWidth: 24, fontStyle: "bold" },
      1: { cellWidth: 22 },
      2: { cellWidth: 34 },
      3: { cellWidth: PW - 80 },
    },
  );
  y += 8;

  /* Disclaimer */
  doc.setFont("helvetica", "italic");
  doc.setFontSize(8);
  doc.setTextColor(100);
  const disc =
    "This warranty applies to the specific installation described above and does not cover damage from flooding, fire, pest infestation, or unauthorized modifications.";
  doc.splitTextToSize(disc, PW).forEach((l) => {
    doc.text(l, LM, y);
    y += 5;
  });
  doc.setTextColor(0);
  y += 12;

  /* Signature lines */
  doc.setLineWidth(0.4);
  doc.setDrawColor(80);
  doc.line(LM, y, LM + 72, y);
  doc.line(RM - 60, y, RM, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text("Authorized Signature / Date", LM, y + 6);
  doc.text("Customer Signature / Date", RM - 60, y + 6);

  job.warrantyIssued = true;
  job.warrantyDate = Date.now();
  saveJob(job).catch(() =>
    showToast(
      "Could not save warranty record. Check your connection.",
      "error",
    ),
  );
  save(`warranty_${job.name.replace(/[^a-z0-9]/gi, "_").slice(0, 40)}.pdf`);
}

/* ─── PDF: Job P&L Report ────────────────────── */
function exportJobPLPDF(job) {
  const e = _pdf("P&L REPORT", job.name);
  if (!e) return;
  const { doc, tbl, infoBlock, section, totals, save, LM, RM, PW, s } = e;
  let y = 46;

  const revenue = job.value || 0;
  const materialCost = jobCost(job);
  const logs = state.timeLogs.filter((l) => l.jobId === job.id);
  const totalHours = logs.reduce((s, l) => s + (l.hours || 0), 0);
  const crewRates = (job.crewIds || [])
    .map((id) => {
      const m = state.crew.find((c) => c.id === id);
      return m?.hourlyRate || 0;
    })
    .filter((r) => r > 0);
  const avgRate = crewRates.length
    ? crewRates.reduce((a, b) => a + b, 0) / crewRates.length
    : 0;
  const laborCost = Math.round(totalHours * avgRate * 100) / 100;
  const overhead = Math.round(revenue * 0.1 * 100) / 100;
  const totalCosts =
    Math.round((materialCost + laborCost + overhead) * 100) / 100;
  const grossMargin = Math.round((revenue - totalCosts) * 100) / 100;
  const marginPct =
    revenue > 0 ? ((grossMargin / revenue) * 100).toFixed(1) : "N/A";

  infoBlock("JOB", [job.name, `Status: ${job.status}`], LM, y);
  infoBlock(
    "PERIOD",
    [
      `Date: ${fmtDate(job.date)}`,
      `Report: ${fmtDate(Date.now())}`,
      `Hours Logged: ${totalHours.toFixed(2)}h`,
    ],
    LM + 90,
    y,
  );
  y += 36;

  /* P&L summary table */
  y = section("Financial Summary", y);
  y = tbl(
    ["Category", "Item", "Amount"],
    [
      ["Revenue", "Estimated Job Value", formatCurrency(revenue)],
      ["Cost", "Material / Item Costs", formatCurrency(materialCost)],
      [
        "Cost",
        `Labor (${totalHours.toFixed(1)}h × $${avgRate.toFixed(0)}/h)`,
        formatCurrency(laborCost),
      ],
      ["Cost", "Overhead Estimate (10%)", formatCurrency(overhead)],
      ["Cost Total", "—", formatCurrency(totalCosts)],
    ],
    y,
    {
      0: { cellWidth: 34, fontStyle: "bold" },
      1: { cellWidth: PW - 80 },
      2: { cellWidth: 46, halign: "right" },
    },
  );
  y += 6;

  y = totals(
    [["Gross Margin:", `${formatCurrency(grossMargin)} (${marginPct}%)`, true]],
    y,
  );

  if (job.rebateAmount > 0) {
    y += 8;
    y = section("Rebate", y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(
      `Amount: ${formatCurrency(job.rebateAmount)}  ·  Status: ${job.rebateStatus || "N/A"}  ·  Source: ${job.rebateSource || "—"}`,
      LM,
      y,
    );
  }

  /* Cost breakdown table */
  const costs = job.costs || [];
  if (costs.length) {
    y += 8;
    y = section("Cost Details", y);
    y = tbl(
      ["Description", "Category", "Qty", "Unit Cost", "Total"],
      costs.map((c) => [
        c.name || c.description || "N/A",
        c.category || "—",
        c.qty || 0,
        formatCurrency(c.unitCost),
        formatCurrency((c.qty || 0) * (c.unitCost || 0)),
      ]),
      y,
      {
        0: { cellWidth: 60 },
        1: { cellWidth: 36 },
        2: { cellWidth: 18, halign: "right" },
        3: { cellWidth: 34, halign: "right" },
        4: { cellWidth: 42, halign: "right" },
      },
    );
  }

  save(`pl_report_${job.name.replace(/[^a-z0-9]/gi, "_").slice(0, 40)}.pdf`);
}
/* ─── Sort helpers ───────────────────────────── */
function sorted(list) {
  const { col, dir } = state.sort;
  return [...list].sort((a, b) => {
    let va = a[col] ?? "",
      vb = b[col] ?? "";
    if (typeof va === "string") va = va.toLowerCase();
    if (typeof vb === "string") vb = vb.toLowerCase();
    return (va < vb ? -1 : va > vb ? 1 : 0) * (dir === "asc" ? 1 : -1);
  });
}
const sortIco = (col) =>
  state.sort.col === col
    ? state.sort.dir === "asc"
      ? " ↑"
      : " ↓"
    : `<span class="sort-inactive"> ↕</span>`;
const th = (col, lbl, align = "") =>
  `<th class="sortable" data-sort="${col}" role="button" tabindex="0" aria-label="Sort by ${lbl}"${align ? ` style="text-align:${align}"` : ""}>${lbl}${sortIco(col)}</th>`;

/* ─── US APIs ────────────────────────────────── */
/*
 * APIs used (all free, no key required):
 *  1. Zippopotam.us  — ZIP → city/state
 *  2. Nominatim/OSM  — GPS lat/lng → street address
 *  3. Open-Meteo     — lat/lng → current weather (no key)
 *  4. date.nager.at  — US federal holidays for a given year
 *  5. Web Share API  — native share sheet / clipboard fallback
 */
function lookupZIP(zip, onResult) {
  const clean = (zip || "").replace(/\D/g, "").slice(0, 5);
  if (clean.length !== 5) return;
  fetch(`https://api.zippopotam.us/us/${clean}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data && data.places && data.places[0]) {
        const p = data.places[0];
        onResult(p["place name"] || "", p["state abbreviation"] || "");
      }
    })
    .catch(() => {});
}

function reverseGeocode(lat, lng, onResult) {
  fetch(
    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
    { headers: { "Accept-Language": "en-US" } },
  )
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data || !data.address) return;
      const a = data.address;
      const parts = [
        a.house_number ? `${a.house_number} ${a.road || ""}`.trim() : a.road,
        a.city || a.town || a.village || a.county,
        a.state,
      ].filter(Boolean);
      if (parts.length) onResult(parts.join(", "));
    })
    .catch(() => {});
}

/* ─── Driving Distance via OSRM + Nominatim (free, no key) ── */
async function calcDrivingMiles(origin, dest) {
  const geocode = async (q) => {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&countrycodes=us&limit=1&format=json`,
      { headers: { "Accept-Language": "en-US" } },
    );
    if (!r.ok) return null;
    const d = await r.json();
    return d[0]
      ? { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) }
      : null;
  };
  const [o, d2] = await Promise.all([geocode(origin), geocode(dest)]);
  if (!o || !d2) return null;
  const r = await fetch(
    `https://router.project-osrm.org/route/v1/driving/${o.lng},${o.lat};${d2.lng},${d2.lat}?overview=false`,
  );
  if (!r.ok) return null;
  const data = await r.json();
  return data.routes?.[0] ? data.routes[0].distance / 1609.344 : null;
}

/* ─── Email Estimate via mailto ───────────────────────────── */
function emailEstimate(e) {
  const s = state.settings;
  const company = s.company || "Your Company";
  const subtotal = e.items?.length
    ? e.items.reduce((sum, i) => sum + (i.total || 0), 0)
    : e.value || 0;
  const travel = e.travelFee || 0;
  const taxAmt = (subtotal + travel) * ((e.taxRate || 0) / 100);
  const total = subtotal + travel + taxAmt;
  const itemLines = e.items?.length
    ? e.items
        .map(
          (i) =>
            `  • ${i.name}${i.description ? ` (${i.description})` : ""}: ${fmt(i.total)}`,
        )
        .join("\n")
    : `  ${e.insulationType || "Insulation"} — ${e.areaType || ""}${e.sqft ? ` (${e.sqft} sq ft)` : ""}`;
  const addrLine = [e.address, e.city, e.state, e.zip]
    .filter(Boolean)
    .join(", ");
  const bodyParts = [
    `Hi ${e.client || "there"},`,
    ``,
    `Here is your estimate from ${company}:`,
    `Estimate #: ${e.name || ""}`,
    addrLine ? `Job Address: ${addrLine}` : null,
    ``,
    `Services:`,
    itemLines,
    ``,
    `Subtotal: ${fmt(subtotal)}`,
    travel > 0
      ? `Travel Fee: ${fmt(travel)}${e.travelMiles ? ` (${e.travelMiles} mi)` : ""}`
      : null,
    taxAmt > 0 ? `Tax (${e.taxRate}%): ${fmt(taxAmt)}` : null,
    `TOTAL: ${fmt(total)}`,
    ``,
    e.notes ? `Notes: ${e.notes}` : null,
    ``,
    `This estimate is valid for 30 days. To accept, reply to this email or call us.`,
    ``,
    company,
    s.companyPhone || null,
    s.companyEmail || null,
  ]
    .filter((l) => l !== null)
    .join("\n");
  const subject = `Estimate ${e.name || ""} — ${company}`;
  window.open(
    `mailto:${encodeURIComponent(e.email || "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyParts)}`,
  );
}

/* ─── QuickBooks-compatible CSV Export ────────────────────── */
function exportQuickBooksCSV() {
  const jobs = state.jobs.filter((j) =>
    ["Active", "Completed", "Invoiced"].includes(j.status),
  );
  if (!jobs.length) {
    toast.warn("No data", "No active/completed/invoiced jobs to export.");
    return;
  }
  const rows = [
    [
      "Invoice Date",
      "Invoice No",
      "Customer",
      "Description",
      "Qty",
      "Unit Price",
      "Amount",
      "Tax Code",
      "Status",
      "Payment Status",
    ],
  ];
  jobs.forEach((j) => {
    const invNo =
      j.invoiceNumber ||
      `${state.settings.invoicePrefix}-${j.id.slice(-6).toUpperCase()}`;
    const date = j.date ? new Date(j.date).toLocaleDateString("en-US") : "";
    rows.push([
      date,
      invNo,
      j.client || "",
      j.name,
      "1",
      (j.value || 0).toFixed(2),
      (j.value || 0).toFixed(2),
      "NON",
      j.status,
      j.paymentStatus || "Unpaid",
    ]);
  });
  const csv = rows
    .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `quickbooks-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast.success(
    "QuickBooks CSV exported",
    `${jobs.length} jobs ready to import.`,
  );
}

/* ─── Address Autocomplete (Nominatim) ────────────────────── */
function attachAddressAutocomplete(inputEl) {
  let timer = null;
  let dropdown = null;
  function removeDrop() {
    if (dropdown) {
      dropdown.remove();
      dropdown = null;
    }
  }
  inputEl.addEventListener("input", () => {
    clearTimeout(timer);
    const q = inputEl.value.trim();
    if (q.length < 5) {
      removeDrop();
      return;
    }
    timer = setTimeout(async () => {
      try {
        const r = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&countrycodes=us&limit=5&format=json&addressdetails=1`,
          { headers: { "Accept-Language": "en-US" } },
        );
        const results = await r.json();
        removeDrop();
        if (!results.length) return;
        dropdown = document.createElement("div");
        dropdown.className = "addressSuggest";
        results.forEach((res) => {
          const a = res.address || {};
          const street = [a.house_number, a.road].filter(Boolean).join(" ");
          const cityName = a.city || a.town || a.village || a.suburb || "";
          const st = a.state_code || (a.state || "").slice(0, 2).toUpperCase();
          const label = [
            street || res.display_name.split(",")[0],
            cityName,
            st,
            a.postcode,
          ]
            .filter(Boolean)
            .join(", ");
          const item = document.createElement("div");
          item.className = "addressSuggestItem";
          item.textContent = label;
          item.addEventListener("mousedown", (ev) => {
            ev.preventDefault();
            inputEl.value = street || res.display_name.split(",")[0].trim();
            const parent = inputEl.closest(".modalBd");
            const cityEl = parent?.querySelector("#eCity");
            const stEl = parent?.querySelector("#eSt");
            const zipEl = parent?.querySelector("#eZip");
            if (cityEl && !cityEl.value) cityEl.value = cityName;
            if (stEl && !stEl.value) stEl.value = st;
            if (zipEl && !zipEl.value) zipEl.value = a.postcode || "";
            removeDrop();
          });
          dropdown.appendChild(item);
        });
        const wrap = inputEl.parentElement;
        wrap.style.position = "relative";
        wrap.appendChild(dropdown);
      } catch {}
    }, 450);
  });
  inputEl.addEventListener("blur", () => setTimeout(removeDrop, 200));
}

/* Open-Meteo: free weather API, no key needed */
function fetchWeather(lat, lng, onResult) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,weathercode,windspeed_10m,precipitation,relativehumidity_2m` +
    `&temperature_unit=fahrenheit&windspeed_unit=mph&precipitation_unit=inch&timezone=auto`;
  fetch(url)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data || !data.current) return;
      const c = data.current;
      const desc = weatherCodeLabel(c.weathercode);
      onResult({
        temp: Math.round(c.temperature_2m),
        wind: Math.round(c.windspeed_10m),
        precip: c.precipitation,
        humidity: c.relativehumidity_2m ?? null,
        desc,
        code: c.weathercode,
      });
    })
    .catch(() => {});
}

function weatherCodeLabel(code) {
  if (code === 0) return "Clear sky";
  if (code <= 3) return "Partly cloudy";
  if (code <= 9) return "Foggy";
  if (code <= 19) return "Drizzle";
  if (code <= 29) return "Rain";
  if (code <= 39) return "Snow";
  if (code <= 49) return "Fog";
  if (code <= 59) return "Drizzle";
  if (code <= 69) return "Rain";
  if (code <= 79) return "Snow";
  if (code <= 84) return "Rain showers";
  if (code <= 94) return "Thunderstorm";
  return "Thunderstorm";
}

function weatherIcon(code) {
  if (code === 0) return "☀️";
  if (code <= 3) return "⛅";
  if (code <= 49) return "🌫️";
  if (code <= 69) return "🌧️";
  if (code <= 79) return "🌨️";
  if (code <= 84) return "🌦️";
  return "⛈️";
}

/* date.nager.at: US federal holidays, free, no key */
function fetchUSHolidays(year, onResult) {
  fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/US`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (Array.isArray(data)) onResult(data);
    })
    .catch(() => {});
}

/* Check if a timestamp falls on a US federal holiday */
let _holidays = [];
function isUSHoliday(ts) {
  const d = new Date(ts).toISOString().slice(0, 10);
  return _holidays.find((h) => h.date === d) || null;
}

function shareText(title, text) {
  if (navigator.share) {
    navigator.share({ title, text }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.info("Copied", "Job summary copied to clipboard."))
      .catch(() => toast.error("Error", "Could not copy to clipboard."));
  }
}

function shareJob(job) {
  const tc = jobCost(job);
  const margin = (job.value || 0) - tc;
  const pct = job.value ? ((margin / job.value) * 100).toFixed(1) : null;
  const hrs = state.timeLogs
    .filter((l) => l.jobId === job.id)
    .reduce((s, l) => s + (l.hours || 0), 0);
  const lines = [
    `📋 ${job.name}`,
    job.client ? `👤 Client: ${job.client}` : null,
    `📌 Status: ${job.status}`,
    job.deadline ? `📅 Deadline: ${fmtDate(job.deadline)}` : null,
    job.value ? `💰 Value: ${fmt(job.value)}` : null,
    tc ? `💸 Costs: ${fmt(tc)}` : null,
    pct !== null ? `📈 Margin: ${fmt(margin)} (${pct}%)` : null,
    hrs ? `⏱ Hours: ${hrs.toFixed(2)}h` : null,
    job.notes ? `📝 Notes: ${job.notes}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  shareText(job.name, lines);
}

/* ─── Insulation / Florida helpers ─────────────────────────── */
const FL_CODE = {
  Attic: 30,
  Walls: 13,
  "Crawl Space": 10,
  Garage: 13,
  "New Construction": 30,
  Other: 13,
};

function checkFLCode(areaType, rValueAchieved) {
  const min = FL_CODE[areaType] || 13;
  if (!rValueAchieved) return null;
  return rValueAchieved >= min ? { pass: true, min } : { pass: false, min };
}

function calcMaterials(insulationType, sqft, rValueTarget) {
  if (!sqft || !rValueTarget) return null;
  const coverage = {
    "Blown-in Fiberglass": sqft / (40 * (rValueTarget / 11)),
    "Blown-in Cellulose": sqft / (35 * (rValueTarget / 13)),
    "Spray Foam Open Cell": (sqft * (rValueTarget / 3.7)) / 55,
    "Spray Foam Closed Cell": (sqft * (rValueTarget / 6.5)) / 55,
    "Batt Fiberglass": Math.ceil(sqft / 32),
    "Batt Mineral Wool": Math.ceil(sqft / 30),
    "Radiant Barrier": Math.ceil(sqft / 500),
    Other: null,
  };
  const units = {
    "Blown-in Fiberglass": "bags",
    "Blown-in Cellulose": "bags",
    "Spray Foam Open Cell": "sets",
    "Spray Foam Closed Cell": "sets",
    "Batt Fiberglass": "rolls",
    "Batt Mineral Wool": "rolls",
    "Radiant Barrier": "rolls",
    Other: null,
  };
  const qty = coverage[insulationType];
  const unit = units[insulationType];
  if (!qty || !unit) return null;
  return { qty: Math.ceil(qty), unit, insulationType };
}

function calcUtilitySavings(sqft, rBefore, rAfter) {
  if (!sqft || !rBefore || !rAfter || rAfter <= rBefore) return null;
  const deltaU = 1 / rBefore - 1 / rAfter;
  const btuSaved = sqft * deltaU * 8000;
  const kwhSaved = btuSaved / 3412;
  const dollarSaved = kwhSaved * 0.12;
  return {
    kwhSaved: Math.round(kwhSaved),
    dollarSaved: Math.round(dollarSaved),
  };
}

function calcHeatIndex(tempF, rh) {
  if (tempF < 80) return tempF;
  const T = tempF,
    R = rh;
  return Math.round(
    -42.379 +
      2.04901523 * T +
      10.14333127 * R -
      0.22475541 * T * R -
      0.00683783 * T * T -
      0.05391554 * R * R +
      0.00122874 * T * T * R +
      0.00085282 * T * R * R -
      0.00000199 * T * T * R * R,
  );
}

function heatIndexLevel(hi) {
  if (hi >= 125)
    return { level: "Extreme Danger", color: "#ff0055", emoji: "🔥" };
  if (hi >= 103)
    return { level: "Danger", color: "var(--danger)", emoji: "⚠️" };
  if (hi >= 90)
    return { level: "Extreme Caution", color: "var(--warn)", emoji: "🌡️" };
  if (hi >= 80) return { level: "Caution", color: "#ffaa00", emoji: "🌡️" };
  return null;
}

function isHurricaneSeason() {
  const m = new Date().getMonth() + 1;
  return m >= 6 && m <= 11;
}

/* ─── Save helpers ───────────────────────────── */
async function saveJob(job) {
  if (demoBlock()) return;
  await idb.put(APP.stores.jobs, job);
  const i = state.jobs.findIndex((j) => j.id === job.id);
  if (i !== -1) {
    state.jobs[i] = job;
  } else {
    state.jobs.push(job);
    /* ── In-app rating prompt after 3rd job ── */
    const jobCount = state.jobs.length;
    const alreadyRated = localStorage.getItem("ratingPromptShown");
    if (jobCount === 3 && !alreadyRated && !window.__demoMode) {
      localStorage.setItem("ratingPromptShown", "1");
      setTimeout(() => {
        modal.open(`
          <div class="modalHd">
            <div><h2>Enjoying JobCost Pro?</h2><p>You've created your 3rd job!</p></div>
            <button type="button" class="closeX" aria-label="Close">
              <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="modalBd" style="text-align:center;padding:20px 0;">
            <div style="font-size:36px;margin-bottom:12px;">⭐⭐⭐⭐⭐</div>
            <p style="color:var(--muted);font-size:14px;max-width:280px;margin:0 auto;">
              If JobCost Pro is helping your business, please take a moment to leave a review on the Play Store. It helps us a lot!
            </p>
          </div>
          <div class="modalFt">
            <button type="button" class="btn" id="ratingLater">Maybe Later</button>
            <button type="button" class="btn primary" id="ratingNow">Rate the App</button>
          </div>`);
        document.getElementById("ratingLater")?.addEventListener("click", modal.close);
        document.getElementById("ratingNow")?.addEventListener("click", () => {
          modal.close();
          window.open("https://play.google.com/store/apps/details?id=SEU_APP_ID_AQUI", "_blank", "noopener,noreferrer");
        });
      }, 1500);
    }
  }
}

/* ─── Auto-Deduct Inventory ─────────────────── */
function autoDeductInventory(job) {
  if (!job.insulationType || !job.sqft || !job.rValueTarget) return;
  const matResult = calcMaterials(
    job.insulationType,
    job.sqft,
    job.rValueTarget,
  );
  if (!matResult) return;
  /* Find matching inventory item by name pattern */
  const typeKeyword = job.insulationType.split(" ")[0].toLowerCase();
  const matchItem = state.inventory.find(
    (item) =>
      item.name.toLowerCase().includes(typeKeyword) ||
      item.category.toLowerCase().includes(typeKeyword),
  );
  if (!matchItem) return;
  if (matchItem.quantity < matResult.qty) {
    toast.warn(
      "Low Stock",
      `Not enough ${matchItem.name} (${matchItem.quantity} on hand, need ${matResult.qty}).`,
    );
    return;
  }
  const msg = `Deduct ${matResult.qty} ${matResult.unit} of "${matchItem.name}" from inventory?`;
  confirm("Auto-Deduct Materials", msg, "Deduct", () => {
    matchItem.quantity = matchItem.quantity - matResult.qty;
    saveInventoryItem(matchItem).then(() => {
      toast.success(
        "Inventory updated",
        `${matResult.qty} ${matResult.unit} deducted.`,
      );
    });
  });
}

/* ─── Tax Summary PDF ────────────────────────── */
function exportTaxSummaryPDF(year) {
  if (!window.jspdf) {
    toast.error("PDF Error", "jsPDF not loaded.");
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const lm = 14,
    rr = 196;
  let y = 18;
  const s = state.settings;

  const yearJobs = state.jobs.filter((j) => {
    const d = new Date(j.date);
    return d.getFullYear() === year;
  });

  const totalRevenue = yearJobs.reduce((sum, j) => sum + (j.value || 0), 0);
  const totalMaterial = yearJobs.reduce((sum, j) => sum + jobCost(j), 0);
  const totalLabor = (() => {
    let labor = 0;
    yearJobs.forEach((j) => {
      const hrs = state.timeLogs
        .filter((l) => l.jobId === j.id)
        .reduce((s, l) => s + (l.hours || 0), 0);
      if (j.crewIds && j.crewIds.length) {
        const rates = j.crewIds
          .map((id) => {
            const m = state.crew.find((c) => c.id === id);
            return m && m.hourlyRate ? m.hourlyRate : 0;
          })
          .filter((r) => r > 0);
        const avg = rates.length
          ? rates.reduce((a, b) => a + b, 0) / rates.length
          : 0;
        labor += hrs * avg;
      }
    });
    return labor;
  })();
  const mileageDeduction = state.mileageLogs
    .filter((ml) => new Date(ml.date).getFullYear() === year)
    .reduce((sum, ml) => sum + (ml.deduction || 0), 0);
  /* Taxable income = Revenue - Job Costs - Mileage.
     Labor (from crew time logs) is shown separately for reference but NOT
     subtracted — it is typically already included in job cost line items. */
  const taxableIncome = totalRevenue - totalMaterial - mileageDeduction;

  /* Quarterly breakdown */
  const quarters = [0, 0, 0, 0];
  yearJobs.forEach((j) => {
    const q = Math.floor(new Date(j.date).getMonth() / 3);
    quarters[q] += j.value || 0;
  });

  /* Header */
  doc.setFillColor(18, 18, 18);
  doc.rect(0, 0, 210, 32, "F");
  if (s.logoDataUrl) {
    try {
      const logoFmt = s.logoDataUrl.startsWith("data:image/png") ? "PNG" : "JPEG";
      doc.addImage(s.logoDataUrl, logoFmt, lm, 4, 24, 24);
    } catch (err) { console.warn("[PDF] Logo render failed:", err); }
  }
  const taxHx = s.logoDataUrl ? lm + 28 : lm;
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text(s.company || "Your Company", taxHx, y);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(`TAX SUMMARY ${year}`, rr, y, { align: "right" });
  doc.setTextColor(0);
  y = 42;

  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(20, 40, 90);
  doc.text(`Annual Tax Summary — ${year}`, lm, y);
  y += 6;
  doc.setDrawColor(20, 40, 90);
  doc.line(lm, y, rr, y);
  y += 10;
  doc.setTextColor(0);

  const r = (lbl, val, bold) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(10);
    doc.text(lbl, lm, y);
    doc.text(val, rr, y, { align: "right" });
    y += 8;
  };

  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(20, 40, 90);
  doc.text("INCOME", lm, y);
  y += 8;
  doc.setTextColor(0);
  r(`Total Revenue (${yearJobs.length} jobs)`, fmt(totalRevenue), false);
  y += 4;
  doc.setDrawColor(200);
  doc.line(lm, y, rr, y);
  y += 8;

  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(20, 40, 90);
  doc.text("DEDUCTIBLE EXPENSES", lm, y);
  y += 8;
  doc.setTextColor(0);
  r("Job Costs (materials, labor, items)", fmt(totalMaterial), false);
  r("Mileage Deduction", fmt(mileageDeduction), false);
  r("Total Deductible Expenses:", fmt(totalMaterial + mileageDeduction), true);
  if (totalLabor > 0) {
    y += 2;
    doc.setFont("helvetica", "italic");
    doc.setFontSize(8);
    doc.setTextColor(120, 120, 120);
    doc.text(
      `* Crew labor from time logs: ${fmt(totalLabor)} (for reference — may already be included above)`,
      lm,
      y,
    );
    doc.setTextColor(0);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    y += 6;
  }
  y += 4;
  doc.setDrawColor(200);
  doc.line(lm, y, rr, y);
  y += 8;

  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(20, 40, 90);
  doc.text("ESTIMATED TAXABLE INCOME", lm, y);
  y += 8;
  doc.setTextColor(taxableIncome >= 0 ? 0 : 200);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text(fmt(taxableIncome), rr, y, { align: "right" });
  doc.setTextColor(0);
  y += 12;

  /* Quarterly breakdown */
  doc.setDrawColor(200);
  doc.line(lm, y, rr, y);
  y += 8;
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(20, 40, 90);
  doc.text("QUARTERLY BREAKDOWN", lm, y);
  y += 8;
  doc.setTextColor(0);
  ["Q1 (Jan–Mar)", "Q2 (Apr–Jun)", "Q3 (Jul–Sep)", "Q4 (Oct–Dec)"].forEach(
    (lbl, i) => {
      r(lbl, fmt(quarters[i]), false);
    },
  );

  doc.setFillColor(18, 18, 18);
  doc.rect(0, 275, 210, 22, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(8);
  doc.text(
    "This summary is for informational purposes only. Consult a tax professional.",
    105,
    285,
    { align: "center" },
  );

  doc.save(`tax_summary_${year}.pdf`);
  toast.success("Tax summary exported", `${year}`);
}

function openPricebookModal(item) {
  const isEdit = !!item;
  const m = modal.open(`
    <div class="modalHd">
      <div><h2>${isEdit ? "Edit Service" : "New Service"}</h2>
        <p>${isEdit ? esc(item.name) : "Add a service to your catalog."}</p></div>
      <button type="button" class="closeX" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="modalBd">
      <div class="fieldGrid">
        <div class="field" style="grid-column:1/-1;">
          <label for="pbName">Service Name *</label>
          <input id="pbName" class="input" type="text" maxlength="120" placeholder="e.g. Attic Blown-in" value="${isEdit ? esc(item.name) : ""}"/>
        </div>
        <div class="field" style="grid-column:1/-1;">
          <label for="pbDesc">Description / R-Value</label>
          <input id="pbDesc" class="input" type="text" maxlength="200" placeholder="e.g. R-38, Fiberglass blown-in" value="${isEdit ? esc(item.description || "") : ""}"/>
        </div>
        <div class="field">
          <label for="pbPrice">Default Unit Price ($)</label>
          <input id="pbPrice" class="input" type="number" min="0" step="0.01" placeholder="0.00" value="${isEdit && item.unitPrice ? item.unitPrice : ""}"/>
          <p class="help" style="margin-top:4px;">Auto-filled in estimate line items. Leave blank if price varies.</p>
        </div>
      </div>
    </div>
    <div class="modalFt">
      <button type="button" class="btn" id="pbCancel">Cancel</button>
      <button type="button" class="btn primary" id="pbSave">${isEdit ? "Save Changes" : "Add Service"}</button>
    </div>`);

  m.querySelector("#pbCancel").addEventListener("click", modal.close);
  m.querySelector("#pbSave").addEventListener("click", async () => {
    if (!auth?.currentUser?.uid) {
      showToast("Session expired. Please sign in again.", "error");
      return;
    }
    const nameEl = m.querySelector("#pbName");
    const name = nameEl.value.trim();
    if (!name) {
      nameEl.classList.add("invalid");
      nameEl.focus();
      return;
    }
    nameEl.classList.remove("invalid");
    const saved = {
      id: isEdit ? item.id : uid(),
      name,
      description: m.querySelector("#pbDesc").value.trim(),
      unitPrice: parseFloat(m.querySelector("#pbPrice").value) || 0,
    };
    const saveBtn = m.querySelector("#pbSave");
    saveBtn.disabled = true;
    try {
      await savePricebookItem(saved);
      showToast(
        isEdit
          ? "Service updated successfully."
          : "Service added successfully.",
        "success",
      );
      modal.close();
      render();
    } catch (err) {
      console.error("[savePricebookItem]", err);
      showToast(
        err.message || "Failed to save service. Please try again.",
        "error",
      );
      saveBtn.disabled = false;
    }
  });
}

/* ─── Material CRUD modal ─────────────────────────────────── */
function openMaterialModal(item) {
  const isEdit = !!item;
  const UNITS = [
    "bag",
    "kit",
    "bale",
    "roll",
    "board-ft",
    "gallon",
    "pail",
    "other",
  ];
  const m = modal.open(`
    <div class="modalHd">
      <div><h2>${isEdit ? "Edit Material" : "Add Material"}</h2>
        <p>Configure name, unit and coverage yield for the calculator.</p></div>
      <button type="button" class="closeX" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="modalBd">
      <div class="fieldGrid">
        <div class="field" style="grid-column:1/-1;">
          <label for="mtName">Material Name *</label>
          <input id="mtName" class="input" type="text" maxlength="120"
            placeholder="e.g. Spider Blown-in R-38" value="${isEdit ? esc(item.name) : ""}"/>
        </div>
        <div class="field">
          <label for="mtUnit">Unit</label>
          <select id="mtUnit" class="input">
            ${UNITS.map((u) => `<option value="${u}" ${isEdit && item.unit === u ? "selected" : ""}>${u}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label for="mtCost">Cost per Unit ($)</label>
          <input id="mtCost" class="input" type="number" min="0" step="0.01" placeholder="0.00"
            value="${isEdit && item.costPerUnit ? item.costPerUnit : ""}"/>
        </div>
        <div class="field">
          <label for="mtCoverage">Coverage per Unit (sq ft) *</label>
          <input id="mtCoverage" class="input" type="number" min="0.1" step="0.1" placeholder="e.g. 40.4"
            value="${isEdit && item.coveragePerUnit ? item.coveragePerUnit : ""}"/>
          <p class="help" style="margin-top:4px;">How many sq ft does one ${isEdit ? item.unit || "unit" : "unit"} cover at your target thickness?</p>
        </div>
        <div class="field">
          <label for="mtThickness">Reference Thickness (in)</label>
          <input id="mtThickness" class="input" type="number" min="0" step="0.25" placeholder="e.g. 5.5"
            value="${isEdit && item.thickness ? item.thickness : ""}"/>
          <p class="help" style="margin-top:4px;">The thickness this coverage applies to (informational).</p>
        </div>
      </div>
    </div>
    <div class="modalFt">
      <button type="button" class="btn" id="mtCancel">Cancel</button>
      <button type="button" class="btn primary" id="mtSave">${isEdit ? "Save Changes" : "Add Material"}</button>
    </div>`);

  m.querySelector("#mtCancel").addEventListener("click", modal.close);
  m.querySelector("#mtSave").addEventListener("click", async () => {
    if (!auth?.currentUser?.uid) {
      showToast("Session expired. Please sign in again.", "error");
      return;
    }
    const nameEl = m.querySelector("#mtName");
    const covEl = m.querySelector("#mtCoverage");
    const name = nameEl.value.trim();
    const cov = parseFloat(covEl.value);
    if (!name) {
      nameEl.classList.add("invalid");
      nameEl.focus();
      return;
    }
    if (!cov || cov <= 0) {
      covEl.classList.add("invalid");
      covEl.focus();
      return;
    }
    nameEl.classList.remove("invalid");
    covEl.classList.remove("invalid");
    const saved = {
      id: isEdit ? item.id : uid(),
      name,
      unit: m.querySelector("#mtUnit").value,
      coveragePerUnit: cov,
      costPerUnit: parseFloat(m.querySelector("#mtCost").value) || 0,
      thickness: parseFloat(m.querySelector("#mtThickness").value) || null,
    };
    const saveBtn = m.querySelector("#mtSave");
    saveBtn.disabled = true;
    try {
      await saveMaterial(saved);
      showToast(
        isEdit
          ? "Material updated successfully."
          : "Material added successfully.",
        "success",
      );
      modal.close();
      render();
    } catch (err) {
      console.error("[saveMaterial]", err);
      showToast(
        err.message || "Failed to save material. Please try again.",
        "error",
      );
      saveBtn.disabled = false;
    }
  });
}

/* ─── Materials Calculator modal ─────────────────────────── */
function openMaterialsCalcModal(onApply) {
  const hasMats = state.materials.length > 0;
  const matOpts = hasMats
    ? state.materials
        .map(
          (mat) =>
            `<option value="${mat.id}">${esc(mat.name)} (${mat.coveragePerUnit} sq ft/${mat.unit})</option>`,
        )
        .join("")
    : `<option value="">No materials configured</option>`;

  const m = modal.open(`
    <div class="modalHd">
      <div><h2><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:7px" aria-hidden="true"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="10" x2="10" y2="10"/><line x1="14" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="10" y2="14"/><line x1="14" y1="14" x2="16" y2="14"/><line x1="8" y1="18" x2="16" y2="18"/></svg>Materials Calculator</h2>
        <p>Calculate exact material needed based on your configured yield.</p></div>
      <button type="button" class="closeX" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="modalBd">
      ${
        !hasMats
          ? `
        <div class="empty" style="padding:20px 0;">
          No materials configured yet.<br>
          <a href="#" id="mcGoSettings" style="color:var(--primary);">Go to Settings → Materials</a> to add your first material.
        </div>`
          : `
      <div class="fieldGrid">
        <div class="field" style="grid-column:1/-1;">
          <label for="mcMaterial">Material</label>
          <select id="mcMaterial" class="input">${matOpts}</select>
        </div>
        <div class="field">
          <label for="mcSqft">Total Area (sq ft) *</label>
          <input id="mcSqft" class="input" type="number" min="1" step="1" placeholder="e.g. 1200"/>
        </div>
        <div class="field">
          <label for="mcThickness">Desired Thickness (in)</label>
          <input id="mcThickness" class="input" type="number" min="0" step="0.25" placeholder="e.g. 5.5"/>
          <p class="help" style="margin-top:4px;">Informational — verify coverage matches this thickness.</p>
        </div>
      </div>

      <div id="mcResult" class="matCalcResult" style="display:none;"></div>

      <div style="margin-top:16px;display:flex;gap:8px;">
        <button type="button" class="btn primary" id="mcCalc" style="flex:1;">Calculate</button>
        ${onApply ? `<button type="button" class="btn" id="mcApply" style="flex:1;" disabled>➕ Add to Estimate</button>` : ""}
      </div>`
      }
    </div>`);

  if (!hasMats) {
    m.querySelector("#mcGoSettings")?.addEventListener("click", (e) => {
      e.preventDefault();
      modal.close();
      routeTo("settings");
    });
    return;
  }

  let lastResult = null;

  function runCalc() {
    const matId = m.querySelector("#mcMaterial").value;
    const sqft = parseFloat(m.querySelector("#mcSqft").value) || 0;
    const mat = state.materials.find((x) => x.id === matId);
    const resultEl = m.querySelector("#mcResult");
    const applyBtn = m.querySelector("#mcApply");

    if (!mat || sqft <= 0) {
      toast.warn("Missing info", "Select a material and enter square footage.");
      return;
    }

    const unitsNeeded = Math.ceil(sqft / mat.coveragePerUnit);
    const totalCost = +(unitsNeeded * mat.costPerUnit).toFixed(2);
    const thicknessRef = mat.thickness ? ` at ${mat.thickness}"` : "";

    lastResult = { mat, unitsNeeded, totalCost, sqft };

    resultEl.style.display = "";
    resultEl.innerHTML = `
      <div class="matCalcRow"><span>Material</span><strong>${esc(mat.name)}</strong></div>
      <div class="matCalcRow"><span>Coverage configured</span><strong>${mat.coveragePerUnit} sq ft / ${mat.unit}${thicknessRef}</strong></div>
      <div class="matCalcRow"><span>Area entered</span><strong>${sqft.toLocaleString()} sq ft</strong></div>
      <div class="matCalcRow matCalcHighlight"><span>${mat.unit}s needed</span><strong>${unitsNeeded} ${mat.unit}s</strong></div>
      ${mat.costPerUnit > 0 ? `<div class="matCalcRow matCalcHighlight"><span>Estimated material cost</span><strong>${fmt(totalCost)}</strong></div>` : ""}`;

    if (applyBtn) applyBtn.disabled = false;
  }

  m.querySelector("#mcCalc").addEventListener("click", runCalc);
  m.querySelector("#mcSqft").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runCalc();
  });

  m.querySelector("#mcApply")?.addEventListener("click", () => {
    if (!lastResult || !onApply) return;
    const { mat, unitsNeeded, totalCost } = lastResult;
    onApply({
      id: uid(),
      name: mat.name,
      description: `${unitsNeeded} ${mat.unit}s @ ${mat.coveragePerUnit} sq ft/${mat.unit}`,
      qty: unitsNeeded,
      unitPrice: mat.costPerUnit || 0,
      total: totalCost,
    });
    toast.success(
      "Added to estimate",
      `${unitsNeeded} ${mat.unit}s of ${mat.name}`,
    );
    modal.close();
  });
}

function openMileageModal(entry) {
  const isEdit = !!entry;
  const jobOpts = state.jobs
    .map(
      (j) =>
        `<option value="${j.id}"${entry && entry.jobId === j.id ? " selected" : ""}>${esc(j.name)}</option>`,
    )
    .join("");
  const m = modal.open(`
      <div class="modalHd">
        <div><h2>${isEdit ? "Edit" : "Add"} Mileage Entry</h2><p>Track business miles for IRS deductions.</p></div>
        <button type="button" class="closeX" aria-label="Close"><svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
      </div>
      <div class="modalBd">
        <div class="fieldGrid">
          <div class="field">
            <label for="mlDate">Date</label>
            <input id="mlDate" class="input" type="date" value="${fmtDateInput(entry ? entry.date : Date.now())}"/>
          </div>
          <div class="field">
            <label for="mlMiles">Miles</label>
            <input id="mlMiles" class="input" type="number" min="0" step="0.1" placeholder="0.0" value="${entry ? entry.miles : ""}"/>
          </div>
          <div class="field">
            <label for="mlJob">Related Job (optional)</label>
            <select id="mlJob"><option value="">— None —</option>${jobOpts}</select>
          </div>
          <div class="field">
            <label for="mlRate">Rate ($/mile)</label>
            <input id="mlRate" class="input" type="number" min="0" step="0.001" value="${entry ? entry.rate : state.settings.mileageRate || 0.67}"/>
          </div>
          <div class="field" style="grid-column:1/-1;">
            <label for="mlDesc">Description</label>
            <input id="mlDesc" class="input" type="text" maxlength="200" placeholder="e.g. Site visit — Attic job at 123 Oak St" value="${esc(entry ? entry.description : "")}"/>
          </div>
        </div>
      </div>
      <div class="modalFt">
        <button type="button" class="btn" id="mlCancel">Cancel</button>
        <button type="button" class="btn primary" id="mlSave">Save Entry</button>
      </div>`);
  m.querySelector("#mlCancel").addEventListener("click", modal.close);
  m.querySelector("#mlSave").addEventListener("click", () => {
    const date = parseDate(m.querySelector("#mlDate").value);
    const miles = parseFloat(m.querySelector("#mlMiles").value) || 0;
    const rate =
      parseFloat(m.querySelector("#mlRate").value) ||
      state.settings.mileageRate ||
      0.67;
    const desc = m.querySelector("#mlDesc").value.trim();
    const jobId = m.querySelector("#mlJob").value || null;
    if (!date) {
      toast.error("Date required", "");
      return;
    }
    if (miles <= 0) {
      toast.error("Miles required", "Enter a valid mileage.");
      return;
    }
    const rec = {
      id: (entry && entry.id) || uid(),
      date,
      miles,
      rate,
      deduction: miles * rate,
      description: desc,
      jobId,
    };
    idb
      .put(APP.stores.mileageLogs, rec)
      .then(() => {
        if (isEdit) {
          state.mileageLogs = state.mileageLogs.map((x) =>
            x.id === rec.id ? rec : x,
          );
        } else {
          state.mileageLogs.push(rec);
        }
        modal.close();
        toast.success(
          "Mileage saved",
          `${miles.toFixed(1)} miles · ${fmt(rec.deduction)} deduction`,
        );
        render();
      })
      .catch(() => toast.error("Error", "Could not save entry."));
  });
}

function openTaxSummaryModal() {
  const currentYear = new Date().getFullYear();
  const years = [];
  const allYears = state.jobs.map((j) => new Date(j.date).getFullYear());
  const minYear = allYears.length ? Math.min(...allYears) : currentYear;
  for (let yr = currentYear; yr >= minYear; yr--) years.push(yr);

  const m = modal.open(`
      <div class="modalHd">
        <div><h2>Tax Summary</h2><p>Annual revenue and expense summary for tax purposes.</p></div>
        <button type="button" class="closeX" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modalBd">
        <div class="fieldGrid" style="margin-bottom:16px;">
          <div class="field"><label for="taxYear">Select Year</label>
            <select id="taxYear">
              ${years.map((yr) => `<option value="${yr}" ${yr === currentYear ? "selected" : ""}>${yr}</option>`).join("")}
            </select>
          </div>
        </div>
        <div id="taxSummaryContent"></div>
      </div>
      <div class="modalFt">
        <button type="button" class="btn" id="btnTaxClose">Close</button>
        <button type="button" class="btn primary" id="btnTaxPDF">Export PDF</button>
      </div>`);

  const renderSummary = (year) => {
    const yearJobs = state.jobs.filter(
      (j) => new Date(j.date).getFullYear() === year,
    );
    const totalRevenue = yearJobs.reduce((sum, j) => sum + (j.value || 0), 0);
    const totalMaterial = yearJobs.reduce((sum, j) => sum + jobCost(j), 0);
    const mileageDed = state.mileageLogs
      .filter((ml) => new Date(ml.date).getFullYear() === year)
      .reduce((sum, ml) => sum + (ml.deduction || 0), 0);
    const taxableIncome = totalRevenue - totalMaterial - mileageDed;
    const quarters = [0, 0, 0, 0];
    yearJobs.forEach((j) => {
      const q = Math.floor(new Date(j.date).getMonth() / 3);
      quarters[q] += j.value || 0;
    });
    m.querySelector("#taxSummaryContent").innerHTML = `
        <div class="summary">
          <div class="summaryRow"><span class="k">Jobs in ${year}</span><strong>${yearJobs.length}</strong></div>
          <div class="summaryRow"><span class="k">Total Revenue</span><strong>${fmt(totalRevenue)}</strong></div>
          <div class="summaryRow"><span class="k">Job Costs (materials, labor, etc.)</span><strong>${fmt(totalMaterial)}</strong></div>
          <div class="summaryRow"><span class="k">Mileage Deduction</span><strong>${fmt(mileageDed)}</strong></div>
          <div class="summaryRow total"><span class="k">Est. Taxable Income</span><strong>${fmt(taxableIncome)}</strong></div>
        </div>
        <div style="margin-top:12px;">
          <div class="sectionLabel">Quarterly Revenue</div>
          <div class="summary">
            ${["Q1 (Jan–Mar)", "Q2 (Apr–Jun)", "Q3 (Jul–Sep)", "Q4 (Oct–Dec)"]
              .map(
                (lbl, i) =>
                  `<div class="summaryRow"><span class="k">${lbl}</span><strong>${fmt(quarters[i])}</strong></div>`,
              )
              .join("")}
          </div>
        </div>`;
  };

  renderSummary(currentYear);
  m.querySelector("#taxYear").addEventListener("change", (e) =>
    renderSummary(parseInt(e.target.value)),
  );
  m.querySelector("#btnTaxClose").addEventListener("click", modal.close);
  m.querySelector("#btnTaxPDF").addEventListener("click", () => {
    const yr = parseInt(m.querySelector("#taxYear").value);
    exportTaxSummaryPDF(yr);
  });
}

/* ─── Duplicate Job ──────────────────────────── */
function duplicateJob(job) {
  const copy = {
    ...job,
    id: uid(),
    name: `${job.name} (Copy)`,
    status: "Draft",
    date: Date.now(),
    statusHistory: [{ status: "Draft", date: Date.now() }],
    costs: (job.costs || []).map((c) => ({ ...c, id: uid() })),
    photos: [],
    paymentStatus: "Unpaid",
    paidDate: null,
    invoiceNumber: null,
  };
  saveJob(copy)
    .then(() => {
      toast.success("Job duplicated", copy.name);
      render();
    })
    .catch((err) =>
      showToast(err.message || "Failed to duplicate job.", "error"),
    );
}

async function saveJobChecklist(job) {
  if (demoBlock()) return;
  await saveJob(job);
}

/* ─── PDF: Before & After Completion Report ─── */
function exportBeforeAfterPDF(job) {
  if (!window.jspdf) {
    toast.error("PDF Error", "jsPDF not loaded.");
    return;
  }
  const beforePhotos = (job.photos || []).filter((p) => p.type === "before");
  const afterPhotos = (job.photos || []).filter((p) => p.type === "after");
  if (!beforePhotos.length && !afterPhotos.length) {
    toast.warn(
      "No tagged photos",
      "Mark at least one photo as Before or After first.",
    );
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const s = state.settings;
  const lm = 14,
    rr = 196,
    pw = 182;
  let y = 18;

  /* ── Header ── */
  doc.setFillColor(18, 18, 18);
  doc.rect(0, 0, 210, 36, "F");
  if (s.logoDataUrl) {
    try {
      const logoFmt = s.logoDataUrl.startsWith("data:image/png") ? "PNG" : "JPEG";
      doc.addImage(s.logoDataUrl, logoFmt, lm, 4, 28, 28);
    } catch (err) { console.warn("[PDF] Logo render failed:", err); }
  }
  const hx = s.logoDataUrl ? lm + 32 : lm;
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(20);
  doc.setFont("helvetica", "bold");
  doc.text("COMPLETION REPORT", hx, y);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  if (s.company) doc.text(s.company, hx, y + 8);
  if (s.companyPhone) doc.text(`Tel: ${s.companyPhone}`, hx, y + 14);
  doc.text(`Date: ${fmtDate(Date.now())}`, rr, y, { align: "right" });
  doc.setTextColor(0);
  y = 44;

  /* ── Job / Client info ── */
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text(job.name, lm, y);
  y += 7;
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  if (job.client) {
    doc.text(`Client: ${job.client}`, lm, y);
    y += 5;
  }
  const addr = [job.city, job.state, job.zip].filter(Boolean).join(", ");
  if (addr) {
    doc.text(`Address: ${addr}`, lm, y);
    y += 5;
  }
  doc.setDrawColor(200, 210, 230);
  doc.line(lm, y, rr, y);
  y += 6;

  /* ── Helper: place one image, returns new y ── */
  const addPhoto = (photo, label, x, imgW, imgH) => {
    const dataUrl = photo.data || photo.dataUrl || "";
    if (!dataUrl) return;
    const fmt = dataUrl.startsWith("data:image/png") ? "PNG" : "JPEG";
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(80, 80, 80);
    doc.text(label, x + imgW / 2, y, { align: "center" });
    try {
      doc.addImage(dataUrl, fmt, x, y + 3, imgW, imgH);
    } catch {}
  };

  /* ── Pair layout: Before left / After right ── */
  const maxPairs = Math.max(beforePhotos.length, afterPhotos.length);
  const colW = (pw - 6) / 2; /* two columns with 6mm gutter */
  const imgH = colW * 0.7; /* ~70% aspect ratio */

  for (let i = 0; i < maxPairs; i++) {
    const neededH = imgH + 18;
    if (y + neededH > 268) {
      doc.setFontSize(7);
      doc.setTextColor(150);
      doc.text(`${s.company || "JobCost Pro"}  ·  ${fmtDate(Date.now())}`, 105, 290, { align: "center" });
      doc.setTextColor(0);
      doc.addPage();
      y = 16;
    }

    const bp = beforePhotos[i] || null;
    const ap = afterPhotos[i] || null;

    if (bp) addPhoto(bp, "BEFORE", lm, colW, imgH);
    if (ap) addPhoto(ap, "AFTER", lm + colW + 6, colW, imgH);

    /* border around each image */
    if (bp) {
      doc.setDrawColor(180, 190, 210);
      doc.rect(lm, y + 3, colW, imgH);
    }
    if (ap) {
      doc.setDrawColor(180, 190, 210);
      doc.rect(lm + colW + 6, y + 3, colW, imgH);
    }

    y += neededH + 4;
  }

  /* ── Summary row ── */
  if (y + 14 > 275) {
    doc.addPage();
    y = 16;
  }
  y += 4;
  doc.setFillColor(18, 18, 18);
  doc.rect(lm, y, pw, 10, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.text(
    `${beforePhotos.length} Before  ·  ${afterPhotos.length} After  ·  Status: ${job.status}`,
    105,
    y + 7,
    { align: "center" },
  );
  doc.setTextColor(0);

  /* ── Footer ── */
  doc.setFontSize(7);
  doc.setTextColor(150);
  doc.text(
    `${s.company || "JobCost Pro"}  ·  Generated ${fmtDate(Date.now())}`,
    105,
    290,
    { align: "center" },
  );

  doc.save(
    `BeforeAfter_${job.name.replace(/[^a-z0-9]/gi, "_").slice(0, 35)}.pdf`,
  );
  toast.success(
    "Report exported",
    `${beforePhotos.length} before + ${afterPhotos.length} after photos.`,
  );
}

/* ─── Completion Certificate PDF ─────────────── */
function exportCompletionCertPDF(job) {
  if (!window.jspdf) {
    toast.error("PDF Error", "jsPDF not loaded.");
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const lm = 14,
    rr = 196;
  const s = state.settings;
  const co = s.company || "Your Company";
  let y = 24;

  doc.setFillColor(18, 18, 18);
  doc.rect(0, 0, 210, 38, "F");
  if (s.logoDataUrl) {
    try {
      const logoFmt = s.logoDataUrl.startsWith("data:image/png") ? "PNG" : "JPEG";
      doc.addImage(s.logoDataUrl, logoFmt, lm, 5, 26, 26);
    } catch (err) { console.warn("[PDF] Logo render failed:", err); }
  }
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(22);
  doc.setFont("helvetica", "bold");
  doc.text(co, lm, y);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  if (s.companyAddress) doc.text(s.companyAddress, lm, y + 9);
  const contactLine = [s.companyPhone, s.companyEmail].filter(Boolean).join("  ·  ");
  if (contactLine) doc.text(contactLine, rr, y + 9, { align: "right" });
  y = 50;

  doc.setTextColor(0);
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(20, 40, 90);
  doc.text("INSTALLATION COMPLETION CERTIFICATE", 105, y, { align: "center" });
  y += 12;
  doc.setDrawColor(20, 40, 90);
  doc.line(lm, y, rr, y);
  y += 10;

  doc.setFontSize(10);
  doc.setTextColor(0);
  const row = (lbl, val) => {
    doc.setFont("helvetica", "bold");
    doc.text(`${lbl}:`, lm, y);
    doc.setFont("helvetica", "normal");
    doc.text(String(val ?? "—"), lm + 55, y);
    y += 8;
  };

  row("Job Name", job.name);
  row("Client", job.client || "—");
  row(
    "Address",
    [job.city, job.state, job.zip].filter(Boolean).join(", ") || "—",
  );
  row("Completion Date", fmtDate(Date.now()));
  row("Insulation Type", job.insulationType || "—");
  row("Area", job.areaType || "—");
  row("Square Footage", job.sqft ? `${job.sqft} sq ft` : "—");
  row("R-Value Before", job.rValueBefore ? `R-${job.rValueBefore}` : "—");
  row("R-Value Achieved", job.rValueAchieved ? `R-${job.rValueAchieved}` : "—");
  row("Depth", job.depthInches ? `${job.depthInches} inches` : "—");

  const flResult = checkFLCode(job.areaType, job.rValueAchieved);
  if (flResult !== null) {
    doc.setFont("helvetica", "bold");
    doc.text("FL Energy Code:", lm, y);
    if (flResult.pass) {
      doc.setTextColor(10, 150, 100);
      doc.text(`PASS (Min R-${flResult.min})`, lm + 55, y);
    } else {
      doc.setTextColor(200, 50, 70);
      doc.text(`DOES NOT MEET (Min R-${flResult.min})`, lm + 55, y);
    }
    doc.setTextColor(0);
    y += 8;
  }

  const savings = calcUtilitySavings(
    job.sqft,
    job.rValueBefore,
    job.rValueAchieved,
  );
  if (savings) {
    row(
      "Est. Annual Savings",
      `~${savings.kwhSaved} kWh / ~$${savings.dollarSaved}/year`,
    );
  }

  const matResult = calcMaterials(
    job.insulationType,
    job.sqft,
    job.rValueAchieved || job.rValueTarget,
  );
  if (matResult) {
    row("Materials Used", `${matResult.qty} ${matResult.unit}`);
  }

  y += 6;
  doc.setDrawColor(180, 185, 200);
  doc.line(lm, y, rr, y);
  y += 10;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("Warranty:", lm, y);
  doc.setFont("helvetica", "normal");
  doc.text("1 year workmanship warranty", lm + 55, y);
  y += 14;

  doc.setFont("helvetica", "italic");
  doc.setFontSize(9);
  doc.setTextColor(80);
  doc.text(
    "This certificate confirms installation was completed to Florida Energy Code standards.",
    lm,
    y,
  );
  y += 10;
  doc.setTextColor(0);

  if (job.signature) {
    try {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.text("Customer Signature:", lm, y);
      y += 6;
      doc.addImage(job.signature, "PNG", lm, y, 70, 25);
      y += 30;
    } catch {}
  }

  y = 275;
  doc.setFillColor(18, 18, 18);
  doc.rect(0, y, 210, 22, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text(
    state.settings.company || "JobCost Pro — Licensed & Insured",
    105,
    y + 8,
    { align: "center" },
  );

  doc.save(
    `completion_cert_${job.name.replace(/[^a-z0-9]/gi, "_").slice(0, 40)}.pdf`,
  );
  toast.success("Certificate exported", job.name);
}

/* ─── Job Modal ──────────────────────────────── */
function openJobModal(job) {
  const isEdit = !!job;
  const STATUS = ["Lead", "Quoted", "Draft", "Active", "Completed", "Invoiced"];
  const PAYMENT_STATUS = ["Unpaid", "Partial", "Paid"];
  const tplOpts = state.templates.length
    ? `<option value="">— none —</option>` +
      state.templates
        .map((t) => `<option value="${t.id}">${esc(t.name)}</option>`)
        .join("")
    : null;

  const currentStatus = isEdit ? job.status : "Draft";
  const currentPayment = isEdit ? job.paymentStatus || "Unpaid" : "Unpaid";
  const currentCosts = isEdit ? jobCost(job) : 0;
  const clientDatalist = `<datalist id="fjClientList">${state.clients
    .map((c) => `<option value="${esc(c.name)}"></option>`)
    .join("")}</datalist>`;

  const m = modal.open(`
      <div class="modalHd">
        <div>
          <h2>${isEdit ? "Edit Job" : "New Job"}</h2>
          <p>${isEdit ? esc(job.name) : "Fill in the job details."}</p>
        </div>
        <button type="button" class="closeX" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modalBd">
        ${clientDatalist}
        <div class="fieldGrid">
          <div class="field">
            <label for="fjN">Job Name *</label>
            <input id="fjN" class="input" type="text" maxlength="120" placeholder="e.g. Kitchen Remodel" value="${isEdit ? esc(job.name) : ""}"/>
          </div>
          <div class="field">
            <label for="fjC">Client</label>
            <input id="fjC" class="input" type="text" maxlength="120" placeholder="Client name" list="fjClientList" value="${isEdit ? esc(job.client || "") : ""}"/>
          </div>
          <div class="field">
            <label for="fjSt">Status</label>
            <select id="fjSt">
              ${STATUS.map((s) => `<option value="${s}" ${currentStatus === s ? "selected" : ""}>${s}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="fjV">Estimated Value ($) <span id="markupDisplay" class="markupHint"></span></label>
            <input id="fjV" class="input" type="number" min="0" step="0.01" placeholder="0.00" value="${isEdit ? job.value || "" : ""}"/>
          </div>
          <div class="field">
            <label for="fjSD">Start Date</label>
            <input id="fjSD" class="input" type="date" value="${isEdit ? fmtDateInput(job.startDate) : ""}"/>
          </div>
          <div class="field">
            <label for="fjDL">Deadline</label>
            <input id="fjDL" class="input" type="date" value="${isEdit ? fmtDateInput(job.deadline) : ""}"/>
          </div>
          <div class="field">
            <label for="fjEH">Estimated Hours</label>
            <input id="fjEH" class="input" type="number" min="0" step="0.5" placeholder="e.g. 40" value="${isEdit ? job.estimatedHours || "" : ""}"/>
          </div>
          <div class="field">
            <label for="fjMi">Mileage (miles)</label>
            <input id="fjMi" class="input" type="number" min="0" step="0.1" placeholder="0" value="${isEdit ? job.mileage || "" : ""}"/>
            <p id="fjFuelEst" class="help fuelEstHint" style="margin-top:4px;"></p>
          </div>
          <div class="field" id="payStatusField" style="display:${currentStatus === "Invoiced" ? "block" : "none"};">
            <label for="fjPS">Payment Status</label>
            <select id="fjPS">
              ${PAYMENT_STATUS.map((s) => `<option value="${s}" ${currentPayment === s ? "selected" : ""}>${s}</option>`).join("")}
            </select>
          </div>
          <div class="field" id="paidDateField" style="display:${currentStatus === "Invoiced" && currentPayment === "Paid" ? "block" : "none"};">
            <label for="fjPD">Paid Date</label>
            <input id="fjPD" class="input" type="date" value="${isEdit ? fmtDateInput(job.paidDate) : ""}"/>
          </div>
          <div class="field">
            <label for="fjZip">ZIP Code</label>
            <input id="fjZip" class="input" type="text" maxlength="10" placeholder="e.g. 90210" value="${isEdit ? esc(job.zip || "") : ""}"/>
          </div>
          <div class="field">
            <label for="fjCity">City</label>
            <input id="fjCity" class="input" type="text" maxlength="80" placeholder="Auto-filled from ZIP" value="${isEdit ? esc(job.city || "") : ""}"/>
          </div>
          <div class="field">
            <label for="fjState">State</label>
            <input id="fjState" class="input" type="text" maxlength="30" placeholder="e.g. CA" value="${isEdit ? esc(job.state || "") : ""}"/>
          </div>
          <div class="field">
            <label for="fjTags">Tags <span class="muted" style="font-weight:400;">(comma-separated)</span></label>
            <input id="fjTags" class="input" type="text" maxlength="200" placeholder="e.g. plumbing, commercial, urgent" value="${isEdit ? (job.tags || []).join(", ") : ""}"/>
          </div>
          ${
            !isEdit && tplOpts
              ? `
          <div class="field">
            <label for="fjT">Apply Template</label>
            <select id="fjT">${tplOpts}</select>
          </div>`
              : ""
          }
        </div>
        <div class="sectionLabel" style="margin:14px 0 8px;">Insulation Spec</div>
        <div class="fieldGrid">
          <div class="field">
            <label for="fjIT">Insulation Type</label>
            <select id="fjIT">
              ${["Blown-in Fiberglass", "Blown-in Cellulose", "Spray Foam Open Cell", "Spray Foam Closed Cell", "Batt Fiberglass", "Batt Mineral Wool", "Radiant Barrier", "Other"].map((s) => `<option value="${s}" ${isEdit && job.insulationType === s ? "selected" : ""}>${s}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="fjAT">Area Type</label>
            <select id="fjAT">
              ${["Attic", "Walls", "Crawl Space", "Garage", "New Construction", "Other"].map((s) => `<option value="${s}" ${isEdit && job.areaType === s ? "selected" : ""}>${s}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="fjSqft">Square Feet</label>
            <input id="fjSqft" class="input" type="number" min="0" step="1" placeholder="e.g. 1200" value="${isEdit ? job.sqft || "" : ""}"/>
          </div>
          <div class="field">
            <label for="fjRVB">R-Value Before</label>
            <input id="fjRVB" class="input" type="number" min="0" step="1" placeholder="e.g. 11" value="${isEdit ? job.rValueBefore || "" : ""}"/>
          </div>
          <div class="field">
            <label for="fjRVT">R-Value Target</label>
            <input id="fjRVT" class="input" type="number" min="0" step="1" placeholder="e.g. 38" value="${isEdit ? job.rValueTarget || "" : ""}"/>
          </div>
          <div class="field">
            <label for="fjRVA">R-Value Achieved</label>
            <input id="fjRVA" class="input" type="number" min="0" step="1" placeholder="Fill on completion" value="${isEdit ? job.rValueAchieved || "" : ""}"/>
          </div>
          <div class="field">
            <label for="fjDI">Depth (inches)</label>
            <input id="fjDI" class="input" type="number" min="0" step="0.5" placeholder="e.g. 14" value="${isEdit ? job.depthInches || "" : ""}"/>
          </div>
          <div class="field">
            <label for="fjTaxR">Tax Rate (%)</label>
            <input id="fjTaxR" class="input" type="number" min="0" step="0.01" placeholder="0" value="${isEdit ? job.taxRate || 0 : 0}"/>
          </div>
          <div class="field">
            <label for="fjRef">Referral Source</label>
            <select id="fjRef">
              ${["Referral", "Google", "Facebook/Social", "Door Knock", "Home Show", "Repeat Customer", "Contractor Referral", "Other"].map((s) => `<option value="${s}" ${isEdit && job.referralSource === s ? "selected" : ""}>${s}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="fjQR">Quality Rating</label>
            <select id="fjQR">
              ${["", "1 ⭐", "2 ⭐⭐", "3 ⭐⭐⭐", "4 ⭐⭐⭐⭐", "5 ⭐⭐⭐⭐⭐"].map((s) => `<option value="${s}" ${isEdit && job.qualityRating === s ? "selected" : ""}>${s || "— not rated —"}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="fjFU">Follow-Up Date</label>
            <input id="fjFU" class="input" type="date" value="${isEdit ? fmtDateInput(job.followUpDate) : ""}"/>
          </div>
          <div class="field">
            <label for="fjRebSrc">Rebate Source</label>
            <select id="fjRebSrc">
              ${["None", "FPL Rebate", "Duke Energy Florida", "HERO Program", "Other"].map((s) => `<option value="${s}" ${isEdit && job.rebateSource === s ? "selected" : ""}>${s}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="fjRebAmt">Rebate Amount ($)</label>
            <input id="fjRebAmt" class="input" type="number" min="0" step="0.01" placeholder="0" value="${isEdit ? job.rebateAmount || "" : ""}"/>
          </div>
          <div class="field">
            <label for="fjRebSt">Rebate Status</label>
            <select id="fjRebSt">
              ${["N/A", "Submitted", "Approved", "Received"].map((s) => `<option value="${s}" ${isEdit && job.rebateStatus === s ? "selected" : ""}>${s}</option>`).join("")}
            </select>
          </div>
          <div class="field" style="grid-column:1/-1;">
            <label>Assign Crew</label>
            <div id="fjCrewList" style="display:flex;flex-wrap:wrap;gap:8px;padding:6px 0;">
              ${state.crew.length === 0 ? `<span class="muted" style="font-size:12px;">No crew members yet. Add them in the Crew section.</span>` : state.crew.map((c) => `<label style="display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer;"><input type="checkbox" value="${c.id}" ${isEdit && (job.crewIds || []).includes(c.id) ? "checked" : ""}/> ${esc(c.name)} <span class="muted" style="font-size:11px;">(${esc(c.role || "")})</span></label>`).join("")}
            </div>
          </div>
          <div class="field" style="grid-column:1/-1;background:var(--bg2);border-radius:10px;padding:10px 14px;" id="matCalcDisplay"></div>
          <div class="field" style="grid-column:1/-1;">
            <label for="fjNo">Notes</label>
            <textarea id="fjNo" placeholder="Description, notes…">${isEdit ? esc(job.notes || "") : ""}</textarea>
          </div>
        </div>
      </div>
      <div class="modalFt">
        <button type="button" class="btn" id="fjCancel">Cancel</button>
        <button type="button" class="btn primary" id="fjSave">${isEdit ? "Save Changes" : "Create Job"}</button>
      </div>`);

  /* Live markup hint */
  const updateMarkup = () => {
    const val = parseFloat(m.querySelector("#fjV").value) || 0;
    const hint = m.querySelector("#markupDisplay");
    if (!hint) return;
    if (val > 0 && currentCosts > 0) {
      const pct = (((val - currentCosts) / val) * 100).toFixed(1);
      hint.textContent = `(${pct >= 0 ? "+" : ""}${pct}% margin)`;
      hint.style.color = Number(pct) >= 0 ? "var(--ok)" : "var(--danger)";
    } else {
      hint.textContent = "";
    }
  };
  m.querySelector("#fjV")?.addEventListener("input", updateMarkup);
  updateMarkup();

  /* Material calculator live update */
  const updateMatCalc = () => {
    const display = m.querySelector("#matCalcDisplay");
    if (!display) return;
    const it = m.querySelector("#fjIT")?.value;
    const sqft = parseFloat(m.querySelector("#fjSqft")?.value) || 0;
    const rvt = parseFloat(m.querySelector("#fjRVT")?.value) || 0;
    if (!sqft || !rvt || !it) {
      display.innerHTML = `<span class="muted" style="font-size:12px;">Enter insulation type, sq ft, and R-value target to see material estimate.</span>`;
      return;
    }
    const result = calcMaterials(it, sqft, rvt);
    if (result) {
      display.innerHTML = `<span style="font-size:13px;font-weight:600;">Estimated Materials: <span style="color:var(--primary);">${result.qty} ${result.unit}</span></span> <span class="muted" style="font-size:11px;">(${it})</span>`;
    } else {
      display.innerHTML = `<span class="muted" style="font-size:12px;">Material estimate not available for selected type.</span>`;
    }
  };
  m.querySelector("#fjIT")?.addEventListener("change", updateMatCalc);
  m.querySelector("#fjSqft")?.addEventListener("input", updateMatCalc);
  m.querySelector("#fjRVT")?.addEventListener("input", updateMatCalc);
  updateMatCalc();

  /* Live fuel cost estimate */
  const fuelHint = m.querySelector("#fjFuelEst");
  const miInput = m.querySelector("#fjMi");
  function updateFuelHint() {
    const miles = parseFloat(miInput?.value) || 0;
    const mpg = state.settings.mpg || 15;
    const gasPrice = state.settings.gasPrice || 3.5;
    if (!fuelHint) return;
    if (miles <= 0) {
      fuelHint.textContent = "";
      return;
    }
    const gallons = miles / mpg;
    const cost = gallons * gasPrice;
    fuelHint.textContent = `⛽ Est. Fuel: ${gallons.toFixed(2)} gal (~${fmt(cost)})`;
  }
  miInput?.addEventListener("input", updateFuelHint);
  updateFuelHint();

  /* Show/hide payment fields */
  const statusSel = m.querySelector("#fjSt");
  const payField = m.querySelector("#payStatusField");
  const paidDateField = m.querySelector("#paidDateField");
  const payStatusSel = m.querySelector("#fjPS");
  statusSel?.addEventListener("change", () => {
    const inv = statusSel.value === "Invoiced";
    payField.style.display = inv ? "block" : "none";
    paidDateField.style.display =
      inv && payStatusSel.value === "Paid" ? "block" : "none";
  });
  payStatusSel?.addEventListener("change", () => {
    paidDateField.style.display =
      payStatusSel.value === "Paid" ? "block" : "none";
  });

  /* ZIP code auto-fill */
  m.querySelector("#fjZip")?.addEventListener("blur", () => {
    const zip = m.querySelector("#fjZip").value.trim();
    lookupZIP(zip, (city, st) => {
      if (!m.querySelector("#fjCity").value)
        m.querySelector("#fjCity").value = city;
      if (!m.querySelector("#fjState").value)
        m.querySelector("#fjState").value = st;
    });
  });

  m.querySelector("#fjCancel").addEventListener("click", modal.close);
  m.querySelector("#fjSave").addEventListener("click", () => {
    const nEl = m.querySelector("#fjN");
    const name = nEl.value.trim();
    if (!name) {
      nEl.classList.add("invalid");
      nEl.focus();
      return;
    }
    nEl.classList.remove("invalid");

    const tplId = m.querySelector("#fjT")?.value;
    const tpl = tplId ? state.templates.find((t) => t.id === tplId) : null;
    const newStatus = statusSel.value;
    const newPayStatus = payStatusSel?.value || "Unpaid";

    /* Track status history */
    let statusHistory = isEdit
      ? job.statusHistory || [{ status: job.status, date: job.date }]
      : [{ status: newStatus, date: Date.now() }];
    if (isEdit && job.status !== newStatus) {
      statusHistory = [
        ...statusHistory,
        { status: newStatus, date: Date.now() },
      ];
    }

    /* Auto-generate invoice number */
    let invoiceNumber = isEdit ? job.invoiceNumber || null : null;
    if (newStatus === "Invoiced" && !invoiceNumber) {
      invoiceNumber = getNextInvoiceNumber();
    }

    /* Parse tags */
    const tagsRaw = m.querySelector("#fjTags").value.trim();
    const tags = tagsRaw
      ? tagsRaw
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

    /* Client ID lookup */
    const clientName = m.querySelector("#fjC").value.trim();
    const matchedClient = state.clients.find(
      (c) => c.name.toLowerCase() === clientName.toLowerCase(),
    );
    const clientId = matchedClient
      ? matchedClient.id
      : isEdit
        ? job.clientId || null
        : null;

    /* Collect selected crew IDs */
    const crewIds = Array.from(
      m.querySelectorAll("#fjCrewList input[type=checkbox]:checked"),
    ).map((cb) => cb.value);

    const saved = {
      id: isEdit ? job.id : uid(),
      name,
      client: clientName,
      clientId,
      status: newStatus,
      value: parseFloat(m.querySelector("#fjV").value) || 0,
      startDate: parseDate(m.querySelector("#fjSD").value),
      deadline: parseDate(m.querySelector("#fjDL").value),
      estimatedHours: parseFloat(m.querySelector("#fjEH").value) || null,
      mileage: parseFloat(m.querySelector("#fjMi").value) || 0,
      tags,
      paymentStatus: newPayStatus,
      paidDate:
        newPayStatus === "Paid"
          ? parseDate(m.querySelector("#fjPD").value)
          : null,
      invoiceNumber,
      notes: m.querySelector("#fjNo").value.trim(),
      zip: m.querySelector("#fjZip").value.trim(),
      city: m.querySelector("#fjCity").value.trim(),
      state: m.querySelector("#fjState").value.trim(),
      date: isEdit ? job.date : Date.now(),
      costs: isEdit
        ? job.costs || []
        : tpl
          ? tpl.costs.map((c) => ({ ...c, id: uid() }))
          : [],
      photos: isEdit ? job.photos || [] : [],
      statusHistory,
      checklist: isEdit ? job.checklist || {} : {},
      signature: isEdit ? job.signature || null : null,
      insulationType: m.querySelector("#fjIT").value,
      areaType: m.querySelector("#fjAT").value,
      sqft: parseFloat(m.querySelector("#fjSqft").value) || null,
      rValueBefore: parseFloat(m.querySelector("#fjRVB").value) || null,
      rValueTarget: parseFloat(m.querySelector("#fjRVT").value) || null,
      rValueAchieved: parseFloat(m.querySelector("#fjRVA").value) || null,
      depthInches: parseFloat(m.querySelector("#fjDI").value) || null,
      taxRate: parseFloat(m.querySelector("#fjTaxR").value) || 0,
      referralSource: m.querySelector("#fjRef").value,
      qualityRating: m.querySelector("#fjQR").value,
      followUpDate: parseDate(m.querySelector("#fjFU").value),
      rebateSource: m.querySelector("#fjRebSrc").value,
      rebateAmount: parseFloat(m.querySelector("#fjRebAmt").value) || 0,
      rebateStatus: m.querySelector("#fjRebSt").value,
      crewIds,
    };

    /* Auto-save new client */
    if (clientName && !matchedClient) {
      saveClient({
        id: uid(),
        name: clientName,
        phone: "",
        email: "",
        date: Date.now(),
      }).catch(() => {});
    }

    /* Auto-create / update "Fuel/Travel" cost item from mileage */
    if (saved.mileage > 0) {
      const mpg = state.settings.mpg || 15;
      const gasPrice = state.settings.gasPrice || 3.5;
      const fuelCost = parseFloat(
        ((saved.mileage / mpg) * gasPrice).toFixed(2),
      );
      const fuelIdx = saved.costs.findIndex(
        (c) =>
          c.category === "Fuel/Travel" ||
          c.description?.toLowerCase().includes("fuel"),
      );
      if (fuelIdx !== -1) {
        /* Update existing entry */
        saved.costs[fuelIdx] = {
          ...saved.costs[fuelIdx],
          qty: 1,
          unitCost: fuelCost,
        };
      } else {
        /* Create new entry */
        saved.costs.push({
          id: uid(),
          description: "Fuel/Travel",
          category: "Fuel/Travel",
          qty: 1,
          unitCost: fuelCost,
        });
      }
    }

    saveJob(saved)
      .then(() => {
        toast.success(isEdit ? "Job updated" : "Job created", saved.name);
        if (invoiceNumber && (!isEdit || !job.invoiceNumber))
          toast.info("Invoice", `Assigned ${invoiceNumber}`);
        modal.close();
        render();
      })
      .catch(() => toast.error("Save error", "Could not save the job."));
  });
}

/* ─── Job Detail Modal (tabbed) ──────────────── */
function openJobDetailModal(job) {
  let tab = "overview";
  let editingCostIdx = -1;
  const CATS = ["Materials", "Labor", "Subcontracted", "Other"];

  const getTC = () => jobCost(job);
  const getMargin = () => (job.value || 0) - getTC();
  const getPct = () =>
    job.value ? ((getMargin() / job.value) * 100).toFixed(1) : null;
  const getJobLogs = () => state.timeLogs.filter((l) => l.jobId === job.id);
  const getRealHrs = () => getJobLogs().reduce((s, l) => s + (l.hours || 0), 0);

  /* Tab: Overview */
  const overviewHTML = () => {
    const tc = getTC(),
      mg = getMargin(),
      pct = getPct();
    const realHrs = getRealHrs();
    const history = job.statusHistory || [];
    const deadlinePast =
      job.deadline &&
      job.deadline < Date.now() &&
      !["Completed", "Invoiced"].includes(job.status);
    const deadlineHoliday = job.deadline ? isUSHoliday(job.deadline) : null;
    return `
        <div class="fieldGrid" style="margin-bottom:16px;">
          <div class="field"><label>Client</label>
            <div class="infoVal">${esc(job.client || "—")}</div></div>
          <div class="field"><label>Status</label>
            <div style="padding:4px 0;"><span class="badge status-${job.status.toLowerCase()}">${job.status}</span></div></div>
          <div class="field"><label>Start Date</label>
            <div class="infoVal muted">${fmtDate(job.startDate)}</div></div>
          <div class="field"><label>Deadline</label>
            <div class="infoVal ${deadlinePast ? "deadlineWarn" : "muted"}">${fmtDate(job.deadline)}${deadlinePast ? " ⚠" : ""}${deadlineHoliday ? ` 🎉 ${esc(deadlineHoliday.localName)}` : ""}</div></div>
          <div class="field"><label>Estimated Value</label>
            <div class="infoVal bigVal">${fmt(job.value)}</div></div>
          <div class="field"><label>Created</label>
            <div class="infoVal muted">${fmtDate(job.date)}</div></div>
          ${
            job.city || job.state
              ? `
          <div class="field"><label>Location</label>
            <div class="infoVal">${[job.city, job.state, job.zip].filter(Boolean).join(", ") || "—"}</div></div>`
              : ""
          }
          ${
            job.estimatedHours
              ? `
          <div class="field"><label>Estimated Hours</label>
            <div class="infoVal">${job.estimatedHours}h</div></div>
          <div class="field"><label>Actual Hours</label>
            <div class="infoVal" style="color:${realHrs > job.estimatedHours ? "var(--danger)" : "var(--ok)"};">
              ${realHrs.toFixed(2)}h ${realHrs > job.estimatedHours ? "⚠ Over budget" : "✓"}
            </div></div>`
              : ""
          }
          ${
            job.tags && job.tags.length
              ? `
          <div class="field" style="grid-column:1/-1;"><label>Tags</label>
            <div class="tagsList">${job.tags.map((t) => `<span class="tagPill">${esc(t)}</span>`).join("")}</div></div>`
              : ""
          }
          ${
            job.mileage
              ? `
          <div class="field"><label>Mileage</label>
            <div class="infoVal">${job.mileage} mi · <span class="muted">$${(job.mileage * (state.settings.mileageRate || 0.67)).toFixed(2)} IRS deduction</span></div></div>`
              : ""
          }
          ${
            job.invoiceNumber
              ? `
          <div class="field"><label>Invoice #</label>
            <div class="infoVal">${esc(job.invoiceNumber)}</div></div>`
              : ""
          }
          ${
            job.status === "Invoiced"
              ? `
          <div class="field"><label>Payment</label>
            <div class="infoVal"><span class="badge payment-${(job.paymentStatus || "unpaid").toLowerCase()}">${job.paymentStatus || "Unpaid"}</span>${job.paidDate ? ` · Paid ${fmtDate(job.paidDate)}` : ""}</div></div>`
              : ""
          }
          ${
            job.notes
              ? `
          <div class="field" style="grid-column:1/-1;"><label>Notes</label>
            <div class="notesBox">${esc(job.notes)}</div></div>`
              : ""
          }
        </div>
        <div class="summary" style="margin-bottom:16px;">
          <div class="summaryRow"><span class="k">Total Item Cost</span><strong>${fmt(tc)}</strong></div>
          <div class="summaryRow"><span class="k">Estimated Value</span><strong>${fmt(job.value)}</strong></div>
          <div class="summaryRow total">
            <span class="k">Profit / Loss</span>
            <strong style="color:${mg >= 0 ? "var(--ok)" : "var(--danger)"}">
              ${fmt(mg)}${pct !== null ? ` (${pct}%)` : ""}
            </strong>
          </div>
        </div>
        ${
          history.length > 1
            ? `
        <div class="historyBlock">
          <div class="historyTitle">STATUS HISTORY</div>
          <div class="historyList">
            ${history
              .map(
                (h) => `
              <div class="historyRow">
                <span class="muted" style="font-size:12px;">${fmtDate(h.date)}</span>
                <span class="badge status-${(h.status || "draft").toLowerCase()}">${h.status}</span>
              </div>`,
              )
              .join("")}
          </div>
        </div>`
            : ""
        }`;
  };

  /* Tab: Costs */
  const costsHTML = () => {
    const costs = job.costs || [];
    const tc = getTC(),
      mg = getMargin(),
      pct = getPct();
    const rows =
      costs.length === 0
        ? `<tr><td colspan="7" class="muted" style="padding:18px;text-align:center;">No cost items yet.</td></tr>`
        : costs
            .map((c, i) => {
              if (i === editingCostIdx) {
                return `
            <tr class="editingRow">
              <td><input class="input" id="ecD" type="text" maxlength="100" value="${esc(c.description)}" style="min-width:100px;"/></td>
              <td><select id="ecC" class="input">${CATS.map((cat) => `<option${c.category === cat ? " selected" : ""}>${cat}</option>`).join("")}</select></td>
              <td><input class="input" id="ecQ" type="number" min="0.01" step="0.01" value="${c.qty}" style="width:60px;"/></td>
              <td><input class="input" id="ecU" type="number" min="0" step="0.01" value="${c.unitCost}" style="width:80px;"/></td>
              <td style="text-align:right;"><strong>${fmt((c.qty || 0) * (c.unitCost || 0))}</strong></td>
              <td>
                <button class="btn primary" data-svedit="${i}" style="padding:4px 9px;font-size:11px;">Save</button>
                <button class="btn" data-canceledit style="padding:4px 9px;font-size:11px;">Cancel</button>
              </td>
              <td></td>
            </tr>`;
              }
              return `
            <tr>
              <td>${esc(c.description)}</td>
              <td><span class="badge">${esc(c.category || "")}</span></td>
              <td style="text-align:right;">${c.qty}</td>
              <td style="text-align:right;">${fmt(c.unitCost)}</td>
              <td style="text-align:right;"><strong>${fmt((c.qty || 0) * (c.unitCost || 0))}</strong></td>
              <td>
                <button class="btn" data-eci="${i}" style="padding:4px 9px;font-size:11px;">Edit</button>
              </td>
              <td>
                <button class="btn danger" data-dci="${i}" style="padding:4px 9px;font-size:11px;">Remove</button>
              </td>
            </tr>`;
            })
            .join("");
    return `
        <div class="tableWrap" style="margin-bottom:14px;">
          <table class="table">
            <thead><tr>
              <th>Description</th><th>Category</th>
              <th style="text-align:right;">Qty</th>
              <th style="text-align:right;">Unit Cost</th>
              <th style="text-align:right;">Total</th>
              <th></th><th></th>
            </tr></thead>
            <tbody id="costTbody">${rows}</tbody>
          </table>
        </div>
        <div class="addCostGrid">
          <div class="field"><label for="fcD">Description</label><input id="fcD" class="input" type="text" maxlength="100" placeholder="e.g. Drywall"/></div>
          <div class="field"><label for="fcC">Category</label><select id="fcC">${CATS.map((c) => `<option>${c}</option>`).join("")}</select></div>
          <div class="field"><label for="fcQ">Qty</label><input id="fcQ" class="input" type="number" min="0.01" step="0.01" value="1"/></div>
          <div class="field"><label for="fcU">Unit Cost ($)</label><input id="fcU" class="input" type="number" min="0" step="0.01" placeholder="0.00"/></div>
          <div class="field addCostBtn"><label style="visibility:hidden">a</label><button type="button" class="btn primary" id="btnAC">+ Add</button></div>
        </div>
        <div class="summary">
          <div class="summaryRow"><span class="k">Total Cost</span><strong>${fmt(tc)}</strong></div>
          <div class="summaryRow"><span class="k">Estimated Value</span><strong>${fmt(job.value)}</strong></div>
          <div class="summaryRow total">
            <span class="k">Profit / Loss</span>
            <strong style="color:${mg >= 0 ? "var(--ok)" : "var(--danger)"}">
              ${fmt(mg)}${pct !== null ? ` (${pct}%)` : ""}
            </strong>
          </div>
        </div>`;
  };

  /* Tab: Time Logs */
  const timelogsHTML = () => {
    const logs = state.timeLogs
      .filter((l) => l.jobId === job.id)
      .sort((a, b) => b.date - a.date);
    const total = logs.reduce((s, l) => s + (l.hours || 0), 0);
    const crewOpts = state.crew.length
      ? `<option value="">— Unassigned —</option>` +
        state.crew
          .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`)
          .join("")
      : `<option value="">No crew members</option>`;
    const tableSection =
      logs.length === 0
        ? `<div class="empty" style="margin-bottom:16px;">No time logs yet. Add hours manually below.</div>`
        : `
        <div class="tableWrap" style="margin-bottom:14px;">
          <table class="table">
            <thead><tr>
              <th>Date</th>
              <th>Crew Member</th>
              <th style="text-align:right;">Hours</th>
              <th>Note</th>
              <th></th>
            </tr></thead>
            <tbody>
              ${logs
                .map((l) => {
                  const member = l.crewId
                    ? state.crew.find((c) => c.id === l.crewId)
                    : null;
                  const pinLink =
                    l.lat && l.lng
                      ? `<a href="https://maps.google.com/?q=${l.lat},${l.lng}" target="_blank" rel="noopener" class="mapPinLink" title="View location (${l.lat.toFixed(4)}, ${l.lng.toFixed(4)})">
                        <svg viewBox="0 0 24 24" fill="none" width="14" height="14" style="vertical-align:middle;">
                          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7Z" stroke="currentColor" stroke-width="1.6"/>
                          <circle cx="12" cy="9" r="2.5" stroke="currentColor" stroke-width="1.6"/>
                        </svg>
                      </a>`
                      : "";
                  return `
                <tr>
                  <td>${fmtDate(l.date)}${pinLink}</td>
                  <td><span class="small">${member ? esc(member.name) : `<span class="faint">—</span>`}</span></td>
                  <td style="text-align:right;"><strong>${(l.hours || 0).toFixed(2)}h</strong></td>
                  <td><span class="small">${l.note ? esc(l.note) : `<span class="faint">—</span>`}</span></td>
                  <td>
                    <button class="btn danger" data-dtl="${l.id}" style="padding:4px 10px;font-size:11px;">Remove</button>
                  </td>
                </tr>`;
                })
                .join("")}
            </tbody>
          </table>
        </div>
        <div class="summaryRow" style="margin-bottom:16px;">
          <span class="k">Total Logged</span>
          <strong>${total.toFixed(2)}h${job.estimatedHours ? ` / ${job.estimatedHours}h estimated` : ""}</strong>
        </div>`;
    return (
      tableSection +
      `
        <div class="sectionLabel">Add Manual Entry</div>
        <div class="addCostGrid">
          <div class="field"><label for="mtDate">Date</label><input id="mtDate" class="input" type="date" value="${fmtDateInput(Date.now())}"/></div>
          <div class="field"><label for="mtCrew">Crew Member</label><select id="mtCrew" class="input">${crewOpts}</select></div>
          <div class="field"><label for="mtHrs">Hours</label><input id="mtHrs" class="input" type="number" min="0.1" step="0.1" placeholder="e.g. 4.5"/></div>
          <div class="field"><label for="mtNote">Note (optional)</label><input id="mtNote" class="input" type="text" maxlength="200" placeholder="What was done…"/></div>
          <div class="field addCostBtn"><label style="visibility:hidden">a</label><button type="button" class="btn primary" id="btnMTAdd">+ Add Hours</button></div>
        </div>`
    );
  };

  /* Tab: Photos */
  const photosHTML = () => {
    const photos = job.photos || [];
    const beforePhotos = photos.filter((p) => p.type === "before");
    const afterPhotos = photos.filter((p) => p.type === "after");
    const otherPhotos = photos.filter(
      (p) => !p.type || (p.type !== "before" && p.type !== "after"),
    );
    const isOffline = !navigator.onLine;
    const renderPhotoGroup = (group) =>
      group
        .map(
          (p) => `
        <div class="photoThumb">
          <img src="${p.data || p.dataUrl || ""}" alt="${esc(p.name || p.caption || "Photo")}" loading="lazy" data-pid="${p.id}"/>
          ${p.caption ? `<div class="photoCaption">${esc(p.caption)}</div>` : ""}
          <div class="photoTypeRow">
            <button class="photoTypeBtn${p.type === "before" ? " active" : ""}" data-ptype="before" data-pid="${p.id}" title="Mark as Before">B</button>
            <button class="photoTypeBtn${p.type === "after" ? " active" : ""}" data-ptype="after" data-pid="${p.id}" title="Mark as After">A</button>
          </div>
          <button class="photoDelBtn" data-pid="${p.id}" aria-label="Remove photo">✕</button>
        </div>`,
        )
        .join("");
    return `
        ${isOffline ? `<div class="alertBanner" style="margin-bottom:10px;font-size:12px;">📴 Offline — photos saved locally. Sync pending when connection restores.</div>` : ""}
        <div class="photosHeader">
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <label class="btn photoAddBtn" style="cursor:pointer;">
              <svg viewBox="0 0 24 24" fill="none" width="16" height="16" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              Before Photo
              <input type="file" id="photoInputBefore" accept="image/*" multiple data-phototype="before" style="display:none;"/>
            </label>
            <label class="btn photoAddBtn" style="cursor:pointer;">
              <svg viewBox="0 0 24 24" fill="none" width="16" height="16" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              After Photo
              <input type="file" id="photoInputAfter" accept="image/*" multiple data-phototype="after" style="display:none;"/>
            </label>
          </div>
          <span class="small">${photos.length}/10 photos</span>
        </div>
        ${
          photos.length === 0
            ? `<div class="empty">No photos added yet.<br><span class="small">Photos are stored locally on this device.</span></div>`
            : `
          ${beforePhotos.length ? `<div class="sectionLabel" style="margin:10px 0 6px;">Before</div><div class="photoGrid">${renderPhotoGroup(beforePhotos)}</div>` : ""}
          ${afterPhotos.length ? `<div class="sectionLabel" style="margin:10px 0 6px;">After</div><div class="photoGrid">${renderPhotoGroup(afterPhotos)}</div>` : ""}
          ${otherPhotos.length ? `<div class="sectionLabel" style="margin:10px 0 6px;">Photos</div><div class="photoGrid">${renderPhotoGroup(otherPhotos)}</div>` : ""}
          `
        }`;
  };

  /* Tab: Spec */
  const specHTML = () => {
    const flResult = checkFLCode(job.areaType, job.rValueAchieved);
    const savings = calcUtilitySavings(
      job.sqft,
      job.rValueBefore,
      job.rValueAchieved,
    );
    const matResult = calcMaterials(
      job.insulationType,
      job.sqft,
      job.rValueAchieved || job.rValueTarget,
    );
    const row = (lbl, val) =>
      `<div class="specRow"><div class="specLbl">${lbl}</div><div class="specVal">${val || `<span class="faint">—</span>`}</div></div>`;
    return `
        <div class="specGrid">
          ${row("Insulation Type", esc(job.insulationType || ""))}
          ${row("Area Type", esc(job.areaType || ""))}
          ${row("Square Feet", job.sqft ? `${job.sqft} sq ft` : "")}
          ${row("R-Value Before", job.rValueBefore ? `R-${job.rValueBefore}` : "")}
          ${row("R-Value Target", job.rValueTarget ? `R-${job.rValueTarget}` : "")}
          ${row("R-Value Achieved", job.rValueAchieved ? `R-${job.rValueAchieved}` : "")}
          ${row("Depth", job.depthInches ? `${job.depthInches}"` : "")}
          ${row("Referral Source", esc(job.referralSource || ""))}
          ${row("Quality Rating", esc(job.qualityRating || ""))}
          ${row("Follow-Up Date", job.followUpDate ? fmtDate(job.followUpDate) : "")}
          ${row("Rebate Source", esc(job.rebateSource || ""))}
          ${row("Rebate Amount", job.rebateAmount ? fmt(job.rebateAmount) : "")}
          ${row("Rebate Status", esc(job.rebateStatus || ""))}
          ${row("Tax Rate", job.taxRate ? `${job.taxRate}%` : "0%")}
        </div>
        ${
          flResult !== null
            ? `
        <div style="margin-bottom:12px;">
          <span class="specLbl">FL Energy Code (Zone 2)</span><br>
          <span class="codeBadge ${flResult.pass ? "pass" : "fail"}" style="margin-top:4px;">
            ${flResult.pass ? `✓ PASS — R-${flResult.min} minimum met` : `✗ FAIL — Minimum R-${flResult.min} not met`}
          </span>
        </div>`
            : ""
        }
        ${
          savings
            ? `
        <div style="margin-bottom:12px;background:rgba(75,227,163,.06);border-radius:10px;padding:10px 14px;">
          <div class="specLbl" style="margin-bottom:4px;">Estimated Annual Utility Savings</div>
          <div style="font-size:15px;font-weight:700;color:var(--ok);">~$${savings.dollarSaved}/year</div>
          <div class="muted" style="font-size:12px;">~${savings.kwhSaved} kWh/year · Based on FL avg. $0.12/kWh</div>
        </div>`
            : ""
        }
        ${
          matResult
            ? `
        <div style="margin-bottom:12px;">
          <span class="specLbl">Material Estimate</span><br>
          <span style="font-size:14px;font-weight:600;color:var(--primary);">${matResult.qty} ${matResult.unit}</span>
          <span class="muted" style="font-size:12px;"> of ${matResult.insulationType}</span>
        </div>`
            : ""
        }
        ${
          job.crewIds && job.crewIds.length
            ? `
        <div>
          <span class="specLbl">Assigned Crew</span><br>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">
            ${job.crewIds
              .map((id) => {
                const m = state.crew.find((c) => c.id === id);
                return m
                  ? `<span class="badge crew-active">${esc(m.name)}</span>`
                  : "";
              })
              .join("")}
          </div>
        </div>`
            : ""
        }`;
  };

  /* Tab: Checklist */
  const PRE_ITEMS = [
    "PPE checked (respirator, goggles, gloves)",
    "Equipment tested and operational",
    "Attic/area access confirmed",
    "Materials quantity verified",
    "Customer briefed on process",
  ];
  const POST_ITEMS = [
    "Area cleaned and debris removed",
    "Photos taken (before & after)",
    "R-value depth measurement confirmed",
    "Customer walkthrough completed",
    "Customer signature obtained",
  ];

  const checklistHTML = () => {
    const cl = job.checklist || {};
    const renderItems = (items, prefix) =>
      items
        .map((item, i) => {
          const key = `${prefix}_${i}`;
          const done = !!cl[key];
          return `<label class="checkItem${done ? " done" : ""}" data-clkey="${key}">
          <input type="checkbox" ${done ? "checked" : ""} data-clkey="${key}"/>
          <label>${esc(item)}</label>
        </label>`;
        })
        .join("");
    return `
        <div class="checklistSection">
          <div class="checklistTitle">Pre-Job Checklist</div>
          ${renderItems(PRE_ITEMS, "pre")}
        </div>
        <div class="checklistSection">
          <div class="checklistTitle">Post-Job Checklist</div>
          ${renderItems(POST_ITEMS, "post")}
        </div>
        <div style="margin-top:16px;">
          <div class="checklistTitle" style="margin-bottom:8px;">Customer Signature</div>
          ${job.signature ? `<div style="margin-bottom:8px;"><img src="${job.signature}" class="sigSaved" alt="Signature"/></div>` : ""}
          <div class="sigWrap"><canvas id="sigCanvas" class="sigCanvas"></canvas></div>
          <div class="sigActions">
            <button type="button" class="btn" id="btnSigClear">Clear</button>
            <button type="button" class="btn primary" id="btnSigSave">Save Signature</button>
          </div>
        </div>`;
  };

  const profitHTML = () => {
    const revenue = job.value || job.revenue || 0;
    const totalCost = jobCost(job);
    const grossProfit = revenue - totalCost;
    const margin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
    const minMargin = state.settings.minMargin ?? 30;
    const marginOk = margin >= minMargin;
    const marginColor =
      margin >= minMargin
        ? "var(--ok)"
        : margin >= minMargin * 0.7
          ? "var(--warn)"
          : "var(--danger)";

    const jobLogs = state.timeLogs.filter((l) => l.jobId === job.id);
    const totalHrs = jobLogs.reduce((s, l) => s + (l.hours || 0), 0);

    const completedJobs = state.jobs.filter(
      (j) => ["Completed", "Invoiced"].includes(j.status) && j.value > 0,
    );
    const avgMargin = completedJobs.length
      ? completedJobs.reduce((s, j) => {
          const c = jobCost(j);
          const v = j.value || 0;
          return s + (v > 0 ? ((v - c) / v) * 100 : 0);
        }, 0) / completedJobs.length
      : null;

    const barPct = Math.max(0, Math.min(100, margin));

    return `
      <div style="display:flex;flex-direction:column;gap:16px;padding:4px 0;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div class="card cardBody" style="text-align:center;">
            <div style="font-size:11px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em;">Revenue</div>
            <div style="font-size:22px;font-weight:800;color:var(--text);">${fmt(revenue)}</div>
          </div>
          <div class="card cardBody" style="text-align:center;">
            <div style="font-size:11px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em;">Total Cost</div>
            <div style="font-size:22px;font-weight:800;color:var(--text);">${fmt(totalCost)}</div>
          </div>
          <div class="card cardBody" style="text-align:center;">
            <div style="font-size:11px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em;">Gross Profit</div>
            <div style="font-size:22px;font-weight:800;color:${grossProfit >= 0 ? "var(--ok)" : "var(--danger)"};">${fmt(grossProfit)}</div>
          </div>
          <div class="card cardBody" style="text-align:center;">
            <div style="font-size:11px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em;">Margin</div>
            <div style="font-size:22px;font-weight:800;color:${marginColor};">${margin.toFixed(1)}%</div>
          </div>
        </div>
        <div class="card cardBody">
          <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:8px;">
            <span>Profit Margin</span>
            <span>Target: ${minMargin}%</span>
          </div>
          <div style="height:12px;background:var(--bg2);border-radius:99px;overflow:hidden;position:relative;">
            <div style="height:100%;width:${barPct}%;background:${marginColor};border-radius:99px;transition:width .5s ease;"></div>
            <div style="position:absolute;top:0;bottom:0;left:${minMargin}%;width:2px;background:var(--faint);"></div>
          </div>
          <div style="margin-top:8px;font-size:12px;color:${marginColor};font-weight:600;">
            ${
              marginOk
                ? `✓ Above ${minMargin}% target — healthy margin`
                : `⚠ Below ${minMargin}% target — consider adjusting pricing`
            }
          </div>
        </div>
        <div class="card cardBody">
          <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:12px;">Cost Breakdown</div>
          ${
            (job.costs || []).length === 0
              ? `<div class="muted" style="font-size:13px;">No cost items added yet.</div>`
              : (job.costs || [])
                  .map((c) => {
                    const lineTotal = (c.qty || 0) * (c.unitCost || 0);
                    const pct =
                      totalCost > 0 ? (lineTotal / totalCost) * 100 : 0;
                    return `
                  <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
                    <div style="flex:1;min-width:0;">
                      <div style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(c.name || c.description || "—")}</div>
                      <div style="font-size:11px;color:var(--faint);">${c.qty} × ${fmt(c.unitCost)}</div>
                    </div>
                    <div style="font-size:12px;font-weight:700;color:var(--text);white-space:nowrap;">${fmt(lineTotal)}</div>
                    <div style="font-size:11px;color:var(--muted);white-space:nowrap;min-width:36px;text-align:right;">${pct.toFixed(0)}%</div>
                  </div>`;
                  })
                  .join("")
          }
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div class="card cardBody" style="text-align:center;">
            <div style="font-size:11px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em;">Hours Logged</div>
            <div style="font-size:20px;font-weight:800;color:var(--text);">${totalHrs.toFixed(1)}h</div>
            ${
              totalHrs > 0 && revenue > 0
                ? `<div style="font-size:11px;color:var(--faint);margin-top:2px;">${fmt(revenue / totalHrs)}/hr effective rate</div>`
                : ""
            }
          </div>
          <div class="card cardBody" style="text-align:center;">
            <div style="font-size:11px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em;">vs. Avg Margin</div>
            <div style="font-size:20px;font-weight:800;color:var(--text);">
              ${
                avgMargin !== null
                  ? `${margin - avgMargin >= 0 ? "+" : ""}${(margin - avgMargin).toFixed(1)}%`
                  : "—"
              }
            </div>
            ${
              avgMargin !== null
                ? `<div style="font-size:11px;color:var(--faint);margin-top:2px;">vs ${avgMargin.toFixed(1)}% avg</div>`
                : `<div style="font-size:11px;color:var(--faint);margin-top:2px;">No completed jobs yet</div>`
            }
          </div>
        </div>
        ${
          revenue === 0
            ? `
        <div class="alertBanner" style="font-size:13px;">
          ⚠ No estimated value set for this job. Add a value in Edit to see profit data.
        </div>`
            : ""
        }
      </div>`;
  };

  const TABS = [
    "overview",
    "costs",
    "timelogs",
    "photos",
    "spec",
    "checklist",
    "profit",
  ];
  const TAB_LABELS = {
    overview: "Overview",
    costs: "Costs",
    timelogs: "Hours",
    photos: "Photos",
    spec: "Spec",
    checklist: "Check",
    profit: "Profit",
  };

  const tabsHTML = () =>
    TABS.map(
      (id) =>
        `<button type="button" class="tab${tab === id ? " active" : ""}" data-tab="${id}">${TAB_LABELS[id]}</button>`,
    ).join("");

  const m = modal.open(`
      <div class="modalHd">
        <div>
          <h2>${esc(job.name)}</h2>
          <p>
            ${job.client ? `${esc(job.client)} · ` : ""}
            <span class="badge status-${job.status.toLowerCase()}" style="font-size:11px;padding:2px 8px;">${job.status}</span>
            ${job.deadline ? ` · Deadline: ${fmtDate(job.deadline)}` : ""}
          </p>
        </div>
        <button type="button" class="closeX" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modalBd">
        <div class="tabs" id="detailTabs">${tabsHTML()}</div>
        <div id="detailContent">${overviewHTML()}</div>
      </div>
      <div class="modalFt">
        <button type="button" class="btn admin-only" id="bjDup">Duplicate</button>
        <button type="button" class="btn admin-only" id="bjEdit">Edit</button>
        <button type="button" class="btn admin-only" id="bjQR" title="QR Clock-In">QR</button>
        <button type="button" class="btn admin-only" id="bjShareQR" title="Share job via QR">Share QR</button>
        <button type="button" class="btn admin-only" id="bjShare">Share</button>
        <button type="button" class="btn admin-only" id="bjInvoice">Invoice PDF</button>
        <button type="button" class="btn admin-only" id="bjWorkOrder">Work Order</button>
        <button type="button" class="btn primary admin-only" id="bjPDF">Report PDF</button>
        <button type="button" class="btn admin-only" id="bjCert">Completion Cert</button>
        <button type="button" class="btn admin-only" id="bjBAReport">Before &amp; After PDF</button>
        <button type="button" class="btn admin-only" id="bjPL">P&amp;L Report</button>
        ${["Completed", "Invoiced"].includes(job.status) ? `<button type="button" class="btn admin-only" id="bjWarranty">Warranty Cert</button>` : ""}
        ${["Completed", "Invoiced"].includes(job.status) ? `<button type="button" class="btn admin-only" id="bjReview">Request Review</button>` : ""}
        <button type="button" class="btn admin-only" id="bjInspect">Schedule Inspection</button>
        <button type="button" class="btn" id="bjClose">Close</button>
      </div>`);

  function switchTab(newTab) {
    tab = newTab;
    m.querySelectorAll(".tab").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === tab),
    );
    const content = m.querySelector("#detailContent");
    if (tab === "overview") content.innerHTML = overviewHTML();
    else if (tab === "costs") {
      content.innerHTML = costsHTML();
      bindCosts(content);
    } else if (tab === "timelogs") {
      content.innerHTML = timelogsHTML();
      bindTimelogs(content);
    } else if (tab === "photos") {
      content.innerHTML = photosHTML();
      bindPhotos(content);
    } else if (tab === "spec") {
      content.innerHTML = specHTML();
    } else if (tab === "checklist") {
      content.innerHTML = checklistHTML();
      bindChecklist(content);
    } else if (tab === "profit") {
      content.innerHTML = profitHTML();
    }
  }

  function bindCosts(root) {
    /* Edit button — enter edit mode for a row */
    root.querySelectorAll("[data-eci]").forEach((btn) => {
      btn.addEventListener("click", () => {
        editingCostIdx = parseInt(btn.dataset.eci, 10);
        switchTab("costs");
      });
    });

    /* Save inline edit */
    root.querySelectorAll("[data-svedit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = parseInt(btn.dataset.svedit, 10);
        const dEl = root.querySelector("#ecD");
        const desc = dEl.value.trim();
        if (!desc) {
          dEl.classList.add("invalid");
          dEl.focus();
          return;
        }
        dEl.classList.remove("invalid");
        job.costs[i] = {
          ...job.costs[i],
          description: desc,
          category: root.querySelector("#ecC").value,
          qty: parseFloat(root.querySelector("#ecQ").value) || 1,
          unitCost: parseFloat(root.querySelector("#ecU").value) || 0,
        };
        editingCostIdx = -1;
        saveJob(job)
          .then(() => {
            switchTab("costs");
            render();
          })
          .catch(() => toast.error("Save error", "Could not save."));
      });
    });

    /* Cancel inline edit */
    root.querySelectorAll("[data-canceledit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        editingCostIdx = -1;
        switchTab("costs");
      });
    });

    /* Remove item */
    root.querySelectorAll("[data-dci]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.dci, 10);
        job.costs = (job.costs || []).filter((_, i) => i !== idx);
        editingCostIdx = -1;
        saveJob(job)
          .then(() => {
            switchTab("costs");
            render();
          })
          .catch(() =>
            toast.error(
              "Save failed",
              "Could not save. Check your connection.",
            ),
          );
      });
    });

    /* Add new item */
    root.querySelector("#btnAC")?.addEventListener("click", () => {
      const dEl = root.querySelector("#fcD");
      const desc = dEl.value.trim();
      if (!desc) {
        dEl.classList.add("invalid");
        dEl.focus();
        return;
      }
      dEl.classList.remove("invalid");
      job.costs = [
        ...(job.costs || []),
        {
          id: uid(),
          description: desc,
          category: root.querySelector("#fcC").value,
          qty: parseFloat(root.querySelector("#fcQ").value) || 1,
          unitCost: parseFloat(root.querySelector("#fcU").value) || 0,
        },
      ];
      saveJob(job)
        .then(() => {
          switchTab("costs");
          render();
        })
        .catch(() => toast.error("Save error", "Could not save cost item."));
    });
  }

  function bindTimelogs(root) {
    /* Manual entry */
    root.querySelector("#btnMTAdd")?.addEventListener("click", () => {
      const hrsEl = root.querySelector("#mtHrs");
      const hrs = parseFloat(hrsEl.value);
      if (!hrs || hrs <= 0) {
        hrsEl.classList.add("invalid");
        hrsEl.focus();
        return;
      }
      hrsEl.classList.remove("invalid");
      const dateVal = root.querySelector("#mtDate").value;
      const crewId = root.querySelector("#mtCrew")?.value || null;
      const log = {
        id: uid(),
        jobId: job.id,
        hours: hrs,
        date: dateVal ? parseDate(dateVal) || Date.now() : Date.now(),
        note: root.querySelector("#mtNote").value.trim(),
        crewId: crewId || null,
        manual: true,
        lat: null,
        lng: null,
      };
      const persistLog = () =>
        idb
          .put(APP.stores.timeLogs, log)
          .then(() => {
            state.timeLogs.push(log);
            toast.success("Hours added", `${hrs}h logged.`);
            switchTab("timelogs");
            render();
          })
          .catch(() => toast.error("Error", "Could not save hours."));

      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            log.lat = pos.coords.latitude;
            log.lng = pos.coords.longitude;
            persistLog();
          },
          () => persistLog(),
          { timeout: 10000, maximumAge: 60000 },
        );
      } else {
        persistLog();
      }
    });

    root.querySelectorAll("[data-dtl]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (demoBlock()) return;
        const id = btn.dataset.dtl;
        idb
          .del(APP.stores.timeLogs, id)
          .then(() => {
            state.timeLogs = state.timeLogs.filter((l) => l.id !== id);
            switchTab("timelogs");
            render();
          })
          .catch(() => toast.error("Error", "Could not remove time log."));
      });
    });
  }

  function bindPhotos(root) {
    const handlePhotoInput = (inputEl, photoType) => {
      if (!inputEl) return;
      inputEl.addEventListener("change", (e) => {
        const files = Array.from(e.target.files);
        if (!files.length) return;
        const current = (job.photos || []).length;
        if (current >= 10) {
          toast.warn("Limit reached", "Maximum 10 photos per job.");
          return;
        }
        const toAdd = files.slice(0, 10 - current);
        let done = 0;
        toAdd.forEach((file) => {
          if (file.size > 8 * 1024 * 1024) {
            toast.warn("File too large", `${file.name} exceeds 8MB.`);
            done++;
            if (done === toAdd.length) switchTab("photos");
            return;
          }
          const reader = new FileReader();
          reader.onload = (ev) => {
            const img = new Image();
            img.onload = () => {
              const canvas = document.createElement("canvas");
              const maxW = 900,
                maxH = 900;
              let w = img.width,
                h = img.height;
              if (w > maxW) {
                h = Math.round((h * maxW) / w);
                w = maxW;
              }
              if (h > maxH) {
                w = Math.round((w * maxH) / h);
                h = maxH;
              }
              canvas.width = w;
              canvas.height = h;
              canvas.getContext("2d").drawImage(img, 0, 0, w, h);
              const data = canvas.toDataURL("image/jpeg", 0.55);
              job.photos = [
                ...(job.photos || []),
                {
                  id: uid(),
                  name: file.name,
                  data,
                  dataUrl: data,
                  type: photoType,
                  caption: "",
                  ts: Date.now(),
                  date: Date.now(),
                },
              ];
              done++;
              if (done === toAdd.length) {
                saveJob(job)
                  .then(() => {
                    /* Register background sync when offline */
                    if (!navigator.onLine && "serviceWorker" in navigator) {
                      navigator.serviceWorker.ready
                        .then((sw) => {
                          if (sw.sync)
                            sw.sync.register("photo-sync").catch(() => {});
                        })
                        .catch(() => {});
                    }
                    switchTab("photos");
                    render();
                  })
                  .catch(() =>
                    toast.error(
                      "Save failed",
                      "Could not save photo. Check your connection.",
                    ),
                  );
              }
            };
            img.src = ev.target.result;
          };
          reader.readAsDataURL(file);
        });
      });
    };
    handlePhotoInput(root.querySelector("#photoInputBefore"), "before");
    handlePhotoInput(root.querySelector("#photoInputAfter"), "after");

    root.querySelectorAll(".photoDelBtn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const pid = btn.dataset.pid;
        job.photos = (job.photos || []).filter((p) => p.id !== pid);
        saveJob(job)
          .then(() => switchTab("photos"))
          .catch(() => toast.error("Save failed", "Could not delete photo."));
      });
    });

    root.querySelectorAll(".photoTypeBtn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const { pid, ptype } = btn.dataset;
        const photo = (job.photos || []).find((p) => p.id === pid);
        if (!photo) return;
        photo.type = photo.type === ptype ? "" : ptype;
        saveJob(job)
          .then(() => switchTab("photos"))
          .catch(() =>
            toast.error("Save failed", "Could not update photo type."),
          );
      });
    });

    root.querySelectorAll(".photoThumb img").forEach((img) => {
      img.addEventListener("click", () => {
        const pid = img.dataset.pid;
        const lb = document.createElement("div");
        lb.className = "lightbox";
        lb.innerHTML = `
            <div class="lightboxBg"></div>
            <div class="lightboxImgWrap">
              <img src="${img.src}" class="lightboxImg" alt="Photo"/>
            </div>
            <button class="lightboxClose" aria-label="Close">✕</button>
            <div class="lightboxToolbar">
              <button class="btn lbAnnotateBtn">✏️ Annotate</button>
            </div>`;
        document.body.appendChild(lb);

        const lbImg = lb.querySelector(".lightboxImg");
        const wrap = lb.querySelector(".lightboxImgWrap");
        const toolbar = lb.querySelector(".lightboxToolbar");

        const closeLb = () => lb.remove();
        lb.querySelector(".lightboxBg").addEventListener("click", closeLb);
        lb.querySelector(".lightboxClose").addEventListener("click", closeLb);
        document.addEventListener("keydown", function escKey(e) {
          if (e.key === "Escape") {
            closeLb();
            document.removeEventListener("keydown", escKey);
          }
        });

        function startAnnotation() {
          const dw = lbImg.clientWidth;
          const dh = lbImg.clientHeight;
          const drawCanvas = document.createElement("canvas");
          drawCanvas.className = "annotateCanvas";
          drawCanvas.width = dw;
          drawCanvas.height = dh;
          wrap.appendChild(drawCanvas);

          const ctx = drawCanvas.getContext("2d");
          ctx.strokeStyle = "#ff0000";
          ctx.lineWidth = 4;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";

          let drawing = false;

          const getPos = (e) => {
            const r = drawCanvas.getBoundingClientRect();
            const cx = e.clientX ?? e.touches?.[0].clientX ?? 0;
            const cy = e.clientY ?? e.touches?.[0].clientY ?? 0;
            return [
              (cx - r.left) * (dw / r.width),
              (cy - r.top) * (dh / r.height),
            ];
          };

          drawCanvas.addEventListener("pointerdown", (e) => {
            drawing = true;
            const [x, y] = getPos(e);
            ctx.beginPath();
            ctx.moveTo(x, y);
            drawCanvas.setPointerCapture(e.pointerId);
          });
          drawCanvas.addEventListener("pointermove", (e) => {
            if (!drawing) return;
            const [x, y] = getPos(e);
            ctx.lineTo(x, y);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x, y);
          });
          drawCanvas.addEventListener("pointerup", () => {
            drawing = false;
            ctx.beginPath();
          });
          drawCanvas.addEventListener("pointercancel", () => {
            drawing = false;
          });

          toolbar.innerHTML = `
            <button class="btn lbCancelDraw">✕ Cancel</button>
            <button class="btn primary lbSaveDraw">💾 Save Annotation</button>`;

          toolbar
            .querySelector(".lbCancelDraw")
            .addEventListener("click", () => {
              drawCanvas.remove();
              toolbar.innerHTML = `<button class="btn lbAnnotateBtn">✏️ Annotate</button>`;
              toolbar
                .querySelector(".lbAnnotateBtn")
                .addEventListener("click", startAnnotation);
            });

          toolbar.querySelector(".lbSaveDraw").addEventListener("click", () => {
            if (!lbImg.complete || !lbImg.naturalWidth) {
              toast.error("Photo error", "Image not fully loaded. Try again.");
              return;
            }
            const off = document.createElement("canvas");
            off.width = lbImg.naturalWidth;
            off.height = lbImg.naturalHeight;
            const offCtx = off.getContext("2d");
            offCtx.drawImage(lbImg, 0, 0);
            offCtx.drawImage(
              drawCanvas,
              0,
              0,
              lbImg.naturalWidth,
              lbImg.naturalHeight,
            );
            const merged = off.toDataURL("image/jpeg", 0.85);
            const photo = (job.photos || []).find((p) => p.id === pid);
            if (photo) {
              photo.data = merged;
              photo.dataUrl = merged;
              saveJob(job)
                .then(() => {
                  toast.success("Annotation saved", "Photo updated.");
                  closeLb();
                  switchTab("photos");
                })
                .catch(() =>
                  toast.error("Save failed", "Could not save annotation."),
                );
            }
          });
        }

        lb.querySelector(".lbAnnotateBtn").addEventListener(
          "click",
          startAnnotation,
        );
      });
    });
  }

  function bindChecklist(root) {
    /* Checkbox toggles */
    root.querySelectorAll("input[type=checkbox][data-clkey]").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (!job.checklist) job.checklist = {};
        if (cb.checked) job.checklist[cb.dataset.clkey] = true;
        else delete job.checklist[cb.dataset.clkey];
        const lbl = cb.closest(".checkItem");
        if (lbl) lbl.classList.toggle("done", cb.checked);
        saveJobChecklist(job).catch(() =>
          toast.error("Save failed", "Could not save checklist."),
        );
      });
    });

    /* Signature pad */
    const canvas = root.querySelector("#sigCanvas");
    if (!canvas) return;

    /* Match canvas internal resolution to its CSS display size for crisp drawing */
    const rect0 = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round((rect0.width || 560) * dpr);
    canvas.height = Math.round((rect0.height || 160) * dpr);
    const ctx2 = canvas.getContext("2d");
    ctx2.scale(dpr, dpr);

    const ctx = canvas.getContext("2d");
    let drawing = false;
    let lastX = 0,
      lastY = 0;

    const getPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      if (e.touches) {
        return [
          (e.touches[0].clientX - rect.left) * scaleX,
          (e.touches[0].clientY - rect.top) * scaleY,
        ];
      }
      return [
        (e.clientX - rect.left) * scaleX,
        (e.clientY - rect.top) * scaleY,
      ];
    };

    canvas.addEventListener("mousedown", (e) => {
      drawing = true;
      [lastX, lastY] = getPos(e);
    });
    canvas.addEventListener("mousemove", (e) => {
      if (!drawing) return;
      const [x, y] = getPos(e);
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(x, y);
      ctx.strokeStyle =
        getComputedStyle(document.documentElement).getPropertyValue("--text") ||
        "#e7ecf5";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.stroke();
      [lastX, lastY] = [x, y];
    });
    canvas.addEventListener("mouseup", () => {
      drawing = false;
    });
    canvas.addEventListener("mouseleave", () => {
      drawing = false;
    });

    canvas.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        drawing = true;
        [lastX, lastY] = getPos(e);
      },
      { passive: false },
    );
    canvas.addEventListener(
      "touchmove",
      (e) => {
        if (!drawing) return;
        e.preventDefault();
        const [x, y] = getPos(e);
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(x, y);
        ctx.strokeStyle =
          getComputedStyle(document.documentElement).getPropertyValue(
            "--text",
          ) || "#e7ecf5";
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.stroke();
        [lastX, lastY] = [x, y];
      },
      { passive: false },
    );
    canvas.addEventListener("touchend", () => {
      drawing = false;
    });

    root.querySelector("#btnSigClear")?.addEventListener("click", () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    });

    root.querySelector("#btnSigSave")?.addEventListener("click", () => {
      const dataUrl = canvas.toDataURL("image/png");
      job.signature = dataUrl;
      saveJob(job)
        .then(() => toast.success("Signature saved", ""))
        .catch(() => toast.error("Save failed", "Could not save signature."));
    });
  }

  m.querySelectorAll(".tab").forEach((btn) =>
    btn.addEventListener("click", () => switchTab(btn.dataset.tab)),
  );
  m.querySelector("#bjDup").addEventListener("click", () => {
    modal.close();
    duplicateJob(job);
  });
  m.querySelector("#bjEdit").addEventListener("click", () => {
    modal.close();
    openJobModal(job);
  });
  m.querySelector("#bjQR").addEventListener("click", () => showQRModal(job));
  m.querySelector("#bjShareQR").addEventListener("click", () =>
    showJobShareQR(job),
  );
  m.querySelector("#bjShare").addEventListener("click", () => shareJob(job));
  m.querySelector("#bjInvoice").addEventListener("click", () =>
    exportInvoicePDF(job),
  );
  m.querySelector("#bjPDF").addEventListener("click", () => exportJobPDF(job));
  m.querySelector("#bjCert").addEventListener("click", () =>
    exportCompletionCertPDF(job),
  );
  m.querySelector("#bjBAReport").addEventListener("click", () =>
    exportBeforeAfterPDF(job),
  );
  m.querySelector("#bjWorkOrder").addEventListener("click", () =>
    exportWorkOrderPDF(job),
  );
  m.querySelector("#bjPL").addEventListener("click", () => exportJobPLPDF(job));
  m.querySelector("#bjWarranty")?.addEventListener("click", () =>
    exportWarrantyCertPDF(job),
  );
  m.querySelector("#bjReview")?.addEventListener("click", () =>
    openReviewRequestModal(job),
  );
  m.querySelector("#bjInspect")?.addEventListener("click", () =>
    openScheduleInspectionModal(job),
  );
  m.querySelector("#bjClose").addEventListener("click", modal.close);
}

/* ─── Review Request Modal ───────────────────── */
function openReviewRequestModal(job) {
  const clientName = job.client || "Valued Customer";
  const reviewUrl =
    state.settings.googleReviewUrl || "https://g.page/r/YOUR_REVIEW_LINK";
  const msg = `Hi ${clientName}! Thank you for choosing ${state.settings.company || "Your Company"}. We'd love your feedback — please leave us a review: ${reviewUrl}`;
  const m2 = modal.open(`
      <div class="modalHd">
        <div><h2>Request Google Review</h2><p>${esc(job.name)}</p></div>
        <button type="button" class="closeX" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modalBd">
        <div class="field" style="margin-bottom:12px;">
          <label>Message to Send</label>
          <textarea id="reviewMsg" style="min-height:80px;">${esc(msg)}</textarea>
        </div>
        ${
          reviewUrl && reviewUrl !== "https://g.page/r/YOUR_REVIEW_LINK"
            ? `
        <div style="display:flex;flex-direction:column;align-items:center;gap:10px;margin-top:12px;">
          <canvas id="reviewQRCanvas"></canvas>
          <p class="small muted">QR Code for review link</p>
        </div>`
            : `<p class="help">Add your Google Review URL in Settings → Branding to show a QR code here.</p>`
        }
      </div>
      <div class="modalFt">
        <button type="button" class="btn" id="btnRevClose">Close</button>
        <button type="button" class="btn primary" id="btnRevCopy">Copy to Clipboard</button>
      </div>`);
  setTimeout(() => {
    const canvas = document.getElementById("reviewQRCanvas");
    if (canvas && window.QRCode && reviewUrl) {
      QRCode.toCanvas(canvas, reviewUrl, { width: 180, margin: 2 }, () => {});
    }
  }, 60);
  m2.querySelector("#btnRevClose").addEventListener("click", modal.close);
  m2.querySelector("#btnRevCopy").addEventListener("click", () => {
    const text = m2.querySelector("#reviewMsg").value;
    navigator.clipboard
      ?.writeText(text)
      .then(() =>
        toast.success("Copied", "Review request copied to clipboard."),
      );
  });
}

/* ─── Schedule Inspection Modal ──────────────── */
function openScheduleInspectionModal(job) {
  const m2 = modal.open(`
      <div class="modalHd">
        <div><h2>Schedule Inspection</h2><p>${esc(job.name)}</p></div>
        <button type="button" class="closeX" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modalBd">
        <p class="help" style="margin-bottom:12px;">This will create a new estimate pre-filled for the same client for a follow-up inspection.</p>
        <div class="fieldGrid">
          <div class="field"><label for="inspDate">Inspection Date</label>
            <input id="inspDate" class="input" type="date" value="${fmtDateInput(Date.now() + 180 * 24 * 60 * 60 * 1000)}"/></div>
          <div class="field"><label for="inspNotes">Notes</label>
            <input id="inspNotes" class="input" type="text" placeholder="Annual insulation inspection…"/></div>
        </div>
      </div>
      <div class="modalFt">
        <button type="button" class="btn" id="btnInspClose">Cancel</button>
        <button type="button" class="btn primary" id="btnInspSave">Create Estimate</button>
      </div>`);
  m2.querySelector("#btnInspClose").addEventListener("click", modal.close);
  m2.querySelector("#btnInspSave").addEventListener("click", () => {
    const inspDate = parseDate(m2.querySelector("#inspDate").value);
    const notes = m2.querySelector("#inspNotes").value.trim();
    /* Update job nextInspectionDate */
    job.nextInspectionDate = inspDate;
    saveJob(job).catch(() =>
      toast.error("Save failed", "Could not save inspection date."),
    );
    /* Create a pre-filled estimate */
    const est = {
      id: uid(),
      name: getNextEstimateNumber(),
      client: job.client || "",
      insulationType: job.insulationType || "",
      areaType: job.areaType || "",
      sqft: job.sqft || null,
      rValueTarget: job.rValueTarget || null,
      city: job.city || "",
      state: job.state || "FL",
      zip: job.zip || "",
      value: 0,
      taxRate: 0,
      status: "Draft",
      notes: notes || `Follow-up inspection for: ${job.name}`,
      date: Date.now(),
      sentDate: null,
    };
    saveEstimate(est)
      .then(() => {
        toast.success(
          "Estimate created",
          `Inspection estimate for ${job.client || job.name}`,
        );
        modal.close();
      })
      .catch(() => toast.error("Save failed", "Could not create estimate."));
  });
}

/* ─── Template Modal ─────────────────────────── */
function openTemplateModal(tpl) {
  const isEdit = !!tpl;
  const CATS = ["Materials", "Labor", "Subcontracted", "Other"];
  const w = isEdit
    ? { ...tpl, costs: (tpl.costs || []).map((c) => ({ ...c })) }
    : { id: uid(), name: "", description: "", date: Date.now(), costs: [] };

  const costRows = () =>
    w.costs.length === 0
      ? `<tr><td colspan="5" class="muted" style="padding:14px;text-align:center;">No items yet.</td></tr>`
      : w.costs
          .map(
            (c, i) => `
            <tr>
              <td>${esc(c.description)}</td>
              <td>${esc(c.category || "")}</td>
              <td style="text-align:right;">${c.qty}</td>
              <td style="text-align:right;">${fmt(c.unitCost)}</td>
              <td><button class="btn danger" data-dtc="${i}" style="padding:4px 10px;font-size:11px;">Remove</button></td>
            </tr>`,
          )
          .join("");

  const m = modal.open(`
      <div class="modalHd">
        <div>
          <h2>${isEdit ? "Edit Template" : "New Template"}</h2>
          <p>Templates pre-fill cost items when creating a new job.</p>
        </div>
        <button type="button" class="closeX" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modalBd" style="display:flex;flex-direction:column;gap:16px;">
        <div class="fieldGrid">
          <div class="field">
            <label for="ftN">Name *</label>
            <input id="ftN" class="input" type="text" maxlength="100" placeholder="e.g. Standard Remodel" value="${isEdit ? esc(tpl.name) : ""}"/>
          </div>
          <div class="field">
            <label for="ftD">Description</label>
            <input id="ftD" class="input" type="text" maxlength="200" placeholder="Optional" value="${isEdit ? esc(tpl.description || "") : ""}"/>
          </div>
        </div>
        <div>
          <strong style="display:block;margin-bottom:8px;font-size:13px;">Default Cost Items</strong>
          <div class="tableWrap" style="margin-bottom:10px;">
            <table class="table">
              <thead><tr>
                <th>Description</th><th>Category</th>
                <th style="text-align:right;">Qty</th>
                <th style="text-align:right;">Unit Cost</th>
                <th></th>
              </tr></thead>
              <tbody id="tTbody">${costRows()}</tbody>
            </table>
          </div>
          <div class="addCostGrid">
            <div class="field"><label for="ftcD">Description</label><input id="ftcD" class="input" type="text" maxlength="100" placeholder="Item"/></div>
            <div class="field"><label for="ftcC">Category</label><select id="ftcC">${CATS.map((c) => `<option>${c}</option>`).join("")}</select></div>
            <div class="field"><label for="ftcQ">Qty</label><input id="ftcQ" class="input" type="number" min="0.01" step="0.01" value="1"/></div>
            <div class="field"><label for="ftcU">Unit Cost ($)</label><input id="ftcU" class="input" type="number" min="0" step="0.01" placeholder="0.00"/></div>
            <div class="field addCostBtn"><label style="visibility:hidden">a</label><button type="button" class="btn primary" id="btnTAC">+ Add</button></div>
          </div>
        </div>
      </div>
      <div class="modalFt">
        <button type="button" class="btn" id="ftCancel">Cancel</button>
        <button type="button" class="btn primary" id="ftSave">${isEdit ? "Save" : "Create Template"}</button>
      </div>`);

  const rebind = () => {
    m.querySelectorAll("[data-dtc]").forEach((btn) =>
      btn.addEventListener("click", () => {
        w.costs.splice(parseInt(btn.dataset.dtc, 10), 1);
        m.querySelector("#tTbody").innerHTML = costRows();
        rebind();
      }),
    );
  };
  rebind();

  m.querySelector("#btnTAC").addEventListener("click", () => {
    const dEl = m.querySelector("#ftcD");
    const desc = dEl.value.trim();
    if (!desc) {
      dEl.classList.add("invalid");
      return;
    }
    dEl.classList.remove("invalid");
    w.costs.push({
      id: uid(),
      description: desc,
      category: m.querySelector("#ftcC").value,
      qty: parseFloat(m.querySelector("#ftcQ").value) || 1,
      unitCost: parseFloat(m.querySelector("#ftcU").value) || 0,
    });
    dEl.value = "";
    m.querySelector("#ftcU").value = "";
    m.querySelector("#ftcQ").value = "1";
    m.querySelector("#tTbody").innerHTML = costRows();
    rebind();
  });

  m.querySelector("#ftCancel").addEventListener("click", modal.close);
  m.querySelector("#ftSave").addEventListener("click", () => {
    const nEl = m.querySelector("#ftN");
    const name = nEl.value.trim();
    if (!name) {
      nEl.classList.add("invalid");
      nEl.focus();
      return;
    }
    nEl.classList.remove("invalid");
    const saved = {
      ...w,
      name,
      description: m.querySelector("#ftD").value.trim(),
    };
    idb
      .put(APP.stores.templates, saved)
      .then(() => {
        const i = state.templates.findIndex((t) => t.id === saved.id);
        if (i !== -1) state.templates[i] = saved;
        else state.templates.push(saved);
        toast.success(
          isEdit ? "Template updated" : "Template created",
          saved.name,
        );
        modal.close();
        render();
      })
      .catch(() => toast.error("Save error", "Could not save template."));
  });
}

/* ─── Clients ────────────────────────────────── */
function renderClients(root) {
  root.innerHTML = `
      <div class="pageHeader">
        <h2 class="pageTitle">Clients <span class="muted" style="font-size:14px;font-weight:400;">(${state.clients.length})</span></h2>
        <button class="btn primary admin-only" id="btnNC">+ New Client</button>
      </div>
      ${
        state.clients.length === 0
          ? `<div class="empty">No clients yet. Clients are auto-created when you save a job with a client name, or add them manually.</div>`
          : `<div class="tableWrap">
            <table class="table">
              <thead><tr>
                <th>Name</th><th>Phone</th><th>Email</th>
                <th style="text-align:right;">Jobs</th>
                <th style="text-align:right;">Total Value</th>
                <th></th>
              </tr></thead>
              <tbody>
                ${[...state.clients]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((c) => {
                    const jobs = state.jobs.filter(
                      (j) =>
                        j.clientId === c.id ||
                        j.client?.toLowerCase() === c.name?.toLowerCase(),
                    );
                    const totalVal = jobs.reduce(
                      (s, j) => s + (j.value || 0),
                      0,
                    );
                    return `
                  <tr>
                    <td><strong>${esc(c.name)}</strong>${c.notes ? `<br><span class="small muted">${esc(c.notes)}</span>` : ""}</td>
                    <td>${c.phone ? `<a href="tel:${esc(c.phone)}" class="link">${esc(c.phone)}</a>` : `<span class="muted">—</span>`}</td>
                    <td>${c.email ? `<a href="mailto:${esc(c.email)}" class="link">${esc(c.email)}</a>` : `<span class="muted">—</span>`}</td>
                    <td style="text-align:right;">${jobs.length}</td>
                    <td style="text-align:right;">${fmt(totalVal)}</td>
                    <td>
                      <div style="display:flex;gap:5px;">
                        <button class="btn" data-vc="${c.id}" style="padding:5px 9px;font-size:12px;">View</button>
                        <button class="btn admin-only" data-ec="${c.id}" style="padding:5px 9px;font-size:12px;">Edit</button>
                        <button class="btn danger admin-only" data-dc="${c.id}" style="padding:5px 9px;font-size:12px;">Delete</button>
                      </div>
                    </td>
                  </tr>`;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>`
      }`;

  root
    .querySelector("#btnNC")
    ?.addEventListener("click", () => openClientModal(null));
  root.querySelectorAll("[data-vc]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = state.clients.find((x) => x.id === btn.dataset.vc);
      if (c) openClientDetailModal(c);
    });
  });
  root.querySelectorAll("[data-ec]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = state.clients.find((x) => x.id === btn.dataset.ec);
      if (c) openClientModal(c);
    });
  });
  root.querySelectorAll("[data-dc]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = state.clients.find((x) => x.id === btn.dataset.dc);
      if (!c) return;
      if (demoBlock()) return;
      confirm("Delete Client", c.name, "Delete", () => {
        idb
          .del(APP.stores.clients, c.id)
          .then(() => {
            state.clients = state.clients.filter((x) => x.id !== c.id);
            toast.warn("Client deleted", c.name);
            render();
          })
          .catch(() => toast.error("Error", "Could not delete client."));
      });
    });
  });
}

function openClientDetailModal(client) {
  const jobs = state.jobs.filter(
    (j) =>
      j.clientId === client.id ||
      j.client?.toLowerCase() === client.name?.toLowerCase(),
  );
  const totalVal = jobs.reduce((s, j) => s + (j.value || 0), 0);
  const log = (client.commLog || []).slice().sort((a, b) => b.ts - a.ts);
  const typeBadge = {
    call: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.77 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.08 6.08l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`,
    email: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22 6 12 13 2 6"/></svg>`,
    visit: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="10" r="3"/><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>`,
    note: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  };

  function renderLog() {
    return log.length === 0
      ? `<div class="empty" style="padding:8px 0;">No interactions logged yet.</div>`
      : log
          .map(
            (e) => `
          <div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
            <div style="font-size:18px;line-height:1;">${typeBadge[e.type] || "📝"}</div>
            <div style="flex:1;">
              <div style="font-size:12px;color:var(--muted);">${fmtDate(e.ts)} · <strong>${e.type}</strong></div>
              <div style="font-size:13px;margin-top:2px;">${esc(e.summary)}</div>
            </div>
            <button class="btn danger" data-dlc="${e.id}" style="padding:3px 8px;font-size:11px;align-self:flex-start;">Del</button>
          </div>`,
          )
          .join("");
  }

  const m = modal.open(`
      <div class="modalHd">
        <div>
          <h2>${esc(client.name)}</h2>
          <p>${[client.phone, client.email].filter(Boolean).map(esc).join(" · ") || "No contact info"}</p>
        </div>
        <button type="button" class="closeX" aria-label="Close"><svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
      </div>
      <div class="modalBd" style="display:flex;flex-direction:column;gap:16px;">
        <div style="display:flex;gap:16px;flex-wrap:wrap;">
          <div class="card cardBody" style="flex:1;min-width:120px;">
            <div class="kpiVal">${jobs.length}</div><div class="kpiLbl">Total Jobs</div>
          </div>
          <div class="card cardBody" style="flex:1;min-width:120px;">
            <div class="kpiVal kpiValSm" style="color:var(--ok);">${fmt(totalVal)}</div><div class="kpiLbl">Total Value</div>
          </div>
          <div class="card cardBody" style="flex:1;min-width:120px;">
            <div class="kpiVal">${jobs.filter((j) => j.status === "Active").length}</div><div class="kpiLbl">Active Jobs</div>
          </div>
        </div>
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
            <div class="sectionLabel">Communication Log</div>
            <button class="btn primary" id="btnLogInt" style="padding:5px 12px;font-size:12px;">+ Log Interaction</button>
          </div>
          <div id="commLogList">${renderLog()}</div>
        </div>
      </div>
      <div class="modalFt">
        <button type="button" class="btn admin-only" id="btnEditFromDetail">Edit Client</button>
        <button type="button" class="btn" id="cdClose">Close</button>
      </div>`);

  m.querySelector("#cdClose").addEventListener("click", modal.close);
  m.querySelector("#btnEditFromDetail").addEventListener("click", () => {
    modal.close();
    openClientModal(client);
  });

  m.querySelector("#btnLogInt").addEventListener("click", () => {
    const logM = modal.open(`
        <div class="modalHd">
          <div><h2>Log Interaction</h2><p>${esc(client.name)}</p></div>
          <button type="button" class="closeX" aria-label="Close"><svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
        </div>
        <div class="modalBd">
          <div class="fieldGrid">
            <div class="field">
              <label for="liType">Type</label>
              <select id="liType">
                <option value="call">Phone Call</option>
                <option value="email">Email</option>
                <option value="visit">Site Visit</option>
                <option value="note">Note</option>
              </select>
            </div>
            <div class="field" style="grid-column:1/-1;">
              <label for="liSummary">Summary</label>
              <textarea id="liSummary" class="input" rows="3" maxlength="500" placeholder="Brief summary of the interaction…" style="resize:vertical;"></textarea>
            </div>
          </div>
        </div>
        <div class="modalFt">
          <button type="button" class="btn" id="liCancel">Cancel</button>
          <button type="button" class="btn primary" id="liSave">Save</button>
        </div>`);
    logM.querySelector("#liCancel").addEventListener("click", modal.close);
    logM.querySelector("#liSave").addEventListener("click", () => {
      const type = logM.querySelector("#liType").value;
      const summary = logM.querySelector("#liSummary").value.trim();
      if (!summary) {
        toast.error("Summary required", "");
        return;
      }
      const entry = { id: uid(), ts: Date.now(), type, summary };
      client.commLog = [...(client.commLog || []), entry];
      log.unshift(entry);
      idb
        .put(APP.stores.clients, client)
        .then(() => {
          const idx = state.clients.findIndex((x) => x.id === client.id);
          if (idx !== -1) state.clients[idx] = client;
          modal.close();
          m.querySelector("#commLogList").innerHTML = renderLog();
          bindCommLogDel();
          toast.success("Interaction logged", type);
        })
        .catch(() => toast.error("Error", "Could not save."));
    });
  });

  function bindCommLogDel() {
    m.querySelectorAll("[data-dlc]").forEach((btn) => {
      btn.addEventListener("click", () => {
        client.commLog = (client.commLog || []).filter(
          (e) => e.id !== btn.dataset.dlc,
        );
        const idx2 = log.findIndex((e) => e.id === btn.dataset.dlc);
        if (idx2 !== -1) log.splice(idx2, 1);
        idb.put(APP.stores.clients, client).then(() => {
          const si = state.clients.findIndex((x) => x.id === client.id);
          if (si !== -1) state.clients[si] = client;
          m.querySelector("#commLogList").innerHTML = renderLog();
          bindCommLogDel();
        });
      });
    });
  }
  bindCommLogDel();
}

function openClientModal(client) {
  const isEdit = !!client;
  const m = modal.open(`
      <div class="modalHd">
        <div>
          <h2>${isEdit ? "Edit Client" : "New Client"}</h2>
          <p>${isEdit ? esc(client.name) : "Add a client to your directory."}</p>
        </div>
        <button type="button" class="closeX" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modalBd">
        <div class="fieldGrid">
          <div class="field" style="grid-column:1/-1;">
            <label for="fcN">Name *</label>
            <input id="fcN" class="input" type="text" maxlength="120" placeholder="e.g. Acme Construction" value="${isEdit ? esc(client.name) : ""}"/>
          </div>
          <div class="field">
            <label for="fcPh">Phone</label>
            <input id="fcPh" class="input" type="tel" maxlength="30" placeholder="e.g. (555) 123-4567" value="${isEdit ? esc(client.phone || "") : ""}"/>
          </div>
          <div class="field">
            <label for="fcEm">Email</label>
            <input id="fcEm" class="input" type="email" maxlength="120" placeholder="e.g. owner@example.com" value="${isEdit ? esc(client.email || "") : ""}"/>
          </div>
          <div class="field" style="grid-column:1/-1;">
            <label for="fcNo">Notes</label>
            <textarea id="fcNo" placeholder="Address, preferences, etc.">${isEdit ? esc(client.notes || "") : ""}</textarea>
          </div>
        </div>
      </div>
      <div class="modalFt">
        <button type="button" class="btn" id="fcCancel">Cancel</button>
        <button type="button" class="btn primary" id="fcSave">${isEdit ? "Save Changes" : "Add Client"}</button>
      </div>`);

  m.querySelector("#fcCancel").addEventListener("click", modal.close);
  m.querySelector("#fcSave").addEventListener("click", () => {
    const nEl = m.querySelector("#fcN");
    const name = nEl.value.trim();
    if (!name) {
      nEl.classList.add("invalid");
      nEl.focus();
      return;
    }
    nEl.classList.remove("invalid");
    const saved = {
      id: isEdit ? client.id : uid(),
      name,
      phone: m.querySelector("#fcPh").value.trim(),
      email: m.querySelector("#fcEm").value.trim(),
      notes: m.querySelector("#fcNo").value.trim(),
      date: isEdit ? client.date : Date.now(),
    };
    saveClient(saved)
      .then(() => {
        toast.success(isEdit ? "Client updated" : "Client added", saved.name);
        modal.close();
        render();
      })
      .catch(() => toast.error("Save error", "Could not save client."));
  });
}

/* ─── Dashboard ──────────────────────────────── */
function renderDashboard(root) {
  const active = state.jobs.filter((j) => j.status === "Active").length;
  const completed = state.jobs.filter((j) => j.status === "Completed").length;
  const invoiced = state.jobs.filter((j) => j.status === "Invoiced").length;
  const totalVal = state.jobs.reduce((s, j) => s + (j.value || 0), 0);
  const totalCosts = state.jobs.reduce((s, j) => s + jobCost(j), 0);
  const totalHrs = state.timeLogs.reduce((s, l) => s + (l.hours || 0), 0);
  const totalMargin = totalVal - totalCosts;
  const unpaidAmt = state.jobs
    .filter((j) => j.status === "Invoiced" && j.paymentStatus !== "Paid")
    .reduce((s, j) => s + (j.value || 0), 0);
  const paidAmt = state.jobs
    .filter((j) => j.paymentStatus === "Paid")
    .reduce((s, j) => s + (j.value || 0), 0);
  const leadCount = state.estimates.filter(
    (e) => e.status === "Draft" || e.status === "Sent",
  ).length;
  const approvedEst = state.estimates
    .filter((e) => e.status === "Approved")
    .reduce((s, e) => s + (e.value || 0), 0);
  const lowStockCount = state.inventory.filter(
    (i) => (i.quantity || 0) <= (i.minStock || 0),
  ).length;

  const now = Date.now();
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  const followUps = state.estimates.filter((e) => {
    if (!["Draft", "Sent"].includes(e.status)) return false;
    if (!e.followUpDate) return false;
    return e.followUpDate <= todayEnd.getTime();
  });

  const overdueJobs = state.jobs.filter(
    (j) =>
      j.deadline &&
      j.deadline < now &&
      !["Completed", "Invoiced"].includes(j.status),
  );

  const list = state.search
    ? state.jobs.filter(
        (j) =>
          j.name.toLowerCase().includes(state.search) ||
          (j.client || "").toLowerCase().includes(state.search),
      )
    : sorted(state.jobs).slice(0, 8);

  /* ── Monthly Revenue Goal ── */
  const goal = state.settings.monthlyGoal || 0;
  const nowD = new Date();
  const monthStart = new Date(nowD.getFullYear(), nowD.getMonth(), 1).getTime();
  const monthEnd = new Date(
    nowD.getFullYear(),
    nowD.getMonth() + 1,
    0,
    23,
    59,
    59,
    999,
  ).getTime();
  const monthRevenue = state.jobs
    .filter((j) => {
      const d = j.date || j.createdAt || 0;
      return d >= monthStart && d <= monthEnd && j.paymentStatus === "Paid";
    })
    .reduce((s, j) => s + (j.value || j.revenue || 0), 0);
  const goalPct = goal > 0 ? Math.min(100, (monthRevenue / goal) * 100) : 0;
  const goalColor =
    goalPct >= 80
      ? "var(--ok)"
      : goalPct >= 50
        ? "var(--warn)"
        : "var(--danger)";
  const monthName = nowD.toLocaleDateString("en-US", { month: "long" });

  root.innerHTML = `
      ${isHurricaneSeason() ? `<div class="hurricaneBanner">🌀 Hurricane Season Active (Jun–Nov) — Verify job site safety before dispatch</div>` : ""}
      ${lowStockCount > 0 ? `<div class="alertBanner" style="margin-bottom:12px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px" aria-hidden="true"><path d="M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></svg>${lowStockCount} inventory item(s) at or below minimum stock level</div>` : ""}
      ${
        followUps.length > 0
          ? `
        <div class="followUpBanner">
          <div class="followUpBannerTitle">🚨 Follow-ups Today: ${followUps.length} estimate${followUps.length > 1 ? "s" : ""} need${followUps.length === 1 ? "s" : ""} your attention!</div>
          <div class="followUpList">
            ${followUps
              .map(
                (e) => `
              <div class="followUpRow">
                <span class="followUpClient"><strong>${esc(e.client || "—")}</strong> <span class="muted" style="font-size:12px;">${esc(e.name)}</span></span>
                <span class="followUpVal">${fmt(estGrandTotal(e))}</span>
                <span class="badge est-${(e.status || "draft").toLowerCase()}">${e.status}</span>
                ${e.phone ? `<a href="tel:${esc(e.phone)}" class="btn followUpCall"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.77 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.08 6.08l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>Call</a>` : ""}
                <button type="button" class="btn followUpWA" data-fuwajob="${e.id}">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" style="vertical-align:-2px;margin-right:4px;" aria-hidden="true">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                    <path d="M12 0C5.373 0 0 5.373 0 12c0 2.127.558 4.126 1.532 5.861L0 24l6.305-1.654A11.955 11.955 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.796 9.796 0 01-5.032-1.388l-.361-.214-3.741.981.998-3.648-.235-.374A9.796 9.796 0 012.182 12C2.182 6.57 6.57 2.182 12 2.182S21.818 6.57 21.818 12 17.43 21.818 12 21.818z"/>
                  </svg>
                  Follow-up
                </button>
              </div>`,
              )
              .join("")}
          </div>
        </div>`
          : ""
      }
      <div style="display:flex;justify-content:flex-end;margin-bottom:8px;">
        <button class="btn" id="btnScanQR" title="Scan a Job QR code to import a job from another device">
          <svg viewBox="0 0 24 24" fill="none" width="15" height="15" style="margin-right:5px;vertical-align:middle;" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.6"/>
            <rect x="14" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.6"/>
            <rect x="3" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.6"/>
            <path d="M14 14h2v2h-2zM18 14h3M14 18h3M18 18h3v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          </svg>
          Scan Job QR
        </button>
      </div>
      ${
        goal > 0
          ? `
      <div class="card cardBody goalCard" style="margin-bottom:14px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <div>
            <div style="font-size:13px;font-weight:700;color:var(--text);">${monthName} Revenue Goal</div>
            <div style="font-size:12px;color:var(--muted);margin-top:2px;">
              ${fmt(monthRevenue)} collected of ${fmt(goal)} goal
            </div>
          </div>
          <div style="font-size:22px;font-weight:900;color:${goalColor};">
            ${goalPct.toFixed(0)}%
          </div>
        </div>
        <div style="height:10px;background:var(--bg2);border-radius:99px;overflow:hidden;">
          <div style="
            height:100%;
            width:${goalPct}%;
            background:${goalColor};
            border-radius:99px;
            transition:width .6s cubic-bezier(.22,1,.36,1);
            min-width:${goalPct > 0 ? "6px" : "0"};
          "></div>
        </div>
        ${
          goalPct >= 100
            ? `
        <div style="text-align:center;margin-top:8px;font-size:12px;font-weight:700;color:var(--ok);">
          🎉 Goal reached! Amazing work this month.
        </div>`
            : goalPct >= 80
              ? `
        <div style="text-align:center;margin-top:8px;font-size:12px;color:var(--ok);">
          Almost there — ${fmt(goal - monthRevenue)} to go!
        </div>`
              : `
        <div style="text-align:center;margin-top:8px;font-size:12px;color:var(--muted);">
          ${fmt(goal - monthRevenue)} remaining this month
        </div>`
        }
      </div>`
          : ""
      }
      <div class="kpiGrid">
        <div class="card cardBody kpi">
          <div class="kpiVal">${state.jobs.length}</div>
          <div class="kpiLbl">Total Jobs</div>
        </div>
        <div class="card cardBody kpi">
          <div class="kpiVal" style="color:var(--primary)">${active}</div>
          <div class="kpiLbl">Active</div>
        </div>
        <div class="card cardBody kpi">
          <div class="kpiVal" style="color:var(--ok)">${completed}</div>
          <div class="kpiLbl">Completed</div>
        </div>
        <div class="card cardBody kpi">
          <div class="kpiVal" style="color:var(--purple)">${invoiced}</div>
          <div class="kpiLbl">Invoiced</div>
        </div>
        <div class="card cardBody kpi">
          <div class="kpiVal kpiValSm">${fmt(totalVal)}</div>
          <div class="kpiLbl">Total Est. Value</div>
        </div>
        <div class="card cardBody kpi">
          <div class="kpiVal kpiValSm">${fmt(totalCosts)}</div>
          <div class="kpiLbl">Total Costs</div>
        </div>
        <div class="card cardBody kpi">
          <div class="kpiVal kpiValSm" style="color:${totalMargin >= 0 ? "var(--ok)" : "var(--danger)"}">
            ${fmt(totalMargin)}
          </div>
          <div class="kpiLbl">Total Margin</div>
        </div>
        <div class="card cardBody kpi">
          <div class="kpiVal">${totalHrs.toFixed(1)}h</div>
          <div class="kpiLbl">Hours Logged</div>
        </div>
        <div class="card cardBody kpi">
          <div class="kpiVal kpiValSm" style="color:var(--warn);">${fmt(unpaidAmt)}</div>
          <div class="kpiLbl">Unpaid Invoiced</div>
        </div>
        <div class="card cardBody kpi">
          <div class="kpiVal kpiValSm" style="color:var(--ok);">${fmt(paidAmt)}</div>
          <div class="kpiLbl">Total Paid</div>
        </div>
        <div class="card cardBody kpi">
          <div class="kpiVal" style="color:var(--primary)">${leadCount}</div>
          <div class="kpiLbl">Open Estimates</div>
        </div>
        <div class="card cardBody kpi">
          <div class="kpiVal kpiValSm" style="color:var(--ok)">${fmt(approvedEst)}</div>
          <div class="kpiLbl">Approved Est. Value</div>
        </div>
        <div class="card cardBody kpi">
          <div class="kpiVal" style="color:${lowStockCount > 0 ? "var(--warn)" : "var(--ok)"}">${state.crew.filter((c) => c.status === "Active").length}</div>
          <div class="kpiLbl">Active Crew</div>
        </div>
      </div>
      ${
        overdueJobs.length
          ? `
      <div class="alertBanner">
        ⚠ ${overdueJobs.length} job(s) with overdue deadline:
        ${overdueJobs
          .slice(0, 3)
          .map((j) => `<strong>${esc(j.name)}</strong>`)
          .join(", ")}
        ${overdueJobs.length > 3 ? `and ${overdueJobs.length - 3} more…` : ""}
      </div>`
          : ""
      }
      <div class="card" style="margin-top:14px;">
        <div class="cardHeader">
          <div class="cardTitle">${state.search ? `Results: "${esc(state.search)}"` : "Recent Jobs"}</div>
          <button class="btn primary admin-only" id="btnDN">+ New Job</button>
        </div>
        ${
          list.length === 0
            ? `<div class="empty" style="margin:14px;">${state.search ? "No jobs found." : "No jobs created yet."}</div>`
            : list
                .map((j) => {
                  const tc = jobCost(j);
                  const margin = (j.value || 0) - tc;
                  const marginPct = j.value > 0 ? (margin / j.value) * 100 : 0;
                  const minMargin = state.settings.minMargin ?? 30;
                  const isLowMargin =
                    j.value > 0 &&
                    marginPct < minMargin &&
                    !["Lead", "Draft"].includes(j.status);
                  const overdue =
                    j.deadline &&
                    j.deadline < now &&
                    !["Completed", "Invoiced"].includes(j.status);
                  return `
              <div class="jobRow${isLowMargin ? " low-margin" : ""}" data-detail="${j.id}">
                <div class="jobRowMain">
                  <strong>${esc(j.name)}</strong>
                  ${isLowMargin ? `<span class="lowMarginBadge" title="Margin ${marginPct.toFixed(1)}% — below ${minMargin}% target">⚠ Low Margin</span>` : ""}
                  ${j.client ? `<span class="jobRowClient"> · ${esc(j.client)}</span>` : ""}
                  ${j.deadline ? `<span class="jobRowDeadline${overdue ? " overdue" : ""}">Due: ${fmtDate(j.deadline)}</span>` : ""}
                </div>
                <div class="jobRowMeta">
                  <span class="badge status-${j.status.toLowerCase()}">${j.status}</span>
                  <span class="muted" style="font-size:12px;">${fmt(j.value)}</span>
                  <span style="font-size:11px;color:${margin >= 0 ? "var(--ok)" : "var(--danger)"};">${fmt(margin)}</span>
                </div>
              </div>`;
                })
                .join("")
        }
      </div>`;

  root
    .querySelector("#btnDN")
    ?.addEventListener("click", () => openJobModal(null));
  root.querySelector("#btnScanQR")?.addEventListener("click", openQRScanner);
  root.querySelectorAll("[data-fuwajob]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const est = state.estimates.find((e) => e.id === btn.dataset.fuwajob);
      if (est) sendFollowUpWA(est);
    });
  });
  root.querySelectorAll("[data-detail]").forEach((el) =>
    el.addEventListener("click", () => {
      const j = state.jobs.find((x) => x.id === el.dataset.detail);
      if (j) openJobDetailModal(j);
    }),
  );
}

/* ─── Jobs ───────────────────────────────────── */
function renderJobs(root) {
  const STATUSES = ["all", "Draft", "Active", "Completed", "Invoiced"];
  let base = [...state.jobs];

  /* Search filter */
  if (state.search)
    base = base.filter(
      (j) =>
        j.name.toLowerCase().includes(state.search) ||
        (j.client || "").toLowerCase().includes(state.search) ||
        j.status.toLowerCase().includes(state.search) ||
        (j.tags || []).some((t) => t.toLowerCase().includes(state.search)),
    );

  /* Status filter */
  if (state.filter !== "all")
    base = base.filter((j) => j.status === state.filter);

  /* Tag filter */
  if (state.tagFilter)
    base = base.filter((j) => (j.tags || []).includes(state.tagFilter));

  /* Date range filter */
  if (state.dateFilter.from)
    base = base.filter((j) => j.date >= state.dateFilter.from);
  if (state.dateFilter.to)
    base = base.filter((j) => j.date <= state.dateFilter.to + 86399999);

  const list = sorted(base);
  const now = Date.now();

  /* Collect all unique tags */
  const allTags = [...new Set(state.jobs.flatMap((j) => j.tags || []))].sort();

  const rows = list
    .map((j) => {
      const tc = jobCost(j);
      const margin = (j.value || 0) - tc;
      const overdue =
        j.deadline &&
        j.deadline < now &&
        !["Completed", "Invoiced"].includes(j.status);
      const holiday = j.deadline ? isUSHoliday(j.deadline) : null;
      const payBadge =
        j.status === "Invoiced"
          ? `<span class="badge payment-${(j.paymentStatus || "unpaid").toLowerCase()}" style="font-size:10px;">${j.paymentStatus || "Unpaid"}</span>`
          : "";
      return `
        <tr data-detail="${j.id}">
          <td>
            <strong>${esc(j.name)}</strong>
            ${j.client ? `<br><span class="small">${esc(j.client)}</span>` : ""}
            ${(j.tags || []).length ? `<br>${j.tags.map((t) => `<span class="tagPill">${esc(t)}</span>`).join("")}` : ""}
          </td>
          <td>
            <span class="badge status-${j.status.toLowerCase()}">${j.status}</span>
            ${payBadge ? `<br style="margin-top:3px;">${payBadge}` : ""}
          </td>
          <td style="text-align:right;">${fmt(j.value)}</td>
          <td style="text-align:right;">${fmt(tc)}</td>
          <td style="text-align:right;color:${margin >= 0 ? "var(--ok)" : "var(--danger)"};">
            <strong>${fmt(margin)}</strong>
          </td>
          <td class="${overdue ? "deadlineCell overdue" : "deadlineCell"}">${j.deadline ? `${fmtDate(j.deadline)}${holiday ? ` <span title="${esc(holiday.localName)}">🎉</span>` : ""}` : `<span class="muted">—</span>`}</td>
          <td>${fmtDate(j.date)}</td>
          <td>
            <div style="display:flex;gap:4px;flex-wrap:wrap;">
              <button class="btn" data-detail="${j.id}" style="padding:5px 9px;font-size:12px;">View</button>
              <button class="btn admin-only" data-dup="${j.id}" style="padding:5px 9px;font-size:12px;">Copy</button>
              <button class="btn admin-only" data-edit="${j.id}" style="padding:5px 9px;font-size:12px;">Edit</button>
              <button class="btn admin-only" data-qr="${j.id}" style="padding:5px 9px;font-size:12px;" title="QR Clock-In">QR</button>
              <button class="btn danger admin-only" data-del="${j.id}" style="padding:5px 9px;font-size:12px;">Delete</button>
            </div>
          </td>
        </tr>`;
    })
    .join("");

  root.innerHTML = `
      <div class="pageHeader">
        <h2 class="pageTitle">Job Pipeline <span class="muted" style="font-size:14px;font-weight:400;">(${list.length})</span></h2>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <button class="btn admin-only" id="btnExportCSV">Export CSV</button>
          <button class="btn admin-only" id="btnExportAllPDF">Full Report PDF</button>
          <button class="btn primary admin-only" id="btnNJ">+ New Job</button>
        </div>
      </div>
      <div class="filterBar">
        ${STATUSES.map(
          (s) => `
          <button type="button" class="filterPill${state.filter === s ? " active" : ""}" data-fv="${s}">
            ${s === "all" ? "All" : s}
          </button>`,
        ).join("")}
        <div class="dateFilterWrap">
          <input type="date" class="input dateFilterIn" id="dfFrom" value="${state.dateFilter.from ? fmtDateInput(state.dateFilter.from) : ""}" title="From" placeholder="From"/>
          <span class="muted" style="font-size:12px;">to</span>
          <input type="date" class="input dateFilterIn" id="dfTo" value="${state.dateFilter.to ? fmtDateInput(state.dateFilter.to) : ""}" title="To" placeholder="To"/>
          ${state.dateFilter.from || state.dateFilter.to ? `<button class="btn" id="btnClearDate" style="padding:4px 10px;font-size:12px;">✕</button>` : ""}
        </div>
      </div>
      ${
        allTags.length
          ? `
      <div class="tagFilterBar">
        <button type="button" class="tagFilterPill${!state.tagFilter ? " active" : ""}" data-tag="">All Tags</button>
        ${allTags.map((t) => `<button type="button" class="tagFilterPill${state.tagFilter === t ? " active" : ""}" data-tag="${esc(t)}">${esc(t)}</button>`).join("")}
      </div>`
          : ""
      }
      ${
        list.length === 0
          ? `<div class="empty">${state.search || state.filter !== "all" || state.tagFilter || state.dateFilter.from || state.dateFilter.to ? "No jobs found with the applied filters." : "No jobs created yet."}</div>`
          : `<div class="tableWrap">
            <table class="table">
              <thead><tr>
                ${th("name", "Job")}
                ${th("status", "Status")}
                ${th("value", "Est. Value", "right")}
                <th style="text-align:right;">Cost</th>
                <th style="text-align:right;">Margin</th>
                ${th("deadline", "Deadline")}
                ${th("date", "Created")}
                <th>Actions</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`
      }`;

  root
    .querySelector("#btnNJ")
    ?.addEventListener("click", () => openJobModal(null));
  root
    .querySelector("#btnExportAllPDF")
    ?.addEventListener("click", exportAllPDF);
  root.querySelector("#btnExportCSV")?.addEventListener("click", exportCSV);

  root.querySelectorAll(".tagFilterPill").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.tagFilter = btn.dataset.tag;
      render();
    }),
  );

  root.querySelector("#dfFrom")?.addEventListener("change", (e) => {
    state.dateFilter.from = parseDate(e.target.value);
    render();
  });
  root.querySelector("#dfTo")?.addEventListener("change", (e) => {
    state.dateFilter.to = parseDate(e.target.value);
    render();
  });
  root.querySelector("#btnClearDate")?.addEventListener("click", () => {
    state.dateFilter = { from: null, to: null };
    render();
  });

  root.querySelectorAll(".filterPill").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.filter = btn.dataset.fv;
      render();
    }),
  );
  root.querySelectorAll("th.sortable").forEach((thEl) => {
    const doSort = () => {
      const col = thEl.dataset.sort;
      state.sort =
        state.sort.col === col
          ? { col, dir: state.sort.dir === "asc" ? "desc" : "asc" }
          : { col, dir: "asc" };
      render();
    };
    thEl.addEventListener("click", doSort);
    thEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        doSort();
      }
    });
  });
  root.querySelectorAll("tr[data-detail]").forEach((tr) =>
    tr.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      const j = state.jobs.find((x) => x.id === tr.dataset.detail);
      if (j) openJobDetailModal(j);
    }),
  );
  root.querySelectorAll("button[data-detail]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const j = state.jobs.find((x) => x.id === btn.dataset.detail);
      if (j) openJobDetailModal(j);
    }),
  );
  root.querySelectorAll("[data-dup]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const j = state.jobs.find((x) => x.id === btn.dataset.dup);
      if (j) duplicateJob(j);
    }),
  );
  root.querySelectorAll("[data-edit]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const j = state.jobs.find((x) => x.id === btn.dataset.edit);
      if (j) openJobModal(j);
    }),
  );
  root.querySelectorAll("[data-qr]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const j = state.jobs.find((x) => x.id === btn.dataset.qr);
      if (j) showQRModal(j);
    }),
  );
  root.querySelectorAll("[data-del]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const j = state.jobs.find((x) => x.id === btn.dataset.del);
      if (!j) return;
      if (demoBlock()) return;
      confirm("Delete Job", j.name, "Delete", () => {
        idb
          .del(APP.stores.jobs, j.id)
          .then(() => {
            state.jobs = state.jobs.filter((x) => x.id !== j.id);
            toast.warn("Job deleted", j.name);
            render();
          })
          .catch(() => toast.error("Error", "Could not delete job."));
      });
    }),
  );
}

/* ─── Templates ──────────────────────────────── */
function renderTemplates(root) {
  root.innerHTML = `
      <div class="pageHeader">
        <h2 class="pageTitle">Templates <span class="muted" style="font-size:14px;font-weight:400;">(${state.templates.length})</span></h2>
        <button class="btn primary admin-only" id="btnNT">+ New Template</button>
      </div>
      <p class="help" style="margin-bottom:16px;">Templates pre-fill cost items when you create a new job.</p>
      ${
        state.templates.length === 0
          ? `<div class="empty">No templates created yet.</div>`
          : `<div class="cardList">
            ${state.templates
              .map(
                (t) => `
              <div class="card cardBody">
                <div class="row space" style="gap:14px;flex-wrap:wrap;">
                  <div style="min-width:0;">
                    <div class="cardTitle">${esc(t.name)}</div>
                    ${t.description ? `<div class="cardSub" style="margin-top:4px;">${esc(t.description)}</div>` : ""}
                    <div class="muted" style="font-size:12px;margin-top:6px;">
                      ${(t.costs || []).length} item(s) ·
                      Est. total: <strong>${fmt((t.costs || []).reduce((s, c) => s + (c.qty || 0) * (c.unitCost || 0), 0))}</strong>
                    </div>
                  </div>
                  <div style="display:flex;gap:8px;flex-shrink:0;">
                    <button class="btn admin-only" data-et="${t.id}">Edit</button>
                    <button class="btn danger admin-only" data-dt="${t.id}">Delete</button>
                  </div>
                </div>
              </div>`,
              )
              .join("")}
          </div>`
      }`;

  root
    .querySelector("#btnNT")
    ?.addEventListener("click", () => openTemplateModal(null));
  root.querySelectorAll("[data-et]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = state.templates.find((x) => x.id === btn.dataset.et);
      if (t) openTemplateModal(t);
    });
  });
  root.querySelectorAll("[data-dt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = state.templates.find((x) => x.id === btn.dataset.dt);
      if (!t) return;
      if (demoBlock()) return;
      confirm("Delete Template", t.name, "Delete", () => {
        idb
          .del(APP.stores.templates, t.id)
          .then(() => {
            state.templates = state.templates.filter((x) => x.id !== t.id);
            toast.warn("Template deleted", t.name);
            render();
          })
          .catch(() => toast.error("Error", "Could not delete template."));
      });
    });
  });
}

/* ─── Field App ──────────────────────────────── */
function renderFieldApp(root) {
  const activeJobs = state.jobs.filter((j) => j.status === "Active");
  const jobList = activeJobs.length ? activeJobs : state.jobs;
  const pendingId = state.fieldSession._pendingJobId || null;
  const opts = jobList.length
    ? jobList
        .map(
          (j) =>
            `<option value="${j.id}" ${state.fieldSession.data?.jobId === j.id || (!state.fieldSession.data && pendingId === j.id) ? "selected" : ""}>${esc(j.name)}</option>`,
        )
        .join("")
    : `<option value="">No jobs available</option>`;
  if (pendingId) delete state.fieldSession._pendingJobId;

  const recentLogs = [...state.timeLogs]
    .sort((a, b) => b.date - a.date)
    .slice(0, 8);

  const elapsed = state.fieldSession.active
    ? fmtDuration(Date.now() - state.fieldSession.data.timeIn)
    : "00:00:00";

  root.innerHTML = `
      <div class="fieldLayout">
        <div class="card fieldAppWrapper">
          <h2 style="margin:0;font-size:18px;">Time Tracking</h2>
          ${
            !jobList.length
              ? `<div class="empty" style="max-width:320px;">No jobs available. Ask an admin to create jobs with "Active" status.</div>`
              : `
              <div style="width:100%;max-width:360px;">
                <label for="fieldJobSel" style="display:block;margin-bottom:6px;font-size:12px;font-weight:600;">Job</label>
                <select id="fieldJobSel" class="input" ${state.fieldSession.active ? "disabled" : ""}>${opts}</select>
              </div>
              <button id="btnClock" type="button" class="clockBtn ${state.fieldSession.active ? "clocked-in" : ""}">
                ${state.fieldSession.active ? "CLOCK OUT" : "CLOCK IN"}
              </button>
              ${
                state.fieldSession.active
                  ? `
              <div class="timerDisplay">
                <span id="liveTimer">${elapsed}</span>
                <span class="timerLabel">in progress since ${new Date(state.fieldSession.data.timeIn).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              <div style="width:100%;max-width:360px;">
                <label for="clockNote" style="display:block;margin-bottom:6px;font-size:12px;font-weight:600;">Note when clocking out (optional)</label>
                <input id="clockNote" class="input" type="text" maxlength="200" placeholder="What was done this session…"/>
              </div>`
                  : ""
              }
              <div id="geoDisplay" class="geoData">
                ${(() => {
                  if (!state.fieldSession.active) return "Ready to log.";
                  const d = state.fieldSession.data;
                  const pinIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px;opacity:.8" aria-hidden="true"><circle cx="12" cy="10" r="3"/><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>`;
                  const loc = d.address
                    ? `${pinIcon}${esc(d.address)}`
                    : d.lat != null
                      ? `${pinIcon}${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`
                      : `${pinIcon}Location unavailable`;
                  const wx = d.weather;
                  let wxLine = "";
                  if (wx) {
                    wxLine = `<br><span class="weatherLine">${weatherIcon(wx.code)} ${wx.temp}°F · ${wx.desc} · 💨 ${wx.wind} mph${wx.precip > 0 ? ` · 🌧 ${wx.precip}"` : ""}${wx.humidity != null ? ` · 💧${wx.humidity}%` : ""}</span>`;
                    if (wx.humidity != null) {
                      const hi = calcHeatIndex(wx.temp, wx.humidity);
                      const hil = heatIndexLevel(hi);
                      if (hil) {
                        wxLine += `<div class="heatAlert" style="background:${hil.color}22;color:${hil.color};margin-top:4px;">${hil.emoji} Heat Index: ${hi}°F — ${hil.level}</div>`;
                      }
                    }
                  }
                  const hurricaneNote = isHurricaneSeason()
                    ? `<div class="muted" style="font-size:11px;margin-top:4px;">🌀 Hurricane season active — stay alert</div>`
                    : "";
                  return loc + wxLine + hurricaneNote;
                })()}
              </div>`
          }
        </div>
        ${
          recentLogs.length
            ? `
        <div class="card">
          <div class="cardHeader"><div class="cardTitle">Recent Logs</div></div>
          <div class="tableWrap">
            <table class="table">
              <thead><tr><th>Job</th><th>Date</th><th style="text-align:right;">Hours</th><th>Note</th></tr></thead>
              <tbody>
                ${recentLogs
                  .map((l) => {
                    const j = state.jobs.find((x) => x.id === l.jobId);
                    return `<tr>
                    <td>${j ? esc(j.name) : `<span class="muted">—</span>`}</td>
                    <td>${fmtDate(l.date)}</td>
                    <td style="text-align:right;"><strong>${(l.hours || 0).toFixed(2)}h</strong></td>
                    <td><span class="small">${l.note ? esc(l.note) : `<span class="faint">—</span>`}</span></td>
                  </tr>`;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>`
            : ""
        }
      </div>`;

  if (!jobList.length) return;

  /* Start live timer if already clocked in */
  if (state.fieldSession.active && !state.liveTimer) {
    state.liveTimer = setInterval(() => {
      const el = document.getElementById("liveTimer");
      if (el) {
        el.textContent = fmtDuration(
          Date.now() - state.fieldSession.data.timeIn,
        );
      } else {
        clearInterval(state.liveTimer);
        state.liveTimer = null;
      }
    }, 1000);
  }

  $("#btnClock", root)?.addEventListener("click", () => {
    if (demoBlock()) return;
    const geo = $("#geoDisplay", root);
    if (!state.fieldSession.active) {
      /* Clock in */
      if (!navigator.geolocation) {
        const reason =
          location.protocol !== "https:" && location.hostname !== "localhost"
            ? "GPS requires HTTPS. Host the app on a secure URL (e.g. GitHub Pages)."
            : "GPS not available in this browser.";
        geo.textContent = reason;
        toast.warn("GPS unavailable", reason);
        state.fieldSession.active = true;
        state.fieldSession.data = {
          lat: null,
          lng: null,
          address: null,
          timeIn: Date.now(),
          jobId: $("#fieldJobSel", root).value,
        };
        if (state.liveTimer) clearInterval(state.liveTimer);
        state.liveTimer = null;
        renderFieldApp(root);
        return;
      }
      geo.textContent = "Getting GPS location…";
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          state.fieldSession.active = true;
          state.fieldSession.data = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            address: null,
            timeIn: Date.now(),
            jobId: $("#fieldJobSel", root).value,
          };
          if (state.liveTimer) clearInterval(state.liveTimer);
          state.liveTimer = null;
          renderFieldApp(root);
          toast.info(
            "Clocked In",
            `${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`,
          );
          /* Reverse geocode in background */
          reverseGeocode(pos.coords.latitude, pos.coords.longitude, (addr) => {
            if (state.fieldSession.data) state.fieldSession.data.address = addr;
            const geoEl = document.getElementById("geoDisplay");
            if (geoEl) {
              const wx = state.fieldSession.data?.weather;
              const _pin1 = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px;opacity:.8" aria-hidden="true"><circle cx="12" cy="10" r="3"/><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>`;
              geoEl.innerHTML = `${_pin1}${esc(addr)}${wx ? `<br><span class="weatherLine">${weatherIcon(wx.code)} ${wx.temp}°F · ${wx.desc} · 💨 ${wx.wind} mph${wx.precip > 0 ? ` · 🌧 ${wx.precip}"` : ""}</span>` : ""}`;
            }
          });
          /* Fetch weather in background */
          fetchWeather(pos.coords.latitude, pos.coords.longitude, (wx) => {
            if (state.fieldSession.data) state.fieldSession.data.weather = wx;
            const geoEl = document.getElementById("geoDisplay");
            if (geoEl) {
              const addr = state.fieldSession.data?.address;
              let wxContent = `<span class="weatherLine">${weatherIcon(wx.code)} ${wx.temp}°F · ${wx.desc} · 💨 ${wx.wind} mph${wx.precip > 0 ? ` · 🌧 ${wx.precip}"` : ""}${wx.humidity != null ? ` · 💧${wx.humidity}%` : ""}</span>`;
              if (wx.humidity != null) {
                const hi = calcHeatIndex(wx.temp, wx.humidity);
                const hil = heatIndexLevel(hi);
                if (hil)
                  wxContent += `<div class="heatAlert" style="background:${hil.color}22;color:${hil.color};">${hil.emoji} Heat Index: ${hi}°F — ${hil.level}</div>`;
              }
              const hurricaneNote = isHurricaneSeason()
                ? `<div class="muted" style="font-size:11px;margin-top:4px;">🌀 Hurricane season active — stay alert</div>`
                : "";
              const _pin2 = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px;opacity:.8" aria-hidden="true"><circle cx="12" cy="10" r="3"/><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>`;
              geoEl.innerHTML = `${addr ? `${_pin2}${esc(addr)}<br>` : ""}${wxContent}${hurricaneNote}`;
            }
          });
        },
        () => {
          /* GPS denied — clock in without coordinates */
          state.fieldSession.active = true;
          state.fieldSession.data = {
            lat: null,
            lng: null,
            address: null,
            timeIn: Date.now(),
            jobId: $("#fieldJobSel", root).value,
          };
          if (state.liveTimer) clearInterval(state.liveTimer);
          state.liveTimer = null;
          renderFieldApp(root);
          toast.warn("GPS unavailable", "Session started without coordinates.");
        },
        { timeout: 15000, maximumAge: 60000 },
      );
    } else {
      /* Clock out */
      const hrs = (Date.now() - state.fieldSession.data.timeIn) / 3600000;
      const note = $("#clockNote", root)?.value.trim() || "";
      const log = {
        id: uid(),
        jobId: state.fieldSession.data.jobId,
        hours: hrs,
        date: Date.now(),
        note,
        lat: state.fieldSession.data.lat || null,
        lng: state.fieldSession.data.lng || null,
      };
      clearInterval(state.liveTimer);
      state.liveTimer = null;
      idb
        .put(APP.stores.timeLogs, log)
        .then(() => {
          state.timeLogs.push(log);
          state.fieldSession.active = false;
          state.fieldSession.data = null;
          toast.success("Session saved", `${hrs.toFixed(2)} hours logged.`);
          renderFieldApp(root);
        })
        .catch(() => toast.error("Error", "Could not save time log."));
    }
  });
}

/* ─── Analytics ──────────────────────────────── */
function renderBI(root) {
  const statusCounts = state.jobs.reduce((a, j) => {
    a[j.status] = (a[j.status] || 0) + 1;
    return a;
  }, {});
  const topJobs = [...state.jobs]
    .sort((a, b) => jobCost(b) - jobCost(a))
    .slice(0, 8);
  const hrsByJob = state.timeLogs.reduce((a, l) => {
    a[l.jobId] = (a[l.jobId] || 0) + (l.hours || 0);
    return a;
  }, {});

  const hasLogs = state.timeLogs.length > 0;
  const hasJobs = state.jobs.length > 0;
  const hasCosts = topJobs.some((j) => jobCost(j) > 0);
  const hasHoursEst = state.jobs.some((j) => j.estimatedHours);

  /* Build last-12-months revenue & cost data */
  const now12 = new Date();
  const monthLabels = [];
  const monthRevData = [];
  const monthCostData = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now12.getFullYear(), now12.getMonth() - i, 1);
    monthLabels.push(
      d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
    );
    const mJobs = state.jobs.filter((j) => {
      const jd = new Date(j.date);
      return (
        jd.getFullYear() === d.getFullYear() && jd.getMonth() === d.getMonth()
      );
    });
    monthRevData.push(mJobs.reduce((s, j) => s + (j.value || 0), 0));
    monthCostData.push(mJobs.reduce((s, j) => s + jobCost(j), 0));
  }
  const hasMonthlyData = monthRevData.some((v) => v > 0);

  root.innerHTML = `
      <h2 class="pageTitle" style="margin-bottom:18px;">Analytics</h2>
      <div class="biGrid">
        ${
          hasMonthlyData
            ? `
        <div class="chartWrap" style="grid-column:1/-1;">
          <h3>Monthly Revenue vs. Cost (Last 12 Months)</h3>
          <canvas id="chartMonthly"></canvas>
        </div>`
            : ""
        }
        <div class="chartWrap">
          <h3>Jobs by Status</h3>
          ${hasJobs ? `<canvas id="chartStatus"></canvas>` : `<div class="empty">No jobs created yet.</div>`}
        </div>
        <div class="chartWrap">
          <h3>Hours by Job</h3>
          ${hasLogs ? `<canvas id="chartTime"></canvas>` : `<div class="empty">No time logs yet.</div>`}
        </div>
        ${
          hasCosts
            ? `
        <div class="chartWrap" style="grid-column:1/-1;">
          <h3>Total Cost vs. Estimated Value</h3>
          <canvas id="chartCosts"></canvas>
        </div>`
            : ""
        }
        ${
          hasHoursEst
            ? `
        <div class="chartWrap" style="grid-column:1/-1;">
          <h3>Estimated vs. Actual Hours by Job</h3>
          <canvas id="chartHours"></canvas>
        </div>`
            : ""
        }
      </div>`;

  setTimeout(() => {
    if (!window.Chart) return;
    const style = getComputedStyle(document.documentElement);
    const textColor = style.getPropertyValue("--text").trim() || "#e7ecf5";
    const mutedColor = style.getPropertyValue("--muted").trim() || "#aab5cc";
    const gridColor =
      style.getPropertyValue("--border").trim() || "rgba(255,255,255,.08)";
    Chart.defaults.color = mutedColor;
    const scaleOpts = {
      y: {
        beginAtZero: true,
        ticks: { color: mutedColor },
        grid: { color: gridColor },
      },
      x: { ticks: { color: mutedColor }, grid: { color: gridColor } },
    };

    /* Destroy any existing Chart instances before re-creating — prevents
       "Canvas is already in use" error when navigating away and back. */
    [
      "chartMonthly",
      "chartStatus",
      "chartTime",
      "chartCosts",
      "chartHours",
    ].forEach((id) => {
      const el = document.getElementById(id);
      if (el) Chart.getChart(el)?.destroy();
    });

    if (hasMonthlyData && $("#chartMonthly")) {
      new Chart($("#chartMonthly"), {
        type: "bar",
        data: {
          labels: monthLabels,
          datasets: [
            {
              label: "Revenue",
              data: monthRevData,
              backgroundColor: "rgba(122,162,255,.75)",
              borderRadius: 5,
              order: 2,
            },
            {
              label: "Cost",
              data: monthCostData,
              backgroundColor: "rgba(255,90,122,.65)",
              borderRadius: 5,
              order: 2,
            },
            {
              label: "Profit",
              data: monthRevData.map((r, i) => r - monthCostData[i]),
              type: "line",
              borderColor: "rgba(75,227,163,.9)",
              backgroundColor: "rgba(75,227,163,.15)",
              pointBackgroundColor: "rgba(75,227,163,1)",
              borderWidth: 2,
              tension: 0.35,
              fill: false,
              order: 1,
            },
          ],
        },
        options: {
          plugins: {
            legend: { position: "top", labels: { color: textColor } },
            tooltip: {
              callbacks: {
                label: (ctx) =>
                  ` ${ctx.dataset.label}: $${Number(ctx.raw).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
              },
            },
          },
          scales: scaleOpts,
        },
      });
    }

    if (hasJobs && $("#chartStatus")) {
      new Chart($("#chartStatus"), {
        type: "doughnut",
        data: {
          labels: Object.keys(statusCounts),
          datasets: [
            {
              data: Object.values(statusCounts),
              backgroundColor: ["#7f8aa3", "#7aa2ff", "#4be3a3", "#bb86fc"],
              borderWidth: 0,
            },
          ],
        },
        options: {
          plugins: {
            legend: {
              position: "bottom",
              labels: { color: mutedColor, padding: 12 },
            },
          },
        },
      });
    }

    if (hasLogs && $("#chartTime")) {
      const data = {};
      Object.entries(hrsByJob).forEach(([id, hrs]) => {
        const j = state.jobs.find((x) => x.id === id);
        data[j ? j.name.slice(0, 20) : "Unknown"] = +hrs.toFixed(2);
      });
      new Chart($("#chartTime"), {
        type: "bar",
        data: {
          labels: Object.keys(data),
          datasets: [
            {
              label: "Hours",
              data: Object.values(data),
              backgroundColor: "rgba(122,162,255,.75)",
              borderRadius: 6,
            },
          ],
        },
        options: {
          plugins: { legend: { display: false } },
          scales: scaleOpts,
        },
      });
    }

    if (hasCosts && $("#chartCosts")) {
      new Chart($("#chartCosts"), {
        type: "bar",
        data: {
          labels: topJobs.map((j) => j.name.slice(0, 20)),
          datasets: [
            {
              label: "Total Cost",
              data: topJobs.map((j) => jobCost(j)),
              backgroundColor: "rgba(255,90,122,.75)",
              borderRadius: 5,
            },
            {
              label: "Estimated Value",
              data: topJobs.map((j) => j.value || 0),
              backgroundColor: "rgba(122,162,255,.75)",
              borderRadius: 5,
            },
          ],
        },
        options: {
          plugins: {
            legend: { position: "top", labels: { color: textColor } },
          },
          scales: scaleOpts,
        },
      });
    }

    if (hasHoursEst && $("#chartHours")) {
      const jobsWithEst = state.jobs.filter((j) => j.estimatedHours);
      new Chart($("#chartHours"), {
        type: "bar",
        data: {
          labels: jobsWithEst.map((j) => j.name.slice(0, 20)),
          datasets: [
            {
              label: "Estimated Hours",
              data: jobsWithEst.map((j) => j.estimatedHours),
              backgroundColor: "rgba(122,162,255,.65)",
              borderRadius: 5,
            },
            {
              label: "Actual Hours",
              data: jobsWithEst.map((j) =>
                state.timeLogs
                  .filter((l) => l.jobId === j.id)
                  .reduce((s, l) => s + (l.hours || 0), 0),
              ),
              backgroundColor: "rgba(75,227,163,.65)",
              borderRadius: 5,
            },
          ],
        },
        options: {
          plugins: {
            legend: { position: "top", labels: { color: textColor } },
          },
          scales: scaleOpts,
        },
      });
    }
  }, 120);
}

/* ─── Settings ───────────────────────────────── */
function renderSettings(root) {
  const s = state.settings;
  const now = Date.now();
  const in60 = now + 60 * 24 * 60 * 60 * 1000;
  const licWarn =
    s.licenseExpiry && s.licenseExpiry > now && s.licenseExpiry <= in60;
  const glWarn =
    s.glInsuranceExpiry &&
    s.glInsuranceExpiry > now &&
    s.glInsuranceExpiry <= in60;
  const wcWarn = s.wcExpiry && s.wcExpiry > now && s.wcExpiry <= in60;
  const licExp = s.licenseExpiry && s.licenseExpiry < now;
  const glExp = s.glInsuranceExpiry && s.glInsuranceExpiry < now;
  const wcExp = s.wcExpiry && s.wcExpiry < now;

  const mileYear = new Date().getFullYear();
  const mileLogs = state.mileageLogs
    .filter((ml) => {
      const d = ml.date ? new Date(ml.date) : null;
      return d && d.getFullYear() === mileYear;
    })
    .sort((a, b) => (b.date || 0) - (a.date || 0));
  const mileTotal = mileLogs.reduce((s, ml) => s + (ml.miles || 0), 0);
  const mileDed = mileLogs.reduce((s, ml) => s + (ml.deduction || 0), 0);

  root.innerHTML = `
      <div class="settingsLayout">

        <!-- Quick Stats -->
        <div class="card settings-full">
          <div class="cardBody">
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:12px;text-align:center;">
              <div>
                <div style="font-size:22px;font-weight:800;color:var(--primary);">${state.jobs.length}</div>
                <div style="font-size:11px;color:var(--muted);margin-top:2px;">Total Jobs</div>
              </div>
              <div>
                <div style="font-size:22px;font-weight:800;color:var(--ok);">${state.clients.length}</div>
                <div style="font-size:11px;color:var(--muted);margin-top:2px;">Clients</div>
              </div>
              <div>
                <div style="font-size:22px;font-weight:800;color:var(--text);">${state.crew.length}</div>
                <div style="font-size:11px;color:var(--muted);margin-top:2px;">Crew</div>
              </div>
              <div>
                <div style="font-size:22px;font-weight:800;color:var(--warn);">${state.estimates.length}</div>
                <div style="font-size:11px;color:var(--muted);margin-top:2px;">Estimates</div>
              </div>
              <div>
                <div style="font-size:22px;font-weight:800;color:var(--text);">${fmt(state.jobs.reduce((s,j)=>s+(j.value||j.revenue||0),0))}</div>
                <div style="font-size:11px;color:var(--muted);margin-top:2px;">Total Pipeline</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Install App -->
        <button id="btnInstallApp" class="btn primary settings-full" style="display:none;align-items:center;gap:8px;font-size:1rem;">
          📥 Install JobCost Pro
        </button>

        <!-- Access & Profile -->
        <div class="card">
          <div class="cardHeader"><div class="cardTitle">Access &amp; Profile</div></div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:14px;">
            <div class="fieldGrid">
              <div class="field">
                <label for="selRole">Access Level</label>
                <select id="selRole">
                  <option value="admin" ${s.role === "admin" ? "selected" : ""}>Administrator — full access</option>
                  <option value="field" ${s.role === "field" ? "selected" : ""}>Field Worker — Dashboard &amp; Field only</option>
                </select>
              </div>
              <div class="field">
                <label for="selLang">Language / Idioma</label>
                <select id="selLang">
                  <option value="en" ${s.language === "en" ? "selected" : ""}>English</option>
                  <option value="es" ${s.language === "es" ? "selected" : ""}>Español</option>
                </select>
              </div>
              <div class="field">
                <label for="selTheme">Appearance</label>
                <select id="selTheme">
                  <option value="dark"  ${s.theme === "dark"  ? "selected" : ""}>Dark Mode</option>
                  <option value="light" ${s.theme === "light" ? "selected" : ""}>Light Mode</option>
                </select>
              </div>
            </div>
            <button class="btn primary" id="btnSave">Save Settings</button>
          </div>
        </div>

        <!-- Company Branding -->
        <div class="card settings-full">
          <div class="cardHeader"><div class="cardTitle">Company Branding</div></div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:14px;">
            <div class="fieldGrid">
              <div class="field">
                <label for="selCompany">Company Name</label>
                <input id="selCompany" class="input" type="text" maxlength="100" placeholder="e.g. Acme Insulation" value="${esc(s.company || "")}"/>
              </div>
              <div class="field">
                <label for="selPhone">Phone</label>
                <input id="selPhone" class="input" type="tel" maxlength="30" placeholder="(555) 000-0000" value="${esc(s.companyPhone || "")}"/>
              </div>
              <div class="field">
                <label for="selEmail">Email</label>
                <input id="selEmail" class="input" type="email" maxlength="100" placeholder="office@kinginsulation.com" value="${esc(s.companyEmail || "")}"/>
              </div>
              <div class="field">
                <label for="selAddress">Address</label>
                <input id="selAddress" class="input" type="text" maxlength="150" placeholder="123 Main St, Miami, FL 33101" value="${esc(s.companyAddress || "")}"/>
              </div>
              <div class="field">
                <label for="selReviewUrl">Google Review Link</label>
                <input id="selReviewUrl" class="input" type="url" maxlength="300" placeholder="https://g.page/r/..." value="${esc(s.googleReviewUrl || "")}"/>
                <p class="help" style="margin-top:4px;">Used in the Review Request feature.</p>
              </div>
              <div class="field">
                <label for="selWebsite">Company Website</label>
                <input id="selWebsite" class="input" type="url" maxlength="200"
                  placeholder="https://yourcompany.com"
                  value="${esc(s.companyWebsite || "")}"/>
              </div>
            </div>
            <div class="field" style="grid-column:1/-1;">
              <label>Company Logo</label>
              <div class="logoUploadArea">
                <div class="logoPreviewBox">
                  ${
                    s.logoDataUrl
                      ? `<img src="${s.logoDataUrl}" class="logoPreviewImg" alt="Company logo"/>`
                      : `<div class="logoPlaceholder">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" opacity=".4">
                          <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.6"/>
                          <circle cx="8.5" cy="10.5" r="1.5" stroke="currentColor" stroke-width="1.4"/>
                          <path d="M3 16l5-4 4 3 3-2 6 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                        <span>No logo</span>
                      </div>`
                  }
                </div>
                <div style="display:flex;flex-direction:column;gap:8px;">
                  <label class="btn" style="cursor:pointer;width:fit-content;">
                    📁 Upload Logo
                    <input type="file" id="selLogo" accept="image/*" style="display:none;"/>
                  </label>
                  ${s.logoDataUrl ? `<button class="btn danger" id="btnRemoveLogo" style="padding:6px 14px;width:fit-content;">🗑 Remove</button>` : ""}
                  <p class="help">PNG or JPG. Max 3 MB. Will be resized to 240×240 px.<br>Appears on invoices, estimates, certificates, and PDFs.</p>
                </div>
              </div>
            </div>
            <button class="btn primary" id="btnSaveBranding">Save Branding</button>
          </div>
        </div>

        <!-- Compliance / Licenses -->
        <div class="card">
          <div class="cardHeader"><div class="cardTitle">Florida Compliance &amp; Licenses</div></div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:14px;">
            ${licExp || glExp || wcExp ? `<div class="hurricaneBanner" style="background:rgba(255,60,60,.15);border-color:rgba(255,60,60,.4);color:var(--danger);">⚠ ${[licExp ? "Contractor license EXPIRED" : null, glExp ? "GL Insurance EXPIRED" : null, wcExp ? "Workers Comp EXPIRED" : null].filter(Boolean).join(" · ")}</div>` : ""}
            ${licWarn || glWarn || wcWarn ? `<div class="hurricaneBanner">⚠ Expiring soon: ${[licWarn ? "Contractor License" : null, glWarn ? "GL Insurance" : null, wcWarn ? "Workers Comp" : null].filter(Boolean).join(", ")} — renew within 60 days</div>` : ""}
            <div class="fieldGrid">
              <div class="field">
                <label for="selLicNum">Contractor License #</label>
                <input id="selLicNum" class="input" type="text" maxlength="50" placeholder="CGC123456" value="${esc(s.licenseNumber || "")}"/>
              </div>
              <div class="field">
                <label for="selLicExp">License Expiry</label>
                <input id="selLicExp" class="input" type="date" value="${fmtDateInput(s.licenseExpiry)}"/>
              </div>
              <div class="field">
                <label for="selGLExp">GL Insurance Expiry</label>
                <input id="selGLExp" class="input" type="date" value="${fmtDateInput(s.glInsuranceExpiry)}"/>
              </div>
              <div class="field">
                <label for="selWCExp">Workers' Comp Expiry</label>
                <input id="selWCExp" class="input" type="date" value="${fmtDateInput(s.wcExpiry)}"/>
              </div>
            </div>
            <button class="btn primary" id="btnSaveCompliance">Save Compliance Info</button>
          </div>
        </div>

        <!-- Job Defaults -->
        <div class="card">
          <div class="cardHeader"><div class="cardTitle">Job Defaults</div></div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:14px;">
            <div class="fieldGrid">
              <div class="field">
                <label for="selInvPrefix">Invoice Prefix</label>
                <input id="selInvPrefix" class="input" type="text" maxlength="10" placeholder="INV" value="${esc(s.invoicePrefix || "INV")}"/>
                <p class="help" style="margin-top:4px;">Next: <strong>${getNextInvoiceNumberPreview()}</strong></p>
              </div>
              <div class="field">
                <label for="selMarkup">Default Markup (%)</label>
                <input id="selMarkup" class="input" type="number" min="0" step="0.1" placeholder="0" value="${s.defaultMarkup || 0}"/>
                <p class="help" style="margin-top:4px;">Shown as target margin in job modal.</p>
              </div>
              <div class="field">
                <label for="selMinMargin">Target Minimum Margin (%)</label>
                <input id="selMinMargin" class="input" type="number" min="0" max="100" step="1" placeholder="30" value="${s.minMargin ?? 30}"/>
                <p class="help" style="margin-top:4px;">Jobs below this margin show a ⚠ alert on Kanban &amp; Dashboard.</p>
              </div>
              <div class="field">
                <label for="selMonthlyGoal">Monthly Revenue Goal ($)</label>
                <input id="selMonthlyGoal" class="input" type="number" min="0" step="100"
                  placeholder="e.g. 10000"
                  value="${s.monthlyGoal || ""}"/>
                <p class="help" style="margin-top:4px;">Used to show progress on the Dashboard.</p>
              </div>
              <div class="field">
                <label for="selMileage">IRS Mileage Rate ($/mile)</label>
                <input id="selMileage" class="input" type="number" min="0" step="0.001" placeholder="0.670" value="${s.mileageRate || 0.67}"/>
                <p class="help" style="margin-top:4px;">2024 IRS standard rate: $0.67/mile.</p>
              </div>
              <div class="field">
                <label for="selMPG">Average Vehicle MPG</label>
                <input id="selMPG" class="input" type="number" min="1" step="0.5" placeholder="15" value="${s.mpg || 15}"/>
                <p class="help" style="margin-top:4px;">Miles per gallon of your service vehicle.</p>
              </div>
              <div class="field">
                <label for="selGasPrice">Avg. Gas Price ($/gal)</label>
                <input id="selGasPrice" class="input" type="number" min="0" step="0.01" placeholder="3.50" value="${s.gasPrice || 3.5}"/>
                <p class="help" style="margin-top:4px;">Used to estimate fuel cost per job.</p>
              </div>
              <div class="field">
                <label for="selTravelFee">Default Travel Fee ($)</label>
                <input id="selTravelFee" class="input" type="number" min="0" step="0.01" placeholder="0.00" value="${s.defaultTravelFee || 0}"/>
                <p class="help" style="margin-top:4px;">Flat fee added to estimates when travel is enabled.</p>
              </div>
              <div class="field">
                <label for="selTravelRate">Travel Rate ($/mile)</label>
                <input id="selTravelRate" class="input" type="number" min="0" step="0.01" placeholder="0.00" value="${s.travelRatePerMile || 0}"/>
                <p class="help" style="margin-top:4px;">Optional per-mile rate (enter miles in the estimate to auto-calculate).</p>
              </div>
              <div class="field">
                <label for="selDefaultTax">Default Tax Rate (%)</label>
                <input id="selDefaultTax" class="input" type="number" min="0" max="30" step="0.01"
                  placeholder="0.00"
                  value="${s.defaultTaxRate || 0}"/>
                <p class="help" style="margin-top:4px;">Pre-filled in new estimates. Can be changed per estimate.</p>
              </div>
              <div class="field">
                <label for="selValidDays">Estimate Valid For (days)</label>
                <input id="selValidDays" class="input" type="number" min="1" max="365" step="1"
                  placeholder="30"
                  value="${s.estimateValidDays || 30}"/>
                <p class="help" style="margin-top:4px;">Sets the "Valid Until" date when creating estimates.</p>
              </div>
              <div class="field" style="grid-column:1/-1;">
                <label for="selPayTerms">Default Payment Terms</label>
                <select id="selPayTerms" class="input">
                  ${["Due upon receipt","Net 15","Net 30","Net 45","Net 60","50% deposit required","Paid in full at completion"].map(t =>
                    `<option value="${t}" ${(s.defaultPaymentTerms || "Due upon receipt") === t ? "selected" : ""}>${t}</option>`
                  ).join("")}
                </select>
                <p class="help" style="margin-top:4px;">Printed on invoices and estimates.</p>
              </div>
              <div class="field">
                <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                  <input id="selNotify" type="checkbox" ${s.notificationsEnabled ? "checked" : ""} style="width:18px;height:18px;cursor:pointer;"/>
                  <span>Enable Deadline Notifications</span>
                </label>
                <p class="help" style="margin-top:4px;">Browser notifications for overdue &amp; upcoming jobs.</p>
              </div>
            </div>
            <button class="btn primary" id="btnSaveDefaults">Save Defaults</button>
          </div>
        </div>

        <!-- API Integrations -->
        <div class="card">
          <div class="cardHeader"><div class="cardTitle">API Integrations</div></div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:14px;">
            <div class="fieldGrid">
              <div class="field" style="grid-column:1/-1;">
                <label for="selGMapsKey">Google Maps API Key <span class="muted" style="font-weight:400;font-size:11px;">(optional — enhances distance calc)</span></label>
                <input id="selGMapsKey" class="input" type="text" maxlength="100" placeholder="AIza..." value="${esc(s.googleMapsApiKey || "")}"/>
                <p class="help" style="margin-top:4px;">If left blank, driving distance is calculated using free routing (OSRM). With a key, Google Maps precision is used.</p>
              </div>
            </div>
            <button class="btn primary" id="btnSaveIntegrations">Save API Keys</button>
          </div>
        </div>

        <!-- Service Catalog (Price Book) -->
        <div class="card settings-full">
          <div class="cardHeader">
            <div class="cardTitle">Service Catalog (Price Book)</div>
            <button class="btn primary" id="btnAddPBItem">＋ Add Service</button>
          </div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:10px;">
            <p class="help">Services listed here appear as Quick Add tags in every estimate. Click a tag to auto-fill name, description and unit price.</p>
            ${
              state.pricebook.length === 0
                ? `<div class="empty" style="padding:10px 0;">No services yet. Add your first one above.</div>`
                : `<div class="tableWrap"><table class="table">
                  <thead><tr>
                    <th>Service Name</th>
                    <th>Description / R-Value</th>
                    <th style="text-align:right;">Default Price</th>
                    <th></th>
                  </tr></thead>
                  <tbody>
                    ${state.pricebook
                      .map(
                        (pb) => `<tr>
                          <td><strong>${esc(pb.name)}</strong></td>
                          <td class="muted">${esc(pb.description || "—")}</td>
                          <td style="text-align:right;">${pb.unitPrice ? fmt(pb.unitPrice) : `<span class="muted">—</span>`}</td>
                          <td>
                            <div style="display:flex;gap:4px;">
                              <button class="btn" data-pbedit="${pb.id}" style="padding:4px 8px;font-size:11px;">Edit</button>
                              <button class="btn danger" data-pbdel="${pb.id}" style="padding:4px 8px;font-size:11px;">Del</button>
                            </div>
                          </td>
                        </tr>`,
                      )
                      .join("")}
                  </tbody>
                </table></div>`
            }
          </div>
        </div>

        <!-- Materials Configuration -->
        <div class="card settings-full">
          <div class="cardHeader">
            <div class="cardTitle">Materials Configuration</div>
            <div style="display:flex;gap:8px;">
              <button class="btn" id="btnOpenMatCalc"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px" aria-hidden="true"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="10" x2="10" y2="10"/><line x1="14" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="10" y2="14"/><line x1="14" y1="14" x2="16" y2="14"/><line x1="8" y1="18" x2="16" y2="18"/></svg>Calculator</button>
              <button class="btn primary" id="btnAddMaterial">＋ Add Material</button>
            </div>
          </div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:10px;">
            <p class="help">Define your materials and their <strong>yield (sq ft per unit)</strong>. The calculator uses these values — change them here and all future calculations update instantly.</p>
            ${
              state.materials.length === 0
                ? `<div class="empty" style="padding:10px 0;">No materials yet. Add your first material above to enable the calculator.</div>`
                : `<div class="tableWrap"><table class="table">
                  <thead><tr>
                    <th>Material Name</th>
                    <th style="text-align:right;">Coverage / Unit</th>
                    <th style="text-align:right;">Thickness (in)</th>
                    <th style="text-align:right;">Cost / Unit</th>
                    <th></th>
                  </tr></thead>
                  <tbody>
                    ${state.materials
                      .map(
                        (mt) => `<tr>
                      <td><strong>${esc(mt.name)}</strong><br><span class="muted small">${esc(mt.unit)}</span></td>
                      <td style="text-align:right;font-weight:700;color:var(--ok);">${mt.coveragePerUnit} sq ft/${mt.unit}</td>
                      <td style="text-align:right;">${mt.thickness ? `${mt.thickness}"` : `<span class="muted">—</span>`}</td>
                      <td style="text-align:right;">${mt.costPerUnit ? fmt(mt.costPerUnit) : `<span class="muted">—</span>`}</td>
                      <td>
                        <div style="display:flex;gap:4px;">
                          <button class="btn" data-mtedit="${mt.id}" style="padding:4px 8px;font-size:11px;">Edit</button>
                          <button class="btn danger" data-mtdel="${mt.id}" style="padding:4px 8px;font-size:11px;">Del</button>
                        </div>
                      </td>
                    </tr>`,
                      )
                      .join("")}
                  </tbody>
                </table></div>`
            }
          </div>
        </div>

        <!-- Reports -->
        <div class="card settings-full">
          <div class="cardHeader"><div class="cardTitle">Reports</div></div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:12px;">
            <div class="reportsButtonGroup" style="display:flex;flex-wrap:wrap;gap:8px;">
              <button class="btn" id="btnTaxSummary"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px" aria-hidden="true"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/></svg>Tax Summary</button>
              <button class="btn" id="btnSettingsPayroll"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>Payroll Report</button>
              <button class="btn" id="btnSExp">⬇ JSON Backup</button>
              <button class="btn" id="btnSCSV">⬇ Export CSV</button>
              <button class="btn" id="btnQBExport">⬇ QuickBooks CSV</button>
              <button class="btn" id="btnAllPDF"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="12" y2="17"/></svg>Full Report PDF</button>
              <button class="btn" id="btnSImp">⬆ Import Backup</button>
              <input type="file" id="fileImport" accept=".json" style="display:none;"/>
            </div>
            <p class="help">JSON backup includes all data. Import merges without deleting existing records.</p>
          </div>
        </div>

        <!-- Data Migration -->
        <div class="card settings-full">
          <div class="cardHeader">
            <div class="cardTitle">Import from Another App</div>
            <span class="badge" style="font-size:11px;background:rgba(122,162,255,.15);color:var(--primary);padding:3px 10px;border-radius:20px;">Beta</span>
          </div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:14px;">
            <p class="help">Migrate your existing data from another field service app or spreadsheet. Your existing JobCost Pro data will not be deleted.</p>
            <div class="fieldGrid">
              <div class="field">
                <label for="selMigSource">Source Format</label>
                <select id="selMigSource" class="input">
                  <option value="">— Select source app —</option>
                  <option value="jobcost">JobCost Pro Backup (JSON)</option>
                  <option value="csv_generic">Generic CSV (Excel / Google Sheets)</option>
                  <option value="jobber">Jobber CSV Export</option>
                  <option value="housecall">HouseCall Pro CSV Export</option>
                  <option value="servicetitan">ServiceTitan CSV Export</option>
                  <option value="quickbooks">QuickBooks Customer/Invoice CSV</option>
                </select>
              </div>
              <div class="field">
                <label for="selMigType">What to Import</label>
                <select id="selMigType" class="input">
                  <option value="all">Everything (Jobs + Clients + Estimates)</option>
                  <option value="clients">Clients only</option>
                  <option value="jobs">Jobs only</option>
                  <option value="estimates">Estimates only</option>
                </select>
              </div>
            </div>
            <div id="migInstructions" class="alertBanner" style="display:none;font-size:13px;line-height:1.7;"></div>
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
              <label class="btn primary" style="cursor:pointer;width:fit-content;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                Choose File
                <input type="file" id="fileMigration" accept=".json,.csv" style="display:none;"/>
              </label>
              <span id="migFileName" class="muted" style="font-size:13px;">No file selected</span>
            </div>
            <div id="migPreview" style="display:none;">
              <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px;" id="migPreviewTitle"></div>
              <div class="tableWrap" id="migPreviewTable"></div>
              <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;">
                <button class="btn primary" id="btnMigConfirm"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>Import Now</button>
                <button class="btn" id="btnMigCancel">Cancel</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Mileage Log -->
        <div class="card settings-full">
          <div class="cardHeader">
            <div class="cardTitle">Mileage Log — ${mileYear}</div>
            <button class="btn primary" id="btnAddMileage">+ Add Entry</button>
          </div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:10px;">
            <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:4px;">
              <div><span class="muted" style="font-size:12px;">Total Miles</span><br><strong>${mileTotal.toFixed(1)}</strong></div>
              <div><span class="muted" style="font-size:12px;">Total Deduction</span><br><strong style="color:var(--ok);">${fmt(mileDed)}</strong></div>
            </div>
            ${
              mileLogs.length === 0
                ? `<div class="empty" style="padding:10px 0;">No mileage entries for ${mileYear}.</div>`
                : `<div class="tableWrap"><table class="table">
                  <thead><tr><th>Date</th><th>Job</th><th>Description</th><th style="text-align:right;">Miles</th><th style="text-align:right;">Deduction</th><th></th></tr></thead>
                  <tbody>
                    ${mileLogs
                      .map((ml) => {
                        const job = state.jobs.find((j) => j.id === ml.jobId);
                        return `<tr>
                        <td>${fmtDate(ml.date)}</td>
                        <td>${job ? esc(job.name) : `<span class="muted">—</span>`}</td>
                        <td>${esc(ml.description || "")}</td>
                        <td style="text-align:right;">${(ml.miles || 0).toFixed(1)}</td>
                        <td style="text-align:right;">${fmt(ml.deduction || 0)}</td>
                        <td><button class="btn danger" data-dml="${ml.id}" style="padding:4px 8px;font-size:11px;">Del</button></td>
                      </tr>`;
                      })
                      .join("")}
                  </tbody>
                </table></div>`
            }
          </div>
        </div>

        <!-- Danger Zone -->
        <div class="card settings-full">
          <div class="cardHeader"><div class="cardTitle">Danger Zone</div></div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:12px;">
            <button class="btn danger" id="btnClear">Clear All Data</button>
            <p class="help" style="color:var(--danger);">Permanently removes all jobs, hours, templates, and clients. Export a backup first!</p>
          </div>
        </div>

        <!-- Subscription -->
        <div class="card settings-full">
          <div class="cardHeader"><div class="cardTitle">Subscription</div></div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:12px;">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:rgba(75,227,163,.08);border:1px solid rgba(75,227,163,.2);border-radius:12px;">
              <div>
                <div style="font-weight:700;color:${window.__demoMode ? "var(--warn)" : "var(--ok)"};">
                  ${window.__demoMode ? "👁 Explore Mode — Not subscribed" : "✓ JobCost Pro — Active"}
                </div>
                <div style="font-size:12px;color:var(--muted);margin-top:2px;">
                  ${window.__demoMode ? "Subscribe to unlock all features." : "$19 / month · Billed via Stripe"}
                </div>
              </div>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="var(--ok)" stroke-width="1.6"/><path d="M8 12l3 3 5-5" stroke="var(--ok)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
            <a href="https://billing.stripe.com/p/login/SEU_PORTAL_STRIPE_AQUI"
               target="_blank" rel="noopener noreferrer"
               class="btn"
               style="text-align:center;text-decoration:none;display:block;">
              Manage Billing &amp; Cancel Subscription
            </a>
            <p style="font-size:11px;color:var(--faint);text-align:center;">
              You'll be redirected to Stripe's secure billing portal.
            </p>
          </div>
        </div>

        <!-- About -->
        <div class="card settings-full">
          <div class="cardHeader"><div class="cardTitle">About</div></div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:6px;">
            <div><strong>JobCost Pro</strong> <span class="muted">v5.0</span></div>
            <div class="muted">Offline-first PWA · Field & Job Cost Management</div>
            <div class="hr"></div>
            <div class="small">${state.jobs.length} jobs · ${state.timeLogs.length} time logs · ${state.clients.length} clients · ${state.crew.length} crew · ${state.estimates.length} estimates</div>
            <div class="small">Shortcuts: <code class="kbd">Ctrl+K</code> search · <code class="kbd">Ctrl+N</code> new job · <code class="kbd">Esc</code> close modal</div>
          </div>
        </div>

      </div>`;

  /* Read every form field into state.settings so any save button captures the full form.
     str()  – allows empty string, keeps old value only if element is missing from DOM
     num()  – keeps old value when input is blank or NaN
     date() – allows user to clear a date back to null                                  */
  function syncAllFromDOM() {
    const g = (id) => root.querySelector(id);
    const str = (id, cur) => {
      const el = g(id);
      return el ? el.value.trim() : cur;
    };
    const num = (id, cur) => {
      const el = g(id);
      const v = parseFloat(el?.value);
      return isNaN(v) ? cur : v;
    };
    const date = (id, cur) => {
      const el = g(id);
      return el ? parseDate(el.value) || null : cur;
    };

    state.settings.role = g("#selRole")?.value ?? state.settings.role;
    state.settings.language = g("#selLang")?.value ?? state.settings.language;
    state.settings.company = str("#selCompany", state.settings.company);
    state.settings.companyPhone = str("#selPhone", state.settings.companyPhone);
    state.settings.companyEmail = str("#selEmail", state.settings.companyEmail);
    state.settings.companyAddress = str(
      "#selAddress",
      state.settings.companyAddress,
    );
    state.settings.googleReviewUrl = str(
      "#selReviewUrl",
      state.settings.googleReviewUrl,
    );
    state.settings.licenseNumber = str(
      "#selLicNum",
      state.settings.licenseNumber,
    );
    state.settings.licenseExpiry = date(
      "#selLicExp",
      state.settings.licenseExpiry,
    );
    state.settings.glInsuranceExpiry = date(
      "#selGLExp",
      state.settings.glInsuranceExpiry,
    );
    state.settings.wcExpiry = date("#selWCExp", state.settings.wcExpiry);
    state.settings.invoicePrefix =
      str("#selInvPrefix", state.settings.invoicePrefix) || "INV";
    state.settings.defaultMarkup = num(
      "#selMarkup",
      state.settings.defaultMarkup,
    );
    state.settings.minMargin = num("#selMinMargin", state.settings.minMargin);
    state.settings.monthlyGoal = num(
      "#selMonthlyGoal",
      state.settings.monthlyGoal,
    );
    state.settings.mileageRate = num("#selMileage", state.settings.mileageRate);
    state.settings.mpg = num("#selMPG", state.settings.mpg);
    state.settings.gasPrice = num("#selGasPrice", state.settings.gasPrice);
    state.settings.defaultTravelFee = num(
      "#selTravelFee",
      state.settings.defaultTravelFee,
    );
    state.settings.travelRatePerMile = num(
      "#selTravelRate",
      state.settings.travelRatePerMile,
    );
    const notifyEl = g("#selNotify");
    if (notifyEl) state.settings.notificationsEnabled = notifyEl.checked;
    state.settings.googleMapsApiKey = str(
      "#selGMapsKey",
      state.settings.googleMapsApiKey,
    );
    state.settings.defaultTaxRate    = num("#selDefaultTax", state.settings.defaultTaxRate);
    state.settings.estimateValidDays = num("#selValidDays",  state.settings.estimateValidDays);
    state.settings.defaultPaymentTerms = str("#selPayTerms", state.settings.defaultPaymentTerms);
    state.settings.companyWebsite    = str("#selWebsite",    state.settings.companyWebsite);
    const themeEl = g("#selTheme");
    if (themeEl) {
      state.settings.theme = themeEl.value;
      applyTheme(state.settings.theme);
    }
  }

  function showSaved(btnId) {
    const btn = root.querySelector(btnId);
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = "✓ Saved!";
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = orig;
      btn.disabled = false;
    }, 2000);
  }

  function saveSettings() {
    const ok = ls(APP.lsKey).save(state.settings);
    if (ok === false)
      toast.error(
        "Save failed",
        "Storage may be full. Free space and try again.",
      );
    return ok !== false;
  }

  const installBtn = root.querySelector("#btnInstallApp");
  if (installBtn) {
    if (deferredPrompt) installBtn.style.display = "flex";
    installBtn.addEventListener("click", async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === "accepted") {
        deferredPrompt = null;
        installBtn.style.display = "none";
      }
    });
  }

  root.querySelector("#btnSave")?.addEventListener("click", () => {
    syncAllFromDOM();
    if (!saveSettings()) return;
    document.body.setAttribute("data-role", state.settings.role);
    if (state.settings.role === "field") {
      routeTo("field");
    } else {
      toast.success("Settings saved", "Preferences updated.");
      render();
    }
  });

  root.querySelector("#btnSaveBranding")?.addEventListener("click", () => {
    syncAllFromDOM();
    if (!saveSettings()) return;
    toast.success("Branding saved", "Company info updated.");
    render();
  });

  root.querySelector("#selLogo")?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) {
      toast.error("File too large", "Logo must be under 3 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        /* Compress logo to max 240×240 px, JPEG 0.82 — keeps it small for localStorage */
        const MAX = 240;
        let w = img.width,
          h = img.height;
        if (w > MAX || h > MAX) {
          if (w > h) {
            h = Math.round((h * MAX) / w);
            w = MAX;
          } else {
            w = Math.round((w * MAX) / h);
            h = MAX;
          }
        }
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        state.settings.logoDataUrl = c.toDataURL("image/png");
        if (!saveSettings()) return;
        toast.success("Logo saved", `${w}×${h} px`);
        render();
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });

  root.querySelector("#btnRemoveLogo")?.addEventListener("click", () => {
    state.settings.logoDataUrl = null;
    if (!saveSettings()) return;
    toast.info("Logo removed", "");
    render();
  });

  root.querySelector("#btnSaveCompliance")?.addEventListener("click", () => {
    syncAllFromDOM();
    if (!saveSettings()) return;
    toast.success("Compliance saved", "License & insurance info updated.");
    render();
  });

  root.querySelector("#btnSaveDefaults")?.addEventListener("click", () => {
    const wasEnabled = state.settings.notificationsEnabled;
    syncAllFromDOM();
    if (
      state.settings.notificationsEnabled &&
      !wasEnabled &&
      Notification.permission === "default"
    ) {
      Notification.requestPermission().then((p) => {
        if (p === "granted")
          toast.success(
            "Notifications enabled",
            "You'll receive deadline alerts.",
          );
        else
          toast.warn(
            "Permission denied",
            "Allow notifications in your browser settings.",
          );
      });
    }
    if (!saveSettings()) return;
    toast.success("Defaults saved", "Job defaults updated.");
    render();
  });

  root
    .querySelector("#btnTaxSummary")
    ?.addEventListener("click", openTaxSummaryModal);
  root.querySelector("#btnSExp")?.addEventListener("click", doExport);
  root.querySelector("#btnSCSV")?.addEventListener("click", exportCSV);
  root
    .querySelector("#btnQBExport")
    ?.addEventListener("click", exportQuickBooksCSV);
  root.querySelector("#btnAllPDF")?.addEventListener("click", exportAllPDF);
  root
    .querySelector("#btnSImp")
    ?.addEventListener("click", () =>
      root.querySelector("#fileImport").click(),
    );
  root.querySelector("#btnSaveIntegrations")?.addEventListener("click", () => {
    syncAllFromDOM();
    if (!saveSettings()) return;
    toast.success("API keys saved", "Integration settings updated.");
    showSaved("#btnSaveIntegrations");
  });

  root.querySelector("#btnSettingsPayroll")?.addEventListener("click", openPayrollModal);

  /* ══════════════════════════════════════════════
     DATA MIGRATION
     ══════════════════════════════════════════════ */

  const MIGRATION_INSTRUCTIONS = {
    jobcost: `<strong>JobCost Pro Backup:</strong> Upload a <code>.json</code> file previously exported via Settings → Reports → JSON Backup.`,
    csv_generic: `<strong>Generic CSV / Excel / Google Sheets:</strong> Your CSV must have headers in the first row. Supported column names: <code>Name / Job Name / Title</code> · <code>Client / Customer</code> · <code>Status</code> · <code>Value / Amount / Total</code> · <code>Address</code> · <code>Notes</code> · <code>Date</code> · <code>Phone</code> · <code>Email</code>`,
    jobber: `<strong>Jobber:</strong> Go to Reports → Export. Download the Clients or Jobs CSV and upload it here.`,
    housecall: `<strong>HouseCall Pro:</strong> Go to Reports → Export Data → choose Customers or Jobs CSV.`,
    servicetitan: `<strong>ServiceTitan:</strong> Go to Reporting → Export → Jobs or Customers. Download the CSV and upload here.`,
    quickbooks: `<strong>QuickBooks:</strong> Go to Customers → Export to Excel/CSV, or Invoices → Export. Upload the CSV here.`,
  };

  root.querySelector("#selMigSource")?.addEventListener("change", (e) => {
    const instr = root.querySelector("#migInstructions");
    const src = e.target.value;
    if (src && MIGRATION_INSTRUCTIONS[src]) {
      instr.innerHTML = MIGRATION_INSTRUCTIONS[src];
      instr.style.display = "block";
    } else {
      instr.style.display = "none";
    }
    root.querySelector("#migPreview").style.display = "none";
    root.querySelector("#migFileName").textContent = "No file selected";
    root.querySelector("#fileMigration").value = "";
  });

  function parseCSV(text) {
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l => l.trim());
    if (!lines.length) return { headers: [], rows: [] };
    const parseRow = (line) => {
      const cols = []; let cur = "", inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
        else if (ch === "," && !inQ) { cols.push(cur.trim()); cur = ""; }
        else { cur += ch; }
      }
      cols.push(cur.trim()); return cols;
    };
    const headers = parseRow(lines[0]).map(h => h.toLowerCase().trim());
    const rows = lines.slice(1).filter(l => l.trim()).map(l => {
      const vals = parseRow(l); const obj = {};
      headers.forEach((h, i) => { obj[h] = vals[i] || ""; }); return obj;
    });
    return { headers, rows };
  }

  function csvRowToJob(row) {
    const get = (...keys) => { for (const k of keys) { const v = row[k.toLowerCase()]; if (v !== undefined && v !== "") return v; } return ""; };
    const name = get("name","job name","title","job","work order","service","subject") || "Imported Job";
    const client = get("client","customer","customer name","contact","client name","billed to","account");
    const status = (() => {
      const raw = (get("status","job status","state") || "").toLowerCase();
      if (raw.includes("complete") || raw.includes("done"))  return "Completed";
      if (raw.includes("invoice")  || raw.includes("billed")) return "Invoiced";
      if (raw.includes("quote")    || raw.includes("quoted")) return "Quoted";
      if (raw.includes("draft")    || raw.includes("pending"))return "Draft";
      if (raw.includes("lead")     || raw.includes("prospect"))return "Lead";
      return "Active";
    })();
    const value = parseFloat(get("value","amount","total","revenue","price","job total","grand total","invoice total") || 0) || 0;
    const notes = get("notes","description","note","details","scope","comments","memo");
    const address = get("address","job address","service address","location","property address","site address");
    const dateRaw = get("date","created","created date","job date","start date","scheduled date","invoice date");
    const date = dateRaw ? (new Date(dateRaw).getTime() || Date.now()) : Date.now();
    const phone = get("phone","customer phone","mobile","cell","contact phone");
    const email = get("email","customer email","contact email");
    const payRaw = (get("payment status","paid","payment","payment state") || "").toLowerCase();
    return { id: uid(), name: name.slice(0,120), client: client.slice(0,100), clientName: client.slice(0,100), status, value, date, notes: notes.slice(0,1000), address: address.slice(0,200), phone: phone.slice(0,30), email: email.slice(0,100), paymentStatus: payRaw.includes("paid") ? "Paid" : "Unpaid", costs: [], tags: [], photos: [] };
  }

  function csvRowToClient(row) {
    const get = (...keys) => { for (const k of keys) { const v = row[k.toLowerCase()]; if (v !== undefined && v !== "") return v; } return ""; };
    const name = get("name","customer name","client name","contact","company","account name","full name") || "Imported Client";
    return { id: uid(), name: name.slice(0,100), email: get("email","customer email","e-mail").slice(0,100), phone: get("phone","mobile","cell","customer phone","telephone").slice(0,30), address: get("address","billing address","service address","location").slice(0,200), notes: get("notes","comments","description","memo").slice(0,500), date: Date.now() };
  }

  root.querySelector("#fileMigration")?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const source  = root.querySelector("#selMigSource")?.value || "";
    const migType = root.querySelector("#selMigType")?.value || "all";
    const preview = root.querySelector("#migPreview");
    const previewTitle = root.querySelector("#migPreviewTitle");
    const previewTable = root.querySelector("#migPreviewTable");
    root.querySelector("#migFileName").textContent = file.name;
    if (!source) { toast.warn("Select source", "Please choose the source app format first."); return; }

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        let importedJobs = [], importedClients = [], importedEstimates = [];
        let rawSettings = null;

        if (source === "jobcost" || file.name.endsWith(".json")) {
          const data = JSON.parse(ev.target.result);
          if (!data.jobs && !data.clients && !data.estimates) { toast.error("Invalid file", "This doesn't look like a JobCost Pro backup."); return; }
          importedJobs = data.jobs || []; importedClients = data.clients || []; importedEstimates = data.estimates || []; rawSettings = data.settings || null;
        } else if (file.name.endsWith(".csv")) {
          const { rows } = parseCSV(ev.target.result);
          if (!rows.length) { toast.error("Empty file", "No data rows found in the CSV."); return; }
          if (migType === "clients") {
            importedClients = rows.map(csvRowToClient);
          } else {
            const keys = Object.keys(rows[0]).map(k => k.toLowerCase());
            const hasJobFields = keys.some(k => ["job name","job","work order","service","title","status"].includes(k));
            const hasClientFields = keys.some(k => ["customer name","customer","contact","company","account"].includes(k));
            if (!hasJobFields && hasClientFields) {
              importedClients = rows.map(csvRowToClient);
            } else {
              importedJobs = rows.map(r => csvRowToJob(r));
              if (migType === "all" && hasClientFields) {
                const clientMap = {};
                importedJobs.forEach(j => { if (j.client && !clientMap[j.client]) { clientMap[j.client] = { id: uid(), name: j.client, email: j.email || "", phone: j.phone || "", address: j.address || "", notes: "", date: Date.now() }; } });
                importedClients = Object.values(clientMap);
              }
            }
          }
        } else { toast.error("Unsupported format", "Please upload a .json or .csv file."); return; }

        const existingJobNames = new Set(state.jobs.map(j => j.name.toLowerCase().trim()));
        const existingClientNames = new Set(state.clients.map(c => c.name.toLowerCase().trim()));
        const newJobs    = importedJobs.filter(j    => !existingJobNames.has(j.name.toLowerCase().trim()));
        const dupJobs    = importedJobs.filter(j    =>  existingJobNames.has(j.name.toLowerCase().trim()));
        const newClients = importedClients.filter(c => !existingClientNames.has(c.name.toLowerCase().trim()));
        const dupClients = importedClients.filter(c =>  existingClientNames.has(c.name.toLowerCase().trim()));
        preview._data = { newJobs, dupJobs, newClients, dupClients, importedEstimates, rawSettings };

        const totalNew = newJobs.length + newClients.length + importedEstimates.length;
        const totalDup = dupJobs.length + dupClients.length;
        previewTitle.innerHTML = `<span style="color:var(--ok);">✓ ${totalNew} records ready to import</span>${totalDup > 0 ? `<span style="color:var(--warn);margin-left:12px;">⚠ ${totalDup} duplicates will be skipped</span>` : ""}`;

        let tableHTML = `<table class="table" style="font-size:12px;"><thead><tr><th>Type</th><th>Name</th><th>Status</th><th>Value</th></tr></thead><tbody>`;
        [...newJobs.slice(0,8)].forEach(j => { tableHTML += `<tr><td><span class="badge" style="font-size:10px;">Job</span></td><td>${esc(j.name)}</td><td><span class="badge job-${(j.status||"active").toLowerCase()}">${j.status}</span></td><td>${j.value ? fmt(j.value) : "—"}</td></tr>`; });
        [...newClients.slice(0,5)].forEach(c => { tableHTML += `<tr><td><span class="badge" style="font-size:10px;background:rgba(75,227,163,.15);color:var(--ok);">Client</span></td><td>${esc(c.name)}</td><td class="muted">—</td><td class="muted">—</td></tr>`; });
        const shown = Math.min(newJobs.length,8) + Math.min(newClients.length,5);
        if (totalNew - shown > 0) tableHTML += `<tr><td colspan="4" class="muted" style="text-align:center;font-style:italic;">… and ${totalNew - shown} more records</td></tr>`;
        tableHTML += `</tbody></table>`;
        previewTable.innerHTML = tableHTML;
        preview.style.display = "block";

        if (totalNew === 0) {
          previewTitle.innerHTML = `<span style="color:var(--warn);">⚠ All ${totalDup} records already exist — nothing new to import.</span>`;
          root.querySelector("#btnMigConfirm").style.display = "none";
        } else {
          root.querySelector("#btnMigConfirm").style.display = "";
        }
      } catch (err) {
        console.error("[Migration]", err);
        toast.error("Parse error", "Could not read the file. Make sure it's a valid CSV or JSON.");
      }
    };
    reader.readAsText(file, "UTF-8");
  });

  root.querySelector("#btnMigConfirm")?.addEventListener("click", async () => {
    if (demoBlock()) return;
    const preview = root.querySelector("#migPreview");
    const data = preview._data;
    if (!data) return;
    const { newJobs, newClients, importedEstimates, rawSettings } = data;
    const btn = root.querySelector("#btnMigConfirm");
    btn.disabled = true; btn.textContent = "Importing…";
    try {
      await Promise.all([
        ...newJobs.map(j    => idb.put(APP.stores.jobs,      j)),
        ...newClients.map(c => idb.put(APP.stores.clients,   c)),
        ...importedEstimates.map(e => idb.put(APP.stores.estimates, e)),
      ]);
      const [jobs, clients, estimates] = await Promise.all([idb.getAll(APP.stores.jobs), idb.getAll(APP.stores.clients), idb.getAll(APP.stores.estimates)]);
      state.jobs = jobs; state.clients = clients; state.estimates = estimates;
      if (rawSettings && typeof rawSettings === "object") {
        const { logoDataUrl, ...safeSettings } = rawSettings;
        state.settings = { ...state.settings, ...safeSettings };
        ls(APP.lsKey).save(state.settings);
      }
      toast.success("Migration complete!", `${newJobs.length} jobs · ${newClients.length} clients · ${importedEstimates.length} estimates imported.`);
      preview.style.display = "none";
      root.querySelector("#fileMigration").value = "";
      root.querySelector("#migFileName").textContent = "No file selected";
      render();
    } catch (err) {
      console.error("[Migration] Import failed:", err);
      toast.error("Import failed", "Could not save some records. Check your connection.");
      btn.disabled = false; btn.textContent = "Import Now";
    }
  });

  root.querySelector("#btnMigCancel")?.addEventListener("click", () => {
    root.querySelector("#migPreview").style.display = "none";
    root.querySelector("#fileMigration").value = "";
    root.querySelector("#migFileName").textContent = "No file selected";
  });

  /* ── Price Book ── */
  root
    .querySelector("#btnAddPBItem")
    ?.addEventListener("click", () => openPricebookModal(null));
  root.querySelectorAll("[data-pbedit]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const item = state.pricebook.find((x) => x.id === btn.dataset.pbedit);
      if (item) openPricebookModal(item);
    }),
  );
  root.querySelectorAll("[data-pbdel]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const item = state.pricebook.find((x) => x.id === btn.dataset.pbdel);
      if (!item) return;
      if (demoBlock()) return;
      confirm("Delete Service", item.name, "Delete", () => {
        deletePricebookItem(item.id).then(() => {
          toast.warn("Service deleted", item.name);
          render();
        });
      });
    }),
  );

  /* ── Materials ── */
  root
    .querySelector("#btnAddMaterial")
    ?.addEventListener("click", () => openMaterialModal(null));
  root
    .querySelector("#btnOpenMatCalc")
    ?.addEventListener("click", () => openMaterialsCalcModal(null));
  root.querySelectorAll("[data-mtedit]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const item = state.materials.find((x) => x.id === btn.dataset.mtedit);
      if (item) openMaterialModal(item);
    }),
  );
  root.querySelectorAll("[data-mtdel]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const item = state.materials.find((x) => x.id === btn.dataset.mtdel);
      if (!item) return;
      if (demoBlock()) return;
      confirm("Delete Material", item.name, "Delete", () => {
        deleteMaterial(item.id).then(() => {
          toast.warn("Material deleted", item.name);
          render();
        });
      });
    }),
  );

  root
    .querySelector("#btnAddMileage")
    ?.addEventListener("click", () => openMileageModal(null));

  root.querySelectorAll("[data-dml]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ml = state.mileageLogs.find((x) => x.id === btn.dataset.dml);
      if (!ml) return;
      if (demoBlock()) return;
      confirm(
        "Delete Entry",
        `${fmtDate(ml.date)} — ${ml.description || "Mileage entry"}`,
        "Delete",
        () => {
          idb.del(APP.stores.mileageLogs, ml.id).then(() => {
            state.mileageLogs = state.mileageLogs.filter((x) => x.id !== ml.id);
            toast.warn("Deleted", "Mileage entry removed.");
            render();
          });
        },
      );
    });
  });

  root.querySelector("#fileImport")?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!Array.isArray(data.jobs)) {
          toast.error("Import failed", "Invalid file format.");
          return;
        }
        Promise.all([
          ...data.jobs.map((j) => idb.put(APP.stores.jobs, j)),
          ...(data.timeLogs || []).map((l) => idb.put(APP.stores.timeLogs, l)),
          ...(data.templates || []).map((t) =>
            idb.put(APP.stores.templates, t),
          ),
          ...(data.clients || []).map((c) => idb.put(APP.stores.clients, c)),
          ...(data.crew || []).map((c) => idb.put(APP.stores.crew, c)),
          ...(data.inventory || []).map((i) =>
            idb.put(APP.stores.inventory, i),
          ),
          ...(data.estimates || []).map((e) =>
            idb.put(APP.stores.estimates, e),
          ),
          ...(data.mileageLogs || []).map((m) =>
            idb.put(APP.stores.mileageLogs, m),
          ),
          ...(data.equipment || []).map((eq) =>
            idb.put(APP.stores.equipment, eq),
          ),
        ])
          .then(() =>
            Promise.all([
              idb.getAll(APP.stores.jobs),
              idb.getAll(APP.stores.timeLogs),
              idb.getAll(APP.stores.templates),
              idb.getAll(APP.stores.clients),
              idb.getAll(APP.stores.crew),
              idb.getAll(APP.stores.inventory),
              idb.getAll(APP.stores.estimates),
              idb.getAll(APP.stores.mileageLogs),
              idb.getAll(APP.stores.equipment),
            ]),
          )
          .then(
            ([
              jobs,
              tl,
              tpls,
              clients,
              crew,
              inventory,
              estimates,
              mileageLogs,
              equipment,
            ]) => {
              state.jobs = jobs;
              state.timeLogs = tl;
              state.templates = tpls;
              state.clients = clients;
              state.crew = crew;
              state.inventory = inventory;
              state.estimates = estimates;
              state.mileageLogs = mileageLogs;
              state.equipment = equipment;
              if (data.settings && typeof data.settings === "object") {
                state.settings = { ...state.settings, ...data.settings };
                ls(APP.lsKey).save(state.settings);
                applyTheme(state.settings.theme);
              }
              toast.success(
                "Import complete",
                `${data.jobs.length} jobs · ${(data.clients || []).length} clients imported.`,
              );
              render();
            },
          )
          .catch(() => toast.error("Error", "Failed to save imported data."));
      } catch {
        toast.error("Import failed", "Could not read the JSON file.");
      }
    };
    reader.readAsText(file);
  });

  root.querySelector("#btnClear")?.addEventListener("click", () => {
    if (demoBlock()) return;
    confirm(
      "Clear All Data",
      "This will permanently delete ALL jobs, time logs, templates, and clients.",
      "Clear All",
      () => {
        Promise.all(
          Object.values(APP.stores).map((s) =>
            idb
              .getAll(s)
              .then((items) =>
                Promise.all(items.map((item) => idb.del(s, item.id))),
              ),
          ),
        )
          .then(() => {
            state.jobs = [];
            state.timeLogs = [];
            state.templates = [];
            state.clients = [];
            state.crew = [];
            state.inventory = [];
            state.estimates = [];
            state.mileageLogs = [];
            toast.warn("Data cleared", "All data has been deleted.");
            render();
          })
          .catch(() => toast.error("Error", "Failed to clear data."));
      },
    );
  });
}

/* ─── Estimates ──────────────────────────────── */
/* ─── Estimate Share (WhatsApp / Web Share) ──────────────── */
function shareEstimate(e) {
  const s = state.settings;
  const company = s.company || "Your Company";
  const phone = s.companyPhone ? `\n📞 ${s.companyPhone}` : "";
  const subtotal =
    e.items && e.items.length
      ? e.items.reduce((sum, i) => sum + (i.total || 0), 0)
      : e.value || 0;
  const travel = e.travelFee || 0;
  const taxAmt = (subtotal + travel) * ((e.taxRate || 0) / 100);
  const total = subtotal + travel + taxAmt;

  const itemLines =
    e.items && e.items.length
      ? e.items.map(
          (i) =>
            `  • ${i.name}${i.description ? ` (${i.description})` : ""}: ${fmt(i.total)}`,
        )
      : [];

  const lines = [
    `🏠 *${company} — Estimate ${e.name || ""}*`,
    ``,
    `👤 Client: ${e.client || "—"}`,
    e.city || e.state
      ? `📍 ${[e.city, e.state, e.zip].filter(Boolean).join(", ")}`
      : null,
    ``,
    itemLines.length
      ? `🔧 *Services:*`
      : `🔧 Service: ${e.insulationType || "Insulation"} — ${e.areaType || ""}${e.sqft ? ` (${e.sqft} sq ft)` : ""}`,
    ...itemLines,
    ``,
    `💰 Subtotal: ${fmt(subtotal)}`,
    travel > 0
      ? `🚗 Travel Fee: ${fmt(travel)}${e.travelMiles ? ` (${e.travelMiles} mi)` : ""}`
      : null,
    taxAmt > 0 ? `🧾 Tax (${e.taxRate}%): ${fmt(taxAmt)}` : null,
    `✅ *Total: ${fmt(total)}*`,
    ``,
    e.notes ? `📝 Notes: ${e.notes}` : null,
    ``,
    `_This estimate is valid for 30 days._`,
    `_To accept, reply to this message or call us._`,
    ``,
    `${company}${phone}`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  if (navigator.share) {
    navigator
      .share({
        title: `Estimate from ${company}`,
        text: lines,
      })
      .catch((err) => {
        if (err.name !== "AbortError") openShareFallback(lines);
      });
  } else {
    openShareFallback(lines);
  }
}

/* ─── Follow-up WhatsApp Draft ───────────────── */
function sendFollowUpWA(est) {
  const company = state.settings.company || "Your Company";
  const phone = state.settings.companyPhone
    ? `\n📞 ${state.settings.companyPhone}`
    : "";
  const clientName = (est.client || "").split(" ")[0] || "there";

  const subtotal =
    est.items && est.items.length
      ? est.items.reduce((s, i) => s + (i.total || 0), 0)
      : est.value || 0;
  const travel = est.travelFee || 0;
  const taxAmt = (subtotal + travel) * ((est.taxRate || 0) / 100);
  const total = subtotal + travel + taxAmt;

  const message = [
    `Hi ${clientName}! 👋`,
    ``,
    `This is ${company} following up on the estimate we sent for **${est.title || est.name || "your project"}**.`,
    ``,
    `Estimate Total: ${fmt(total)}`,
    ``,
    `Do you have any questions? We're happy to walk you through the details or adjust anything to better fit your needs.`,
    ``,
    `Ready to schedule? Just reply to this message and we'll get you on the calendar! 🗓️`,
    ``,
    `— ${company}${phone}`,
  ].join("\n");

  const phoneNum = (est.phone || "").replace(/\D/g, "");
  const waUrl = phoneNum
    ? `https://wa.me/${phoneNum}?text=${encodeURIComponent(message)}`
    : `https://wa.me/?text=${encodeURIComponent(message)}`;

  if (navigator.share && !phoneNum) {
    navigator
      .share({ title: `Follow-up: ${est.name}`, text: message })
      .catch((err) => {
        if (err.name !== "AbortError") window.open(waUrl, "_blank");
      });
  } else {
    window.open(waUrl, "_blank", "noopener,noreferrer");
  }
}

function openShareFallback(text) {
  const waUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
  const m = modal.open(`
      <div class="modalHd">
        <div><h2>Share Estimate</h2><p>Copy the message or open WhatsApp Web.</p></div>
        <button type="button" class="closeX" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modalBd">
        <textarea id="shareText" class="input" rows="14" readonly
          style="resize:none;font-size:12px;font-family:monospace;white-space:pre;"
        >${esc(text)}</textarea>
      </div>
      <div class="modalFt" style="gap:8px;">
        <button type="button" class="btn" id="shareCopy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px" aria-hidden="true"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg>Copy Text</button>
        <a href="${esc(waUrl)}" target="_blank" rel="noopener" class="btn primary" id="shareWA">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
            <path d="M12 0C5.373 0 0 5.373 0 12c0 2.127.558 4.126 1.532 5.861L0 24l6.305-1.654A11.955 11.955 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.796 9.796 0 01-5.032-1.388l-.361-.214-3.741.981.998-3.648-.235-.374A9.796 9.796 0 012.182 12C2.182 6.57 6.57 2.182 12 2.182S21.818 6.57 21.818 12 17.43 21.818 12 21.818z"/>
          </svg>
          Open WhatsApp
        </a>
        <button type="button" class="btn" id="shareClose">Close</button>
      </div>`);

  m.querySelector("#shareClose").addEventListener("click", modal.close);
  m.querySelector("#shareCopy").addEventListener("click", () => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        toast.success("Copied!", "Message copied to clipboard.");
      })
      .catch(() => {
        m.querySelector("#shareText").select();
        document.execCommand("copy");
        toast.success("Copied!", "Message copied to clipboard.");
      });
  });
}

/* Compute the grand total of an estimate — supports both legacy (root value) and new (items array) */
function estGrandTotal(e) {
  if (e.items && e.items.length) {
    const sub = e.items.reduce((s, i) => s + (i.total || 0), 0);
    const travel = e.travelFee || 0;
    return (sub + travel) * (1 + (e.taxRate || 0) / 100);
  }
  return e.value || 0;
}

function renderEstimates(root) {
  const STATUSES = ["All", "Draft", "Sent", "Approved", "Declined"];
  const filt = state._estFilter || "All";
  let list = [...state.estimates];
  if (filt !== "All") list = list.filter((e) => e.status === filt);
  list.sort((a, b) => b.date - a.date);

  root.innerHTML = `
      <div class="pageHeader">
        <h2 class="pageTitle">Estimates &amp; Quotes <span class="muted" style="font-size:14px;font-weight:400;">(${list.length})</span></h2>
        <button class="btn primary admin-only" id="btnNE">+ New Estimate</button>
      </div>
      <div class="filterBar">
        ${STATUSES.map((s) => `<button type="button" class="filterPill${filt === s ? " active" : ""}" data-ef="${s}">${s}</button>`).join("")}
      </div>
      ${
        list.length === 0
          ? `<div class="empty">No estimates yet. Create one to start your sales pipeline.</div>`
          : `<div class="tableWrap"><table class="table">
            <thead><tr>
              <th>Estimate #</th><th>Client</th><th>Insulation Type</th><th>Area</th>
              <th style="text-align:right;">Est. Value</th>
              <th>Created</th><th>Status</th><th>Actions</th>
            </tr></thead>
            <tbody>
              ${list
                .map(
                  (e) => `
              <tr>
                <td><strong>${esc(e.name)}</strong></td>
                <td>${esc(e.client || "—")}<br><span class="small muted">${esc(e.city || "")}${e.state ? `, ${esc(e.state)}` : ""}</span></td>
                <td>${esc(e.insulationType || "—")}</td>
                <td>${esc(e.areaType || "—")}${e.sqft ? `<br><span class="small muted">${e.sqft} sq ft</span>` : ""}</td>
                <td style="text-align:right;">${fmt(estGrandTotal(e))}${e.items?.length ? `<br><span class="small muted">${e.items.length} item${e.items.length > 1 ? "s" : ""}</span>` : ""}</td>
                <td>${fmtDate(e.date)}</td>
                <td><span class="badge est-${(e.status || "draft").toLowerCase()}">${e.status || "Draft"}</span></td>
                <td>
                  <div style="display:flex;gap:4px;flex-wrap:wrap;">
                    <button class="btn admin-only" data-ee="${e.id}" style="padding:5px 9px;font-size:12px;">Edit</button>
                    <button class="btn" data-epdf="${e.id}" style="padding:5px 9px;font-size:12px;">PDF</button>
                    <button class="btn primary admin-only" data-econvert="${e.id}" style="padding:5px 9px;font-size:12px;">→ Job</button>
                    <button class="btn" data-eshare="${e.id}" style="padding:5px 9px;font-size:12px;" title="Share via WhatsApp">📤 Share</button>
                    <button class="btn" data-eemail="${e.id}" style="padding:5px 9px;font-size:12px;" title="Send via Email"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px" aria-hidden="true"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22 6 12 13 2 6"/></svg>Email</button>
                    <button class="btn danger admin-only" data-edel="${e.id}" style="padding:5px 9px;font-size:12px;">Delete</button>
                  </div>
                </td>
              </tr>`,
                )
                .join("")}
            </tbody>
          </table></div>`
      }`;

  root
    .querySelector("#btnNE")
    ?.addEventListener("click", () => openEstimateModal(null));
  root.querySelectorAll(".filterPill[data-ef]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state._estFilter = btn.dataset.ef;
      render();
    }),
  );
  root.querySelectorAll("[data-ee]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const e = state.estimates.find((x) => x.id === btn.dataset.ee);
      if (e) openEstimateModal(e);
    }),
  );
  root.querySelectorAll("[data-epdf]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const e = state.estimates.find((x) => x.id === btn.dataset.epdf);
      if (e) exportEstimatePDF(e);
    }),
  );
  root.querySelectorAll("[data-econvert]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const e = state.estimates.find((x) => x.id === btn.dataset.econvert);
      if (!e) return;
      const jobCosts = (e.items || []).map((i) => ({
        id: uid(),
        description: i.name + (i.description ? ` — ${i.description}` : ""),
        qty: i.qty,
        unitCost: i.unitPrice,
        category: "Labor",
      }));
      const job = {
        id: uid(),
        name: e.client
          ? `${e.client} – ${e.insulationType || "Insulation"}`
          : e.name || "New Job",
        client: e.client || "",
        status: "Draft",
        value: estGrandTotal(e),
        insulationType: e.insulationType || "",
        areaType: e.areaType || "",
        sqft: e.sqft || null,
        rValueTarget: e.rValueTarget || null,
        city: e.city || "",
        state: e.state || "",
        zip: e.zip || "",
        notes: e.notes || "",
        taxRate: e.taxRate || 0,
        date: Date.now(),
        costs: jobCosts,
        photos: [],
        tags: [],
        paymentStatus: "Unpaid",
        statusHistory: [{ status: "Draft", date: Date.now() }],
        checklist: {},
        mileage: 0,
      };
      saveJob(job)
        .then(() => {
          const updated = { ...e, status: "Approved" };
          saveEstimate(updated)
            .then(() => {
              toast.success("Job created", job.name);
              routeTo("jobs");
            })
            .catch(() =>
              toast.error("Save failed", "Could not update estimate status."),
            );
        })
        .catch(() =>
          toast.error(
            "Save failed",
            "Could not create job. Check your connection.",
          ),
        );
    }),
  );
  root.querySelectorAll("[data-edel]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const e = state.estimates.find((x) => x.id === btn.dataset.edel);
      if (!e) return;
      if (demoBlock()) return;
      confirm("Delete Estimate", e.name, "Delete", () => {
        idb.del(APP.stores.estimates, e.id).then(() => {
          state.estimates = state.estimates.filter((x) => x.id !== e.id);
          toast.warn("Estimate deleted", e.name);
          render();
        });
      });
    }),
  );
  root.querySelectorAll("[data-eshare]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const e = state.estimates.find((x) => x.id === btn.dataset.eshare);
      if (e) shareEstimate(e);
    }),
  );
  root.querySelectorAll("[data-eemail]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const e = state.estimates.find((x) => x.id === btn.dataset.eemail);
      if (e) emailEstimate(e);
    }),
  );
}

function openAtticCalcModal(estimateModalEl, onApply) {
  const currentSqft = estimateModalEl.querySelector("#eSqft")?.value || "";
  const markup = state.settings.defaultMarkup || 0;
  const defaultBagCost = ATTIC_DEFAULT_BAG_COST;

  const calcModal = modal.open(`
    <div class="modalHd">
      <div><h2><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:7px" aria-hidden="true"><path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z"/><polyline points="9 21 9 12 15 12 15 21"/></svg>Attic Smart Calculator</h2>
        <p>Auto-fill estimate from square footage &amp; material coverage.</p></div>
      <button type="button" class="closeX" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="modalBd">
      <div class="fieldGrid">
        <div class="field"><label for="aeSqft">Square Footage *</label>
          <input id="aeSqft" class="input" type="number" min="1" step="1" placeholder="e.g. 1000" value="${currentSqft}"/></div>
        <div class="field"><label for="aeCoverage">Coverage per Bag (sq ft / bag)</label>
          <input id="aeCoverage" class="input" type="number" min="0.1" step="0.1" placeholder="e.g. 58.5"/></div>
        <div class="field"><label for="acBagCost">Bag Cost ($ / bag)</label>
          <input id="acBagCost" class="input" type="number" min="0" step="0.01" value="${defaultBagCost}"/></div>
        <div class="field"><label for="aeLaborRate">Labor Rate ($ per Sq Ft)</label>
          <input id="aeLaborRate" class="input" type="number" min="0" step="0.01" placeholder="e.g. 1.00"/></div>
      </div>
      <div id="acPreview" style="margin-top:14px;padding:12px;background:var(--panel2);border-radius:8px;font-size:13px;display:none;"></div>
    </div>
    <div class="modalFt">
      <button type="button" class="btn closeX">Cancel</button>
      <button type="button" class="btn" id="acPreviewBtn">Preview</button>
      <button type="button" class="btn primary" id="acApply" disabled>Apply to Estimate</button>
    </div>`);

  let calcResult = null;

  function runCalc() {
    const sqft = parseFloat(calcModal.querySelector("#aeSqft").value);
    const coverage = parseFloat(calcModal.querySelector("#aeCoverage").value);
    const bagCost =
      parseFloat(calcModal.querySelector("#acBagCost").value) || defaultBagCost;
    const laborRatePerSqft =
      parseFloat(calcModal.querySelector("#aeLaborRate").value) || 0;
    if (!sqft || sqft <= 0 || !coverage || coverage <= 0) return null;

    const bags = Math.ceil(sqft / coverage);
    const matCost = bags * bagCost;
    const totalLabor = sqft * laborRatePerSqft;
    const subtotal = matCost + totalLabor;
    const total = +(subtotal * (1 + markup / 100)).toFixed(2);
    return {
      sqft,
      coverage,
      bags,
      bagCost,
      matCost,
      laborRatePerSqft,
      totalLabor,
      subtotal,
      total,
      markup,
    };
  }

  calcModal.querySelector("#acPreviewBtn").addEventListener("click", () => {
    const r = runCalc();
    const preview = calcModal.querySelector("#acPreview");
    const applyBtn = calcModal.querySelector("#acApply");
    if (!r) {
      preview.style.display = "block";
      preview.innerHTML = `<span style="color:var(--danger);">Enter valid Square Footage and Coverage per Bag.</span>`;
      applyBtn.disabled = true;
      return;
    }
    calcResult = r;
    applyBtn.disabled = false;
    preview.style.display = "block";
    preview.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;">
        <span class="muted">Bags needed</span><strong>${r.bags} bags</strong>
        <span class="muted">Material cost</span><strong>${fmt(r.matCost)}</strong>
        <span class="muted">Labor cost</span><strong>${fmt(r.totalLabor)}</strong>
        <span class="muted">Subtotal</span><strong>${fmt(r.subtotal)}</strong>
        ${r.markup > 0 ? `<span class="muted">Markup (${r.markup}%)</span><strong>${fmt(r.total - r.subtotal)}</strong>` : ""}
        <span class="muted" style="font-size:14px;"><strong>Total</strong></span><strong style="font-size:15px;color:var(--primary);">${fmt(r.total)}</strong>
      </div>`;
  });

  calcModal.querySelector("#acApply").addEventListener("click", () => {
    if (!calcResult) return;
    const r = calcResult;
    /* Populate sqft / type fields on parent modal if present */
    const sqftEl = estimateModalEl?.querySelector("#eSqft");
    const itEl = estimateModalEl?.querySelector("#eIT");
    const atEl = estimateModalEl?.querySelector("#eAT");
    if (sqftEl && !sqftEl.value) sqftEl.value = r.sqft;
    if (itEl && !itEl.value) itEl.value = "Blown-in Fiberglass";
    if (atEl && !atEl.value) atEl.value = "Attic";
    /* Build line items and push via callback — markup distributed into unit prices */
    const mf = 1 + r.markup / 100; /* markup factor, 1.0 when no markup */
    const matUnitPrice = +(r.bagCost * mf).toFixed(2);
    const matTotal = +(r.bags * matUnitPrice).toFixed(2);
    const matItem = {
      id: uid(),
      name: "Attic Material",
      description: `${r.bags} bags × ${r.coverage} sqft/bag @ ${fmt(r.bagCost)}/bag`,
      qty: r.bags,
      unitPrice: matUnitPrice,
      total: matTotal,
    };
    const laborUnitPrice =
      r.totalLabor > 0 ? +(r.laborRatePerSqft * mf).toFixed(4) : 0;
    const laborTotal =
      r.totalLabor > 0 ? +(r.sqft * laborUnitPrice).toFixed(2) : 0;
    const laborItem =
      r.totalLabor > 0
        ? {
            id: uid(),
            name: "Attic Labor",
            description: `${r.sqft} sqft × $${r.laborRatePerSqft.toFixed(2)}/sqft`,
            qty: r.sqft,
            unitPrice: laborUnitPrice,
            total: laborTotal,
          }
        : null;
    modal.close();
    if (typeof onApply === "function") {
      onApply(matItem, laborItem);
    }
    toast.success(
      "Smart Calc applied",
      `${r.bags} bags · Labor ${fmt(r.totalLabor)} · added to estimate`,
    );
  });
}

function openEstimateModal(est) {
  const isEdit = !!est;
  const initTaxRate    = isEdit ? (est.taxRate    || 0) : (state.settings.defaultTaxRate    || 0);
  const initValidDays  = isEdit ? null             : (state.settings.estimateValidDays || 30);
  const initValidUntil = isEdit ? (est.validUntil || null) : Date.now() + initValidDays * 86400000;
  const EST_STATUS = ["Draft", "Sent", "Approved", "Declined"];
  const INST = [
    "Blown-in Fiberglass",
    "Blown-in Cellulose",
    "Spray Foam Open Cell",
    "Spray Foam Closed Cell",
    "Batt Fiberglass",
    "Batt Mineral Wool",
    "Radiant Barrier",
    "Other",
  ];
  const AREAS = [
    "Attic",
    "Walls",
    "Crawl Space",
    "Garage",
    "New Construction",
    "Other",
  ];

  /* ── Working line-items array (mutable in closure) ── */
  let lineItems =
    est?.items && est.items.length ? est.items.map((i) => ({ ...i })) : [];

  /* ── Signature captured in this editing session ── */
  let pendingSignature = isEdit ? est.signature || null : null;

  function computeSubtotal() {
    return lineItems.reduce((s, i) => s + (i.total || 0), 0);
  }

  function getTravelFeeValue() {
    const toggle = m.querySelector("#eTravelToggle");
    if (!toggle?.checked) return 0;
    const miles = parseFloat(m.querySelector("#eTravelMiles")?.value) || 0;
    const ratePerMile = state.settings.travelRatePerMile || 0;
    if (miles > 0 && ratePerMile > 0) return +(miles * ratePerMile).toFixed(2);
    return parseFloat(m.querySelector("#eTravelFee")?.value) || 0;
  }

  function renderLineItems() {
    const taxRate = safeNum(parseFloat(m.querySelector("#eTax")?.value));
    const subtotal = Math.round(computeSubtotal() * 100) / 100;
    const travel = Math.round(getTravelFeeValue() * 100) / 100;
    const taxBase = subtotal + travel;
    const taxAmt = Math.round(taxBase * (taxRate / 100) * 100) / 100;
    const grand = Math.round((taxBase + taxAmt) * 100) / 100;

    const tbody = m.querySelector("#eLineItemsBody");
    if (tbody) {
      tbody.innerHTML =
        lineItems.length === 0
          ? `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:12px 0;">No items yet. Add one above.</td></tr>`
          : lineItems
              .map(
                (item, idx) => `
            <tr>
              <td><strong>${esc(item.name)}</strong>${item.description ? `<br><span class="small muted">${esc(item.description)}</span>` : ""}</td>
              <td style="text-align:right;">${item.qty}</td>
              <td style="text-align:right;">${fmt(item.unitPrice)}</td>
              <td style="text-align:right;"><strong>${fmt(item.total)}</strong></td>
              <td style="text-align:center;">
                <button type="button" class="btn danger" data-eli="${idx}" style="padding:3px 8px;font-size:12px;" aria-label="Remove item">🗑</button>
              </td>
            </tr>`,
              )
              .join("");

      tbody.querySelectorAll("[data-eli]").forEach((btn) =>
        btn.addEventListener("click", () => {
          lineItems.splice(parseInt(btn.dataset.eli), 1);
          renderLineItems();
        }),
      );
    }
    const subEl = m.querySelector("#eSubtotal");
    const grandEl = m.querySelector("#eGrandTotal");
    const travelRow = m.querySelector("#eTravelFeeRow");
    const travelAmtEl = m.querySelector("#eTravelFeeAmt");
    const taxRow = m.querySelector("#eTaxRow");
    const taxAmtEl = m.querySelector("#eTaxAmt");
    const taxPctEl = m.querySelector("#eTaxPct");
    if (subEl) subEl.textContent = fmt(subtotal);
    if (grandEl) grandEl.textContent = fmt(grand);
    if (travelRow) travelRow.style.display = travel > 0 ? "" : "none";
    if (travelAmtEl) travelAmtEl.textContent = fmt(travel);
    if (taxRow) taxRow.style.display = taxRate > 0 ? "" : "none";
    if (taxAmtEl) taxAmtEl.textContent = fmt(taxAmt);
    if (taxPctEl) taxPctEl.textContent = taxRate;
  }

  const m = modal.open(`
    <div class="modalHd">
      <div><h2>${isEdit ? "Edit Estimate" : "New Estimate"}</h2>
        <p>${isEdit ? esc(est.name) : "Create a quote to send to a client."}</p></div>
      <button type="button" class="closeX" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="modalBd">

      <div class="sectionLabel" style="margin-bottom:10px;">Client &amp; Job Info</div>
      <div class="fieldGrid">
        <div class="field"><label for="eCl">Client Name *</label>
          <input id="eCl" class="input" type="text" maxlength="120" placeholder="e.g. John Smith" value="${isEdit ? esc(est.client || "") : ""}"/></div>
        <div class="field"><label for="ePh">Phone</label>
          <input id="ePh" class="input" type="tel" maxlength="30" placeholder="(555) 123-4567" value="${isEdit ? esc(est.phone || "") : ""}"/></div>
        <div class="field"><label for="eEm">Email</label>
          <input id="eEm" class="input" type="email" maxlength="120" placeholder="client@email.com" value="${isEdit ? esc(est.email || "") : ""}"/></div>
        <div class="field"><label for="eAddr">Address</label>
          <input id="eAddr" class="input" type="text" maxlength="200" placeholder="Street address" value="${isEdit ? esc(est.address || "") : ""}"/></div>
        <div class="field"><label for="eZip">ZIP</label>
          <input id="eZip" class="input" type="text" maxlength="10" placeholder="e.g. 33101" value="${isEdit ? esc(est.zip || "") : ""}"/></div>
        <div class="field"><label for="eCity">City</label>
          <input id="eCity" class="input" type="text" maxlength="80" placeholder="Miami" value="${isEdit ? esc(est.city || "") : ""}"/></div>
        <div class="field"><label for="eSt">State</label>
          <input id="eSt" class="input" type="text" maxlength="10" placeholder="FL" value="${isEdit ? esc(est.state || "FL") : "FL"}"/></div>
        <div class="field"><label for="eIT">Insulation Type</label>
          <select id="eIT"><option value="">— Select —</option>
            ${INST.map((s) => `<option value="${s}" ${isEdit && est.insulationType === s ? "selected" : ""}>${s}</option>`).join("")}
          </select></div>
        <div class="field"><label for="eAT">Area Type</label>
          <select id="eAT"><option value="">— Select —</option>
            ${AREAS.map((s) => `<option value="${s}" ${isEdit && est.areaType === s ? "selected" : ""}>${s}</option>`).join("")}
          </select></div>
        <div class="field"><label for="eSqft">Square Footage</label>
          <input id="eSqft" class="input" type="number" min="0" step="1" placeholder="e.g. 1200" value="${isEdit ? est.sqft || "" : ""}"/></div>
        <div class="field"><label for="eTax">Tax Rate (%)</label>
          <input id="eTax" class="input" type="number" min="0" step="0.01" placeholder="0" value="${initTaxRate}"/></div>
        <div class="field"><label for="eStatus">Status</label>
          <select id="eStatus">
            ${EST_STATUS.map((s) => `<option value="${s}" ${isEdit && est.status === s ? "selected" : ""}>${s}</option>`).join("")}
          </select></div>
        <div class="field" style="grid-column:1/-1;"><label for="eNotes">Notes</label>
          <textarea id="eNotes" placeholder="Scope of work, special requirements…">${isEdit ? esc(est.notes || "") : ""}</textarea></div>
        <div class="field">
          <label for="eFollowUp">Follow-up Date</label>
          <input id="eFollowUp" class="input" type="date" value="${isEdit && est.followUpDate ? fmtDateInput(est.followUpDate) : ""}"/>
          <p class="help" style="margin-top:4px;">Set a reminder to follow up with this client.</p>
        </div>
      </div>

      <div class="sectionLabel" style="margin:20px 0 8px;">Add Line Item</div>
      <div class="quickAddTags" id="eQuickTags"></div>
      <div class="fieldGrid" style="margin-top:8px;">
        <div class="field"><label for="eLIName">Service / Material *</label>
          <input id="eLIName" class="input" type="text" maxlength="120" placeholder="e.g. Attic Blown-in"/></div>
        <div class="field"><label for="eLIDesc">Description</label>
          <input id="eLIDesc" class="input" type="text" maxlength="200" placeholder="e.g. R-38, 1 200 sqft"/></div>
        <div class="field estQtyField"><label for="eLIQty">Qty</label>
          <input id="eLIQty" class="input" type="number" min="0" step="0.01" placeholder="1" value="1"/></div>
        <div class="field estPriceField"><label for="eLIPrice">Unit Price ($)</label>
          <input id="eLIPrice" class="input" type="number" min="0" step="0.01" placeholder="0.00"/></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
        <button type="button" class="btn primary" id="eBtnAddItem" style="flex:1;min-width:140px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="13" x2="12" y2="17"/><line x1="10" y1="15" x2="14" y2="15"/></svg>Add Line Item</button>
        <button type="button" class="btn" id="eBtnMatCalc" style="flex:1;min-width:100px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px" aria-hidden="true"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="10" x2="10" y2="10"/><line x1="14" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="10" y2="14"/><line x1="14" y1="14" x2="16" y2="14"/><line x1="8" y1="18" x2="16" y2="18"/></svg>Mat. Calc</button>
        <button type="button" class="btn" id="eBtnAttic" style="flex:1;min-width:100px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px" aria-hidden="true"><path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z"/><polyline points="9 21 9 12 15 12 15 21"/></svg>Smart Calc</button>
      </div>

      <div style="margin-top:16px;" class="tableWrap">
        <table class="table" style="font-size:13px;min-width:400px;">
          <thead><tr>
            <th>Service / Material</th>
            <th style="text-align:right;width:60px;">Qty</th>
            <th style="text-align:right;width:90px;">Unit Price</th>
            <th style="text-align:right;width:90px;">Total</th>
            <th style="width:36px;"></th>
          </tr></thead>
          <tbody id="eLineItemsBody"></tbody>
        </table>
      </div>

      <div class="travelSection" style="margin-top:16px;padding:12px 14px;background:var(--panel2);border-radius:10px;">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-bottom:0;">
          <input type="checkbox" id="eTravelToggle" style="width:18px;height:18px;cursor:pointer;"
            ${isEdit && est.travelFee ? "checked" : ""}/>
          <span style="font-weight:600;font-size:13px;">Add Travel &amp; Logistics Fee</span>
        </label>
        <div id="eTravelInputWrap" style="margin-top:10px;display:${isEdit && est.travelFee ? "block" : "none"};">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <div class="field" style="flex:1;min-width:160px;margin:0;">
              <label for="eTravelFee" style="font-size:12px;">Fee Amount ($)</label>
              <input id="eTravelFee" class="input" type="number" min="0" step="0.01" placeholder="0.00"
                value="${isEdit && est.travelFee ? est.travelFee : state.settings.defaultTravelFee || 0}"/>
            </div>
            <div class="field" style="flex:1;min-width:160px;margin:0;">
              <label for="eTravelMiles" style="font-size:12px;">Miles (optional — auto-calc)</label>
              <input id="eTravelMiles" class="input" type="number" min="0" step="0.1" placeholder="e.g. 25"
                value="${isEdit && est.travelMiles ? est.travelMiles : ""}"/>
            </div>
          </div>
          <p class="help" style="margin-top:6px;">If you enter miles, the fee is calculated as miles × Travel Rate ($/mile) from Settings. Otherwise the flat fee is used.</p>
          <button type="button" class="btn" id="eBtnCalcDist" style="margin-top:8px;width:100%;font-size:12px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px" aria-hidden="true"><circle cx="12" cy="10" r="3"/><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>Auto-Calculate Driving Miles</button>
        </div>
      </div>

      <div class="estTotals">
        <div class="estTotalsRow estimateTotalsRow"><span class="muted">Subtotal (services)</span><strong id="eSubtotal">${fmt(0)}</strong></div>
        <div class="estTotalsRow estimateTotalsRow" id="eTravelFeeRow" style="display:none;"><span class="muted">Travel &amp; Logistics</span><strong id="eTravelFeeAmt">${fmt(0)}</strong></div>
        <div class="estTotalsRow estimateTotalsRow" id="eTaxRow" style="display:none;"><span class="muted">Tax (<span id="eTaxPct">0</span>%)</span><strong id="eTaxAmt">${fmt(0)}</strong></div>
        <div class="estTotalsRow estimateTotalsRow estTotalsGrand"><span>Grand Total</span><strong id="eGrandTotal">${fmt(0)}</strong></div>
      </div>

    </div>
    <div class="modalFt">
      <button type="button" class="btn" id="eCancel">Cancel</button>
      ${isEdit ? `<button type="button" class="btn" id="eBtnPDF" title="Download PDF"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="12" y2="17"/></svg>PDF</button>` : ""}
      ${!isEdit || est.status !== "Approved" ? `<button type="button" class="btn" id="eBtnSign" style="background:var(--primary);color:#fff;font-weight:600;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>Sign &amp; Approve</button>` : `<span class="badge est-approved" style="align-self:center;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-5"/></svg>Signed</span>`}
      <button type="button" class="btn primary" id="eSave">${isEdit ? "Save Changes" : "Create Estimate"}</button>
    </div>`);

  /* Initial render of items + totals */
  renderLineItems();

  /* Quick-add tags — driven by state.pricebook */
  const tagsContainer = m.querySelector("#eQuickTags");
  if (tagsContainer) {
    if (state.pricebook.length === 0) {
      tagsContainer.innerHTML = `<span class="muted" style="font-size:12px;">No services in your catalog yet. Go to Settings → Service Catalog to add some.</span>`;
    } else {
      tagsContainer.innerHTML = state.pricebook
        .map(
          (svc, i) =>
            `<button type="button" class="quickTag" data-qi="${i}">${esc(svc.name)}</button>`,
        )
        .join("");
      tagsContainer.querySelectorAll(".quickTag").forEach((btn) =>
        btn.addEventListener("click", () => {
          const svc = state.pricebook[parseInt(btn.dataset.qi)];
          m.querySelector("#eLIName").value = svc.name;
          m.querySelector("#eLIDesc").value = svc.description || "";
          if (svc.unitPrice)
            m.querySelector("#eLIPrice").value = svc.unitPrice.toFixed(2);
          m.querySelector("#eLIQty").focus();
        }),
      );
    }
  }

  /* ZIP lookup */
  m.querySelector("#eZip")?.addEventListener("blur", () => {
    lookupZIP(m.querySelector("#eZip").value, (city, st) => {
      if (!m.querySelector("#eCity").value)
        m.querySelector("#eCity").value = city;
      if (!m.querySelector("#eSt").value) m.querySelector("#eSt").value = st;
    });
  });

  /* Tax rate change → re-render totals */
  m.querySelector("#eTax")?.addEventListener("input", renderLineItems);

  /* Travel toggle */
  m.querySelector("#eTravelToggle")?.addEventListener("change", (e) => {
    const wrap = m.querySelector("#eTravelInputWrap");
    if (wrap) wrap.style.display = e.target.checked ? "block" : "none";
    renderLineItems();
  });
  /* Travel fee / miles change → re-render totals */
  m.querySelector("#eTravelFee")?.addEventListener("input", renderLineItems);
  m.querySelector("#eTravelMiles")?.addEventListener("input", () => {
    const miles = parseFloat(m.querySelector("#eTravelMiles").value) || 0;
    const rate = state.settings.travelRatePerMile || 0;
    if (miles > 0 && rate > 0) {
      const feeEl = m.querySelector("#eTravelFee");
      if (feeEl) feeEl.value = (miles * rate).toFixed(2);
    }
    renderLineItems();
  });

  /* Distance calculator */
  m.querySelector("#eBtnCalcDist")?.addEventListener("click", async () => {
    const origin = state.settings.companyAddress;
    if (!origin) {
      toast.warn(
        "No origin address",
        "Set your Company Address in Settings first.",
      );
      return;
    }
    const addr = m.querySelector("#eAddr")?.value.trim() || "";
    const city = m.querySelector("#eCity")?.value.trim() || "";
    const st = m.querySelector("#eSt")?.value.trim() || "";
    const zip = m.querySelector("#eZip")?.value.trim() || "";
    const dest = [addr, city, st, zip].filter(Boolean).join(", ");
    if (!dest) {
      toast.warn("No destination", "Fill in the client address fields first.");
      return;
    }
    const btn = m.querySelector("#eBtnCalcDist");
    btn.textContent = "⌛ Calculating…";
    btn.disabled = true;
    try {
      const miles = await calcDrivingMiles(origin, dest);
      if (miles != null) {
        const milesEl = m.querySelector("#eTravelMiles");
        if (milesEl) {
          milesEl.value = miles.toFixed(1);
          milesEl.dispatchEvent(new Event("input"));
        }
        toast.success(
          "Distance calculated",
          `${miles.toFixed(1)} miles driving`,
        );
      } else {
        toast.warn(
          "Calculation failed",
          "Could not find one of the addresses. Check spelling.",
        );
      }
    } catch {
      toast.warn("Calculation failed", "Check your internet connection.");
    } finally {
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px" aria-hidden="true"><circle cx="12" cy="10" r="3"/><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>Auto-Calculate Driving Miles`;
      btn.disabled = false;
    }
  });

  /* Address autocomplete on street address field */
  const eAddrEl = m.querySelector("#eAddr");
  if (eAddrEl) attachAddressAutocomplete(eAddrEl);

  /* Add line item button */
  m.querySelector("#eBtnAddItem").addEventListener("click", () => {
    const nameEl = m.querySelector("#eLIName");
    const descEl = m.querySelector("#eLIDesc");
    const qtyEl = m.querySelector("#eLIQty");
    const priceEl = m.querySelector("#eLIPrice");
    const name = nameEl.value.trim();
    const qty = Math.max(0.0001, safeNum(parseFloat(qtyEl.value)) || 1);
    const unitPrice = safeNum(parseFloat(priceEl.value));
    if (!name) {
      nameEl.classList.add("invalid");
      nameEl.focus();
      return;
    }
    nameEl.classList.remove("invalid");
    lineItems.push({
      id: uid(),
      name,
      description: descEl.value.trim(),
      qty,
      unitPrice,
      total: +(qty * unitPrice).toFixed(2),
    });
    nameEl.value = "";
    descEl.value = "";
    qtyEl.value = "1";
    priceEl.value = "";
    renderLineItems();
  });

  /* Materials Calculator: push returned item into lineItems */
  m.querySelector("#eBtnMatCalc").addEventListener("click", () =>
    openMaterialsCalcModal((item) => {
      lineItems.push(item);
      renderLineItems();
    }),
  );

  /* Smart Calc: push returned items directly into lineItems */
  m.querySelector("#eBtnAttic").addEventListener("click", () =>
    openAtticCalcModal(m, (matItem, laborItem) => {
      lineItems.push(matItem);
      if (laborItem) lineItems.push(laborItem);
      renderLineItems();
    }),
  );

  m.querySelector("#eCancel").addEventListener("click", modal.close);

  /* ── PDF (edit mode only) ── */
  m.querySelector("#eBtnPDF")?.addEventListener("click", () =>
    exportEstimatePDF(est),
  );

  /* ── Sign & Approve ── */
  m.querySelector("#eBtnSign")?.addEventListener("click", () => {
    const signModal = modal.open(`
      <div class="modalHd">
        <div><h2><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:7px" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>Customer Signature</h2>
          <p>Sign below to approve this estimate.</p></div>
        <button type="button" class="closeX" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modalBd" style="display:flex;flex-direction:column;align-items:center;gap:12px;">
        <canvas id="sigCanvas" width="480" height="200"
          style="border:2px solid var(--border);border-radius:10px;background:#fff;touch-action:none;cursor:crosshair;max-width:100%;"></canvas>
        <p class="help" style="text-align:center;">Draw your signature above.</p>
      </div>
      <div class="modalFt">
        <button type="button" class="btn" id="sigClear">🗑 Clear</button>
        <button type="button" class="btn" id="sigCancel">Cancel</button>
        <button type="button" class="btn primary" id="sigSave"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-5"/></svg>Confirm Signature</button>
      </div>`);

    const canvas = signModal.querySelector("#sigCanvas");
    const ctx = canvas.getContext("2d");
    ctx.strokeStyle = "#14285a";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    let drawing = false;

    /* Prefill existing signature if re-signing */
    if (pendingSignature) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0);
      img.src = pendingSignature;
    }

    const getPos = (e) => {
      const r = canvas.getBoundingClientRect();
      const src = e.touches ? e.touches[0] : e;
      return {
        x: (src.clientX - r.left) * (canvas.width / r.width),
        y: (src.clientY - r.top) * (canvas.height / r.height),
      };
    };
    const start = (e) => {
      e.preventDefault();
      drawing = true;
      const p = getPos(e);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
    };
    const move = (e) => {
      e.preventDefault();
      if (!drawing) return;
      const p = getPos(e);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    };
    const end = (e) => {
      e.preventDefault();
      drawing = false;
    };

    canvas.addEventListener("mousedown", start);
    canvas.addEventListener("mousemove", move);
    canvas.addEventListener("mouseup", end);
    canvas.addEventListener("mouseleave", end);
    canvas.addEventListener("touchstart", start, { passive: false });
    canvas.addEventListener("touchmove", move, { passive: false });
    canvas.addEventListener("touchend", end, { passive: false });

    signModal.querySelector("#sigClear").addEventListener("click", () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    });
    signModal
      .querySelector("#sigCancel")
      .addEventListener("click", modal.close);
    signModal.querySelector("#sigSave").addEventListener("click", () => {
      /* Check canvas is not blank */
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const hasInk = px.some((v, i) => i % 4 === 3 && v > 0);
      if (!hasInk) {
        toast.warn("Empty signature", "Please sign before confirming.");
        return;
      }
      pendingSignature = canvas.toDataURL("image/png");
      /* Set status to Approved in the parent modal */
      const statusEl = m.querySelector("#eStatus");
      if (statusEl) statusEl.value = "Approved";
      modal.close();
      toast.success("Signature captured", "Status set to Approved.");
    });
  });

  m.querySelector("#eSave").addEventListener("click", () => {
    const clEl = m.querySelector("#eCl");
    if (!clEl.value.trim()) {
      clEl.classList.add("invalid");
      clEl.focus();
      return;
    }
    clEl.classList.remove("invalid");
    const taxRate = parseFloat(m.querySelector("#eTax").value) || 0;
    const subtotal = computeSubtotal();
    const travelFeeVal =
      getTravelFeeValue(); /* compute once — used in both travelFee and value */
    const saved = {
      id: isEdit ? est.id : uid(),
      name: isEdit ? est.name : getNextEstimateNumber(),
      client: clEl.value.trim(),
      phone: m.querySelector("#ePh").value.trim(),
      email: m.querySelector("#eEm").value.trim(),
      address: m.querySelector("#eAddr").value.trim(),
      zip: m.querySelector("#eZip").value.trim(),
      city: m.querySelector("#eCity").value.trim(),
      state: m.querySelector("#eSt").value.trim(),
      insulationType: m.querySelector("#eIT").value,
      areaType: m.querySelector("#eAT").value,
      sqft: parseFloat(m.querySelector("#eSqft").value) || null,
      taxRate,
      status: m.querySelector("#eStatus").value,
      notes: m.querySelector("#eNotes").value.trim(),
      date: isEdit ? est.date : Date.now(),
      sentDate: isEdit ? est.sentDate : null,
      items: lineItems,
      travelFee: travelFeeVal,
      travelMiles: parseFloat(m.querySelector("#eTravelMiles")?.value) || 0,
      value: +((subtotal + travelFeeVal) * (1 + taxRate / 100)).toFixed(2),
      signature: pendingSignature || null,
      followUpDate: parseDate(m.querySelector("#eFollowUp")?.value) || null,
    };
    saveEstimate(saved)
      .then(() => {
        toast.success(
          isEdit ? "Estimate updated" : "Estimate created",
          saved.name,
        );
        modal.close();
        render();
      })
      .catch(() => toast.error("Save error", "Could not save estimate."));
  });
}

/* ─── PDF: Estimate ─────────────────────────── */
function exportEstimatePDF(est) {
  if (!window.jspdf) {
    toast.error("PDF Error", "jsPDF not loaded.");
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const lm = 18; /* left margin */
  const rr = 192; /* right edge  */
  const pw = rr - lm; /* printable width */
  const FOOTER_Y = 272; /* footer bar starts */
  const PAGE_SAFE = 262; /* last safe y before footer */
  const s = state.settings;

  /* ── helpers ── */
  const newPage = () => {
    drawFooter();
    doc.addPage();
    return 20;
  };
  const safeY = (needed = 10) => {
    if (y + needed > PAGE_SAFE) y = newPage();
  };

  /* ── data ── */
  const items =
    est.items && est.items.length
      ? est.items
      : est.value
        ? [
            {
              id: "legacy",
              name: "Services rendered",
              description: "",
              qty: 1,
              unitPrice: est.value,
              total: est.value,
            },
          ]
        : [];
  const subtotal =
    Math.round(items.reduce((s, i) => s + (i.total || 0), 0) * 100) / 100;
  const travel = Math.round((est.travelFee || 0) * 100) / 100;
  const taxRate = est.taxRate || 0;
  const taxBase = Math.round((subtotal + travel) * 100) / 100;
  const taxAmt = Math.round(taxBase * (taxRate / 100) * 100) / 100;
  const grand = Math.round((taxBase + taxAmt) * 100) / 100;

  /* ── footer helper (drawn on each page) ── */
  function drawFooter() {
    const pg = doc.internal.getCurrentPageInfo().pageNumber;
    doc.setFillColor(18, 18, 18);
    doc.rect(0, FOOTER_Y, 210, 297 - FOOTER_Y, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    const txt =
      [
        s.company || "Your Company",
        s.companyPhone,
        s.companyEmail,
        s.licenseNumber ? `Lic: ${s.licenseNumber}` : null,
      ]
        .filter(Boolean)
        .join("  ·  ") || "Valid for 30 days from issue date";
    doc.text(txt, 105, FOOTER_Y + 8, { align: "center" });
    doc.text(`Page ${pg}`, rr, FOOTER_Y + 8, { align: "right" });
    doc.setTextColor(0);
  }

  /* ═══════════════ HEADER BAR ═══════════════ */
  doc.setFillColor(18, 18, 18);
  doc.rect(0, 0, 210, 40, "F");
  if (s.logoDataUrl) {
    try {
      const logoFmt = s.logoDataUrl.startsWith("data:image/png") ? "PNG" : "JPEG";
      doc.addImage(s.logoDataUrl, logoFmt, lm, 5, 28, 28);
    } catch (err) { console.warn("[PDF] Logo render failed:", err); }
  }
  const hx = s.logoDataUrl ? lm + 32 : lm;
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.text("ESTIMATE", hx, 20);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(s.company || "Your Company", hx, 28);
  if (s.companyAddress) doc.text(s.companyAddress, hx, 33);
  if (s.companyPhone || s.companyEmail) {
    const contact = [
      s.companyPhone ? `Tel: ${s.companyPhone}` : null,
      s.companyEmail,
    ]
      .filter(Boolean)
      .join("   ");
    doc.text(contact, hx, 38);
  }
  if (s.licenseNumber)
    doc.text(`Lic: ${s.licenseNumber}`, rr, 28, { align: "right" });
  doc.setTextColor(0);

  /* ═══════════════ META + CLIENT (two columns) ═══════════════ */
  let y = 52;
  const midX = lm + pw / 2 + 4;

  /* Left: Client */
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(120);
  doc.text("PREPARED FOR", lm, y);
  doc.setTextColor(0);
  doc.setFontSize(11);
  doc.text(est.client || "—", lm, y + 6);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  let cy = y + 13;
  if (est.address) {
    doc.text(est.address, lm, cy);
    cy += 5;
  }
  if (est.city || est.state || est.zip) {
    doc.text([est.city, est.state, est.zip].filter(Boolean).join(", "), lm, cy);
    cy += 5;
  }
  if (est.phone) {
    doc.text(`Tel: ${est.phone}`, lm, cy);
    cy += 5;
  }
  if (est.email) {
    doc.text(est.email, lm, cy);
    cy += 5;
  }

  /* Right: Estimate meta */
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(120);
  doc.text("ESTIMATE NO.", rr, y, { align: "right" });
  doc.setTextColor(0);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text(est.name || "—", rr, y + 6, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`Date: ${fmtDate(Date.now())}`, rr, y + 13, { align: "right" });
  if (est.insulationType)
    doc.text(est.insulationType, rr, y + 19, { align: "right" });
  if (est.areaType) doc.text(est.areaType, rr, y + 25, { align: "right" });

  y = Math.max(cy, y + 30) + 6;

  /* Divider */
  doc.setDrawColor(200);
  doc.setLineWidth(0.4);
  doc.line(lm, y, rr, y);
  y += 8;

  /* ═══════════════ ITEMS TABLE ═══════════════ */
  const cols = [lm, lm + 72, lm + 114, lm + 138, lm + 160];
  const cw = [70, 40, 22, 20, pw - (cols[4] - lm)];

  /* Table header */
  doc.setFillColor(18, 18, 18);
  doc.rect(lm, y - 5, pw, 7, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  ["Service / Material", "Description", "Qty", "Unit Price", "Total"].forEach(
    (h, i) => doc.text(h, cols[i] + 1, y),
  );
  y += 5;
  doc.setTextColor(0);
  doc.setFont("helvetica", "normal");

  /* Item rows */
  const allRows = [...items];
  if (travel > 0)
    allRows.push({
      name: "Travel & Logistics",
      description: est.travelMiles ? `${est.travelMiles} mi` : "",
      qty: "",
      unitPrice: null,
      total: travel,
      _travel: true,
    });

  allRows.forEach((item, i) => {
    safeY(8);
    if (i % 2 === 0) {
      doc.setFillColor(246, 246, 246);
      doc.rect(lm, y - 4, pw, 7, "F");
    }
    doc.setFont("helvetica", item._travel ? "italic" : "normal");
    doc.setFontSize(8.5);
    doc.text(
      doc.splitTextToSize(String(item.name || ""), cw[0])[0],
      cols[0] + 1,
      y,
    );
    doc.text(
      doc.splitTextToSize(String(item.description || ""), cw[1])[0],
      cols[1] + 1,
      y,
    );
    doc.text(String(item.qty ?? ""), cols[2] + 1, y);
    doc.text(
      item.unitPrice != null ? formatCurrency(item.unitPrice) : "",
      cols[3] + 1,
      y,
    );
    doc.setFont("helvetica", "bold");
    doc.text(formatCurrency(item.total), rr, y, { align: "right" });
    doc.setFont("helvetica", "normal");
    y += 7;
  });

  /* ═══════════════ TOTALS BLOCK ═══════════════ */
  const totalsNeeded = 8 + (travel > 0 ? 6 : 0) + (taxRate > 0 ? 6 : 0) + 10;
  safeY(totalsNeeded + 14);

  y += 4;
  doc.setDrawColor(200);
  doc.setLineWidth(0.4);
  doc.line(lm, y, rr, y);
  y += 7;

  const totRow = (lbl, val, bold) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(bold ? 11 : 9);
    if (bold) {
      doc.setFillColor(18, 18, 18);
      doc.rect(lm + pw * 0.55, y - 5, pw * 0.45, 8, "F");
      doc.setTextColor(255, 255, 255);
    }
    doc.text(lbl, rr - 38, y, { align: "right" });
    doc.text(val, rr, y, { align: "right" });
    if (bold) doc.setTextColor(0);
    y += bold ? 10 : 6;
  };
  totRow("Subtotal:", formatCurrency(subtotal), false);
  if (travel > 0) totRow("Travel Fee:", formatCurrency(travel), false);
  if (taxRate > 0) totRow(`Tax (${taxRate}%):`, formatCurrency(taxAmt), false);
  totRow("TOTAL DUE:", formatCurrency(grand), true);

  /* ═══════════════ NOTES ═══════════════ */
  if (est.notes) {
    safeY(20);
    y += 6;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text("Notes / Scope of Work:", lm, y);
    y += 6;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc
      .splitTextToSize(est.notes, pw)
      .slice(0, 10)
      .forEach((l) => {
        safeY(6);
        doc.text(l, lm, y);
        y += 5;
      });
  }

  /* ═══════════════ SIGNATURE ═══════════════ */
  if (est.signature) {
    safeY(46);
    y += 8;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(60, 60, 60);
    doc.text("Customer Approval Signature:", lm, y);
    doc.setDrawColor(160);
    doc.line(lm, y + 2, lm + 100, y + 2);
    try {
      doc.addImage(est.signature, "PNG", lm, y + 4, 90, 28);
    } catch (err) {
      console.warn("[PDF] Signature render failed:", err);
      doc.setFont("helvetica", "italic");
      doc.setFontSize(8);
      doc.setTextColor(150);
      doc.text("(Signature image unavailable)", lm, y + 20);
      doc.setTextColor(0);
    }
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(120, 120, 120);
    doc.text(`Signed: ${new Date().toLocaleDateString("en-US")}`, lm, y + 36);
    doc.setTextColor(0);
    y += 42;
  }

  /* ═══════════════ FOOTER (last page) ═══════════════ */
  drawFooter();

  showToast("Generating PDF…", "info");
  doc.save(
    `estimate_${(est.name || "quote").replace(/[^a-z0-9]/gi, "_").slice(0, 40)}.pdf`,
  );
  showToast("PDF Downloaded! ✓", "success");
}

/* ─── Payroll Report ─────────────────────────── */
function openPayrollModal() {
  const now = new Date();
  const firstOfMonth = fmtDateInput(
    new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
  );
  const today = fmtDateInput(now.getTime());

  modal.open(`
    <div class="modalHd">
      <div><h2>Payroll Report</h2><p>Calculate crew pay for a date range.</p></div>
      <button class="closeX" aria-label="Close">&times;</button>
    </div>
    <div class="modalBd">
      <div class="fieldGrid" style="margin-bottom:16px;">
        <div class="field"><label for="prStart">Start Date</label><input id="prStart" class="input" type="date" value="${firstOfMonth}"/></div>
        <div class="field"><label for="prEnd">End Date</label><input id="prEnd" class="input" type="date" value="${today}"/></div>
      </div>
      <button class="btn primary" id="btnGenPayroll" style="width:100%;">Generate Report</button>
      <div id="payrollResult" style="margin-top:20px;"></div>
    </div>`);

  const m = document.querySelector(".modal");

  m.querySelector("#btnGenPayroll").addEventListener("click", () => {
    const start = parseDate(m.querySelector("#prStart").value);
    const end = parseDate(m.querySelector("#prEnd").value);
    if (!start || !end || start > end) {
      toast.warn("Invalid range", "Please select a valid start and end date.");
      return;
    }
    const endOfDay = end + 86399999; /* include the full end day */

    /* Group logs by crewId within date range */
    const byMember = {};
    state.timeLogs.forEach((l) => {
      if (!l.crewId) return;
      if (l.date < start || l.date > endOfDay) return;
      byMember[l.crewId] = (byMember[l.crewId] || 0) + (l.hours || 0);
    });

    /* Also include crew members with 0 hours (for reference) */
    state.crew.forEach((c) => {
      if (!(c.id in byMember)) byMember[c.id] = 0;
    });

    const rows = Object.entries(byMember)
      .map(([cid, hours]) => {
        const member = state.crew.find((c) => c.id === cid);
        const name = member ? member.name : "Unknown";
        const rate = member?.hourlyRate || 0;
        return { name, hours, rate, total: hours * rate };
      })
      .sort((a, b) => b.total - a.total);

    const grandTotal = rows.reduce((s, r) => s + r.total, 0);

    if (rows.length === 0) {
      m.querySelector("#payrollResult").innerHTML =
        `<div class="empty">No time logs with assigned crew members in this period.</div>`;
      return;
    }

    m.querySelector("#payrollResult").innerHTML = `
      <div class="tableWrap">
        <table class="table" id="payrollTable">
          <thead><tr>
            <th>Name</th>
            <th style="text-align:right;">Hours</th>
            <th style="text-align:right;">Rate ($/hr)</th>
            <th style="text-align:right;">Total Pay</th>
          </tr></thead>
          <tbody>
            ${rows
              .map(
                (r) => `
              <tr>
                <td><strong>${esc(r.name)}</strong></td>
                <td style="text-align:right;">${r.hours.toFixed(2)}h</td>
                <td style="text-align:right;">${fmt(r.rate)}</td>
                <td style="text-align:right;"><strong>${fmt(r.total)}</strong></td>
              </tr>`,
              )
              .join("")}
          </tbody>
          <tfoot><tr>
            <td colspan="3"><strong>Grand Total</strong></td>
            <td style="text-align:right;"><strong>${fmt(grandTotal)}</strong></td>
          </tr></tfoot>
        </table>
      </div>
      <button class="btn" id="btnPayrollPDF" style="margin-top:12px;width:100%;">⬇ Export PDF</button>`;

    m.querySelector("#btnPayrollPDF").addEventListener("click", () => {
      if (!window.jspdf) {
        toast.error("PDF Error", "jsPDF not loaded.");
        return;
      }
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: "mm", format: "a4" });
      const co = state.settings.company || "JobCost Pro";
      const startLabel = new Date(start).toLocaleDateString("en-US");
      const endLabel = new Date(endOfDay).toLocaleDateString("en-US");

      doc.setFontSize(18);
      doc.setFont("helvetica", "bold");
      doc.text("Payroll Report", 14, 20);
      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      doc.text(`${co}`, 14, 28);
      doc.text(`Period: ${startLabel} — ${endLabel}`, 14, 34);
      doc.text(`Generated: ${new Date().toLocaleDateString("en-US")}`, 14, 40);

      /* Table header */
      let y = 52;
      doc.setFillColor(18, 18, 18);
      doc.rect(14, y - 5, 183, 8, "F");
      doc.setTextColor(255);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.text("Name", 16, y);
      doc.text("Hours", 110, y, { align: "right" });
      doc.text("Rate", 145, y, { align: "right" });
      doc.text("Total Pay", 196, y, { align: "right" });
      doc.setTextColor(0);
      y += 10;

      rows.forEach((r, i) => {
        if (i % 2 === 0) {
          doc.setFillColor(245, 247, 252);
          doc.rect(14, y - 5, 183, 7, "F");
        }
        doc.setFont("helvetica", "normal");
        doc.text(r.name.slice(0, 35), 16, y);
        doc.text(`${r.hours.toFixed(2)}h`, 110, y, { align: "right" });
        doc.text(`$${r.rate.toFixed(2)}/hr`, 145, y, { align: "right" });
        doc.setFont("helvetica", "bold");
        doc.text(fmt(r.total), 196, y, { align: "right" });
        y += 8;
      });

      /* Footer total */
      doc.setDrawColor(180);
      doc.line(14, y, 197, y);
      y += 6;
      doc.setFont("helvetica", "bold");
      doc.text("Grand Total", 16, y);
      doc.text(fmt(grandTotal), 196, y, { align: "right" });

      /* Footer on last page */
      doc.setFillColor(18, 18, 18);
      doc.rect(0, 272, 210, 25, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(7.5);
      doc.setFont("helvetica", "normal");
      const payFootTxt = [co, state.settings.companyPhone, state.settings.companyEmail]
        .filter(Boolean).join("  ·  ") || "JobCost Pro — Payroll Report";
      doc.text(payFootTxt, 105, 280, { align: "center" });
      doc.text(`Page ${doc.internal.getCurrentPageInfo().pageNumber}`, 196, 280, { align: "right" });
      doc.setTextColor(0);

      doc.save(
        `payroll_${startLabel.replace(/\//g, "-")}_${endLabel.replace(/\//g, "-")}.pdf`,
      );
      toast.success("Payroll PDF exported");
    });
  });
}

/* ─── Crew ───────────────────────────────────── */
function renderCrew(root) {
  const sorted = [...state.crew].sort((a, b) => a.name.localeCompare(b.name));
  root.innerHTML = `
      <div class="pageHeader">
        <h2 class="pageTitle">Crew &amp; Technicians <span class="muted" style="font-size:14px;font-weight:400;">(${sorted.length})</span></h2>
        <div style="display:flex;gap:8px;">
          <button class="btn admin-only" id="btnPayroll"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px" aria-hidden="true"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/></svg>Payroll Report</button>
          <button class="btn primary admin-only" id="btnNCr">+ Add Member</button>
        </div>
      </div>
      ${
        sorted.length === 0
          ? `<div class="empty">No crew members yet. Add your installers and technicians.</div>`
          : `<div class="tableWrap"><table class="table">
            <thead><tr>
              <th>Name</th><th>Role</th><th>Phone</th><th>Email</th>
              <th>Certifications</th><th>Status</th><th>Actions</th>
            </tr></thead>
            <tbody>
              ${sorted
                .map((c) => {
                  const jobCount = state.jobs.filter((j) =>
                    (j.crewIds || []).includes(c.id),
                  ).length;
                  return `<tr>
                  <td><strong>${esc(c.name)}</strong>${c.notes ? `<br><span class="small muted">${esc(c.notes)}</span>` : ""}</td>
                  <td>${esc(c.role || "—")}</td>
                  <td>${c.phone ? `<a href="tel:${esc(c.phone)}" class="link">${esc(c.phone)}</a>` : `<span class="muted">—</span>`}</td>
                  <td>${c.email ? `<a href="mailto:${esc(c.email)}" class="link">${esc(c.email)}</a>` : `<span class="muted">—</span>`}</td>
                  <td><span class="small">${esc(c.certifications || "—")}</span></td>
                  <td><span class="badge crew-${(c.status || "active").toLowerCase()}">${c.status || "Active"}</span><br>
                    <span class="small muted">${jobCount} job${jobCount !== 1 ? "s" : ""}</span></td>
                  <td>
                    <div style="display:flex;gap:5px;">
                      <button class="btn admin-only" data-ecr="${c.id}" style="padding:5px 9px;font-size:12px;">Edit</button>
                      <button class="btn danger admin-only" data-dcr="${c.id}" style="padding:5px 9px;font-size:12px;">Delete</button>
                    </div>
                  </td>
                </tr>`;
                })
                .join("")}
            </tbody>
          </table></div>`
      }`;

  root
    .querySelector("#btnPayroll")
    ?.addEventListener("click", openPayrollModal);
  root
    .querySelector("#btnNCr")
    ?.addEventListener("click", () => openCrewModal(null));
  root.querySelectorAll("[data-ecr]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const c = state.crew.find((x) => x.id === btn.dataset.ecr);
      if (c) openCrewModal(c);
    }),
  );
  root.querySelectorAll("[data-dcr]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const c = state.crew.find((x) => x.id === btn.dataset.dcr);
      if (!c) return;
      if (demoBlock()) return;
      confirm("Remove Crew Member", c.name, "Remove", () => {
        idb.del(APP.stores.crew, c.id).then(() => {
          state.crew = state.crew.filter((x) => x.id !== c.id);
          toast.warn("Crew member removed", c.name);
          render();
        });
      });
    }),
  );
}

function openCrewModal(member) {
  const isEdit = !!member;
  const ROLES = [
    "Lead Installer",
    "Installer",
    "Helper",
    "Foreman",
    "Supervisor",
  ];
  const m = modal.open(`
      <div class="modalHd">
        <div><h2>${isEdit ? "Edit Crew Member" : "Add Crew Member"}</h2>
          <p>${isEdit ? esc(member.name) : "Add an installer or technician."}</p></div>
        <button type="button" class="closeX" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modalBd">
        <div class="fieldGrid">
          <div class="field" style="grid-column:1/-1;"><label for="crN">Full Name *</label>
            <input id="crN" class="input" type="text" maxlength="120" placeholder="e.g. Carlos Rivera" value="${isEdit ? esc(member.name) : ""}"/></div>
          <div class="field"><label for="crR">Role</label>
            <select id="crR">
              ${ROLES.map((r) => `<option value="${r}" ${isEdit && member.role === r ? "selected" : ""}>${r}</option>`).join("")}
            </select></div>
          <div class="field"><label for="crS">Status</label>
            <select id="crS">
              <option value="Active" ${isEdit && member.status === "Active" ? "selected" : ""}>Active</option>
              <option value="Inactive" ${isEdit && member.status === "Inactive" ? "selected" : ""}>Inactive</option>
            </select></div>
          <div class="field"><label for="crPh">Phone</label>
            <input id="crPh" class="input" type="tel" maxlength="30" placeholder="(555) 123-4567" value="${isEdit ? esc(member.phone || "") : ""}"/></div>
          <div class="field"><label for="crEm">Email</label>
            <input id="crEm" class="input" type="email" maxlength="120" placeholder="installer@email.com" value="${isEdit ? esc(member.email || "") : ""}"/></div>
          <div class="field"><label for="crRate">Hourly Rate ($/hr)</label>
            <input id="crRate" class="input" type="number" min="0" step="0.01" placeholder="0.00" value="${isEdit ? member.hourlyRate || "" : ""}"/></div>
          <div class="field" style="grid-column:1/-1;"><label for="crCert">Certifications</label>
            <input id="crCert" class="input" type="text" maxlength="200" placeholder="e.g. BPI Certified, OSHA 10" value="${isEdit ? esc(member.certifications || "") : ""}"/></div>
          <div class="field" style="grid-column:1/-1;"><label for="crNo">Notes</label>
            <textarea id="crNo" placeholder="Additional notes…">${isEdit ? esc(member.notes || "") : ""}</textarea></div>
        </div>
      </div>
      <div class="modalFt">
        <button type="button" class="btn" id="crCancel">Cancel</button>
        <button type="button" class="btn primary" id="crSave">${isEdit ? "Save Changes" : "Add Member"}</button>
      </div>`);

  m.querySelector("#crCancel").addEventListener("click", modal.close);
  m.querySelector("#crSave").addEventListener("click", () => {
    const nEl = m.querySelector("#crN");
    if (!nEl.value.trim()) {
      nEl.classList.add("invalid");
      nEl.focus();
      return;
    }
    nEl.classList.remove("invalid");
    const saved = {
      id: isEdit ? member.id : uid(),
      name: nEl.value.trim(),
      role: m.querySelector("#crR").value,
      status: m.querySelector("#crS").value,
      phone: m.querySelector("#crPh").value.trim(),
      email: m.querySelector("#crEm").value.trim(),
      hourlyRate: parseFloat(m.querySelector("#crRate").value) || 0,
      certifications: m.querySelector("#crCert").value.trim(),
      notes: m.querySelector("#crNo").value.trim(),
      date: isEdit ? member.date : Date.now(),
    };
    saveCrewMember(saved)
      .then(() => {
        toast.success(isEdit ? "Member updated" : "Member added", saved.name);
        modal.close();
        render();
      })
      .catch(() => toast.error("Save error", "Could not save crew member."));
  });
}

/* ─── PDF: Purchase Order ────────────────────── */
function exportPO_PDF(items) {
  if (!window.jspdf) {
    toast.error("PDF Error", "jsPDF not loaded.");
    return;
  }
  if (!items || !items.length) {
    toast.warn("No items", "All inventory is at sufficient stock levels.");
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const s = state.settings;
  const lm = 14,
    rr = 196,
    pw = 182;
  let y = 18;

  const poNumber = `PO-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;

  /* ── Header bar ── */
  doc.setFillColor(18, 18, 18);
  doc.rect(0, 0, 210, 38, "F");
  if (s.logoDataUrl) {
    try {
      const logoFmt = s.logoDataUrl.startsWith("data:image/png") ? "PNG" : "JPEG";
      doc.addImage(s.logoDataUrl, logoFmt, lm, 4, 28, 28);
    } catch (err) { console.warn("[PDF] Logo render failed:", err); }
  }
  const txtX = s.logoDataUrl ? lm + 32 : lm;
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(22);
  doc.setFont("helvetica", "bold");
  doc.text("PURCHASE ORDER", txtX, y);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  if (s.company) doc.text(s.company, txtX, y + 8);
  if (s.companyAddress) doc.text(s.companyAddress, txtX, y + 14);
  if (s.companyPhone) doc.text(`Tel: ${s.companyPhone}`, txtX, y + 20);
  doc.setFont("helvetica", "bold");
  doc.text(`PO #: ${poNumber}`, rr, y, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.text(`Date: ${fmtDate(Date.now())}`, rr, y + 7, { align: "right" });
  if (s.licenseNumber)
    doc.text(`Lic: ${s.licenseNumber}`, rr, y + 14, { align: "right" });
  doc.setTextColor(0);
  y = 46;

  /* ── Supplier section ── */
  doc.setFillColor(245, 247, 252);
  doc.rect(lm, y, pw, 28, "F");
  doc.setDrawColor(200, 210, 230);
  doc.rect(lm, y, pw, 28);
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.text("SUPPLIER INFORMATION", lm + 3, y + 6);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text("Company:", lm + 3, y + 13);
  doc.line(lm + 25, y + 13, lm + 88, y + 13);
  doc.text("Contact:", lm + 3, y + 19);
  doc.line(lm + 25, y + 19, lm + 88, y + 19);
  doc.text("Phone:", lm + 3, y + 25);
  doc.line(lm + 25, y + 25, lm + 88, y + 25);
  doc.text("Email:", lm + 95, y + 13);
  doc.line(lm + 110, y + 13, rr, y + 13);
  doc.text("Address:", lm + 95, y + 19);
  doc.line(lm + 115, y + 19, rr, y + 19);
  doc.text("Terms:", lm + 95, y + 25);
  doc.line(lm + 115, y + 25, rr, y + 25);
  doc.setDrawColor(0);
  y += 34;

  /* ── Delivery info ── */
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.text("Deliver to:", lm, y);
  doc.setFont("helvetica", "normal");
  const deliverTo = [s.company, s.companyAddress, s.companyPhone]
    .filter(Boolean)
    .join("  ·  ");
  doc.text(deliverTo || "____________________________________", lm + 25, y);
  doc.text(`Required by: ____________________`, rr, y, { align: "right" });
  y += 10;

  /* ── Table header ── */
  const cols = [lm, lm + 62, lm + 98, lm + 113, lm + 128, lm + 145, lm + 163];
  const colW = [58, 32, 15, 15, 17, 18, pw - (cols[6] - lm)];
  doc.setFillColor(18, 18, 18);
  doc.rect(lm, y - 5, pw, 8, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  [
    "Item / Description",
    "Category",
    "Unit",
    "On Hand",
    "Min Stock",
    "Order Qty",
    "Unit Cost",
  ].forEach((h, i) => doc.text(h, cols[i] + 1, y));
  doc.setTextColor(0);
  y += 5;

  /* ── Table rows ── */
  let grandTotal = 0;
  items.forEach((item, idx) => {
    if (y > 250) {
      doc.addPage();
      y = 20;
    }
    const orderQty = Math.max(
      1,
      (item.minStock || 10) * 2 - (item.quantity || 0),
    );
    const lineTotal = orderQty * (item.unitCost || 0);
    grandTotal += lineTotal;
    const isOut = (item.quantity || 0) <= 0;

    if (idx % 2 === 0) {
      doc.setFillColor(248, 249, 252);
      doc.rect(lm, y - 4, pw, 7, "F");
    }
    if (isOut) {
      doc.setTextColor(200, 30, 30);
    } else {
      doc.setTextColor(160, 100, 0);
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.text(item.name.slice(0, 34), cols[0] + 1, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(60, 60, 60);
    if (item.supplier)
      doc.text(item.supplier.slice(0, 30), cols[0] + 1, y + 3.5);
    doc.setTextColor(0);
    doc.text(esc(item.category || "—").slice(0, 16), cols[1] + 1, y);
    doc.text(item.unit || "—", cols[2] + 1, y);
    doc.setTextColor(isOut ? 180 : 0, isOut ? 0 : 0, 0);
    doc.text(String(item.quantity ?? 0), cols[3] + 1, y);
    doc.setTextColor(0);
    doc.text(String(item.minStock ?? 0), cols[4] + 1, y);
    doc.setFont("helvetica", "bold");
    doc.setFillColor(255, 235, 100);
    doc.rect(cols[5], y - 4, colW[5], 7, "F");
    doc.setTextColor(80, 60, 0);
    doc.text(String(orderQty), cols[5] + 2, y);
    doc.setTextColor(0);
    doc.setFont("helvetica", "normal");
    doc.text(fmt(item.unitCost || 0), cols[6] + 1, y);
    y += 8;
  });

  /* ── Total row ── */
  y += 2;
  doc.setFillColor(18, 18, 18);
  doc.rect(lm, y - 5, pw, 9, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("ESTIMATED TOTAL (at current unit cost)", cols[0] + 1, y);
  doc.text(fmt(grandTotal), rr, y, { align: "right" });
  doc.setTextColor(0);
  y += 14;

  /* ── Notes ── */
  if (y > 230) {
    doc.addPage();
    y = 20;
  }
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.text("Notes / Special Instructions:", lm, y);
  doc.setFont("helvetica", "normal");
  doc.setFillColor(250, 251, 254);
  doc.rect(lm, y + 2, pw, 18, "FD");
  y += 26;

  /* ── Signatures ── */
  if (y > 255) {
    doc.addPage();
    y = 20;
  }
  const sigW = pw / 3 - 4;
  const sigs = ["Requested By", "Approved By", "Supplier Signature"];
  sigs.forEach((label, i) => {
    const sx = lm + i * (sigW + 6);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.text(label, sx, y);
    doc.line(sx, y + 12, sx + sigW, y + 12);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.text("Signature / Date", sx, y + 16);
    if (i === 0 && s.company) {
      doc.setFont("helvetica", "normal");
      doc.text(s.company, sx, y + 5);
    }
  });

  /* ── Footer ── */
  doc.setFontSize(7);
  doc.setTextColor(150);
  doc.text(
    `Generated by JobCost Pro · ${fmtDate(Date.now())} · PO# ${poNumber}`,
    105,
    290,
    { align: "center" },
  );

  doc.save(`PO_${poNumber}.pdf`);
  toast.success(
    "Purchase Order exported",
    `${items.length} items · Est. ${fmt(grandTotal)}`,
  );
}

/* ─── Equipment Tracker ──────────────────────── */
function openEquipmentModal(eq) {
  const isEdit = !!eq;
  const m = modal.open(`
    <div class="modalHd">
      <div><h2>${isEdit ? "Edit Equipment" : "Add Equipment"}</h2>
        <p>${isEdit ? esc(eq.name) : "Add a tool or machine to track."}</p></div>
      <button class="closeX" aria-label="Close">&times;</button>
    </div>
    <div class="modalBd">
      <div class="fieldGrid">
        <div class="field"><label for="eqName">Name *</label>
          <input id="eqName" class="input" type="text" maxlength="100" placeholder="e.g. Fiber Machine" value="${isEdit ? esc(eq.name) : ""}"/></div>
        <div class="field"><label for="eqSerial">Serial / Model #</label>
          <input id="eqSerial" class="input" type="text" maxlength="80" placeholder="Optional" value="${isEdit ? esc(eq.serialNumber || "") : ""}"/></div>
        <div class="field" style="grid-column:1/-1;"><label for="eqNotes">Notes</label>
          <textarea id="eqNotes" class="input" rows="2" maxlength="300" placeholder="Purchase date, maintenance notes…">${isEdit ? esc(eq.notes || "") : ""}</textarea></div>
      </div>
    </div>
    <div class="modalFt">
      <button class="btn closeX">Cancel</button>
      <button class="btn primary" id="btnEqSave">${isEdit ? "Save Changes" : "Add Equipment"}</button>
    </div>`);

  m.querySelector("#btnEqSave").addEventListener("click", () => {
    const nameEl = m.querySelector("#eqName");
    const name = nameEl.value.trim();
    if (!name) {
      nameEl.classList.add("invalid");
      nameEl.focus();
      return;
    }
    const item = {
      id: isEdit ? eq.id : uid(),
      name,
      serialNumber: m.querySelector("#eqSerial").value.trim(),
      notes: m.querySelector("#eqNotes").value.trim(),
      status: isEdit ? eq.status : "available",
      assignedTo: isEdit ? eq.assignedTo || null : null,
      jobId: isEdit ? eq.jobId || null : null,
      checkedOutAt: isEdit ? eq.checkedOutAt || null : null,
    };
    saveEquipment(item).then(() => {
      toast.success(isEdit ? "Equipment updated" : "Equipment added", name);
      modal.close();
      render();
    });
  });
}

function openCheckOutModal(eq) {
  const crewOpts = state.crew.length
    ? state.crew
        .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`)
        .join("")
    : `<option value="">No crew members</option>`;
  const jobOpts =
    state.jobs
      .filter((j) => !["Completed", "Invoiced"].includes(j.status))
      .map((j) => `<option value="${j.id}">${esc(j.name)}</option>`)
      .join("") || `<option value="">No active jobs</option>`;

  const m = modal.open(`
    <div class="modalHd">
      <div><h2>Check Out Equipment</h2><p>${esc(eq.name)}</p></div>
      <button class="closeX" aria-label="Close">&times;</button>
    </div>
    <div class="modalBd">
      <div class="fieldGrid">
        <div class="field"><label for="coMember">Assign To (Crew Member)</label>
          <select id="coMember" class="input"><option value="">— Unassigned —</option>${crewOpts}</select></div>
        <div class="field"><label for="coJob">Job</label>
          <select id="coJob" class="input"><option value="">— No job —</option>${jobOpts}</select></div>
      </div>
    </div>
    <div class="modalFt">
      <button class="btn closeX">Cancel</button>
      <button class="btn primary" id="btnCoSave">Check Out</button>
    </div>`);

  m.querySelector("#btnCoSave").addEventListener("click", () => {
    const assignedTo = m.querySelector("#coMember").value || null;
    const jobId = m.querySelector("#coJob").value || null;
    saveEquipment({
      ...eq,
      status: "checkedout",
      assignedTo,
      jobId,
      checkedOutAt: Date.now(),
    }).then(() => {
      toast.success("Equipment checked out", eq.name);
      modal.close();
      render();
    });
  });
}

/* ─── Inventory ──────────────────────────────── */
function renderInventory(root) {
  const lowItems = state.inventory.filter(
    (i) => (i.quantity || 0) <= (i.minStock || 0) && (i.quantity || 0) > 0,
  );
  const outItems = state.inventory.filter((i) => (i.quantity || 0) <= 0);
  const sorted = [...state.inventory].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const totalValue = sorted.reduce(
    (s, i) => s + (i.quantity || 0) * (i.unitCost || 0),
    0,
  );
  const sortedEq = [...state.equipment].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const checkedOut = sortedEq.filter((e) => e.status === "checkedout").length;

  const needsOrder = [...outItems, ...lowItems];

  root.innerHTML = `
      <div class="pageHeader">
        <h2 class="pageTitle">Material Inventory <span class="muted" style="font-size:14px;font-weight:400;">(${sorted.length} items)</span></h2>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <span class="muted" style="font-size:13px;">Stock value: <strong>${fmt(totalValue)}</strong></span>
          ${needsOrder.length ? `<button class="btn admin-only" id="btnGenPO" style="border-color:var(--warn);color:var(--warn);"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px" aria-hidden="true"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg>Generate PO (${needsOrder.length} items)</button>` : ""}
          <button class="btn primary admin-only" id="btnNInv">+ Add Item</button>
        </div>
      </div>
      ${
        outItems.length
          ? `<div class="alertBanner">🚫 ${outItems.length} item(s) out of stock: ${outItems
              .slice(0, 3)
              .map((i) => `<strong>${esc(i.name)}</strong>`)
              .join(", ")}</div>`
          : ""
      }
      ${
        lowItems.length
          ? `<div class="alertBanner" style="background:rgba(255,204,102,.12);border-color:rgba(255,204,102,.3);color:var(--warn);">⚠ ${lowItems.length} item(s) low on stock: ${lowItems
              .slice(0, 3)
              .map((i) => `<strong>${esc(i.name)}</strong>`)
              .join(", ")}</div>`
          : ""
      }
      ${
        sorted.length === 0
          ? `<div class="empty">No inventory items yet. Add your insulation materials.</div>`
          : `<div class="tableWrap"><table class="table">
            <thead><tr>
              <th>Item</th><th>Category</th>
              <th style="text-align:right;">Qty</th><th>Unit</th>
              <th style="text-align:right;">Min Stock</th>
              <th style="text-align:right;">Unit Cost</th>
              <th style="text-align:right;">Total Value</th>
              <th>Status</th><th>Actions</th>
            </tr></thead>
            <tbody>
              ${sorted
                .map((item) => {
                  const totalVal = (item.quantity || 0) * (item.unitCost || 0);
                  const status =
                    (item.quantity || 0) <= 0
                      ? "out"
                      : (item.quantity || 0) <= (item.minStock || 0)
                        ? "low"
                        : "instock";
                  const statusLabel =
                    status === "out"
                      ? "Out of Stock"
                      : status === "low"
                        ? "Low Stock"
                        : "In Stock";
                  return `<tr>
                  <td><strong>${esc(item.name)}</strong>${item.supplier ? `<br><span class="small muted">${esc(item.supplier)}</span>` : ""}</td>
                  <td>${esc(item.category || "—")}</td>
                  <td style="text-align:right;"><strong>${item.quantity ?? 0}</strong></td>
                  <td>${esc(item.unit || "")}</td>
                  <td style="text-align:right;">${item.minStock ?? 0}</td>
                  <td style="text-align:right;">${fmt(item.unitCost)}</td>
                  <td style="text-align:right;">${fmt(totalVal)}</td>
                  <td><span class="invBadge ${status}">${statusLabel}</span></td>
                  <td>
                    <div style="display:flex;gap:4px;">
                      <button class="btn admin-only" data-einv="${item.id}" style="padding:5px 9px;font-size:12px;">Edit</button>
                      <button class="btn danger admin-only" data-dinv="${item.id}" style="padding:5px 9px;font-size:12px;">Delete</button>
                    </div>
                  </td>
                </tr>`;
                })
                .join("")}
            </tbody>
          </table></div>`
      }

      <div class="pageHeader" style="margin-top:32px;">
        <h2 class="pageTitle">Tools &amp; Equipment <span class="muted" style="font-size:14px;font-weight:400;">(${sortedEq.length} items · ${checkedOut} checked out)</span></h2>
        <button class="btn primary admin-only" id="btnNEq">+ Add Equipment</button>
      </div>
      ${
        sortedEq.length === 0
          ? `<div class="empty">No equipment added yet. Track your expensive tools and machines here.</div>`
          : `<div class="tableWrap"><table class="table">
          <thead><tr>
            <th>Name</th><th>Serial #</th><th>Status</th>
            <th>Assigned To</th><th>Job</th><th>Notes</th><th>Actions</th>
          </tr></thead>
          <tbody>
            ${sortedEq
              .map((eq) => {
                const assignedMember = eq.assignedTo
                  ? state.crew.find((c) => c.id === eq.assignedTo)
                  : null;
                const assignedJob = eq.jobId
                  ? state.jobs.find((j) => j.id === eq.jobId)
                  : null;
                const isOut = eq.status === "checkedout";
                return `<tr>
                <td><strong>${esc(eq.name)}</strong></td>
                <td><span class="small muted">${esc(eq.serialNumber || "—")}</span></td>
                <td><span class="invBadge ${isOut ? "low" : "instock"}">${isOut ? "Checked Out" : "Available"}</span></td>
                <td>${assignedMember ? esc(assignedMember.name) : `<span class="muted">—</span>`}</td>
                <td>${assignedJob ? esc(assignedJob.name) : `<span class="muted">—</span>`}</td>
                <td><span class="small">${esc(eq.notes || "")}</span></td>
                <td>
                  <div style="display:flex;gap:4px;flex-wrap:wrap;">
                    ${
                      isOut
                        ? `<button class="btn primary admin-only" data-eqret="${eq.id}" style="padding:5px 9px;font-size:12px;">↩ Return</button>`
                        : `<button class="btn admin-only" data-eqout="${eq.id}" style="padding:5px 9px;font-size:12px;">↗ Check Out</button>`
                    }
                    <button class="btn admin-only" data-eeq="${eq.id}" style="padding:5px 9px;font-size:12px;">Edit</button>
                    <button class="btn danger admin-only" data-deq="${eq.id}" style="padding:5px 9px;font-size:12px;">Delete</button>
                  </div>
                </td>
              </tr>`;
              })
              .join("")}
          </tbody>
        </table></div>`
      }`;

  root
    .querySelector("#btnNInv")
    ?.addEventListener("click", () => openInventoryModal(null));
  root.querySelectorAll("[data-einv]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const item = state.inventory.find((x) => x.id === btn.dataset.einv);
      if (item) openInventoryModal(item);
    }),
  );
  root.querySelectorAll("[data-dinv]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const item = state.inventory.find((x) => x.id === btn.dataset.dinv);
      if (!item) return;
      if (demoBlock()) return;
      confirm("Delete Item", item.name, "Delete", () => {
        idb.del(APP.stores.inventory, item.id).then(() => {
          state.inventory = state.inventory.filter((x) => x.id !== item.id);
          toast.warn("Item deleted", item.name);
          render();
        });
      });
    }),
  );

  root
    .querySelector("#btnGenPO")
    ?.addEventListener("click", () => exportPO_PDF(needsOrder));
  root
    .querySelector("#btnNEq")
    ?.addEventListener("click", () => openEquipmentModal(null));
  root.querySelectorAll("[data-eeq]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const eq = state.equipment.find((x) => x.id === btn.dataset.eeq);
      if (eq) openEquipmentModal(eq);
    }),
  );
  root.querySelectorAll("[data-deq]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const eq = state.equipment.find((x) => x.id === btn.dataset.deq);
      if (!eq) return;
      if (demoBlock()) return;
      confirm("Delete Equipment", eq.name, "Delete", () => {
        idb.del(APP.stores.equipment, eq.id).then(() => {
          state.equipment = state.equipment.filter((x) => x.id !== eq.id);
          toast.warn("Equipment deleted", eq.name);
          render();
        });
      });
    }),
  );
  root.querySelectorAll("[data-eqout]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const eq = state.equipment.find((x) => x.id === btn.dataset.eqout);
      if (eq) openCheckOutModal(eq);
    }),
  );
  root.querySelectorAll("[data-eqret]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const eq = state.equipment.find((x) => x.id === btn.dataset.eqret);
      if (!eq) return;
      saveEquipment({
        ...eq,
        status: "available",
        assignedTo: null,
        jobId: null,
        checkedOutAt: null,
      }).then(() => {
        toast.success("Equipment returned", eq.name);
        render();
      });
    }),
  );
}

function openInventoryModal(item) {
  const isEdit = !!item;
  const CATS = [
    "Blown-in Fiberglass",
    "Blown-in Cellulose",
    "Spray Foam",
    "Batt Insulation",
    "Radiant Barrier",
    "Equipment",
    "Accessories",
    "Other",
  ];
  const UNITS = ["bags", "rolls", "sets", "board-ft", "each", "lbs", "sq ft"];
  const m = modal.open(`
      <div class="modalHd">
        <div><h2>${isEdit ? "Edit Inventory Item" : "Add Inventory Item"}</h2>
          <p>${isEdit ? esc(item.name) : "Track your insulation materials."}</p></div>
        <button type="button" class="closeX" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modalBd">
        <div class="fieldGrid">
          <div class="field" style="grid-column:1/-1;"><label for="invN">Item Name *</label>
            <input id="invN" class="input" type="text" maxlength="120" placeholder="e.g. Owens Corning Blown-in Bags" value="${isEdit ? esc(item.name) : ""}"/></div>
          <div class="field"><label for="invCat">Category</label>
            <select id="invCat">
              ${CATS.map((c) => `<option value="${c}" ${isEdit && item.category === c ? "selected" : ""}>${c}</option>`).join("")}
            </select></div>
          <div class="field"><label for="invUnit">Unit</label>
            <select id="invUnit">
              ${UNITS.map((u) => `<option value="${u}" ${isEdit && item.unit === u ? "selected" : ""}>${u}</option>`).join("")}
            </select></div>
          <div class="field"><label for="invQty">Quantity on Hand</label>
            <input id="invQty" class="input" type="number" min="0" step="1" placeholder="0" value="${isEdit ? (item.quantity ?? 0) : 0}"/></div>
          <div class="field"><label for="invMin">Min Stock Level <span class="muted">(alert threshold)</span></label>
            <input id="invMin" class="input" type="number" min="0" step="1" placeholder="5" value="${isEdit ? (item.minStock ?? 5) : 5}"/></div>
          <div class="field"><label for="invCost">Unit Cost ($)</label>
            <input id="invCost" class="input" type="number" min="0" step="0.01" placeholder="0.00" value="${isEdit ? item.unitCost || "" : ""}"/></div>
          <div class="field"><label for="invSup">Supplier</label>
            <input id="invSup" class="input" type="text" maxlength="120" placeholder="e.g. Home Depot" value="${isEdit ? esc(item.supplier || "") : ""}"/></div>
          <div class="field" style="grid-column:1/-1;"><label for="invNotes">Notes</label>
            <textarea id="invNotes" placeholder="SKU, storage location, etc.">${isEdit ? esc(item.notes || "") : ""}</textarea></div>
        </div>
      </div>
      <div class="modalFt">
        <button type="button" class="btn" id="invCancel">Cancel</button>
        <button type="button" class="btn primary" id="invSave">${isEdit ? "Save Changes" : "Add Item"}</button>
      </div>`);

  m.querySelector("#invCancel").addEventListener("click", modal.close);
  m.querySelector("#invSave").addEventListener("click", () => {
    const nEl = m.querySelector("#invN");
    if (!nEl.value.trim()) {
      nEl.classList.add("invalid");
      nEl.focus();
      return;
    }
    nEl.classList.remove("invalid");
    const saved = {
      id: isEdit ? item.id : uid(),
      name: nEl.value.trim(),
      category: m.querySelector("#invCat").value,
      unit: m.querySelector("#invUnit").value,
      quantity: parseFloat(m.querySelector("#invQty").value) || 0,
      minStock: parseFloat(m.querySelector("#invMin").value) || 0,
      unitCost: parseFloat(m.querySelector("#invCost").value) || 0,
      supplier: m.querySelector("#invSup").value.trim(),
      notes: m.querySelector("#invNotes").value.trim(),
      date: isEdit ? item.date : Date.now(),
    };
    saveInventoryItem(saved)
      .then(() => {
        toast.success(isEdit ? "Item updated" : "Item added", saved.name);
        modal.close();
        render();
      })
      .catch(() => toast.error("Save error", "Could not save item."));
  });
}

/* ─── Kanban Pipeline ────────────────────────── */
function renderKanban(root) {
  const COLS = [
    { status: "Lead", color: "#7f8aa3", label: "Leads" },
    { status: "Quoted", color: "#bb86fc", label: "Quoted" },
    { status: "Draft", color: "#aab5cc", label: "Draft" },
    { status: "Active", color: "#7aa2ff", label: "Active" },
    { status: "Completed", color: "#4be3a3", label: "Completed" },
    { status: "Invoiced", color: "#ffcc66", label: "Invoiced" },
  ];

  const byStatus = {};
  COLS.forEach((c) => {
    byStatus[c.status] = [];
  });
  state.jobs.forEach((j) => {
    if (byStatus[j.status]) byStatus[j.status].push(j);
  });

  const now = Date.now();

  root.innerHTML = `
      <div class="pageHeader">
        <h2 class="pageTitle">Job Pipeline</h2>
        <span class="muted" style="font-size:12px;align-self:center;">Drag cards between columns to move</span>
        <button class="btn primary admin-only" id="btnKNJ">+ New Job</button>
      </div>
      <div class="kanbanBoard">
        ${COLS.map((col) => {
          const jobs = byStatus[col.status] || [];
          const colVal = jobs.reduce((s, j) => s + (j.value || 0), 0);
          return `
          <div class="kanbanCol" data-kdrop="${col.status}">
            <div class="kanbanColHd" style="border-top:3px solid ${col.color};">
              <span style="color:${col.color};">${col.label}</span>
              <span class="kanbanCount">${jobs.length}</span>
              ${colVal > 0 ? `<span class="kanbanTotal">${fmt(colVal)}</span>` : ""}
            </div>
            <div class="kanbanCards" data-kdrop="${col.status}">
              ${
                jobs.length === 0
                  ? `<div class="kanbanEmpty">Drop here</div>`
                  : jobs
                      .map((j) => {
                        const tc = jobCost(j);
                        const marginPct =
                          j.value > 0 ? ((j.value - tc) / j.value) * 100 : 0;
                        const minMargin = state.settings.minMargin ?? 30;
                        const isLowMargin =
                          j.value > 0 &&
                          marginPct < minMargin &&
                          !["Lead", "Draft"].includes(j.status);
                        const overdue =
                          j.deadline &&
                          j.deadline < now &&
                          !["Completed", "Invoiced"].includes(j.status);
                        return `
                    <div class="kanbanCard${isLowMargin ? " low-margin" : ""}" draggable="true" data-kd="${j.id}" data-kdetail="${j.id}">
                      <div class="kanbanCardTitle">${esc(j.name)}${isLowMargin ? ` <span class="lowMarginBadge" title="Margin ${marginPct.toFixed(1)}% — below ${minMargin}% target">⚠</span>` : ""}</div>
                      <div class="kanbanCardMeta">
                        ${j.client ? `<span>${esc(j.client)}</span>` : ""}
                        ${j.insulationType ? `<span>${esc(j.insulationType)}</span>` : ""}
                        ${j.sqft ? `<span>${j.sqft} sq ft</span>` : ""}
                        ${j.deadline ? `<span class="${overdue ? "deadlineWarn" : ""}">📅 ${fmtDate(j.deadline)}${overdue ? " ⚠" : ""}</span>` : ""}
                      </div>
                      <div class="kanbanCardVal">${fmt(j.value)}</div>
                    </div>`;
                      })
                      .join("")
              }
            </div>
          </div>`;
        }).join("")}
      </div>`;

  root
    .querySelector("#btnKNJ")
    ?.addEventListener("click", () => openJobModal(null));

  /* ── Click to open detail ── */
  root.querySelectorAll("[data-kdetail]").forEach((el) =>
    el.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      const j = state.jobs.find((x) => x.id === el.dataset.kdetail);
      if (j) openJobDetailModal(j);
    }),
  );

  /* ── Drag & Drop ── */
  let dragId = null;

  root.querySelectorAll(".kanbanCard[draggable]").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      dragId = card.dataset.kd;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragId);
      setTimeout(() => card.classList.add("kanbanCard--dragging"), 0);
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("kanbanCard--dragging");
      root
        .querySelectorAll(".kanbanCards")
        .forEach((z) => z.classList.remove("kanbanDrop--over"));
      dragId = null;
    });
  });

  root.querySelectorAll(".kanbanCards[data-kdrop]").forEach((zone) => {
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      zone.classList.add("kanbanDrop--over");
    });
    zone.addEventListener("dragleave", (e) => {
      /* only remove if leaving the zone itself, not a child */
      if (!zone.contains(e.relatedTarget))
        zone.classList.remove("kanbanDrop--over");
    });
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("kanbanDrop--over");
      const id = e.dataTransfer.getData("text/plain") || dragId;
      const newStatus = zone.dataset.kdrop;
      if (!id || !newStatus) return;
      const j = state.jobs.find((x) => x.id === id);
      if (!j || j.status === newStatus) return;
      const updated = {
        ...j,
        status: newStatus,
        statusHistory: [
          ...(j.statusHistory || []),
          { status: newStatus, date: Date.now() },
        ],
        invoiceNumber:
          newStatus === "Invoiced" && !j.invoiceNumber
            ? getNextInvoiceNumber()
            : j.invoiceNumber,
        paymentStatus:
          newStatus === "Invoiced" && !j.paymentStatus
            ? "Unpaid"
            : j.paymentStatus || "Unpaid",
      };
      saveJob(updated).then(() => {
        toast.success("Moved", `${j.name} → ${newStatus}`);
        render();
      });
    });
  });
}

/* ─── Calendar ──────────────────────────────────────── */
function renderCalendar(root) {
  if (typeof renderCalendar._offset === "undefined") renderCalendar._offset = 0;
  const offset = renderCalendar._offset;

  const today = new Date();
  const viewDate = new Date(today.getFullYear(), today.getMonth() + offset, 1);
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const monthName = viewDate.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  function jobsForDay(day) {
    const dayStart = new Date(year, month, day).getTime();
    const dayEnd = new Date(year, month, day, 23, 59, 59, 999).getTime();
    return state.jobs.filter((j) => {
      const d = j.date || 0;
      const dl = j.deadline || 0;
      return (d >= dayStart && d <= dayEnd) || (dl >= dayStart && dl <= dayEnd);
    });
  }

  const statusColor = {
    active: "var(--primary)",
    completed: "var(--ok)",
    invoiced: "var(--purple, #a78bfa)",
    draft: "var(--faint)",
    lead: "var(--warn)",
    quoted: "var(--warn)",
  };

  let cells = "";

  for (let i = 0; i < firstDay; i++) {
    cells += `<div class="calCell calCell--empty"></div>`;
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const jobs = jobsForDay(d);
    const isToday = offset === 0 && d === today.getDate();
    const dateTs = new Date(year, month, d).getTime();
    const hasOverdue = jobs.some(
      (j) =>
        j.deadline &&
        j.deadline <= dateTs &&
        !["Completed", "Invoiced"].includes(j.status),
    );

    cells += `
      <div class="calCell${isToday ? " calCell--today" : ""}${hasOverdue ? " calCell--overdue" : ""}">
        <div class="calDay${isToday ? " calDay--today" : ""}">${d}</div>
        <div class="calJobs">
          ${jobs
            .slice(0, 3)
            .map((j) => {
              const isDeadline =
                j.deadline &&
                (() => {
                  const dl = new Date(j.deadline);
                  return (
                    dl.getFullYear() === year &&
                    dl.getMonth() === month &&
                    dl.getDate() === d
                  );
                })();
              return `
              <div class="calJob" data-caldetail="${j.id}"
                style="border-left:3px solid ${statusColor[(j.status || "").toLowerCase()] || "var(--muted)"};"
                title="${esc(j.name)}${isDeadline ? " (deadline)" : ""}">
                ${isDeadline ? '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--danger);margin-right:4px;vertical-align:2px;flex-shrink:0;" aria-hidden="true"></span>' : ""}${esc(j.name.length > 18 ? j.name.slice(0, 17) + "…" : j.name)}
              </div>`;
            })
            .join("")}
          ${jobs.length > 3 ? `<div class="calMore">+${jobs.length - 3} more</div>` : ""}
        </div>
      </div>`;
  }

  root.innerHTML = `
    <div class="calWrap">
      <div class="calHeader">
        <button class="btn" id="calPrev" aria-label="Previous month">
          <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
            <path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <h2 class="calTitle">${monthName}</h2>
        <button class="btn" id="calNext" aria-label="Next month">
          <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
            <path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="btn" id="calToday" style="margin-left:8px;">Today</button>
      </div>
      <div class="calDayLabels">
        ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
          .map((d) => `<div class="calDayLabel">${d}</div>`)
          .join("")}
      </div>
      <div class="calGrid">${cells}</div>
      <div class="calLegend">
        ${Object.entries({
          Active: "var(--primary)",
          Completed: "var(--ok)",
          Invoiced: "var(--purple,#a78bfa)",
          Draft: "var(--faint)",
          Lead: "var(--warn)",
        })
          .map(
            ([label, color]) => `
            <span class="calLegendItem">
              <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};margin-right:4px;vertical-align:middle;"></span>
              ${label}
            </span>`,
          )
          .join("")}
        <span class="calLegendItem"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--danger);margin-right:4px;" aria-hidden="true"></span>Deadline</span>
      </div>
    </div>`;

  root.querySelector("#calPrev").addEventListener("click", () => {
    renderCalendar._offset--;
    renderCalendar(root);
  });
  root.querySelector("#calNext").addEventListener("click", () => {
    renderCalendar._offset++;
    renderCalendar(root);
  });
  root.querySelector("#calToday").addEventListener("click", () => {
    renderCalendar._offset = 0;
    renderCalendar(root);
  });

  root.querySelectorAll("[data-caldetail]").forEach((el) => {
    el.addEventListener("click", () => {
      const j = state.jobs.find((x) => x.id === el.dataset.caldetail);
      if (j) openJobDetailModal(j);
    });
  });
}

/* ─── Auth Gate (Sign In + Sign Up) ─────────────────────── */
function initAuth() {
  /* QA Fix #1: prevent double init() on Firebase token refresh */
  let appStarted = false;

  const overlay = document.createElement("div");
  overlay.id = "authOverlay";
  overlay.innerHTML = `
    <div class="authCard">
      <div class="authBrand">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none">
          <path d="M4 7.5C4 6.12 5.12 5 6.5 5h11C18.88 5 20 6.12 20 7.5v9c0 1.38-1.12 2.5-2.5 2.5h-11C5.12 19 4 17.88 4 16.5v-9Z"
            stroke="#7aa2ff" stroke-width="1.6"/>
          <path d="M7 9h10M7 12h6M7 15h8" stroke="#7aa2ff" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
        <div>
          <div class="authBrandName">JobCost Pro</div>
          <div class="authBrandSub">Professional Field Management</div>
        </div>
      </div>

      <!-- Tab toggle: Sign In / Create Account -->
      <div class="authTabRow" role="tablist">
        <button class="authTab authTab--active" id="authTabIn" type="button" role="tab" aria-selected="true">Sign In</button>
        <button class="authTab" id="authTabUp" type="button" role="tab" aria-selected="false">Create Account</button>
      </div>

      <div id="authError" class="authError" hidden></div>

      <div class="authFields">
        <div class="authFieldWrap">
          <label class="authLabel">Email</label>
          <input id="authEmail" class="authInput" type="email" placeholder="you@company.com" autocomplete="email"/>
        </div>
        <div class="authFieldWrap">
          <label class="authLabel">Password</label>
          <input id="authPassword" class="authInput" type="password" placeholder="••••••••" autocomplete="current-password"/>
          <p class="authHint" id="authPassHint" hidden>Must be at least 6 characters</p>
          <div style="text-align:right;margin-top:4px;">
            <button type="button" id="authForgotBtn" style="background:none;border:none;color:var(--primary);font-size:12px;cursor:pointer;padding:0;">Forgot password?</button>
          </div>
        </div>
        <div class="authFieldWrap" id="authConfirmWrap" style="display:none;">
          <label class="authLabel">Confirm Password</label>
          <input id="authConfirm" class="authInput" type="password" placeholder="••••••••" autocomplete="new-password"/>
        </div>
      </div>

      <button id="authSubmit" class="authBtn" type="button">
        <span id="authBtnLabel">LOGIN / ACCESS SYSTEM</span>
        <span id="authBtnSpinner" class="authSpinner" hidden></span>
      </button>

      <div class="authDivider"><span>OR</span></div>

      <div class="authSocialSingle">
        <button id="authGoogleBtn" class="authSocialBtn authGoogleBtn authGoogleBtn--full" type="button">
          <svg width="18" height="18" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
          </svg>
          Continue with Google
        </button>
      </div>
      <p style="font-size:11px;color:var(--faint);text-align:center;margin-top:16px;line-height:1.7;">
        By continuing, you agree to our
        <a href="https://jobcostpro.com/terms" target="_blank" rel="noopener" style="color:var(--primary);">Terms of Use</a>
        and
        <a href="https://jobcostpro.com/privacy" target="_blank" rel="noopener" style="color:var(--primary);">Privacy Policy</a>.
      </p>
    </div>`;
  document.body.appendChild(overlay);

  /* Prevent keyboard navigation to app content while auth overlay is shown */
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Sign in to JobCost Pro");
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") e.preventDefault();
  });

  /* ── DOM refs ── */
  const emailEl = overlay.querySelector("#authEmail");
  const passEl = overlay.querySelector("#authPassword");
  const confirmEl = overlay.querySelector("#authConfirm");
  const confirmWrap = overlay.querySelector("#authConfirmWrap");
  const passHint = overlay.querySelector("#authPassHint");
  const submitBtn = overlay.querySelector("#authSubmit");
  const labelEl = overlay.querySelector("#authBtnLabel");
  const spinnerEl = overlay.querySelector("#authBtnSpinner");
  const errorEl = overlay.querySelector("#authError");
  const tabIn = overlay.querySelector("#authTabIn");
  const tabUp = overlay.querySelector("#authTabUp");

  function showError(msg) {
    errorEl.style.color = "";
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }
  function clearError() {
    errorEl.hidden = true;
    errorEl.style.color = "";
    errorEl.textContent = "";
  }
  function setLoading(on) {
    submitBtn.disabled = on;
    labelEl.hidden = on;
    spinnerEl.hidden = !on;
  }

  let isRegister = false;

  function switchTab(toRegister) {
    isRegister = toRegister;
    clearError();
    emailEl.value = passEl.value = confirmEl.value = "";
    tabIn.classList.toggle("authTab--active", !isRegister);
    tabUp.classList.toggle("authTab--active", isRegister);
    tabIn.setAttribute("aria-selected", String(!isRegister));
    tabUp.setAttribute("aria-selected", String(isRegister));
    labelEl.textContent = isRegister
      ? "CREATE ACCOUNT"
      : "LOGIN / ACCESS SYSTEM";
    passEl.autocomplete = isRegister ? "new-password" : "current-password";
    confirmWrap.style.display = isRegister ? "flex" : "none";
    passHint.style.display = isRegister ? "block" : "none";
  }

  tabIn.addEventListener("click", () => switchTab(false));
  tabUp.addEventListener("click", () => switchTab(true));

  overlay
    .querySelector("#authForgotBtn")
    .addEventListener("click", async () => {
      const email = emailEl.value.trim();
      if (!email) {
        showError("Enter your email address first.");
        return;
      }
      try {
        await sendPasswordResetEmail(auth, email);
        errorEl.style.color = "var(--ok)";
        errorEl.textContent = "Password reset email sent — check your inbox.";
        errorEl.hidden = false;
        submitBtn.disabled = false;
      } catch (err) {
        showError(getFriendlyError(err));
      }
    });

  /* ── Error code map ── */
  const AUTH_ERRORS = {
    "auth/user-not-found":         "No account found with this email.",
    "auth/wrong-password":         "Incorrect password. Try again.",
    "auth/invalid-credential":     "Incorrect email or password.",
    "auth/email-already-in-use":   "An account with this email already exists. Sign in instead.",
    "auth/weak-password":          "Password must be at least 6 characters.",
    "auth/invalid-email":          "Please enter a valid email address.",
    "auth/too-many-requests":      "Too many attempts — please wait before trying again.",
    "auth/network-request-failed": "Network error. Check your connection and try again.",
    "auth/user-disabled":          "This account has been disabled. Contact support.",
    "auth/operation-not-allowed":  "This sign-in method is not enabled.",
    "auth/popup-closed-by-user":   "Sign-in cancelled.",
    "auth/cancelled-popup-request":"Sign-in cancelled.",
    "auth/internal-error":         "An error occurred. Please try again.",
    "auth/unauthorized-domain":    "This domain is not authorized. Contact support.",
    "auth/account-exists-with-different-credential": "An account already exists with a different sign-in method.",
  };

  function getFriendlyError(err) {
    if (AUTH_ERRORS[err.code]) return AUTH_ERRORS[err.code];
    if (err.code?.startsWith("auth/")) return "Authentication error. Please try again.";
    return "Something went wrong. Please try again.";
  }

  /* ── Client-side rate limit ── */
  let authAttempts = 0;
  let authCooldownTimer = null;

  function checkRateLimit() {
    authAttempts++;
    if (authAttempts >= 5) {
      submitBtn.disabled = true;
      let secs = 30;
      showError(`Too many attempts. Please wait ${secs} seconds.`);
      authCooldownTimer = setInterval(() => {
        secs--;
        if (secs <= 0) {
          clearInterval(authCooldownTimer);
          authAttempts = 0;
          submitBtn.disabled = false;
          clearError();
        } else {
          showError(`Too many attempts. Please wait ${secs} seconds.`);
        }
      }, 1000);
      return false;
    }
    return true;
  }

  submitBtn.addEventListener("click", async () => {
    if (!checkRateLimit()) return;
    clearError();
    const email = emailEl.value.trim();
    const password = passEl.value;

    /* Client-side validation */
    if (!email) {
      showError("Email is required.");
      emailEl.focus();
      return;
    }
    if (!password) {
      showError("Password is required.");
      passEl.focus();
      return;
    }
    if (isRegister && password.length < 6) {
      showError("Password must be at least 6 characters.");
      passEl.focus();
      return;
    }
    if (isRegister && confirmEl.value !== password) {
      showError("Passwords do not match.");
      confirmEl.focus();
      return;
    }

    setLoading(true);
    const authTimeout = setTimeout(() => {
      setLoading(false);
      showError("Request timed out. Check your connection and try again.");
    }, 15000);

    try {
      if (isRegister) {
        await createUserWithEmailAndPassword(auth, email, password);
        clearTimeout(authTimeout);
        showToast("Account created! Welcome to JobCost Pro.", "success");
        /* onAuthStateChanged handles overlay hide + init() */
      } else {
        await signInWithEmailAndPassword(auth, email, password);
        clearTimeout(authTimeout);
      }
    } catch (err) {
      clearTimeout(authTimeout);
      const msg = getFriendlyError(err);
      showError(msg);
      showToast(msg, "error");
      setLoading(false);
      passEl.value = "";
      if (isRegister) confirmEl.value = "";
      passEl.focus();
    }
  });

  /* ── Social sign-in (redirect) ── */
  function socialSignIn(btn, providerFn, providerName) {
    btn?.addEventListener("click", async () => {
      clearError();
      btn.disabled = true;
      btn.style.opacity = "0.7";
      showToast(`Redirecting to ${providerName}…`, "info");
      try {
        await providerFn();
      } catch (err) {
        showError(getFriendlyError(err));
        showToast(getFriendlyError(err), "error");
        btn.disabled = false;
        btn.style.opacity = "";
      }
    });
  }

  socialSignIn(
    overlay.querySelector("#authGoogleBtn"),
    signInWithGoogle,
    "Google",
  );

  /* ── Keyboard submit ── */
  [emailEl, passEl, confirmEl].forEach((el) =>
    el?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitBtn.click();
    }),
  );

  /* ── Redirect result error handler ── */
  handleRedirectResult().catch((err) => {
    if (!err?.code) return;
    const msg =
      err.code === "auth/unauthorized-domain"
        ? `Domain "${location.hostname}" is not authorized in Firebase Console → Auth → Authorized Domains.`
        : err.message || "Sign-in redirect failed.";
    console.error("[Auth redirect]", err.code, msg);
    showError(msg);
  });

  /* ── Auth state ── */
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      overlay.style.display = "none";
      if (!appStarted) {
        document.body.insertAdjacentHTML(
          "beforeend",
          `
          <div id="subCheckLoader" style="
            position:fixed;inset:0;z-index:9998;
            display:flex;flex-direction:column;align-items:center;justify-content:center;
            background:var(--bg);gap:16px;">
            <div class="spinner"></div>
            <span style="color:var(--muted);font-size:14px;">Verifying subscription…</span>
          </div>`,
        );

        const isSubscribed = await checkSubscription(user.uid);
        document.getElementById("subCheckLoader")?.remove();

        if (isSubscribed) {
          appStarted = true;
          init();
        } else {
          showSubscriptionWall(() => {
            appStarted = true;
            init();
          });
        }
      }
    } else {
      overlay.style.display = "flex";
      document.getElementById("subscriptionWall")?.remove();
      document.getElementById("subCheckLoader")?.remove();
      setLoading(false);
    }
  });
}

initAuth();
