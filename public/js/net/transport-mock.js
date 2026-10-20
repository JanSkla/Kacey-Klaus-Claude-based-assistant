/* =========================================================================
   The mock transport.

   ?mock=1 bypasses the WebSocket and replays the exact same frame types from a
   script, so the whole UI can be built and tested with no backend, no API key
   and no memory database. Type "/error", "/offline", "/long" or "/web" (or ask
   for "ordinační hodiny") to exercise those branches.

   It deliberately produces awkward output — chunks that split mid-word, a
   preamble before a tool call, sentences without the space after the full stop
   — because those are the cases that broke the renderer and the speech
   splitter in real use.
   ========================================================================= */

import { state } from '../core/state.js';

export function makeMockTransport(onServer, onConn, submit) {
  var open = false, timers = [], cancelled = false;

  function at(ms, fn) { timers.push(setTimeout(function () { if (!cancelled) fn(); }, ms)); }
  function clearAll() { timers.forEach(clearTimeout); timers = []; }

  var REPLIES = {
    'cs-CZ': [
      'Ahoj Klausi. Jsem tu — pamatuju si naše minulé rozhovory. Co dneska řešíme?',
      'Podle paměti jsi minulý týden ladil ten hlasový interface. Mám ti připomenout, kde jsi skončil?',
      'Rozumím. Poznamenala jsem si to do dlouhodobé paměti. Chceš k tomu ještě něco dodat?'
    ],
    'en-US': [
      'Hey Klaus. I am here — I remember our earlier conversations. What are we working on today?',
      'From memory: last week you were polishing the voice interface. Want me to recap where you stopped?',
      'Got it. I stored that in long-term memory. Anything you want to add?'
    ]
  };
  var LONG = {
    'cs-CZ': 'Tak popořadě. Nejdřív se podíváme na architekturu — WebSocket drží jedno spojení a streamuje delty. Pak řeč: rozpoznávání běží jen když ho pustíš, syntéza mluví po větách. A nakonec ta koule; pulzuje podle stavu. Dává to smysl?',
    'en-US': 'Let me take this in order. First the architecture — one WebSocket streams deltas. Then speech: recognition runs only while you hold the mic, synthesis speaks sentence by sentence. And finally the orb; it pulses with the state. Does that make sense?'
  };
  var turn = 0;

  /* split into 1..7 char pieces, deliberately breaking mid-word to prove
     the renderer concatenates raw text without inserting spaces */
  function chunk(text) {
    var out = [], i = 0;
    while (i < text.length) {
      var n = 1 + Math.floor(Math.random() * 7);
      out.push(text.substr(i, n));
      i += n;
    }
    return out;
  }

  function ready() {
    open = true;
    onConn('online');
    at(120, function () { onServer({ type: 'ready', version: '1.0.0', model: 'claude-opus-4-6 (mock)', mcpServers: ['klaus-memory'] }); });
    at(200, function () { onServer({ type: 'session', sessionId: 'mock-' + Math.random().toString(36).slice(2, 9) }); });
  }

  function respond(text) {
    var lower = text.toLowerCase();

    if (lower.indexOf('/error') === 0) {
      at(300, function () { onServer({ type: 'thinking' }); });
      at(900, function () { onServer({ type: 'error', message: 'Mock backend failure: klaus-memory MCP server did not respond.' }); });
      return;
    }
    if (lower.indexOf('/offline') === 0) {
      // clear synchronously FIRST, then schedule the reconnect, otherwise
      // clearAll() would also cancel the timer that brings us back online
      clearAll();
      open = false;
      onConn('offline', 4000);
      at(4000, ready);
      return;
    }

    /* A question for the web: a search, one page read, sources under the answer. */
    if (lower.indexOf('/web') === 0 || /ordina|otevírac|internet|na webu/.test(lower)) {
      var t = 260;
      var say = function (text) {
        chunk(text).forEach(function (piece) {
          t += 22 + Math.floor(Math.random() * 30);
          at(t, function () { onServer({ type: 'delta', text: piece }); });
        });
      };
      at(t, function () { onServer({ type: 'thinking' }); });
      say('Podívám se na internet.');
      at(t += 200, function () { onServer({ type: 'tool', name: 'WebSearch', phase: 'start' }); });
      at(t += 1400, function () {
        onServer({ type: 'web', tool: 'search', ok: true, query: 'MUDr. Nováková praktická lékařka Brno ordinační hodiny', sources: [
          { title: 'MUDr. Jana Nováková — praktický lékař pro dospělé', url: 'https://www.ordinace-novakova.cz/ordinacni-hodiny' },
          { title: 'Nováková Jana MUDr. | Firmy.cz', url: 'https://www.firmy.cz/detail/12345-mudr-jana-novakova-brno.html' },
          { title: 'Praktičtí lékaři Brno-střed — seznam ordinací', url: 'https://www.brno-stred.cz/zdravotnictvi/prakticti-lekari' },
          { title: 'MUDr. Jana Nováková, Brno — recenze a hodnocení', url: 'https://www.znamylekar.cz/mudr-jana-novakova/prakticky-lekar/brno' }
        ] });
        onServer({ type: 'tool', name: 'WebSearch', phase: 'end' });
      });
      at(t += 150, function () { onServer({ type: 'tool', name: 'WebFetch', phase: 'start' }); });
      at(t += 1100, function () {
        onServer({ type: 'web', tool: 'fetch', ok: true, sources: [{ title: '', url: 'https://www.ordinace-novakova.cz/ordinacni-hodiny' }] });
        onServer({ type: 'tool', name: 'WebFetch', phase: 'end' });
      });
      t += 200;
      say('Paní doktorka Nováková ordinuje v pondělí a ve středu od sedmi do jedné, v úterý a ve čtvrtek odpoledne od dvou do šesti, v pátek jen do jedenácti. Odběry jsou každé ráno do půl deváté.');
      at(t += 160, function () { onServer({ type: 'done' }); });
      return;
    }

    var reply = lower.indexOf('/long') === 0 ? LONG[state.lang] : REPLIES[state.lang][turn++ % 3];
    var withTool = turn % 2 === 1 || lower.indexOf('/long') === 0;
    var clock = 260;

    at(clock, function () { onServer({ type: 'thinking' }); });
    if (withTool) {
      clock += 320;
      at(clock, function () { onServer({ type: 'tool', name: 'klaus-memory', phase: 'start' }); });
      clock += 850;
      at(clock, function () { onServer({ type: 'tool', name: 'klaus-memory', phase: 'end' }); });
    }
    clock += 260;
    chunk(reply).forEach(function (piece) {
      clock += 22 + Math.floor(Math.random() * 30);
      at(clock, function () { onServer({ type: 'delta', text: piece }); });
    });
    clock += 160;
    at(clock, function () { onServer({ type: 'done' }); });
  }

  /* &say=<text> auto-submits one turn on connect. Mock-only; it exists so a
     headless browser (which cannot click or talk) can capture a populated UI. */
  function autoSay() {
    var m = /[?&]say=([^&]*)/.exec(location.search);
    if (!m) return;
    var text = decodeURIComponent(m[1].replace(/\+/g, ' '));
    if (text) at(500, function () { submit(text); });
  }

  return {
    start: function () { onConn('connecting'); at(350, ready); at(360, autoSay); },
    send: function (obj) {
      if (!open) return false;
      if (obj.type === 'user_message') { respond(String(obj.text || '')); return true; }
      if (obj.type === 'interrupt') { clearAll(); at(60, function () { onServer({ type: 'done' }); }); return true; }
      return true;
    },
    isOpen: function () { return open; },
    stop: function () { cancelled = true; clearAll(); open = false; },
    resume: function () { if (open) return; cancelled = false; onConn('connecting'); at(200, ready); }
  };
}
