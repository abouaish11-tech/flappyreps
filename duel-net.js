/* Flappy Reps — duel transport (global `DuelNet`).
   One tiny interface so the game never cares what carries the messages:
     const link = DuelNet.connect(roomCode, onMessage);  link.send(obj);  link.close();
   Messages are small JSON objects (bird height, score, round events) — never video.

   Backends:
   - 'local'    BroadcastChannel: links tabs of the same browser on the same origin.
                No server; used for development and testing until the live backend exists.
   - 'supabase' (not wired yet) Supabase Realtime broadcast on channel `duel:<code>`.
                Same send/onMessage shape; drop it in here once the project is created.
*/
window.DuelNet = (() => {
  'use strict';

  function local(code, onMessage) {
    const ch = new BroadcastChannel('fr-duel-' + code);
    ch.onmessage = (e) => onMessage(e.data);
    return { kind: 'local', send: (msg) => ch.postMessage(msg), close: () => ch.close() };
  }

  function connect(code, onMessage) {
    return local(code, onMessage);
  }

  // `live` = players on different devices can actually reach each other. The local backend can't,
  // so the game only offers duels on a dev machine until the Supabase backend is in.
  return { connect, live: false };
})();
