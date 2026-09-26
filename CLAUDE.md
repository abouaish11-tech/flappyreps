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
  stretches the joint's observed travel (`cal.lo..cal.hi`, expands instantly, relaxes
  at `CAL_RELAX`/s, never below `CAL_MIN_RANGE`) onto the play area (`PLAY_TOP` to
  just above the ground). The ready state asks for one full rep (`CAL_READY_RANGE`)
  before counting down, or starts after 6 s anyway. Plank ignores the range and moves
  the bird `HOLD_GAIN` × the hip deviation from the locked position. `?exact=1`
  restores the old 1:1 mapping. Push-ups blend in *depth by size*: apparent shoulder
  width (ear distance ×3.2 as fallback) with its own range (`scale`, floor
  `SCALE_MIN_RANGE`) is averaged 50/50 with the vertical signal, so a shrug on the
  floor barely moves the bird and calibration needs a real size change
  (`SCALE_READY_RANGE`). Once the player has shown `REACH_MIN` of travel, pipe gaps
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
- Run recorder: every countdown starts a `MediaRecorder` on `canvas.captureStream(0)`
  (frames pushed with `requestFrame()` after each render, sfx routed through a
  `MediaStreamAudioDestinationNode`). Prefers `video/mp4` (H.264/AAC) and falls back
  to WebM. Stops 1.8s after game over (runs with score 0 are discarded, clips cap at
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
- Duels (1 v 1 over a link, first to `DUEL_WIN` = 3), in the "Duels" section of
  `script.js` plus `duel-net.js` (global `DuelNet`, the transport). "⚔ DUEL A FRIEND" on the
  intro creates a 5-char room code and a `?duel=CODE` link; the creator is the host
  (sessionStorage `pushup-bird-duel-host`) and picks the exercise; opening the link shows
  the lobby with JOIN. Both get the identical course: pipe gaps come from `duelRand(i)`
  seeded per round (the host sends the seed with `start`), and the `reach` gap
  adaptation is off in duels. Only bird height (`y`/H, plus the plank anchor `a`),
  score and round events are sent, never video. Messages: `hello` (presence, name,
  mode, ready flag; sent by a 1 s timer so it keeps going in a background tab),
  `ready`, `start`, `pos` (~15/s), `dead` (survival ms), `rematch`, `bye`. The host
  starts a round once both are set; a round ends when both crash or as soon as the
  survivor outlasts the rival's time, longer survival wins. Rival is drawn as a blue
  ghost (`drawRival`), the duel scoreboard sits on the ground strip (`drawDuelHUD`;
  the mode pill and watermark are hidden via `body.in-duel`). Duels are free (no
  paywall check, no free-run count, not recorded, not on the local leaderboard). ↑/↓
  keys work in duels only on localhost. **Not live yet:** `DuelNet` only has the
  `local` BroadcastChannel backend (tabs of one browser), so `DuelNet.live` is false
  and the duel button/links are only enabled on localhost. Next step is a Supabase
  Realtime backend in `duel-net.js` (same `connect/send/close` shape), then ranked
  play (queue, Glicko-2 rating, tiers, ghost matches when the queue is empty; ranked
  behind the paywall). No global leaderboard (user decision). Test harness:
  `duel-test.html` (gitignored) shows two game iframes linked locally, with an
  arrow-key autopilot `pilot(frame, maxPipes)`.
- After a run: the game-over card stays for `OVER_MS` (30 s) with a countdown; the
  `#againbar` PLAY AGAIN button, a tap on the canvas, or Space restarts sooner (all
  call `toReady()`, which then runs the normal ready→countdown flow).
- Analytics (`analytics.js`, global `FRAnalytics`): GA4 via gtag, OFF until
  `MEASUREMENT_ID` is set (also off on localhost). Events: `play_start_<mode>`
  (in `toCountdown`), `run_end_<mode>` with `value` = score (in `toOver`),
  `clip_share`, `camera_denied`, `paywall_shown`, `quit`. The local dashboard in
  `../Flappy Reps Dashboard` (http://localhost:4101) reads them through the GA4 API.
