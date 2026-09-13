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
      hint: 'Get in push-up position facing the camera. The bird follows your <b>shoulders</b>: go down, it drops; push up, it rises.',
    },
    squat: {
      label: 'SQUATS', unit: 'squat', points: [23, 24], source: 'hips', pipes: 'green',
      ready: 'STAND BACK, HIPS IN FRAME',
      hint: 'Stand back so your hips are in frame. The bird follows your <b>hips</b>: squat down, it drops; stand up, it rises.',
    },
    plank: {
      label: 'PLANK', unit: 's', points: [23, 24], source: 'hips', pipes: 'steel', hold: true,
      ready: 'SIDE VIEW, HOLD THE PLANK',
      hint: 'Put the phone to your side so your whole body is in frame. The bird follows your <b>hips</b>. Pipe gaps lock to your hip height: sag or pike and you hit. Score is seconds held.',
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
  const OVER_MS = 3200;            // how long the game-over card stays up
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
  let mode = MODES[localStorage.getItem(MODE_KEY)] ? localStorage.getItem(MODE_KEY) : 'pushup';
  const bestKey = () => (mode === 'pushup' ? BEST_KEY : `${BEST_KEY}:${mode}`);
  let best = Number(localStorage.getItem(bestKey()) || 0);
  let lastRank = 0;                // all-time rank of the run that just ended
  let boardOpen = false;
  let boardMode = mode;
  let speedMult = 1;
  let spawnTimer = 0;
  let groundX = 0;                 // scroll offset of the ground strip
  let holdY = 0, holdT = 0;        // plank: locked gap height and seconds held
  const groundH = () => H * GROUND_FRAC;
  const groundTop = () => H - groundH();
  let stateTimer = 0;
  let lastFrame = performance.now();
  let muted = false;

  // Tracking
  let tracking = { hasPose: false, targetY: 0.5, lastSeen: 0, source: 'none' };
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
  function beep(freq, dur, type = 'square', gain = 0.08, slide = 0) {
    if (muted || !audio) return;
    const t = audio.currentTime;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + dur);
  }
  const sfx = {
    point: () => { beep(880, 0.08); setTimeout(() => beep(1320, 0.12), 70); },
    hit: () => { beep(220, 0.25, 'sawtooth', 0.12, -160); },
    tick: () => beep(660, 0.07),
    go: () => beep(990, 0.18),
    milestone: () => { [660, 880, 1100, 1320].forEach((f, i) => setTimeout(() => beep(f, 0.14, 'square', 0.09), i * 80)); },
  };

  // ---------- Sizing ----------
  function resize(w, h) {
    W = w; H = h;
    canvas.width = W; canvas.height = H;
    unit = Math.min(W, H) / 720;
    bird.x = W * BIRD_X_FRAC;
    if (!bird.y) bird.y = H / 2;
  }
  resize(720, 1280);

  // ---------- Pose ----------
  let pose = null;
  async function startCamera() {
    camPhase = 'starting';
    setStatus('starting camera… allow access');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    video.srcObject = stream;
    await new Promise((res) => (video.onloadedmetadata = res));
    await video.play();
    resize(video.videoWidth, video.videoHeight);

    if (typeof Pose === 'undefined') {
      camPhase = 'failed';
      setStatus('pose model failed to load — keys only', 'bad');
      return;
    }
    camPhase = 'model';
    pose = new Pose({
      locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${f}`,
    });
    pose.setOptions({
      modelComplexity: 0,
      smoothLandmarks: true,
      enableSegmentation: false,
      selfieMode: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    pose.onResults(onPose);
    setStatus('loading pose model…');
    pump();
  }

  async function pump() {
    // Feed frames sequentially; pose.send resolves when the frame is processed.
    if (video.readyState >= 2) {
      try { await pose.send({ image: video }); } catch (e) { /* keep going */ }
    }
    requestAnimationFrame(pump);
  }

  function onPose(res) {
    const lm = res.poseLandmarks;
    if (!lm) { return; }
    const vis = (i) => lm[i] && (lm[i].visibility ?? 1) > 0.4;
    const mid = (a, b) => (lm[a].y + lm[b].y) / 2;
    const [a, b] = MODES[mode].points;
    let y, source;
    if (vis(a) && vis(b)) { y = mid(a, b); source = MODES[mode].source; }
    else if (vis(11) && vis(12)) { y = mid(11, 12); source = 'shoulders'; }
    else if (lm[0] && (lm[0].visibility ?? 1) > 0.5) { y = lm[0].y + 0.08; source = 'face'; }
    else return;
    tracking.targetY = Math.min(1, Math.max(0, y));
    tracking.hasPose = true;
    tracking.lastSeen = performance.now();
    tracking.source = source;
    camPhase = 'ready';
    keyboardY = null; // camera takes over from keys
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

  // ---------- Game control ----------
  function resetRun() {
    pipes = [];
    score = 0;
    speedMult = 1;
    spawnTimer = SPAWN_MS * 0.4; // first pipe arrives quickly
  }
  function toCountdown() { state = 'countdown'; stateTimer = 0; resetRun(); }
  function toPlaying() {
    state = 'playing'; sfx.go();
    holdY = bird.y; holdT = 0; // plank: gaps lock to where the hips are right now
  }
  function toOver() {
    state = 'over'; stateTimer = 0; sfx.hit();
    onHit();
    if (score > best) { best = score; localStorage.setItem(bestKey(), String(best)); }
    lastRank = recordRun();
    if (boardOpen) renderBoard();
  }
  function toReady() { state = 'ready'; stateTimer = 0; }

  function setMode(next) {
    if (!MODES[next]) return;
    mode = next;
    localStorage.setItem(MODE_KEY, mode);
    best = Number(localStorage.getItem(bestKey()) || 0);
    modeBtn.textContent = MODES[mode].label;
    modeButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    introHint.innerHTML = MODES[mode].hint;
    if (state !== 'ready') { resetRun(); toReady(); }
  }

  // ---------- Update ----------
  function update(dt) {
    const now = performance.now();
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
    bird.flapT += dt;
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
      // Hands-free start: once a body is in frame for a moment, count down.
      if ((seen || keyboardY !== null) && !boardOpen) {
        if (stateTimer > 900) toCountdown();
      } else stateTimer = 0;
      return;
    }
    if (state === 'countdown') {
      const step = Math.floor(stateTimer / 1000);
      if (step !== countdownStep) { countdownStep = step; if (step < 3) sfx.tick(); }
      if (stateTimer >= COUNTDOWN_MS) { countdownStep = -1; toPlaying(); }
      return;
    }
    if (state === 'over') {
      if (stateTimer >= OVER_MS) toReady();
      return;
    }

    // ---- playing ----
    const hold = !!MODES[mode].hold;
    if (hold) {
      holdT += dt;
      const sec = Math.floor(holdT);
      if (sec !== score) {
        score = sec;
        fx.scorePop = 0.6;
        if (HOLD_MILESTONES.has(score)) {
          fx.banner = { text: `${score}s HOLD!`, t: 0 };
          burst(W / 2, H * 0.4, 40, ['#cfe3f2', '#f7d21c', '#ffffff', '#4fc3f7'], H * 0.6, H * 0.8);
          sfx.milestone();
        }
      }
    }
    const speed = W * BASE_SPEED_FRAC * speedMult;
    const pipeW = Math.min(W, H) * PIPE_W_FRAC;
    const gap = hold
      ? H * (HOLD_GAP_START + (HOLD_GAP_END - HOLD_GAP_START) * Math.min(1, holdT / HOLD_GAP_SECS))
      : H * GAP_FRAC;
    groundX += speed * dt;

    spawnTimer -= dt * 1000 * speedMult;
    if (spawnTimer <= 0) {
      spawnTimer = SPAWN_MS;
      const margin = H * 0.08;
      const playH = groundTop();
      const cy = hold
        ? Math.min(playH - margin - gap / 2, Math.max(margin + gap / 2, holdY))
        : margin + gap / 2 + Math.random() * (playH - 2 * margin - gap);
      pipes.push({ x: W + pipeW, w: pipeW, top: cy - gap / 2, bottom: cy + gap / 2, passed: false });
    }

    const r = 20 * unit; // collision radius
    for (const p of pipes) {
      p.x -= speed * dt;
      if (!p.passed && p.x + p.w < bird.x) {
        p.passed = true;
        if (hold) {
          // Plank: passing a pipe is just confirmation you're still level.
          burst(bird.x, bird.y, 6, ['#ffffff', '#cfe3f2'], H * 0.25, H * 0.5);
          sfx.tick();
        } else {
          score += 1;
          speedMult = Math.min(MAX_SPEED_MULT, speedMult + SPEED_STEP);
          onPoint();
        }
      }
      // circle vs the two pipe rectangles
      const withinX = bird.x + r > p.x && bird.x - r < p.x + p.w;
      if (withinX && (bird.y - r < p.top || bird.y + r > p.bottom)) { toOver(); return; }
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
    fx.popups.push({ x: bird.x + 36 * unit, y: bird.y - 26 * unit, t: 0, text: '+1' });
    burst(bird.x, bird.y, 10, ['#ffffff', '#f7d21c', '#fbe58a'], H * 0.35, H * 0.6);
    if (MILESTONES.has(score)) {
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
      text(p.text, p.x, p.y - k * 70 * unit, 16 * unit, { fill: '#fbe58a' });
      ctx.restore();
    }
    if (fx.banner) {
      const t = fx.banner.t;
      const pop = t < 0.25 ? 1.6 - 2.4 * t : 1;                // overshoot in
      const alpha = t > 1.1 ? Math.max(0, 1 - (t - 1.1) / 0.5) : 1;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(W / 2, H * 0.42); ctx.scale(pop, pop);
      text(fx.banner.text, 0, 0, 30 * unit, { fill: '#f6c948' });
      ctx.restore();
    }
  }

  // ---------- Drawing ----------
  let vignette = null, vignetteKey = '';
  function drawVideo() {
    if (video.readyState >= 2 && video.videoWidth) {
      ctx.save();
      ctx.translate(W, 0); ctx.scale(-1, 1); // selfie mirror
      ctx.filter = 'saturate(0.8) contrast(1.05)';   // lets the pixel art pop over the room
      ctx.drawImage(video, 0, 0, W, H);
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
    ctx.fillStyle = vignette; ctx.fillRect(0, 0, W, H);
  }

  function drawPipe(p) {
    const T = PIPE_THEMES[MODES[mode].pipes];
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

  const SPR_W = 22, SPR_H = 16;
  function bakeFrame(rows, tint) {
    for (const r of rows) if (r.length !== SPR_W) throw new Error('sprite row width ' + r.length + ': ' + r);
    const c = document.createElement('canvas');
    c.width = SPR_W; c.height = SPR_H;
    const g = c.getContext('2d');
    rows.forEach((row, j) => [...row].forEach((ch, i) => {
      if (ch === '.') return;
      g.fillStyle = PAL[ch]; g.fillRect(i, j, 1, 1);
    }));
    if (tint) { g.globalCompositeOperation = 'source-atop'; g.fillStyle = tint; g.fillRect(0, 0, SPR_W, SPR_H); }
    return c;
  }
  const FR = {
    mid: bakeFrame(MID), up: bakeFrame(UP), down: bakeFrame(DOWN),
    strain: bakeFrame(STRAIN), hit: bakeFrame(HIT, 'rgba(255,70,70,0.35)'),
  };

  function pickFrame() {
    if (state === 'over') return FR.hit;
    const fast = H * 0.08;
    // Straining: low in the frame (bottom of a rep) and barely moving.
    if (state === 'playing' && bird.y > H * 0.72 && Math.abs(bird.vy) < H * 0.15) return FR.strain;
    if (bird.vy < -fast) return Math.floor(bird.flapT * 18) % 2 ? FR.up : FR.mid;   // frantic flapping upward
    if (bird.vy > fast) return FR.down;                                              // gliding down
    return [FR.mid, FR.up, FR.mid, FR.down][Math.floor(bird.flapT * 6) % 4];          // idle flap
  }

  function blitBird(frame, x, y, rot, sx, sy, alpha) {
    const px = 3.4 * unit, w = SPR_W * px, h = SPR_H * px;
    ctx.save();
    ctx.globalAlpha = alpha;
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
    blitBird(frame, bird.x, bird.y, bird.rot, sx, sy, 1);
    // Sweat drops while straining.
    if (frame === FR.strain) {
      const d = (bird.flapT * 2.2) % 1;
      const px = 3.4 * unit;
      ctx.save();
      ctx.translate(bird.x + 24 * unit, bird.y - 30 * unit + d * 26 * unit);
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
    if (state === 'playing') {
      const pop = 1 + 0.45 * fx.scorePop * fx.scorePop;
      ctx.save();
      ctx.translate(W / 2, H * 0.12); ctx.scale(pop, pop);
      text(fmtScore(mode, score), 0, 0, big);
      ctx.restore();
      return;
    }
    if (state === 'ready') {
      const posed = tracking.hasPose || keyboardY !== null;
      if (!posed) drawPoseGuide();
      text('FLAPPY REPS', W / 2, H * 0.18, 34 * unit, { fill: '#f6c948' });
      text(posed ? 'HOLD STILL…' : MODES[mode].ready, W / 2, H * 0.26, small);
      text('BEST ' + fmtScore(mode, best), W / 2, H * 0.31, small);
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
      const pw = Math.min(W * 0.8, 380 * unit), ph = 150 * unit;
      const px0 = W / 2 - pw / 2, py0 = H * 0.16;
      text('GAME OVER', W / 2, py0 - 34 * unit, 30 * unit, { fill: '#f6c948' });
      panel(px0, py0, pw, ph);
      text(MODES[mode].label, W / 2, py0 + ph * 0.24, small, { fill: '#e0432b' });
      text(fmtScore(mode, score), W / 2, py0 + ph * 0.48, mid, { fill: '#3d1c12', stroke: '#ded895' });
      const tag = lastRank === 1 && score > 0 ? 'NEW #1!' : lastRank > 0 ? `#${lastRank} ALL-TIME` : 'BEST ' + fmtScore(mode, best);
      text(tag, W / 2, py0 + ph * 0.78, small, { fill: '#3d1c12', stroke: '#ded895' });
      return;
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
    drawGround();
    drawTrackingGuide();
    drawBird();
    if (state === 'over') { ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(-W, -H, W * 3, H * 3); drawBird(); }
    drawFx();
    drawHUD();
    ctx.restore();
    if (fx.flash > 0) { ctx.fillStyle = `rgba(255,255,255,${0.7 * fx.flash})`; ctx.fillRect(0, 0, W, H); }
  }

  // ---------- Loop ----------
  function frame(now) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }

  // ---------- Input ----------
  function nudge(dir) {
    // Each keydown (including auto-repeat while held) moves the bird one step.
    if (keyboardY === null) keyboardY = bird.y / H;
    keyboardY = Math.min(1, Math.max(0, keyboardY + dir * 0.04));
  }
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) { if (e.key === 'Escape') closeBoard(); return; }
    if (e.key === 'ArrowUp') { nudge(-1); e.preventDefault(); }
    if (e.key === 'ArrowDown') { nudge(1); e.preventDefault(); }
    if (e.key === ' ') { ensureAudio(); if (state === 'over') toReady(); e.preventDefault(); }
    if (e.key === 'Escape' && boardOpen) closeBoard();
    if (e.key === 'l' || e.key === 'L') { boardOpen ? closeBoard() : openBoard(); }
  });
  canvas.addEventListener('pointerdown', () => { ensureAudio(); if (state === 'over') toReady(); });

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

  muteBtn.addEventListener('click', () => {
    muted = !muted;
    muteBtn.textContent = muted ? '🔇' : '🔊';
  });

  startBtn.addEventListener('click', async () => {
    ensureAudio();
    intro.hidden = true;
    requestAnimationFrame(frame);
    try {
      await startCamera();
    } catch (err) {
      console.error(err);
      camPhase = 'failed';
      setStatus('camera blocked — use ↑ ↓ keys', 'bad');
    }
  });

  // Expose a little for debugging in the console.
  window.__pushupBird = { get state() { return state; }, get score() { return score; }, get mode() { return mode; }, setMode, get runs() { return runs; }, get pose() { return pose; }, get pipes() { return pipes; }, tracking, bird, fx, onPoint, onHit,
    // Debug helpers: step the simulation and draw a frame without the rAF loop (used for headless checks).
    _debug: { render, step: (dt) => { update(dt); render(); }, setState: (s) => { state = s; stateTimer = 0; }, addPipe: (x, top, bottom) => pipes.push({ x, w: Math.min(W, H) * PIPE_W_FRAC, top, bottom, passed: false }) } };
})();
