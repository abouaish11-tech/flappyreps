/* Flappy Reps — payment gate (Polar, no backend).
   OFF by default. Flip PAYWALL.enabled to true (or open ?paywall=1 to preview) when ready.
   Currently OFF because the Polar org has no payout account connected yet — turning this on
   before that step is done would lock every player out with no way to actually pay. Finish
   "Connect a payout account" at https://polar.sh/dashboard/flappy-reps, then flip enabled: true.

   How it works: Polar's License Keys benefit is attached to the "Flappy Reps Pro" subscription
   product. Checkout happens on Polar's hosted page (checkoutUrl below); the buyer sees their
   license key on Polar's confirmation page and pastes it in here, or looks it up anytime at
   the customer portal (portalUrl below) by email. Keys are verified with Polar's public
   Customer Portal API (activate/validate, no auth needed — safe to call from the browser).
   If the subscription lapses or is cancelled, Polar automatically revokes the key, so
   revalidate() will get a 404 and re-lock the game within revalidateDays + graceDays.
*/
window.Paywall = (() => {
  'use strict';

  const PAYWALL = {
    enabled: false,                       // master switch — see the note above before flipping this
    provider: 'polar',
    checkoutUrl: 'https://buy.polar.sh/polar_cl_Cl9es93tWu4SeXlSCug0WRLW55Y3w7CLEBn6F2MFf4U',
    portalUrl: 'https://polar.sh/flappy-reps/portal', // "forgot your key?" — customers look it up by email
    orgId: 'e4541c72-92a0-438a-97bc-f78a40cbc191',     // Polar organization id ("Flappy Reps")
    productId: '5a037755-d0a1-499a-821f-bcf637ebb3c4', // "Flappy Reps Pro" subscription product
    productName: 'Flappy Reps Pro',
    price: '$4.99',
    priceNote: '/month',
    gate: 'runs',                         // 'runs' | 'modes' | 'all'
    freeRuns: 1,                          // per day, when gate is 'runs' — one free run, then pay
    freeModes: ['pushup'],                // always free, when gate is 'modes'
    revalidateDays: 3,                    // re-check the key this often (billing is monthly)
    graceDays: 7,                         // keep working offline this long after the last good check
  };

  const LS_KEY = 'pushup-bird-license';
  const STARTS_KEY = 'pushup-bird-starts';
  const API = 'https://api.polar.sh/v1/customer-portal/license-keys';
  const qs = new URLSearchParams(location.search);
  const forced = qs.get('paywall');
  const enabled = () => (forced === '1' ? true : forced === '0' ? false : PAYWALL.enabled);

  // ---------- storage ----------
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  let lic = load(LS_KEY, null);           // { key, instanceId, validatedAt, status }
  const today = () => new Date().toISOString().slice(0, 10);
  const starts = () => { const s = load(STARTS_KEY, { date: today(), count: 0 }); return s.date === today() ? s : { date: today(), count: 0 }; };

  // ---------- entitlement ----------
  function unlocked() {
    if (!lic || !lic.key || lic.status !== 'active') return false;
    const age = (Date.now() - (lic.validatedAt || 0)) / 86400000;
    return age <= PAYWALL.graceDays;
  }
  function needsRevalidation() {
    return lic && lic.key && (Date.now() - (lic.validatedAt || 0)) / 86400000 > PAYWALL.revalidateDays;
  }
  function canPlay(mode) {
    if (!enabled() || unlocked()) return true;
    if (PAYWALL.gate === 'modes') return PAYWALL.freeModes.includes(mode);
    if (PAYWALL.gate === 'runs') return starts().count < PAYWALL.freeRuns;
    return false;
  }
  function isProMode(mode) { return enabled() && !unlocked() && PAYWALL.gate === 'modes' && !PAYWALL.freeModes.includes(mode); }
  function noteStart() { if (!enabled()) return; const s = starts(); s.count += 1; save(STARTS_KEY, s); }
  function runsLeft() { return Math.max(0, PAYWALL.freeRuns - starts().count); }

  // ---------- license API (Polar's public customer-portal endpoints, safe to call from the browser) ----------
  async function post(path, body) {
    const res = await fetch(`${API}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  }
  function deviceName() {
    let id = localStorage.getItem('pushup-bird-device');
    if (!id) { id = 'web-' + Math.random().toString(36).slice(2, 10); localStorage.setItem('pushup-bird-device', id); }
    return id;
  }
  // A 200 response already means "valid, granted, belongs to this org" (org_id is in the
  // request); Polar returns 404 for anything revoked, disabled, expired, or unrecognised.
  async function activate(key) {
    key = String(key || '').trim();
    if (!key) return { ok: false, error: 'Enter your license key.' };
    let r = await post('activate', { key, organization_id: PAYWALL.orgId, label: deviceName() });
    if (r.ok) {
      lic = { key, activationId: r.json.id, validatedAt: Date.now(), status: 'active' };
      save(LS_KEY, lic); return { ok: true };
    }
    // Already activated on another device (activation limit) or no limit set: fall back to a plain validation.
    r = await post('validate', { key, organization_id: PAYWALL.orgId });
    if (r.ok) {
      lic = { key, activationId: null, validatedAt: Date.now(), status: 'active' };
      save(LS_KEY, lic); return { ok: true };
    }
    const msg = r.status === 404 ? 'That key is not valid for Flappy Reps Pro.'
              : r.status === 403 ? 'That key is revoked, expired, or already in use.'
              : 'Could not verify that key right now — try again in a moment.';
    return { ok: false, error: msg };
  }
  async function revalidate() {
    if (!lic || !lic.key) return;
    try {
      const body = { key: lic.key, organization_id: PAYWALL.orgId };
      if (lic.activationId) body.activation_id = lic.activationId;
      const r = await post('validate', body);
      if (r.ok) { lic.validatedAt = Date.now(); lic.status = 'active'; }
      else if (r.status === 404 || r.status === 403) { lic.status = 'revoked'; }
      // any other status (network hiccup, 5xx): leave lic.validatedAt alone, grace period covers it
      save(LS_KEY, lic);
    } catch { /* offline: keep working within the grace period */ }
    render();
  }
  function forget() { lic = null; localStorage.removeItem(LS_KEY); render(); }

  // ---------- checkout ----------
  function openCheckout() {
    if (!PAYWALL.checkoutUrl) { setMsg('Checkout is not configured yet.'); return; }
    window.open(PAYWALL.checkoutUrl, '_blank', 'noopener');
  }

  // ---------- UI ----------
  let el = {};
  function setMsg(text, ok) { if (el.msg) { el.msg.textContent = text || ''; el.msg.className = 'pw-msg ' + (ok ? 'ok' : ''); } }
  function render() {
    if (!el.root) return;
    const u = unlocked();
    el.root.classList.toggle('unlocked', u);
    el.status.textContent = u ? 'PRO UNLOCKED ✓' : '';
    el.price.textContent = `${PAYWALL.price} · ${PAYWALL.priceNote}`;
    el.title.textContent = u ? 'YOU\'RE PRO' : `UNLOCK ${PAYWALL.productName.toUpperCase()}`;
    const why = PAYWALL.gate === 'runs' ? `Free play is ${PAYWALL.freeRuns} runs a day. ${runsLeft()} left today.`
              : PAYWALL.gate === 'modes' ? 'Push-ups are free. Squats and plank are Pro.'
              : 'Flappy Reps is a paid game.';
    el.why.textContent = u ? 'Thanks for supporting the game.' : why;
    el.buy.hidden = u; el.keyRow.hidden = u; el.forget.hidden = !u;
    el.close.hidden = !u && PAYWALL.gate === 'all';
  }
  function show(reason) {
    if (!el.root) return;
    if (window.FRAnalytics) FRAnalytics.paywallShown();
    render();
    setMsg(reason || '');
    el.root.hidden = false;
  }
  function hide() { if (el.root) el.root.hidden = true; }

  function mount() {
    el.root = document.getElementById('paywall');
    if (!el.root) return;
    el.title = el.root.querySelector('.pw-title');
    el.why = el.root.querySelector('.pw-why');
    el.price = el.root.querySelector('.pw-price');
    el.status = el.root.querySelector('.pw-status');
    el.buy = document.getElementById('pw-buy');
    el.keyRow = el.root.querySelector('.pw-keyrow');
    el.key = document.getElementById('pw-key');
    el.apply = document.getElementById('pw-apply');
    el.msg = el.root.querySelector('.pw-msg');
    el.close = document.getElementById('pw-close');
    el.forget = document.getElementById('pw-forget');
    el.portal = document.getElementById('pw-portal');
    if (el.portal && PAYWALL.portalUrl) el.portal.href = PAYWALL.portalUrl;
    el.buy.addEventListener('click', openCheckout);
    el.apply.addEventListener('click', async () => {
      el.apply.disabled = true; setMsg('Checking…');
      const r = await activate(el.key.value);
      el.apply.disabled = false;
      setMsg(r.ok ? 'Unlocked! Enjoy.' : r.error, r.ok);
      render();
      if (r.ok) setTimeout(hide, 900);
    });
    el.key.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.apply.click(); });
    el.close.addEventListener('click', hide);
    el.forget.addEventListener('click', () => { if (confirm('Remove the license from this device?')) forget(); });
    el.root.addEventListener('click', (e) => { if (e.target === el.root && !el.close.hidden) hide(); });

    // Coming back from checkout with ?license_key=... : activate silently and clean the URL.
    const k = qs.get('license_key');
    if (k) {
      activate(k).then((r) => { if (r.ok) show('Unlocked! Enjoy.'); else show(r.error); });
      qs.delete('license_key'); history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs : ''));
    } else if (needsRevalidation()) {
      revalidate();
    }
    render();
  }
  document.addEventListener('DOMContentLoaded', mount);

  return { config: PAYWALL, enabled, unlocked, canPlay, isProMode, noteStart, runsLeft, show, hide, activate, revalidate, forget };
})();
