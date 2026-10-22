# Flappy Reps (Bird Project) — flappyreps.com

Flappy Bird controlled by doing push-ups, squats or planks in front of the camera.
Brand: Flappy Reps, domain flappyreps.com. Internal names/localStorage keys still say
"pushup-bird"; leave them so existing scores survive. Static app, no build step: `index.html` + `script.js` + `style.css`,
served with `python3 -m http.server 8766` (config name "pushupbird" in
`.claude/launch.json`).

- Body tracking: MediaPipe Pose (legacy `@mediapipe/pose` from jsDelivr),
  `modelComplexity: 0` (`?model=1` for the heavier model), selfie mode. The tracked
  joint pair uses whichever of the two points is visible; fallbacks (shoulders, then
  nose) are offset so the signal stays continuous. `feedTracking()` → `mapRaw()`
  stretches the joint's recent travel onto the play area: `cal.lo..cal.hi` (and the size range
  `scale`) come from `robustRange()`, the 8th..92nd percentile (`CAL_PCT`) of the last `CAL_WINDOW_MS` (6 s),
  widening fast (`CAL_WIDEN`) and narrowing slowly (`CAL_NARROW`), never below `CAL_MIN_RANGE`.
  Before that the height is smoothed by a One Euro filter (`euroFilter()`, `EURO_MIN_CUT` 1.5 Hz,
  `EURO_BETA` 3: still = smooth, fast = no lag), and a joint pair reported visible but narrower than
  half its usual width (`PAIR_COLLAPSE`, the face covering the shoulders) counts as unseen. All
  tuned on the user's own recordings: the bench (scratchpad `bench/sim.js`, `sweep.js`) replicates
  the mapping offline, and `_debug.feedPose(landmarks)` / `_debug.resetCal()` replay recorded
  landmarks through the real game (works in WebKit, which can't run MediaPipe headless).
  (Until 2026-10-22 it kept every extreme ever seen and barely relaxed after calibration; a user's
  iPhone-on-the-floor clip showed the range at ~3%..88% of the frame while push-ups used 20%..55%,
  so the bird only crossed the middle of the screen.) The play area runs from `PLAY_TOP` to
  just above the ground). Calibration: before the first countdown the player does
  `CALIB_REPS` (2) full reps with the primary joint in view (`stepCalib()`: the bird must
  reach the top and bottom zones, shown as bands, and the travel must be ≥ `CAL_READY_RANGE`);
  there is no timeout for camera play. Tracked joints are drawn as dots in the ready state,
  and the prompt says "MOVE BACK" while the tracker is on a fallback joint. After
  calibration the range relaxes much slower (`CAL_RELAX_LOCKED`). `resetCal()` (quit to
  menu) asks for the calibration reps again. Plank ignores the range and moves
  the bird `HOLD_GAIN` × the hip deviation from the locked position. `?exact=1`
  restores the old 1:1 mapping. Push-ups could blend in *depth by size* (OFF since 2026-10-22, `SIZE_CUE`, `?size=1` to test: on the user's runs it only switched on once and made tracking worse) (apparent shoulder
  width, or ear distance × a per-player ratio learned when both are visible), but only if
  the calibration reps show size moving with height (|r| > 0.7, `learnSizeCue()`), at
  weight 0.35 and with the learned sign. In the stock test clip (phone on the floor in
  front) the shoulders look *smaller* at the bottom, so the old fixed "bigger = lower"
  50/50 blend cancelled the height signal and the bird barely moved.
