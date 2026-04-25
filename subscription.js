/**
 * subscription.js — Paywall & Stripe integration for JobCost Pro
 *
 * HOW IT WORKS (no backend required):
 *   1. User clicks "Subscribe Now" → redirected to Stripe Payment Link.
 *   2. Stripe charges the card and redirects back to:
 *        https://YOUR-DOMAIN/?subscribed=true
 *   3. On next load, showSubscriptionWall() detects ?subscribed=true,
 *      calls activateSubscription(), clears the querystring, and unlocks the app.
 *
 * STRIPE DASHBOARD SETUP:
 *   • Payment Link → After payment → "Redirect customers to your website"
 *   • Redirect URL: https://YOUR-DOMAIN/?subscribed=true
 *   • Replace STRIPE_PAYMENT_LINK below with your actual Stripe Payment Link URL.
 */

import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { db, auth } from "./firebase-config.js";
import { logoutUser } from "./firebase-config.js";

// ─── REPLACE THIS with your real Stripe Payment Link ──────────────────────────
const STRIPE_PAYMENT_LINK = "https://buy.stripe.com/SEU_LINK_AQUI";
// ──────────────────────────────────────────────────────────────────────────────

/**
 * checkSubscription(uid)
 * Reads subscriptions/{uid} from Firestore.
 * Returns true only if document exists and status === "active".
 */
/* ─── Email whitelist — free access, no subscription required ── */
const FREE_ACCESS_EMAILS = [
  "kaua.honorato10@gmail.com",           // Owner — testing account
  "info@kinginsulationfl.com",           // Partner company — free access
];

/**
 * checkSubscription(uid)
 * Returns true if the user has an active subscription OR is on the whitelist.
 */
export async function checkSubscription(uid) {
  /* Whitelist check — instant, no Firestore query needed */
  const email = auth.currentUser?.email?.toLowerCase().trim();
  if (email && FREE_ACCESS_EMAILS.map(e => e.toLowerCase()).includes(email)) {
    console.log("[Subscription] Whitelist access granted for:", email);
    return true;
  }

  /* Regular Firestore subscription check */
  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 8000)
    );
    const snap = await Promise.race([
      getDoc(doc(db, "subscriptions", uid)),
      timeout,
    ]);
    if (!snap.exists()) return false;
    return snap.data()?.status === "active";
  } catch (err) {
    console.error("[Subscription] checkSubscription failed:", err);
    return false;
  }
}

/**
 * activateSubscription(uid)
 * Writes/merges the subscription document for this user.
 * Called automatically when ?subscribed=true is detected in the URL.
 */
