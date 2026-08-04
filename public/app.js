/* =========================================================================
   Kacey — frontend
   Vanilla JS, no build step, no dependencies.

   Layout of this file
     1. constants, i18n strings, tiny state bag
     2. DOM refs
     3. orb state machine (+ optional amplitude rAF loop)
     4. message log rendering (plain text only, never innerHTML)
     5. text-to-speech: sentence-boundary buffering, voice matching
     6. speech recognition: toggle, interim results, every failure mode
     7. transports: real WebSocket (with backoff) and the mock stream
     8. protocol handler — the single pipeline both transports feed
     9. wiring / boot
   ========================================================================= */
(function () {
  'use strict';

  /* =======================================================================
     1. CONSTANTS / STATE
     ======================================================================= */

  var LS_LANG = 'kacey.lang';
  var LS_MUTED = 'kacey.muted';
  var LANGS = ['cs-CZ', 'en-US'];

  var STR = {
    'cs-CZ': {
      you: 'Já', kacey: 'Kacey',
      langLabel: 'Jazyk',
      connecting: 'Připojuji…', online: 'Připojeno', offline: 'Offline',
      reconnecting: function (s) { return 'Offline · nový pokus za ' + s + ' s'; },
      placeholder: 'Napiš zprávu…',
      send: 'Odeslat zprávu', stop: 'Zastavit odpověď',
      inputLabel: 'Zpráva',
      micStart: 'Začít mluvit', micStop: 'Přestat nahrávat',
      muteOn: 'Vypnout mluvení nahlas', muteOff: 'Zapnout mluvení nahlas',
      listening: 'Poslouchám…', listenHold: 'Mluv, po chvilce ticha to odešlu.',
      micHint: 'Klepni a mluv', thinking: 'Kacey přemýšlí…', speaking: 'Kacey mluví…',
      tool: function (n) { return n === 'klaus-memory' ? 'Prohledávám paměť…' : 'Používám ' + n + '…'; },
      readyInfo: function (model, mcp) {
        return 'Připojeno · ' + model + (mcp && mcp.length ? ' · ' + mcp.join(', ') : '');
      },
      errNoSpeech: 'Nic jsem neslyšela. Zkus to znovu.',
      errDenied: 'Přístup k mikrofonu byl zamítnut. Povol ho v nastavení prohlížeče.',
      errAudio: 'Mikrofon není dostupný.',
      errNet: 'Rozpoznávání řeči selhalo kvůli síti. Napiš to prosím.',
      errRec: 'Rozpoznávání řeči selhalo. Napiš to prosím.',
      errUnsupported: 'Tento prohlížeč neumí rozpoznávat řeč. Použij psaní (nebo Chrome / Edge).',
      errNoTTS: 'Tento prohlížeč neumí mluvit nahlas.',
      errNoVoice: function (l) { return 'Není nainstalovaný hlas pro ' + l + ' — čtu nahlas výchozím hlasem.'; },
      errOfflineSend: 'Nejsi připojená k serveru — zpráva nebyla odeslána.',
      interrupted: 'Přerušeno.',
      mockHint: 'MOCK režim: /error, /offline, /long'
    },
    'en-US': {
      you: 'You', kacey: 'Kacey',
      langLabel: 'Language',
      connecting: 'Connecting…', online: 'Connected', offline: 'Offline',
      reconnecting: function (s) { return 'Offline · retrying in ' + s + 's'; },
      placeholder: 'Type a message…',
      send: 'Send message', stop: 'Stop the response',
      inputLabel: 'Message',
      micStart: 'Start talking', micStop: 'Stop recording',
      muteOn: 'Mute spoken replies', muteOff: 'Unmute spoken replies',
      listening: 'Listening…', listenHold: 'Speak — I will send it after a pause.',
      micHint: 'Tap and speak', thinking: 'Kacey is thinking…', speaking: 'Kacey is speaking…',
      tool: function (n) { return n === 'klaus-memory' ? 'Recalling memory…' : 'Using ' + n + '…'; },
      readyInfo: function (model, mcp) {
        return 'Connected · ' + model + (mcp && mcp.length ? ' · ' + mcp.join(', ') : '');
      },
      errNoSpeech: 'I did not hear anything. Try again.',
      errDenied: 'Microphone access was denied. Allow it in your browser settings.',
      errAudio: 'No microphone available.',
      errNet: 'Speech recognition failed (network). Please type instead.',
      errRec: 'Speech recognition failed. Please type instead.',
      errUnsupported: 'This browser cannot do speech recognition. Type instead (or use Chrome / Edge).',
      errNoTTS: 'This browser cannot speak out loud.',
      errNoVoice: function (l) { return 'No installed voice for ' + l + ' — using the default voice.'; },
      errOfflineSend: 'Not connected to the server — message was not sent.',
      interrupted: 'Interrupted.',
      mockHint: 'MOCK mode: /error, /offline, /long'
    }
  };

  var MOCK = /(?:^|[?&])mock=1(?:&|$)/.test(location.search);

  var state = {
    lang: 'cs-CZ',
    muted: false,
    conn: 'connecting',      // connecting | online | offline
    streaming: false,        // a reply is in flight
    listening: false,        // recognition is actually running
    micDesired: false,       // the user wants the mic on
    resumeVoiceLoop: false,  // last turn came from voice -> re-open the mic after TTS
    ttsPending: 0,           // utterances queued/being spoken
    ttsSuspendedRec: false,  // recognition was stopped by us because TTS started
    errorUntil: 0,
    sessionId: null,
    voiceWarned: false
  };

  function t() { return STR[state.lang] || STR['en-US']; }

  /* =======================================================================
     2. DOM
     ======================================================================= */

  var $ = function (id) { return document.getElementById(id); };
  var orb = $('orb'), orbAmp = $('orbAmp');
  var conn = $('conn'), connLabel = $('connLabel');
  var logwrap = $('logwrap'), log = $('log');
  var hintEl = $('hint'), alertEl = $('alert'), announcer = $('announcer');
  var form = $('composer'), input = $('input'), sendBtn = $('send'), stopBtn = $('stop');
  var micBtn = $('mic'), micNote = $('micNote');
  var muteBtn = $('mute'), langSel = $('lang'), langLabel = $('langLabel');
  var inputLabel = $('inputLabel'), mockBadge = $('mockBadge');

  var reduceMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false, addEventListener: function () {} };

  /* =======================================================================
     3. ORB STATE MACHINE
     ======================================================================= */

  var orbState = 'boot';

  function computeOrbState() {
    if (Date.now() < state.errorUntil) return 'error';
    if (state.conn !== 'online') return 'offline';
    if (state.ttsPending > 0) return 'speaking';   // audio wins: it is what the user perceives
    if (state.streaming) return 'thinking';
    if (state.listening) return 'listening';
    return 'idle';
  }

  function syncOrb() {
    var next = computeOrbState();
    if (next !== orbState) {
      orbState = next;
      orb.setAttribute('data-state', next);
      startAmpLoop();
    }
    // ambient hint text follows the orb unless something transient owns it
    if (!hintLocked) {
      if (next === 'thinking') setHint(t().thinking, true);
      else if (next === 'speaking') setHint(t().speaking, true);
      else if (next === 'listening') setHint(t().listening, true);
      else setHint('');
    }
  }

  /* Amplitude loop: a smooth pseudo-noise written into --amp so the orb reads
     as voice/energy rather than a metronome. Runs ONLY while thinking /
     speaking / listening, and never when the tab is hidden or motion is
     reduced — so the idle page costs nothing. */
  var rafId = 0;

  function ampActive() {
    return !reduceMotion.matches &&
      !document.hidden &&
      (orbState === 'thinking' || orbState === 'speaking' || orbState === 'listening');
  }

  function ampTick(ts) {
    if (!ampActive()) { rafId = 0; orbAmp.style.setProperty('--amp', '0'); return; }
    var s = ts / 1000;
    var fast = orbState === 'speaking' ? 1 : 0.45;
    // three incommensurable sines -> organic, non-repeating envelope
    var v = 0.5 +
      0.30 * Math.sin(s * (5.1 * fast + 1.2)) +
      0.14 * Math.sin(s * (11.3 * fast + 2.0) + 1.7) +
      0.06 * Math.sin(s * (19.7 * fast + 3.1) + 0.4);
    if (v < 0) v = 0; else if (v > 1) v = 1;
    if (orbState === 'listening') v *= 0.55;
    orbAmp.style.setProperty('--amp', v.toFixed(3));
    rafId = requestAnimationFrame(ampTick);
  }

  function startAmpLoop() {
    if (rafId || !ampActive()) {
      if (!ampActive() && rafId) { cancelAnimationFrame(rafId); rafId = 0; orbAmp.style.setProperty('--amp', '0'); }
      return;
    }
    rafId = requestAnimationFrame(ampTick);
  }

  /* =======================================================================
     4. MESSAGE LOG  (textContent only — server text is untrusted)
     ======================================================================= */

  var stick = true;
  logwrap.addEventListener('scroll', function () {
    stick = logwrap.scrollHeight - logwrap.scrollTop - logwrap.clientHeight < 140;
  }, { passive: true });

  function scrollEnd(force) {
    if (force) stick = true;
    if (stick) logwrap.scrollTop = logwrap.scrollHeight;
  }

  function addMessage(role, text) {
    var li = document.createElement('li');
    li.className = 'msg msg--' + role;

    if (role !== 'system') {
      var who = document.createElement('p');
      who.className = 'msg__who';
      who.textContent = role === 'user' ? t().you : t().kacey;
      li.appendChild(who);
    }

    var bubble = document.createElement('p');
    bubble.className = 'msg__bubble';
    var node = document.createTextNode(text || '');
    bubble.appendChild(node);
    li.appendChild(bubble);

    log.appendChild(li);
    scrollEnd(role === 'user');
    return { li: li, bubble: bubble, node: node };
  }

  var current = null; // the assistant bubble currently being streamed into

  function beginAssistant() {
    if (current) return current;
    current = addMessage('assistant', '');
    current.bubble.classList.add('is-streaming');
    return current;
  }

  function appendDelta(chunk) {
    if (typeof chunk !== 'string' || chunk === '') return;
    beginAssistant();
    current.node.nodeValue += chunk;   // raw concatenation: chunks may split mid-word
    scrollEnd();
    feedTTS(chunk);
  }

  function endAssistant(quiet) {
    if (current) {
      current.bubble.classList.remove('is-streaming');
      var full = current.node.nodeValue;
      if (!full) current.li.remove();
      else if (!quiet) announcer.textContent = full;   // one polite SR announcement per turn
      current = null;
    }
    state.streaming = false;
    stopBtn.hidden = true;
    sendBtn.hidden = false;
    syncOrb();
  }

  /* transient status line */
  var hintLocked = false, hintTimer = 0;

  function setHint(text, busy) {
    hintEl.textContent = text || '';
    hintEl.classList.toggle('is-busy', !!busy && !!text);
  }

  function flashHint(text, busy, ms) {
    hintLocked = true;
    clearTimeout(hintTimer);
    setHint(text, busy);
    hintTimer = setTimeout(function () { hintLocked = false; syncOrb(); }, ms || 2600);
  }

  var alertTimer = 0;
  function showAlert(message, alsoInLog) {
    var msg = String(message == null ? '' : message);
    alertEl.textContent = msg;
    alertEl.hidden = !msg;
    // When the message also gets a permanent row in the log, keep the role="alert"
    // node for the assertive screen-reader announcement but do not show the text
    // twice on screen.
    alertEl.classList.toggle('sr-only', !!alsoInLog);
    clearTimeout(alertTimer);
    if (msg) {
      alertTimer = setTimeout(function () {
        alertEl.hidden = true; alertEl.textContent = ''; alertEl.classList.remove('sr-only');
      }, 8000);
      state.errorUntil = Date.now() + 2200;
      syncOrb();
      setTimeout(syncOrb, 2300);
      if (alsoInLog) { addMessage('system', msg); scrollEnd(true); }
    }
  }

  /* =======================================================================
     5. TEXT TO SPEECH
     ======================================================================= */

  var synth = window.speechSynthesis || null;
  var ttsBuf = '';
  var voices = [];
  var ttsPrimed = false;

  function loadVoices() {
    if (!synth) return;
    try { voices = synth.getVoices() || []; } catch (e) { voices = []; }
  }
  if (synth) {
    loadVoices();
    // getVoices() is empty until this fires in Chrome/Edge
    if ('onvoiceschanged' in synth) synth.onvoiceschanged = function () { loadVoices(); };
    else setTimeout(loadVoices, 400);
  }

  function pickVoice(lang) {
    if (!voices.length) loadVoices();
    if (!voices.length) return null;
    var want = lang.toLowerCase();
    var base = want.split('-')[0];
    var norm = function (v) { return (v.lang || '').replace('_', '-').toLowerCase(); };
    var pool = voices.filter(function (v) { return norm(v) === want; });
    if (!pool.length) pool = voices.filter(function (v) { return norm(v).indexOf(base) === 0; });
    if (!pool.length) {
      if (!state.voiceWarned) { state.voiceWarned = true; flashHint(t().errNoVoice(lang), false, 4500); }
      return null;
    }
    var local = pool.filter(function (v) { return v.localService; });
    return (local[0] || pool[0]);
  }

  /* Unlock audio on the first real user gesture (Safari/iOS refuse otherwise). */
  function primeTTS() {
    if (ttsPrimed || !synth) return;
    ttsPrimed = true;
    try {
      var u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      synth.speak(u);
    } catch (e) { /* non-fatal */ }
  }

  /* Split off every COMPLETE sentence, keep the tail buffered.
     A boundary is . ! ? … or a newline, followed by whitespace (or, on the
     final flush, by end of text). Decimals like "3.14" are not boundaries. */
  var CLOSERS = '"\')]»”’…!?.';

  function takeSentences(buf, final) {
    var out = [], start = 0, i = 0;
    while (i < buf.length) {
      var c = buf.charAt(i);
      if (c === '\n') {
        out.push(buf.slice(start, i + 1)); start = i + 1; i = start; continue;
      }
      if (c === '.' || c === '!' || c === '?' || c === '…') {
        if (c === '.' && /\d/.test(buf.charAt(i - 1)) && /\d/.test(buf.charAt(i + 1))) { i++; continue; }
        var j = i + 1;
        while (j < buf.length && CLOSERS.indexOf(buf.charAt(j)) !== -1) j++;
        if (j < buf.length && /\s/.test(buf.charAt(j))) {
          out.push(buf.slice(start, j + 1)); start = j + 1; i = start; continue;
        }
        if (j >= buf.length && final) { out.push(buf.slice(start)); start = buf.length; break; }
        i = j; continue;
      }
      i++;
    }
    var rest = buf.slice(start);
    if (final && rest.trim()) { out.push(rest); rest = ''; }
    // never speak a lone stray character
    var keep = [];
    for (var k = 0; k < out.length; k++) {
      if (out[k].trim().length > 1 || final) keep.push(out[k]);
      else rest = out[k] + rest;
    }
    return { sentences: keep, rest: rest };
  }

  function feedTTS(chunk) {
    if (!synth || state.muted) return;
    ttsBuf += chunk;
    var r = takeSentences(ttsBuf, false);
    ttsBuf = r.rest;
    for (var i = 0; i < r.sentences.length; i++) speakChunk(r.sentences[i]);
  }

  function flushTTS() {
    if (!synth || state.muted) { ttsBuf = ''; return; }
    var r = takeSentences(ttsBuf, true);
    ttsBuf = '';
    for (var i = 0; i < r.sentences.length; i++) speakChunk(r.sentences[i]);
  }

  function speakChunk(text) {
    if (!synth || state.muted || !text || !text.trim()) return;

    // Feedback-loop guard: never let the mic hear our own voice.
    if (state.listening) {
      state.ttsSuspendedRec = true;
      stopRecognition(false);
    }

    var u;
    try { u = new SpeechSynthesisUtterance(text); } catch (e) { return; }
    u.lang = state.lang;
    var v = pickVoice(state.lang);
    if (v) u.voice = v;
    u.rate = 1.02; u.pitch = 1; u.volume = 1;

    var done = false, guard = 0;
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(guard);
      state.ttsPending = Math.max(0, state.ttsPending - 1);
      syncOrb();
      if (state.ttsPending === 0) onAllSpeechDone();
    }
    u.onend = finish;
    u.onerror = finish;                       // includes 'interrupted' / 'canceled'
    // Watchdog: some engines silently drop onend. Never strand the orb in "speaking".
    guard = setTimeout(finish, 4000 + text.length * 130);

    state.ttsPending++;
    syncOrb();
    try { synth.speak(u); } catch (e) { finish(); }
  }

  function cancelSpeech() {
    ttsBuf = '';
    if (synth) { try { synth.cancel(); } catch (e) {} }
    state.ttsPending = 0;
    syncOrb();
  }

  function onAllSpeechDone() {
    if (state.ttsSuspendedRec || state.resumeVoiceLoop) {
      state.ttsSuspendedRec = false;
      // short pause so the speaker tail does not get picked up
      setTimeout(maybeResumeVoiceLoop, 400);
    }
  }

  /* Hands-free loop: if the turn started with the voice, re-open the mic once
     the answer has been spoken. Only ever while visible + online. */
  function maybeResumeVoiceLoop() {
    if (!state.resumeVoiceLoop && !state.micDesired) return;
    if (document.hidden || state.conn !== 'online' || state.streaming || state.ttsPending > 0) return;
    if (state.listening || !recognitionAvailable()) return;
    state.resumeVoiceLoop = false;
    startRecognition();
  }

  /* =======================================================================
     6. SPEECH RECOGNITION
     ======================================================================= */

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  var rec = null;
  var recBlocked = false;    // permission denied / hardware missing -> stop offering it
  var baseText = '';         // whatever the user had typed before dictating

  function recognitionAvailable() { return !!SR && !recBlocked; }

  function buildRecognition() {
    if (!SR) return null;
    var r = new SR();
    r.lang = state.lang;
    r.continuous = false;      // one utterance per press; onend always resets the UI
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onstart = function () {
      state.listening = true;
      micBtn.setAttribute('aria-pressed', 'true');
      micBtn.setAttribute('aria-label', t().micStop);
      micNote.textContent = t().listenHold;
      syncOrb();
    };

    r.onaudiostart = function () { cancelSpeech(); };      // user talks -> we shut up
    r.onspeechstart = function () { cancelSpeech(); };

    r.onresult = function (ev) {
      var finalText = '', interim = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var alt = ev.results[i][0];
        if (!alt) continue;
        if (ev.results[i].isFinal) finalText += alt.transcript;
        else interim += alt.transcript;
      }
      if (interim) {
        input.value = (baseText ? baseText + ' ' : '') + interim;
        input.classList.add('is-interim');
      }
      if (finalText.trim()) {
        input.classList.remove('is-interim');
        var text = (baseText ? baseText + ' ' : '') + finalText.trim();
        input.value = text;
        baseText = '';
        state.micDesired = false;
        state.resumeVoiceLoop = true;     // keep the hands-free conversation going
        stopRecognition(false);
        submit(text);
      }
    };

    r.onerror = function (ev) {
      var code = (ev && ev.error) || 'unknown';
      switch (code) {
        case 'no-speech':
          flashHint(t().errNoSpeech, false, 3000);
          state.micDesired = false;
          state.resumeVoiceLoop = false;
          break;
        case 'aborted':
          break;                                   // we did it on purpose; stay quiet
        case 'not-allowed':
        case 'service-not-allowed':
          recBlocked = true;
          state.micDesired = false;
          state.resumeVoiceLoop = false;
          showAlert(t().errDenied);
          disableMic(t().errDenied);
          break;
        case 'audio-capture':
          recBlocked = true;
          state.micDesired = false;
          showAlert(t().errAudio);
          disableMic(t().errAudio);
          break;
        case 'network':
          state.micDesired = false;
          state.resumeVoiceLoop = false;
          showAlert(t().errNet);
          break;
        case 'language-not-supported':
          state.micDesired = false;
          showAlert(t().errRec);
          break;
        default:
          state.micDesired = false;
          state.resumeVoiceLoop = false;
          showAlert(t().errRec);
      }
      resetMicUI();
    };

    // Fires on every stop: manual, natural timeout, error, tab switch.
    // This is the one place that guarantees we never look "stuck listening".
    r.onend = function () {
      var wasSuspended = state.ttsSuspendedRec;
      resetMicUI();
      if (input.classList.contains('is-interim')) {
        // an interim transcript never finalised — keep it for the user to send/edit
        input.classList.remove('is-interim');
      }
      if (!wasSuspended && !state.resumeVoiceLoop) state.micDesired = false;
    };

    return r;
  }

  function resetMicUI() {
    state.listening = false;
    micBtn.setAttribute('aria-pressed', 'false');
    micBtn.setAttribute('aria-label', t().micStart);
    if (!recBlocked && SR) micNote.textContent = t().micHint;
    syncOrb();
  }

  function startRecognition() {
    if (!recognitionAvailable()) return;
    if (state.listening) return;
    cancelSpeech();
    if (!rec) rec = buildRecognition();
    if (!rec) return;
    rec.lang = state.lang;
    baseText = input.value.trim();
    try {
      rec.start();
    } catch (e) {
      // InvalidStateError: engine still winding down. Rebuild and retry once.
      try { rec.abort(); } catch (e2) {}
      rec = buildRecognition();
      setTimeout(function () {
        if (!rec || state.listening) return;
        try { rec.start(); } catch (e3) { resetMicUI(); showAlert(t().errRec); }
      }, 220);
    }
  }

  function stopRecognition(hard) {
    if (!rec) { resetMicUI(); return; }
    try { hard ? rec.abort() : rec.stop(); } catch (e) {}
    if (hard) resetMicUI();
  }

  function disableMic(reason) {
    micBtn.disabled = true;
    micBtn.setAttribute('data-unavailable', 'true');
    micNote.textContent = reason;
    resetMicUI();
  }

  function toggleMic() {
    primeTTS();
    if (!recognitionAvailable()) return;
    if (state.listening || state.micDesired) {
      state.micDesired = false;
      state.resumeVoiceLoop = false;
      stopRecognition(true);
      return;
    }
    state.micDesired = true;
    startRecognition();
  }

  /* =======================================================================
     7. TRANSPORTS — identical interface, one pipeline
        { start(), send(obj) -> bool, isOpen(), stop() }
        Both call onServer(msg) and onConn(state, retryMs).
     ======================================================================= */

  function makeSocketTransport(onServer, onConn) {
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

  /* ---- MOCK TRANSPORT ---------------------------------------------------
     ?mock=1 bypasses the WebSocket and replays the exact same frame types
     from a script, so the whole UI can be built and tested with no backend.
     Type "/error" or "/offline" (or "/long") to exercise those branches.
     ---------------------------------------------------------------------- */
  function makeMockTransport(onServer, onConn) {
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
      at(120, function () { onServer({ type: 'ready', model: 'claude-opus-4-6 (mock)', mcpServers: ['klaus-memory'] }); });
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

  /* =======================================================================
     8. PROTOCOL PIPELINE (shared by both transports)
     ======================================================================= */

  var transport = null;
  var readyInfo = '';
  var toolDepth = 0;

  function onServer(msg) {
    switch (msg.type) {
      case 'ready':
        readyInfo = t().readyInfo(
          typeof msg.model === 'string' ? msg.model : '?',
          Array.isArray(msg.mcpServers) ? msg.mcpServers.filter(function (s) { return typeof s === 'string'; }) : []
        );
        connLabel.textContent = t().online;
        conn.title = readyInfo;
        flashHint(readyInfo, false, 4200);
        break;

      case 'session':
        state.sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
        if (state.sessionId) conn.title = readyInfo + ' · ' + state.sessionId;
        break;

      case 'thinking':
        state.streaming = true;
        stopBtn.hidden = false;
        sendBtn.hidden = true;
        beginAssistant();
        syncOrb();
        break;

      case 'delta':
        if (!state.streaming) { state.streaming = true; stopBtn.hidden = false; sendBtn.hidden = true; }
        appendDelta(typeof msg.text === 'string' ? msg.text : '');
        syncOrb();
        break;

      case 'tool':
        if (msg.phase === 'start') { toolDepth++; flashHint(t().tool(String(msg.name || '')), true, 12000); }
        else { toolDepth = Math.max(0, toolDepth - 1); if (!toolDepth) { hintLocked = false; clearTimeout(hintTimer); syncOrb(); } }
        break;

      case 'done':
        toolDepth = 0;
        hintLocked = false;
        flushTTS();
        endAssistant();
        // muted? then nothing will speak — reopen the mic straight away
        if (state.ttsPending === 0) setTimeout(maybeResumeVoiceLoop, 250);
        break;

      case 'error':
        toolDepth = 0;
        hintLocked = false;
        cancelSpeech();
        endAssistant(true);
        showAlert(typeof msg.message === 'string' && msg.message ? msg.message : t().errRec, true);
        state.resumeVoiceLoop = false;
        break;

      default:
        break; // unknown frame types are ignored, not fatal
    }
  }

  var connCountdown = 0;
  function onConn(next, retryMs) {
    state.conn = next;
    conn.setAttribute('data-state', next);
    clearInterval(connCountdown);

    if (next === 'online') {
      connLabel.textContent = readyInfo ? t().online : t().connecting;
      input.disabled = false;
      sendBtn.disabled = false;
      if (recognitionAvailable()) micBtn.disabled = false;
    } else if (next === 'connecting') {
      connLabel.textContent = t().connecting;
      input.disabled = false;      // let people type while we reconnect
      sendBtn.disabled = true;
    } else {
      // offline: degrade visibly instead of failing silently
      cancelSpeech();
      stopRecognition(true);
      endAssistant(true);
      input.disabled = true;
      sendBtn.disabled = true;
      micBtn.disabled = true;
      var left = Math.ceil((retryMs || 0) / 1000);
      var paint = function () {
        connLabel.textContent = left > 0 ? t().reconnecting(left) : t().offline;
        if (left-- <= 0) clearInterval(connCountdown);
      };
      paint();
      if (left > 0) connCountdown = setInterval(paint, 1000);
    }
    syncOrb();
  }

  /* ---- sending ---------------------------------------------------------- */

  function submit(text) {
    var msg = String(text == null ? '' : text).trim();
    if (!msg) return;

    primeTTS();
    cancelSpeech();                       // a new message always silences the old answer

    if (state.streaming) {
      transport.send({ type: 'interrupt' });
      endAssistant(true);
    }

    if (!transport.isOpen()) {
      showAlert(t().errOfflineSend);
      return;
    }

    addMessage('user', msg);
    input.value = '';
    input.classList.remove('is-interim');
    var ok = transport.send({ type: 'user_message', text: msg });
    if (!ok) showAlert(t().errOfflineSend);
    else syncOrb();
  }

  function interrupt() {
    if (!state.streaming && state.ttsPending === 0) return;
    cancelSpeech();
    state.resumeVoiceLoop = false;
    if (state.streaming) transport.send({ type: 'interrupt' });
    endAssistant();
    flashHint(t().interrupted, false, 1800);
  }

  /* =======================================================================
     9. WIRING / BOOT
     ======================================================================= */

  function applyLangToUI() {
    var s = t();
    document.documentElement.lang = state.lang.split('-')[0];
    langSel.value = state.lang;
    langLabel.textContent = s.langLabel;
    inputLabel.textContent = s.inputLabel;
    input.placeholder = s.placeholder;
    sendBtn.setAttribute('aria-label', s.send);
    sendBtn.title = s.send;
    stopBtn.setAttribute('aria-label', s.stop);
    stopBtn.title = s.stop;
    applyMuteToUI();
    if (!SR) {
      micNote.textContent = s.errUnsupported;
    } else if (recBlocked) {
      micNote.textContent = s.errDenied;
    } else {
      micNote.textContent = state.listening ? s.listenHold : s.micHint;
    }
    micBtn.setAttribute('aria-label', state.listening ? s.micStop : s.micStart);
    // re-label the connection pill without restarting any retry countdown
    connLabel.textContent = state.conn === 'online' ? (readyInfo ? s.online : s.connecting)
      : state.conn === 'connecting' ? s.connecting : s.offline;
    if (MOCK) flashHint(s.mockHint, false, 5000);
  }

  function applyMuteToUI() {
    var s = t();
    var label = state.muted ? s.muteOff : s.muteOn;
    muteBtn.setAttribute('aria-pressed', String(state.muted));
    muteBtn.setAttribute('aria-label', label);
    muteBtn.title = label;
    if (!synth) { muteBtn.disabled = true; muteBtn.title = s.errNoTTS; muteBtn.setAttribute('aria-label', s.errNoTTS); }
  }

  /* restore persisted preferences */
  try {
    var savedLang = localStorage.getItem(LS_LANG);
    if (savedLang && LANGS.indexOf(savedLang) !== -1) state.lang = savedLang;
    state.muted = localStorage.getItem(LS_MUTED) === '1';
  } catch (e) { /* private mode: defaults are fine */ }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    submit(input.value);
  });

  input.addEventListener('input', function () {
    input.classList.remove('is-interim');
    state.resumeVoiceLoop = false;      // typing opts out of the hands-free loop
  });

  sendBtn.addEventListener('click', primeTTS);
  stopBtn.addEventListener('click', interrupt);
  micBtn.addEventListener('click', toggleMic);

  muteBtn.addEventListener('click', function () {
    state.muted = !state.muted;
    try { localStorage.setItem(LS_MUTED, state.muted ? '1' : '0'); } catch (e) {}
    if (state.muted) cancelSpeech(); else primeTTS();
    applyMuteToUI();
  });

  langSel.addEventListener('change', function () {
    var v = langSel.value;
    if (LANGS.indexOf(v) === -1) return;
    state.lang = v;
    try { localStorage.setItem(LS_LANG, v); } catch (e) {}
    state.voiceWarned = false;
    cancelSpeech();
    applyLangToUI();
    if (state.listening) {           // restart recognition in the new language
      stopRecognition(true);
      setTimeout(function () { if (state.micDesired) startRecognition(); }, 260);
    }
    syncOrb();
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      if (state.listening) { toggleMic(); return; }
      interrupt();
    }
  });

  document.addEventListener('visibilitychange', function () {
    document.body.classList.toggle('is-hidden', document.hidden);
    if (document.hidden) {
      state.micDesired = false;
      stopRecognition(true);           // mobile browsers kill it anyway
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    } else {
      startAmpLoop();
    }
  });

  reduceMotion.addEventListener && reduceMotion.addEventListener('change', function () {
    if (reduceMotion.matches && rafId) {
      cancelAnimationFrame(rafId); rafId = 0; orbAmp.style.setProperty('--amp', '0');
    } else startAmpLoop();
  });

  window.addEventListener('pagehide', function () {
    if (synth) { try { synth.cancel(); } catch (e) {} }
    stopRecognition(true);
    if (transport) transport.stop();
  });

  // Restored from the back/forward cache (or a hidden pane that fired pagehide):
  // pagehide killed the transport permanently, so bring it back.
  window.addEventListener('pageshow', function () {
    if (transport && transport.resume) transport.resume();
  });

  /* mic availability is decided once, up front — never show a dead button */
  if (!SR) disableMic(t().errUnsupported);

  applyLangToUI();
  if (MOCK) mockBadge.hidden = false;
  // the page can be loaded while already backgrounded — visibilitychange never fires then
  document.body.classList.toggle('is-hidden', document.hidden);

  transport = MOCK ? makeMockTransport(onServer, onConn) : makeSocketTransport(onServer, onConn);
  onConn('connecting');
  transport.start();
  syncOrb();

  /* small test surface for the browser console / automation */
  window.kacey = {
    state: state,
    send: submit,
    inject: onServer,
    conn: onConn,
    orb: function () { return orbState; }
  };
})();