- Orientation: the game takes the camera's shape (`fitCanvas()`: short side 720, so a laptop
  webcam gives 1280x720 and both shoulders stay in view; a phone held upright gives portrait), and
  `#game` scales up to fill the window (`--ar` set in `resize()`). Rotating mid-run (manifest
  `orientation: any`) refits the canvas in `onVideoResize()`, rescales pipes/bird, and resets the
  height range (calibration reps are not asked for again), but only when the frame's aspect really
  changes (`lastVideoShape`): phones fire `resize` without a change, and resetting on every event
  (Oct 19-22) made phone tracking jumpy. Landmarks map to the canvas with
  `camX`/`camY` through `crop` (the whole frame unless a source and the canvas disagree), never
  `x * W`. Clips are always 9:16 portrait: see the recorder's `composeClip()`. (A fixed 9:16 game
  canvas was tried on 2026-10-19 and reverted: on laptops it cropped the shoulders out.)
- Script/style tags in `index.html` carry `?v=` so phones pick up new code; bump it on
  every deploy that changes JS/CSS. Once the player has shown `REACH_MIN` of travel, pipe gaps
  are spawned inside the observed bird range (`reach`).
- Quit: the ✕ pill (top-left) or Escape calls `quitToMenu()` — discards the clip,
  resets the run and calibration, stops the camera tracks, and shows the intro with
  the attract demo. Play re-requests the camera; the Pose instance is reused.
- Three exercise modes in the `MODES` table in `script.js`: `pushup` follows the
  shoulders (landmarks 11/12), `squat` and `plank` follow the hips (23/24). All
  fall back to shoulders, then nose. `plank` is a hold mode (`hold: true`): on
  `toPlaying()` the current bird height is stored in `holdY`, every pipe gap is
  centred there, the gap narrows from `HOLD_GAP_START` to `HOLD_GAP_END` over
  `HOLD_GAP_SECS`, speed never ramps, and `score` is whole seconds held
  (`fmtScore()` appends "s"). Best keys: `pushup-bird-best:plank`. Mode is picked on the intro screen or with the
  centre pill in-game and persists in localStorage under `pushup-bird-mode`.
- Camera access needs localhost or https. The Browser pane usually has no camera;
  verify tracking in the user's real Chrome at http://localhost:8766.
- ↑ / ↓ keys move the bird without a camera (used for testing the game loop).
- `?debug=1` draws a green diagnostics readout (`drawDiag()`, not in clips): frames drawn and pose
  results per second, camera vs game size, video `resize` events and real shape flips, tracked joint
  and shoulder/hip visibility, the learned height range. For tracking problems on a real phone, ask
  for a screen recording of a run with it.
- Best score persists per mode: `pushup-bird-best` (push-ups) and
  `pushup-bird-best:squat`.
- Leaderboard is local to the browser: every finished run with score > 0 is
  appended to `pushup-bird-runs` (`{name, score, mode, ts}`, capped at 1000);
  the player name lives in `pushup-bird-name`. The overlay (🏆 pill, intro
  button, or the L key) shows the top 10 per mode plus today / 7-day / total
  reps and run count for the current name. No backend; a shared leaderboard
  would need a server or a sync service.
- Visuals: the bird is a 22x16 pixel sprite sheet defined as string maps in
  `script.js` (`MID`, `UP`, `DOWN`; `HIT` and `STRAIN` derived from `MID`) and
  baked to offscreen canvases once. Squash/stretch, a ghost trail, particles,
  "+1" popups, milestone banners, screen shake, and a hit flash live in the
  `fx` object (`onPoint`, `onHit`, `updateFx`, `drawFx`). The camera feed is
  drawn desaturated with a vignette. `drawPoseGuide()` shows the silhouette in
  the ready state until a body is detected.
- `window.__pushupBird._debug` has `render`, `step(dt)`, `setState`, `addPipe`
  so frames can be drawn headlessly when the tab is hidden (rAF is paused).
- Pipes are drawn in `drawPipe()` from the `PIPE_THEMES` palette named by the
  mode (`copper` for push-ups, `green` for squats). The bottom pipe ends at
  `groundTop()`. `drawGround()` tiles a baked ground strip (`GROUND_FRAC` of H)
  that scrolls with pipe speed (idle drift otherwise) over a slower bush layer;
  the bird is clamped above it and pipe gaps are spawned within the play area.
