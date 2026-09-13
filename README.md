# Flappy Reps — flappyreps.com

Flappy Bird, but you are the controller. Your camera tracks your body with
MediaPipe Pose; every push-up, squat or second of plank flies the bird through
the pipes. Static site, no build step, no backend.

- `index.html`, `script.js`, `style.css` — the whole game
- `icons/`, `manifest.webmanifest` — PWA icons and install metadata
- Run locally: `python3 -m http.server 8766` then open http://localhost:8766

Camera access needs HTTPS (or localhost). Scores and the leaderboard are stored
in the browser's localStorage.