export async function activateSubscription(uid) {
  try {
    await setDoc(
      doc(db, "subscriptions", uid),
      {
        status: "active",
        plan: "pro",
        price: 19,
        currency: "usd",
        ownerId: uid,
        activatedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  } catch (err) {
    console.error("[Subscription] activateSubscription failed:", err);
    throw err;
  }
}

/**
 * showSubscriptionWall(onSuccess)
 * Renders the paywall overlay.
 * If URL contains ?subscribed=true, activates the subscription silently
 * and calls onSuccess() without showing the wall.
 */
export async function showSubscriptionWall(onSuccess) {
  const user = auth.currentUser;

  /* ── Handle Stripe redirect return ── */
  localStorage.removeItem("demoMode");
  window.__demoMode = false;
  const params = new URLSearchParams(location.search);
  if (params.get("subscribed") === "true" && user) {
    try {
      await activateSubscription(user.uid);
      /* Clean up the querystring so it doesn't linger */
      history.replaceState({}, "", location.pathname);
      onSuccess();
      return;
    } catch {
      /* Fall through to show the wall if activation failed */
    }
  }

  /* ── Build paywall DOM ── */
  const wall = document.createElement("div");
  wall.id = "subscriptionWall";
  wall.innerHTML = `
    <div class="sw-bg">
      <div class="sw-orb sw-orb1"></div>
      <div class="sw-orb sw-orb2"></div>
      <div class="sw-orb sw-orb3"></div>
      <div class="sw-dots"></div>
    </div>

    <div class="sw-card">
      <!-- Branding -->
      <div class="sw-brand">
        <svg width="38" height="38" viewBox="0 0 24 24" fill="none">
          <path d="M4 7.5C4 6.12 5.12 5 6.5 5h11C18.88 5 20 6.12 20 7.5v9c0 1.38-1.12 2.5-2.5 2.5h-11C5.12 19 4 17.88 4 16.5v-9Z"
            stroke="var(--primary)" stroke-width="1.6"/>
          <path d="M7 9h10M7 12h6M7 15h8" stroke="var(--primary)" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
        <span class="sw-brand-name">JobCost Pro</span>
      </div>

      <!-- Headline -->
      <h1 class="sw-title">
        Unlock the full<br>
        <span class="sw-title-gradient">professional toolkit</span>
      </h1>
      <p class="sw-subtitle">Everything you need to run a field service business — estimates, crew, invoices, analytics and more.</p>

      <!-- Feature grid -->
      <div class="sw-features">
        <div class="sw-feature">
          <span class="sw-feature-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/>
            </svg>
          </span>
          <div>
            <div class="sw-feature-title">Unlimited Jobs &amp; Clients</div>
            <div class="sw-feature-sub">No caps, no limits</div>
          </div>
          <span class="sw-check">✓</span>
        </div>
        <div class="sw-feature">
          <span class="sw-feature-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </span>
          <div>
            <div class="sw-feature-title">Crew &amp; Time Tracking</div>
            <div class="sw-feature-sub">GPS clock-in, logs</div>
          </div>
          <span class="sw-check">✓</span>
        </div>
        <div class="sw-feature">
          <span class="sw-feature-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
            </svg>
          </span>
          <div>
            <div class="sw-feature-title">Estimates &amp; Invoicing</div>
            <div class="sw-feature-sub">PDF, e-sign, email</div>
          </div>
          <span class="sw-check">✓</span>
        </div>
        <div class="sw-feature">
          <span class="sw-feature-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
            </svg>
          </span>
          <div>
            <div class="sw-feature-title">Analytics &amp; Pipeline</div>
            <div class="sw-feature-sub">Charts, Kanban board</div>
          </div>
          <span class="sw-check">✓</span>
        </div>
        <div class="sw-feature">
          <span class="sw-feature-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>
            </svg>
          </span>
          <div>
            <div class="sw-feature-title">Inventory &amp; Pricebook</div>
            <div class="sw-feature-sub">Materials calculator</div>
          </div>
          <span class="sw-check">✓</span>
        </div>
        <div class="sw-feature">
          <span class="sw-feature-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>
            </svg>
          </span>
          <div>
            <div class="sw-feature-title">Offline-First PWA</div>
            <div class="sw-feature-sub">Works without internet</div>
          </div>
          <span class="sw-check">✓</span>
        </div>
      </div>

      <!-- Price block -->
      <div class="sw-price-block">
        <div class="sw-price"><span class="sw-price-amount">$19</span><span class="sw-price-period"> / month</span></div>
        <div class="sw-price-note">Cancel anytime · Secure checkout via Stripe</div>
      </div>

      <!-- CTA button -->
      <button class="sw-cta" id="swCtaBtn" type="button">
        <span id="swCtaLabel">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style="vertical-align:-3px;margin-right:6px">
            <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" stroke-width="1.8"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
          Subscribe Now · $19/month
        </span>
        <span id="swCtaSpinner" class="sw-spinner" hidden></span>
      </button>

      <!-- Explore button -->
      <button class="sw-explore" id="swExploreBtn" type="button">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px">
          <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
        </svg>
        Explore the App — Free Preview
      </button>

      <!-- Sign out -->
      <button class="sw-signout" id="swSignOut" type="button">
        Signed in as <strong>${user?.email || "unknown"}</strong> — Sign out
      </button>
    </div>`;

  document.body.appendChild(wall);

  /* ── CTA click → redirect to Stripe ── */
  document.getElementById("swCtaBtn").addEventListener("click", () => {
    const btn     = document.getElementById("swCtaBtn");
    const label   = document.getElementById("swCtaLabel");
    const spinner = document.getElementById("swCtaSpinner");
    btn.disabled  = true;
    label.hidden  = true;
    spinner.hidden = false;

    const email = encodeURIComponent(user?.email || "");
    const url   = `${STRIPE_PAYMENT_LINK}?prefilled_email=${email}`;
    window.location.href = url;
  });

  /* ── Explore (demo mode) ── */
  document.getElementById("swExploreBtn").addEventListener("click", () => {
    wall.remove();
    window.__demoMode = true;
    localStorage.setItem("demoMode", "1");
    onSuccess();
  });

  /* ── Sign out ── */
  document.getElementById("swSignOut").addEventListener("click", async () => {
    wall.remove();
    await logoutUser();
    /* onAuthStateChanged(null) will restore the login overlay */
  });
}
