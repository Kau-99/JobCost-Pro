import { APP, T, ATTIC_CALC, ATTIC_DEFAULT_BAG_COST, ATTIC_DEFAULT_LABOR_RATE } from "./config.js";
import {
  $,
  $$,
  uid,
  esc,
  fmt,
  fmtDate,
  fmtDateInput,
  parseDate,
  jobCost,
  fmtDuration,
  ls,
} from "./utils.js";
import { createIDB } from "./db.js";

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
})()

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
  }).load(),
  mileageLogs: [],
  equipment: [],
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

    if (!SR) {
      btn.disabled = true;
      btn.classList.add("voiceMicBtn--disabled");
      const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
      btn.title = isIOS
        ? "Voice input not supported on iOS Safari. Use Chrome on Android."
        : location.protocol !== "https:" && location.hostname !== "localhost"
          ? "Voice input requires HTTPS. Host the app on a secure URL."
          : "Voice input not supported in this browser.";
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
      recognition.lang = state.settings.language === "es"
        ? "es-ES"
        : navigator.language || "en-US";
      recognition.interimResults = false;
      recognition.continuous = false;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        listening = true;
        btn.classList.add("voiceMicBtn--active");
        btn.title = "Click to stop";
        ta.placeholder = "Listening… Speak slowly";
      };

      recognition.onresult = (ev) => {
        const transcript = ev.results[0]?.[0]?.transcript ?? "";
        if (transcript) {
          ta.value = ta.value
            ? ta.value.trimEnd() + " " + transcript
            : transcript;
          ta.dispatchEvent(new Event("input", { bubbles: true }));
        }
      };

      recognition.onerror = (ev) => {
        if (ev.error === "not-allowed") {
          toast.warn("Microphone blocked", "Allow microphone access in your browser settings.");
        } else if (ev.error !== "aborted" && ev.error !== "no-speech") {
          toast.warn("Voice error", ev.error);
        }
      };

      recognition.onend = () => {
        listening = false;
        btn.classList.remove("voiceMicBtn--active");
        btn.title = "Speak to type";
        ta.placeholder = origPlaceholder;
        recognition = null;
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
    el.querySelector(".btn").addEventListener("click", () => { kill(); onBtn(); });
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

/* ─── Boot ───────────────────────────────────── */
async function init() {
  document.body.setAttribute("data-role", state.settings.role);
  applyTheme(state.settings.theme);
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
  } catch (e) {
    console.error(e);
    toast.error("Database error", "Failed to load local data.");
    if (wrap)
      wrap.innerHTML = `<div class="empty">Failed to load. Please reload the page.</div>`;
  }
}

