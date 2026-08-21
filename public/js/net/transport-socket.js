/* =========================================================================
   The real transport: one WebSocket, reconnecting.

   { start(), send(obj) -> bool, isOpen(), stop(), resume() } — the same shape
   the mock implements, so protocol.js never knows which one it is holding.

   Nothing about the conversation lives here. The session is continuous for the
   life of the connection on the server side; this only has to deliver frames
   and be honest about whether it currently can.
   ========================================================================= */

export function makeSocketTransport(onServer, onConn) {
  var ws = null, tries = 0, timer = 0, dead = false;

  function url() {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  }

  function connect() {
    if (dead) return;
    onConn('connecting');
    try { ws = new WebSocket(url()); }
    catch (e) { ws = null; retry(); return; }

    ws.onopen = function () { tries = 0; onConn('online'); };

    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }   // ignore junk frames
      if (msg && typeof msg.type === 'string') onServer(msg);
    };

    ws.onerror = function () { /* onclose always follows; handled there */ };

    ws.onclose = function () {
      ws = null;
      if (dead) return;
      retry();
    };
  }

  function retry() {
    // exponential backoff, capped, with jitter
    var wait = Math.min(20000, 600 * Math.pow(1.7, tries++)) + Math.floor(Math.random() * 400);
    onConn('offline', wait);
    clearTimeout(timer);
    timer = setTimeout(connect, wait);
  }

  return {
    start: connect,
    send: function (obj) {
      if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
      return false;
    },
    isOpen: function () { return !!ws && ws.readyState === 1; },
    stop: function () { dead = true; clearTimeout(timer); if (ws) { try { ws.close(); } catch (e) {} } },
    // pagehide -> stop() is permanent (dead = true), but pagehide also fires when
    // the page enters the back/forward cache — switch apps on a phone and come
    // back and it would stay offline forever. pageshow calls this to revive.
    resume: function () {
      if (!dead && (ws || timer)) return;      // already live or already retrying
      dead = false; tries = 0; clearTimeout(timer); connect();
    }
  };
}