- Offline rendering / demo videos: `?src=<video>&manual=1` feeds a file through the
  tracker instead of the webcam; `window.__pushupBird._debug` exposes `render`,
  `step(dt)`, `setState`, `setFrameSource`, `trackImage`, `setGapHook`,
  `setSpawnGate`, `setGapFrac`, `setSpeedStep`. See `marketing/README.md` for the
  recipe. Hidden browser tabs don't decode video on seek, so use JPEG frames.
- Run recorder: every countdown starts recording. Both paths record `clipCv` (720x1280 portrait),
  refreshed by `composeClip()` (at most `REC_FPS`): a 9:16 game is copied straight in; another portrait
  shape (4:3 phone cameras) is fitted to the width over a blurred copy (`fitPortraitClip()`, cheap so
  the phone's tracker keeps its frames); a landscape game (laptop webcam) is drawn a second time as a native portrait game by
  `renderClipPortrait()`: it swaps `ctx`/`W`/`H`/`unit` to the clip, maps the run's positions (x by
  720/W, y by 1280/H; pipes keep their centre, width × sx × 1.2), calls the shared `renderScene()`
  with `drawClipVideo()`, then restores everything exactly (`clipPass` is true meanwhile; per-size
  caches for vignette, ground tiles and smoke layers). `drawClipVideo()` shows the camera at full
  width, auto-framed around the tracked joints (`trackClipFrame()`, every frame: both shoulders × 1.9,
  zoom at most to 55% of the width, smoothed) and feathered into a blurred extension of the room
  (`blurCv`), so clips fill the screen without cropping the player out. `_debug.composeClip()`
  returns one clip frame as a JPEG. Headless tests with the real tracker need Chrome flags
  `--use-angle=swiftshader --enable-unsafe-swiftshader` and `?src=<video>&manual=1`. On Apple browsers (and with `?rec=wc`)
  it encodes the canvas with WebCodecs (`VideoEncoder`, H.264 `avc1.42002a`, 30 fps, real
  timestamps) and muxes an MP4 with mp4-muxer 5.2.2
  (lazy-loaded from jsDelivr); no game audio there. Safari's `VideoEncoder` leaves `chunk.duration` empty, which mp4-muxer's `addVideoChunk` rejects (every
  iPhone clip silently failed until 2026-10-22), so chunks go in through `addVideoChunkRaw` with one
  frame's duration; any WebCodecs failure (`wcFailed()`) switches later runs to MediaRecorder. Test the
  Safari path with Playwright's WebKit (`webkit.launch()`, `devices['iPhone 13']`), not Chrome
  emulation. Safari's own MediaRecorder produced
  MP4s with collapsed timestamps and an "83 day" duration. Elsewhere it uses MediaRecorder
  on `clipCv.captureStream(30)` with the sfx track, one blob at stop (`?rec=mr` forces this).
  Prefers `video/mp4` (H.264/AAC) and falls back to WebM. Stops 2.6s after game over (runs with score 0 shorter than 3 s are discarded, clips cap at
  2 min). The `#sharebar` then offers SHARE CLIP: `navigator.share({files})` on
  phones, a download on desktop. A small `flappyreps.com` watermark is drawn on the
  ground strip so shared clips carry the URL.
