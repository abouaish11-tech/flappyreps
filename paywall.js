/* Flappy Reps — payment gate (Lemon Squeezy, no backend).
   OFF by default. Flip PAYWALL.enabled to true (or open ?paywall=1 to preview) when ready.

   Setup checklist (see CLAUDE.md):
     1. In Lemon Squeezy create a product "Flappy Reps Pro" with License Keys enabled.
     2. Paste its checkout URL into checkoutUrl and the numeric store/product ids below.
     3. Set the product's redirect URL to  https://flappyreps.com/?license_key=[license_key]
        so buyers land back in the game already unlocked. Manual key entry also works.
*/
window.Paywall = (() => {
  'use strict';

  const PAYWALL = {
    enabled: false,                       // master switch
    provider: 'lemonsqueezy',
    checkoutUrl: '',                      // e.g. https://flappyreps.lemonsqueezy.com/buy/xxxxxxxx
    storeId: 0,                           // optional: reject keys from other stores
    productId: 0,                         // optional: reject keys from other products
    productName: 'Flappy Reps Pro',
    price: '$4.99',
    priceNote: 'one-time',
    gate: 'runs',                         // 'runs' | 'modes' | 'all'
    freeRuns: 3,                          // per day, when gate is 'runs'
    freeModes: ['pushup'],                // always free, when gate is 'modes'
    revalidateDays: 7,                    // re-check the key this often
    graceDays: 14,                        // keep working offline this long after the last good check
  };

  const LS_KEY = 'pushup-bird-license';
  const STARTS_KEY = 'pushup-bird-starts';
  const API = 'https://api.lemonsqueezy.com/v1/licenses';
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

  // ---------- license API (public endpoints, safe to call from the browser) ----------
  async function post(path, body) {
    const form = new URLSearchParams(body);
    const res = await fetch(`${API}/${path}`, { method: 'POST', headers: { Accept: 'application/json' }, body: form });
    const json = await res.json().catch(() => ({}));
    return json;
  }
  function deviceName() {
    let id = localStorage.getItem('pushup-bird-device');
    if (!id) { id = 'web-' + Math.random().toString(36).slice(2, 10); localStorage.setItem('pushup-bird-device', id); }
    return id;
  }
  function accept(json) {
    if (!json || !json.valid && !json.activated) return false;
    const meta = json.meta || {};
    if (PAYWALL.storeId && Number(meta.store_id) !== Number(PAYWALL.storeId)) return false;
    if (PAYWALL.productId && Number(meta.product_id) !== Number(PAYWALL.productId)) return false;
    const status = json.license_key && json.license_key.status;
    return status === 'active' || status === undefined;
  }
  async function activate(key) {
    key = String(key || '').trim();
    if (!key) return { ok: false, error: 'Enter your license key.' };
    let json = await post('activate', { license_key: key, instance_name: deviceName() });
    if (json.activated && accept(json)) {
      lic = { key, instanceId: json.instance && json.instance.id, validatedAt: Date.now(), status: 'active' };
      save(LS_KEY, lic); return { ok: true };
    }
    // Activation limit reached or already activated elsewhere: fall back to a plain validation.
    json = await post('validate', { license_key: key });
    if (json.valid && accept(json)) {
      lic = { key, instanceId: null, validatedAt: Date.now(), status: 'active' };
      save(LS_KEY, lic); return { ok: true };
    }
    return { ok: false, error: json.error || 'That key is not valid for Flappy Reps Pro.' };
  }
  async function revalidate() {
    if (!lic || !lic.key) return;
    try {
      const json = await post('validate', lic.instanceId ? { license_key: lic.key, instance_id: lic.instanceId } : { license_key: lic.key });
      if (json.valid && accept(json)) { lic.validatedAt = Date.now(); lic.status = 'active'; }
      else if (json.valid === false) { lic.status = 'revoked'; }
      save(LS_KEY, lic);
    } catch { /* offline: keep within grace period */ }
    render();
  }
  function forget() { lic = null; localStorage.removeItem(LS_KEY); render(); }

  // ---------- checkout ----------
  function openCheckout() {
    if (!PAYWALL.checkoutUrl) { setMsg('Checkout is not configured yet.'); return; }
    const url = new URL(PAYWALL.checkoutUrl);
    url.searchParams.set('checkout[custom][device]', deviceName());
    if (window.LemonSqueezy && window.LemonSqueezy.Url) { window.LemonSqueezy.Url.Open(url.toString()); return; }
    window.open(url.toString(), '_blank', 'noopener');
  }
  function loadLemonJs() {
    if (PAYWALL.provider !== 'lemonsqueezy' || document.getElementById('lemonjs')) return;
    const s = document.createElement('script');
    s.id = 'lemonjs'; s.src = 'https://app.lemonsqueezy.com/js/lemon.js'; s.defer = true;
    s.onload = () => { if (window.createLemonSqueezy) window.createLemonSqueezy(); };
    document.head.appendChild(s);
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
    render();
    setMsg(reason || '');
    el.root.hidden = false;
    loadLemonJs();
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
    if (enabled()) loadLemonJs();
  }
  document.addEventListener('DOMContentLoaded', mount);

  return { config: PAYWALL, enabled, unlocked, canPlay, isProMode, noteStart, runsLeft, show, hide, activate, revalidate, forget };
})();
