(() => {
  "use strict";

  /* ─── Config ─────────────────────────────────── */
  const APP = {
    dbName: "jobcost_pro_db",
    dbVersion: 4,
    stores: { jobs: "jobs", timeLogs: "timeLogs", templates: "templates" },
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
  const fmtDateInput = (ts) =>
    ts ? new Date(ts).toISOString().slice(0, 10) : "";
  const parseDate = (s) => (s ? new Date(s).getTime() : null);
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
    settings: ls(APP.lsKey, {
      role: "admin",
      theme: "dark",
      company: "",
    }).load(),
    fieldSession: { active: false, data: null },
    search: "",
    sort: { col: "date", dir: "desc" },
    filter: "all",
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
      [state.jobs, state.timeLogs, state.templates] = await Promise.all([
        idb.getAll(APP.stores.jobs),
        idb.getAll(APP.stores.timeLogs),
        idb.getAll(APP.stores.templates),
      ]);
      bindUI();
      routeTo(location.hash.replace("#", "") || "dashboard", false);
      setTimeout(checkDeadlines, 1200);
      registerSW();
      /* Pre-load US holidays for current + next year */
      const yr = new Date().getFullYear();
      fetchUSHolidays(yr, (h) => { _holidays = h; });
      fetchUSHolidays(yr + 1, (h) => { _holidays = [..._holidays, ...h]; });
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
    if (overdue.length)
      toast.error(
        "Deadline overdue",
        `${overdue.length} job(s) past their deadline.`,
      );
    if (upcoming.length)
      toast.warn(
        "Deadline soon",
        `${upcoming.length} job(s) due within 3 days.`,
      );
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
      "field",
      "views",
      "settings",
      "templates",
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
      templates: renderTemplates,
      field: renderFieldApp,
      views: renderBI,
      settings: renderSettings,
    };
    (views[state.route] || renderDashboard)(wrap);
  }

  /* ─── Export JSON backup ─────────────────────── */
  function doExport() {
    const data = {
      jobs: state.jobs,
      timeLogs: state.timeLogs,
      templates: state.templates,
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
      `&current=temperature_2m,weathercode,windspeed_10m,precipitation` +
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
    };
    saveJob(copy).then(() => {
      toast.success("Job duplicated", copy.name);
      render();
    });
  }

  /* ─── Job Modal ──────────────────────────────── */
  function openJobModal(job) {
    const isEdit = !!job;
    const STATUS = ["Draft", "Active", "Completed", "Invoiced"];
    const tplOpts = state.templates.length
      ? `<option value="">— none —</option>` +
        state.templates
          .map((t) => `<option value="${t.id}">${esc(t.name)}</option>`)
          .join("")
      : null;

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
        <div class="fieldGrid">
          <div class="field">
            <label for="fjN">Job Name *</label>
            <input id="fjN" class="input" type="text" maxlength="120" placeholder="e.g. Kitchen Remodel" value="${isEdit ? esc(job.name) : ""}"/>
          </div>
          <div class="field">
            <label for="fjC">Client</label>
            <input id="fjC" class="input" type="text" maxlength="120" placeholder="Client name" value="${isEdit ? esc(job.client || "") : ""}"/>
          </div>
          <div class="field">
            <label for="fjSt">Status</label>
            <select id="fjSt">
              ${STATUS.map((s) => `<option value="${s}" ${(isEdit ? job.status : "Draft") === s ? "selected" : ""}>${s}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="fjV">Estimated Value ($)</label>
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
          ${
            !isEdit && tplOpts
              ? `
          <div class="field">
            <label for="fjT">Apply Template</label>
            <select id="fjT">${tplOpts}</select>
          </div>`
              : ""
          }
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

    /* ZIP code auto-fill */
    m.querySelector("#fjZip")?.addEventListener("blur", () => {
      const zip = m.querySelector("#fjZip").value.trim();
      lookupZIP(zip, (city, state) => {
        if (!m.querySelector("#fjCity").value) m.querySelector("#fjCity").value = city;
        if (!m.querySelector("#fjState").value) m.querySelector("#fjState").value = state;
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
      const newStatus = m.querySelector("#fjSt").value;

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

      const saved = {
        id: isEdit ? job.id : uid(),
        name,
        client: m.querySelector("#fjC").value.trim(),
        status: newStatus,
        value: parseFloat(m.querySelector("#fjV").value) || 0,
        startDate: parseDate(m.querySelector("#fjSD").value),
        deadline: parseDate(m.querySelector("#fjDL").value),
        estimatedHours: parseFloat(m.querySelector("#fjEH").value) || null,
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
      };

      saveJob(saved)
        .then(() => {
          toast.success(isEdit ? "Job updated" : "Job created", saved.name);
          modal.close();
          render();
        })
        .catch(() =>
          toast.error("Save error", "Could not save the job."),
        );
    });
  }

  /* ─── Job Detail Modal (tabbed) ──────────────── */
  function openJobDetailModal(job) {
    let tab = "overview";
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
        m = getMargin(),
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
            <strong style="color:${m >= 0 ? "var(--ok)" : "var(--danger)"}">
              ${fmt(m)}${pct !== null ? ` (${pct}%)` : ""}
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
        m = getMargin(),
        pct = getPct();
      const rows =
        costs.length === 0
          ? `<tr><td colspan="6" class="muted" style="padding:18px;text-align:center;">No cost items yet.</td></tr>`
          : costs
              .map(
                (c, i) => `
            <tr>
              <td>${esc(c.description)}</td>
              <td><span class="badge">${esc(c.category || "")}</span></td>
              <td style="text-align:right;">${c.qty}</td>
              <td style="text-align:right;">${fmt(c.unitCost)}</td>
              <td style="text-align:right;"><strong>${fmt((c.qty || 0) * (c.unitCost || 0))}</strong></td>
              <td>
                <button class="btn danger" data-dci="${i}" style="padding:4px 10px;font-size:11px;">Remove</button>
              </td>
            </tr>`,
              )
              .join("");
      return `
        <div class="tableWrap" style="margin-bottom:14px;">
          <table class="table">
            <thead><tr>
              <th>Description</th><th>Category</th>
              <th style="text-align:right;">Qty</th>
              <th style="text-align:right;">Unit Cost</th>
              <th style="text-align:right;">Total</th>
              <th></th>
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
            <strong style="color:${m >= 0 ? "var(--ok)" : "var(--danger)"}">
              ${fmt(m)}${pct !== null ? ` (${pct}%)` : ""}
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
      if (!logs.length)
        return `<div class="empty">No time logs for this job.</div>`;
      return `
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
        <div class="summaryRow">
          <span class="k">Total Logged</span>
          <strong>${total.toFixed(2)}h${job.estimatedHours ? ` / ${job.estimatedHours}h estimated` : ""}</strong>
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

    const TABS = ["overview", "costs", "timelogs", "photos"];
    const TAB_LABELS = {
      overview: "Overview",
      costs: "Costs",
      timelogs: "Hours",
      photos: "Photos",
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
        <button type="button" class="btn admin-only" id="bjShare">Share</button>
        <button type="button" class="btn admin-only" id="bjInvoice">Invoice PDF</button>
        <button type="button" class="btn primary admin-only" id="bjPDF">Report PDF</button>
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
      }
    }

    function bindCosts(root) {
      root.querySelectorAll("[data-dci]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = parseInt(btn.dataset.dci, 10);
          job.costs = (job.costs || []).filter((_, i) => i !== idx);
          saveJob(job).then(() => {
            switchTab("costs");
            render();
          });
        });
      });
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
          .catch(() =>
            toast.error("Save error", "Could not save cost item."),
          );
      });
    }

    function bindTimelogs(root) {
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
    m.querySelector("#bjShare").addEventListener("click", () => shareJob(job));
    m.querySelector("#bjInvoice").addEventListener("click", () =>
      exportInvoicePDF(job),
    );
    m.querySelector("#bjPDF").addEventListener("click", () =>
      exportJobPDF(job),
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

  /* ─── Dashboard ──────────────────────────────── */
  function renderDashboard(root) {
    const active = state.jobs.filter((j) => j.status === "Active").length;
    const completed = state.jobs.filter((j) => j.status === "Completed").length;
    const invoiced = state.jobs.filter((j) => j.status === "Invoiced").length;
    const totalVal = state.jobs.reduce((s, j) => s + (j.value || 0), 0);
    const totalCosts = state.jobs.reduce((s, j) => s + jobCost(j), 0);
    const totalHrs = state.timeLogs.reduce((s, l) => s + (l.hours || 0), 0);
    const totalMargin = totalVal - totalCosts;

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
        ${overdueJobs.length > 3 ? `e mais ${overdueJobs.length - 3}…` : ""}
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
          j.status.toLowerCase().includes(state.search),
      );

    /* Status filter */
    if (state.filter !== "all")
      base = base.filter((j) => j.status === state.filter);

    /* Date range filter */
    if (state.dateFilter.from)
      base = base.filter((j) => j.date >= state.dateFilter.from);
    if (state.dateFilter.to)
      base = base.filter((j) => j.date <= state.dateFilter.to + 86399999);

    const list = sorted(base);
    const now = Date.now();

    const rows = list
      .map((j) => {
        const tc = jobCost(j);
        const margin = (j.value || 0) - tc;
        const overdue =
          j.deadline &&
          j.deadline < now &&
          !["Completed", "Invoiced"].includes(j.status);
        const holiday = j.deadline ? isUSHoliday(j.deadline) : null;
        return `
        <tr data-detail="${j.id}">
          <td>
            <strong>${esc(j.name)}</strong>
            ${j.client ? `<br><span class="small">${esc(j.client)}</span>` : ""}
          </td>
          <td><span class="badge status-${j.status.toLowerCase()}">${j.status}</span></td>
          <td style="text-align:right;">${fmt(j.value)}</td>
          <td style="text-align:right;">${fmt(tc)}</td>
          <td style="text-align:right;color:${margin >= 0 ? "var(--ok)" : "var(--danger)"};">
            <strong>${fmt(margin)}</strong>
          </td>
          <td class="${overdue ? "deadlineCell overdue" : "deadlineCell"}">${j.deadline ? `${fmtDate(j.deadline)}${holiday ? ` <span title="${esc(holiday.localName)}">🎉</span>` : ""}` : `<span class="muted">—</span>`}</td>
          <td>${fmtDate(j.date)}</td>
          <td>
            <div style="display:flex;gap:5px;flex-wrap:wrap;">
              <button class="btn" data-detail="${j.id}" style="padding:5px 9px;font-size:12px;">View</button>
              <button class="btn admin-only" data-dup="${j.id}" style="padding:5px 9px;font-size:12px;">Copy</button>
              <button class="btn admin-only" data-edit="${j.id}" style="padding:5px 9px;font-size:12px;">Edit</button>
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
        list.length === 0
          ? `<div class="empty">${state.search || state.filter !== "all" || state.dateFilter.from || state.dateFilter.to ? "No jobs found with the applied filters." : "No jobs created yet."}</div>`
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
                  const wxLine = wx
                    ? `<br><span class="weatherLine">${weatherIcon(wx.code)} ${wx.temp}°F · ${wx.desc} · 💨 ${wx.wind} mph${wx.precip > 0 ? ` · 🌧 ${wx.precip}"` : ""}</span>`
                    : "";
                  return loc + wxLine;
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
                geoEl.innerHTML = `${addr ? `📍 ${esc(addr)}<br>` : ""}<span class="weatherLine">${weatherIcon(wx.code)} ${wx.temp}°F · ${wx.desc} · 💨 ${wx.wind} mph${wx.precip > 0 ? ` · 🌧 ${wx.precip}"` : ""}</span>`;
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
      <div style="display:flex;flex-direction:column;gap:14px;max-width:560px;">
        <div class="card">
          <div class="cardHeader"><div class="cardTitle">Access & Profile</div></div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:14px;">
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
            <button class="btn primary" id="btnSave">Save Settings</button>
          </div>
        </div>

        <div class="card">
          <div class="cardHeader"><div class="cardTitle">Export Reports</div></div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:12px;">
            <div class="row" style="flex-wrap:wrap;">
              <button class="btn" id="btnSExp">
                <svg viewBox="0 0 24 24" fill="none" width="16" height="16"><path d="M12 3v10M8 9l4 4 4-4M5 21h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
                JSON Backup
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
            <p class="help" style="color:var(--danger);">Permanently removes all jobs, hours, and templates. Export a backup first!</p>
          </div>
        </div>

        <div class="card">
          <div class="cardHeader"><div class="cardTitle">About</div></div>
          <div class="cardBody" style="display:flex;flex-direction:column;gap:6px;">
            <div><strong>JobCost Pro</strong> <span class="muted">v2.0</span></div>
            <div class="muted">Offline-first · No backend · 100% local data (IndexedDB)</div>
            <div class="hr"></div>
            <div class="small">${state.jobs.length} jobs · ${state.timeLogs.length} time logs · ${state.templates.length} templates</div>
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

    root.querySelector("#btnSExp")?.addEventListener("click", doExport);
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
        "This will permanently delete ALL jobs, time logs, and templates.",
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
              toast.warn("Data cleared", "All data has been deleted.");
              render();
            })
            .catch(() => toast.error("Error", "Failed to clear data."));
        },
      );
    });
  }

  init();
})();

