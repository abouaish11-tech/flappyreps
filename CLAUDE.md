# Flappy Reps (Bird Project) — flappyreps.com

Flappy Bird controlled by doing push-ups, squats or planks in front of the camera.
Brand: Flappy Reps, domain flappyreps.com. Internal names/localStorage keys still say
"pushup-bird"; leave them so existing scores survive. Static app, no build step: `index.html` + `script.js` + `style.css`,
served with `python3 -m http.server 8766` (config name "pushupbird" in
`.claude/launch.json`).

- Body tracking: MediaPipe Pose (legacy `@mediapipe/pose` from jsDelivr),
  `modelComplexity: 0`, selfie mode. Bird Y = midpoint of the tracked pair of
  landmarks, mapped directly onto the canvas (no calibration step).
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