- Payment gate (`paywall.js`, loaded before `script.js`, global `Paywall`): LIVE in
  production. Provider is Polar, org "Flappy Reps" (`orgId`
  e4541c72-92a0-438a-97bc-f78a40cbc191). Two tiers as of 2026-09-24, both attached to
  the same checkout link (`PAYWALL.checkoutUrl`, Polar's hosted page lets the buyer
  pick either there): "Flappy Reps Day Pass" (`productId`
  2778d57c-87c5-4157-88ff-6f6965919b00, $1.99 one-time, its own License Keys benefit
  configured on Polar's side to expire 24h after activation) and "Flappy Reps Pro"
  (`productId` 5a037755-d0a1-499a-821f-bcf637ebb3c4, $4.99/month, License Keys
  benefit with no fixed expiry — Polar revokes it on cancellation instead). Both
  tiers are listed in `PAYWALL.tiers` and rendered into the `.pw-tier` boxes in the
  paywall overlay. No backend: `checkoutUrl` opens Polar's hosted checkout in a new
  tab; keys are verified with Polar's public Customer Portal API
  (`POST /v1/customer-portal/license-keys/activate` then `/validate`, both take
  `{key, organization_id}`, no auth) and stored in `pushup-bird-license`. A key from
  either tier validates identically here (this file doesn't know which product
  granted it), so `revalidateDays` is `0` — re-check with Polar on every page load —
  with a short `graceDays` (2) for offline tolerance, so a Day Pass actually re-locks
  within about a day instead of riding a grace window sized for monthly billing.
  `gate` is `'runs'` (`freeRuns: 1` — one free run then paywall, counted in
  `pushup-bird-starts`), `'modes'` (`freeModes` free, others tagged PRO) or `'all'`.
  `script.js` calls `Paywall.canPlay(mode)` from the intro Play button and the
  ready→countdown transition, `Paywall.noteStart()` in `toCountdown()`, and
  `Paywall.isProMode()` for the tags. Polar doesn't put the key in the redirect URL
  (no Lemon-Squeezy-style placeholder), so buyers copy it from Polar's checkout
  confirmation page or look it up anytime at `portalUrl`
  (https://polar.sh/flappy-reps/portal) and paste it into the key field; the
  `?license_key=` URL param is still handled in case that ever changes.
- Rep Race (default duel format, `duel.fmt === 'race'`, `raceOn()`; plank always uses survival): `RACE_MS` (60 s;
  `?racesecs=N` on localhost for tests) on the clock, most counted reps wins, ties go to full-range reps. A rep
  counts only if ≥ `RACE_REP_MIN` (0.3) of the play range and not during a stun (`raceRep()`); hitting a pipe
  stuns you for `RACE_STUN_MS` (2 s, `raceStun()`, the bird blinks and flies through). One race per match,
  then REMATCH. The host picks the format in the lobby (`#duel-fmt`, saved in `pushup-bird-duel-fmt`) and sends
  it in `hello`/`start` (guests of hosts without `fmt` fall back to survival). `pos`/`dead`/`hello` carry `r`
  (reps) and `f` (full reps); `hello` also carries `pid` (random per-browser id, `pushup-bird-pid`), `skin` and
  `life` (lifetime reps). HUD is deliberately *not* pixel art: `drawRaceHUD()`/`raceCard()` draw a clean glass
  versus card (system font via `SANS`, `rrect`, `glass`, `pillText`) with avatars of each player's skin,
  rank pills (`RANKS` by lifetime reps: Bronze 0, Silver 100, Gold 500, Platinum 1500, Diamond 4000,
  Champion 10000), the clock (red + pulsing in the last 10 s), head-to-head record (`pushup-bird-h2h`,
  `{pid: {w, l, name}}`, also updated by survival match results), live reps and a tug-of-war bar; the card sits
  below the HTML pills (`pillsBottom()`). Races are recorded (clip shows the card and the VICTORY/DEFEAT
  card; share text names the score and rival). Test: two headless pages with `?net=local&exact=1&racesecs=12`.
- Duels (1 v 1 over a link: Rep Race above, or survival first to `DUEL_WIN` = 3), in the "Duels" section of
  `script.js` plus `duel-net.js` (global `DuelNet`, the transport). "⚔ DUEL A FRIEND" on the
  intro creates a 5-char room code and a `?duel=CODE` link; the creator is the host
  (sessionStorage `pushup-bird-duel-host`) and picks the exercise; opening the link shows
  the lobby with JOIN. Both get the identical course: pipe gaps come from `duelRand(i)`
  seeded per round (the host sends the seed with `start`), and the `reach` gap
  adaptation is off in duels. Only bird height (`y`/H, plus the plank anchor `a`),
  score and round events are sent, never video. Messages: `hello` (presence, name,
  mode, ready flag, and the round/seed/result so a dropped `start` or `dead` heals; sent
  by a 1 s timer so it keeps going in a background tab), `ready`, `start`, `pos`
  (6/s, the rival is smoothed), `dead` (survival ms, or race end), `rematch`, `bye`. The host
  starts a round once both are set; a round ends when both crash or as soon as the
  survivor outlasts the rival's time, longer survival wins. Rival is drawn as a blue
  ghost (`drawRival`), the duel scoreboard sits on the ground strip (`drawDuelHUD`;
  the mode pill and watermark are hidden via `body.in-duel`). Duels are free (no
  paywall check, no free-run count, not on the local leaderboard; only Rep Races are recorded). ↑/↓
  keys work in duels only on localhost. Transport: Supabase Realtime broadcast on public
  channel `duel:<code>` (project "flappy-reps", ref kaqclzjfjywgwjfvlgvu, West EU;
  publishable key in `duel-net.js`; supabase-js lazy-loaded from jsDelivr when a duel
  opens). `?net=local` swaps in a BroadcastChannel between tabs of one browser. Free
  plan: 200 concurrent connections and 100 messages/s for the whole project, roughly
  7 duels at once at the current rates; Pro ($25/mo) is 500/s. **Public** since
  2026-10-19 (`DUELS_PUBLIC = true`; false hides the intro button again unless `?duels=1`,
  links always work). Next: ranked play (Supabase
  Auth, queue, Glicko-2 rating, tiers, ghost matches when the queue is empty; ranked
  behind the paywall). No global leaderboard (user decision). Test harness:
  `duel-test.html` (gitignored) shows two game iframes linked locally, with an
  arrow-key autopilot `pilot(frame, maxPipes)`.
- Run extras ("Run extras" section of `script.js`, state in the `run` object, reset by
  `resetExtras()` in `resetRun()`):
  - Heat: `heatFor(score)` = one level per 5 points (10 s in plank), max 4 (CHARGED UP, POWERED
    UP, SUPERCHARGED, BEAST MODE), in electric `HEAT_COLORS` (cyan → blue → violet → magenta) so it never
    looks like overheating's red. Level-ups show a banner (`heatCheck()`, takes priority over
    the milestone banner). Visuals in `heatFx()`/`drawBird()`/`drawPipe()`: glow, steam,
    spark trail (fire colours only on the Fire Bird skin), glowing pipes at 3+, bigger "+1!" at 4; the point sound pitches up.
  - Real reps: `trackReps()` reads the bird's own swings (hysteresis `REP_HYST`), a rep is
    a down+up pair ≥ `REP_MIN` of the play range, full range ≥ `FULL_REP` ("FULL REP" /
    "3x FULL!" popups). No "go deeper" nag: gap heights dictate how far you move.
  - Tiredness = overheating: rep speed vs the best 3 of the first 5 reps; `run.fatigue` 0..1, starting
    once recent reps fall under 88% of that pace. `run.oh` follows it smoothly and `ohStage()` maps it
    through `OH_AT` (0.15/0.45/0.75) to WARM / HOT / OVERHEAT: the bird is redrawn in the `OH_RAMP`
    palettes (yellow → orange → red, frames in `FR.oh`), grey pixel smoke pours off its back
    (`run.smoke`, `drawSmoke()` merges puffs on a low-res layer with a checker dither as they fade),
    sparks fly from HOT, and at OVERHEAT the screen edges glow red (`drawOverheatHaze()`) and the bird
    sags and rattles. A thermometer on the right edge (`drawThermo()`) fills with it; the rep count
    sits under the score. Crossing 0.45 shows the OVERHEATING! banner; recovering shows SECOND WIND.
    Cosmetic only, never changes difficulty.
  - Boss pipes: every 25th pipe in solo push-up/squat play, alternating a sliding gap
    (`boss: 'slide'`) and a 2.6× wide pipe set low (`boss: 'wide'`), steel theme with hazard
    stripes. Not in duels or plank.
  - Seeded courses: solo gaps come from `runRand` (mulberry32). Daily challenge (intro
    button or `?daily=1`): seed = date + mode, so everyone gets the same course; best per
    day in `pushup-bird-daily:<mode>:<date>`. The ghost of today's best daily attempt
    (`pushup-bird-ghost:<mode>:<date>`, y every 50 ms, older days deleted) races you on
    the same course; passing its score shows BEAT TODAY'S BEST. Ghost is daily-only:
    normal runs have random courses, so a ghost there would fly through pipes.
  - Skins (`SKINS`, built by `buildFrames()`): palette swaps, row patches, accessory layers per flap
    frame (`acc.mid/up/down`, `{x, y, rows}` in body coords, may stick out: frames are baked with
    `SPR_PX`/`SPR_PY` transparent padding, so drawing code uses `frame.width/height`), `facet` (crystal
    pattern) and live effects in `fx` (`skinFx()`/`drawBird()`: `glow` colour or 'prism', `shine` sweep,
    `sparkle` star particles, `glint` on the shades' lens, `sweat`, ninja `shadow` afterimages; fire
    embers in `heatFx()`). Unlocks by lifetime reps (`lifetimeReps()`: push-up + squat scores + plank
    seconds / 3): Classic, Headband 100 (ribbon tails), Shades 250 (backwards cap), Gold 500, Fire Bird
    1000 (flame crest), Ninja 2000, Cyborg 5000 (visor, antenna), King 10000 (crown), Diamond for an
    active Day Pass / Pro. Saved in `pushup-bird-skin`; the 🐤 SKINS intro button opens the picker.
  - Game-over card = stats card (reps, full range, slowdown rep, peak heat, daily best,
    PLAY FREE AT FLAPPYREPS.COM); the recorder keeps 2.6 s of it at the end of each clip.
- After a run: the game-over card stays for `OVER_MS` (30 s) with a countdown; the
  `#againbar` PLAY AGAIN button, a tap on the canvas, or Space restarts sooner (all
  call `toReady()`, which then runs the normal ready→countdown flow).
- Analytics (`analytics.js`, global `FRAnalytics`): GA4 via gtag, OFF until
  `MEASUREMENT_ID` is set (also off on localhost). Events: `play_start_<mode>`
  (in `toCountdown`), `run_end_<mode>` with `value` = score (in `toOver`),
  `clip_share`, `camera_denied`, `paywall_shown`, `quit`. The local dashboard in
  `../Flappy Reps Dashboard` (http://localhost:4101) reads them through the GA4 API.
- Search / AI-answer visibility (AEO): the intro has a crawlable `#about` section (what it
  is, modes, privacy, FAQ) below the hero, and `index.html` carries JSON-LD (WebSite,
  VideoGame/WebApplication with the three price offers, FAQPage). Keep the JSON-LD FAQ text
  identical to the visible FAQ and the prices in step with `PAYWALL.tiers`. Static landing
  pages (plain HTML, `pages.css`, no build): `/push-up-game/`, `/squat-game/`,
  `/plank-game/`, `/faq/`, `/how-it-works/`; their Play buttons link to `/?mode=<mode>`,
  which `script.js` reads on load. `robots.txt` allows the AI crawlers, `sitemap.xml` lists
  every page (bump `lastmod` when content changes), `llms.txt` is the plain-text summary.
  IndexNow key file: `da0ee399fbe2dbe7e66d85e4fcaa9195.txt` at the root.
