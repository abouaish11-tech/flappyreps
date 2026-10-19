/* Flappy Reps — Flappy Bird controlled by push-ups, squats and planks.
   Bird Y = shoulder midpoint from MediaPipe Pose, mapped 1:1 onto the frame. */

(() => {
  'use strict';

  // ---------- DOM ----------
  const video = document.getElementById('cam');
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const statusEl = document.getElementById('status');
  const intro = document.getElementById('intro');
  const startBtn = document.getElementById('start');
  const muteBtn = document.getElementById('mute');
  const modeBtn = document.getElementById('mode');
  const modeButtons = [...document.querySelectorAll('[data-mode]')];
  const introHint = document.getElementById('intro-hint');
  const boardEl = document.getElementById('leaderboard');
  const boardList = document.getElementById('board-list');
  const boardStats = document.getElementById('board-stats');
  const boardTabs = [...document.querySelectorAll('[data-board]')];
  const nameInput = document.getElementById('player-name');

  // ---------- Constants ----------
  const BEST_KEY = 'pushup-bird-best';
  const MODE_KEY = 'pushup-bird-mode';
  const RUNS_KEY = 'pushup-bird-runs';
  const NAME_KEY = 'pushup-bird-name';
  const MAX_RUNS = 1000;
  // Which landmarks drive the bird in each exercise (MediaPipe Pose indices).
  const MODES = {
    pushup: {
      label: 'PUSH-UPS', unit: 'push-up', points: [11, 12], source: 'shoulders', pipes: 'copper',
      ready: 'GET IN PUSH-UP POSITION',
      hint: 'Phone on the floor, face the camera. Go down and the bird drops, push up and it rises.',
    },
    squat: {
      label: 'SQUATS', unit: 'squat', points: [23, 24], source: 'hips', pipes: 'green',
      ready: 'STAND BACK, HIPS IN FRAME',
      hint: 'Stand back until your hips are in frame. Squat and the bird drops, stand and it rises.',
    },
    plank: {
      label: 'PLANK', unit: 's', points: [23, 24], source: 'hips', pipes: 'steel', hold: true,
      ready: 'SIDE VIEW, HOLD THE PLANK',
      hint: 'Camera at your side, whole body in frame. The gaps lock to your hip height, so stay level. Score is seconds held.',
    },
  };
  const MODE_ORDER = Object.keys(MODES);
  const HOLD_MILESTONES = new Set([10, 30, 60, 90, 120, 180, 300]);
  const HOLD_GAP_START = 0.26, HOLD_GAP_END = 0.14, HOLD_GAP_SECS = 60; // gap narrows over a minute
  const fmtScore = (m, n) => (MODES[m].hold ? `${n}s` : String(n));
  const BIRD_X_FRAC = 0.32;        // bird sits a third of the way across
  const GAP_FRAC = 0.30;           // gap height as a fraction of frame height
  const PIPE_W_FRAC = 0.11;        // pipe width as a fraction of min(W,H)
  const SPAWN_MS = 1900;           // time between pipes at speed 1
  const BASE_SPEED_FRAC = 0.24;    // pipes travel this fraction of W per second
  const SPEED_STEP = 0.035;        // speed multiplier gained per pipe cleared
  const MAX_SPEED_MULT = 2.2;
  const COUNTDOWN_MS = 3000;
  const OVER_MS = 30000;           // game-over card stays up this long, then restarts on its own
  const POSE_TIMEOUT_MS = 800;     // consider tracking lost after this long
  const GROUND_FRAC = 0.075;       // scrolling ground strip height as a fraction of H
  const IDLE_SCROLL_FRAC = 0.05;   // ground drifts slowly when not playing
  // Pipe palettes: push-ups keep the copper look of the original filter, squats go classic green.
  const PIPE_THEMES = {
    copper: { light: '#f6bba4', mid: '#e58e70', dark: '#b95b40', deep: '#7d3a25', outline: '#3d1c12' },
    green:  { light: '#b6f07a', mid: '#73c93f', dark: '#4a9a2a', deep: '#2f6b1b', outline: '#1f3d12' },
    steel:  { light: '#cfe3f2', mid: '#8fb3cc', dark: '#587a94', deep: '#34495e', outline: '#1b2631' },
  };

  // ---------- State ----------
  let W = 720, H = 1280, unit = 1;
  let state = 'ready';             // ready | countdown | playing | over
  let pipes = [];
  let score = 0;
  const startMode = new URLSearchParams(location.search).get('mode') || localStorage.getItem(MODE_KEY); // ?mode= from the landing pages
  let mode = MODES[startMode] ? startMode : 'pushup';
  const bestKey = () => (mode === 'pushup' ? BEST_KEY : `${BEST_KEY}:${mode}`);
  let best = Number(localStorage.getItem(bestKey()) || 0);
  let lastRank = 0;                // all-time rank of the run that just ended
  let boardOpen = false;
  let boardMode = mode;
  let speedMult = 1;
  let spawnTimer = 0;
  let groundX = 0;                 // scroll offset of the ground strip
  let holdY = 0, holdT = 0;        // plank: locked gap height and seconds held
  let holdSamples = [];            // plank: raw readings gathered during countdown, for a stable lock-in
  const median = (arr) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  let attract = true;              // demo running behind the intro screen
  let gapHook = null;              // offline rendering: (gap, playH, margin, speed) => gap centre
  let gapFracOverride = null;      // offline rendering: widen the gap for demo footage
  let spawnGate = null;            // offline rendering: () => boolean, may postpone a spawn
  let speedStepOverride = null;    // offline rendering: freeze the speed ramp so pipe timing is predictable
  // Offline rendering "raw filter" look: overrides for sizes/timings and a flag that hides all chrome.
  const tune = { raw: false, birdX: null, spriteScale: 1, pipeW: null, gapFrac: null, spawnMs: null, speedFrac: null, ground: null };
  const groundH = () => H * (tune.ground ?? GROUND_FRAC);
  const groundTop = () => H - groundH();
  let stateTimer = 0;
  let lastFrame = performance.now();
  let muted = false;

  // Tracking
  let tracking = { hasPose: false, targetY: 0.5, lastSeen: 0, source: 'none', rawY: 0.5, pts: [] };
  // Adaptive range: the joint's observed travel (lo..hi, as a fraction of the frame) is
  // stretched onto the play area, so a small movement on camera still reaches every gap.
  const cal = { lo: null, hi: null, lastT: 0, primaryRaw: null, offset: 0, prevSource: null };
  const CAL_MIN_RANGE = 0.14;      // never amplify more than this (frame fraction → full play height)
  const CAL_RELAX_FREE = 0.03;     // per second: how fast the range forgets old extremes
  const CAL_RELAX_LOCKED = 0.006;  // after the calibration reps: keep the measured top/bottom
  const CAL_READY_RANGE = 0.07;    // one visible rep = at least this much travel
  const PLAY_TOP = 0.10;           // mapped bird range (fractions of H), bottom is above the ground
  const HOLD_GAIN = 2.2;           // plank: bird moves this many times the hip movement
  let holdRaw = 0.5, holdBird = 0.5;
  // Push-ups: depth = half vertical position, half apparent shoulder width (you get bigger
  // as you come down toward a floor-level phone). A shrug moves y a little but not size.
  const scale = { lo: null, hi: null, last: null };
  const SCALE_MIN_RANGE = 0.16;    // shoulder-width change (frame fraction) that counts as a full rep
  const SCALE_READY_RANGE = 0.08;
  let earRatio = 3.2, earRatioSeen = false;   // shoulder width ÷ ear distance, learned per player
  const reach = { lo: null, hi: null }; // observed bird range (fraction of H) → pipes stay reachable
  // Calibration: before the first countdown the player does CALIB_REPS full reps with the right
  // joint in view. Each rep must swing the bird from the top zone to the bottom zone and back.
  const CALIB_REPS = 2;
  const calib = { zone: null, halves: 0, done: false, samples: [] };
  // Whether the shoulders look bigger or smaller at the bottom depends on where the phone sits
  // (in our test footage they look *smaller*), so the size cue is only blended in once the
  // calibration reps show it moves together with the height signal, and with the right sign.
  const sizeUse = { w: 0, sign: 1 };
  function learnSizeCue() {
    const S = calib.samples; sizeUse.w = 0;
    if (S.length < 20) return;
    const n = S.length, my = S.reduce((a, p) => a + p[0], 0) / n, ms = S.reduce((a, p) => a + p[1], 0) / n;
    let cov = 0, vy = 0, vs = 0;
    for (const [y, sw] of S) { cov += (y - my) * (sw - ms); vy += (y - my) ** 2; vs += (sw - ms) ** 2; }
    const r = vy && vs ? cov / Math.sqrt(vy * vs) : 0;
    if (Math.abs(r) > 0.7) { sizeUse.w = 0.35; sizeUse.sign = Math.sign(r); }
  }
  const calRelax = () => (calib.done ? CAL_RELAX_LOCKED : CAL_RELAX_FREE);
  const calibReps = () => Math.min(CALIB_REPS, Math.floor(calib.halves / 2));
  const REACH_MIN = 0.45;          // only constrain gaps once the player has shown this much travel
  const EXACT = new URLSearchParams(location.search).get('exact') === '1';
  let camPhase = 'idle';            // idle | starting | model | ready | failed
  let keyboardY = null;            // set when ↑/↓ are used

  // Bird
  const bird = { x: 0, y: 0, vy: 0, rot: 0, flapT: 0, squash: 0, trail: [], trailT: 0 };

  // Visual effects ("juice"): all decay on their own in updateFx().
  const fx = { shake: 0, flash: 0, scorePop: 0, popups: [], particles: [], banner: null };
  const MILESTONES = new Set([5, 10, 25, 50, 100, 200]);

  // ---------- Audio (tiny synth, no assets) ----------
  let audio = null;
  function ensureAudio() {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  }
  function beep(freq, dur, type = 'square', gain = 0.11, slide = 0) {
    if (muted || !audio) return;
    // Mobile browsers can silently re-suspend the context (e.g. the OS camera-permission
    // dialog backgrounds the page for a moment) with no error — sounds scheduled after
    // that just never play. Nudge it awake before every beep, not only on first unlock.
    if (audio.state === 'suspended') audio.resume();
    const t = audio.currentTime;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(audio.destination);
    if (recDest) g.connect(recDest);
    o.connect(g);
    o.start(t);
    o.stop(t + dur);
  }
  const sfx = {
    point: () => { const k = 1 + 0.07 * (run.heat || 0); beep(880 * k, 0.08); setTimeout(() => beep(1320 * k, 0.12), 70); },
    hit: () => { beep(220, 0.25, 'sawtooth', 0.17, -160); },
    tick: () => beep(660, 0.07),
    go: () => beep(990, 0.18),
    milestone: () => { [660, 880, 1100, 1320].forEach((f, i) => setTimeout(() => beep(f, 0.14, 'square', 0.13), i * 80)); },
  };
  // A backgrounded tab (the OS camera-permission dialog does this on some mobile browsers)
  // can suspend the audio context; resume it the moment the page is visible again so the
  // very next beep isn't the one that silently gets dropped.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && audio && audio.state === 'suspended') audio.resume(); });

  // ---------- Sizing ----------
  function resize(w, h) {
    W = w; H = h;
    canvas.width = W; canvas.height = H;
    unit = Math.min(W, H) / 720;
    bird.x = W * (tune.birdX ?? BIRD_X_FRAC);
    if (!bird.y) bird.y = H / 2;
  }
  resize(720, 1280);

  // The game is always 9:16 portrait (720x1280), so what you see is a full-screen TikTok-shaped
  // clip. The camera frame is cover-cropped into it: `crop` is the part of the frame on screen,
  // in normalized camera coordinates (landmarks map through it with camX/camY).
  const crop = { x: 0, y: 0, w: 1, h: 1 };
  function updateCrop() {
    const src = frameSource || video;
    const vw = frameSource ? src.width : src.videoWidth, vh = frameSource ? src.height : src.videoHeight;
    crop.x = 0; crop.y = 0; crop.w = 1; crop.h = 1;
    if (!vw || !vh) return;
    if (vw / vh > W / H) { crop.w = (vh * W / H) / vw; crop.x = (1 - crop.w) / 2; }
    else { crop.h = (vw * H / W) / vh; crop.y = (1 - crop.h) / 2; }
  }
  const camX = (x) => ((x - crop.x) / crop.w) * W;
  const camY = (y) => ((y - crop.y) / crop.h) * H;

  // Portrait ⇄ landscape: the camera's frame flips, the canvas stays 9:16. Only the crop changes,
  // and the height range is re-learned on the next rep (the calibration reps aren't asked for again).
  function onVideoResize() {
    updateCrop();
    bird.trail = [];
    cal.lo = cal.hi = null; cal.primaryRaw = null; scale.lo = scale.hi = null; reach.lo = reach.hi = null;
  }

  // ---------- Pose ----------
  let pose = null;
  // Dev/demo: ?src=<video url> feeds a video file through the tracker instead of the webcam.
  const SRC_PARAM = new URLSearchParams(location.search).get('src');
  let manualPump = false;          // when true, frames are pushed to the tracker by the caller (offline render)
  let frameSource = null;          // offline render: an image/canvas drawn instead of the video element
  let poseReady = false;           // true once the MediaPipe graph has finished loading

  async function startCamera() {
    camPhase = 'starting';
    setStatus('starting camera… allow access');
    if (SRC_PARAM) {
      video.src = SRC_PARAM; video.loop = true; video.muted = true;
      manualPump = new URLSearchParams(location.search).get('manual') === '1';
      await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = rej; });
      if (!manualPump) await video.play();
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      video.srcObject = stream;
      await new Promise((res) => (video.onloadedmetadata = res));
      await video.play();
    }
    updateCrop();
    if (!video.__rotWatch) { video.__rotWatch = true; video.addEventListener('resize', onVideoResize); }

    if (typeof Pose === 'undefined') {
      camPhase = 'failed';
      setStatus('pose model failed to load — keys only', 'bad');
      return;
    }
    camPhase = 'model';
    if (pose) { if (!manualPump && !pumping) pump(); return; } // already loaded from a previous session
    pose = new Pose({
      locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${f}`,
    });
    pose.setOptions({
      modelComplexity: Number(new URLSearchParams(location.search).get('model') ?? 0) || 0, // ?model=1 = more accurate, slower
      smoothLandmarks: true,
      enableSegmentation: false,
      selfieMode: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    pose.onResults(onPose);
    setStatus('loading pose model…');
    await pose.initialize();
    poseReady = true;
    if (!manualPump) pump();
  }

  let pumping = false;
  async function pump() {
    pumping = true;
    // Feed frames sequentially; pose.send resolves when the frame is processed.
    if (video.readyState >= 2 && video.srcObject) {
      try { await pose.send({ image: video }); } catch (e) { /* keep going */ }
    }
    requestAnimationFrame(pump);
  }

  function onPose(res) {
    const lm = res.poseLandmarks;
    if (!lm) { return; }
    const v = (i) => (lm[i] ? (lm[i].visibility ?? 1) : 0);
    // Average of whichever points of a pair are visible (one hip/shoulder is enough).
    const pairY = (a, b, th) => { const pts = [a, b].filter((i) => v(i) > th); return pts.length ? pts.reduce((s, i) => s + lm[i].y, 0) / pts.length : null; };
    const [a, b] = MODES[mode].points;
    tracking.pts = [a, b].filter((i) => v(i) > 0.5).map((i) => ({ x: lm[i].x, y: lm[i].y }));
    let y = pairY(a, b, 0.5), source = MODES[mode].source;
    if (y === null) { y = pairY(11, 12, 0.5); source = 'shoulders'; }
    if (y === null && v(0) > 0.5) { y = lm[0].y + 0.08; source = 'face'; }
    if (y === null) return;
    // Apparent size: shoulder width, or ear distance scaled up when the shoulders are out of frame.
    // The ear→shoulder ratio is learned from this player whenever both are visible, so the
    // size signal doesn't jump when the shoulders leave the frame close to a floor-level phone.
    let sw = null;
    const shW = v(11) > 0.5 && v(12) > 0.5 ? Math.abs(lm[11].x - lm[12].x) : null;
    const earW = v(7) > 0.5 && v(8) > 0.5 ? Math.abs(lm[7].x - lm[8].x) : null;
    if (shW !== null && earW !== null && earW > 0.01) {
      const r = Math.min(5, Math.max(2, shW / earW));
      earRatio = earRatioSeen ? earRatio + (r - earRatio) * 0.1 : r; earRatioSeen = true;
    }
    if (shW !== null) sw = shW;
    else if (earW !== null) sw = earW * earRatio;
    feedTracking(y, source, sw);
  }

  // Shared by the camera path and the offline/debug path.
  function feedTracking(y, source, sw) {
    const now = performance.now();
    if (typeof sw === 'number' && isFinite(sw)) {
      if (scale.lo === null) { scale.lo = sw; scale.hi = sw; }
      scale.lo = Math.min(scale.lo, sw); scale.hi = Math.max(scale.hi, sw);
      const dts = cal.lastT ? Math.min(0.5, (now - cal.lastT) / 1000) : 0;
      scale.lo += (sw - scale.lo) * calRelax() * dts; scale.hi += (sw - scale.hi) * calRelax() * dts;
      scale.last = sw;
    }
    const primary = source === MODES[mode].source;
    if (!calib.done && primary && typeof sw === 'number' && isFinite(sw) && calib.samples.length < 900) calib.samples.push([y, sw]);
    // Keep the signal continuous when the tracker falls back to another joint.
    if (primary) { cal.offset = 0; cal.primaryRaw = y; }
    else if (cal.prevSource !== source && cal.primaryRaw !== null) cal.offset = cal.primaryRaw - y;
    cal.prevSource = source;
    const raw = Math.min(1, Math.max(0, y + cal.offset));
    tracking.rawY = raw;
    tracking.targetY = EXACT ? raw : mapRaw(raw, now);
    tracking.hasPose = true;
    tracking.lastSeen = now;
    tracking.source = source;
    camPhase = 'ready';
    keyboardY = null; // camera takes over from keys
  }

  function mapRaw(raw, now, pure) {
    // pure=true (used to compute the plank lock-in anchor): a plain positional read with no
    // side effects on the shared calibration/reach state, and no amplification.
    if (MODES[mode].hold) {
      const bottom = groundTop() / H - 0.08;
      if (pure || state !== 'playing') return PLAY_TOP + Math.min(1, Math.max(0, raw)) * (bottom - PLAY_TOP);
      // Playing: deviation from the locked position, amplified, around where the bird was locked.
      return Math.min(1, Math.max(0, holdBird + (raw - holdRaw) * HOLD_GAIN));
    }
    const dtp = cal.lastT ? Math.min(0.5, (now - cal.lastT) / 1000) : 0;
    cal.lastT = now;
    if (cal.lo === null) { cal.lo = raw; cal.hi = raw; }
    // expand instantly, contract slowly
    cal.lo = Math.min(cal.lo, raw); cal.hi = Math.max(cal.hi, raw);
    cal.lo += (raw - cal.lo) * calRelax() * dtp;
    cal.hi += (raw - cal.hi) * calRelax() * dtp;
    const mid = (cal.lo + cal.hi) / 2;
    const range = Math.max(cal.hi - cal.lo, CAL_MIN_RANGE);
    let norm = Math.min(1, Math.max(0, (raw - mid) / range + 0.5));
    if (mode === 'pushup' && scale.last !== null && !EXACT && sizeUse.w > 0) {
      // Blend in depth-by-size. Neither half is stretched below its minimum range, so a
      // shoulder wiggle on the floor moves the bird a few percent, not the whole screen.
      const smid = (scale.lo + scale.hi) / 2;
      const srange = Math.max(scale.hi - scale.lo, SCALE_MIN_RANGE);
      let snorm = Math.min(1, Math.max(0, (scale.last - smid) / srange + 0.5)); // bigger = lower…
      if (sizeUse.sign < 0) snorm = 1 - snorm;                                   // …unless calibration says smaller = lower
      norm = (1 - sizeUse.w) * norm + sizeUse.w * snorm;
    }
    const bottom = groundTop() / H - 0.08;
    const out = PLAY_TOP + norm * (bottom - PLAY_TOP);
    if (reach.lo === null) { reach.lo = out; reach.hi = out; }
    reach.lo = Math.min(reach.lo, out); reach.hi = Math.max(reach.hi, out);
    reach.lo += (out - reach.lo) * calRelax() * dtp; reach.hi += (out - reach.hi) * calRelax() * dtp;
    return out;
  }
  const scaleRange = () => (scale.lo === null ? 0 : scale.hi - scale.lo);
  const calibrated = () => calib.done;
  // Called every frame in the ready state while the camera sees the player.
  function stepCalib() {
    if (calib.done || tracking.source !== MODES[mode].source) return;  // needs the real joint, not a fallback
    const bottom = groundTop() / H - 0.08;
    const n = (tracking.targetY - PLAY_TOP) / (bottom - PLAY_TOP);
    // The range must also be a real movement, not a twitch amplified to full height.
    const big = calRange() >= CAL_READY_RANGE;
    const zone = !big ? calib.zone : n > 0.72 ? 'low' : n < 0.28 ? 'high' : calib.zone;
    if (zone && zone !== calib.zone) {
      if (calib.zone) { calib.halves++; if (calib.halves % 2 === 0) sfx.point(); }
      calib.zone = zone;
      if (calibReps() >= CALIB_REPS) { calib.done = true; learnSizeCue(); }
    }
  }
  function calibText() {                 // [headline, instruction]
    if (tracking.source !== MODES[mode].source) return ['MOVE BACK', mode === 'pushup' ? 'SHOW BOTH SHOULDERS' : 'SHOW YOUR HIPS'];
    const word = mode === 'pushup' ? 'PUSH-UP' : 'SQUAT';
    return [`CALIBRATE ${word} ${Math.min(CALIB_REPS, calibReps() + 1)}/${CALIB_REPS}`, calib.zone === 'low' ? 'NOW COME ALL THE WAY UP' : 'GO ALL THE WAY DOWN'];
  }
  const calRange = () => (cal.lo === null ? 0 : cal.hi - cal.lo);
  function resetCal() { calib.zone = null; calib.halves = 0; calib.done = false; calib.samples = []; sizeUse.w = 0; cal.lo = cal.hi = null; cal.lastT = 0; cal.primaryRaw = null; cal.offset = 0; cal.prevSource = null; scale.lo = scale.hi = null; scale.last = null; reach.lo = reach.hi = null; }

  function stopCamera() {
    if (video.srcObject) { video.srcObject.getTracks().forEach((t) => t.stop()); video.srcObject = null; }
    camPhase = 'idle';
    tracking.lastSeen = 0; tracking.hasPose = false;
  }

  // Quit to the menu: stop the run, drop the clip, release the camera, show the intro.
  function quitToMenu() {
    if (window.FRAnalytics && intro.hidden) FRAnalytics.quit(mode);
    duelClose(false);
    stopRecording(true);
    resetRun();
    toReady();
    resetCal();
    daily.on = DAILY_URL;
    keyboardY = null;
    shareBar.hidden = true;
    againBar.hidden = true;
    closeBoard();
    stopCamera();
    attract = true;
    intro.hidden = false;
    document.body.classList.add('in-intro');
    setStatus('starting camera…');
  }

  function setStatus(text, cls = '') {
    statusEl.textContent = text;
    statusEl.className = 'pill ' + cls;
  }

  // ---------- Leaderboard (local, per browser) ----------
  function loadRuns() {
    try { const r = JSON.parse(localStorage.getItem(RUNS_KEY) || '[]'); return Array.isArray(r) ? r : []; }
    catch { return []; }
  }
  let runs = loadRuns();
  let playerName = (localStorage.getItem(NAME_KEY) || 'YOU').toUpperCase();

  function saveRuns() { localStorage.setItem(RUNS_KEY, JSON.stringify(runs.slice(-MAX_RUNS))); }
  function ranked(m) {
    return runs.filter((r) => r.mode === m).sort((a, b) => b.score - a.score || a.ts - b.ts);
  }
  function recordRun() {
    if (score <= 0) return 0;
    const run = { name: playerName, score, mode, ts: Date.now() };
    runs.push(run);
    saveRuns();
    return ranked(mode).indexOf(run) + 1;
  }
  function fmtWhen(ts) {
    const d = new Date(ts);
    const sameDay = new Date().toDateString() === d.toDateString();
    return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                   : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function renderBoard() {
    boardTabs.forEach((b) => b.classList.toggle('active', b.dataset.board === boardMode));
    const list = ranked(boardMode);
    const top = list.slice(0, 10);
    boardList.innerHTML = top.length
      ? top.map((r, i) => `<li class="${r.name === playerName ? 'me' : ''}">
            <span class="rank">#${i + 1}</span>
            <span class="name">${escapeHtml(r.name)}</span>
            <span class="score">${fmtScore(boardMode, r.score)}</span>
            <span class="when">${fmtWhen(r.ts)}</span>
          </li>`).join('')
      : '<li class="empty">NO RUNS YET — GO EARN A SPOT</li>';
    const mine = list.filter((r) => r.name === playerName);
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const weekStart = Date.now() - 7 * 86400000;
    const sum = (arr) => arr.reduce((n, r) => n + r.score, 0);
    const f = (n) => fmtScore(boardMode, n);
    boardStats.innerHTML = `
      <div><b>${f(sum(mine.filter((r) => r.ts >= dayStart)))}</b><span>TODAY</span></div>
      <div><b>${f(sum(mine.filter((r) => r.ts >= weekStart)))}</b><span>7 DAYS</span></div>
      <div><b>${f(sum(mine))}</b><span>TOTAL</span></div>
      <div><b>${mine.length}</b><span>RUNS</span></div>`;
  }
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function openBoard() {
    boardMode = mode;
    nameInput.value = playerName;
    renderBoard();
    boardEl.hidden = false;
    boardOpen = true;
    if (state === 'playing' || state === 'countdown') { resetRun(); toReady(); }
  }
  function closeBoard() {
    boardEl.hidden = true;
    boardOpen = false;
    stateTimer = 0; // don't auto-start the instant the board closes
  }

  // ---------- Run recorder (records the canvas + sfx, offers Share / Save) ----------
  const shareBar = document.getElementById('sharebar');
  const shareBtn = document.getElementById('share');
  const shareInfo = document.getElementById('share-info');
  const recDot = document.getElementById('recdot');
  const againBar = document.getElementById('againbar');
  const againTimer = document.getElementById('again-timer');
  let recDest = null;              // MediaStreamAudioDestinationNode for the sfx
  let recorder = null, recChunks = [], recStream = null, recTrack = null, recStart = 0, recStopTimer = null;
  let lastClip = null;             // { blob, url, ext, seconds, score, mode }
  const REC_MAX_MS = 120000;       // cap a single clip at two minutes
  const REC_FPS = 30;
  // Safari's MediaRecorder writes MP4s whose timestamps collapse (a 40 s run plays as ~3 s and
  // reports an "83 day" length). On Apple browsers we encode the canvas ourselves with WebCodecs
  // and mux a normal MP4 with mp4-muxer, stamping every frame with its real time. ?rec=wc forces
  // that path anywhere (for testing), ?rec=mr forces MediaRecorder.
  const REC_FORCE = new URLSearchParams(location.search).get('rec');
  const IS_APPLE = navigator.vendor === 'Apple Computer, Inc.';
  const WC_POSSIBLE = typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
  const WC_WANTED = REC_FORCE === 'wc' || (REC_FORCE !== 'mr' && IS_APPLE);
  const WC_CODEC = 'avc1.42002a';  // H.264 baseline, level 4.2 (fits up to 1080p)
  const WC_MUXER_SRC = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.js';
  let wcReady = false, wc = null;
  if (WC_POSSIBLE && WC_WANTED) {
    VideoEncoder.isConfigSupported({ codec: WC_CODEC, width: 720, height: 1280, bitrate: 4_000_000, framerate: REC_FPS })
      .then((r) => r.supported && (window.Mp4Muxer ? null : new Promise((ok, bad) => {
        const sc = document.createElement('script'); sc.src = WC_MUXER_SRC; sc.onload = ok; sc.onerror = bad; document.head.appendChild(sc);
      })).then(() => { wcReady = !!window.Mp4Muxer; }))
      .catch((e) => console.warn('webcodecs recorder unavailable', e));
  }
  const canRecord = (typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream) || (WC_POSSIBLE && WC_WANTED);
  const recMime = (() => {
    if (typeof MediaRecorder === 'undefined') return null;
    const c = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return c.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  })();
  const recExt = () => (recMime && recMime.startsWith('video/mp4') ? 'mp4' : 'webm');

  function startRecording() {
    if (!canRecord || tune.raw) return;
    stopRecording(true);
    if (wcReady) { startWebCodecs(); return; }
    if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return;
    try {
      if (!recStream) {
        // A fixed capture rate lets the browser stamp frames itself.
        recStream = canvas.captureStream(REC_FPS);
        recTrack = recStream.getVideoTracks()[0];
        // Game sound only off Apple: Safari's muxer follows the audio clock and squashes the video
        // when that track stalls (e.g. iOS interrupts the AudioContext while the camera runs).
        if (audio && !IS_APPLE) {
          if (!recDest) recDest = audio.createMediaStreamDestination();
          recDest.stream.getAudioTracks().forEach((t) => recStream.addTrack(t));
        }
      }
      recChunks = [];
      recorder = new MediaRecorder(recStream, recMime ? { mimeType: recMime, videoBitsPerSecond: 4_000_000 } : undefined);
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
      recorder.onstop = () => { if (recChunks.length) finishClip(new Blob(recChunks, { type: recMime || 'video/webm' }), recExt()); };
      recorder.start();                               // one blob at stop; Safari mangles timesliced MP4 chunks
      recStarted();
    } catch (err) { console.warn('recording unavailable', err); recorder = null; }
  }
  function startWebCodecs() {
    try {
      const w = W & ~1, h = H & ~1;
      const target = new Mp4Muxer.ArrayBufferTarget();
      const muxer = new Mp4Muxer.Muxer({ target, video: { codec: 'avc', width: w, height: h, frameRate: REC_FPS }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
      const rec = { muxer, target, w, h, next: 0, n: 0, failed: false, enc: null };
      rec.enc = new VideoEncoder({
        output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { rec.failed = true; console.warn(e); } },
        error: (e) => { rec.failed = true; console.warn('encoder error', e); },
      });
      rec.enc.configure({ codec: WC_CODEC, width: w, height: h, bitrate: 4_000_000, framerate: REC_FPS, avc: { format: 'avc' } });
      wc = rec;
      recStarted();
    } catch (err) { console.warn('webcodecs recording failed', err); wc = null; }
  }
  function recStarted() {
    recStart = performance.now();
    recDot.hidden = false;
    shareBar.hidden = true;
    clearTimeout(recStopTimer);
    recStopTimer = setTimeout(() => stopRecording(false), REC_MAX_MS);
  }
  function stopRecording(discard) {
    clearTimeout(recStopTimer);
    recDot.hidden = true;
    if (wc) {
      const r = wc; wc = null;
      if (discard || r.failed || !r.n) { try { r.enc.close(); } catch { /* ignore */ } return; }
      r.enc.flush().then(() => {
        r.muxer.finalize();
        try { r.enc.close(); } catch { /* ignore */ }
        if (!r.failed) finishClip(new Blob([r.target.buffer], { type: 'video/mp4' }), 'mp4');
      }).catch((e) => console.warn('finishing clip failed', e));
      return;
    }
    if (!recorder) return;
    const r = recorder; recorder = null;
    if (discard) { r.onstop = null; r.ondataavailable = null; }
    if (r.state !== 'inactive') { try { r.stop(); } catch { /* ignore */ } }
  }
  function finishClip(blob, ext) {
    if (lastClip) URL.revokeObjectURL(lastClip.url);
    const race = raceOn() && duel.result ? { me: duel.reps, them: duel.oppReps, opp: duelDisplayName(duel.oppName), result: duel.result } : null;
    lastClip = { blob, url: URL.createObjectURL(blob), ext, seconds: Math.round((performance.now() - recStart) / 1000), score: race ? race.me : score, mode, daily: daily.on, race };
    shareInfo.textContent = race ? `${race.me}–${race.them} vs ${race.opp} · ${lastClip.seconds}s clip` : `${fmtScore(mode, score)} · ${lastClip.seconds}s clip`;
    shareBar.hidden = false;
  }
  async function shareClip() {
    if (!lastClip) return;
    if (window.FRAnalytics) FRAnalytics.clipShare(lastClip.mode, lastClip.score);
    const name = `flappy-reps-${lastClip.mode}-${lastClip.score}.${lastClip.ext}`;
    const file = new File([lastClip.blob], name, { type: lastClip.blob.type });
    const rc = lastClip.race;
    const text = rc
      ? `${rc.result === 'win' ? 'Won' : rc.result === 'lose' ? 'Lost' : 'Drew'} a ${MODES[lastClip.mode].label.toLowerCase()} rep race on Flappy Reps, ${rc.me}–${rc.them} vs ${rc.opp}. Race me: https://flappyreps.com`
      : lastClip.daily
      ? `I got ${fmtScore(lastClip.mode, lastClip.score)} on today's Flappy Reps daily challenge (${MODES[lastClip.mode].label.toLowerCase()}, ${todayLabel()}). Same course for everyone: https://flappyreps.com/?daily=1`
      : `I scored ${fmtScore(lastClip.mode, lastClip.score)} on Flappy Reps (${MODES[lastClip.mode].label.toLowerCase()}). Beat me: https://flappyreps.com`;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Flappy Reps', text }); return; }
      catch (err) { if (err && err.name === 'AbortError') return; }
    }
    // Desktop or no share sheet: download the file instead.
    const a = document.createElement('a');
    a.href = lastClip.url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }
  // Push a frame into the recording after every render.
  // WebCodecs path: encode the freshly rendered canvas at REC_FPS with its real timestamp.
  function recFrame() {
    if (!wc || wc.failed) return;
    const t = performance.now() - recStart;
    if (t < wc.next) return;
    wc.next = t + 1000 / REC_FPS - 2;
    if (wc.enc.encodeQueueSize > 4) return;          // encoder behind: drop this frame
    try {
      let src = canvas;
      if ((W & ~1) !== wc.w || (H & ~1) !== wc.h) {   // phone rotated mid-run: letterbox into the clip's size
        if (!wc.off) { wc.off = document.createElement('canvas'); wc.off.width = wc.w; wc.off.height = wc.h; }
        const o = wc.off.getContext('2d'), k = Math.min(wc.w / W, wc.h / H);
        o.fillStyle = '#000'; o.fillRect(0, 0, wc.w, wc.h);
        o.drawImage(canvas, (wc.w - W * k) / 2, (wc.h - H * k) / 2, W * k, H * k);
        src = wc.off;
      }
      const frame = new VideoFrame(src, { timestamp: Math.round(t * 1000), visibleRect: { x: 0, y: 0, width: wc.w, height: wc.h } });
      wc.enc.encode(frame, { keyFrame: wc.n % (REC_FPS * 2) === 0 });
      frame.close(); wc.n++;
    } catch (e) { wc.failed = true; console.warn('frame encode failed', e); }
  }

  // ---------- Run extras: heat, tiredness, form, ghost, daily, boss pipes, skins ----------
  // Seeded courses: every solo run draws its gaps from runRand. The daily challenge seeds it
  // from the date (+ mode), so everyone gets the same course that day and the ghost of your
  // best attempt flies the exact same gaps.
  function mulberry(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  let runRand = Math.random;
  const DAILY_URL = new URLSearchParams(location.search).get('daily') === '1';
  const daily = { on: DAILY_URL };
  const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const todayLabel = () => new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
  function dailySeed() { let h = 2166136261; for (const c of todayKey() + ':' + mode) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
  const dailyBestKey = () => `pushup-bird-daily:${mode}:${todayKey()}`;
  const ghostKey = () => `pushup-bird-ghost:${mode}:${todayKey()}`;
  const dailyBest = () => Number(localStorage.getItem(dailyBestKey()) || 0);
  const GHOST_STEP_MS = 50;
  let ghost = null;                 // { seed, score, ys: [y/H every 50 ms], endMs } — today's best daily run
  let ghostRec = null;              // the run being played, recorded in the same format
  let ghostShowY = null;
  function loadGhost() {
    try {
      const g = JSON.parse(localStorage.getItem(ghostKey()) || 'null');
      return g && Array.isArray(g.ys) && g.ys.length > 4 ? g : null;
    } catch { return null; }
  }
  function saveGhost() {
    if (!ghostRec || ghostRec.ys.length < 5) return;
    try { localStorage.setItem(ghostKey(), JSON.stringify({ seed: ghostRec.seed, score, ys: ghostRec.ys, endMs: ghostRec.ys.length * GHOST_STEP_MS })); }
    catch { /* storage full: skip the ghost */ }
    // Old days' ghosts are dead weight.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('pushup-bird-ghost:') && !k.endsWith(todayKey())) localStorage.removeItem(k);
    }
  }

  // Heat (the score streak): every 5 points (10 s in plank) the bird charges up with an electric
  // cyan → blue → violet → magenta glow, kept clear of the red/orange used for overheating (tiredness),
  // which also damps it.
  const HEAT_NAMES = ['', 'CHARGED UP!', 'POWERED UP!', 'SUPERCHARGED!', 'BEAST MODE!'];
  const HEAT_COLORS = ['', '#5fe6ff', '#3d8bff', '#9b5cff', '#ff3df0'];
  const SPARK_COLORS = ['#ffffff', '#5fe6ff', '#9b5cff'];
  const heatStep = () => (MODES[mode].hold ? 10 : 5);
  const heatFor = (n) => Math.min(4, Math.floor(n / heatStep()));
  // Real reps, read from the bird's own movement: a rep is a down-and-up swing of at least
  // REP_MIN of the play range; a full rep travels FULL_REP of it both ways. Rep speed
  // (range covered per second) against the player's own early reps is the tiredness signal.
  const REP_MIN = 0.15, FULL_REP = 0.6, REP_HYST = 0.06;
  const run = {};
  function resetExtras() {
    Object.assign(run, {
      heat: 0, peakHeat: 0, flame: 0, steamT: 0, emberT: 0,
      dir: 0, ext: null, extT: 0, turnY: null, turnT: 0, halves: [], reps: 0, full: 0,
      speeds: [], fatigue: 0, tiredAt: null, tiredShown: false, streak: 0, bestStreak: 0,
      oh: 0, smoke: [], smokeT: 0, sparkT: 0,
      t: 0, pipeCount: 0, bossBanner: false, beatGhost: false, ghostDownShown: false, lifetimeBefore: lifetimeReps(),
    });
  }
  const birdN = () => { const bottom = groundTop() - 22 * unit, top = 20 * unit; return (bird.y - top) / Math.max(1, bottom - top); };
  function trackReps(now) {
    const n = birdN();
    if (run.ext === null) { run.ext = n; run.extT = now; run.turnY = n; run.turnT = now; return; }
    if (run.dir >= 0 && n > run.ext) { run.ext = n; run.extT = now; }
    if (run.dir <= 0 && n < run.ext) { run.ext = n; run.extT = now; }
    if (run.dir === 0) { if (Math.abs(n - run.turnY) > REP_HYST) run.dir = n > run.turnY ? 1 : -1; return; }
    const reversed = run.dir > 0 ? n < run.ext - REP_HYST : n > run.ext + REP_HYST;
    if (!reversed) return;
    const amp = Math.abs(run.ext - run.turnY), dur = Math.max(0.15, (run.extT - run.turnT) / 1000);
    run.halves.push({ amp, speed: amp / dur, down: run.dir > 0 });
    run.turnY = run.ext; run.turnT = run.extT; run.dir = -run.dir; run.ext = n; run.extT = now;
    // A rep completes on the way back up (bottom → top), made of the last two halves.
    const h = run.halves;
    if (h.length >= 2 && !h[h.length - 1].down && h[h.length - 2].down) {
      const a = h[h.length - 2], b = h[h.length - 1];
      if (Math.min(a.amp, b.amp) >= REP_MIN) onRep(Math.min(a.amp, b.amp), (a.speed + b.speed) / 2);
    }
  }
  function onRep(amp, speed) {
    run.reps++;
    run.speeds.push(speed);
    if (amp >= FULL_REP) {
      run.full++; run.streak++; run.bestStreak = Math.max(run.bestStreak, run.streak);
      const label = run.streak >= 3 && (run.streak === 3 || run.streak % 5 === 0) ? `${run.streak}x FULL!` : 'FULL REP';
      if (!raceOn()) fx.popups.push({ x: bird.x - 40 * unit, y: bird.y + 34 * unit, t: 0, text: label, fill: '#7ec850', size: 10 });
      burst(bird.x, bird.y, 6, ['#7ec850', '#ffffff'], H * 0.2, H * 0.4);
    } else run.streak = 0;
    if (raceOn()) raceRep(amp);
    // Tiredness: recent rep speed vs the best of the player's own first reps.
    if (run.speeds.length >= 5) {
      const early = run.speeds.slice(0, 5).sort((x, y) => y - x).slice(0, 3);
      const base = early.reduce((x, y) => x + y, 0) / early.length;
      const recent = run.speeds.slice(-3).reduce((x, y) => x + y, 0) / 3;
      const before = run.fatigue;
      run.fatigue = Math.min(1, Math.max(0, (0.88 - recent / base) / 0.3));
      if (run.fatigue > 0.45 && !run.tiredShown) {
        run.tiredShown = true; if (run.tiredAt === null) run.tiredAt = run.reps;
        fx.banner = { text: 'OVERHEATING!', t: 0, fill: '#ff4a2a' };
      }
      if (before > 0.45 && run.fatigue < 0.15) {
        run.tiredShown = false;
        fx.banner = { text: 'SECOND WIND!', t: 0 };
        burst(bird.x, bird.y, 24, HEAT_COLORS.slice(1), H * 0.4, H * 0.5);
        sfx.milestone();
      }
    }
  }
  // Rep Race scoring: a rep counts only outside a stun and deep enough.
  function raceRep(amp) {
    const pill = (text, color) => fx.popups.push({ x: bird.x + 40 * unit, y: bird.y - 30 * unit, t: 0, text, pill: color });
    if (performance.now() < duel.stunUntil) { pill('STUNNED', '#64748b'); return; }
    if (amp < RACE_REP_MIN) { pill('GO DEEPER', '#64748b'); return; }
    duel.reps += 1;
    if (amp >= FULL_REP) duel.full += 1;
    fx.scorePop = 1;
    pill('+1', '#16a34a');
    sfx.point();
  }
  function raceStun(now) {
    duel.stunUntil = now + RACE_STUN_MS;
    sfx.hit();
    fx.shake = 0.7; fx.flash = 0.5;
    burst(bird.x, bird.y, 16, ['#f87171', '#ffffff', '#94a3b8'], H * 0.4, H * 0.6);
    fx.popups.push({ x: bird.x + 40 * unit, y: bird.y - 30 * unit, t: 0, text: 'STUNNED 2s', pill: '#dc2626' });
  }
  // Called whenever the score changes. Returns true if it showed a heat banner.
  function heatCheck() {
    const lvl = heatFor(score);
    if (lvl <= run.heat) return false;
    run.heat = lvl; run.peakHeat = Math.max(run.peakHeat, lvl);
    fx.banner = { text: HEAT_NAMES[lvl], t: 0, fill: HEAT_COLORS[lvl] };
    burst(bird.x, bird.y, 30, [...SPARK_COLORS, HEAT_COLORS[lvl]], H * 0.5, -H * 0.2);
    sfx.milestone();
    return true;
  }
  // Per-frame visuals for heat and tiredness (steam, flame trail, embers).
  function heatFx(dt) {
    run.flame += ((run.heat * (1 - 0.6 * run.fatigue)) - run.flame) * Math.min(1, dt * 3);
    if (run.heat >= 1) {
      run.steamT += dt;
      if (run.steamT > (run.flame >= 1.5 ? 0.5 : 0.22)) {
        run.steamT = 0;
        fx.particles.push({ x: bird.x + (Math.random() - 0.5) * 20 * unit, y: bird.y - 22 * unit, vx: (Math.random() - 0.5) * 20 * unit, vy: -60 * unit, g: -20 * unit,
          life: 0.7, age: 0, size: (4 + Math.random() * 3) * unit, color: 'rgba(160,240,255,0.8)', spin: 0, rot: 0 });
      }
    }
    if (run.flame >= 1.5 || skinId === 'fire') {
      run.emberT += dt;
      const every = skinId === 'fire' && run.flame < 1.5 ? 0.12 : 0.045 / Math.max(1, run.flame - 0.5);
      while (run.emberT > every) {
        run.emberT -= every;
        const big = Math.max(1, run.flame);
        fx.particles.push({ x: bird.x - 26 * unit, y: bird.y + (Math.random() - 0.5) * 18 * unit, vx: -(80 + Math.random() * 120) * unit, vy: (Math.random() - 0.5) * 50 * unit - 30 * unit, g: -40 * unit,
          life: 0.25 + 0.08 * big, age: 0, size: (3 + Math.random() * 3 * big) * unit, color: (run.flame >= 1.5 ? SPARK_COLORS : ['#ffd200', '#ff7b22', '#ff3b1a'])[(Math.random() * 3) | 0], spin: 0, rot: 0 });
      }
    }
  }
  // Overheating = tiredness made visible. run.oh follows run.fatigue smoothly; past each OH_AT
  // threshold the bird ramps yellow → orange → red (OH_RAMP frames), grey smoke pours off its
  // back, sparks fly, the screen edges glow red and the thermometer fills. Cosmetic only.
  const OH_AT = [0.15, 0.45, 0.75];                    // WARM, HOT, OVERHEAT
  function ohStage() {
    if (state !== 'playing' || !run.oh) return 0;
    return run.oh > OH_AT[2] ? 3 : run.oh > OH_AT[1] ? 2 : run.oh > OH_AT[0] ? 1 : 0;
  }
  function overheatFx(dt) {
    run.oh += (run.fatigue - run.oh) * Math.min(1, dt * 1.5);
    const st = ohStage();
    if (st >= 1) {
      run.smokeT += dt;
      const every = [0, 0.08, 0.05, 0.035][st];
      while (run.smokeT > every) {
        run.smokeT -= every;
        const big = 0.7 + Math.random() * 0.6;
        run.smoke.push({ x: bird.x - 22 * unit, y: bird.y + (Math.random() - 0.7) * 14 * unit, vx: -(170 + Math.random() * 60) * unit, vy: -(20 + Math.random() * 50) * unit,
          r0: (6 + 3 * st) * unit, r1: (14 + 9 * st) * big * unit, age: 0, life: 0.7 + 0.25 * st });
      }
    }
    if (st >= 2) {
      run.sparkT += dt;
      const every = st >= 3 ? 0.06 : 0.13;
      while (run.sparkT > every) {
        run.sparkT -= every;
        fx.particles.push({ x: bird.x + (Math.random() - 0.3) * 40 * unit, y: bird.y - 14 * unit, vx: (Math.random() - 0.5) * 70 * unit, vy: -(90 + Math.random() * 90) * unit, g: 120 * unit,
          life: 0.45, age: 0, size: (4 + Math.random() * 4) * unit, color: ['#ffe14a', '#ff9a1f', '#ff4a1a'][(Math.random() * 3) | 0], spin: 0, rot: 0 });
      }
    }
  }
  // Smoke puffs merge on a low-res layer (dark rims, then body, then highlights) that is upscaled
  // without smoothing, so they read as pixel art; old puffs switch to a checker dither as they fade.
  let smokeLayer = null;
  const smokePat = {};
  function smokeFill(sctx, color, dither) {
    if (!dither) return color;
    if (!smokePat[color]) {
      const c = document.createElement('canvas'); c.width = c.height = 2;
      const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, 1, 1); x.fillRect(1, 1, 1, 1);
      smokePat[color] = sctx.createPattern(c, 'repeat');
    }
    return smokePat[color];
  }
  function drawSmoke() {
    if (!run.smoke || !run.smoke.length) return;
    const cell = Math.max(2, Math.round(5 * unit)), lw = Math.ceil(W / cell), lh = Math.ceil(H / cell);
    if (!smokeLayer || smokeLayer.width !== lw || smokeLayer.height !== lh) {
      smokeLayer = document.createElement('canvas'); smokeLayer.width = lw; smokeLayer.height = lh;
      for (const k in smokePat) delete smokePat[k];
    }
    const s = smokeLayer.getContext('2d');
    s.clearRect(0, 0, lw, lh);
    const pass = (grow, color, hl) => {
      for (const p of run.smoke) {
        const k = p.age / p.life, r = (p.r0 + (p.r1 - p.r0) * Math.sqrt(k)) / cell;
        s.fillStyle = smokeFill(s, color, k > 0.6);
        s.beginPath();
        s.arc(p.x / cell - (hl ? r * 0.25 : 0), p.y / cell - (hl ? r * 0.3 : 0), r * (hl ? 0.6 : 1) + grow, 0, Math.PI * 2);
        s.fill();
      }
    };
    pass(1, '#3a3a48'); pass(0, '#8d8d9c'); pass(0, '#c9c9d4', true);
    ctx.save();
    ctx.imageSmoothingEnabled = false; ctx.globalAlpha = 0.92;
    ctx.drawImage(smokeLayer, 0, 0, lw * cell, lh * cell);
    ctx.restore();
  }
  // Red heat haze on the screen edges once the bird is HOT, pulsing.
  function drawOverheatHaze() {
    if (state !== 'playing') return;
    const k = Math.min(1, Math.max(0, (run.oh - OH_AT[1]) / (1 - OH_AT[1])));
    if (k <= 0) return;
    const pulse = 0.85 + 0.15 * Math.sin(run.t * 5.5);
    const rg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.32, W / 2, H / 2, Math.max(W, H) * 0.7);
    rg.addColorStop(0, 'rgba(255,60,20,0)'); rg.addColorStop(1, `rgba(255,40,10,${(0.25 + 0.3 * k) * pulse})`);
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  }

  // Ghost: record this run's path; draw today's best attempt on the same course.
  function ghostTick(dt) {
    if (!ghostRec) return;
    ghostRec.acc += dt * 1000;
    while (ghostRec.acc >= GHOST_STEP_MS) { ghostRec.acc -= GHOST_STEP_MS; ghostRec.ys.push(Math.round((bird.y / H) * 1000) / 1000); }
    if (ghost && !run.beatGhost && score > ghost.score) {
      run.beatGhost = true;
      fx.banner = { text: "BEAT TODAY'S BEST!", t: 0, fill: '#7ec850' };
      burst(W / 2, H * 0.4, 40, ['#7ec850', '#ffffff', '#f7d21c'], H * 0.6, H * 0.8);
      sfx.milestone();
    }
  }
  function drawGhost() {
    if (!ghost || !daily.on || duel.on || (state !== 'playing' && state !== 'over')) return;
    const ms = run.t * 1000, i = ms / GHOST_STEP_MS;
    const alive = i < ghost.ys.length - 1;
    let y;
    if (alive) { const a = Math.floor(i), f = i - a; y = (ghost.ys[a] * (1 - f) + ghost.ys[a + 1] * f) * H; }
    else {
      const since = (ms - ghost.endMs) / 1000;
      if (since > 0.9) return;
      y = ghost.ys[ghost.ys.length - 1] * H + since * since * H * 0.8;
      if (!run.ghostDownShown && state === 'playing') { run.ghostDownShown = true; fx.popups.push({ x: bird.x, y: y - 40 * unit, t: 0, text: 'BEST RUN DOWN', fill: '#cfe3f2', size: 9 }); }
    }
    ghostShowY = y;
    const frame = !alive ? FR.ghostHit : Math.floor(run.t * 8) % 2 ? FR.ghostUp : FR.ghost;
    blitBird(frame, bird.x, y, alive ? 0 : 0.6, 1, 1, alive ? 0.42 : 0.3);
    if (alive) text(`BEST ${ghost.score}`, bird.x, y - 36 * unit, 7 * unit, { fill: '#e8f4ff' });
  }

  // Lifetime reps unlock skins: push-up and squat reps, plus one per 3 s of plank.
  function lifetimeReps() {
    let n = 0;
    for (const r of runs) n += r.mode === 'plank' ? Math.floor(r.score / 3) : r.score;
    return n;
  }
  const isPro = () => !!(window.Paywall && Paywall.enabled() && Paywall.unlocked());
  const skinUnlocked = (sk, total = lifetimeReps()) => (sk.pro ? isPro() : total >= sk.need);
  function setSkin(id) {
    const sk = skinDef(id);
    if (!skinUnlocked(sk)) return;
    skinId = sk.id; localStorage.setItem(SKIN_KEY, skinId); FR = buildFrames(skinId);
  }
  resetExtras();

  // ---------- Game control ----------
  function resetRun() {
    pipes = [];
    score = 0;
    speedMult = 1;
    spawnTimer = SPAWN_MS * 0.4; // first pipe arrives quickly
    resetExtras();
    ghostRec = null; ghostShowY = null;
  }
  function toCountdown() {
    state = 'countdown'; stateTimer = 0; resetRun(); holdSamples = [];
    if (duel.on) { if (raceOn()) startRecording(); return; } // duels are free and aren't solo runs; races are filmed
    const seed = daily.on ? dailySeed() : (Math.random() * 4294967296) >>> 0;
    runRand = mulberry(seed);
    ghost = daily.on ? loadGhost() : null;
    if (ghost && ghost.seed !== seed) ghost = null;
    ghostRec = { seed, ys: [], acc: 0 };
    startRecording(); if (window.Paywall) Paywall.noteStart(); if (window.FRAnalytics) FRAnalytics.playStart(mode);
  }
  function toPlaying() {
    state = 'playing'; sfx.go();
    duel.goAt = performance.now();
    // Plank: anchor on the median of the last ~0.5s of countdown, not one instantaneous frame —
    // a single noisy pose reading at the "GO!" instant would otherwise mis-centre every gap.
    const recent = holdSamples.slice(-15);
    holdRaw = recent.length ? median(recent) : tracking.rawY;
    holdBird = mapRaw(holdRaw, performance.now(), true);
    holdY = holdBird * H; holdT = 0;
    bird.y = holdY; // snap to the locked anchor so there's no pop on the first playing frame
  }
  function toOver() {
    state = 'over'; stateTimer = 0; sfx.hit();
    if (duel.on) { onHit(); duelFinishRun(); return; }
    if (window.FRAnalytics) FRAnalytics.runEnd(mode, score);
    againBar.hidden = false;
    onHit();
    if (score > best) { best = score; localStorage.setItem(bestKey(), String(best)); }
    if (daily.on && score > 0 && score > (ghost ? ghost.score : dailyBest() - 1)) saveGhost();
    if (daily.on && score > dailyBest()) localStorage.setItem(dailyBestKey(), String(score));
    lastRank = recordRun();
    // A skin unlocked by this run's reps?
    const after = lifetimeReps();
    const fresh = SKINS.find((k) => !k.pro && run.lifetimeBefore < k.need && after >= k.need);
    if (fresh) { run.newSkin = fresh.name; setTimeout(() => { if (state === 'over') fx.banner = { text: `NEW SKIN: ${fresh.name}!`, t: 0, fill: '#7ec850' }; }, 900); }
    if (boardOpen) renderBoard();
    // keep the game-over stats card in the clip for a couple of seconds, then finish it
    if (score > 0) setTimeout(() => stopRecording(false), 2600); else stopRecording(true);
  }
  function toReady() { state = 'ready'; stateTimer = 0; againBar.hidden = true; }

  function updateProTags() {
    if (!window.Paywall) return;
    modeButtons.forEach((b) => {
      const pro = Paywall.isProMode(b.dataset.mode);
      let tag = b.querySelector('.pro');
      if (pro && !tag) { tag = document.createElement('span'); tag.className = 'pro'; tag.textContent = 'PRO'; b.appendChild(tag); }
      if (!pro && tag) tag.remove();
    });
    const proPill = Paywall.isProMode(mode);
    modeBtn.innerHTML = MODES[mode].label + (proPill ? ' <span class="pro">PRO</span>' : '');
  }

  function setMode(next, fromDuel) {
    if (!MODES[next]) return;
    if (duel.on && !fromDuel) return; // the exercise is fixed for the whole duel
    mode = next;
    resetCal();
    localStorage.setItem(MODE_KEY, mode);
    best = Number(localStorage.getItem(bestKey()) || 0);
    modeBtn.textContent = MODES[mode].label;
    modeButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    updateProTags();
    if (window.Paywall && Paywall.isProMode(mode) && intro.hidden) Paywall.show();
    introHint.innerHTML = MODES[mode].hint;
    if (state !== 'ready') { resetRun(); toReady(); }
  }

  // ---------- Attract mode (behind the intro) ----------
  function updateAttract(dt) {
    const t = performance.now() / 1000;
    const speed = W * BASE_SPEED_FRAC * 0.9;
    const pipeW = Math.min(W, H) * PIPE_W_FRAC;
    const gap = H * 0.42;
    groundX += speed * dt;
    spawnTimer -= dt * 1000;
    if (spawnTimer <= 0) {
      spawnTimer = SPAWN_MS * 1.15;
      pipes.push({ x: W + pipeW, w: pipeW, top: H * 0.5 - gap / 2, bottom: H * 0.5 + gap / 2, passed: false });
    }
    for (const p of pipes) p.x -= speed * dt;
    pipes = pipes.filter((p) => p.x + p.w > -10);
    const prevY = bird.y;
    bird.y = H * 0.5 + Math.sin(t * 1.7) * H * 0.11;
    bird.vy = (bird.y - prevY) / Math.max(dt, 1e-3);
    bird.rot += (Math.max(-0.5, Math.min(0.9, bird.vy / (H * 1.2))) - bird.rot) * Math.min(1, dt * 10);
    bird.flapT += dt;
    bird.squash = Math.max(0, bird.squash - dt * 1.4);
    updateFx(dt);
  }

  // ---------- Update ----------
  function update(dt) {
    const now = performance.now();
    if (duel.on) duelTick(now); // heartbeat runs in the lobby too, not just in game
    if (attract) { updateAttract(dt); return; }
    const seen = now - tracking.lastSeen < POSE_TIMEOUT_MS;
    tracking.hasPose = seen;

    const target = keyboardY !== null ? keyboardY * H
                 : seen ? tracking.targetY * H
                 : bird.y;

    // Follow the body in real time; a light low-pass only removes landmark jitter.
    const prevY = bird.y, prevVy = bird.vy;
    bird.y += (target - bird.y) * Math.min(1, dt * 18);
    bird.y = Math.min(groundTop() - 22 * unit, Math.max(20 * unit, bird.y)); // stay inside the frame, above the ground
    bird.vy = (bird.y - prevY) / Math.max(dt, 1e-3);
    const targetRot = Math.max(-0.5, Math.min(0.9, bird.vy / (H * 1.2)));
    bird.rot += (targetRot - bird.rot) * Math.min(1, dt * 10);
    bird.flapT += dt * (1 - 0.5 * (run.fatigue || 0));   // tired birds flap slower
    // Squash when the bird reverses direction hard (top / bottom of a rep).
    if (Math.sign(prevVy) !== Math.sign(bird.vy) && Math.abs(prevVy) > H * 0.35) bird.squash = 0.22;
    bird.squash = Math.max(0, bird.squash - dt * 1.4);
    // Motion trail while moving fast.
    bird.trailT += dt;
    if (Math.abs(bird.vy) > H * 0.3 && bird.trailT > 0.035) {
      bird.trailT = 0;
      bird.trail.push({ x: bird.x, y: bird.y, rot: bird.rot, t: 0 });
      if (bird.trail.length > 5) bird.trail.shift();
    }
    for (const g of bird.trail) g.t += dt;
    bird.trail = bird.trail.filter((g) => g.t < 0.22);
    updateFx(dt);

    // Status pill
    if (keyboardY !== null) setStatus('keys: ↑ ↓', 'ok');
    else if (camPhase === 'failed') setStatus('camera blocked — use ↑ ↓ keys', 'bad');
    else if (camPhase === 'model') setStatus('loading pose model…');
    else if (camPhase === 'ready') setStatus(seen ? `tracking ${tracking.source}` : 'no body detected', seen ? 'ok' : 'bad');
    // while 'starting', keep the message set by startCamera()

    stateTimer += dt * 1000;

    if (state !== 'playing') groundX += W * IDLE_SCROLL_FRAC * dt;

    if (state === 'ready') {
      // Hands-free start: once a body is in frame, wait for one visible rep (or a short hold for plank).
      const pwOpen = !!(window.Paywall && document.getElementById('paywall') && !document.getElementById('paywall').hidden);
      if ((seen || keyboardY !== null) && !boardOpen && !pwOpen) {
        const hold = !!MODES[mode].hold;
        if (seen && keyboardY === null && !hold && !EXACT) stepCalib();
        const ready = keyboardY !== null || EXACT || hold || calibrated();
        if (ready && stateTimer > 900) {
          if (duel.on) duelSetReady(true); // in a duel the host starts the round once both are set
          else if (window.Paywall && !Paywall.canPlay(mode)) { Paywall.show(); stateTimer = 0; }
          else toCountdown();
        } else if (duel.on) duelSetReady(false);
      } else { stateTimer = 0; if (duel.on) duelSetReady(false); }
      return;
    }
    if (state === 'countdown') {
      if (MODES[mode].hold && seen) holdSamples.push(tracking.rawY);
      const step = Math.floor(stateTimer / 1000);
      if (step !== countdownStep) { countdownStep = step; if (step < 3) sfx.tick(); }
      if (stateTimer >= COUNTDOWN_MS) { countdownStep = -1; toPlaying(); }
      return;
    }
    if (state === 'over') {
      if (duel.on) { if (duel.nextAt && now >= duel.nextAt) { duel.nextAt = 0; toReady(); } return; }
      if (stateTimer >= OVER_MS) toReady();
      return;
    }
    // Rep Race: the clock runs out for both at the same moment.
    if (raceOn() && now - duel.goAt >= RACE_MS) { state = 'over'; stateTimer = 0; sfx.go(); duelFinishRun(); return; }
    // Duel: once the rival has crashed, outlasting them wins the round on the spot.
    if (duel.on && !raceOn() && duel.oppMs !== null && now - duel.goAt > duel.oppMs) { duel.outlasted = true; state = 'over'; stateTimer = 0; duelFinishRun(); return; }

    // ---- playing ----
    const hold = !!MODES[mode].hold;
    run.t += dt;
    if (!hold) trackReps(now);
    heatFx(dt);
    overheatFx(dt);
    ghostTick(dt);
    if (hold) {
      holdT += dt;
      const sec = Math.floor(holdT);
      if (sec !== score) {
        score = sec;
        fx.scorePop = 0.6;
        if (heatCheck()) { /* heat banner shown */ }
        else if (HOLD_MILESTONES.has(score)) {
          fx.banner = { text: `${score}s HOLD!`, t: 0 };
          burst(W / 2, H * 0.4, 40, ['#cfe3f2', '#f7d21c', '#ffffff', '#4fc3f7'], H * 0.6, H * 0.8);
          sfx.milestone();
        }
      }
    }
    const speed = W * (tune.speedFrac ?? BASE_SPEED_FRAC) * speedMult;
    const pipeW = Math.min(W, H) * (tune.pipeW ?? PIPE_W_FRAC);
    const gap = hold
      ? H * (HOLD_GAP_START + (HOLD_GAP_END - HOLD_GAP_START) * Math.min(1, holdT / HOLD_GAP_SECS))
      : H * (gapFracOverride ?? tune.gapFrac ?? GAP_FRAC);
    groundX += speed * dt;

    spawnTimer -= dt * 1000 * speedMult;
    if (spawnTimer <= 0 && (!spawnGate || spawnGate(speed, pipeW, gap))) {
      spawnTimer = tune.spawnMs ?? SPAWN_MS;
      const margin = H * 0.08;
      const playH = groundTop();
      // Duels: both players get the identical course, pipe i always has the same gap.
      const rnd = duel.on ? duelRand(duel.pipeIdx++) : runRand();
      run.pipeCount++;
      let cy = hold
        ? Math.min(playH - margin - gap / 2, Math.max(margin + gap / 2, holdY))
        : margin + gap / 2 + rnd * (playH - 2 * margin - gap);
      // Camera play: keep the gap centre within the range the player has actually reached
      // (the same random draw, mapped into that range, so seeded courses keep their shape).
      let lo = margin + gap / 2, hi = playH - margin - gap / 2;
      if (!duel.on && !hold && keyboardY === null && reach.lo !== null && (reach.hi - reach.lo) >= REACH_MIN * (playH / H)) {
        const rl = Math.max(lo, reach.lo * H + 10 * unit), rh = Math.min(hi, reach.hi * H - 10 * unit);
        if (rh > rl) { lo = rl; hi = rh; cy = lo + rnd * (hi - lo); }
      }
      if (gapHook) cy = Math.min(playH - margin - gap / 2, Math.max(margin + gap / 2, gapHook(gap, playH, margin, speed, pipeW)));
      const pipe = { x: W + pipeW, w: pipeW, top: cy - gap / 2, bottom: cy + gap / 2, passed: false };
      // Boss pipe every 25th: a gap that slides up and down, or an extra-wide pipe you hold low through.
      if (!duel.on && !hold && !gapHook && run.pipeCount % 25 === 0) {
        if ((run.pipeCount / 25) % 2 === 1) {
          const amp = Math.min(H * 0.1, (hi - lo) / 2);
          pipe.boss = 'slide'; pipe.cy = Math.min(hi - amp, Math.max(lo + amp, cy)); pipe.amp = amp; pipe.gap = gap; pipe.ph = 0;
        } else {
          pipe.boss = 'wide'; pipe.w = pipeW * 2.6; pipe.x = W + pipe.w;
          const low = lo + 0.8 * (hi - lo);
          pipe.top = low - gap / 2; pipe.bottom = low + gap / 2;
        }
        fx.banner = { text: pipe.boss === 'slide' ? 'BOSS PIPE: IT MOVES!' : 'BOSS PIPE: HOLD LOW!', t: 0, fill: '#e0432b' };
        sfx.tick();
      }
      pipes.push(pipe);
    }

    const r = 20 * unit; // collision radius
    for (const p of pipes) {
      p.x -= speed * dt;
      if (p.boss === 'slide') {
        p.ph += dt;
        const c = p.cy + Math.sin(p.ph * Math.PI * 2 * 0.45) * p.amp;
        p.top = c - p.gap / 2; p.bottom = c + p.gap / 2;
      }
      if (!p.passed && p.x + p.w < bird.x) {
        p.passed = true;
        if (p.boss) {
          run.bossBanner = true;   // shown by onPoint() this same frame, after any heat banner
          burst(bird.x, bird.y, 36, ['#cfe3f2', '#e0432b', '#ffffff', '#f7d21c'], H * 0.6, H * 0.8);
        }
        if (hold) {
          // Plank: passing a pipe is just confirmation you're still level.
          burst(bird.x, bird.y, 6, ['#ffffff', '#cfe3f2'], H * 0.25, H * 0.5);
          sfx.tick();
        } else if (raceOn()) {
          // Rep Race: reps are the score; pipes are just in the way.
          speedMult = Math.min(MAX_SPEED_MULT, speedMult + (speedStepOverride ?? SPEED_STEP));
        } else {
          score += 1;
          speedMult = Math.min(MAX_SPEED_MULT, speedMult + (speedStepOverride ?? SPEED_STEP));
          onPoint();
        }
      }
      // circle vs the two pipe rectangles
      const withinX = bird.x + r > p.x && bird.x - r < p.x + p.w;
      if (withinX && (bird.y - r < p.top || bird.y + r > p.bottom)) {
        if (!raceOn()) { toOver(); return; }
        if (!p.hit && now >= duel.stunUntil) { p.hit = true; raceStun(now); }   // fly through, stunned
      }
    }
    pipes = pipes.filter((p) => p.x + p.w > -10);
  }
  let countdownStep = -1;

  // ---------- Effects ----------
  function burst(x, y, n, colors, speed, gravity) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.8);
      fx.particles.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.3, g: gravity,
        life: 0.5 + Math.random() * 0.5, age: 0, size: (3 + Math.random() * 4) * unit,
        color: colors[(Math.random() * colors.length) | 0], spin: (Math.random() - 0.5) * 12, rot: 0,
      });
    }
  }
  function onPoint() {
    fx.scorePop = 1;
    const hot = run.heat >= 4;
    fx.popups.push({ x: bird.x + 36 * unit, y: bird.y - 26 * unit, t: 0, text: hot ? '+1!' : '+1', fill: hot ? HEAT_COLORS[4] : undefined, size: hot ? 22 : 16 });
    burst(bird.x, bird.y, 10, run.heat >= 2 ? SPARK_COLORS : ['#ffffff', '#f7d21c', '#fbe58a'], H * 0.35, H * 0.6);
    if (run.bossBanner) { run.bossBanner = false; heatCheck(); fx.banner = { text: 'BOSS BEATEN!', t: 0, fill: '#7ec850' }; sfx.milestone(); }
    else if (heatCheck()) { /* heat banner shown */ }
    else if (MILESTONES.has(score)) {
      fx.banner = { text: `${score} REPS!`, t: 0 };
      burst(W / 2, H * 0.4, 40, ['#f7d21c', '#e0432b', '#ffffff', '#4fc3f7'], H * 0.6, H * 0.8);
      sfx.milestone();
    } else {
      sfx.point();
    }
  }
  function onHit() {
    fx.shake = 1;
    fx.flash = 1;
    burst(bird.x, bird.y, 22, ['#f7d21c', '#e39f2b', '#fbe58a', '#ffffff'], H * 0.5, H * 1.1);
  }
  function updateFx(dt) {
    fx.shake = Math.max(0, fx.shake - dt * 2.2);
    fx.flash = Math.max(0, fx.flash - dt * 3.5);
    fx.scorePop = Math.max(0, fx.scorePop - dt * 3.2);
    for (const p of fx.popups) p.t += dt;
    fx.popups = fx.popups.filter((p) => p.t < 0.8);
    for (const q of fx.particles) {
      q.age += dt; q.vy += q.g * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.rot += q.spin * dt;
    }
    fx.particles = fx.particles.filter((q) => q.age < q.life);
    if (run.smoke) {
      for (const p of run.smoke) { p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt; }
      run.smoke = run.smoke.filter((p) => p.age < p.life);
    }
    if (fx.banner) { fx.banner.t += dt; if (fx.banner.t > 1.6) fx.banner = null; }
  }
  function drawFx() {
    for (const q of fx.particles) {
      const a = 1 - q.age / q.life;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(q.x, q.y); ctx.rotate(q.rot);
      ctx.fillStyle = q.color;
      ctx.fillRect(-q.size / 2, -q.size / 2, q.size, q.size);
      ctx.restore();
    }
    for (const p of fx.popups) {
      const k = p.t / 0.8;
      ctx.save();
      ctx.globalAlpha = 1 - k * k;
      if (p.pill) pillText(p.text, p.x, p.y - k * 70 * unit, 16 * unit, p.pill, '#ffffff');
      else text(p.text, p.x, p.y - k * 70 * unit, (p.size || 16) * unit, { fill: p.fill || '#fbe58a' });
      ctx.restore();
    }
    if (fx.banner) {
      const t = fx.banner.t;
      const pop = t < 0.25 ? 1.6 - 2.4 * t : 1;                // overshoot in
      const alpha = t > 1.1 ? Math.max(0, 1 - (t - 1.1) / 0.5) : 1;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(W / 2, H * 0.42); ctx.scale(pop, pop);
      const bs = fx.banner.text.length > 14 ? 20 : 30;
      text(fx.banner.text, 0, 0, bs * unit, { fill: fx.banner.fill || '#f6c948' });
      ctx.restore();
    }
  }

  // ---------- Drawing ----------
  let vignette = null, vignetteKey = '';
  function drawVideo() {
    if (frameSource || (video.readyState >= 2 && video.videoWidth)) {
      ctx.save();
      ctx.translate(W, 0); ctx.scale(-1, 1); // selfie mirror
      if (!tune.raw) ctx.filter = 'saturate(0.8) contrast(1.05)';   // lets the pixel art pop over the room
      updateCrop();                                    // every frame: cheap, and survives a missed resize event
      const src = frameSource || video;
      const vw = frameSource ? src.width : src.videoWidth, vh = frameSource ? src.height : src.videoHeight;
      ctx.drawImage(src, crop.x * vw, crop.y * vh, crop.w * vw, crop.h * vh, 0, 0, W, H);
      ctx.restore();
    } else {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#4ec0ca'); g.addColorStop(1, '#8fd8dd');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    // Dark vignette so the frame reads as a stage rather than a raw webcam feed.
    const key = W + 'x' + H;
    if (vignetteKey !== key) {
      vignette = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.72);
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
      vignetteKey = key;
    }
    if (!tune.raw) { ctx.fillStyle = vignette; ctx.fillRect(0, 0, W, H); }
  }

  function drawPipe(p) {
    const T = PIPE_THEMES[p.boss ? 'steel' : MODES[mode].pipes];
    const capH = 30 * unit, capOver = 8 * unit, line = 3 * unit;
    const gTop = groundTop();

    // Soft drop shadow onto the room so the pipe reads as standing in front of it.
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(p.x + p.w, 0, 10 * unit, p.top);
    ctx.fillRect(p.x + p.w, p.bottom, 10 * unit, gTop - p.bottom);

    const section = (x, y, w, h, isCap) => {
      if (h <= 0) return;
      ctx.fillStyle = T.mid; ctx.fillRect(x, y, w, h);
      ctx.fillStyle = T.light; ctx.fillRect(x + w * 0.12, y, w * 0.14, h);          // highlight band
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(x + w * 0.16, y, w * 0.04, h); // gloss
      ctx.fillStyle = T.dark; ctx.fillRect(x + w * 0.72, y, w * 0.22, h);           // shadow band
      ctx.fillStyle = T.deep; ctx.fillRect(x + w * 0.94, y, w * 0.06, h);           // far edge
      if (!isCap) {
        // Faint joint lines every so often, scrolling with the pipe.
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        const step = 110 * unit;
        for (let yy = y + step - ((y + step) % step); yy < y + h; yy += step) ctx.fillRect(x, yy, w, line);
      }
      ctx.strokeStyle = T.outline; ctx.lineWidth = line;
      ctx.strokeRect(x + line / 2, y + line / 2, w - line, h - line);
    };
    // Top pipe: body then cap (cap drawn last so its outline sits on top).
    section(p.x, -line, p.w, p.top - capH + line * 2, false);
    section(p.x - capOver, p.top - capH, p.w + capOver * 2, capH, true);
    // Bottom pipe: cap then body down to the ground.
    section(p.x - capOver, p.bottom, p.w + capOver * 2, capH, true);
    section(p.x, p.bottom + capH - line, p.w, gTop - (p.bottom + capH) + line * 2, false);
    // Shade under each cap lip.
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(p.x, p.top, p.w, line * 1.5);
    ctx.fillRect(p.x, p.bottom + capH, p.w, line * 1.5);
    if (p.boss) {
      // Hazard stripes on both caps.
      ctx.save();
      for (const cy0 of [p.top - capH, p.bottom]) {
        ctx.beginPath(); ctx.rect(p.x - capOver + line, cy0 + line, p.w + capOver * 2 - line * 2, capH - line * 2); ctx.clip();
        ctx.fillStyle = '#e0432b';
        for (let x = p.x - capOver - capH; x < p.x + p.w + capOver; x += 18 * unit) {
          ctx.beginPath(); ctx.moveTo(x, cy0 + capH); ctx.lineTo(x + 9 * unit, cy0 + capH); ctx.lineTo(x + 9 * unit + capH, cy0); ctx.lineTo(x + capH, cy0); ctx.fill();
        }
        ctx.restore(); ctx.save();
      }
      ctx.restore();
    }
    if (run.heat >= 3 && state === 'playing') {
      // Supercharged: the pipes glow with the streak colour.
      ctx.save();
      ctx.strokeStyle = run.heat >= 4 ? 'rgba(255,61,240,0.75)' : 'rgba(155,92,255,0.6)';
      ctx.lineWidth = 4 * unit; ctx.shadowColor = HEAT_COLORS[run.heat]; ctx.shadowBlur = 18 * unit;
      ctx.strokeRect(p.x - capOver, -line, p.w + capOver * 2, p.top + line);
      ctx.strokeRect(p.x - capOver, p.bottom, p.w + capOver * 2, gTop - p.bottom);
      ctx.restore();
    }
  }

  // ---------- Ground strip (two parallax layers, tiles baked once per size) ----------
  let groundTile = null, groundKey = '';
  function bakeGround() {
    const gh = Math.round(groundH()), tw = Math.round(48 * unit);
    const c = document.createElement('canvas');
    c.width = tw; c.height = gh;
    const g = c.getContext('2d');
    const u = unit;
    // grass
    g.fillStyle = '#7ec850'; g.fillRect(0, 0, tw, 12 * u);
    g.fillStyle = '#5aa53a';
    for (let x = 0; x < tw; x += 8 * u) g.fillRect(x, 8 * u, 4 * u, 4 * u);   // jagged grass edge
    g.fillStyle = '#b9ee7a'; g.fillRect(0, 0, tw, 2 * u);                     // sun-lit top
    g.fillStyle = '#3d1c12'; g.fillRect(0, 12 * u, tw, 3 * u);                // edge line
    // dirt with diagonal stripes
    g.fillStyle = '#ded895'; g.fillRect(0, 15 * u, tw, gh - 15 * u);
    g.fillStyle = '#d3c67a';
    g.beginPath();
    for (let x = -gh; x < tw + gh; x += 24 * u) {
      g.moveTo(x, 15 * u); g.lineTo(x + 12 * u, 15 * u); g.lineTo(x + 12 * u - gh, gh); g.lineTo(x - gh, gh); g.closePath();
    }
    g.fill();
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, gh - 4 * u, tw, 4 * u);  // bottom shade
    groundTile = c;
    groundKey = W + 'x' + H;
  }
  function drawGround() {
    if (groundKey !== W + 'x' + H) bakeGround();
    const gt = groundTop(), gh = groundH();
    // Back layer: soft bushes drifting at 40% speed.
    const bushW = 140 * unit, off = (groundX * 0.4) % bushW;
    ctx.fillStyle = 'rgba(46,110,60,0.55)';
    for (let x = -off - bushW; x < W + bushW; x += bushW) {
      ctx.beginPath();
      ctx.arc(x + bushW * 0.3, gt + 2 * unit, 26 * unit, Math.PI, 0);
      ctx.arc(x + bushW * 0.55, gt + 2 * unit, 34 * unit, Math.PI, 0);
      ctx.arc(x + bushW * 0.8, gt + 2 * unit, 22 * unit, Math.PI, 0);
      ctx.fill();
    }
    // Front layer: tiled ground at full speed.
    const tw = groundTile.width, o = groundX % tw;
    ctx.imageSmoothingEnabled = false;
    for (let x = -o; x < W; x += tw) ctx.drawImage(groundTile, Math.round(x), Math.round(gt), tw, Math.ceil(gh));
  }

  // ---------- Bird sprite sheet (22x16 pixel frames, pre-rendered once) ----------
  const PAL = {
    k: '#2b1b0e', y: '#f7d21c', l: '#fbe58a', o: '#e39f2b', d: '#b8741a',
    w: '#ffffff', e: '#111111', r: '#e0432b', m: '#b32f1d',
  };
  const MID = [
    '.......kkkkkkkk.......',
    '.....kkyyyyyyyykk.....',
    '....kyyyyyyyyykwwwwk..',
    '...kyyyyyyyyyykwwwwwk.',
    '...kyyyyyyyyyykwwewwk.',
    '..kyyyyyyyyyyykwweewk.',
    '..kyyyyyyyyyyyykwwwwk.',
    '..kyyyyyyyyyyyyykwwk..',
    '.kkkkkkyyyyyyyyyykkkkk',
    'kdddddokyyyyyyyykrrrrk',
    'kdooooookyyyyyyykmmmmk',
    'kdooooookyyyyyyyykkkkk',
    '.kkkkkkkyyyyyyyllllk..',
    '...kyyyyyyyyylllllk...',
    '....kkyyyyyylllkk.....',
    '......kkkkkkkkk.......',
  ];
  const UP = [
    '.......kkkkkkkk.......',
    '.....kkyyyyyyyykk.....',
    '....kyyyyyyyyykwwwwk..',
    '...kyyyyyyyyyykwwwwwk.',
    '.kkkkyyyyyyyyykwwewwk.',
    'kdookyyyyyyyyykwweewk.',
    'kdoooookyyyyyyykwwwwk.',
    '.kdooookyyyyyyyykwwk..',
    '..kkkkkkyyyyyyyyykkkkk',
    '..kyyyyyyyyyyyyykrrrrk',
    '..kyyyyyyyyyyyyykmmmmk',
    '..kyyyyyyyyyyyyyykkkkk',
    '..kkkyyyyyyyyyyllllk..',
    '...kyyyyyyyyylllllk...',
    '....kkyyyyyylllkk.....',
    '......kkkkkkkkk.......',
  ];
  const DOWN = [
    '.......kkkkkkkk.......',
    '.....kkyyyyyyyykk.....',
    '....kyyyyyyyyykwwwwk..',
    '...kyyyyyyyyyykwwwwwk.',
    '...kyyyyyyyyyykwwewwk.',
    '..kyyyyyyyyyyykwweewk.',
    '..kyyyyyyyyyyyykwwwwk.',
    '..kyyyyyyyyyyyyykwwk..',
    '.kkyyyyyyyyyyyyyykkkkk',
    '.kyyyyyyyyyyyyyykrrrrk',
    '.kyyyyyyyyyyyyyykmmmmk',
    'kkkkkkkyyyyyyyyyykkkkk',
    'kdooooookyyyyyyllllk..',
    'kdoooookyyyyylllllk...',
    '.kkkkkkyyyyylllkk.....',
    '......kkkkkkkkk.......',
  ];
  // Derive the face variants from MID by rewriting the eye block (cols 15-19).
  const patchRows = (rows, edits) => rows.map((r, i) => {
    const e = edits[i]; if (!e) return r;
    return r.slice(0, e[0]) + e[1] + r.slice(e[0] + e[1].length);
  });
  const HIT = patchRows(MID, { 3: [15, 'ewwwe'], 4: [15, 'wewew'], 5: [15, 'wewew'], 6: [16, 'ewwe'] });
  const STRAIN = patchRows(MID, { 3: [15, 'kkkkk'], 4: [15, 'wwwww'], 5: [15, 'weeww'], 6: [16, 'wwww'] });
  // Tired: heavy half-closed lids, pupil sagging to the bottom.
  const TIRED = patchRows(MID, { 3: [15, 'kkkkk'], 4: [15, 'kkkkk'], 5: [15, 'wwwew'], 6: [16, 'wwww'] });
  // Overheating palettes for WARM / HOT / OVERHEAT: yellow → orange → red (never brown, which reads as dirt).
  const OH_RAMP = [null,
    { y: '#f9b52a', l: '#fcd77a', o: '#e07a2b', d: '#b5531a' },
    { y: '#f57a2b', l: '#f9b07a', o: '#d9461f', d: '#9e2f12' },
    { y: '#e2382b', l: '#f2806e', o: '#b02a1d', d: '#74140c', r: '#ffb52e', m: '#d98a12' }];

  const SPR_W = 22, SPR_H = 16;
  function bakeFrame(rows, tint, pal = PAL) {
    for (const r of rows) if (r.length !== SPR_W) throw new Error('sprite row width ' + r.length + ': ' + r);
    const c = document.createElement('canvas');
    c.width = SPR_W; c.height = SPR_H;
    const g = c.getContext('2d');
    rows.forEach((row, j) => [...row].forEach((ch, i) => {
      if (ch === '.') return;
      g.fillStyle = pal[ch]; g.fillRect(i, j, 1, 1);
    }));
    if (tint) { g.globalCompositeOperation = 'source-atop'; g.fillStyle = tint; g.fillRect(0, 0, SPR_W, SPR_H); }
    return c;
  }
  // Duel rival: the classic bird tinted blue, drawn as a ghost.
  const RV = {
    rival: bakeFrame(MID, 'rgba(79,195,247,0.6)'), rivalUp: bakeFrame(UP, 'rgba(79,195,247,0.6)'),
    rivalHit: bakeFrame(HIT, 'rgba(79,195,247,0.6)'),
  };

  // ---------- Skins (unlocked by lifetime reps; Diamond for Day Pass / Pro) ----------
  const SKIN_KEY = 'pushup-bird-skin';
  const SKINS = [
    { id: 'classic', name: 'CLASSIC', need: 0 },
    { id: 'band', name: 'HEADBAND', need: 100, patch: { 2: [5, 'rrrrrrrrr'], 3: [4, 'mmmmmmmmmm'] } },
    { id: 'shades', name: 'SHADES', need: 250, patch: { 3: [14, 'kkkkkkk'], 4: [14, 'kweeeek'], 5: [14, 'keeeeek'], 6: [15, 'kkkkkk'] } },
    { id: 'gold', name: 'GOLD', need: 500, pal: { y: '#f2c230', l: '#fff4b0', o: '#c48a12', d: '#8f5f08', k: '#3a2405' } },
    { id: 'fire', name: 'FIRE BIRD', need: 1000, pal: { y: '#ff7b22', l: '#ffd36b', o: '#d93a14', d: '#9e1f0e', r: '#ffd200', m: '#e0a000' } },
    { id: 'diamond', name: 'DIAMOND', pro: true, pal: { y: '#7fe0ff', l: '#e8fcff', o: '#3aa0d8', d: '#1f6a9c', k: '#0c2a44' } },
  ];
  const skinDef = (id) => SKINS.find((k) => k.id === id) || SKINS[0];
  function buildFrames(id) {
    const sk = skinDef(id), pal = { ...PAL, ...(sk.pal || {}) };
    const b = (rows, tint, p = pal) => bakeFrame(sk.patch ? patchRows(rows, sk.patch) : rows, tint, p);
    const heated = (ramp) => { const p = { ...pal, ...ramp }; return { mid: b(MID, null, p), up: b(UP, null, p), down: b(DOWN, null, p), strain: b(STRAIN, null, p), tired: b(TIRED, null, p) }; };
    return {
      mid: b(MID), up: b(UP), down: b(DOWN), strain: b(STRAIN), tired: b(TIRED), hit: b(HIT, 'rgba(255,70,70,0.35)'),
      oh: OH_RAMP.map((r) => r && heated(r)),
      ghost: b(MID, 'rgba(255,255,255,0.55)'), ghostUp: b(UP, 'rgba(255,255,255,0.55)'), ghostHit: b(HIT, 'rgba(255,255,255,0.55)'),
    };
  }
  let skinId = localStorage.getItem(SKIN_KEY) || 'classic';
  let FR = buildFrames(skinId);
  if (!skinUnlocked(skinDef(skinId))) { skinId = 'classic'; FR = buildFrames(skinId); } // e.g. a Day Pass ran out

  // The rival's bird, positioned from their last reported height. Plank gaps are centred on
  // each player's own hold height, so the rival is drawn relative to our anchor.
  function drawRival() {
    if (!duel.on || duel.oppY === null || (state !== 'playing' && state !== 'over')) return;
    const anchor = MODES[mode].hold ? holdY : 0;
    const target = (duel.oppY - duel.oppA) * H + anchor;
    duel.showY = duel.showY === null ? target : duel.showY + (target - duel.showY) * 0.22; // glides between 6/s updates
    const dead = duel.oppMs !== null;
    const frame = dead ? RV.rivalHit : Math.floor(bird.flapT * 8) % 2 ? RV.rivalUp : RV.rival;
    blitBird(frame, bird.x, duel.showY, dead ? 0.6 : 0, 1, 1, dead ? 0.35 : 0.55);
    if (raceOn()) pillText(duelDisplayName(duel.oppName), bird.x, duel.showY - 40 * unit, 13 * unit, 'rgba(14,16,28,0.75)', '#93c5fd');
    else text(duel.oppName, bird.x, duel.showY - 38 * unit, 8 * unit, { fill: '#4fc3f7' });
  }

  function pickFrame() {
    if (state === 'over' && !(duel.on && duel.outlasted)) return FR.hit;
    const fast = H * 0.08, S = FR.oh[ohStage()] || FR;   // overheating recolours every frame
    if (state === 'playing' && run.fatigue > 0.45 && Math.abs(bird.vy) < H * 0.6) return S.tired;
    // Straining: low in the frame (bottom of a rep) and barely moving.
    if (state === 'playing' && bird.y > H * 0.72 && Math.abs(bird.vy) < H * 0.15) return S.strain;
    if (bird.vy < -fast) return Math.floor(bird.flapT * 18) % 2 ? S.up : S.mid;   // frantic flapping upward
    if (bird.vy > fast) return S.down;                                             // gliding down
    return [S.mid, S.up, S.mid, S.down][Math.floor(bird.flapT * 6) % 4];           // idle flap
  }

  function blitBird(frame, x, y, rot, sx, sy, alpha, glow) {
    const px = 3.4 * unit * tune.spriteScale, w = SPR_W * px, h = SPR_H * px;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (glow) { ctx.shadowColor = glow.color; ctx.shadowBlur = glow.blur; }
    ctx.imageSmoothingEnabled = false;
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(sx, sy);
    ctx.drawImage(frame, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  function drawBird() {
    const frame = pickFrame();
    // Ghost trail behind fast movement.
    for (const g of bird.trail) blitBird(frame, g.x, g.y, g.rot, 1, 1, 0.22 * (1 - g.t / 0.22));
    // Squash & stretch: stretch along the motion, squash on reversals.
    const stretch = state === 'over' ? 0 : Math.min(0.28, Math.abs(bird.vy) / (H * 1.6));
    const q = bird.squash;
    const sx = (1 - stretch * 0.5) * (1 + q), sy = (1 + stretch) * (1 - q);
    const lvl = Math.round(Math.min(4, run.flame || 0)), st = ohStage();
    let glow = state === 'playing' && lvl >= 1 ? { color: HEAT_COLORS[lvl], blur: (10 + 8 * lvl) * unit } : null;
    if (st >= 1) glow = { color: ['', '#ff9a2a', '#ff6a1f', '#ff2a12'][st], blur: (12 + 8 * st) * unit };
    // Overheating: the bird sags nose-down and rattles.
    const jx = st >= 3 ? (Math.random() - 0.5) * 4 * unit : 0, jy = st >= 3 ? (Math.random() - 0.5) * 3 * unit : 0;
    const stunned = raceOn() && state === 'playing' && performance.now() < duel.stunUntil;
    const alpha = stunned && Math.floor(performance.now() / 110) % 2 ? 0.3 : 1;
    blitBird(frame, bird.x + jx, bird.y + jy, bird.rot + (st >= 3 ? 0.14 : 0), sx, sy, alpha, glow);
    // Sweat drop while straining at the bottom of a rep.
    if (frame === FR.strain) {
      const px = 3.4 * unit, d = (bird.flapT * 2.2) % 1;
      ctx.save();
      ctx.translate(bird.x + 24 * unit, bird.y - 30 * unit + d * 30 * unit);
      ctx.globalAlpha = 1 - d;
      ctx.fillStyle = '#4fc3f7';
      ctx.fillRect(0, 0, px, px * 2); ctx.fillRect(-px, px, px * 3, px);
      ctx.restore();
    }
  }

  function text(str, x, y, size, opts = {}) {
    ctx.save();
    ctx.font = `${size}px "Press Start 2P", monospace`;
    ctx.textAlign = opts.align || 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, size * 0.22);
    ctx.strokeStyle = opts.stroke || '#000';
    ctx.strokeText(str, x, y);
    ctx.fillStyle = opts.fill || '#fff';
    ctx.fillText(str, x, y);
    ctx.restore();
  }

  function panel(x, y, w, h) {
    ctx.save();
    ctx.fillStyle = '#ded895';
    ctx.strokeStyle = '#3d1c12';
    ctx.lineWidth = 4 * unit;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  function drawHUD() {
    const big = 56 * unit, mid = 22 * unit, small = 13 * unit;
    if (raceOn()) { drawRaceHUD(); return; }
    if (duel.on) { drawDuelHUD(big, mid, small); return; }
    if (state === 'playing') {
      const pop = 1 + 0.45 * fx.scorePop * fx.scorePop;
      ctx.save();
      ctx.translate(W / 2, H * 0.12); ctx.scale(pop, pop);
      text(fmtScore(mode, score), 0, 0, big, { fill: run.heat >= 2 ? '#d4f6ff' : '#fff' });
      ctx.restore();
      if (daily.on) text(`DAILY ${todayLabel()}${ghost ? ' · BEST ' + ghost.score : ''}`, W / 2, H * 0.12 + 44 * unit, 9 * unit, { fill: '#4fc3f7' });
      if (!MODES[mode].hold) {
        if (run.reps > 0) text(`${run.reps} REPS`, W / 2, H * 0.12 + (daily.on ? 66 : 48) * unit, 10 * unit);
        drawThermo();
      }
      return;
    }
    if (state === 'ready') {
      const posed = tracking.hasPose || keyboardY !== null;
      if (!posed) drawPoseGuide();
      text(daily.on ? `DAILY · ${todayLabel()}` : 'FLAPPY REPS', W / 2, H * 0.18, (daily.on ? 26 : 34) * unit, { fill: daily.on ? '#4fc3f7' : '#f6c948' });
      const needRep = posed && keyboardY === null && !EXACT && !MODES[mode].hold && !calibrated();
      if (needRep) {
        const [head, step] = calibText();
        text(head, W / 2, H * 0.255, 16 * unit, { fill: '#7ec850' });
        text(step, W / 2, H * 0.3, small);
        if (stateTimer > 20000) text('PHONE ~1 M AWAY, HEAD + SHOULDERS IN VIEW', W / 2, H * 0.345, 9 * unit, { fill: '#f6c948' });
      } else text(posed ? 'HOLD STILL…' : MODES[mode].ready, W / 2, H * 0.26, small);
      text(daily.on ? `TODAY'S BEST ${fmtScore(mode, dailyBest())}` : 'BEST ' + fmtScore(mode, best), W / 2, H * (needRep ? 0.39 : 0.31), small);
      return;
    }
    if (state === 'countdown') {
      const n = 3 - Math.floor(stateTimer / 1000);
      const t = (stateTimer % 1000) / 1000;
      const punch = 1 + 0.7 * Math.pow(1 - t, 3);          // slams in, settles
      ctx.save();
      ctx.translate(W / 2, H * 0.22); ctx.scale(punch, punch);
      text(n > 0 ? String(n) : 'GO!', 0, 0, big, { fill: '#f6c948' });
      ctx.restore();
      return;
    }
    if (state === 'over') {
      // Stats card: also the last two seconds of every shared clip, so it carries the URL.
      const hold = !!MODES[mode].hold;
      const lines = [];
      if (!hold && run.reps > 0) lines.push(`${run.reps} REPS · ${run.full} FULL RANGE`);
      if (!hold && run.reps >= 6) lines.push(run.tiredAt !== null ? `OVERHEATED AT REP ${run.tiredAt}` : 'NEVER OVERHEATED');
      if (run.peakHeat > 0) lines.push(`PEAK: ${HEAT_NAMES[run.peakHeat].replace('!', '')}`);
      if (daily.on) lines.push(`DAILY ${todayLabel()} · TODAY'S BEST ${fmtScore(mode, dailyBest())}`);
      const pw = Math.min(W * 0.9, 560 * unit), lh = 28 * unit, ph = 132 * unit + lines.length * lh + 36 * unit;
      const px0 = W / 2 - pw / 2, py0 = H * 0.14;
      text('GAME OVER', W / 2, py0 - 34 * unit, 30 * unit, { fill: '#f6c948' });
      panel(px0, py0, pw, ph);
      const ink = { fill: '#3d1c12', stroke: '#ded895' };
      text(MODES[mode].label, W / 2, py0 + 24 * unit, small, { fill: '#e0432b' });
      text(fmtScore(mode, score), W / 2, py0 + 60 * unit, mid, ink);
      const tag = lastRank === 1 && score > 0 ? 'NEW #1!' : lastRank > 0 ? `#${lastRank} ALL-TIME` : 'BEST ' + fmtScore(mode, best);
      text(tag, W / 2, py0 + 94 * unit, 11 * unit, ink);
      lines.forEach((l, i) => text(l, W / 2, py0 + 128 * unit + i * lh, Math.min(12 * unit, (pw - 30 * unit) / (l.length * 1.02)), ink));
      text('PLAY FREE AT FLAPPYREPS.COM', W / 2, py0 + ph - 20 * unit, 12 * unit, { fill: '#e0432b', stroke: '#ded895' });
      const left = Math.max(0, Math.ceil((OVER_MS - stateTimer) / 1000));
      text(`NEXT RUN IN ${left}s · TAP TO GO NOW`, W / 2, py0 + ph + 26 * unit, 9 * unit, { fill: '#fff' });
      if (againTimer) againTimer.textContent = `auto in ${left}s`;
      return;
    }
  }

  // Thermometer on the right edge: fills yellow → orange → red as the bird overheats (tiredness).
  function drawThermo() {
    const k = Math.min(1, run.oh || 0), st = ohStage();
    const x = W - 34 * unit, top = H * 0.2, th = Math.min(H * 0.22, 190 * unit), tw = 14 * unit, br = 14 * unit, by = top + th + br * 0.6;
    const col = st >= 3 ? '#ff2a12' : st >= 2 ? '#ff8a1f' : st >= 1 ? '#ffb52a' : '#ffd23f';
    ctx.save();
    ctx.fillStyle = 'rgba(10,10,20,0.6)'; ctx.fillRect(x - 22 * unit, top - 12 * unit, 44 * unit, th + br * 2 + 20 * unit);
    ctx.fillStyle = '#fff'; ctx.fillRect(x - tw / 2, top, tw, th);
    ctx.beginPath(); ctx.arc(x, by, br, 0, Math.PI * 2); ctx.fill();
    const fill = th * (0.1 + 0.9 * k);
    ctx.fillStyle = col; ctx.fillRect(x - tw / 2 + 3 * unit, top + th - fill, tw - 6 * unit, fill + br * 0.6);
    ctx.beginPath(); ctx.arc(x, by, br - 4 * unit, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2b1b0e';
    for (let i = 0; i < 4; i++) ctx.fillRect(x + tw / 2 - 5 * unit, top + th * (i + 1) / 5, 5 * unit, 2 * unit);
    ctx.restore();
    const blink = Math.floor(performance.now() / 350) % 2;
    text(st >= 2 ? 'HOT!' : 'TEMP', x, by + br + 14 * unit, 8 * unit, { fill: st >= 2 && blink ? '#ff4a2a' : '#fff' });
  }

  // ---------- Rep Race HUD (clean, not pixel: system font, rounded glass cards) ----------
  const SANS = (weight, px) => `${weight} ${px}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Inter, Roboto, system-ui, sans-serif`;
  const duelDisplayName = (n) => (n ? n.charAt(0) + n.slice(1).toLowerCase() : '');
  function rrect(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function ctext(str, x, y, weight, px, fill, align = 'center', spacing = 0) {
    ctx.font = SANS(weight, px); ctx.textAlign = align; ctx.textBaseline = 'middle';
    const ls = 'letterSpacing' in ctx; if (ls) ctx.letterSpacing = `${spacing}px`;
    ctx.fillStyle = fill; ctx.fillText(str, x, y);
    if (ls) ctx.letterSpacing = '0px';
  }
  function pillText(str, x, y, px, bg, fg) {
    ctx.save();
    ctx.font = SANS(800, px);
    const w = ctx.measureText(str).width + px * 1.4, h = px * 1.9;
    rrect(x - w / 2, y - h / 2, w, h, h / 2); ctx.fillStyle = bg; ctx.fill();
    ctext(str, x, y + px * 0.05, 800, px, fg);
    ctx.restore();
  }
  function glass(x, y, w, h, r) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 30 * unit; ctx.shadowOffsetY = 10 * unit;
    rrect(x, y, w, h, r); ctx.fillStyle = 'rgba(14,16,28,0.86)'; ctx.fill();
    ctx.restore();
    rrect(x + 0.5, y + 0.5, w - 1, h - 1, r); ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1; ctx.stroke();
  }
  function raceAvatar(x, y, r, c1, c2, frame, flip) {
    const ring = ctx.createLinearGradient(x - r, y - r, x + r, y + r); ring.addColorStop(0, c1); ring.addColorStop(1, c2);
    ctx.beginPath(); ctx.arc(x, y, r * 1.09, 0, Math.PI * 2); ctx.fillStyle = ring; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = '#1c2033'; ctx.fill();
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.clip();
    ctx.imageSmoothingEnabled = false;
    const px = r / 14;
    ctx.translate(x + (flip ? -2 : 2) * px, y + 2 * px); if (flip) ctx.scale(-1, 1);
    ctx.drawImage(frame, -11 * px, -8 * px, 22 * px, 16 * px);
    ctx.restore();
  }
  function rankPill(x, y, k, reps, align) {
    const [name, , col] = rankFor(reps);
    ctx.font = SANS(700, 13 * k);
    const w = ctx.measureText(name).width + 30 * k, h = 26 * k, x0 = align === 'left' ? x : x - w;
    rrect(x0, y - h / 2, w, h, h / 2); ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fill();
    ctx.beginPath(); ctx.arc(x0 + 13 * k, y, 5 * k, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
    ctext(name, x0 + 23 * k, y + k, 700, 13 * k, '#e6e8f0', 'left', k);
  }
  // The versus card: avatars + ranks, clock, head-to-head, live reps with a tug-of-war bar.
  function raceCard() {
    const cw = Math.min(W - 32 * unit, 680 * unit), k = cw / 680, ch = 272 * k;
    const x0 = (W - cw) / 2, y0 = Math.max(16 * unit, H * 0.035, pillsBottom() + 8 * unit);
    const X = (v) => x0 + v * k, Y = (v) => y0 + v * k;
    glass(x0, y0, cw, ch, 28 * k);
    ctext(`REP RACE  ·  ${MODES[mode].label}`, X(340), Y(30), 700, 13 * k, 'rgba(255,255,255,0.55)', 'center', 2.5 * k);
    raceAvatar(X(84), Y(100), 44 * k, '#4ade80', '#16a34a', FR.mid, false);
    raceAvatar(X(596), Y(100), 44 * k, '#f87171', '#dc2626', duel.oppFace || RV.rival, true);
    ctext('You', X(146), Y(82), 800, 24 * k, '#ffffff', 'left');
    rankPill(X(146), Y(116), k, duel.myLife ?? lifetimeReps(), 'left');
    ctext(duelDisplayName(duel.oppName), X(534), Y(82), 800, 24 * k, '#ffffff', 'right');
    rankPill(X(534), Y(116), k, duel.oppLife, 'right');
    // clock
    const left = state === 'playing' ? Math.max(0, RACE_MS - (performance.now() - duel.goAt)) : state === 'over' ? 0 : RACE_MS;
    const secs = Math.ceil(left / 1000), urgent = state === 'playing' && secs <= 10;
    ctx.save();
    ctx.translate(X(340), Y(80));
    if (urgent) { const pz = 1 + 0.08 * Math.max(0, Math.sin(performance.now() / 160)); ctx.scale(pz, pz); }
    ctext(`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`, 0, 0, 800, 50 * k, urgent ? '#f87171' : '#ffffff');
    ctx.restore();
    const rec = h2hGet(duel.oppPid);
    rrect(X(292), Y(116), 96 * k, 26 * k, 13 * k); ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fill();
    ctext(`${rec.w} – ${rec.l}`, X(340), Y(130), 700, 14 * k, '#e6e8f0');
    ctext('HEAD TO HEAD', X(340), Y(158), 600, 10 * k, 'rgba(255,255,255,0.4)', 'center', 1.5 * k);
    // reps + tug of war
    const a = duel.reps, b = duel.oppReps;
    const target = (a + 1) / (a + b + 2);
    duel.barF = duel.barF === undefined ? target : duel.barF + (target - duel.barF) * 0.15;
    const by = Y(218), bx0 = X(120), bx1 = X(560), split = bx0 + (bx1 - bx0) * duel.barF;
    const pop = 1 + 0.35 * fx.scorePop * fx.scorePop;
    ctx.save(); ctx.translate(X(56), by); ctx.scale(pop, pop); ctext(String(a), 0, 0, 800, 44 * k, '#4ade80'); ctx.restore();
    ctext(String(b), X(624), by, 800, 44 * k, '#f87171');
    ctext('REPS', X(56), by + 30 * k, 700, 10 * k, 'rgba(255,255,255,0.4)', 'center', 1.5 * k);
    ctext('REPS', X(624), by + 30 * k, 700, 10 * k, 'rgba(255,255,255,0.4)', 'center', 1.5 * k);
    ctx.save();
    rrect(bx0, by - 7 * k, bx1 - bx0, 14 * k, 7 * k); ctx.clip();
    const lg = ctx.createLinearGradient(bx0, 0, split, 0); lg.addColorStop(0, '#16a34a'); lg.addColorStop(1, '#4ade80');
    ctx.fillStyle = lg; ctx.fillRect(bx0, by - 7 * k, split - bx0, 14 * k);
    const rg = ctx.createLinearGradient(split, 0, bx1, 0); rg.addColorStop(0, '#f87171'); rg.addColorStop(1, '#dc2626');
    ctx.fillStyle = rg; ctx.fillRect(split, by - 7 * k, bx1 - split, 14 * k);
    ctx.restore();
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 8 * k;
    ctx.beginPath(); ctx.arc(split, by, 11 * k, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.restore();
    return { bottom: y0 + ch, k, cw };
  }
  // Bottom of the HTML pills (✕, status, 🏆, 🔊) in canvas pixels, so the card sits below them.
  function pillsBottom() {
    const c = canvas.getBoundingClientRect();
    if (!c.height) return 0;
    let bottom = c.top;
    for (const id of ['quit', 'status', 'board', 'mute']) {
      const r = document.getElementById(id).getBoundingClientRect();
      if (r.height) bottom = Math.max(bottom, r.bottom);
    }
    return Math.max(0, (bottom - c.top) * (H / c.height));
  }
  // A centred glass panel with lines of text: [str, weight, px, colour].
  function racePanel(cy, lines, k) {
    const w = Math.min(W - 32 * unit, 520 * unit), gap = 12 * k;
    const h = lines.reduce((t, l) => t + l[2] * 1.25, 0) + gap * (lines.length - 1) + 48 * k;
    glass(W / 2 - w / 2, cy - h / 2, w, h, 24 * k);
    let y = cy - h / 2 + 24 * k;
    for (const [str, weight, px, col] of lines) { y += px * 0.625; ctext(str, W / 2, y, weight, px, col); y += px * 0.625 + gap; }
  }
  function drawRaceHUD() {
    const opp = duelDisplayName(duel.oppName);
    if (!duel.peer && state === 'ready') {
      const posed = tracking.hasPose || keyboardY !== null;
      if (!posed) drawPoseGuide();
      racePanel(H * 0.16, [['Waiting for your friend…', 800, 26 * unit, '#ffffff'], ['Send them the race link', 600, 16 * unit, 'rgba(255,255,255,0.6)']], unit);
      return;
    }
    const card = raceCard(), k = card.k, below = card.bottom + 24 * unit;
    if (duel.gone) {
      racePanel(H * 0.5, [[`${opp} left the race`, 800, 28 * k, '#ffffff'], ['Head back to the menu to start a new one', 600, 15 * k, 'rgba(255,255,255,0.6)']], k);
      return;
    }
    if (state === 'ready') {
      const posed = tracking.hasPose || keyboardY !== null;
      if (!posed) drawPoseGuide();
      const needRep = posed && keyboardY === null && !EXACT && !calibrated();
      const mine = posed ? (needRep ? calibText().join(' · ') : 'You’re set ✓') : MODES[mode].ready;
      const lines = [
        [`Most reps in ${RACE_MS / 1000} seconds wins`, 800, 24 * k, '#ffffff'],
        ['Hit a pipe = 2s stun  ·  only deep reps count', 600, 14 * k, 'rgba(255,255,255,0.6)'],
        [mine, 700, 16 * k, posed && !needRep ? '#4ade80' : '#facc15'],
        [duel.oppReady ? `${opp} is set ✓` : `Waiting for ${opp}…`, 700, 16 * k, '#93c5fd'],
      ];
      const lh = lines.reduce((t, l) => t + l[2] * 1.25, 0) + 12 * k * 3 + 48 * k;
      racePanel(below + lh / 2, lines, k);
      return;
    }
    if (state === 'countdown') {
      const n = 3 - Math.floor(stateTimer / 1000), t = (stateTimer % 1000) / 1000;
      const punch = 1 + 0.6 * Math.pow(1 - t, 3);
      ctx.save();
      ctx.translate(W / 2, H * 0.5); ctx.scale(punch, punch);
      ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 24 * unit;
      ctext(n > 0 ? String(n) : 'GO!', 0, 0, 900, 130 * unit, '#ffffff');
      ctx.restore();
      return;
    }
    if (state === 'over') {
      if (!duel.result) {
        racePanel(H * 0.5, [['Time!', 900, 44 * k, '#ffffff'], [`Waiting for ${opp}’s reps…`, 600, 16 * k, 'rgba(255,255,255,0.6)']], k);
        return;
      }
      const head = duel.result === 'win' ? 'VICTORY' : duel.result === 'lose' ? 'DEFEAT' : 'DRAW';
      const col = duel.result === 'win' ? '#4ade80' : duel.result === 'lose' ? '#f87171' : '#facc15';
      const rec = h2hGet(duel.oppPid);
      const lines = [[head, 900, 52 * k, col], [`${duel.reps} – ${duel.oppReps}`, 800, 40 * k, '#ffffff']];
      if (duel.reps === duel.oppReps && duel.result !== 'draw') lines.push([`Full-range reps ${duel.full} – ${duel.oppFull}`, 600, 15 * k, 'rgba(255,255,255,0.7)']);
      lines.push([`Head to head vs ${opp}: ${rec.w} – ${rec.l}`, 600, 15 * k, 'rgba(255,255,255,0.6)']);
      racePanel(H * 0.5, lines, k);
    }
  }

  function drawDuelHUD(big, mid, small) {
    // Scoreboard on the ground strip, always visible (and in any recording): YOU 2 – 1 RIVAL.
    const gy = groundTop() + groundH() * 0.5;
    text(`${playerName} ${duel.me}`, W / 2 - 14 * unit, gy, 12 * unit, { fill: '#f6c948', align: 'right' });
    text('–', W / 2, gy, 12 * unit);
    text(`${duel.them} ${duel.oppName}`, W / 2 + 14 * unit, gy, 12 * unit, { fill: '#4fc3f7', align: 'left' });

    if (duel.gone) {
      text(`${duel.oppName} LEFT`, W / 2, H * 0.22, mid, { fill: '#e0432b' });
      text('THE DUEL IS OVER', W / 2, H * 0.29, small);
      return;
    }
    if (state === 'playing') {
      const pop = 1 + 0.45 * fx.scorePop * fx.scorePop;
      ctx.save();
      ctx.translate(W / 2, H * 0.12); ctx.scale(pop, pop);
      text(fmtScore(mode, score), 0, 0, big);
      ctx.restore();
      const oppLine = duel.oppMs !== null ? `${duel.oppName} OUT AT ${fmtScore(mode, duel.oppScore)} — OUTLAST THEM`
                                          : `${duel.oppName} ${fmtScore(mode, duel.oppScore)}`;
      text(oppLine, W / 2, H * 0.2, 9 * unit, { fill: '#4fc3f7' });
      return;
    }
    if (state === 'ready') {
      const posed = tracking.hasPose || keyboardY !== null;
      if (!posed) drawPoseGuide();
      if (!duel.peer) {
        text('WAITING FOR RIVAL…', W / 2, H * 0.2, 16 * unit, { fill: '#f6c948' });
        text('SEND THEM THE DUEL LINK', W / 2, H * 0.26, 10 * unit);
        return;
      }
      text(`ROUND ${duel.round + 1}`, W / 2, H * 0.17, 30 * unit, { fill: '#f6c948' });
      text(`FIRST TO ${DUEL_WIN}`, W / 2, H * 0.225, 10 * unit);
      const needRep = posed && keyboardY === null && !EXACT && !MODES[mode].hold && !calibrated();
      const mine = posed ? (needRep ? calibText().join(' · ') : 'YOU ARE SET ✓') : MODES[mode].ready;
      text(mine, W / 2, H * 0.28, small);
      text(duel.oppReady ? `${duel.oppName} IS SET ✓` : `WAITING FOR ${duel.oppName}…`, W / 2, H * 0.325, 10 * unit, { fill: '#4fc3f7' });
      return;
    }
    if (state === 'countdown') {
      const n = 3 - Math.floor(stateTimer / 1000);
      const t = (stateTimer % 1000) / 1000;
      const punch = 1 + 0.7 * Math.pow(1 - t, 3);
      ctx.save();
      ctx.translate(W / 2, H * 0.22); ctx.scale(punch, punch);
      text(n > 0 ? String(n) : 'GO!', 0, 0, big, { fill: '#f6c948' });
      ctx.restore();
      text(`ROUND ${duel.round} · vs ${duel.oppName}`, W / 2, H * 0.12, 10 * unit);
      return;
    }
    if (state === 'over') {
      const pw = Math.min(W * 0.8, 380 * unit), ph = 150 * unit;
      const px0 = W / 2 - pw / 2, py0 = H * 0.16;
      let head, sub;
      if (duel.matchOver) {
        head = duel.me > duel.them ? 'YOU WIN THE DUEL!' : `${duel.oppName} WINS`;
        sub = 'FINAL SCORE';
      } else if (duel.result) {
        head = duel.result === 'win' ? 'ROUND WON!' : duel.result === 'lose' ? 'ROUND LOST' : 'DEAD HEAT';
        sub = `ROUND ${duel.round} · FIRST TO ${DUEL_WIN}`;
      } else {
        head = 'YOU\'RE OUT';
        sub = `${duel.oppName} STILL GOING: ${fmtScore(mode, duel.oppScore)}`;
      }
      const win = duel.matchOver ? duel.me > duel.them : duel.result === 'win';
      text(head, W / 2, py0 - 34 * unit, (head.length > 14 ? 20 : 26) * unit, { fill: win ? '#7ec850' : '#f6c948' });
      panel(px0, py0, pw, ph);
      text(sub, W / 2, py0 + ph * 0.22, 9 * unit, { fill: '#e0432b' });
      text(`${duel.me} – ${duel.them}`, W / 2, py0 + ph * 0.52, 30 * unit, { fill: '#3d1c12', stroke: '#ded895' });
      const mineStr = `YOU ${fmtScore(mode, score)}`;
      const theirs = duel.oppMs !== null ? `${duel.oppName} ${fmtScore(mode, duel.oppScore)}` : `${duel.oppName} …`;
      text(`${mineStr}  ·  ${theirs}`, W / 2, py0 + ph * 0.82, 9 * unit, { fill: '#3d1c12', stroke: '#ded895' });
      if (duel.nextAt) {
        const left = Math.max(0, Math.ceil((duel.nextAt - performance.now()) / 1000));
        text(`NEXT ROUND IN ${left}s`, W / 2, py0 + ph + 26 * unit, 9 * unit);
      }
    }
  }

  // Translucent silhouette showing where the body should be for the current exercise.
  function drawPoseGuide() {
    const m = Math.min(W, H);
    const pulse = 0.22 + 0.08 * Math.sin(performance.now() / 350);
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = `rgba(255,255,255,${pulse})`;
    ctx.fillStyle = `rgba(255,255,255,${pulse})`;
    ctx.lineWidth = m * 0.07;
    const seg = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
    const head = (x, y, r) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); };
    let lineY, label;
    if (mode === 'plank') {
      // Side view: head left, straight body to the feet on the right, forearms planted.
      const gt = groundTop() - 6 * unit;
      const hy = H * 0.66;
      head(W * 0.16, hy - m * 0.02, m * 0.06);
      seg(W * 0.24, hy, W * 0.86, hy + H * 0.04);           // shoulders → ankles
      seg(W * 0.26, hy, W * 0.2, gt);                       // upper arm down
      seg(W * 0.2, gt, W * 0.34, gt);                       // forearm on the floor
      seg(W * 0.86, hy + H * 0.04, W * 0.9, gt);            // feet
      lineY = hy + H * 0.02; label = 'HIPS HERE';
    } else if (mode === 'pushup') {
      // Seen from a phone on the floor: head, wide shoulders, arms planted at the bottom corners.
      const cx = W / 2, sy = H * 0.6;
      head(cx, H * 0.44, m * 0.11);
      seg(cx - W * 0.22, sy, cx + W * 0.22, sy);
      seg(cx - W * 0.22, sy, cx - W * 0.3, groundTop() - 6 * unit);
      seg(cx + W * 0.22, sy, cx + W * 0.3, groundTop() - 6 * unit);
      lineY = sy; label = 'SHOULDERS HERE';
    } else {
      // Standing figure in the lower half, under the title text.
      const cx = W / 2;
      head(cx, H * 0.45, m * 0.06);
      seg(cx, H * 0.51, cx, H * 0.7);                       // torso
      seg(cx - W * 0.15, H * 0.62, cx, H * 0.53);           // arms
      seg(cx + W * 0.15, H * 0.62, cx, H * 0.53);
      seg(cx, H * 0.7, cx - W * 0.09, groundTop() - 8 * unit);  // legs
      seg(cx, H * 0.7, cx + W * 0.09, groundTop() - 8 * unit);
      lineY = H * 0.7; label = 'HIPS HERE';
    }
    // Target line for the tracked joint.
    ctx.strokeStyle = 'rgba(246,201,72,0.7)';
    ctx.lineWidth = 2 * unit;
    ctx.setLineDash([8 * unit, 8 * unit]);
    ctx.beginPath(); ctx.moveTo(0, lineY); ctx.lineTo(W, lineY); ctx.stroke();
    ctx.restore();
    text(label, W - 12 * unit, lineY - 14 * unit, 9 * unit, { fill: '#f6c948', align: 'right' });
    text('MATCH THE POSE', W / 2, H * 0.36, 11 * unit);
  }

  function drawWatermark() {
    // Small site tag so shared clips carry the URL (drawn on the ground strip, right side).
    ctx.save();
    ctx.globalAlpha = 0.85;
    text('flappyreps.com', W - 10 * unit, groundTop() + groundH() * 0.55, 9 * unit, { fill: '#3d1c12', stroke: '#ded895', align: 'right' });
    ctx.restore();
  }

  function drawTrackingGuide() {
    // Plank: the locked hold height the gaps are centred on.
    if (MODES[mode].hold && state === 'playing') {
      ctx.save();
      ctx.strokeStyle = 'rgba(246,201,72,0.55)';
      ctx.setLineDash([10 * unit, 8 * unit]);
      ctx.lineWidth = 2 * unit;
      ctx.beginPath(); ctx.moveTo(0, holdY); ctx.lineTo(W, holdY); ctx.stroke();
      ctx.restore();
    }
    // Thin horizontal line showing the tracked joint height, for feedback.
    if (!tracking.hasPose || state === 'over') return;
    const seenNow = performance.now() - tracking.lastSeen < POSE_TIMEOUT_MS;
    if (state === 'ready' && seenNow) {
      // Show exactly what the camera is tracking: a dot on each detected shoulder/hip.
      const ok = tracking.source === MODES[mode].source;
      ctx.save();
      ctx.fillStyle = ok ? 'rgba(126,200,80,0.95)' : 'rgba(246,201,72,0.95)';
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3 * unit;
      for (const p of tracking.pts) { ctx.beginPath(); ctx.arc(camX(p.x), camY(p.y), 11 * unit, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      if (tracking.pts.length === 2) { ctx.beginPath(); ctx.moveTo(camX(tracking.pts[0].x), camY(tracking.pts[0].y)); ctx.lineTo(camX(tracking.pts[1].x), camY(tracking.pts[1].y)); ctx.stroke(); }
      ctx.restore();
      // Calibration targets: the bird has to reach both bands for a rep to count.
      if (!calib.done && keyboardY === null && !EXACT && !MODES[mode].hold) {
        const bottom = groundTop() / H - 0.08, yAt = (n) => (PLAY_TOP + n * (bottom - PLAY_TOP)) * H;
        ctx.save();
        for (const [n0, n1, lab, on] of [[0, 0.28, 'UP', calib.zone === 'high'], [0.72, 1, 'DOWN', calib.zone === 'low']]) {
          ctx.fillStyle = on ? 'rgba(126,200,80,0.22)' : 'rgba(255,255,255,0.10)';
          ctx.fillRect(0, yAt(n0), W, yAt(n1) - yAt(n0));
          ctx.font = `${10 * unit}px ${getComputedStyle(document.body).getPropertyValue('--font') || 'monospace'}`;
          ctx.fillStyle = on ? 'rgba(126,200,80,0.95)' : 'rgba(255,255,255,0.7)';
          ctx.textAlign = 'right'; ctx.fillText(lab, W - 12 * unit, (yAt(n0) + yAt(n1)) / 2);
        }
        ctx.restore();
      }
    }
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([6 * unit, 6 * unit]);
    ctx.lineWidth = 2 * unit;
    const y = tracking.targetY * H;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.restore();
  }

  function render() {
    ctx.save();
    if (fx.shake > 0) {
      const mag = 16 * unit * fx.shake * fx.shake;
      ctx.translate((Math.random() - 0.5) * mag, (Math.random() - 0.5) * mag);
    }
    drawVideo();
    for (const p of pipes) drawPipe(p);
    if (!tune.raw) drawGround();
    if (!attract && !tune.raw) drawTrackingGuide();
    if (!attract) drawRival();
    if (!attract) drawGhost();
    if (!attract) { drawOverheatHaze(); drawSmoke(); }
    drawBird();
    if (state === 'over' && !tune.raw && !(duel.on && duel.outlasted)) { ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(-W, -H, W * 3, H * 3); drawBird(); }
    if (!tune.raw) drawFx();
    if (!attract && !tune.raw) drawHUD();
    ctx.restore();
    if (fx.flash > 0) { ctx.fillStyle = `rgba(255,255,255,${0.7 * fx.flash})`; ctx.fillRect(0, 0, W, H); }
    if (!tune.raw && !attract && (!duel.on || raceOn())) drawWatermark(); // the survival scoreboard owns the ground strip
    recFrame();
  }

  // ---------- Loop ----------
  function frame(now) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }

  // ---------- Duels (1 v 1 over a link: 60 s Rep Race, or survival first to 3) ----------
  // Both players get the same seeded course. Only bird height, reps/score and round events cross
  // the wire (DuelNet), never video. The creator of the link is the host: it picks the exercise and
  // the format, and starts each round once both players are set, sending the seed.
  // Rep Race (`duel.fmt` 'race', the default; plank always uses survival): RACE_MS on the clock,
  // most counted reps wins (ties: more full-range reps). Only reps of at least RACE_REP_MIN of the
  // play range count, and hitting a pipe stuns you for RACE_STUN_MS (you fly through, reps don't
  // count). One race per match, then REMATCH. Races are recorded so the clip carries the scoreboard.
  // Survival ('survive'): a round ends when both have crashed, or as soon as the survivor outlasts
  // the one who crashed; longer survival wins it. First to DUEL_WIN rounds takes the duel.
  const DUEL_WIN = 3;
  const RACE_MS = (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && Number(new URLSearchParams(location.search).get('racesecs')) || 60) * 1000;
  const RACE_STUN_MS = 2000;
  const RACE_REP_MIN = 0.3;
  const DUEL_FMT_KEY = 'pushup-bird-duel-fmt';   // the host's last pick
  // Rank badge from lifetime reps (no accounts yet), and a head-to-head record per opponent,
  // keyed by a random per-browser player id that travels in `hello`.
  const RANKS = [['BRONZE', 0, '#d08a4e'], ['SILVER', 100, '#cbd5e1'], ['GOLD', 500, '#facc15'],
    ['PLATINUM', 1500, '#5eead4'], ['DIAMOND', 4000, '#7dd3fc'], ['CHAMPION', 10000, '#f472b6']];
  const rankFor = (reps) => RANKS.filter((r) => reps >= r[1]).pop();
  const PID_KEY = 'pushup-bird-pid', H2H_KEY = 'pushup-bird-h2h';
  const myPid = localStorage.getItem(PID_KEY) || (() => { const id = Math.random().toString(36).slice(2, 12); localStorage.setItem(PID_KEY, id); return id; })();
  function h2hAll() { try { return JSON.parse(localStorage.getItem(H2H_KEY) || '{}') || {}; } catch { return {}; } }
  const h2hGet = (pid) => (pid && h2hAll()[pid]) || { w: 0, l: 0 };
  function h2hAdd(result) {
    if (!duel.oppPid || result === 'draw') return;
    const all = h2hAll(), r = all[duel.oppPid] || { w: 0, l: 0 };
    r[result === 'win' ? 'w' : 'l'] += 1; r.name = duel.oppName;
    all[duel.oppPid] = r;
    localStorage.setItem(H2H_KEY, JSON.stringify(all));
  }
  const raceOn = () => duel.on && duel.fmt === 'race' && !MODES[mode].hold;
  const DUEL_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const DUEL_POS_MS = 166;         // send our bird height 6x a second while playing (the rival is smoothed);
                                   // Supabase free plan caps the whole project at 100 messages/s
  const DUEL_HELLO_MS = 1000;      // heartbeat: carries our full round state, so a dropped message heals
  const DUEL_TIMEOUT_MS = 8000;    // rival counts as gone after this much silence
  const DUEL_NEXT_MS = 4500;       // pause on the result card between rounds
  const DUEL_HOST_KEY = 'pushup-bird-duel-host'; // sessionStorage: code of the duel this tab created
  // ↑/↓ keys stay available in duels only on a dev machine, so two tabs can be tested without a camera.
  const DUEL_KEYS_OK = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const duelEl = document.getElementById('duel');
  const duelBar = document.getElementById('duelbar');
  const duel = {
    on: false, code: null, host: false, link: null, id: Math.random().toString(36).slice(2, 10),
    peer: null, oppName: 'RIVAL', lastHeard: 0, lastHello: 0, lastPos: 0,
    seed: 0, round: 0, me: 0, them: 0, pipeIdx: 0, goAt: 0,
    iReady: false, oppReady: false,
    oppY: null, oppA: 0, oppScore: 0, oppMs: null, myMs: null, showY: null,
    result: null, nextAt: 0, matchOver: false, gone: false,
    fmt: 'race', reps: 0, full: 0, oppReps: 0, oppFull: 0, stunUntil: 0,
    oppPid: null, oppSkin: null, oppFace: null, oppLife: 0,
  };

  function duelRand(i) {
    // Deterministic per-pipe random in [0,1) from the round seed (mulberry32 mix).
    let t = (duel.seed + Math.imul(i + 1, 0x9e3779b9)) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const duelSend = (type, data = {}) => { if (duel.link) duel.link.send({ t: type, from: duel.id, ...data }); };
  const duelUrl = (code) => `${location.origin}${location.pathname}?duel=${code}`;
  const duelHello = () => duelSend('hello', {
    name: playerName, mode, host: duel.host, ready: duel.iReady, round: duel.round,
    fmt: duel.host ? duel.fmt : undefined, pid: myPid, skin: skinId, life: (duel.myLife = lifetimeReps()),
    seed: duel.host && duel.round ? duel.seed : undefined,   // lets a rival who missed `start` catch up
    ms: duel.myMs ?? undefined, s: duel.myMs !== null ? score : undefined, // repeats a possibly-lost `dead`
    r: duel.myMs !== null ? duel.reps : undefined, f: duel.myMs !== null ? duel.full : undefined,
  });

  function duelOpen(code, host) {
    duelClose(true);
    Object.assign(duel, { on: true, code, host, peer: null, oppName: 'RIVAL', lastHeard: 0, lastHello: 0, round: 0, me: 0, them: 0,
      iReady: false, oppReady: false, result: null, nextAt: 0, matchOver: false, gone: false, oppY: null, oppMs: null, myMs: null,
      fmt: host ? (localStorage.getItem(DUEL_FMT_KEY) || 'race') : 'race', reps: 0, full: 0, oppReps: 0, oppFull: 0, stunUntil: 0,
      oppPid: null, oppSkin: null, oppFace: null, oppLife: 0 });
    if (host) sessionStorage.setItem(DUEL_HOST_KEY, code);
    history.replaceState(null, '', `?duel=${code}`);
    document.body.classList.add('in-duel');
    duel.link = DuelNet.connect(code, duelOnMessage);
    document.getElementById('duel-name').value = playerName === 'YOU' ? '' : playerName;
    duelFmtUi();
    document.getElementById('duel-link').value = duelUrl(code);
    document.getElementById('duel-linkrow').hidden = !host;
    document.getElementById('duel-join').hidden = host;
    duelLobbyStatus(host ? 'Send this link to your rival:' : 'Looking for the duel…');
    duelEl.hidden = false;
    duelHello();
    duel.hb = setInterval(duelHeartbeat, DUEL_HELLO_MS);
  }
  // Lobby: the host picks Rep Race or Survival; the guest sees what they were challenged to.
  const duelFmtText = () => (duel.fmt === 'race' && !MODES[mode].hold ? `rep race · ${RACE_MS / 1000}s · most reps wins` : `survival · first to ${DUEL_WIN} rounds`);
  function duelFmtUi() {
    document.getElementById('duel-mode').textContent = MODES[mode].label;
    document.getElementById('duel-fmt-text').textContent = duelFmtText();
    const box = document.getElementById('duel-fmt');
    box.hidden = !duel.host || !!MODES[mode].hold;   // planks are always survival
    box.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.fmt === duel.fmt));
  }
  function duelLobbyStatus(msg, ok) {
    const s = document.getElementById('duel-status');
    s.textContent = msg; s.className = 'duel-status' + (ok ? ' ok' : '');
  }

  function duelOnMessage(m) {
    if (!m || m.from === duel.id || !duel.on) return;
    if (duel.peer && m.from !== duel.peer) return;   // a duel is two players; ignore anyone else on the code
    duel.lastHeard = performance.now();
    if (m.t === 'hello') {
      const first = !duel.peer;
      duel.peer = m.from;
      const nm = String(m.name || '').toUpperCase().slice(0, 12);
      duel.oppName = nm && nm !== 'YOU' ? nm : 'RIVAL'; // 'YOU' is the unset default; it reads wrong on their side
      // Two tabs can both believe they created the room (shared session storage); one steps down.
      if (m.host && duel.host && m.from < duel.id) duel.host = false;
      if (m.host && !duel.host && MODES[m.mode] && m.mode !== mode) setMode(m.mode, true);
      if (m.host && !duel.host) { const f = m.fmt === 'race' ? 'race' : 'survive'; if (f !== duel.fmt) { duel.fmt = f; duelFmtUi(); } } // older hosts send no fmt
      if (typeof m.pid === 'string') duel.oppPid = m.pid.slice(0, 16);
      duel.oppLife = Math.max(0, m.life | 0);
      if (m.skin !== duel.oppSkin && SKINS.some((k) => k.id === m.skin)) { duel.oppSkin = m.skin; duel.oppFace = buildFrames(m.skin).mid; }
      if (m.round === duel.round) duel.oppReady = !!m.ready;
      // Heartbeat recovery: a round we never got `start` for, or a result whose `dead` was lost.
      // (only the very next round: a hello sent just before a rematch reset must not restart an old one)
      if (m.host && !duel.host && m.round === duel.round + 1 && m.seed !== undefined && !duel.gone) duelBeginRound(m.round, m.seed);
      else if (m.round === duel.round && m.ms !== undefined && duel.oppMs === null) { duel.oppMs = m.ms; duel.oppScore = m.s || 0; duel.oppReps = m.r | 0; duel.oppFull = m.f | 0; duelResolve(); }
      if (first) {
        duelHello(); // answer right away so both sides see each other
        duelFmtUi();
        if (window.FRAnalytics) FRAnalytics.duel(duel.host ? 'create' : 'join', mode);
        if (duel.host) { duelLobbyStatus(`${duel.oppName} joined!`, true); duelEnterGame(); }
        else duelLobbyStatus(`${duel.oppName === 'RIVAL' ? 'A friend' : duel.oppName} challenged you: ${MODES[mode].label.toLowerCase()}, ${duelFmtText()}.`, true);
      }
    } else if (m.t === 'ready') {
      if (m.round === duel.round) duel.oppReady = !!m.ready;
    } else if (m.t === 'start') {
      if (!duel.host && m.round > duel.round) { if (m.fmt === 'race' || m.fmt === 'survive') duel.fmt = m.fmt; duelBeginRound(m.round, m.seed); }
    } else if (m.t === 'pos') {
      if (m.round !== duel.round) return;
      duel.oppY = m.y; duel.oppA = m.a || 0;
      if (duel.oppMs === null) { duel.oppScore = m.s; if (m.r !== undefined) duel.oppReps = m.r | 0; }
    } else if (m.t === 'dead') {
      if (m.round !== duel.round || duel.oppMs !== null) return;
      duel.oppMs = m.ms; duel.oppScore = m.s; duel.oppReps = m.r | 0; duel.oppFull = m.f | 0;
      duelResolve();
    } else if (m.t === 'rematch') {
      if (duel.matchOver) duelRematch(false);
    } else if (m.t === 'bye') {
      duelGone();
    }
  }

  function duelSetReady(r) {
    if (duel.iReady === r) return;
    duel.iReady = r;
    duelSend('ready', { ready: r, round: duel.round });
  }

  // Presence runs on a timer, not the frame loop: timers keep ticking in a background tab
  // (e.g. while the host is in a messaging app sending the link), requestAnimationFrame doesn't.
  function duelHeartbeat() {
    if (!duel.on) return;
    duelHello();
    if (duel.peer && !duel.gone && performance.now() - duel.lastHeard > DUEL_TIMEOUT_MS) { duelSend('bye'); duelGone(); }
  }

  // Called every frame while a duel is open.
  function duelTick(now) {
    if (duel.gone) return;
    if (state === 'playing' && now - duel.lastPos > DUEL_POS_MS) {
      duel.lastPos = now;
      duelSend('pos', { round: duel.round, y: bird.y / H, a: MODES[mode].hold ? holdY / H : 0, s: score, r: duel.reps });
    }
    // Host starts the next round once both players are set.
    if (duel.host && state === 'ready' && !attract && duel.peer && !duel.matchOver && duel.iReady && duel.oppReady) {
      const seed = (Math.random() * 4294967296) >>> 0;
      duelSend('start', { round: duel.round + 1, seed, fmt: duel.fmt });
      duelBeginRound(duel.round + 1, seed);
    }
  }

  function duelBeginRound(round, seed) {
    Object.assign(duel, { round, seed, pipeIdx: 0, iReady: false, oppReady: false, oppY: null, showY: null, outlasted: false,
      oppScore: 0, oppMs: null, myMs: null, result: null, nextAt: 0, reps: 0, full: 0, oppReps: 0, oppFull: 0, stunUntil: 0 });
    toCountdown();
  }

  // We crashed, or outlasted a rival who already crashed: report our time and try to settle the round.
  function duelFinishRun() {
    if (duel.myMs !== null) return;
    duel.myMs = Math.round(performance.now() - duel.goAt);
    duelSend('dead', { round: duel.round, ms: duel.myMs, s: score, r: duel.reps, f: duel.full });
    duelResolve();
  }

  function duelResolve() {
    if (duel.myMs === null || duel.oppMs === null || duel.result) {
      // Rival is out and we're still flying: nothing to settle yet, the play loop ends the round
      // the moment we pass their time.
      return;
    }
    if (raceOn()) {
      // Rep Race: one race decides it; most reps, then most full-range reps.
      const a = duel.reps, b = duel.oppReps;
      duel.result = a !== b ? (a > b ? 'win' : 'lose') : duel.full !== duel.oppFull ? (duel.full > duel.oppFull ? 'win' : 'lose') : 'draw';
      if (duel.result === 'win') { duel.me += 1; sfx.milestone(); burst(W / 2, H * 0.45, 50, ['#4ade80', '#facc15', '#ffffff'], H * 0.6, H * 0.8); }
      if (duel.result === 'lose') duel.them += 1;
      duel.matchOver = true;
      duelBar.hidden = false;
      h2hAdd(duel.result);
      setTimeout(() => stopRecording(false), 2600);   // keep the result card in the clip
      if (window.FRAnalytics) FRAnalytics.duel('end', mode);
      return;
    }
    duel.result = duel.myMs > duel.oppMs ? 'win' : duel.myMs < duel.oppMs ? 'lose' : 'draw';
    if (duel.result === 'win') { duel.me += 1; sfx.milestone(); burst(W / 2, H * 0.3, 40, ['#7ec850', '#f7d21c', '#ffffff'], H * 0.6, H * 0.8); }
    if (duel.result === 'lose') duel.them += 1;
    if (duel.me >= DUEL_WIN || duel.them >= DUEL_WIN) {
      duel.matchOver = true;
      duelBar.hidden = false;
      h2hAdd(duel.me > duel.them ? 'win' : 'lose');
      if (window.FRAnalytics) FRAnalytics.duel('end', mode);
    } else {
      duel.nextAt = performance.now() + DUEL_NEXT_MS;
    }
  }

  function duelRematch(announce) {
    if (announce) duelSend('rematch');
    Object.assign(duel, { round: 0, me: 0, them: 0, matchOver: false, result: null, nextAt: 0, iReady: false, oppReady: false });
    duelBar.hidden = true;
    resetRun();
    toReady();
  }

  function duelGone() {
    if (duel.gone) return;
    duel.gone = true;
    duel.nextAt = 0;
    if (raceOn()) stopRecording(true);
    if (state === 'playing' || state === 'countdown') { resetRun(); state = 'over'; stateTimer = 0; }
    duelLobbyStatus(`${duel.oppName} left the duel.`);
    document.getElementById('duel-rematch').hidden = true;
    duelBar.hidden = false;
  }

  // Leave the duel entirely (quit, menu, or closing the lobby). `silent` skips the goodbye.
  function duelClose(silent) {
    if (!duel.on) return;
    if (!silent) duelSend('bye');
    if (duel.link) duel.link.close();
    clearInterval(duel.hb);
    duel.link = null; duel.on = false; duel.peer = null;
    document.body.classList.remove('in-duel');
    if (sessionStorage.getItem(DUEL_HOST_KEY) === duel.code) sessionStorage.removeItem(DUEL_HOST_KEY);
    duelEl.hidden = true;
    duelBar.hidden = true;
    document.getElementById('duel-rematch').hidden = false;
    if (new URLSearchParams(location.search).has('duel')) history.replaceState(null, '', location.pathname);
  }

  // Both players are in: hide the lobby and go to the ready screen with the camera on.
  function duelEnterGame() {
    duelEl.hidden = true;
    if (!intro.hidden) enterGame();
  }

  function newDuelCode() {
    let c = '';
    for (let i = 0; i < 5; i++) c += DUEL_CODE_CHARS[(Math.random() * DUEL_CODE_CHARS.length) | 0];
    return c;
  }

  // ---------- Input ----------
  function nudge(dir) {
    // Each keydown (including auto-repeat while held) moves the bird one step.
    if (duel.on && !DUEL_KEYS_OK) return; // duels are body-only
    if (keyboardY === null) keyboardY = bird.y / H;
    keyboardY = Math.min(1, Math.max(0, keyboardY + dir * 0.04));
  }
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) { if (e.key === 'Escape') closeBoard(); return; }
    if (e.key === 'ArrowUp') { nudge(-1); e.preventDefault(); }
    if (e.key === 'ArrowDown') { nudge(1); e.preventDefault(); }
    if (e.key === ' ') { ensureAudio(); if (state === 'over' && !duel.on) toReady(); e.preventDefault(); }
    if (e.key === 'Escape') { if (boardOpen) closeBoard(); else if (intro.hidden) quitToMenu(); }
    if (e.key === 'l' || e.key === 'L') { boardOpen ? closeBoard() : openBoard(); }
  });
  canvas.addEventListener('pointerdown', () => { ensureAudio(); if (state === 'over' && !duel.on) toReady(); });

  modeBtn.addEventListener('click', () => setMode(MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length]));
  modeButtons.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  setMode(mode); // sync UI with the saved mode

  document.getElementById('board').addEventListener('click', openBoard);
  document.getElementById('intro-board').addEventListener('click', openBoard);
  document.getElementById('board-close').addEventListener('click', closeBoard);
  boardEl.addEventListener('click', (e) => { if (e.target === boardEl) closeBoard(); });
  boardTabs.forEach((b) => b.addEventListener('click', () => { boardMode = b.dataset.board; renderBoard(); }));
  nameInput.addEventListener('input', () => {
    playerName = (nameInput.value.trim().toUpperCase() || 'YOU').slice(0, 12);
    localStorage.setItem(NAME_KEY, playerName);
    renderBoard();
  });
  document.getElementById('board-clear').addEventListener('click', () => {
    if (!confirm('Delete all recorded runs on this device?')) return;
    runs = []; saveRuns(); renderBoard();
  });

  shareBtn.addEventListener('click', () => { ensureAudio(); shareClip(); });
  document.getElementById('share-close').addEventListener('click', () => { shareBar.hidden = true; });
  if (!canRecord) shareBar.hidden = true;

  document.getElementById('quit').addEventListener('click', () => { ensureAudio(); quitToMenu(); });
  document.getElementById('again').addEventListener('click', () => { ensureAudio(); if (state === 'over') toReady(); });

  muteBtn.addEventListener('click', () => {
    muted = !muted;
    muteBtn.textContent = muted ? '🔇' : '🔊';
  });

  requestAnimationFrame(frame); // the demo runs behind the intro from page load

  startBtn.addEventListener('click', () => {
    ensureAudio();
    daily.on = DAILY_URL;
    if (window.Paywall && !Paywall.canPlay(mode)) { Paywall.show(); return; }
    enterGame();
  });
  document.getElementById('intro-daily').addEventListener('click', () => {
    ensureAudio();
    daily.on = true;
    if (window.Paywall && !Paywall.canPlay(mode)) { Paywall.show(); return; }
    enterGame();
  });

  // Skins screen: every bird with its unlock state; tap an unlocked one to wear it.
  const skinsEl = document.getElementById('skins');
  function renderSkins() {
    const total = lifetimeReps();
    document.getElementById('skins-total').textContent = `LIFETIME REPS: ${total}`;
    const list = document.getElementById('skins-list');
    list.innerHTML = '';
    for (const sk of SKINS) {
      const open = skinUnlocked(sk, total);
      const li = document.createElement('li');
      li.className = (open ? '' : 'locked') + (sk.id === skinId ? ' on' : '');
      const c = document.createElement('canvas'); c.width = 22; c.height = 16;
      c.getContext('2d').drawImage(buildFrames(sk.id).mid, 0, 0);
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = sk.name;
      const st = document.createElement('span'); st.className = 'st';
      st.textContent = sk.id === skinId ? 'WEARING' : open ? 'TAP TO WEAR' : sk.pro ? 'DAY PASS / PRO' : `${sk.need - total} REPS TO GO`;
      li.append(c, nm, st);
      if (!open && !sk.pro) {
        const bar = document.createElement('div'); bar.className = 'skins-bar';
        const fill = document.createElement('i'); fill.style.width = `${Math.min(100, (total / sk.need) * 100)}%`;
        bar.append(fill); li.append(bar);
      }
      if (open) li.addEventListener('click', () => { setSkin(sk.id); renderSkins(); });
      list.append(li);
    }
  }
  document.getElementById('intro-skins').addEventListener('click', () => { renderSkins(); skinsEl.hidden = false; });
  document.getElementById('skins-close').addEventListener('click', () => { skinsEl.hidden = true; });
  skinsEl.addEventListener('click', (e) => { if (e.target === skinsEl) skinsEl.hidden = true; });

  // Leave the intro for the ready screen and turn the camera on (solo Play, or joining a duel).
  async function enterGame() {
    intro.hidden = true;
    document.body.classList.remove('in-intro');
    attract = false;
    resetRun();
    toReady();
    try {
      await startCamera();
    } catch (err) {
      console.error(err);
      if (window.FRAnalytics) FRAnalytics.cameraDenied();
      camPhase = 'failed';
      setStatus('camera blocked — use ↑ ↓ keys', 'bad');
    }
  }

  // Duel wiring: the intro button creates a room and shows the link; opening that link joins it.
  // Soft launch: the button shows only with ?duels=1 (or on localhost) until DUELS_PUBLIC is
  // flipped; any duel link can always be joined. Needs a transport that reaches other devices.
  const DUELS_PUBLIC = false;
  const DUELS_AVAILABLE = !!window.DuelNet && (DuelNet.live || DUEL_KEYS_OK);
  const DUELS_CREATE = DUELS_AVAILABLE && (DUELS_PUBLIC || DUEL_KEYS_OK || new URLSearchParams(location.search).get('duels') === '1');
  document.getElementById('intro-duel').hidden = !DUELS_CREATE;
  document.getElementById('intro-duel').addEventListener('click', () => { ensureAudio(); duelOpen(newDuelCode(), true); });
  document.getElementById('duel-join').addEventListener('click', () => { ensureAudio(); duelEnterGame(); });
  document.querySelectorAll('#duel-fmt button').forEach((b) => b.addEventListener('click', () => {
    if (!duel.host || duel.round) return;
    duel.fmt = b.dataset.fmt;
    localStorage.setItem(DUEL_FMT_KEY, duel.fmt);
    duelFmtUi();
    duelHello();
  }));
  document.getElementById('duel-close').addEventListener('click', () => duelClose(false));
  document.getElementById('duel-copy').addEventListener('click', async () => {
    const url = duelUrl(duel.code);
    const btn = document.getElementById('duel-copy');
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: 'Flappy Reps duel', text: `Duel me on Flappy Reps, ${MODES[mode].label.toLowerCase()}, ${duelFmtText()}:`, url }); return; }
      catch (err) { if (err && err.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); btn.textContent = 'COPIED'; }
    catch { document.getElementById('duel-link').select(); btn.textContent = 'SELECTED'; }
    setTimeout(() => { btn.textContent = 'COPY'; }, 1600);
  });
  document.getElementById('duel-name').addEventListener('input', (e) => {
    playerName = (e.target.value.trim().toUpperCase() || 'YOU').slice(0, 12);
    localStorage.setItem(NAME_KEY, playerName);
  });
  document.getElementById('duel-rematch').addEventListener('click', () => { ensureAudio(); duelRematch(true); });
  document.getElementById('duel-menu').addEventListener('click', () => { ensureAudio(); quitToMenu(); });
  {
    const code = (new URLSearchParams(location.search).get('duel') || '').toUpperCase();
    if (DUELS_AVAILABLE && /^[A-Z0-9]{4,8}$/.test(code)) duelOpen(code, sessionStorage.getItem(DUEL_HOST_KEY) === code);
  }
  // Tell the rival we left; keep the URL and host flag so a refresh lands back in the same duel.
  window.addEventListener('pagehide', () => { if (duel.on) duelSend('bye'); });

  // Expose a little for debugging in the console.
  window.__pushupBird = { get state() { return state; }, get score() { return score; }, get mode() { return mode; }, setMode, get runs() { return runs; }, get pose() { return pose; }, get pipes() { return pipes; }, tracking, bird, fx, onPoint, onHit, get lastClip() { return lastClip; }, get recMime() { return recMime; }, calib, sizeUse, run, daily, duel, get ghost() { return ghost; }, setSkin, get skin() { return skinId; }, lifetimeReps,
    // Debug helpers: step the simulation and draw a frame without the rAF loop (used for headless checks).
    _debug: { render, step: (dt) => { update(dt); render(); }, setState: (s) => { state = s; stateTimer = 0; },
      // Offline rendering: seek the source video to t seconds, run the tracker on that frame, resolve when landmarks arrive.
      trackAt: async (t) => {
        await new Promise((res) => { video.onseeked = res; video.currentTime = t; });
        await pose.send({ image: video });
        return { y: tracking.targetY, seen: performance.now() - tracking.lastSeen < 200, source: tracking.source };
      },
      // Offline render from still frames (hidden tabs don't decode video on seek).
      setFrameSource: (src) => { frameSource = src; if (src && src.width) resize(src.width, src.height); updateCrop(); },
      trackImage: async (img) => {
        tracking.lastSeen = 0;
        await pose.send({ image: img });
        return { y: tracking.targetY, seen: performance.now() - tracking.lastSeen < 200, source: tracking.source };
      },
      get camPhase() { return camPhase; },
      get poseReady() { return poseReady; },
      feedRaw: (y, source, sw) => feedTracking(y, source || MODES[mode].source, sw),
      quit: quitToMenu,
      get reach() { return { ...reach }; }, get scale() { return { ...scale, range: scaleRange() }; },
      get cal() { return { lo: cal.lo, hi: cal.hi, offset: cal.offset, range: calRange() }; },
      resetCal,
      setGapHook: (fn) => { gapHook = fn; },
      setGapFrac: (v) => { gapFracOverride = v; },
      setSpawnGate: (fn) => { spawnGate = fn; },
      setSpeedStep: (v) => { speedStepOverride = v; },
      tune: (o) => { Object.assign(tune, o); bird.x = W * (tune.birdX ?? BIRD_X_FRAC); },
      get birdRadius() { return 20 * unit; },
      get speed() { return W * BASE_SPEED_FRAC * speedMult; },
      addPipe: (x, top, bottom) => pipes.push({ x, w: Math.min(W, H) * PIPE_W_FRAC, top, bottom, passed: false }) } };
})();
