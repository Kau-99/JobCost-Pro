(() => {
  "use strict";

  /* ─── Config ─────────────────────────────────── */
  const APP = {
    dbName: "jobcost_pro_db",
    dbVersion: 6,
    stores: { jobs: "jobs", timeLogs: "timeLogs", templates: "templates", clients: "clients", crew: "crew", inventory: "inventory", estimates: "estimates" },
    lsKey: "jobcost_pro_v2",
  };

  /* ─── Utils ──────────────────────────────────── */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const uid = () => `id_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const esc = (v) =>
    String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const fmt = (n) =>
    Number(n || 0).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    });
  const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString("en-US") : "—");
  const fmtDateInput = (ts) => {
    if (!ts) return "";
    const d = new Date(ts);
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    ].join("-");
  };
  const parseDate = (s) => {
    if (!s) return null;
    /* Date-only strings (YYYY-MM-DD from <input type="date">) must be
       treated as local midnight, not UTC midnight, so US users don't
       get dates shifted back by one day. */
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, mo, d] = s.split("-").map(Number);
      return new Date(y, mo - 1, d).getTime();
    }
    return new Date(s).getTime();
  };
  const jobCost = (job) =>
    (job.costs || []).reduce((s, c) => s + (c.qty || 0) * (c.unitCost || 0), 0);
  const fmtDuration = (ms) => {
    const s = Math.floor(Math.max(0, ms) / 1000);
    return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");
  };

  /* ─── LocalStore ─────────────────────────────── */
  const ls = (key, defs = {}) => ({
    load: () => {
      try {
        return { ...defs, ...(JSON.parse(localStorage.getItem(key)) || {}) };
      } catch {
        return { ...defs };
      }
    },
    save: (v) => localStorage.setItem(key, JSON.stringify(v)),
  });

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
      mileageRate: 0.67,
      notificationsEnabled: false,
    }).load(),
    fieldSession: { active: false, data: null },
    search: "",
    sort: { col: "date", dir: "desc" },
    filter: "all",
    tagFilter: "",
    dateFilter: { from: null, to: null },
    liveTimer: null,
  };

  /* ─── IndexedDB ──────────────────────────────── */
  const idb = (() => {
    let db;
    const wrap = (r) =>
      new Promise((res, rej) => {
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    return {
      open: () =>
        new Promise((resolve, reject) => {
          const r = indexedDB.open(APP.dbName, APP.dbVersion);
          r.onupgradeneeded = () => {
            const d = r.result;
            Object.values(APP.stores).forEach((s) => {
              if (!d.objectStoreNames.contains(s))
                d.createObjectStore(s, { keyPath: "id" });
            });
          };
          r.onsuccess = () => {
            db = r.result;
            resolve(db);
          };
          r.onerror = () => reject(r.error);
        }),
      getAll: (s) =>
        wrap(db.transaction(s, "readonly").objectStore(s).getAll()),
      put: (s, v) => wrap(db.transaction(s, "readwrite").objectStore(s).put(v)),
      del: (s, id) =>
        wrap(db.transaction(s, "readwrite").objectStore(s).delete(id)),
    };
  })();

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
    return {
      success: (t, m) => show("success", t, m),
      error: (t, m) => show("error", t, m),
      warn: (t, m) => show("warn", t, m),
      info: (t, m) => show("info", t, m),
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
      return r.querySelector(".modal");
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
      [state.jobs, state.timeLogs, state.templates, state.clients, state.crew, state.inventory, state.estimates] = await Promise.all([
        idb.getAll(APP.stores.jobs),
        idb.getAll(APP.stores.timeLogs),
        idb.getAll(APP.stores.templates),
        idb.getAll(APP.stores.clients),
        idb.getAll(APP.stores.crew),
        idb.getAll(APP.stores.inventory),
        idb.getAll(APP.stores.estimates),
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
      fetchUSHolidays(yr, (h) => { _holidays = h; });
      fetchUSHolidays(yr + 1, (h) => { _holidays = [..._holidays, ...h]; });
      /* Request notification permission if previously enabled */
      if (state.settings.notificationsEnabled && Notification.permission === "default") {
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
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
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
      toast.error("Deadline overdue", `${overdue.length} job(s) past their deadline.`);
      pushNotify("JobCost Pro — Overdue", `${overdue.length} job(s) past their deadline.`);
    }
    if (upcoming.length) {
      toast.warn("Deadline soon", `${upcoming.length} job(s) due within 3 days.`);
      pushNotify("JobCost Pro — Due Soon", `${upcoming.length} job(s) due within 3 days.`);
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
    si?.addEventListener("input", () => {
      state.search = si.value.trim().toLowerCase();
      cl.hidden = !si.value;
      if (["jobs", "dashboard"].includes(state.route)) render();
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
    if (!state.jobs.length) { toast.warn("No data", "No jobs to export."); return; }
    const rows = [
      ["Job Name","Client","Status","Tags","Est. Value","Total Cost","Margin","Margin %","Mileage","Miles Deduction","Payment Status","Paid Date","Invoice #","Start Date","Deadline","Created","Hours","Notes"],
    ];
    state.jobs.forEach((j) => {
      const tc = jobCost(j);
      const margin = (j.value || 0) - tc;
      const pct = j.value ? ((margin / j.value) * 100).toFixed(1) : "";
      const hrs = state.timeLogs.filter((l) => l.jobId === j.id).reduce((s, l) => s + (l.hours || 0), 0);
      const milesDeduction = ((j.mileage || 0) * (state.settings.mileageRate || 0.67)).toFixed(2);
      rows.push([
        j.name, j.client || "", j.status,
        (j.tags || []).join("; "),
        (j.value || 0).toFixed(2), tc.toFixed(2), margin.toFixed(2), pct,
        (j.mileage || 0), milesDeduction,
        j.paymentStatus || "Unpaid", j.paidDate ? fmtDate(j.paidDate) : "",
        j.invoiceNumber || "",
        j.startDate ? fmtDate(j.startDate) : "",
        j.deadline ? fmtDate(j.deadline) : "",
        fmtDate(j.date), hrs.toFixed(2),
        (j.notes || "").replace(/"/g, '""'),
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
      navigator.clipboard?.writeText(url).then(() => toast.info("Copied", "Clock-in link copied."));
    });
    m.querySelector("#bjQRClose").addEventListener("click", modal.close);
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
      ["Description", "Category", "Qty", "Unit Cost", "Total"].forEach(
        (h, i) => doc.text(h, cols[i], y),
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

    doc.save(
      `${job.name.replace(/[^a-z0-9]/gi, "_").slice(0, 48)}_report.pdf`,
    );
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
    toast.success(
      "Report exported",
      `${state.jobs.length} jobs included.`,
    );
  }

  /* ─── PDF: Invoice ───────────────────────────── */
  function exportInvoicePDF(job) {
    if (!window.jspdf) {
      toast.error("PDF Error", "jsPDF not loaded.");
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const lm = 14,
      rr = 196;
    let y = 28;

    doc.setFontSize(28);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 50, 100);
    doc.text("INVOICE", lm, y);
    doc.setTextColor(0);
    doc.setFontSize(11);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(80);
    doc.text(state.settings.company || "JobCost Pro", lm, y + 9);
    doc.setTextColor(0);
    doc.setFontSize(10);
    doc.text(`Date: ${fmtDate(Date.now())}`, rr, y, { align: "right" });
    doc.text(`Ref: ${job.name.slice(0, 40)}`, rr, y + 7, { align: "right" });
    y += 22;
    doc.setDrawColor(180, 185, 200);
    doc.line(lm, y, rr, y);
    y += 10;

    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text("Bill To:", lm, y);
    doc.setFont("helvetica", "normal");
    doc.text(job.client || "—", lm, y + 7);
    y += 20;

    const costs = job.costs || [];
    if (costs.length) {
      doc.setFontSize(9);
      doc.setFillColor(20, 30, 55);
      doc.rect(lm, y - 5, 182, 7, "F");
      doc.setTextColor(200, 210, 230);
      const cols = [lm + 1, 90, 122, 145, 173];
      ["Description", "Category", "Qty", "Unit Price", "Total"].forEach(
        (h, i) => doc.text(h, cols[i], y),
      );
      y += 5;
      doc.setTextColor(0);
      costs.forEach((c, i) => {
        if (y > 260) {
          doc.addPage();
          y = 20;
        }
        if (i % 2 === 0) {
          doc.setFillColor(248, 249, 252);
          doc.rect(lm, y - 4, 182, 7, "F");
        }
        doc.setFont("helvetica", "normal");
        const ct = (c.qty || 0) * (c.unitCost || 0);
        [
          String(c.description || "").slice(0, 38),
          c.category || "",
          String(c.qty || 0),
          fmt(c.unitCost),
          fmt(ct),
        ].forEach((v, i) => doc.text(v, cols[i], y));
        y += 7;
      });
    } else {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.text("Services rendered as agreed.", lm, y);
      y += 10;
    }

    y += 8;
    doc.setDrawColor(180, 185, 200);
    doc.line(lm, y, rr, y);
    y += 10;
    const total = costs.length ? jobCost(job) : job.value || 0;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(30, 50, 100);
    doc.text(`TOTAL DUE: ${fmt(total)}`, rr, y, { align: "right" });
    doc.setTextColor(0);

    if (job.notes) {
      y += 18;
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(100);
      doc.text("Notes:", lm, y);
      y += 6;
      doc
        .splitTextToSize(job.notes, 170)
        .slice(0, 6)
        .forEach((l) => {
          doc.text(l, lm, y);
          y += 5;
        });
    }

    doc.save(`invoice_${job.name.replace(/[^a-z0-9]/gi, "_").slice(0, 40)}.pdf`);
    toast.success("Invoice exported", job.name);
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
    `<th class="sortable" data-sort="${col}"${align ? ` style="text-align:${align}"` : ""}>${lbl}${sortIco(col)}</th>`;

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
  const FL_CODE = { Attic: 30, Walls: 13, "Crawl Space": 10, Garage: 13, "New Construction": 30, Other: 13 };

  function checkFLCode(areaType, rValueAchieved) {
    const min = FL_CODE[areaType] || 13;
    if (!rValueAchieved) return null;
    return rValueAchieved >= min ? { pass: true, min } : { pass: false, min };
  }

  function calcMaterials(insulationType, sqft, rValueTarget) {
    if (!sqft || !rValueTarget) return null;
    const coverage = {
      "Blown-in Fiberglass": sqft / (40 * (rValueTarget / 11)),
      "Blown-in Cellulose":  sqft / (35 * (rValueTarget / 13)),
      "Spray Foam Open Cell": sqft * (rValueTarget / 3.7) / 55,
      "Spray Foam Closed Cell": sqft * (rValueTarget / 6.5) / 55,
      "Batt Fiberglass": Math.ceil(sqft / 32),
      "Batt Mineral Wool": Math.ceil(sqft / 30),
      "Radiant Barrier": Math.ceil(sqft / 500),
      "Other": null,
    };
    const units = {
      "Blown-in Fiberglass": "bags",
      "Blown-in Cellulose": "bags",
      "Spray Foam Open Cell": "sets",
      "Spray Foam Closed Cell": "sets",
      "Batt Fiberglass": "rolls",
      "Batt Mineral Wool": "rolls",
      "Radiant Barrier": "rolls",
      "Other": null,
    };
    const qty = coverage[insulationType];
    const unit = units[insulationType];
    if (!qty || !unit) return null;
    return { qty: Math.ceil(qty), unit, insulationType };
  }

  function calcUtilitySavings(sqft, rBefore, rAfter) {
    if (!sqft || !rBefore || !rAfter || rAfter <= rBefore) return null;
    const deltaU = (1 / rBefore) - (1 / rAfter);
    const btuSaved = sqft * deltaU * 8000;
    const kwhSaved = btuSaved / 3412;
    const dollarSaved = kwhSaved * 0.12;
    return { kwhSaved: Math.round(kwhSaved), dollarSaved: Math.round(dollarSaved) };
  }

  function calcHeatIndex(tempF, rh) {
    if (tempF < 80) return tempF;
    const T = tempF, R = rh;
    return Math.round(
      -42.379 + 2.04901523*T + 10.14333127*R - 0.22475541*T*R
      - 0.00683783*T*T - 0.05391554*R*R + 0.00122874*T*T*R
      + 0.00085282*T*R*R - 0.00000199*T*T*R*R
    );
  }

  function heatIndexLevel(hi) {
    if (hi >= 125) return { level: "Extreme Danger", color: "#ff0055", emoji: "🔥" };
    if (hi >= 103) return { level: "Danger", color: "var(--danger)", emoji: "⚠️" };
    if (hi >= 90)  return { level: "Extreme Caution", color: "var(--warn)", emoji: "🌡️" };
    if (hi >= 80)  return { level: "Caution", color: "#ffaa00", emoji: "🌡️" };
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

  /* ─── Completion Certificate PDF ─────────────── */
  function exportCompletionCertPDF(job) {
    if (!window.jspdf) { toast.error("PDF Error", "jsPDF not loaded."); return; }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const lm = 14, rr = 196;
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
    doc.text("kinginsulation.com · Florida Licensed & Insured", rr, y + 9, { align: "right" });
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
    row("Address", [job.city, job.state, job.zip].filter(Boolean).join(", ") || "—");
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

    const savings = calcUtilitySavings(job.sqft, job.rValueBefore, job.rValueAchieved);
    if (savings) {
      row("Est. Annual Savings", `~${savings.kwhSaved} kWh / ~$${savings.dollarSaved}/year`);
    }

    const matResult = calcMaterials(job.insulationType, job.sqft, job.rValueAchieved || job.rValueTarget);
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
    doc.text("This certificate confirms installation was completed to Florida Energy Code standards.", lm, y);
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
    doc.text("kinginsulation.com · Florida Licensed & Insured · King Insulation", 105, y + 8, { align: "center" });

    doc.save(`completion_cert_${job.name.replace(/[^a-z0-9]/gi, "_").slice(0, 40)}.pdf`);
    toast.success("Certificate exported", job.name);
  }

  /* ─── Job Modal ──────────────────────────────── */
  function openJobModal(job) {
    const isEdit = !!job;
    const STATUS = ["Lead","Quoted","Draft", "Active", "Completed", "Invoiced"];
    const PAYMENT_STATUS = ["Unpaid", "Partial", "Paid"];
    const tplOpts = state.templates.length
      ? `<option value="">— none —</option>` +
        state.templates
          .map((t) => `<option value="${t.id}">${esc(t.name)}</option>`)
          .join("")
      : null;

    const currentStatus = isEdit ? job.status : "Draft";
    const currentPayment = isEdit ? (job.paymentStatus || "Unpaid") : "Unpaid";
    const currentCosts = isEdit ? jobCost(job) : 0;
    const clientDatalist = `<datalist id="fjClientList">${
      state.clients.map((c) => `<option value="${esc(c.name)}"></option>`).join("")
    }</datalist>`;

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
              ${["Blown-in Fiberglass","Blown-in Cellulose","Spray Foam Open Cell","Spray Foam Closed Cell","Batt Fiberglass","Batt Mineral Wool","Radiant Barrier","Other"].map((s)=>`<option value="${s}" ${isEdit&&job.insulationType===s?"selected":""}>${s}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="fjAT">Area Type</label>
            <select id="fjAT">
              ${["Attic","Walls","Crawl Space","Garage","New Construction","Other"].map((s)=>`<option value="${s}" ${isEdit&&job.areaType===s?"selected":""}>${s}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="fjSqft">Square Feet</label>
            <input id="fjSqft" class="input" type="number" min="0" step="1" placeholder="e.g. 1200" value="${isEdit?job.sqft||"":""}"/>
          </div>
          <div class="field">
            <label for="fjRVB">R-Value Before</label>
            <input id="fjRVB" class="input" type="number" min="0" step="1" placeholder="e.g. 11" value="${isEdit?job.rValueBefore||"":""}"/>
          </div>
          <div class="field">
            <label for="fjRVT">R-Value Target</label>
            <input id="fjRVT" class="input" type="number" min="0" step="1" placeholder="e.g. 38" value="${isEdit?job.rValueTarget||"":""}"/>
          </div>
          <div class="field">
            <label for="fjRVA">R-Value Achieved</label>
            <input id="fjRVA" class="input" type="number" min="0" step="1" placeholder="Fill on completion" value="${isEdit?job.rValueAchieved||"":""}"/>
          </div>
          <div class="field">
            <label for="fjDI">Depth (inches)</label>
            <input id="fjDI" class="input" type="number" min="0" step="0.5" placeholder="e.g. 14" value="${isEdit?job.depthInches||"":""}"/>
          </div>
          <div class="field">
            <label for="fjTaxR">Tax Rate (%)</label>
            <input id="fjTaxR" class="input" type="number" min="0" step="0.01" placeholder="0" value="${isEdit?job.taxRate||0:0}"/>
          </div>
          <div class="field">
            <label for="fjRef">Referral Source</label>
            <select id="fjRef">
              ${["Referral","Google","Facebook/Social","Door Knock","Home Show","Repeat Customer","Contractor Referral","Other"].map((s)=>`<option value="${s}" ${isEdit&&job.referralSource===s?"selected":""}>${s}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="fjQR">Quality Rating</label>
            <select id="fjQR">
              ${["","1 ⭐","2 ⭐⭐","3 ⭐⭐⭐","4 ⭐⭐⭐⭐","5 ⭐⭐⭐⭐⭐"].map((s)=>`<option value="${s}" ${isEdit&&job.qualityRating===s?"selected":""}>${s||"— not rated —"}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="fjFU">Follow-Up Date</label>
            <input id="fjFU" class="input" type="date" value="${isEdit?fmtDateInput(job.followUpDate):""}"/>
          </div>
          <div class="field">
            <label for="fjRebSrc">Rebate Source</label>
            <select id="fjRebSrc">
              ${["None","FPL Rebate","Duke Energy Florida","HERO Program","Other"].map((s)=>`<option value="${s}" ${isEdit&&job.rebateSource===s?"selected":""}>${s}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="fjRebAmt">Rebate Amount ($)</label>
            <input id="fjRebAmt" class="input" type="number" min="0" step="0.01" placeholder="0" value="${isEdit?job.rebateAmount||"":""}"/>
          </div>
          <div class="field">
            <label for="fjRebSt">Rebate Status</label>
            <select id="fjRebSt">
              ${["N/A","Submitted","Approved","Received"].map((s)=>`<option value="${s}" ${isEdit&&job.rebateStatus===s?"selected":""}>${s}</option>`).join("")}
            </select>
          </div>
          <div class="field" style="grid-column:1/-1;">
            <label>Assign Crew</label>
            <div id="fjCrewList" style="display:flex;flex-wrap:wrap;gap:8px;padding:6px 0;">
              ${state.crew.length===0?`<span class="muted" style="font-size:12px;">No crew members yet. Add them in the Crew section.</span>`:state.crew.map((c)=>`<label style="display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer;"><input type="checkbox" value="${c.id}" ${isEdit&&(job.crewIds||[]).includes(c.id)?"checked":""}/> ${esc(c.name)} <span class="muted" style="font-size:11px;">(${esc(c.role||"")})</span></label>`).join("")}
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
        const pct = ((val - currentCosts) / val * 100).toFixed(1);
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

    /* Show/hide payment fields */
    const statusSel = m.querySelector("#fjSt");
    const payField = m.querySelector("#payStatusField");
    const paidDateField = m.querySelector("#paidDateField");
    const payStatusSel = m.querySelector("#fjPS");
    statusSel?.addEventListener("change", () => {
      const inv = statusSel.value === "Invoiced";
      payField.style.display = inv ? "block" : "none";
      paidDateField.style.display = (inv && payStatusSel.value === "Paid") ? "block" : "none";
    });
    payStatusSel?.addEventListener("change", () => {
      paidDateField.style.display = payStatusSel.value === "Paid" ? "block" : "none";
    });

    /* ZIP code auto-fill */
    m.querySelector("#fjZip")?.addEventListener("blur", () => {
      const zip = m.querySelector("#fjZip").value.trim();
      lookupZIP(zip, (city, st) => {
        if (!m.querySelector("#fjCity").value) m.querySelector("#fjCity").value = city;
        if (!m.querySelector("#fjState").value) m.querySelector("#fjState").value = st;
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
        statusHistory = [...statusHistory, { status: newStatus, date: Date.now() }];
      }

      /* Auto-generate invoice number */
      let invoiceNumber = isEdit ? job.invoiceNumber || null : null;
      if (newStatus === "Invoiced" && !invoiceNumber) {
        invoiceNumber = getNextInvoiceNumber();
      }

      /* Parse tags */
      const tagsRaw = m.querySelector("#fjTags").value.trim();
      const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [];

      /* Client ID lookup */
      const clientName = m.querySelector("#fjC").value.trim();
      const matchedClient = state.clients.find((c) => c.name.toLowerCase() === clientName.toLowerCase());
      const clientId = matchedClient ? matchedClient.id : (isEdit ? job.clientId || null : null);

      /* Collect selected crew IDs */
      const crewIds = Array.from(m.querySelectorAll("#fjCrewList input[type=checkbox]:checked")).map((cb) => cb.value);

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
        paidDate: newPayStatus === "Paid" ? parseDate(m.querySelector("#fjPD").value) : null,
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
        saveClient({ id: uid(), name: clientName, phone: "", email: "", date: Date.now() });
      }

      saveJob(saved)
        .then(() => {
          toast.success(isEdit ? "Job updated" : "Job created", saved.name);
          if (invoiceNumber && (!isEdit || !job.invoiceNumber)) toast.info("Invoice", `Assigned ${invoiceNumber}`);
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
    const getRealHrs = () =>
      getJobLogs().reduce((s, l) => s + (l.hours || 0), 0);

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
          ${job.city || job.state ? `
          <div class="field"><label>Location</label>
            <div class="infoVal">${[job.city, job.state, job.zip].filter(Boolean).join(", ") || "—"}</div></div>` : ""}
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
          ${job.tags && job.tags.length ? `
          <div class="field" style="grid-column:1/-1;"><label>Tags</label>
            <div class="tagsList">${job.tags.map((t) => `<span class="tagPill">${esc(t)}</span>`).join("")}</div></div>` : ""}
          ${job.mileage ? `
          <div class="field"><label>Mileage</label>
            <div class="infoVal">${job.mileage} mi · <span class="muted">$${((job.mileage) * (state.settings.mileageRate || 0.67)).toFixed(2)} IRS deduction</span></div></div>` : ""}
          ${job.invoiceNumber ? `
          <div class="field"><label>Invoice #</label>
            <div class="infoVal">${esc(job.invoiceNumber)}</div></div>` : ""}
          ${job.status === "Invoiced" ? `
          <div class="field"><label>Payment</label>
            <div class="infoVal"><span class="badge payment-${(job.paymentStatus || "unpaid").toLowerCase()}">${job.paymentStatus || "Unpaid"}</span>${job.paidDate ? ` · Paid ${fmtDate(job.paidDate)}` : ""}</div></div>` : ""}
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
      const tableSection = logs.length === 0
        ? `<div class="empty" style="margin-bottom:16px;">No time logs yet. Add hours manually below.</div>`
        : `
        <div class="tableWrap" style="margin-bottom:14px;">
          <table class="table">
            <thead><tr>
              <th>Date</th>
              <th style="text-align:right;">Hours</th>
              <th>Note</th>
              <th></th>
            </tr></thead>
            <tbody>
              ${logs
                .map(
                  (l) => `
                <tr>
                  <td>${fmtDate(l.date)}</td>
                  <td style="text-align:right;"><strong>${(l.hours || 0).toFixed(2)}h</strong></td>
                  <td><span class="small">${l.note ? esc(l.note) : `<span class="faint">—</span>`}</span></td>
                  <td>
                    <button class="btn danger" data-dtl="${l.id}" style="padding:4px 10px;font-size:11px;">Remove</button>
                  </td>
                </tr>`,
                )
                .join("")}
            </tbody>
          </table>
        </div>
        <div class="summaryRow" style="margin-bottom:16px;">
          <span class="k">Total Logged</span>
          <strong>${total.toFixed(2)}h${job.estimatedHours ? ` / ${job.estimatedHours}h estimated` : ""}</strong>
        </div>`;
      return tableSection + `
        <div class="sectionLabel">Add Manual Entry</div>
        <div class="addCostGrid">
          <div class="field"><label for="mtDate">Date</label><input id="mtDate" class="input" type="date" value="${fmtDateInput(Date.now())}"/></div>
          <div class="field"><label for="mtHrs">Hours</label><input id="mtHrs" class="input" type="number" min="0.1" step="0.1" placeholder="e.g. 4.5"/></div>
          <div class="field"><label for="mtNote">Note (optional)</label><input id="mtNote" class="input" type="text" maxlength="200" placeholder="What was done…"/></div>
          <div class="field addCostBtn"><label style="visibility:hidden">a</label><button type="button" class="btn primary" id="btnMTAdd">+ Add Hours</button></div>
        </div>`;
    };

    /* Tab: Photos */
    const photosHTML = () => {
      const photos = job.photos || [];
      return `
        <div class="photosHeader">
          <label class="btn photoAddBtn">
            <svg viewBox="0 0 24 24" fill="none" width="16" height="16" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            Add Photos
            <input type="file" id="photoInput" accept="image/*" multiple style="display:none;"/>
          </label>
          <span class="small">${photos.length}/10 photos</span>
        </div>
        ${
          photos.length === 0
            ? `<div class="empty">No photos added yet.<br><span class="small">Photos are stored locally on this device.</span></div>`
            : `<div class="photoGrid">
              ${photos
                .map(
                  (p) => `
                <div class="photoThumb">
                  <img src="${p.data}" alt="${esc(p.name)}" loading="lazy" data-pid="${p.id}"/>
                  <button class="photoDelBtn" data-pid="${p.id}" aria-label="Remove photo">✕</button>
                </div>`,
                )
                .join("")}
             </div>`
        }`;
    };

    /* Tab: Spec */
    const specHTML = () => {
      const flResult = checkFLCode(job.areaType, job.rValueAchieved);
      const savings = calcUtilitySavings(job.sqft, job.rValueBefore, job.rValueAchieved);
      const matResult = calcMaterials(job.insulationType, job.sqft, job.rValueAchieved || job.rValueTarget);
      const row = (lbl, val) => `<div class="specRow"><div class="specLbl">${lbl}</div><div class="specVal">${val || `<span class="faint">—</span>`}</div></div>`;
      return `
        <div class="specGrid">
          ${row("Insulation Type", esc(job.insulationType||""))}
          ${row("Area Type", esc(job.areaType||""))}
          ${row("Square Feet", job.sqft ? `${job.sqft} sq ft` : "")}
          ${row("R-Value Before", job.rValueBefore ? `R-${job.rValueBefore}` : "")}
          ${row("R-Value Target", job.rValueTarget ? `R-${job.rValueTarget}` : "")}
          ${row("R-Value Achieved", job.rValueAchieved ? `R-${job.rValueAchieved}` : "")}
          ${row("Depth", job.depthInches ? `${job.depthInches}"` : "")}
          ${row("Referral Source", esc(job.referralSource||""))}
          ${row("Quality Rating", esc(job.qualityRating||""))}
          ${row("Follow-Up Date", job.followUpDate ? fmtDate(job.followUpDate) : "")}
          ${row("Rebate Source", esc(job.rebateSource||""))}
          ${row("Rebate Amount", job.rebateAmount ? fmt(job.rebateAmount) : "")}
          ${row("Rebate Status", esc(job.rebateStatus||""))}
          ${row("Tax Rate", job.taxRate ? `${job.taxRate}%` : "0%")}
        </div>
        ${flResult !== null ? `
        <div style="margin-bottom:12px;">
          <span class="specLbl">FL Energy Code (Zone 2)</span><br>
          <span class="codeBadge ${flResult.pass?"pass":"fail"}" style="margin-top:4px;">
            ${flResult.pass ? `✓ PASS — R-${flResult.min} minimum met` : `✗ FAIL — Minimum R-${flResult.min} not met`}
          </span>
        </div>` : ""}
        ${savings ? `
        <div style="margin-bottom:12px;background:rgba(75,227,163,.06);border-radius:10px;padding:10px 14px;">
          <div class="specLbl" style="margin-bottom:4px;">Estimated Annual Utility Savings</div>
          <div style="font-size:15px;font-weight:700;color:var(--ok);">~$${savings.dollarSaved}/year</div>
          <div class="muted" style="font-size:12px;">~${savings.kwhSaved} kWh/year · Based on FL avg. $0.12/kWh</div>
        </div>` : ""}
        ${matResult ? `
        <div style="margin-bottom:12px;">
          <span class="specLbl">Material Estimate</span><br>
          <span style="font-size:14px;font-weight:600;color:var(--primary);">${matResult.qty} ${matResult.unit}</span>
          <span class="muted" style="font-size:12px;"> of ${matResult.insulationType}</span>
        </div>` : ""}
        ${job.crewIds && job.crewIds.length ? `
        <div>
          <span class="specLbl">Assigned Crew</span><br>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">
            ${job.crewIds.map((id)=>{const m=state.crew.find((c)=>c.id===id);return m?`<span class="badge crew-active">${esc(m.name)}</span>`:""}).join("")}
          </div>
        </div>` : ""}`;
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
      const renderItems = (items, prefix) => items.map((item, i) => {
        const key = `${prefix}_${i}`;
        const done = !!cl[key];
        return `<label class="checkItem${done?" done":""}" data-clkey="${key}">
          <input type="checkbox" ${done?"checked":""} data-clkey="${key}"/>
          <label>${esc(item)}</label>
        </label>`;
      }).join("");
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
        <button type="button" class="btn admin-only" id="bjShare">Share</button>
        <button type="button" class="btn admin-only" id="bjInvoice">Invoice PDF</button>
        <button type="button" class="btn primary admin-only" id="bjPDF">Report PDF</button>
        <button type="button" class="btn admin-only" id="bjCert">Completion Cert</button>
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
          if (!desc) { dEl.classList.add("invalid"); dEl.focus(); return; }
          dEl.classList.remove("invalid");
          job.costs[i] = {
            ...job.costs[i],
            description: desc,
            category: root.querySelector("#ecC").value,
            qty: parseFloat(root.querySelector("#ecQ").value) || 1,
            unitCost: parseFloat(root.querySelector("#ecU").value) || 0,
          };
          editingCostIdx = -1;
          saveJob(job).then(() => { switchTab("costs"); render(); })
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
        if (!hrs || hrs <= 0) { hrsEl.classList.add("invalid"); hrsEl.focus(); return; }
        hrsEl.classList.remove("invalid");
        const dateVal = root.querySelector("#mtDate").value;
        const log = {
          id: uid(),
          jobId: job.id,
          hours: hrs,
          date: dateVal ? parseDate(dateVal) || Date.now() : Date.now(),
          note: root.querySelector("#mtNote").value.trim(),
          manual: true,
        };
        idb.put(APP.stores.timeLogs, log)
          .then(() => {
            state.timeLogs.push(log);
            toast.success("Hours added", `${hrs}h logged.`);
            switchTab("timelogs");
            render();
          })
          .catch(() => toast.error("Error", "Could not save hours."));
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
            .catch(() =>
              toast.error("Error", "Could not remove time log."),
            );
        });
      });
    }

    function bindPhotos(root) {
      root.querySelector("#photoInput")?.addEventListener("change", (e) => {
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
              const maxW = 1400,
                maxH = 1400;
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
              const data = canvas.toDataURL("image/jpeg", 0.8);
              job.photos = [
                ...(job.photos || []),
                { id: uid(), name: file.name, data, date: Date.now() },
              ];
              done++;
              if (done === toAdd.length)
                saveJob(job).then(() => {
                  switchTab("photos");
                  render();
                });
            };
            img.src = ev.target.result;
          };
          reader.readAsDataURL(file);
        });
      });

      root.querySelectorAll(".photoDelBtn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const pid = btn.dataset.pid;
          job.photos = (job.photos || []).filter((p) => p.id !== pid);
          saveJob(job).then(() => switchTab("photos"));
        });
      });

      root.querySelectorAll(".photoThumb img").forEach((img) => {
        img.addEventListener("click", () => {
          /* Open full-size in a lightbox modal */
          const lb = document.createElement("div");
          lb.className = "lightbox";
          lb.innerHTML = `
            <div class="lightboxBg"></div>
            <img src="${img.src}" class="lightboxImg" alt="Photo"/>
            <button class="lightboxClose" aria-label="Close">✕</button>`;
          document.body.appendChild(lb);
          const closeLb = () => lb.remove();
          lb.querySelector(".lightboxBg").addEventListener("click", closeLb);
          lb.querySelector(".lightboxClose").addEventListener("click", closeLb);
          document.addEventListener("keydown", function esc(e) {
            if (e.key === "Escape") {
              closeLb();
              document.removeEventListener("keydown", esc);
            }
          });
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
      let lastX = 0, lastY = 0;

      const getPos = (e) => {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        if (e.touches) {
          return [(e.touches[0].clientX - rect.left) * scaleX, (e.touches[0].clientY - rect.top) * scaleY];
        }
        return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
      };

      canvas.addEventListener("mousedown", (e) => { drawing = true; [lastX, lastY] = getPos(e); });
      canvas.addEventListener("mousemove", (e) => {
        if (!drawing) return;
        const [x, y] = getPos(e);
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(x, y);
        ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--text") || "#e7ecf5";
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.stroke();
        [lastX, lastY] = [x, y];
      });
      canvas.addEventListener("mouseup", () => { drawing = false; });
      canvas.addEventListener("mouseleave", () => { drawing = false; });

      canvas.addEventListener("touchstart", (e) => { e.preventDefault(); drawing = true; [lastX, lastY] = getPos(e); }, { passive: false });
      canvas.addEventListener("touchmove", (e) => {
        if (!drawing) return;
        e.preventDefault();
        const [x, y] = getPos(e);
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(x, y);
        ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--text") || "#e7ecf5";
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.stroke();
        [lastX, lastY] = [x, y];
      }, { passive: false });
      canvas.addEventListener("touchend", () => { drawing = false; });

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
    m.querySelector("#bjShare").addEventListener("click", () => shareJob(job));
    m.querySelector("#bjInvoice").addEventListener("click", () =>
      exportInvoicePDF(job),
    );
    m.querySelector("#bjPDF").addEventListener("click", () =>
      exportJobPDF(job),
    );
    m.querySelector("#bjCert").addEventListener("click", () =>
      exportCompletionCertPDF(job),
    );
    m.querySelector("#bjClose").addEventListener("click", modal.close);
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
        .catch(() =>
          toast.error("Save error", "Could not save template."),
        );
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
                    const jobs = state.jobs.filter((j) =>
                      j.clientId === c.id || j.client?.toLowerCase() === c.name?.toLowerCase()
                    );
                    const totalVal = jobs.reduce((s, j) => s + (j.value || 0), 0);
                    return `
                  <tr>
                    <td><strong>${esc(c.name)}</strong>${c.notes ? `<br><span class="small muted">${esc(c.notes)}</span>` : ""}</td>
                    <td>${c.phone ? `<a href="tel:${esc(c.phone)}" class="link">${esc(c.phone)}</a>` : `<span class="muted">—</span>`}</td>
                    <td>${c.email ? `<a href="mailto:${esc(c.email)}" class="link">${esc(c.email)}</a>` : `<span class="muted">—</span>`}</td>
                    <td style="text-align:right;">${jobs.length}</td>
                    <td style="text-align:right;">${fmt(totalVal)}</td>
                    <td>
                      <div style="display:flex;gap:5px;">
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

    root.querySelector("#btnNC")?.addEventListener("click", () => openClientModal(null));
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
          idb.del(APP.stores.clients, c.id)
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
      if (!name) { nEl.classList.add("invalid"); nEl.focus(); return; }
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
    const unpaidAmt = state.jobs.filter((j) => j.status === "Invoiced" && j.paymentStatus !== "Paid").reduce((s, j) => s + (j.value || 0), 0);
    const paidAmt = state.jobs.filter((j) => j.paymentStatus === "Paid").reduce((s, j) => s + (j.value || 0), 0);
    const leadCount = state.estimates.filter((e) => e.status === "Draft" || e.status === "Sent").length;
    const approvedEst = state.estimates.filter((e) => e.status === "Approved").reduce((s, e) => s + (e.value || 0), 0);
    const lowStockCount = state.inventory.filter((i) => (i.quantity || 0) <= (i.minStock || 0)).length;

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
          <div class="kpiVal" style="color:${lowStockCount > 0 ? "var(--warn)" : "var(--ok)"}">${state.crew.filter(c=>c.status==="Active").length}</div>
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
                  const overdue =
                    j.deadline &&
                    j.deadline < now &&
                    !["Completed", "Invoiced"].includes(j.status);
                  return `
              <div class="jobRow" data-detail="${j.id}">
                <div class="jobRowMain">
                  <strong>${esc(j.name)}</strong>
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
        const payBadge = j.status === "Invoiced"
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
      ${allTags.length ? `
      <div class="tagFilterBar">
        <button type="button" class="tagFilterPill${!state.tagFilter ? " active" : ""}" data-tag="">All Tags</button>
        ${allTags.map((t) => `<button type="button" class="tagFilterPill${state.tagFilter === t ? " active" : ""}" data-tag="${esc(t)}">${esc(t)}</button>`).join("")}
      </div>` : ""}
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

    root.querySelector("#btnNJ")?.addEventListener("click", () => openJobModal(null));
    root.querySelector("#btnExportAllPDF")?.addEventListener("click", exportAllPDF);
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
    root.querySelectorAll("th.sortable").forEach((thEl) =>
      thEl.addEventListener("click", () => {
        const col = thEl.dataset.sort;
        state.sort =
          state.sort.col === col
            ? { col, dir: state.sort.dir === "asc" ? "desc" : "asc" }
            : { col, dir: "asc" };
        render();
      }),
    );
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
    const opts = jobList.length
      ? jobList
          .map(
            (j) =>
              `<option value="${j.id}" ${state.fieldSession.data?.jobId === j.id ? "selected" : ""}>${esc(j.name)}</option>`,
          )
          .join("")
      : `<option value="">No jobs available</option>`;

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
                    wxLine = `<br><span class="weatherLine">${weatherIcon(wx.code)} ${wx.temp}°F · ${wx.desc} · 💨 ${wx.wind} mph${wx.precip > 0 ? ` · 🌧 ${wx.precip}"` : ""}${wx.humidity!=null?` · 💧${wx.humidity}%`:""}</span>`;
                    if (wx.humidity != null) {
                      const hi = calcHeatIndex(wx.temp, wx.humidity);
                      const hil = heatIndexLevel(hi);
                      if (hil) {
                        wxLine += `<div class="heatAlert" style="background:${hil.color}22;color:${hil.color};margin-top:4px;">${hil.emoji} Heat Index: ${hi}°F — ${hil.level}</div>`;
                      }
                    }
                  }
                  const hurricaneNote = isHurricaneSeason() ? `<div class="muted" style="font-size:11px;margin-top:4px;">🌀 Hurricane season active — stay alert</div>` : "";
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
                let wxContent = `<span class="weatherLine">${weatherIcon(wx.code)} ${wx.temp}°F · ${wx.desc} · 💨 ${wx.wind} mph${wx.precip > 0 ? ` · 🌧 ${wx.precip}"` : ""}${wx.humidity!=null?` · 💧${wx.humidity}%`:""}</span>`;
                if (wx.humidity != null) {
                  const hi = calcHeatIndex(wx.temp, wx.humidity);
                  const hil = heatIndexLevel(hi);
                  if (hil) wxContent += `<div class="heatAlert" style="background:${hil.color}22;color:${hil.color};">${hil.emoji} Heat Index: ${hi}°F — ${hil.level}</div>`;
                }
                const hurricaneNote = isHurricaneSeason() ? `<div class="muted" style="font-size:11px;margin-top:4px;">🌀 Hurricane season active — stay alert</div>` : "";
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
            toast.warn(
              "GPS unavailable",
              "Session started without coordinates.",
            );
          },
          { timeout: 8000 },
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
        };
        clearInterval(state.liveTimer);
        state.liveTimer = null;
        idb
          .put(APP.stores.timeLogs, log)
          .then(() => {
            state.timeLogs.push(log);
            state.fieldSession.active = false;
            state.fieldSession.data = null;
            toast.success(
              "Session saved",
              `${hrs.toFixed(2)} hours logged.`,
            );
            renderFieldApp(root);
          })
          .catch(() =>
            toast.error("Error", "Could not save time log."),
          );
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
    root.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px;max-width:600px;">

        <div class="card">
          <div class="cardHeader"><div class="cardTitle">Access & Profile</div></div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:14px;">
            <div class="fieldGrid">
              <div class="field">
                <label for="selRole">Access Level</label>
                <select id="selRole">
                  <option value="admin" ${state.settings.role === "admin" ? "selected" : ""}>Administrator — full access</option>
                  <option value="field" ${state.settings.role === "field" ? "selected" : ""}>Field Worker — Dashboard & Field only</option>
                </select>
              </div>
              <div class="field">
                <label for="selCompany">Company Name</label>
                <input id="selCompany" class="input" type="text" maxlength="100"
                  placeholder="Appears on exported PDFs"
                  value="${esc(state.settings.company || "")}"/>
              </div>
            </div>
            <button class="btn primary" id="btnSave">Save Settings</button>
          </div>
        </div>

        <div class="card">
          <div class="cardHeader"><div class="cardTitle">Job Defaults</div></div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:14px;">
            <div class="fieldGrid">
              <div class="field">
                <label for="selInvPrefix">Invoice Prefix</label>
                <input id="selInvPrefix" class="input" type="text" maxlength="10"
                  placeholder="e.g. INV"
                  value="${esc(state.settings.invoicePrefix || "INV")}"/>
                <p class="help" style="margin-top:4px;">Next: <strong>${getNextInvoiceNumberPreview()}</strong></p>
              </div>
              <div class="field">
                <label for="selMarkup">Default Markup (%)</label>
                <input id="selMarkup" class="input" type="number" min="0" step="0.1"
                  placeholder="0"
                  value="${state.settings.defaultMarkup || 0}"/>
                <p class="help" style="margin-top:4px;">Shown as target margin in job modal.</p>
              </div>
              <div class="field">
                <label for="selMileage">IRS Mileage Rate ($/mile)</label>
                <input id="selMileage" class="input" type="number" min="0" step="0.001"
                  placeholder="0.670"
                  value="${state.settings.mileageRate || 0.67}"/>
                <p class="help" style="margin-top:4px;">2024 IRS standard rate: $0.67/mile.</p>
              </div>
              <div class="field">
                <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                  <input id="selNotify" type="checkbox" ${state.settings.notificationsEnabled ? "checked" : ""} style="width:18px;height:18px;cursor:pointer;"/>
                  <span>Enable Deadline Notifications</span>
                </label>
                <p class="help" style="margin-top:4px;">Browser notifications for overdue &amp; upcoming jobs.</p>
              </div>
            </div>
            <button class="btn primary" id="btnSaveDefaults">Save Defaults</button>
          </div>
        </div>

        <div class="card">
          <div class="cardHeader"><div class="cardTitle">Export &amp; Import</div></div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:12px;">
            <div class="row" style="flex-wrap:wrap;gap:8px;">
              <button class="btn" id="btnSExp">
                <svg viewBox="0 0 24 24" fill="none" width="16" height="16"><path d="M12 3v10M8 9l4 4 4-4M5 21h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
                JSON Backup
              </button>
              <button class="btn" id="btnSCSV">
                <svg viewBox="0 0 24 24" fill="none" width="16" height="16"><path d="M12 3v10M8 9l4 4 4-4M5 21h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
                Export CSV
              </button>
              <button class="btn" id="btnAllPDF">
                <svg viewBox="0 0 24 24" fill="none" width="16" height="16"><path d="M7 7h10M7 12h10M7 17h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.6"/></svg>
                Full Report PDF
              </button>
              <button class="btn" id="btnSImp">
                <svg viewBox="0 0 24 24" fill="none" width="16" height="16"><path d="M12 21V11M8 15l4-4 4 4M5 3h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
                Import Backup
              </button>
              <input type="file" id="fileImport" accept=".json" style="display:none;"/>
            </div>
            <p class="help">JSON backup includes jobs, hours, and templates. Import merges data without deleting existing records.</p>
          </div>
        </div>

        <div class="card">
          <div class="cardHeader"><div class="cardTitle">Danger Zone</div></div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:12px;">
            <button class="btn danger" id="btnClear">Clear All Data</button>
            <p class="help" style="color:var(--danger);">Permanently removes all jobs, hours, templates, and clients. Export a backup first!</p>
          </div>
        </div>

        <div class="card">
          <div class="cardHeader"><div class="cardTitle">About</div></div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:6px;">
            <div><strong>JobCost Pro</strong> <span class="muted">v3.0</span></div>
            <div class="muted">Offline-first · No backend · 100% local data (IndexedDB)</div>
            <div class="hr"></div>
            <div class="small">${state.jobs.length} jobs · ${state.timeLogs.length} time logs · ${state.templates.length} templates · ${state.clients.length} clients</div>
            <div class="small">Shortcuts: <code class="kbd">Ctrl+K</code> search · <code class="kbd">Ctrl+N</code> new job · <code class="kbd">Esc</code> close modal</div>
          </div>
        </div>

      </div>`;

    root.querySelector("#btnSave")?.addEventListener("click", () => {
      state.settings.role = root.querySelector("#selRole").value;
      state.settings.company = root.querySelector("#selCompany").value.trim();
      ls(APP.lsKey).save(state.settings);
      document.body.setAttribute("data-role", state.settings.role);
      if (state.settings.role === "field") {
        routeTo("field");
      } else {
        toast.success("Settings saved", "Preferences updated.");
      }
    });

    root.querySelector("#btnSaveDefaults")?.addEventListener("click", () => {
      state.settings.invoicePrefix = root.querySelector("#selInvPrefix").value.trim() || "INV";
      state.settings.defaultMarkup = parseFloat(root.querySelector("#selMarkup").value) || 0;
      state.settings.mileageRate = parseFloat(root.querySelector("#selMileage").value) || 0.67;
      const notifyEl = root.querySelector("#selNotify");
      const wasEnabled = state.settings.notificationsEnabled;
      state.settings.notificationsEnabled = notifyEl.checked;
      if (notifyEl.checked && !wasEnabled && Notification.permission === "default") {
        Notification.requestPermission().then((p) => {
          if (p === "granted") toast.success("Notifications enabled", "You'll receive deadline alerts.");
          else toast.warn("Permission denied", "Allow notifications in your browser settings.");
        });
      }
      ls(APP.lsKey).save(state.settings);
      toast.success("Defaults saved", "Job defaults updated.");
      render();
    });

    root.querySelector("#btnSExp")?.addEventListener("click", doExport);
    root.querySelector("#btnSCSV")?.addEventListener("click", exportCSV);
    root.querySelector("#btnAllPDF")?.addEventListener("click", exportAllPDF);
    root
      .querySelector("#btnSImp")
      ?.addEventListener("click", () =>
        root.querySelector("#fileImport").click(),
      );

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
            ...(data.timeLogs || []).map((l) =>
              idb.put(APP.stores.timeLogs, l),
            ),
            ...(data.templates || []).map((t) =>
              idb.put(APP.stores.templates, t),
            ),
          ])
            .then(() =>
              Promise.all([
                idb.getAll(APP.stores.jobs),
                idb.getAll(APP.stores.timeLogs),
                idb.getAll(APP.stores.templates),
              ]),
            )
            .then(([jobs, tl, tpls]) => {
              state.jobs = jobs;
              state.timeLogs = tl;
              state.templates = tpls;
              toast.success(
                "Import complete",
                `${data.jobs.length} jobs imported.`,
              );
              render();
            })
            .catch(() =>
              toast.error("Error", "Failed to save imported data."),
            );
        } catch {
          toast.error(
            "Import failed",
            "Could not read the JSON file.",
          );
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
              toast.warn("Data cleared", "All data has been deleted.");
              render();
            })
            .catch(() => toast.error("Error", "Failed to clear data."));
        },
      );
    });
  }

  /* ─── Estimates ──────────────────────────────── */
  function renderEstimates(root) {
    const STATUSES = ["All","Draft","Sent","Approved","Declined"];
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
      ${list.length === 0
        ? `<div class="empty">No estimates yet. Create one to start your sales pipeline.</div>`
        : `<div class="tableWrap"><table class="table">
            <thead><tr>
              <th>Estimate #</th><th>Client</th><th>Insulation Type</th><th>Area</th>
              <th style="text-align:right;">Est. Value</th>
              <th>Created</th><th>Status</th><th>Actions</th>
            </tr></thead>
            <tbody>
              ${list.map((e) => `
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
                    <button class="btn danger admin-only" data-edel="${e.id}" style="padding:5px 9px;font-size:12px;">Delete</button>
                  </div>
                </td>
              </tr>`).join("")}
            </tbody>
          </table></div>`
      }`;

    root.querySelector("#btnNE")?.addEventListener("click", () => openEstimateModal(null));
    root.querySelectorAll(".filterPill[data-ef]").forEach((btn) =>
      btn.addEventListener("click", () => { state._estFilter = btn.dataset.ef; render(); })
    );
    root.querySelectorAll("[data-ee]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const e = state.estimates.find((x) => x.id === btn.dataset.ee);
        if (e) openEstimateModal(e);
      })
    );
    root.querySelectorAll("[data-econvert]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const e = state.estimates.find((x) => x.id === btn.dataset.econvert);
        if (!e) return;
        const job = {
          id: uid(), name: e.client ? `${e.client} – ${e.insulationType || "Insulation"}` : (e.name || "New Job"),
          client: e.client || "", status: "Draft", value: e.value || 0,
          insulationType: e.insulationType || "", areaType: e.areaType || "",
          sqft: e.sqft || null, rValueTarget: e.rValueTarget || null,
          city: e.city || "", state: e.state || "", zip: e.zip || "",
          notes: e.notes || "", taxRate: e.taxRate || 0,
          date: Date.now(), costs: [], photos: [], tags: [],
          paymentStatus: "Unpaid", statusHistory: [{ status: "Draft", date: Date.now() }],
          checklist: {}, mileage: 0,
        };
        saveJob(job).then(() => {
          const updated = { ...e, status: "Approved" };
          saveEstimate(updated).then(() => {
            toast.success("Job created", job.name);
            routeTo("jobs");
          });
        });
      })
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
      })
    );
  }

  function openEstimateModal(est) {
    const isEdit = !!est;
    const INST = ["Blown-in Fiberglass","Blown-in Cellulose","Spray Foam Open Cell","Spray Foam Closed Cell","Batt Fiberglass","Batt Mineral Wool","Radiant Barrier","Other"];
    const AREAS = ["Attic","Walls","Crawl Space","Garage","New Construction","Other"];
    const EST_STATUS = ["Draft","Sent","Approved","Declined"];

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
        <button type="button" class="btn primary" id="eSave">${isEdit ? "Save Changes" : "Create Estimate"}</button>
      </div>`);

    m.querySelector("#eZip")?.addEventListener("blur", () => {
      lookupZIP(m.querySelector("#eZip").value, (city, st) => {
        if (!m.querySelector("#eCity").value) m.querySelector("#eCity").value = city;
        if (!m.querySelector("#eSt").value) m.querySelector("#eSt").value = st;
      });
    });
    m.querySelector("#eCancel").addEventListener("click", modal.close);
    m.querySelector("#eSave").addEventListener("click", () => {
      const clEl = m.querySelector("#eCl");
      if (!clEl.value.trim()) { clEl.classList.add("invalid"); clEl.focus(); return; }
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
      saveEstimate(saved).then(() => {
        toast.success(isEdit ? "Estimate updated" : "Estimate created", saved.name);
        modal.close();
        render();
      }).catch(() => toast.error("Save error", "Could not save estimate."));
    });
  }

  /* ─── Crew ───────────────────────────────────── */
  function renderCrew(root) {
    const sorted = [...state.crew].sort((a, b) => a.name.localeCompare(b.name));
    root.innerHTML = `
      <div class="pageHeader">
        <h2 class="pageTitle">Crew &amp; Technicians <span class="muted" style="font-size:14px;font-weight:400;">(${sorted.length})</span></h2>
        <button class="btn primary admin-only" id="btnNCr">+ Add Member</button>
      </div>
      ${sorted.length === 0
        ? `<div class="empty">No crew members yet. Add your installers and technicians.</div>`
        : `<div class="tableWrap"><table class="table">
            <thead><tr>
              <th>Name</th><th>Role</th><th>Phone</th><th>Email</th>
              <th>Certifications</th><th>Status</th><th>Actions</th>
            </tr></thead>
            <tbody>
              ${sorted.map((c) => {
                const jobCount = state.jobs.filter((j) => (j.crewIds || []).includes(c.id)).length;
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
              }).join("")}
            </tbody>
          </table></div>`
      }`;

    root.querySelector("#btnNCr")?.addEventListener("click", () => openCrewModal(null));
    root.querySelectorAll("[data-ecr]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const c = state.crew.find((x) => x.id === btn.dataset.ecr);
        if (c) openCrewModal(c);
      })
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
      })
    );
  }

  function openCrewModal(member) {
    const isEdit = !!member;
    const ROLES = ["Lead Installer","Installer","Helper","Foreman","Supervisor"];
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
      if (!nEl.value.trim()) { nEl.classList.add("invalid"); nEl.focus(); return; }
      nEl.classList.remove("invalid");
      const saved = {
        id: isEdit ? member.id : uid(),
        name: nEl.value.trim(),
        role: m.querySelector("#crR").value,
        status: m.querySelector("#crS").value,
        phone: m.querySelector("#crPh").value.trim(),
        email: m.querySelector("#crEm").value.trim(),
        certifications: m.querySelector("#crCert").value.trim(),
        notes: m.querySelector("#crNo").value.trim(),
        date: isEdit ? member.date : Date.now(),
      };
      saveCrewMember(saved).then(() => {
        toast.success(isEdit ? "Member updated" : "Member added", saved.name);
        modal.close();
        render();
      }).catch(() => toast.error("Save error", "Could not save crew member."));
    });
  }

  /* ─── Inventory ──────────────────────────────── */
  function renderInventory(root) {
    const lowItems = state.inventory.filter((i) => i.quantity <= i.minStock && i.quantity > 0);
    const outItems = state.inventory.filter((i) => i.quantity <= 0);
    const sorted = [...state.inventory].sort((a, b) => a.name.localeCompare(b.name));
    const totalValue = sorted.reduce((s, i) => s + (i.quantity || 0) * (i.unitCost || 0), 0);

    root.innerHTML = `
      <div class="pageHeader">
        <h2 class="pageTitle">Material Inventory <span class="muted" style="font-size:14px;font-weight:400;">(${sorted.length} items)</span></h2>
        <div style="display:flex;gap:8px;align-items:center;">
          <span class="muted" style="font-size:13px;">Stock value: <strong>${fmt(totalValue)}</strong></span>
          <button class="btn primary admin-only" id="btnNInv">+ Add Item</button>
        </div>
      </div>
      ${outItems.length ? `<div class="alertBanner">🚫 ${outItems.length} item(s) out of stock: ${outItems.slice(0,3).map((i) => `<strong>${esc(i.name)}</strong>`).join(", ")}</div>` : ""}
      ${lowItems.length ? `<div class="alertBanner" style="background:rgba(255,204,102,.12);border-color:rgba(255,204,102,.3);color:var(--warn);">⚠ ${lowItems.length} item(s) low on stock: ${lowItems.slice(0,3).map((i) => `<strong>${esc(i.name)}</strong>`).join(", ")}</div>` : ""}
      ${sorted.length === 0
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
              ${sorted.map((item) => {
                const totalVal = (item.quantity || 0) * (item.unitCost || 0);
                const status = item.quantity <= 0 ? "out" : item.quantity <= item.minStock ? "low" : "instock";
                const statusLabel = status === "out" ? "Out of Stock" : status === "low" ? "Low Stock" : "In Stock";
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
              }).join("")}
            </tbody>
          </table></div>`
      }`;

    root.querySelector("#btnNInv")?.addEventListener("click", () => openInventoryModal(null));
    root.querySelectorAll("[data-einv]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const item = state.inventory.find((x) => x.id === btn.dataset.einv);
        if (item) openInventoryModal(item);
      })
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
      })
    );
  }

  function openInventoryModal(item) {
    const isEdit = !!item;
    const CATS = ["Blown-in Fiberglass","Blown-in Cellulose","Spray Foam","Batt Insulation","Radiant Barrier","Equipment","Accessories","Other"];
    const UNITS = ["bags","rolls","sets","board-ft","each","lbs","sq ft"];
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
            <input id="invQty" class="input" type="number" min="0" step="1" placeholder="0" value="${isEdit ? item.quantity ?? 0 : 0}"/></div>
          <div class="field"><label for="invMin">Min Stock Level <span class="muted">(alert threshold)</span></label>
            <input id="invMin" class="input" type="number" min="0" step="1" placeholder="5" value="${isEdit ? item.minStock ?? 5 : 5}"/></div>
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
      if (!nEl.value.trim()) { nEl.classList.add("invalid"); nEl.focus(); return; }
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
      saveInventoryItem(saved).then(() => {
        toast.success(isEdit ? "Item updated" : "Item added", saved.name);
        modal.close();
        render();
      }).catch(() => toast.error("Save error", "Could not save item."));
    });
  }

  /* ─── Kanban Pipeline ────────────────────────── */
  function renderKanban(root) {
    const COLS = [
      { status: "Lead",      color: "#7f8aa3", label: "Leads" },
      { status: "Quoted",    color: "#bb86fc", label: "Quoted" },
      { status: "Draft",     color: "#aab5cc", label: "Draft" },
      { status: "Active",    color: "#7aa2ff", label: "Active" },
      { status: "Completed", color: "#4be3a3", label: "Completed" },
      { status: "Invoiced",  color: "#ffcc66", label: "Invoiced" },
    ];

    const byStatus = {};
    COLS.forEach((c) => { byStatus[c.status] = []; });
    state.jobs.forEach((j) => {
      if (byStatus[j.status]) byStatus[j.status].push(j);
    });

    const now = Date.now();

    root.innerHTML = `
      <div class="pageHeader">
        <h2 class="pageTitle">Job Pipeline</h2>
        <button class="btn primary admin-only" id="btnKNJ">+ New Job</button>
      </div>
      <div class="kanbanBoard">
        ${COLS.map((col) => {
          const jobs = byStatus[col.status] || [];
          const colVal = jobs.reduce((s, j) => s + (j.value || 0), 0);
          return `
          <div class="kanbanCol">
            <div class="kanbanColHd" style="border-top:3px solid ${col.color};">
              <span style="color:${col.color};">${col.label}</span>
              <span class="kanbanCount">${jobs.length}</span>
            </div>
            ${colVal > 0 ? `<div style="padding:4px 14px 0;font-size:11px;color:var(--muted);">${fmt(colVal)}</div>` : ""}
            <div class="kanbanCards">
              ${jobs.length === 0
                ? `<div style="font-size:11px;color:var(--faint);text-align:center;padding:8px 0;">Empty</div>`
                : jobs.map((j) => {
                    const overdue = j.deadline && j.deadline < now && !["Completed","Invoiced"].includes(j.status);
                    const STATUS_NEXT = { Lead: "Quoted", Quoted: "Draft", Draft: "Active", Active: "Completed", Completed: "Invoiced", Invoiced: null };
                    const nextStatus = STATUS_NEXT[j.status];
                    return `
                    <div class="kanbanCard" data-kdetail="${j.id}">
                      <div class="kanbanCardTitle">${esc(j.name)}</div>
                      <div class="kanbanCardMeta">
                        ${j.client ? `<span>${esc(j.client)}</span>` : ""}
                        ${j.insulationType ? `<span>${esc(j.insulationType)}</span>` : ""}
                        ${j.sqft ? `<span>${j.sqft} sq ft</span>` : ""}
                        ${j.deadline ? `<span class="${overdue ? "deadlineWarn" : ""}">📅 ${fmtDate(j.deadline)}${overdue ? " ⚠" : ""}</span>` : ""}
                      </div>
                      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px;">
                        <span class="kanbanCardVal">${fmt(j.value)}</span>
                        ${nextStatus ? `<button class="btn" data-kmove="${j.id}" data-knext="${nextStatus}" style="padding:2px 8px;font-size:11px;">→ ${nextStatus}</button>` : ""}
                      </div>
                    </div>`;
                  }).join("")
              }
            </div>
          </div>`;
        }).join("")}
      </div>`;

    root.querySelector("#btnKNJ")?.addEventListener("click", () => openJobModal(null));
    root.querySelectorAll("[data-kdetail]").forEach((el) =>
      el.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        const j = state.jobs.find((x) => x.id === el.dataset.kdetail);
        if (j) openJobDetailModal(j);
      })
    );
    root.querySelectorAll("[data-kmove]").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const j = state.jobs.find((x) => x.id === btn.dataset.kmove);
        if (!j) return;
        const newStatus = btn.dataset.knext;
        const updated = {
          ...j, status: newStatus,
          statusHistory: [...(j.statusHistory || []), { status: newStatus, date: Date.now() }],
          invoiceNumber: newStatus === "Invoiced" && !j.invoiceNumber ? getNextInvoiceNumber() : j.invoiceNumber,
        };
        saveJob(updated).then(() => { toast.success("Status updated", `${j.name} → ${newStatus}`); render(); });
      })
    );
  }

  init();
})();

