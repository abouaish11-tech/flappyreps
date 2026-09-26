/* Flappy Reps — duel transport (global `DuelNet`).
   One tiny interface so the game never cares what carries the messages:
     const link = DuelNet.connect(roomCode, onMessage);  link.send(obj);  link.close();
   Messages are small JSON objects (bird height, score, round events), never video.
   Sends made before the link is up are dropped; the game's 1 s heartbeat re-sends its state.

   Backends:
   - 'supabase' (default) Supabase Realtime broadcast on public channel `duel:<code>`.
                Project "flappy-reps" (West EU). supabase-js is loaded from jsDelivr only when
                a duel opens. Free plan: 200 concurrent connections, 100 messages/s project-wide.
   - 'local'    BroadcastChannel between tabs of one browser, no server (?net=local).
*/
window.DuelNet = (() => {
  'use strict';

  const SUPABASE_URL = 'https://kaqclzjfjywgwjfvlgvu.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_StY8eskHs-PZb05zauQFYg_ldktmRKu'; // publishable key: meant for browsers
  const LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
  const forced = new URLSearchParams(location.search).get('net');

  function local(code, onMessage) {
    const ch = new BroadcastChannel('fr-duel-' + code);
    ch.onmessage = (e) => onMessage(e.data);
    return { kind: 'local', send: (msg) => ch.postMessage(msg), close: () => ch.close() };
  }

  let clientP = null;
  function client() {
    if (!clientP) clientP = new Promise((resolve, reject) => {
      const make = () => window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false },
        realtime: { params: { eventsPerSecond: 20 } }, // client-side throttle (default is 10)
      });
      if (window.supabase) { resolve(make()); return; }
      const s = document.createElement('script');
      s.src = LIB; s.async = true;
      s.onload = () => resolve(make());
      s.onerror = () => { clientP = null; reject(new Error('could not load supabase-js')); };
      document.head.appendChild(s);
    });
    return clientP;
  }

  function supabaseLink(code, onMessage) {
    let c = null, ch = null, up = false, closed = false;
    client().then((cl) => {
      if (closed) return;
      c = cl;
      ch = c.channel('duel:' + code, { config: { broadcast: { self: false } } });
      ch.on('broadcast', { event: 'm' }, ({ payload }) => onMessage(payload));
      ch.subscribe((status) => { up = status === 'SUBSCRIBED'; });
    }).catch((err) => console.warn('duel link unavailable', err));
    return {
      kind: 'supabase',
      send: (msg) => { if (ch && up) ch.send({ type: 'broadcast', event: 'm', payload: msg }); },
      close: () => { closed = true; up = false; if (c && ch) c.removeChannel(ch); ch = null; },
    };
  }

  function connect(code, onMessage) {
    return forced === 'local' ? local(code, onMessage) : supabaseLink(code, onMessage);
  }

  // `live` = players on different devices can reach each other.
  return { connect, live: forced !== 'local' };
})();