function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("sw.js").then((reg) => {
    /* Listen for a new SW found after the page is already controlled */
    reg.addEventListener("updatefound", () => {
      const newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener("statechange", () => {
        if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
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
  }).catch((err) => {
    console.warn("[SW] Registration failed — offline support unavailable.", err);
  });

  /* Reload once the new SW takes control */
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!refreshing) { refreshing = true; window.location.reload(); }
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

function bindUI() {
  /* Nav */
  $$(".navItem").forEach((btn) =>
    btn.addEventListener("click", () => routeTo(btn.dataset.route)),
  );

  /* Theme */
  $("#btnTheme")?.addEventListener("click", () => {
    state.settings.theme = state.settings.theme === "dark" ? "light" : "dark";
    ls(APP.lsKey).save(state.settings);
    applyTheme(state.settings.theme);
  });

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
  $("#btnNewJob")?.addEventListener("click", () => openJobModal(null));
  $("#btnNewTemplate")?.addEventListener("click", () =>
    openTemplateModal(null),
  );
  $("#btnExportAll")?.addEventListener("click", doExport);

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
  render();
}

function render() {
  const wrap = $("#appContent");
  if (!wrap) return;
  wrap.innerHTML = "";
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
  };
  (views[state.route] || renderDashboard)(wrap);
}

/* ─── Export JSON backup ─────────────────────── */
function doExport() {
  const data = {
    jobs: state.jobs,
    timeLogs: state.timeLogs,
    templates: state.templates,
    estimates: state.estimates,
    crew: state.crew,
    inventory: state.inventory,
    mileageLogs: state.mileageLogs,
    equipment: state.equipment,
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
    `${state.jobs.length} jobs · ${state.templates.length} templates.`,
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
        <p class="small muted" style="text-align:center;max-width:280px;">Field worker scans this to open the app and clock into <strong>${esc(job.name)}</strong> directly.</p>
        <button class="btn" id="btnCopyQR">Copy Link</button>
      </div>
      <div class="modalFt"><button class="btn" id="bjQRClose">Close</button></div>`);
  setTimeout(() => {
    const canvas = document.getElementById("qrCanvas");
    if (canvas && window.QRCode) {
      QRCode.toCanvas(canvas, url, { width: 220, margin: 2 }, () => {});
    }
  }, 60);
  m.querySelector("#btnCopyQR").addEventListener("click", () => {
    navigator.clipboard
      ?.writeText(url)
      .then(() => toast.info("Copied", "Clock-in link copied."));
  });
  m.querySelector("#bjQRClose").addEventListener("click", modal.close);
}

/* ─── QR Code Job Share ──────────────────────── */
function showJobShareQR(job) {
  /* Slim payload — no photos/timeLogs to stay within QR capacity (~2KB) */
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
      d: c.description, q: c.qty, u: c.unitCost, cat: c.category,
    })),
  };
  const payload = JSON.stringify(slim);

  const m = modal.open(`
    <div class="modalHd">
      <div><h2>Share Job via QR</h2><p>${esc(job.name)}</p></div>
      <button type="button" class="closeX" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="modalBd" style="display:flex;flex-direction:column;align-items:center;gap:14px;padding:24px 16px;">
      <canvas id="shareQRCanvas"></canvas>
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
    if (!canvas) return;
    if (!window.QRCode) {
      canvas.parentElement.innerHTML = `<p class="small muted">QR library not loaded yet. Try again in a moment.</p>`;
      return;
    }
    QRCode.toCanvas(canvas, payload, { width: 240, margin: 2, errorCorrectionLevel: "M" }, (err) => {
      if (err) canvas.parentElement.insertAdjacentHTML("beforeend",
        `<p class="small" style="color:var(--danger)">Job too large for QR (try reducing costs/notes).</p>`);
    });
  }, 60);

  m.querySelector("#btnDlShareQR")?.addEventListener("click", () => {
    const canvas = document.getElementById("shareQRCanvas");
    if (!canvas) return;
    const a = document.createElement("a");
    a.download = `job_${job.name.replace(/[^a-z0-9]/gi, "_").slice(0, 30)}_QR.png`;
    a.href = canvas.toDataURL("image/png");
    a.click();
  });
}

/* ─── QR Scanner ─────────────────────────────── */
function openQRScanner() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast.warn("Camera unavailable", "Camera access requires HTTPS and a supported browser.");
    return;
  }

  let stream = null;
  let rafId = null;
  const stopScan = () => {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  };

  const m = modal.open(`
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
    stopScan);

  let useBarcodeDetector = false;
  let detector = null;

  const statusEl = () => document.getElementById("qrScanStatus");
  const video = document.getElementById("qrVideo");
  const scanCanvas = document.getElementById("qrScanCanvas");

  const handlePayload = (data) => {
    stopScan();
    try {
      const obj = JSON.parse(data);
      if (obj._v !== 1 || !obj.id || !obj.name) {
        toast.error("Invalid QR", "This QR code is not a JobCost Pro job.");
        modal.close();
        return;
      }
      /* Expand slim payload back to full job shape */
      const imported = {
        id: obj.id,
        name: obj.name,
        client: obj.client || "",
        status: obj.status || "Lead",
        value: obj.value || 0,
        date: obj.date || Date.now(),
        zip: obj.zip || "",
        city: obj.city || "",
        state: obj.state || "",
        notes: obj.notes || "",
        tags: obj.tags || [],
        costs: (obj.costs || []).map((c) => ({
          id: uid(), description: c.d, qty: c.q, unitCost: c.u, category: c.cat,
        })),
        photos: [],
        crewIds: [],
        paymentStatus: "Unpaid",
        paidDate: null,
        invoiceNumber: null,
        _importedViaQR: true,
      };
      const existing = state.jobs.find((j) => j.id === imported.id);
      if (existing) {
        toast.info("Already exists", `"${imported.name}" is already in your jobs.`);
        modal.close();
        return;
      }
      saveJob(imported).then(() => {
        toast.success("Job imported!", imported.name);
        modal.close();
        render();
      });
    } catch {
      toast.error("Scan error", "Could not parse QR data.");
      modal.close();
    }
  };

  /* ── BarcodeDetector (native, Chrome/Android) ── */
  if ("BarcodeDetector" in window) {
    useBarcodeDetector = true;
    detector = new BarcodeDetector({ formats: ["qr_code"] });
  }

  navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
    .then((s) => {
      stream = s;
      video.srcObject = s;
      const st = statusEl();
      if (st) st.textContent = useBarcodeDetector ? "Scanning…" : "Scanning… (jsQR)";

      const tick = async () => {
        if (!video.videoWidth) { rafId = requestAnimationFrame(tick); return; }
        scanCanvas.width = video.videoWidth;
        scanCanvas.height = video.videoHeight;
        const ctx = scanCanvas.getContext("2d");
        ctx.drawImage(video, 0, 0);

        try {
          if (useBarcodeDetector) {
            const results = await detector.detect(video);
            if (results.length) { handlePayload(results[0].rawValue); return; }
          } else if (window.jsQR) {
            const img = ctx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
            if (code) { handlePayload(code.data); return; }
          }
        } catch (err) {
          console.warn("[QR] Scan frame error:", err);
        }
        rafId = requestAnimationFrame(tick);
      };
      video.onloadedmetadata = () => { rafId = requestAnimationFrame(tick); };
    })
    .catch(() => {
      const st = statusEl();
      if (st) st.textContent = "Camera access denied. Allow camera and try again.";
      if (st) st.style.color = "#ff5a7a";
    });
}

/* ─── Save Client ─────────────────────────────── */
async function saveClient(client) {
  await idb.put(APP.stores.clients, client);
  const i = state.clients.findIndex((c) => c.id === client.id);
  if (i !== -1) state.clients[i] = client;
  else state.clients.push(client);
}

async function saveEstimate(est) {
  await idb.put(APP.stores.estimates, est);
  const i = state.estimates.findIndex((e) => e.id === est.id);
  if (i !== -1) state.estimates[i] = est;
  else state.estimates.push(est);
}

async function saveCrewMember(member) {
  await idb.put(APP.stores.crew, member);
  const i = state.crew.findIndex((c) => c.id === member.id);
  if (i !== -1) state.crew[i] = member;
  else state.crew.push(member);
}

async function saveInventoryItem(item) {
  await idb.put(APP.stores.inventory, item);
  const i = state.inventory.findIndex((x) => x.id === item.id);
  if (i !== -1) state.inventory[i] = item;
  else state.inventory.push(item);
}

async function saveEquipment(item) {
  await idb.put(APP.stores.equipment, item);
  const i = state.equipment.findIndex((x) => x.id === item.id);
  if (i !== -1) state.equipment[i] = item;
  else state.equipment.push(item);
}

/* ─── Push Notification helper ───────────────── */
function pushNotify(title, body) {
  if (!state.settings.notificationsEnabled) return;
  if (Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

/* ─── PDF: Job Report ───────────────────────── */
function exportJobPDF(job) {
  if (!window.jspdf) {
    toast.error("PDF Error", "jsPDF not loaded.");
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const lm = 14;
  let y = 22;

  doc.setFontSize(20);
  doc.setFont("helvetica", "bold");
  doc.text("JobCost Pro", lm, y);
  if (state.settings.company) {
    doc.setFontSize(11);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100);
    doc.text(state.settings.company, lm, y + 7);
    y += 6;
  }
  y += 8;
  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(120);
  doc.text(`Report generated on ${fmtDate(Date.now())}`, lm, y);
  doc.setTextColor(0);
  y += 10;
  doc.line(lm, y, 196, y);
  y += 8;

  const infoRow = (lbl, val) => {
    doc.setFont("helvetica", "bold");
    doc.text(`${lbl}:`, lm, y);
    doc.setFont("helvetica", "normal");
    doc.text(String(val ?? "—"), lm + 42, y);
    y += 7;
  };
  doc.setFontSize(11);
  infoRow("Job", job.name);
  infoRow("Client", job.client || "—");
  infoRow("Status", job.status);
  infoRow("Created", fmtDate(job.date));
  if (job.startDate) infoRow("Start Date", fmtDate(job.startDate));
  if (job.deadline) infoRow("Deadline", fmtDate(job.deadline));
  infoRow("Estimated Value", fmt(job.value));
  if (job.estimatedHours) {
    infoRow("Estimated Hours", `${job.estimatedHours}h`);
    const realHrs = state.timeLogs
      .filter((l) => l.jobId === job.id)
      .reduce((s, l) => s + (l.hours || 0), 0);
    infoRow("Actual Hours", `${realHrs.toFixed(2)}h`);
  }
  if (job.notes) {
    const lines = doc.splitTextToSize(job.notes, 140);
    infoRow("Notes", lines[0]);
    lines.slice(1).forEach((l) => {
      doc.text(l, lm + 42, y);
      y += 6;
    });
  }

  const costs = job.costs || [];
  if (costs.length) {
    y += 6;
    doc.line(lm, y, 196, y);
    y += 8;
    doc.setFontSize(13);
    doc.setFont("helvetica", "bold");
    doc.text("Cost Breakdown", lm, y);
    y += 8;
    doc.setFontSize(9);
    doc.setFillColor(20, 30, 55);
    doc.rect(lm, y - 5, 182, 7, "F");
    doc.setTextColor(200, 210, 230);
    const cols = [lm + 1, 88, 126, 145, 173];
    ["Description", "Category", "Qty", "Unit Cost", "Total"].forEach((h, i) =>
      doc.text(h, cols[i], y),
    );
    y += 5;
    doc.setTextColor(0);
    costs.forEach((c, i) => {
      if (y > 270) {
        doc.addPage();
        y = 20;
      }
      if (i % 2 === 0) {
        doc.setFillColor(245, 246, 249);
        doc.rect(lm, y - 4, 182, 7, "F");
      }
      doc.setFont("helvetica", "normal");
      const ct = (c.qty || 0) * (c.unitCost || 0);
      [
        String(c.description || "").slice(0, 34),
        c.category || "",
        String(c.qty || 0),
        fmt(c.unitCost),
        fmt(ct),
      ].forEach((v, i) => doc.text(v, cols[i], y));
      y += 7;
    });
    y += 4;
    doc.line(lm, y, 196, y);
    y += 8;
    const tc = jobCost(job),
      margin = (job.value || 0) - tc;
    const pct = job.value ? ((margin / job.value) * 100).toFixed(1) : "—";
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    [
      `Total Cost: ${fmt(tc)}`,
      `Estimated Value: ${fmt(job.value)}`,
      `Profit / Loss: ${fmt(margin)} (${pct}%)`,
    ].forEach((t) => {
      doc.text(t, lm, y);
      y += 7;
    });
  }

  const logs = state.timeLogs.filter((l) => l.jobId === job.id);
  if (logs.length) {
    y += 6;
    doc.line(lm, y, 196, y);
    y += 8;
    doc.setFontSize(13);
    doc.setFont("helvetica", "bold");
    doc.text("Time Logs", lm, y);
    y += 8;
    doc.setFontSize(9);
    doc.setFillColor(20, 30, 55);
    doc.rect(lm, y - 5, 150, 7, "F");
    doc.setTextColor(200, 210, 230);
    doc.text("Date", lm + 1, y);
    doc.text("Hours", lm + 42, y);
    doc.text("Note", lm + 70, y);
    y += 5;
    doc.setTextColor(0);
    logs
      .sort((a, b) => b.date - a.date)
      .forEach((l, i) => {
        if (y > 270) {
          doc.addPage();
          y = 20;
        }
        if (i % 2 === 0) {
          doc.setFillColor(245, 246, 249);
          doc.rect(lm, y - 4, 150, 7, "F");
        }
        doc.setFont("helvetica", "normal");
        doc.text(fmtDate(l.date), lm + 1, y);
        doc.text(`${(l.hours || 0).toFixed(2)}h`, lm + 42, y);
        if (l.note) doc.text(String(l.note).slice(0, 50), lm + 70, y);
        y += 7;
      });
    y += 4;
    doc.setFont("helvetica", "bold");
    doc.text(
      `Total: ${logs.reduce((s, l) => s + (l.hours || 0), 0).toFixed(2)}h`,
      lm,
      y,
    );
  }

  doc.save(`${job.name.replace(/[^a-z0-9]/gi, "_").slice(0, 48)}_report.pdf`);
  toast.success("PDF exported", job.name);
}

/* ─── PDF: Full Report ───────────────────────── */
function exportAllPDF() {
  if (!window.jspdf) {
    toast.error("PDF Error", "jsPDF not loaded.");
    return;
  }
  if (!state.jobs.length) {
    toast.warn("No data", "No jobs to export.");
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape" });
  const lm = 14;
  let y = 22;

  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.text("JobCost Pro — Full Report", lm, y);
  if (state.settings.company) {
    doc.setFontSize(11);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100);
    doc.text(state.settings.company, lm, y + 7);
    y += 6;
  }
  y += 8;
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(120);
  doc.text(
    `Generated on ${fmtDate(Date.now())} · ${state.jobs.length} jobs`,
    lm,
    y,
  );
  doc.setTextColor(0);
  y += 8;
  doc.line(lm, y, 283, y);
  y += 8;

  const totalVal = state.jobs.reduce((s, j) => s + (j.value || 0), 0);
  const totalCost = state.jobs.reduce((s, j) => s + jobCost(j), 0);
  const totalHrs = state.timeLogs.reduce((s, l) => s + (l.hours || 0), 0);
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text(
    `Total Value: ${fmt(totalVal)}   Total Cost: ${fmt(totalCost)}   Hours: ${totalHrs.toFixed(1)}h`,
    lm,
    y,
  );
  y += 10;

  doc.setFontSize(8);
  doc.setFillColor(20, 30, 55);
  doc.rect(lm, y - 5, 269, 7, "F");
  doc.setTextColor(200, 210, 230);
  const cols = [lm + 1, 88, 130, 165, 200, 235, 262];
  [
    "Job",
    "Client",
    "Status",
    "Est. Value",
    "Total Cost",
    "Margin",
    "Deadline",
  ].forEach((h, i) => doc.text(h, cols[i], y));
  y += 5;
  doc.setTextColor(0);

  [...state.jobs]
    .sort((a, b) => b.date - a.date)
    .forEach((j, i) => {
      if (y > 190) {
        doc.addPage();
        y = 20;
      }
      if (i % 2 === 0) {
        doc.setFillColor(248, 249, 252);
        doc.rect(lm, y - 4, 269, 7, "F");
      }
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      const tc = jobCost(j),
        m = (j.value || 0) - tc;
      [
        j.name.slice(0, 34),
        (j.client || "—").slice(0, 22),
        j.status,
        fmt(j.value),
        fmt(tc),
        fmt(m),
        j.deadline ? fmtDate(j.deadline) : "—",
      ].forEach((v, i) => doc.text(v, cols[i], y));
      y += 7;
    });

  doc.save(`jobcost_full_report_${Date.now()}.pdf`);
  toast.success("Report exported", `${state.jobs.length} jobs included.`);
}

/* ─── PDF: Invoice (Professional) ───────────── */
function exportInvoicePDF(job) {
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

  /* Header with logo */
  doc.setFillColor(20, 40, 90);
  doc.rect(0, 0, 210, 36, "F");
  if (s.logoDataUrl) {
    try {
      doc.addImage(s.logoDataUrl, "JPEG", lm, 4, 28, 28);
    } catch {}
  }
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(22);
  doc.setFont("helvetica", "bold");
  doc.text("INVOICE", s.logoDataUrl ? lm + 32 : lm, y);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  if (s.company) doc.text(s.company, s.logoDataUrl ? lm + 32 : lm, y + 8);
  if (s.companyAddress)
    doc.text(s.companyAddress, s.logoDataUrl ? lm + 32 : lm, y + 14);
  if (s.companyPhone)
    doc.text(`Tel: ${s.companyPhone}`, s.logoDataUrl ? lm + 32 : lm, y + 20);
  if (s.licenseNumber)
    doc.text(`Lic: ${s.licenseNumber}`, rr, y + 6, { align: "right" });
  doc.setTextColor(0);
  y = 46;

  /* Invoice metadata */
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text(`Date: ${fmtDate(Date.now())}`, rr, y, { align: "right" });
  doc.text(`Invoice #: ${job.invoiceNumber || "TBD"}`, rr, y + 7, {
    align: "right",
  });
  doc.text(`Ref: ${job.name.slice(0, 40)}`, rr, y + 14, { align: "right" });
  doc.setFont("helvetica", "normal");
  y += 4;

  /* Bill To */
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text("Bill To:", lm, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(job.client || "—", lm, y + 7);
  if (job.city || job.state)
    doc.text(
      [job.city, job.state, job.zip].filter(Boolean).join(", "),
      lm,
      y + 14,
    );
  y += 28;

  doc.setDrawColor(180, 185, 200);
  doc.line(lm, y, rr, y);
  y += 8;

  /* Job details section */
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.text("Job Details:", lm, y);
  doc.setFont("helvetica", "normal");
  const details = [
    job.insulationType,
    job.areaType,
    job.sqft ? `${job.sqft} sq ft` : null,
    job.rValueAchieved ? `R-${job.rValueAchieved}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (details) {
    doc.text(details, lm + 24, y);
  }
  y += 10;

  /* Itemized costs table */
  const costs = job.costs || [];
  if (costs.length) {
    doc.setFontSize(9);
    doc.setFillColor(20, 30, 55);
    doc.rect(lm, y - 5, 182, 7, "F");
    doc.setTextColor(200, 210, 230);
    const cols = [lm + 1, 90, 122, 145, 173];
    ["Description", "Category", "Qty", "Unit Price", "Total"].forEach((h, i) =>
      doc.text(h, cols[i], y),
    );
    y += 5;
    doc.setTextColor(0);
    let subtotal = 0;
    costs.forEach((c, i) => {
      if (y > 250) {
        doc.addPage();
        y = 20;
      }
      if (i % 2 === 0) {
        doc.setFillColor(248, 249, 252);
        doc.rect(lm, y - 4, 182, 7, "F");
      }
      doc.setFont("helvetica", "normal");
      const ct = (c.qty || 0) * (c.unitCost || 0);
      subtotal += ct;
      [
        String(c.description || "").slice(0, 38),
        c.category || "",
        String(c.qty || 0),
        fmt(c.unitCost),
        fmt(ct),
      ].forEach((v, i) => doc.text(v, cols[i], y));
      y += 7;
    });

    y += 4;
    doc.setDrawColor(180, 185, 200);
    doc.line(lm, y, rr, y);
    y += 6;

    /* Subtotal, markup, tax, total */
    const markup = job.value && subtotal ? job.value - subtotal : 0;
    const taxRate = job.taxRate || 0;
    const taxAmt = (subtotal + Math.max(0, markup)) * (taxRate / 100);
    const grandTotal = subtotal + Math.max(0, markup) + taxAmt;

    const totRow = (lbl, val, bold) => {
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setFontSize(bold ? 11 : 9);
      doc.text(lbl, rr - 40, y, { align: "right" });
      doc.text(val, rr, y, { align: "right" });
      y += bold ? 8 : 6;
    };
    totRow("Subtotal:", fmt(subtotal), false);
    if (markup > 0) totRow("Service Fee:", fmt(markup), false);
    if (taxRate > 0) totRow(`Tax (${taxRate}%):`, fmt(taxAmt), false);
    doc.setTextColor(20, 40, 90);
    totRow("TOTAL DUE:", fmt(grandTotal), true);
    doc.setTextColor(0);
  } else {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text("Services rendered as agreed.", lm, y);
    y += 10;
    doc.setDrawColor(180, 185, 200);
    doc.line(lm, y, rr, y);
    y += 6;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(20, 40, 90);
    doc.text(`TOTAL DUE: ${fmt(job.value || 0)}`, rr, y, { align: "right" });
    doc.setTextColor(0);
    y += 10;
  }

  /* Payment terms */
  y += 6;
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.text("Payment Terms:", lm, y);
  doc.setFont("helvetica", "normal");
  doc.text("Due upon receipt", lm + 32, y);
  y += 7;
  doc.setFont("helvetica", "bold");
  doc.text("Payment Accepted:", lm, y);
  doc.setFont("helvetica", "normal");
  doc.text("Check / Zelle / Venmo", lm + 36, y);
  y += 7;

  if (job.notes) {
    y += 4;
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.text("Notes:", lm, y);
    doc.setFont("helvetica", "normal");
    y += 6;
    doc
      .splitTextToSize(job.notes, 170)
      .slice(0, 6)
      .forEach((l) => {
        doc.text(l, lm, y);
        y += 5;
      });
  }

  /* Footer */
  doc.setFillColor(20, 40, 90);
  doc.rect(0, 275, 210, 22, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(8);
  const footerText =
    [
      s.company,
      s.companyPhone,
      s.companyEmail,
      s.licenseNumber ? `Lic: ${s.licenseNumber}` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "King Insulation · Florida Licensed & Insured";
  doc.text(footerText, 105, 285, { align: "center" });

  doc.save(`invoice_${job.name.replace(/[^a-z0-9]/gi, "_").slice(0, 40)}.pdf`);
  toast.success("Invoice exported", job.name);
}

/* ─── PDF: Work Order / Dispatch Sheet ──────── */
function exportWorkOrderPDF(job) {
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

  /* Header */
  doc.setFillColor(20, 40, 90);
  doc.rect(0, 0, 210, 32, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.text(s.company || "King Insulation", lm, y);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text("WORK ORDER / DISPATCH SHEET", rr, y, { align: "right" });
  if (s.companyPhone)
    doc.text(`Tel: ${s.companyPhone}`, rr, y + 8, { align: "right" });
  doc.setTextColor(0);
  y = 42;

  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(20, 40, 90);
  doc.text("WORK ORDER", lm, y);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100);
  doc.text(`Generated: ${fmtDate(Date.now())}`, rr, y, { align: "right" });
  doc.setTextColor(0);
  y += 8;
  doc.setDrawColor(20, 40, 90);
  doc.line(lm, y, rr, y);
  y += 8;

  const row = (lbl, val) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text(`${lbl}:`, lm, y);
    doc.setFont("helvetica", "normal");
    doc.text(String(val || "—"), lm + 42, y);
    y += 7;
  };

  row("Job Name", job.name);
  row("Client", job.client || "—");
  row(
    "Address",
    [job.city, job.state, job.zip].filter(Boolean).join(", ") || "—",
  );
  row("Scheduled Date", job.startDate ? fmtDate(job.startDate) : "TBD");
  row("Status", job.status);
  row("Insulation Type", job.insulationType || "—");
  row("Area Type", job.areaType || "—");
  row("Square Footage", job.sqft ? `${job.sqft} sq ft` : "—");
  row("R-Value Target", job.rValueTarget ? `R-${job.rValueTarget}` : "—");

  /* Crew assigned */
  const crewNames = (job.crewIds || [])
    .map((id) => {
      const m = state.crew.find((c) => c.id === id);
      return m ? m.name : null;
    })
    .filter(Boolean);
  row("Crew Assigned", crewNames.length ? crewNames.join(", ") : "—");

  y += 4;
  doc.setDrawColor(180, 185, 200);
  doc.line(lm, y, rr, y);
  y += 8;

  /* Materials needed */
  const matResult = calcMaterials(
    job.insulationType,
    job.sqft,
    job.rValueTarget,
  );
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("Materials Needed:", lm, y);
  y += 7;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  if (matResult) {
    doc.text(
      `• ${matResult.qty} ${matResult.unit} of ${matResult.insulationType}`,
      lm + 4,
      y,
    );
    y += 6;
  }
  (job.costs || [])
    .filter((c) => c.category === "Materials")
    .forEach((c) => {
      doc.text(`• ${c.description} — Qty: ${c.qty}`, lm + 4, y);
      y += 6;
    });
  if (
    !matResult &&
    !(job.costs || []).filter((c) => c.category === "Materials").length
  ) {
    doc.setTextColor(150);
    doc.text("— No materials listed —", lm + 4, y);
    doc.setTextColor(0);
    y += 6;
  }
  y += 4;

  /* Pre-job checklist */
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("Pre-Job Checklist:", lm, y);
  y += 7;
  const preItems = [
    "PPE checked (respirator, goggles, gloves)",
    "Equipment tested and operational",
    "Attic/area access confirmed",
    "Materials quantity verified",
    "Customer briefed on process",
  ];
  preItems.forEach((item) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.rect(lm + 2, y - 4, 4, 4);
    doc.text(item, lm + 10, y);
    y += 7;
  });
  y += 4;

  /* Notes / Special instructions */
  if (job.notes) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text("Special Instructions / Access Notes:", lm, y);
    y += 6;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc
      .splitTextToSize(job.notes, 170)
      .slice(0, 8)
      .forEach((l) => {
        doc.text(l, lm, y);
        y += 5;
      });
  }

  /* Footer */
  doc.setFillColor(20, 40, 90);
  doc.rect(0, 275, 210, 22, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(8);
  doc.text(
    (s.company || "King Insulation") + " · Work Order · " + fmtDate(Date.now()),
    105,
    285,
    { align: "center" },
  );

  doc.save(
    `work_order_${job.name.replace(/[^a-z0-9]/gi, "_").slice(0, 40)}.pdf`,
  );
  toast.success("Work Order exported", job.name);
}

/* ─── PDF: Warranty Certificate ─────────────── */
function exportWarrantyCertPDF(job) {
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
  const installDate = job.startDate || job.date || Date.now();
  const matWarrantyYrs = 10,
    laborWarrantyYrs = 2;
  const matExpiry = new Date(installDate);
  matExpiry.setFullYear(matExpiry.getFullYear() + matWarrantyYrs);
  const laborExpiry = new Date(installDate);
  laborExpiry.setFullYear(laborExpiry.getFullYear() + laborWarrantyYrs);

  /* Decorative border */
  doc.setDrawColor(20, 40, 90);
  doc.setLineWidth(3);
  doc.rect(6, 6, 198, 285);
  doc.setLineWidth(1);
  doc.rect(9, 9, 192, 279);
  doc.setLineWidth(0.5);

  /* Header */
  doc.setFillColor(20, 40, 90);
  doc.rect(0, 0, 210, 40, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(20);
  doc.setFont("helvetica", "bold");
  doc.text(s.company || "King Insulation", 105, 18, { align: "center" });
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  if (s.companyAddress)
    doc.text(s.companyAddress, 105, 27, { align: "center" });
  if (s.licenseNumber)
    doc.text(`License #: ${s.licenseNumber}`, 105, 34, { align: "center" });
  doc.setTextColor(0);
  y = 52;

  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(20, 40, 90);
  doc.text("LIMITED WARRANTY CERTIFICATE", 105, y, { align: "center" });
  y += 6;
  doc.setDrawColor(20, 40, 90);
  doc.line(30, y, 180, y);
  y += 12;

  doc.setTextColor(0);
  const row = (lbl, val) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text(`${lbl}:`, lm, y);
    doc.setFont("helvetica", "normal");
    doc.text(String(val || "—"), lm + 55, y);
    y += 9;
  };

  row("Issued To", job.client || "—");
  row(
    "Property Address",
    [job.city, job.state, job.zip].filter(Boolean).join(", ") || "—",
  );
  row("Job Name", job.name);
  row("Installation Date", fmtDate(installDate));
  row("Insulation Type", job.insulationType || "—");
  row("Area", job.areaType || "—");
  row(
    "R-Value Achieved",
    job.rValueAchieved
      ? `R-${job.rValueAchieved}`
      : job.rValueTarget
        ? `R-${job.rValueTarget}`
        : "—",
  );
  row("Square Footage", job.sqft ? `${job.sqft} sq ft` : "—");
  y += 6;

  doc.setDrawColor(180, 185, 200);
  doc.line(lm, y, rr, y);
  y += 10;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(20, 40, 90);
  doc.text("WARRANTY TERMS", lm, y);
  y += 8;
  doc.setTextColor(0);

  const wRow = (icon, title, desc) => {
    doc.setFillColor(245, 247, 255);
    doc.rect(lm, y - 5, 182, 14, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text(`${icon} ${title}`, lm + 3, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(desc, lm + 3, y + 7);
    y += 18;
  };
  wRow(
    "MATERIAL:",
    `${matWarrantyYrs}-Year Material Warranty`,
    `Expires: ${fmtDate(matExpiry.getTime())} — Covers manufacturer defects in insulation material`,
  );
  wRow(
    "LABOR:",
    `${laborWarrantyYrs}-Year Labor Warranty`,
    `Expires: ${fmtDate(laborExpiry.getTime())} — Covers installation workmanship defects`,
  );
  y += 4;

  doc.setFontSize(8);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(100);
  const disclaimer =
    "This warranty applies to the specific installation described above. It does not cover damage from flooding, fire, pest infestation, or unauthorized modifications.";
  doc.splitTextToSize(disclaimer, 170).forEach((l) => {
    doc.text(l, lm, y);
    y += 5;
  });
  doc.setTextColor(0);
  y += 8;

  /* Signature line */
  doc.setDrawColor(50);
  doc.line(lm, y + 14, lm + 70, y + 14);
  doc.line(rr - 70, y + 14, rr, y + 14);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text("Authorized Signature", lm, y + 19);
  doc.text("Date", rr - 18, y + 19);

  /* Store warranty on job */
  job.warrantyIssued = true;
  job.warrantyDate = Date.now();
  saveJob(job);

  doc.save(`warranty_${job.name.replace(/[^a-z0-9]/gi, "_").slice(0, 40)}.pdf`);
  toast.success("Warranty Certificate exported", job.name);
}

/* ─── PDF: Job P&L Report ────────────────────── */
function exportJobPLPDF(job) {
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

  /* Header */
  doc.setFillColor(20, 40, 90);
  doc.rect(0, 0, 210, 32, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text(s.company || "King Insulation", lm, y);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text("PROFIT & LOSS REPORT", rr, y, { align: "right" });
  doc.setTextColor(0);
  y = 42;

  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(20, 40, 90);
  doc.text(`P&L: ${job.name}`, lm, y);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100);
  doc.text(`Generated: ${fmtDate(Date.now())}`, rr, y, { align: "right" });
  doc.setTextColor(0);
  y += 8;
  doc.setDrawColor(20, 40, 90);
  doc.line(lm, y, rr, y);
  y += 10;

  const revenue = job.value || 0;
  const materialCost = jobCost(job);
  const logs = state.timeLogs.filter((l) => l.jobId === job.id);
  const totalHours = logs.reduce((s, l) => s + (l.hours || 0), 0);
  let laborCost = 0;
  if (job.crewIds && job.crewIds.length) {
    const hourlyRates = job.crewIds.map((id) => {
      const m = state.crew.find((c) => c.id === id);
      return m && m.hourlyRate ? m.hourlyRate : 0;
    });
    const avgRate = hourlyRates.length
      ? hourlyRates.reduce((a, b) => a + b, 0) /
          hourlyRates.filter((r) => r > 0).length || 0
      : 0;
    laborCost = totalHours * avgRate;
  }
  const overhead = revenue * 0.1;
  const totalCosts = materialCost + laborCost + overhead;
  const grossMargin = revenue - totalCosts;
  const marginPct =
    revenue > 0 ? ((grossMargin / revenue) * 100).toFixed(1) : "N/A";
  const avgRate = laborCost > 0 && totalHours > 0 ? laborCost / totalHours : 0;
  const breakEvenHrs =
    avgRate > 0 ? ((materialCost + overhead) / avgRate).toFixed(1) : "N/A";

  const plRow = (lbl, val, color, bold) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(10);
    if (color) doc.setTextColor(...color);
    else doc.setTextColor(0);
    doc.text(lbl, lm, y);
    doc.text(val, rr, y, { align: "right" });
    y += 9;
    doc.setTextColor(0);
  };

  /* Revenue section */
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(20, 40, 90);
  doc.text("REVENUE", lm, y);
  y += 8;
  plRow("Estimated Job Value", fmt(revenue), null, true);
  y += 4;
  doc.setDrawColor(200);
  doc.line(lm, y, rr, y);
  y += 8;

  /* Costs section */
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(20, 40, 90);
  doc.text("COSTS", lm, y);
  y += 8;
  plRow("Material / Item Costs", fmt(materialCost), null, false);
  plRow(
    `Labor Cost (${totalHours.toFixed(1)}h logged)`,
    fmt(laborCost),
    null,
    false,
  );
  plRow("Overhead Estimate (10%)", fmt(overhead), null, false);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("Total Costs:", lm, y);
  doc.text(fmt(totalCosts), rr, y, { align: "right" });
  y += 9;
  y += 4;
  doc.setDrawColor(200);
  doc.line(lm, y, rr, y);
  y += 8;

  /* Summary */
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(20, 40, 90);
  doc.text("SUMMARY", lm, y);
  y += 8;
  plRow(
    "Gross Margin",
    fmt(grossMargin),
    grossMargin >= 0 ? [10, 150, 100] : [200, 50, 70],
    true,
  );
  plRow(
    "Margin %",
    `${marginPct}%`,
    grossMargin >= 0 ? [10, 150, 100] : [200, 50, 70],
    true,
  );
  plRow(
    "Break-Even Hours",
    typeof breakEvenHrs === "string" ? breakEvenHrs : `${breakEvenHrs}h`,
    null,
    false,
  );
  plRow("Total Hours Logged", `${totalHours.toFixed(2)}h`, null, false);
  y += 4;

  /* Rebate info if present */
  if (job.rebateAmount && job.rebateAmount > 0) {
    doc.setDrawColor(200);
    doc.line(lm, y, rr, y);
    y += 8;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text("Rebate (if received):", lm, y);
    doc.text(fmt(job.rebateAmount), rr, y, { align: "right" });
    y += 9;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(
      `Status: ${job.rebateStatus || "N/A"} · Source: ${job.rebateSource || "—"}`,
      lm,
      y,
    );
    y += 7;
  }

  /* Footer */
  doc.setFillColor(20, 40, 90);
  doc.rect(0, 275, 210, 22, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(8);
  doc.text(
    (s.company || "King Insulation") +
      " · Confidential Financial Report · " +
      fmtDate(Date.now()),
    105,
    285,
    { align: "center" },
  );

  doc.save(
    `pl_report_${job.name.replace(/[^a-z0-9]/gi, "_").slice(0, 40)}.pdf`,
  );
  toast.success("P&L Report exported", job.name);
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
  await idb.put(APP.stores.jobs, job);
  const i = state.jobs.findIndex((j) => j.id === job.id);
  if (i !== -1) state.jobs[i] = job;
  else state.jobs.push(job);
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
  const taxableIncome =
    totalRevenue - totalMaterial - totalLabor - mileageDeduction;

  /* Quarterly breakdown */
  const quarters = [0, 0, 0, 0];
  yearJobs.forEach((j) => {
    const q = Math.floor(new Date(j.date).getMonth() / 3);
    quarters[q] += j.value || 0;
  });

  /* Header */
  doc.setFillColor(20, 40, 90);
  doc.rect(0, 0, 210, 32, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text(s.company || "King Insulation", lm, y);
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
  r("Material / Job Costs", fmt(totalMaterial), false);
  r("Labor Costs", fmt(totalLabor), false);
  r("Mileage Deduction", fmt(mileageDeduction), false);
  r(
    "Total Expenses:",
    fmt(totalMaterial + totalLabor + mileageDeduction),
    true,
  );
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

  doc.setFillColor(20, 40, 90);
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
    const quarters = [0, 0, 0, 0];
    yearJobs.forEach((j) => {
      const q = Math.floor(new Date(j.date).getMonth() / 3);
      quarters[q] += j.value || 0;
    });
    m.querySelector("#taxSummaryContent").innerHTML = `
        <div class="summary">
          <div class="summaryRow"><span class="k">Jobs in ${year}</span><strong>${yearJobs.length}</strong></div>
          <div class="summaryRow"><span class="k">Total Revenue</span><strong>${fmt(totalRevenue)}</strong></div>
          <div class="summaryRow"><span class="k">Material Costs</span><strong>${fmt(totalMaterial)}</strong></div>
          <div class="summaryRow"><span class="k">Mileage Deduction</span><strong>${fmt(mileageDed)}</strong></div>
          <div class="summaryRow total"><span class="k">Est. Taxable Income</span><strong>${fmt(totalRevenue - totalMaterial - mileageDed)}</strong></div>
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
  saveJob(copy).then(() => {
    toast.success("Job duplicated", copy.name);
    render();
  });
}

async function saveJobChecklist(job) {
  await saveJob(job);
}

/* ─── PDF: Before & After Completion Report ─── */
function exportBeforeAfterPDF(job) {
  if (!window.jspdf) { toast.error("PDF Error", "jsPDF not loaded."); return; }
  const beforePhotos = (job.photos || []).filter((p) => p.type === "before");
  const afterPhotos  = (job.photos || []).filter((p) => p.type === "after");
  if (!beforePhotos.length && !afterPhotos.length) {
    toast.warn("No tagged photos", "Mark at least one photo as Before or After first.");
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const s = state.settings;
  const lm = 14, rr = 196, pw = 182;
  let y = 18;

  /* ── Header ── */
  doc.setFillColor(20, 40, 90);
  doc.rect(0, 0, 210, 36, "F");
  if (s.logoDataUrl) {
    try { doc.addImage(s.logoDataUrl, "JPEG", lm, 4, 28, 28); } catch {}
  }
  const hx = s.logoDataUrl ? lm + 32 : lm;
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(20); doc.setFont("helvetica", "bold");
  doc.text("COMPLETION REPORT", hx, y);
  doc.setFontSize(9); doc.setFont("helvetica", "normal");
  if (s.company) doc.text(s.company, hx, y + 8);
  if (s.companyPhone) doc.text(`Tel: ${s.companyPhone}`, hx, y + 14);
  doc.text(`Date: ${fmtDate(Date.now())}`, rr, y, { align: "right" });
  doc.setTextColor(0);
  y = 44;

  /* ── Job / Client info ── */
  doc.setFontSize(11); doc.setFont("helvetica", "bold");
  doc.text(job.name, lm, y); y += 7;
  doc.setFontSize(9); doc.setFont("helvetica", "normal");
  if (job.client) { doc.text(`Client: ${job.client}`, lm, y); y += 5; }
  const addr = [job.city, job.state, job.zip].filter(Boolean).join(", ");
  if (addr) { doc.text(`Address: ${addr}`, lm, y); y += 5; }
  doc.setDrawColor(200, 210, 230);
  doc.line(lm, y, rr, y); y += 6;

  /* ── Helper: place one image, returns new y ── */
  const addPhoto = (photo, label, x, imgW, imgH) => {
    const dataUrl = photo.data || photo.dataUrl || "";
    if (!dataUrl) return;
    const fmt = dataUrl.startsWith("data:image/png") ? "PNG" : "JPEG";
    doc.setFontSize(8); doc.setFont("helvetica", "bold");
    doc.setTextColor(80, 80, 80);
    doc.text(label, x + imgW / 2, y, { align: "center" });
    try {
      doc.addImage(dataUrl, fmt, x, y + 3, imgW, imgH);
    } catch {}
  };

  /* ── Pair layout: Before left / After right ── */
  const maxPairs = Math.max(beforePhotos.length, afterPhotos.length);
  const colW = (pw - 6) / 2;     /* two columns with 6mm gutter */
  const imgH = colW * 0.7;       /* ~70% aspect ratio */

  for (let i = 0; i < maxPairs; i++) {
    const neededH = imgH + 18;
    if (y + neededH > 275) { doc.addPage(); y = 16; }

    const bp = beforePhotos[i] || null;
    const ap = afterPhotos[i]  || null;

    if (bp) addPhoto(bp, "BEFORE", lm, colW, imgH);
    if (ap) addPhoto(ap, "AFTER",  lm + colW + 6, colW, imgH);

    /* border around each image */
    if (bp) { doc.setDrawColor(180, 190, 210); doc.rect(lm, y + 3, colW, imgH); }
    if (ap) { doc.setDrawColor(180, 190, 210); doc.rect(lm + colW + 6, y + 3, colW, imgH); }

    y += neededH + 4;
  }

  /* ── Summary row ── */
  if (y + 14 > 275) { doc.addPage(); y = 16; }
  y += 4;
  doc.setFillColor(20, 40, 90);
  doc.rect(lm, y, pw, 10, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(9); doc.setFont("helvetica", "bold");
  doc.text(`${beforePhotos.length} Before  ·  ${afterPhotos.length} After  ·  Status: ${job.status}`, 105, y + 7, { align: "center" });
  doc.setTextColor(0);

  /* ── Footer ── */
  doc.setFontSize(7); doc.setTextColor(150);
  doc.text(`${s.company || "JobCost Pro"}  ·  Generated ${fmtDate(Date.now())}`, 105, 290, { align: "center" });

  doc.save(`BeforeAfter_${job.name.replace(/[^a-z0-9]/gi, "_").slice(0, 35)}.pdf`);
  toast.success("Report exported", `${beforePhotos.length} before + ${afterPhotos.length} after photos.`);
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
  let y = 24;

  doc.setFillColor(20, 40, 90);
  doc.rect(0, 0, 210, 38, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(22);
  doc.setFont("helvetica", "bold");
  doc.text("King Insulation", lm, y);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text("Florida's Insulation Experts", lm, y + 9);
  doc.text("kinginsulation.com · Florida Licensed & Insured", rr, y + 9, {
    align: "right",
  });
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
  doc.setFillColor(20, 40, 90);
  doc.rect(0, y, 210, 22, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text(
    "kinginsulation.com · Florida Licensed & Insured · King Insulation",
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
      });
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
        state.crew.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")
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
                  const member = l.crewId ? state.crew.find((c) => c.id === l.crewId) : null;
                  const pinLink = l.lat && l.lng
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
          <div class="sigWrap"><canvas id="sigCanvas" class="sigCanvas" width="560" height="160"></canvas></div>
          <div class="sigActions">
            <button type="button" class="btn" id="btnSigClear">Clear</button>
            <button type="button" class="btn primary" id="btnSigSave">Save Signature</button>
          </div>
        </div>`;
  };

  const TABS = ["overview", "costs", "timelogs", "photos", "spec", "checklist"];
  const TAB_LABELS = {
    overview: "Overview",
    costs: "Costs",
    timelogs: "Hours",
    photos: "Photos",
    spec: "Spec",
    checklist: "Check",
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
        saveJob(job).then(() => {
          switchTab("costs");
          render();
        });
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
        idb.put(APP.stores.timeLogs, log)
          .then(() => {
            state.timeLogs.push(log);
            toast.success("Hours added", `${hrs}h logged.`);
            switchTab("timelogs");
            render();
          })
          .catch(() => toast.error("Error", "Could not save hours."));

      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => { log.lat = pos.coords.latitude; log.lng = pos.coords.longitude; persistLog(); },
          () => persistLog(),
          { timeout: 10000, maximumAge: 60000 },
        );
      } else {
        persistLog();
      }
    });

    root.querySelectorAll("[data-dtl]").forEach((btn) => {
      btn.addEventListener("click", () => {
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
                saveJob(job).then(() => {
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
                });
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
        saveJob(job).then(() => switchTab("photos"));
      });
    });

    root.querySelectorAll(".photoTypeBtn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const { pid, ptype } = btn.dataset;
        const photo = (job.photos || []).find((p) => p.id === pid);
        if (!photo) return;
        photo.type = photo.type === ptype ? "" : ptype;
        saveJob(job).then(() => switchTab("photos"));
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
          if (e.key === "Escape") { closeLb(); document.removeEventListener("keydown", escKey); }
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
            return [(cx - r.left) * (dw / r.width), (cy - r.top) * (dh / r.height)];
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
          drawCanvas.addEventListener("pointerup", () => { drawing = false; ctx.beginPath(); });
          drawCanvas.addEventListener("pointercancel", () => { drawing = false; });

          toolbar.innerHTML = `
            <button class="btn lbCancelDraw">✕ Cancel</button>
            <button class="btn primary lbSaveDraw">💾 Save Annotation</button>`;

          toolbar.querySelector(".lbCancelDraw").addEventListener("click", () => {
            drawCanvas.remove();
            toolbar.innerHTML = `<button class="btn lbAnnotateBtn">✏️ Annotate</button>`;
            toolbar.querySelector(".lbAnnotateBtn").addEventListener("click", startAnnotation);
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
            offCtx.drawImage(drawCanvas, 0, 0, lbImg.naturalWidth, lbImg.naturalHeight);
            const merged = off.toDataURL("image/jpeg", 0.85);
            const photo = (job.photos || []).find((p) => p.id === pid);
            if (photo) {
              photo.data = merged;
              photo.dataUrl = merged;
              saveJob(job).then(() => {
                toast.success("Annotation saved", "Photo updated.");
                closeLb();
                switchTab("photos");
              });
            }
          });
        }

        lb.querySelector(".lbAnnotateBtn").addEventListener("click", startAnnotation);
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
        saveJobChecklist(job);
      });
    });

    /* Signature pad */
    const canvas = root.querySelector("#sigCanvas");
    if (!canvas) return;
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
      saveJob(job).then(() => toast.success("Signature saved", ""));
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
  m.querySelector("#bjShareQR").addEventListener("click", () => showJobShareQR(job));
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
  const msg = `Hi ${clientName}! Thank you for choosing ${state.settings.company || "King Insulation"}. We'd love your feedback — please leave us a review: ${reviewUrl}`;
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
    saveJob(job);
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
    saveEstimate(est).then(() => {
      toast.success(
        "Estimate created",
        `Inspection estimate for ${job.client || job.name}`,
      );
      modal.close();
    });
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
  const typeBadge = { call: "🤙", email: "📧", visit: "📍", note: "📝" };

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
                <option value="call">📞 Phone Call</option>
                <option value="email">📧 Email</option>
                <option value="visit">📍 Site Visit</option>
                <option value="note">📝 Note</option>
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

  root.innerHTML = `
      ${isHurricaneSeason() ? `<div class="hurricaneBanner">🌀 Hurricane Season Active (Jun–Nov) — Verify job site safety before dispatch</div>` : ""}
      ${lowStockCount > 0 ? `<div class="alertBanner" style="margin-bottom:12px;">📦 ${lowStockCount} inventory item(s) at or below minimum stock level</div>` : ""}
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
                  const isLowMargin = j.value > 0
                    && marginPct < minMargin
                    && !["Lead", "Draft"].includes(j.status);
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
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); doSort(); }
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
                  const loc = d.address
                    ? `📍 ${esc(d.address)}`
                    : d.lat != null
                      ? `📍 ${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`
                      : "📍 Location unavailable";
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
    const geo = $("#geoDisplay", root);
    if (!state.fieldSession.active) {
      /* Clock in */
      if (!navigator.geolocation) {
        const reason = location.protocol !== "https:" && location.hostname !== "localhost"
          ? "GPS requires HTTPS. Host the app on a secure URL (e.g. GitHub Pages)."
          : "GPS not available in this browser.";
        geo.textContent = reason;
        toast.warn("GPS unavailable", reason);
        state.fieldSession.active = true;
        state.fieldSession.data = { lat: null, lng: null, address: null, timeIn: Date.now(), jobId: $("#fieldJobSel", root).value };
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
              geoEl.innerHTML = `📍 ${esc(addr)}${wx ? `<br><span class="weatherLine">${weatherIcon(wx.code)} ${wx.temp}°F · ${wx.desc} · 💨 ${wx.wind} mph${wx.precip > 0 ? ` · 🌧 ${wx.precip}"` : ""}</span>` : ""}`;
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
              geoEl.innerHTML = `${addr ? `📍 ${esc(addr)}<br>` : ""}${wxContent}${hurricaneNote}`;
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
    a[l.jobId] = (a[l.jobId] || 0) + l.hours;
    return a;
  }, {});

  const hasLogs = state.timeLogs.length > 0;
  const hasJobs = state.jobs.length > 0;
  const hasCosts = topJobs.some((j) => jobCost(j) > 0);
  const hasHoursEst = state.jobs.some((j) => j.estimatedHours);

  root.innerHTML = `
      <h2 class="pageTitle" style="margin-bottom:18px;">Analytics</h2>
      <div class="biGrid">
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
      <div style="display:flex;flex-direction:column;gap:14px;max-width:660px;">

        <!-- Install App -->
        <button id="btnInstallApp" class="btn primary" style="display:none;align-items:center;gap:8px;font-size:1rem;">
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
            </div>
            <button class="btn primary" id="btnSave">Save Settings</button>
          </div>
        </div>

        <!-- Company Branding -->
        <div class="card">
          <div class="cardHeader"><div class="cardTitle">Company Branding</div></div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:14px;">
            <div class="fieldGrid">
              <div class="field">
                <label for="selCompany">Company Name</label>
                <input id="selCompany" class="input" type="text" maxlength="100" placeholder="King Insulation" value="${esc(s.company || "")}"/>
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

        <!-- Reports -->
        <div class="card">
          <div class="cardHeader"><div class="cardTitle">Reports</div></div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:12px;">
            <div style="display:flex;flex-wrap:wrap;gap:8px;">
              <button class="btn" id="btnTaxSummary">📊 Tax Summary</button>
              <button class="btn" id="btnSExp">⬇ JSON Backup</button>
              <button class="btn" id="btnSCSV">⬇ Export CSV</button>
              <button class="btn" id="btnAllPDF">📄 Full Report PDF</button>
              <button class="btn" id="btnSImp">⬆ Import Backup</button>
              <input type="file" id="fileImport" accept=".json" style="display:none;"/>
            </div>
            <p class="help">JSON backup includes all data. Import merges without deleting existing records.</p>
          </div>
        </div>

        <!-- Mileage Log -->
        <div class="card">
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
        <div class="card">
          <div class="cardHeader"><div class="cardTitle">Danger Zone</div></div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:12px;">
            <button class="btn danger" id="btnClear">Clear All Data</button>
            <p class="help" style="color:var(--danger);">Permanently removes all jobs, hours, templates, and clients. Export a backup first!</p>
          </div>
        </div>

        <!-- About -->
        <div class="card">
          <div class="cardHeader"><div class="cardTitle">About</div></div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:6px;">
            <div><strong>JobCost Pro</strong> <span class="muted">v4.0</span> — King Insulation</div>
            <div class="muted">Offline-first · No backend · 100% local data (IndexedDB)</div>
            <div class="hr"></div>
            <div class="small">${state.jobs.length} jobs · ${state.timeLogs.length} time logs · ${state.clients.length} clients · ${state.crew.length} crew · ${state.estimates.length} estimates</div>
            <div class="small">Shortcuts: <code class="kbd">Ctrl+K</code> search · <code class="kbd">Ctrl+N</code> new job · <code class="kbd">Esc</code> close modal</div>
          </div>
        </div>

      </div>`;

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
    state.settings.role = root.querySelector("#selRole").value;
    state.settings.language = root.querySelector("#selLang").value;
    ls(APP.lsKey).save(state.settings);
    document.body.setAttribute("data-role", state.settings.role);
    if (state.settings.role === "field") {
      routeTo("field");
    } else {
      toast.success("Settings saved", "Preferences updated.");
      render();
    }
  });

  root.querySelector("#btnSaveBranding")?.addEventListener("click", () => {
    state.settings.company = root.querySelector("#selCompany").value.trim();
    state.settings.companyPhone = root.querySelector("#selPhone").value.trim();
    state.settings.companyEmail = root.querySelector("#selEmail").value.trim();
    state.settings.companyAddress = root
      .querySelector("#selAddress")
      .value.trim();
    state.settings.googleReviewUrl = root
      .querySelector("#selReviewUrl")
      .value.trim();
    ls(APP.lsKey).save(state.settings);
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
        ls(APP.lsKey).save(state.settings);
        toast.success("Logo saved", `${w}×${h} px`);
        render();
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });

  root.querySelector("#btnRemoveLogo")?.addEventListener("click", () => {
    state.settings.logoDataUrl = null;
    ls(APP.lsKey).save(state.settings);
    toast.info("Logo removed", "");
    render();
  });

  root.querySelector("#btnSaveCompliance")?.addEventListener("click", () => {
    state.settings.licenseNumber = root
      .querySelector("#selLicNum")
      .value.trim();
    state.settings.licenseExpiry = parseDate(
      root.querySelector("#selLicExp").value,
    );
    state.settings.glInsuranceExpiry = parseDate(
      root.querySelector("#selGLExp").value,
    );
    state.settings.wcExpiry = parseDate(root.querySelector("#selWCExp").value);
    ls(APP.lsKey).save(state.settings);
    toast.success("Compliance saved", "License & insurance info updated.");
    render();
  });

  root.querySelector("#btnSaveDefaults")?.addEventListener("click", () => {
    state.settings.invoicePrefix =
      root.querySelector("#selInvPrefix").value.trim() || "INV";
    state.settings.defaultMarkup =
      parseFloat(root.querySelector("#selMarkup").value) || 0;
    state.settings.minMargin =
      parseFloat(root.querySelector("#selMinMargin").value) ?? 30;
    state.settings.mileageRate =
      parseFloat(root.querySelector("#selMileage").value) || 0.67;
    state.settings.mpg = parseFloat(root.querySelector("#selMPG").value) || 15;
    state.settings.gasPrice =
      parseFloat(root.querySelector("#selGasPrice").value) || 3.5;
    const notifyEl = root.querySelector("#selNotify");
    const wasEnabled = state.settings.notificationsEnabled;
    state.settings.notificationsEnabled = notifyEl.checked;
    if (
      notifyEl.checked &&
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
    ls(APP.lsKey).save(state.settings);
    toast.success("Defaults saved", "Job defaults updated.");
    render();
  });

  root
    .querySelector("#btnTaxSummary")
    ?.addEventListener("click", openTaxSummaryModal);
  root.querySelector("#btnSExp")?.addEventListener("click", doExport);
  root.querySelector("#btnSCSV")?.addEventListener("click", exportCSV);
  root.querySelector("#btnAllPDF")?.addEventListener("click", exportAllPDF);
  root
    .querySelector("#btnSImp")
    ?.addEventListener("click", () =>
      root.querySelector("#fileImport").click(),
    );

  root
    .querySelector("#btnAddMileage")
    ?.addEventListener("click", () => openMileageModal(null));

  root.querySelectorAll("[data-dml]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ml = state.mileageLogs.find((x) => x.id === btn.dataset.dml);
      if (!ml) return;
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
              toast.success(
                "Import complete",
                `${data.jobs.length} jobs imported.`,
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
  const company = s.company || "King Insulation";
  const phone = s.companyPhone ? `\n📞 ${s.companyPhone}` : "";
  const taxAmt = e.taxRate ? (e.value || 0) * (e.taxRate / 100) : 0;
  const total = (e.value || 0) + taxAmt;

  const lines = [
    `🏠 *${company} — Estimate ${e.name || ""}*`,
    ``,
    `👤 Client: ${e.client || "—"}`,
    e.city || e.state
      ? `📍 ${[e.city, e.state, e.zip].filter(Boolean).join(", ")}`
      : null,
    ``,
    `🔧 Service: ${e.insulationType || "Insulation"} — ${e.areaType || ""}${e.sqft ? ` (${e.sqft} sq ft)` : ""}`,
    e.rValueTarget ? `📊 R-Value Target: R-${e.rValueTarget}` : null,
    ``,
    `💰 Subtotal: ${fmt(e.value || 0)}`,
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
        <button type="button" class="btn" id="shareCopy">📋 Copy Text</button>
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
                <td style="text-align:right;">${fmt(e.value)}</td>
                <td>${fmtDate(e.date)}</td>
                <td><span class="badge est-${(e.status || "draft").toLowerCase()}">${e.status || "Draft"}</span></td>
                <td>
                  <div style="display:flex;gap:4px;flex-wrap:wrap;">
                    <button class="btn admin-only" data-ee="${e.id}" style="padding:5px 9px;font-size:12px;">Edit</button>
                    <button class="btn primary admin-only" data-econvert="${e.id}" style="padding:5px 9px;font-size:12px;">→ Job</button>
                    <button class="btn" data-eshare="${e.id}" style="padding:5px 9px;font-size:12px;" title="Share via WhatsApp">📤 Share</button>
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
  root.querySelectorAll("[data-econvert]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const e = state.estimates.find((x) => x.id === btn.dataset.econvert);
      if (!e) return;
      const job = {
        id: uid(),
        name: e.client
          ? `${e.client} – ${e.insulationType || "Insulation"}`
          : e.name || "New Job",
        client: e.client || "",
        status: "Draft",
        value: e.value || 0,
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
        costs: [],
        photos: [],
        tags: [],
        paymentStatus: "Unpaid",
        statusHistory: [{ status: "Draft", date: Date.now() }],
        checklist: {},
        mileage: 0,
      };
      saveJob(job).then(() => {
        const updated = { ...e, status: "Approved" };
        saveEstimate(updated).then(() => {
          toast.success("Job created", job.name);
          routeTo("jobs");
        });
      });
    }),
  );
  root.querySelectorAll("[data-edel]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const e = state.estimates.find((x) => x.id === btn.dataset.edel);
      if (!e) return;
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
}

function openAtticCalcModal(estimateModalEl) {
  const rOptions = Object.keys(ATTIC_CALC);
  const currentSqft = estimateModalEl.querySelector("#eSqft")?.value || "";
  const markup = state.settings.defaultMarkup || 0;

  /* Compute avg labor rate from crew hourly rates */
  const crewRates = state.crew.map((c) => c.hourlyRate || 0).filter((r) => r > 0);
  const laborRate = crewRates.length
    ? crewRates.reduce((a, b) => a + b, 0) / crewRates.length
    : ATTIC_DEFAULT_LABOR_RATE;

  const calcModal = modal.open(`
    <div class="modalHd">
      <div><h2>🏠 Attic Smart Calculator</h2>
        <p>Auto-fill estimate from square footage &amp; R-Value target.</p></div>
      <button type="button" class="closeX" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="modalBd">
      <div class="fieldGrid">
        <div class="field"><label for="acSqft">Square Footage *</label>
          <input id="acSqft" class="input" type="number" min="1" step="1" placeholder="e.g. 1200" value="${currentSqft}"/></div>
        <div class="field"><label for="acRVal">Target R-Value</label>
          <select id="acRVal" class="input">
            ${rOptions.map((r) => `<option value="${r}">${r}</option>`).join("")}
          </select></div>
        <div class="field"><label for="acBagCost">Bag Cost ($/bag)</label>
          <input id="acBagCost" class="input" type="number" min="0" step="0.01" value="${ATTIC_DEFAULT_BAG_COST}"/></div>
        <div class="field"><label for="acLaborRate">Labor Rate ($/hr)</label>
          <input id="acLaborRate" class="input" type="number" min="0" step="0.01" value="${laborRate.toFixed(2)}"/></div>
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
    const sqft = parseFloat(calcModal.querySelector("#acSqft").value);
    const rKey = calcModal.querySelector("#acRVal").value;
    const bagCost = parseFloat(calcModal.querySelector("#acBagCost").value) || ATTIC_DEFAULT_BAG_COST;
    const lRate = parseFloat(calcModal.querySelector("#acLaborRate").value) || laborRate;
    const tbl = ATTIC_CALC[rKey];
    if (!sqft || sqft <= 0) return null;

    const bags = Math.ceil((sqft / 1000) * tbl.bagsPerKSqft);
    const hrs = +((sqft / 1000) * tbl.laborHrsPerKSqft).toFixed(1);
    const matCost = bags * bagCost;
    const labCost = hrs * lRate;
    const subtotal = matCost + labCost;
    const total = +(subtotal * (1 + markup / 100)).toFixed(2);
    return { sqft, rKey, rValue: tbl.rValue, bags, hrs, matCost, labCost, subtotal, total, markup };
  }

  calcModal.querySelector("#acPreviewBtn").addEventListener("click", () => {
    const r = runCalc();
    const preview = calcModal.querySelector("#acPreview");
    const applyBtn = calcModal.querySelector("#acApply");
    if (!r) {
      preview.style.display = "block";
      preview.innerHTML = `<span style="color:var(--danger);">Enter a valid square footage.</span>`;
      applyBtn.disabled = true;
      return;
    }
    calcResult = r;
    applyBtn.disabled = false;
    preview.style.display = "block";
    preview.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;">
        <span class="muted">Bags needed</span><strong>${r.bags} bags</strong>
        <span class="muted">Labor hours</span><strong>${r.hrs} hrs</strong>
        <span class="muted">Material cost</span><strong>${fmt(r.matCost)}</strong>
        <span class="muted">Labor cost</span><strong>${fmt(r.labCost)}</strong>
        <span class="muted">Subtotal</span><strong>${fmt(r.subtotal)}</strong>
        ${r.markup > 0 ? `<span class="muted">Markup (${r.markup}%)</span><strong>${fmt(r.total - r.subtotal)}</strong>` : ""}
        <span class="muted" style="font-size:14px;"><strong>Total</strong></span><strong style="font-size:15px;color:var(--primary);">${fmt(r.total)}</strong>
      </div>`;
  });

  calcModal.querySelector("#acApply").addEventListener("click", () => {
    if (!calcResult) return;
    const r = calcResult;
    const sqftEl = estimateModalEl.querySelector("#eSqft");
    const rVtEl = estimateModalEl.querySelector("#eRVT");
    const valEl = estimateModalEl.querySelector("#eVal");
    const notesEl = estimateModalEl.querySelector("#eNotes");
    const itEl = estimateModalEl.querySelector("#eIT");
    const atEl = estimateModalEl.querySelector("#eAT");
    if (sqftEl) sqftEl.value = r.sqft;
    if (rVtEl) rVtEl.value = r.rValue;
    if (valEl) valEl.value = r.total.toFixed(2);
    if (itEl && !itEl.value) itEl.value = "Blown-in Fiberglass";
    if (atEl && !atEl.value) atEl.value = "Attic";
    const breakdown = `Smart Calc: ${r.sqft} sqft @ ${r.rKey} — ${r.bags} bags, ${r.hrs} labor hrs. Material: ${fmt(r.matCost)}, Labor: ${fmt(r.labCost)}${r.markup > 0 ? `, Markup: ${r.markup}%` : ""}.`;
    if (notesEl) notesEl.value = notesEl.value ? notesEl.value + "\n" + breakdown : breakdown;
    modal.close();
    toast.success("Smart Calc applied", `${r.bags} bags · ${r.hrs}h labor · ${fmt(r.total)}`);
  });
}

function openEstimateModal(est) {
  const isEdit = !!est;
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
  const EST_STATUS = ["Draft", "Sent", "Approved", "Declined"];

  const m = modal.open(`
      <div class="modalHd">
        <div><h2>${isEdit ? "Edit Estimate" : "New Estimate"}</h2>
          <p>${isEdit ? esc(est.name) : "Create a quote to send to a client."}</p></div>
        <button type="button" class="closeX" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modalBd">
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
          <div class="field"><label for="eRVT">R-Value Target</label>
            <input id="eRVT" class="input" type="number" min="0" step="1" placeholder="e.g. 38" value="${isEdit ? est.rValueTarget || "" : ""}"/></div>
          <div class="field"><label for="eVal">Estimated Value ($)</label>
            <input id="eVal" class="input" type="number" min="0" step="0.01" placeholder="0.00" value="${isEdit ? est.value || "" : ""}"/></div>
          <div class="field"><label for="eTax">Tax Rate (%)</label>
            <input id="eTax" class="input" type="number" min="0" step="0.01" placeholder="0" value="${isEdit ? est.taxRate || 0 : 0}"/></div>
          <div class="field"><label for="eStatus">Status</label>
            <select id="eStatus">
              ${EST_STATUS.map((s) => `<option value="${s}" ${isEdit && est.status === s ? "selected" : ""}>${s}</option>`).join("")}
            </select></div>
          <div class="field" style="grid-column:1/-1;"><label for="eNotes">Notes</label>
            <textarea id="eNotes" placeholder="Scope of work, special requirements…">${isEdit ? esc(est.notes || "") : ""}</textarea></div>
        </div>
      </div>
      <div class="modalFt">
        <button type="button" class="btn" id="eCancel">Cancel</button>
        <button type="button" class="btn" id="eBtnAttic">🏠 Smart Calc: Attic</button>
        <button type="button" class="btn primary" id="eSave">${isEdit ? "Save Changes" : "Create Estimate"}</button>
      </div>`);

  m.querySelector("#eBtnAttic").addEventListener("click", () => openAtticCalcModal(m));
  m.querySelector("#eZip")?.addEventListener("blur", () => {
    lookupZIP(m.querySelector("#eZip").value, (city, st) => {
      if (!m.querySelector("#eCity").value)
        m.querySelector("#eCity").value = city;
      if (!m.querySelector("#eSt").value) m.querySelector("#eSt").value = st;
    });
  });
  m.querySelector("#eCancel").addEventListener("click", modal.close);
  m.querySelector("#eSave").addEventListener("click", () => {
    const clEl = m.querySelector("#eCl");
    if (!clEl.value.trim()) {
      clEl.classList.add("invalid");
      clEl.focus();
      return;
    }
    clEl.classList.remove("invalid");
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
      rValueTarget: parseFloat(m.querySelector("#eRVT").value) || null,
      value: parseFloat(m.querySelector("#eVal").value) || 0,
      taxRate: parseFloat(m.querySelector("#eTax").value) || 0,
      status: m.querySelector("#eStatus").value,
      notes: m.querySelector("#eNotes").value.trim(),
      date: isEdit ? est.date : Date.now(),
      sentDate: isEdit ? est.sentDate : null,
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

/* ─── Payroll Report ─────────────────────────── */
function openPayrollModal() {
  const now = new Date();
  const firstOfMonth = fmtDateInput(new Date(now.getFullYear(), now.getMonth(), 1).getTime());
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

    const rows = Object.entries(byMember).map(([cid, hours]) => {
      const member = state.crew.find((c) => c.id === cid);
      const name = member ? member.name : "Unknown";
      const rate = member?.hourlyRate || 0;
      return { name, hours, rate, total: hours * rate };
    }).sort((a, b) => b.total - a.total);

    const grandTotal = rows.reduce((s, r) => s + r.total, 0);

    if (rows.length === 0) {
      m.querySelector("#payrollResult").innerHTML = `<div class="empty">No time logs with assigned crew members in this period.</div>`;
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
            ${rows.map((r) => `
              <tr>
                <td><strong>${esc(r.name)}</strong></td>
                <td style="text-align:right;">${r.hours.toFixed(2)}h</td>
                <td style="text-align:right;">${fmt(r.rate)}</td>
                <td style="text-align:right;"><strong>${fmt(r.total)}</strong></td>
              </tr>`).join("")}
          </tbody>
          <tfoot><tr>
            <td colspan="3"><strong>Grand Total</strong></td>
            <td style="text-align:right;"><strong>${fmt(grandTotal)}</strong></td>
          </tr></tfoot>
        </table>
      </div>
      <button class="btn" id="btnPayrollPDF" style="margin-top:12px;width:100%;">⬇ Export PDF</button>`;

    m.querySelector("#btnPayrollPDF").addEventListener("click", () => {
      if (!window.jspdf) { toast.error("PDF Error", "jsPDF not loaded."); return; }
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: "mm", format: "letter" });
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
      doc.setFillColor(30, 40, 60);
      doc.rect(14, y - 5, 183, 8, "F");
      doc.setTextColor(255);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.text("Name", 16, y);
      doc.text("Hours", 110, y, { align: "right" });
      doc.text("Rate", 145, y, { align: "right" });
      doc.text("Total Pay", 197, y, { align: "right" });
      doc.setTextColor(0);
      y += 10;

      rows.forEach((r, i) => {
        if (i % 2 === 0) { doc.setFillColor(245, 247, 252); doc.rect(14, y - 5, 183, 7, "F"); }
        doc.setFont("helvetica", "normal");
        doc.text(r.name.slice(0, 35), 16, y);
        doc.text(`${r.hours.toFixed(2)}h`, 110, y, { align: "right" });
        doc.text(`$${r.rate.toFixed(2)}/hr`, 145, y, { align: "right" });
        doc.setFont("helvetica", "bold");
        doc.text(fmt(r.total), 197, y, { align: "right" });
        y += 8;
      });

      /* Footer total */
      doc.setDrawColor(180);
      doc.line(14, y, 197, y);
      y += 6;
      doc.setFont("helvetica", "bold");
      doc.text("Grand Total", 16, y);
      doc.text(fmt(grandTotal), 197, y, { align: "right" });

      doc.save(`payroll_${startLabel.replace(/\//g, "-")}_${endLabel.replace(/\//g, "-")}.pdf`);
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
          <button class="btn admin-only" id="btnPayroll">📊 Payroll Report</button>
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

  root.querySelector("#btnPayroll")?.addEventListener("click", openPayrollModal);
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
  const lm = 14, rr = 196, pw = 182;
  let y = 18;

  const poNumber = `PO-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;

  /* ── Header bar ── */
  doc.setFillColor(20, 40, 90);
  doc.rect(0, 0, 210, 38, "F");
  if (s.logoDataUrl) {
    try { doc.addImage(s.logoDataUrl, "JPEG", lm, 4, 28, 28); } catch {}
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
  if (s.licenseNumber) doc.text(`Lic: ${s.licenseNumber}`, rr, y + 14, { align: "right" });
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
  const deliverTo = [s.company, s.companyAddress, s.companyPhone].filter(Boolean).join("  ·  ");
  doc.text(deliverTo || "____________________________________", lm + 25, y);
  doc.text(`Required by: ____________________`, rr, y, { align: "right" });
  y += 10;

  /* ── Table header ── */
  const cols = [lm, lm + 62, lm + 98, lm + 113, lm + 128, lm + 145, lm + 163];
  const colW = [58, 32, 15, 15, 17, 18, pw - (cols[6] - lm)];
  doc.setFillColor(20, 40, 90);
  doc.rect(lm, y - 5, pw, 8, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  ["Item / Description", "Category", "Unit", "On Hand", "Min Stock", "Order Qty", "Unit Cost"].forEach((h, i) =>
    doc.text(h, cols[i] + 1, y),
  );
  doc.setTextColor(0);
  y += 5;

  /* ── Table rows ── */
  let grandTotal = 0;
  items.forEach((item, idx) => {
    if (y > 250) { doc.addPage(); y = 20; }
    const orderQty = Math.max(1, (item.minStock || 10) * 2 - (item.quantity || 0));
    const lineTotal = orderQty * (item.unitCost || 0);
    grandTotal += lineTotal;
    const isOut = (item.quantity || 0) <= 0;

    if (idx % 2 === 0) { doc.setFillColor(248, 249, 252); doc.rect(lm, y - 4, pw, 7, "F"); }
    if (isOut) { doc.setTextColor(200, 30, 30); } else { doc.setTextColor(160, 100, 0); }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.text(item.name.slice(0, 34), cols[0] + 1, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(60, 60, 60);
    if (item.supplier) doc.text(item.supplier.slice(0, 30), cols[0] + 1, y + 3.5);
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
  doc.setFillColor(20, 40, 90);
  doc.rect(lm, y - 5, pw, 9, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("ESTIMATED TOTAL (at current unit cost)", cols[0] + 1, y);
  doc.text(fmt(grandTotal), rr, y, { align: "right" });
  doc.setTextColor(0);
  y += 14;

  /* ── Notes ── */
  if (y > 230) { doc.addPage(); y = 20; }
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.text("Notes / Special Instructions:", lm, y);
  doc.setFont("helvetica", "normal");
  doc.setFillColor(250, 251, 254);
  doc.rect(lm, y + 2, pw, 18, "FD");
  y += 26;

  /* ── Signatures ── */
  if (y > 255) { doc.addPage(); y = 20; }
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
    if (i === 0 && s.company) { doc.setFont("helvetica", "normal"); doc.text(s.company, sx, y + 5); }
  });

  /* ── Footer ── */
  doc.setFontSize(7);
  doc.setTextColor(150);
  doc.text(`Generated by JobCost Pro · ${fmtDate(Date.now())} · PO# ${poNumber}`, 105, 290, { align: "center" });

  doc.save(`PO_${poNumber}.pdf`);
  toast.success("Purchase Order exported", `${items.length} items · Est. ${fmt(grandTotal)}`);
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
    if (!name) { nameEl.classList.add("invalid"); nameEl.focus(); return; }
    const item = {
      id: isEdit ? eq.id : uid(),
      name,
      serialNumber: m.querySelector("#eqSerial").value.trim(),
      notes: m.querySelector("#eqNotes").value.trim(),
      status: isEdit ? eq.status : "available",
      assignedTo: isEdit ? (eq.assignedTo || null) : null,
      jobId: isEdit ? (eq.jobId || null) : null,
      checkedOutAt: isEdit ? (eq.checkedOutAt || null) : null,
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
    ? state.crew.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")
    : `<option value="">No crew members</option>`;
  const jobOpts = state.jobs.filter((j) => !["Completed", "Invoiced"].includes(j.status))
    .map((j) => `<option value="${j.id}">${esc(j.name)}</option>`).join("")
    || `<option value="">No active jobs</option>`;

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
    saveEquipment({ ...eq, status: "checkedout", assignedTo, jobId, checkedOutAt: Date.now() }).then(() => {
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
  const sortedEq = [...state.equipment].sort((a, b) => a.name.localeCompare(b.name));
  const checkedOut = sortedEq.filter((e) => e.status === "checkedout").length;

  const needsOrder = [...outItems, ...lowItems];

  root.innerHTML = `
      <div class="pageHeader">
        <h2 class="pageTitle">Material Inventory <span class="muted" style="font-size:14px;font-weight:400;">(${sorted.length} items)</span></h2>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <span class="muted" style="font-size:13px;">Stock value: <strong>${fmt(totalValue)}</strong></span>
          ${needsOrder.length ? `<button class="btn admin-only" id="btnGenPO" style="border-color:var(--warn);color:var(--warn);">📋 Generate PO (${needsOrder.length} items)</button>` : ""}
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
      ${sortedEq.length === 0
        ? `<div class="empty">No equipment added yet. Track your expensive tools and machines here.</div>`
        : `<div class="tableWrap"><table class="table">
          <thead><tr>
            <th>Name</th><th>Serial #</th><th>Status</th>
            <th>Assigned To</th><th>Job</th><th>Notes</th><th>Actions</th>
          </tr></thead>
          <tbody>
            ${sortedEq.map((eq) => {
              const assignedMember = eq.assignedTo ? state.crew.find((c) => c.id === eq.assignedTo) : null;
              const assignedJob = eq.jobId ? state.jobs.find((j) => j.id === eq.jobId) : null;
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
                    ${isOut
                      ? `<button class="btn primary admin-only" data-eqret="${eq.id}" style="padding:5px 9px;font-size:12px;">↩ Return</button>`
                      : `<button class="btn admin-only" data-eqout="${eq.id}" style="padding:5px 9px;font-size:12px;">↗ Check Out</button>`}
                    <button class="btn admin-only" data-eeq="${eq.id}" style="padding:5px 9px;font-size:12px;">Edit</button>
                    <button class="btn danger admin-only" data-deq="${eq.id}" style="padding:5px 9px;font-size:12px;">Delete</button>
                  </div>
                </td>
              </tr>`;
            }).join("")}
          </tbody>
        </table></div>`}`;

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
      confirm("Delete Item", item.name, "Delete", () => {
        idb.del(APP.stores.inventory, item.id).then(() => {
          state.inventory = state.inventory.filter((x) => x.id !== item.id);
          toast.warn("Item deleted", item.name);
          render();
        });
      });
    }),
  );

  root.querySelector("#btnGenPO")?.addEventListener("click", () => exportPO_PDF(needsOrder));
  root.querySelector("#btnNEq")?.addEventListener("click", () => openEquipmentModal(null));
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
      saveEquipment({ ...eq, status: "available", assignedTo: null, jobId: null, checkedOutAt: null }).then(() => {
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
                        const marginPct = j.value > 0 ? ((j.value - tc) / j.value) * 100 : 0;
                        const minMargin = state.settings.minMargin ?? 30;
                        const isLowMargin = j.value > 0
                          && marginPct < minMargin
                          && !["Lead", "Draft"].includes(j.status);
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

init();
