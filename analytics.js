/* Flappy Reps — analytics (Google Analytics 4).
   Set MEASUREMENT_ID to the property's "G-XXXXXXXXXX" id to turn it on. Until then every
   call is a no-op. No cookies-consent banner is needed for the anonymous usage we send:
   page views plus the game events below. Nothing personal, no camera data, ever. */
window.FRAnalytics = (() => {
  'use strict';
  const MEASUREMENT_ID = 'G-NWF62KKXW9'; // GA4 property "Flappy Reps", web stream flappyreps.com
  const enabled = /^G-[A-Z0-9]{6,}$/i.test(MEASUREMENT_ID) && location.hostname !== 'localhost';
  if (enabled) {
    const s = document.createElement('script');
    s.async = true; s.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    gtag('js', new Date());
    gtag('config', MEASUREMENT_ID, { anonymize_ip: true, send_page_view: true });
  }
  function track(name, params) {
    if (!enabled || typeof window.gtag !== 'function') return;
    try { gtag('event', name, params || {}); } catch { /* ignore */ }
  }
  return {
    enabled,
    playStart: (mode) => track(`play_start_${mode}`, { mode }),
    runEnd: (mode, score) => track(`run_end_${mode}`, { mode, value: Math.max(0, Number(score) || 0), score }),
    clipShare: (mode, score) => track('clip_share', { mode, score }),
    cameraDenied: () => track('camera_denied'),
    paywallShown: () => track('paywall_shown'),
    quit: (mode) => track('quit', { mode }),
  };
})();
