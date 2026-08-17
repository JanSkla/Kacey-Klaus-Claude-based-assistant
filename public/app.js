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
  var LS_VOICE = 'kacey.voice';
  var LS_WAKE = 'kacey.wake';
  var LS_WAKE_MODE = 'kacey.wake.mode';    // 'voice' (my recording) | 'asr' (transcript)
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
      errInsecure: 'Mikrofon funguje jen přes HTTPS nebo na localhostu. Otevři Kacey přes https:// (např. Tailscale Serve), jinak zbývá psaní.',
      errNoTTS: 'Tento prohlížeč neumí mluvit nahlas.',
      errNoVoice: function (l) { return 'Není nainstalovaný hlas pro ' + l + ' — čtu nahlas výchozím hlasem.'; },
      errOfflineSend: 'Nejsi připojená k serveru — zpráva nebyla odeslána.',
      interrupted: 'Přerušeno.',
      mockHint: 'MOCK režim: /error, /offline, /long',
      wakeOn: 'Slovo „KC“ zapne diktování — poslouchám (přepis)',
      wakeOnVoice: 'Slovo „KC“ zapne diktování — poslouchám (můj hlas)',
      wakeOff: 'Slovo „KC“ nepoužívat',
      wakeBlocked: 'Mikrofon není povolen, „KC“ nefunguje',
      wakeCfgHint: 'podržením nastavíš hlasový podpis',
      closed: 'Hovor ukončen. Řekni „KC“, až budeš chtít pokračovat.',
      silenced: 'Ticho.'
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
      errInsecure: 'The microphone only works over HTTPS or on localhost. Open Kacey via https:// (e.g. Tailscale Serve), otherwise typing is the only input.',
      errNoTTS: 'This browser cannot speak out loud.',
      errNoVoice: function (l) { return 'No installed voice for ' + l + ' — using the default voice.'; },
      errOfflineSend: 'Not connected to the server — message was not sent.',
      interrupted: 'Interrupted.',
      mockHint: 'MOCK mode: /error, /offline, /long',
      wakeOn: 'Say "KC" to start dictation — listening (transcript)',
      wakeOnVoice: 'Say "KC" to start dictation — listening (my voice)',
      wakeOff: 'Wake word "KC" off',
      wakeBlocked: 'Microphone not allowed, "KC" cannot work',
      wakeCfgHint: 'hold to set up your voiceprint',
      closed: 'Conversation ended. Say "KC" when you want to continue.',
      silenced: 'Quiet.'
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
    voiceWarned: false,
    voice: 'Nova Hogarth'    // XTTS speaker, or 'browser' for the built-in engine
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
  var voiceSel = $('voice');
  var wakeBtn = $('wake');
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
    if (typeof updateTelemetry === 'function') updateTelemetry();
    // The barge-in listener lives and dies with the spoken reply, and syncOrb is
    // called at every ttsPending change — so it cannot drift out of step.
    if (typeof superviseBarge === 'function') superviseBarge();
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
    // The HUD activity meter reads the same envelope the orb does — one source
    // of truth, so the bars can never disagree with what the orb is showing.
    paintMeter(v);
    rafId = requestAnimationFrame(ampTick);
  }

  var meterBars = null;

  /* Bars trail the envelope with a per-bar phase offset, so the meter reads as
     a moving signal rather than twelve identical bars. Idle => flat. */
  function paintMeter(v) {
    if (meterBars === null) {
      var box = $('meter');
      meterBars = box ? Array.prototype.slice.call(box.children) : [];
    }
    for (var i = 0; i < meterBars.length; i++) {
      var phase = 1 - Math.abs((i / (meterBars.length - 1)) - 0.5) * 1.3;
      var h = Math.max(3, v * 100 * phase);
      meterBars[i].style.height = h.toFixed(1) + '%';
    }
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

  /* Kacey speaks once BEFORE reaching for memory or the calendar ("Podívám se do
     kalendáře.") and again after. Those are two different utterances, so they get
     two bubbles — and the first one is sealed and spoken the moment the tool call
     starts, which is the earliest instant we know it is complete. Waiting for a
     sentence boundary would delay the very thing that exists to feel immediate. */
  function sealPreamble() {
    if (!current || !current.node.nodeValue.trim()) return;
    current.bubble.classList.remove('is-streaming');
    current.bubble.classList.add('msg__bubble--preamble');
    current.li.classList.add('msg--preamble');
    current = null;                    // the answer will open a fresh bubble
    flushTTS();                        // speak it now, terminator or not
  }

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

  /* A single <audio> element reused for every XTTS clip. It must be created AND
     played once inside a real user gesture — a freshly constructed Audio() is not
     unlocked by an earlier gesture on iOS, so playback would silently reject. */
  var ttsEl = null;
  var SILENT_WAV =
    'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAABErAAABAAgAZGF0YQAAAAA=';

  function audioEl() {
    if (!ttsEl) {
      ttsEl = new Audio();
      ttsEl.preload = 'auto';
    }
    return ttsEl;
  }

  /* Unlock audio on the first real user gesture (Safari/iOS refuse otherwise).
     Primes BOTH engines: speechSynthesis for the browser voice, and the shared
     <audio> element for the XTTS voices. */
  function primeTTS() {
    if (ttsPrimed) return;
    ttsPrimed = true;
    if (synth) {
      try {
        var u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        synth.speak(u);
      } catch (e) { /* non-fatal */ }
    }
    try {
      var a = audioEl();
      a.src = SILENT_WAV;
      var p = a.play();
      if (p && p.catch) p.catch(function () { /* still locked; reported on real use */ });
    } catch (e) { /* non-fatal */ }
    // The wake chime uses Web Audio, which needs its own unlock — otherwise the
    // very first confirmation after a page load would be silently swallowed.
    if (typeof uiAudio === 'function') uiAudio();
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
        /* Streaming models routinely drop the space between sentences, so
           "…for today.Do oběda…" arrived as ONE chunk and cost 19s of silence
           before the first audio. A terminator followed straight by an
           uppercase letter is a boundary too. The digit guard above already
           protects decimals. */
        if (j < buf.length && /\p{Lu}/u.test(buf.charAt(j))) {
          out.push(buf.slice(start, j)); start = j; i = start; continue;
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

  // An XTTS voice does not need the browser engine at all, so only require
  // `synth` when the browser voice is the one selected.
  function ttsAvailable() { return state.voice !== 'browser' || !!synth; }

  function feedTTS(chunk) {
    if (!ttsAvailable() || state.muted) return;
    ttsBuf += chunk;
    var r = takeSentences(ttsBuf, false);
    ttsBuf = r.rest;
    for (var i = 0; i < r.sentences.length; i++) speakChunk(r.sentences[i]);
  }

  function flushTTS() {
    if (!ttsAvailable() || state.muted) { ttsBuf = ''; return; }
    var r = takeSentences(ttsBuf, true);
    ttsBuf = '';
    for (var i = 0; i < r.sentences.length; i++) speakChunk(r.sentences[i]);
  }

  /* ---- XTTS voice ------------------------------------------------------
     The five studio voices chosen in the Voice Lab, synthesised locally by
     xtts_server.py. Sentences must be spoken in the order they were produced,
     but synthesis is slow and asynchronous, so each one is chained onto the
     previous rather than fired off in parallel. A generation token lets an
     interrupt orphan everything still queued. ---------------------------- */

  var xttsChain = Promise.resolve();
  var xttsToken = 0;
  var xttsAudio = null;

  function speakChunkXtts(text) {
    var token = xttsToken;
    bargeSpoken += ' ' + text;         // self-hearing guard for the barge-in listener
    state.ttsPending++;
    syncOrb();

    var finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      state.ttsPending = Math.max(0, state.ttsPending - 1);
      syncOrb();
      if (state.ttsPending === 0) onAllSpeechDone();
    }

    xttsChain = xttsChain.then(function () {
      if (token !== xttsToken) { finish(); return; }
      return fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, voice: state.voice }),
      })
        .then(function (r) {
          if (!r.ok) {
            return r.json().catch(function () { return {}; }).then(function (j) {
              throw new Error(j.error || ('HTTP ' + r.status));
            });
          }
          // real server-measured synthesis time, straight onto the rail
          var ms = r.headers.get('X-Tts-Ms');
          if (ms) { telemetry.lastSynthMs = Number(ms); updateTelemetry(); }
          return r.blob();
        })
        .then(function (blob) {
          if (token !== xttsToken) { finish(); return; }
          return new Promise(function (resolve) {
            var a = audioEl();                  // the primed element, not a new one
            var url = URL.createObjectURL(blob);
            xttsAudio = a;
            a.onended = function () { URL.revokeObjectURL(url); finish(); resolve(); };
            a.onerror = function () { URL.revokeObjectURL(url); finish(); resolve(); };
            a.src = url;
            var p = a.play();
            if (p && p.catch) {
              p.catch(function (err) {
                // Autoplay refusal used to vanish here, which reads as "the app
                // has no sound". Say it out loud instead.
                URL.revokeObjectURL(url);
                showAlert(
                  err && err.name === 'NotAllowedError'
                    ? 'Prohlížeč zablokoval přehrání zvuku. Klepni kamkoli do stránky a zkus to znovu.'
                    : 'Zvuk se nepodařilo přehrát: ' + (err && err.message ? err.message : '?'),
                );
                finish();
                resolve();
              });
            }
          });
        })
        .catch(function (err) {
          // One failed sentence must not strand the orb or stall the rest.
          showAlert(err && err.message ? err.message : t().errNoTTS);
          finish();
        });
    });
  }

  function speakChunk(text) {
    if (state.muted || !text || !text.trim()) return;
    if (state.voice !== 'browser') {
      // Feedback-loop guard applies to both engines.
      if (state.listening) { state.ttsSuspendedRec = true; stopRecognition(false); }
      return speakChunkXtts(text);
    }
    if (!synth) return;

    // Feedback-loop guard: never let the mic hear our own voice.
    if (state.listening) {
      state.ttsSuspendedRec = true;
      stopRecognition(false);
    }

    bargeSpoken += ' ' + text;         // self-hearing guard for the barge-in listener

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
    bargeSpoken = '';
    if (synth) { try { synth.cancel(); } catch (e) {} }
    // Orphan anything queued or in flight on the XTTS chain, and stop audio now.
    xttsToken++;
    if (xttsAudio) { try { xttsAudio.pause(); } catch (e) {} xttsAudio = null; }
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
      // An interim that never finalised is kept for the user to send or edit —
      // except a command, which clearStaleComposer strips. Left in place it
      // would be adopted as baseText next turn and prepended to the request.
      if (input.classList.contains('is-interim')) clearStaleComposer();
      if (!wasSuspended && !state.resumeVoiceLoop) state.micDesired = false;
    };

    return r;
  }

  /* Clear the composer of things the user did not mean to leave there — but
     never a draft they typed themselves.

     Two ways rubbish accumulates: an interim transcript that never finalised
     (onend keeps those on purpose, so a half-heard sentence is not lost), and a
     command phrase, which is never a message. Either one is then adopted as
     baseText the next time dictation opens and prepended to the real request —
     which is how "ticho" ended up at the start of the following prompt. */
  function clearStaleComposer() {
    input.classList.remove('is-interim');
    // Only ever a command. An unfinalised interim of real speech is worth more
    // than a clean box — "kolik mám dnes" left showing is a half-heard question
    // the user can finish, not rubbish.
    if (window.KaceyClosing && window.KaceyClosing.classify(input.value)) {
      input.value = '';
      baseText = '';
    }
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
    // Only one recogniser may hold the microphone; the barge-in listener has to
    // let go before dictation can take it.
    stopBarge(true);
    cancelSpeech();
    if (!rec) rec = buildRecognition();
    if (!rec) return;
    rec.lang = state.lang;
    /* Whatever is in the composer becomes the prefix of this turn. A command
       must never qualify: it is not a message, and prepending it is exactly the
       bug where "ticho" turned up at the front of the next request. Belt and
       braces — the paths above already clear it, but this is the one line that
       decides, so the guard belongs here too. */
    baseText = input.value.trim();
    if (baseText && window.KaceyClosing && window.KaceyClosing.classify(baseText)) {
      baseText = '';
      input.value = '';
    }
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
     6b. WAKE WORD — "KC" opens dictation

     A SECOND recognition instance, continuous, running only while idle. Two
     SpeechRecognition objects cannot hold the microphone at once, so exactly one
     of {wake, dictation} may run: the supervisor below stops the wake listener
     before dictation starts and brings it back when dictation ends.

     Rather than hooking every state transition (dictation start/stop, TTS,
     tab switch, reconnect), a 1.5s supervisor re-evaluates the conditions. That
     is dull but it cannot get wedged, which matters for something that is
     supposed to be listening whenever you are not.
     ======================================================================= */

  /* Wake confirmation is a SOUND, not words. A spoken or written "I heard you"
     costs a beat of reading and clutters the log; a 160ms chime is understood
     instantly and leaves the log for the actual conversation.

     Synthesised with Web Audio rather than shipped as a file — the page has no
     external assets, and two ramped oscillators are smaller than any encoding of
     them. Ends before dictation starts so it cannot bleed into the recording. */
  var uiCtx = null;

  function uiAudio() {
    if (!uiCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { uiCtx = new AC(); } catch (e) { return null; }
    }
    if (uiCtx.state === 'suspended') { try { uiCtx.resume(); } catch (e) {} }
    return uiCtx;
  }

  var WAKE_CHIME_MS = 170;

  function playWakeChime() {
    // Respect the mute button: it means "be quiet", and the orb already shows
    // the listening state visually for anyone who muted deliberately.
    if (state.muted) return;
    var ctx = uiAudio();
    if (!ctx) return;
    var now = ctx.currentTime;

    // Two short ascending notes (E6 -> B6): reads as a question being accepted,
    // and sits well above speech frequencies so it is never mistaken for a word.
    [[1318.5, 0], [1975.5, 0.075]].forEach(function (pair) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = pair[0];
      var at = now + pair[1];
      // Ramped envelope; a bare start/stop would click.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.14, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.1);
    });
  }

  /* The counterpart to the wake chime: same two notes, descending. Read as a
     matched pair, "we started" and "we finished" need no explanation. */
  function playCloseChime() {
    if (state.muted) return;
    var ctx = uiAudio();
    if (!ctx) return;
    var now = ctx.currentTime;
    [[1975.5, 0], [1318.5, 0.085]].forEach(function (pair) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = pair[0];
      var at = now + pair[1];
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.014);
      // Longer release than the wake chime — a close should fall away, not snap.
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.18);
    });
  }

  /* =======================================================================
     6e. SPOKEN COMMANDS — not messages

     Neither of these is sent to Kacey and neither is logged. They are things
     said TO the interface: a reply to "to je vše, díky" is just one more thing
     to sit through, and the log has to mirror what the model actually saw.

     'end'       after a reply: stop the hands-free loop. The wake word is a
                 separate setting with its own button and is not touched here.
     'interrupt' during a reply: stop talking, stop generating. The conversation
                 stays open, so the microphone re-opens as usual.
     ======================================================================= */

  function endListening() {
    clearStaleComposer();
    state.resumeVoiceLoop = false;
    state.micDesired = false;
    state.ttsSuspendedRec = false;
    stopRecognition(true);
    superviseWake();          // hands the microphone back to the wake listener
    playCloseChime();
    flashHint(t().closed, false, 5000);
    syncOrb();
  }

  /* Barge-in. Unlike endListening this leaves resumeVoiceLoop alone: you said
     "ticho" to stop her talking, not to end the conversation, so the loop
     re-opens the microphone once the cancelled speech has settled. */
  function bargeIn() {
    // Reached from the barge-in listener, which never goes through submit() —
    // so this is the only place that can tidy up after it.
    clearStaleComposer();
    var wasBusy = state.streaming || state.ttsPending > 0;
    cancelSpeech();
    if (state.streaming) transport.send({ type: 'interrupt' });
    endAssistant();
    playCloseChime();
    flashHint(t().silenced, false, 2200);
    syncOrb();
    // cancelSpeech() zeroes ttsPending without firing onAllSpeechDone, so the
    // loop has to be nudged by hand or the microphone never comes back.
    if (state.resumeVoiceLoop || state.micDesired) {
      setTimeout(maybeResumeVoiceLoop, 400);
    }
    return wasBusy;
  }

  /* =======================================================================
     6f. BARGE-IN LISTENER — hearing "ticho" while she is still talking

     The dictation microphone is deliberately closed while Kacey speaks, so
     without this there is no channel an interrupt could arrive through: "ticho"
     would only be heard once she had finished, which is exactly too late.

     So: a THIRD recognition instance, continuous, alive only while a reply is
     actually being spoken. Everything it hears is discarded except the
     interrupt phrases. It cannot fight the other two for the microphone —
     dictation is suspended during TTS and the wake listener stands down on
     ttsPending > 0, which is precisely when this one runs.

     Two costs, stated rather than buried:
     - It uses the CLOUD recogniser, so audio leaves the machine while she is
       speaking. That is the cost the local wake word was built to avoid, and it
       is why this is scoped to the seconds she is talking and nothing more.
     - It hears her through the speakers. Echo cancellation helps; the guard
       below is what stops her from interrupting herself when the reply happens
       to contain the word.
     ======================================================================= */

  var bargeAvailable = true;      // cleared for good if the microphone is refused
  var bargeRec = null;
  var bargeRunning = false;
  var bargeBackoffUntil = 0;
  var bargeSpoken = '';           // text of the reply being spoken, for the guard
  var bargeHits = 0;

  function bargeShouldRun() {
    if (!bargeAvailable || !recognitionAvailable()) return false;
    if (state.listening || state.micDesired) return false;   // dictation owns the mic
    if (document.hidden || state.conn !== 'online') return false;
    if (Date.now() < bargeBackoffUntil) return false;
    // Only while she is actually speaking. Muted replies have no voice to cut
    // off, and the stop button already covers stopping generation.
    return state.ttsPending > 0;
  }

  function buildBarge() {
    if (!SR) return null;
    var r = new SR();
    r.lang = state.lang;
    r.continuous = true;
    r.interimResults = true;      // interim fires sooner, and "asap" is the point
    r.maxAlternatives = 1;

    r.onstart = function () { bargeRunning = true; };

    r.onresult = function (ev) {
      var heard = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var alt = ev.results[i][0];
        if (alt) heard += ' ' + alt.transcript;
      }
      if (!heard.trim() || !window.KaceyClosing) return;
      if (window.KaceyClosing.classify(heard) !== 'interrupt') return;
      // She is saying the word herself — that is the loudspeaker, not the room.
      if (window.KaceyClosing.mentionsInterrupt(bargeSpoken)) return;

      bargeHits++;
      stopBarge(true);
      bargeIn();
    };

    r.onerror = function (ev) {
      var code = (ev && ev.error) || 'unknown';
      if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') {
        bargeAvailable = false;              // the microphone is refused; stop asking
        return;
      }
      bargeBackoffUntil = Date.now() + (code === 'network' ? 15000 : 700);
    };

    r.onend = function () { bargeRunning = false; };
    return r;
  }

  function startBarge() {
    if (bargeRunning || !bargeShouldRun()) return;
    if (!bargeRec) bargeRec = buildBarge();
    if (!bargeRec) return;
    bargeRec.lang = state.lang;
    try {
      bargeRec.start();
      bargeRunning = true;
    } catch (e) {
      try { bargeRec.abort(); } catch (e2) {}
      bargeRec = buildBarge();
      bargeRunning = false;
      // Short: the whole window this has to live in is a few seconds long.
      bargeBackoffUntil = Date.now() + 250;
    }
  }

  function stopBarge(hard) {
    if (!bargeRec) { bargeRunning = false; return; }
    try { hard ? bargeRec.abort() : bargeRec.stop(); } catch (e) {}
    bargeRunning = false;
  }

  function superviseBarge() {
    if (bargeShouldRun()) {
      /* The local wake engine holds the microphone through getUserMedia, and its
         own supervisor only runs every 1.5s — far too slow to have let go by the
         time a reply starts. Release it here rather than racing it. */
      if (VW && VW.running()) VW.stop();
      startBarge();
    } else if (bargeRunning) {
      stopBarge(true);
    }
  }

  var WAKE_ENABLED_DEFAULT = true;
  var wakeRec = null;
  var wakeRunning = false;
  var wakeEnabled = WAKE_ENABLED_DEFAULT;
  var wakeBlocked = false;      // permission/hardware refusal — stop retrying
  var wakeBackoffUntil = 0;
  var wakeHits = 0;

  /* Czech ASR spells "KC" a dozen ways: KC, káčé, kács, káca, Kejsí, Kacey…
     Compare on a stripped form (lowercase, no diacritics, letters only) and match
     whole words, so "kdyby" or "akce" cannot trigger it.

     Entries must be lowercase and diacritic-free — normalizeHeard() strips both,
     so an entry like 'KC' or 'Casey' could never match anything.

     This list is the FALLBACK path. Chasing spellings cannot be made reliable
     for a two-syllable non-word; the voice-template detector in 6c is the real
     answer and takes over as soon as it has recordings to compare against. */
  var WAKE_WORDS = [
    'kc', 'kace', 'kacee', 'kacey', 'kaca', 'kaci', 'kacka', 'kacko',
    'kejsi', 'kejsy', 'kejs', 'kejsej', 'kaces', 'kacs', 'casey', 'kejsis'
  ];

  function normalizeHeard(s) {
    var out = String(s || '').toLowerCase();
    if (out.normalize) out = out.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return out.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function isWakePhrase(heard) {
    var n = normalizeHeard(heard);
    if (!n) return false;
    var words = n.split(' ');
    for (var i = 0; i < words.length; i++) {
      if (WAKE_WORDS.indexOf(words[i]) !== -1) return true;
    }
    // "k c" said as two letters
    return /(^|\s)k\s?c(\s|$)/.test(n);
  }

  function wakeShouldRun() {
    return wakeEnabled && !wakeBlocked && recognitionAvailable() &&
      !state.listening && !state.micDesired &&
      state.ttsPending === 0 &&            // never let it hear Kacey's own voice
      !document.hidden &&
      state.conn === 'online' &&
      Date.now() >= wakeBackoffUntil;
  }

  function buildWake() {
    if (!SR) return null;
    var r = new SR();
    r.lang = state.lang;
    r.continuous = true;         // keep listening; the engine still stops on its own
    r.interimResults = true;     // interim fires sooner, so the trigger feels instant
    r.maxAlternatives = 1;

    r.onstart = function () { wakeRunning = true; };

    r.onresult = function (ev) {
      var heard = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var alt = ev.results[i][0];
        if (alt) heard += ' ' + alt.transcript;
      }
      if (!heard.trim() || !isWakePhrase(heard)) return;

      wakeHits++;
      stopWake(true);
      // Hand the microphone over. micDesired keeps the supervisor from
      // immediately restarting the wake listener underneath dictation.
      state.micDesired = true;
      primeTTS();
      playWakeChime();
      // Wait out the chime as well as the engine release, so the confirmation
      // tone is not sitting inside the first moment of the recording.
      setTimeout(startRecognition, WAKE_CHIME_MS + 60);
    };

    r.onerror = function (ev) {
      var code = (ev && ev.error) || 'unknown';
      if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') {
        wakeBlocked = true;                  // the mic itself is refused; stop asking
        applyWakeUI();
        return;
      }
      // no-speech and aborted are normal for an idle listener; network deserves a
      // pause so a flaky connection does not become a request storm.
      if (code === 'network') wakeBackoffUntil = Date.now() + 15000;
      else wakeBackoffUntil = Date.now() + 800;
    };

    r.onend = function () { wakeRunning = false; };
    return r;
  }

  function startWake() {
    if (wakeRunning || !wakeShouldRun()) return;
    if (!wakeRec) wakeRec = buildWake();
    if (!wakeRec) return;
    wakeRec.lang = state.lang;
    try {
      wakeRec.start();
      wakeRunning = true;
    } catch (e) {
      // InvalidStateError — engine winding down. Rebuild and let the supervisor retry.
      try { wakeRec.abort(); } catch (e2) {}
      wakeRec = buildWake();
      wakeRunning = false;
      wakeBackoffUntil = Date.now() + 600;
    }
  }

  function stopWake(hard) {
    if (!wakeRec) { wakeRunning = false; return; }
    try { hard ? wakeRec.abort() : wakeRec.stop(); } catch (e) {}
    wakeRunning = false;
  }

  /* Exactly one detector may hold the microphone. The voice-template detector
     wins whenever it is usable; the transcript path stays as the fallback for a
     browser without AudioWorklet, or before anything has been enrolled. */
  function superviseWake() {
    if (voiceWakePriority()) {
      if (wakeRunning) stopWake(true);
      voiceWakeSupervise();
      return;
    }
    voiceWakeStop();
    if (wakeShouldRun()) startWake();
    else if (wakeRunning) stopWake(true);
  }

  function applyWakeUI() {
    if (!wakeBtn) return;
    var on = wakeEnabled && !wakeBlocked;
    wakeBtn.setAttribute('aria-pressed', String(on));
    var label = wakeBlocked ? t().wakeBlocked
      : !on ? t().wakeOff
      : voiceWakeActive() ? t().wakeOnVoice : t().wakeOn;
    wakeBtn.setAttribute('aria-label', label);
    wakeBtn.title = label + ' · ' + t().wakeCfgHint;
    wakeBtn.disabled = !SR || wakeBlocked;
    if (vwState) vwState.textContent = voiceStateLabel();
  }

  function toggleWake() {
    if (wakeBlocked) return;
    wakeEnabled = !wakeEnabled;
    try { localStorage.setItem(LS_WAKE, wakeEnabled ? '1' : '0'); } catch (e) {}
    applyWakeUI();
    if (!wakeEnabled) stopWake(true);
    else { wakeBackoffUntil = 0; superviseWake(); }
    flashHint(wakeEnabled ? t().wakeOn : t().wakeOff, false, 2200);
  }

  /* =======================================================================
     6c. WAKE WORD BY VOICE — matching the sound, not the transcript

     The transcript path above asks a Czech recogniser to spell a two-syllable
     non-word, then guesses at the spellings it might produce. That is a losing
     game: there is no correct spelling, so the answer changes between takes and
     the list can only chase the last one.

     This path compares the SOUND against recordings of one particular person
     saying it — see wake-voice.js for the DSP. It is speaker-dependent, which
     is exactly what a personal wake word wants, and it needs no network.

     Three things this buys beyond consistency:
       - no audio leaves the machine (the transcript path streamed the room to a
         cloud recogniser all day long),
       - no restart churn from the recogniser timing itself out,
       - it works while offline.

     The transcript path stays for browsers with no AudioWorklet and as the
     behaviour before anything is enrolled.
     ======================================================================= */

  var VW = window.KaceyWakeVoice || null;
  var wakeMode = 'voice';        // preference; falls back on its own if unusable
  var voiceHits = 0;
  var voiceFailUntil = 0;        // after a mic failure, stop hammering the device
  var vwPanelOpen = false;

  var vwPanel = $('vwPanel'), vwOpenBtn = $('vwOpen'), vwCloseBtn = $('vwClose');
  var vwState = $('vwState'), vwList = $('vwList'), vwRecBtn = $('vwRec');
  var vwRecNote = $('vwRecNote'), vwFill = $('vwFill'), vwScore = $('vwScore');
  var vwSens = $('vwSens'), vwSensVal = $('vwSensVal'), vwClearBtn = $('vwClear');
  var vwLevel = $('vwLevel'), vwModeVoice = $('vwModeVoice'), vwModeAsr = $('vwModeAsr');
  var vwSpread = $('vwSpread');

  function voiceWakeUsable() { return !!(VW && VW.supported()); }
  function voiceWakeReady() { return voiceWakeUsable() && VW.enrolled(); }

  /* Which detector the supervisor should run. The panel forces the voice engine
     on even with nothing enrolled — otherwise you could never record the first
     sample, because the transcript listener would be holding the microphone. */
  function voiceWakePriority() {
    if (!voiceWakeUsable()) return false;
    return vwPanelOpen || (wakeMode === 'voice' && VW.enrolled());
  }

  function voiceWakeActive() { return wakeMode === 'voice' && voiceWakeReady(); }

  function voiceShouldRun() {
    if (!voiceWakeUsable() || Date.now() < voiceFailUntil) return false;
    // Never while Kacey is speaking: echo cancellation helps but does not make
    // her own voice inaudible to her own detector.
    if (state.ttsPending > 0 || document.hidden) return false;
    if (vwPanelOpen) return true;                 // tuning needs it live
    if (!wakeEnabled || wakeBlocked) return false;
    if (state.listening || state.micDesired) return false;
    return VW.enrolled() && state.conn === 'online';
  }

  function voiceWakeSupervise() {
    if (voiceShouldRun()) {
      if (!VW.running()) {
        VW.start().catch(function (err) { onVoiceWakeError(err); });
      }
    } else if (VW.running()) {
      VW.stop();
    }
  }

  function voiceWakeStop() { if (VW && VW.running()) VW.stop(); }

  function onVoiceWakeError(err) {
    var name = (err && err.name) || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      // Same microphone, same refusal — the transcript path cannot work either.
      wakeBlocked = true;
      // Back off even so: with the panel open the supervisor ignores wakeBlocked
      // (you must be able to enrol), which would otherwise retry every 1.5s
      // forever. 30s still picks the grant up soon after it happens.
      voiceFailUntil = Date.now() + 30000;
      applyWakeUI();
      if (vwPanelOpen) vwRecNote.textContent = 'mikrofon zamítnut';
      return;
    }
    if (name === 'NotFoundError' || name === 'NotReadableError') {
      voiceFailUntil = Date.now() + 30000;
      if (vwPanelOpen) vwRecNote.textContent = 'mikrofon není dostupný';
      return;
    }
    voiceFailUntil = Date.now() + 5000;
    if (vwPanelOpen) vwRecNote.textContent = 'zvuk se nepodařilo spustit';
  }

  function onVoiceDetect(info) {
    voiceHits++;
    // With the panel open this is a test bench, not a trigger: showing the score
    // is the whole point, and starting dictation would fight the tuning.
    if (vwPanelOpen) { flashVwHit(info); return; }

    voiceWakeStop();                    // release the device before recognition
    state.micDesired = true;
    primeTTS();
    playWakeChime();
    setTimeout(startRecognition, WAKE_CHIME_MS + 60);
  }

  function voiceStateLabel() {
    if (!voiceWakeUsable()) return 'nepodporováno';
    var n = VW.count();
    if (!VW.enrolled()) return n ? n + '/' + VW.minSamples + ' vzorků' : 'nenastaveno';
    return wakeMode === 'voice' ? n + ' vzorků · aktivní' : n + ' vzorků · vypnuto';
  }

  /* ---- panel ----------------------------------------------------------- */

  /* Distances from the most recent live attempt, one per sample. This is the
     answer to "why did it not match": a sample that never comes close is dead
     weight, and you can hear it and delete it instead of guessing. */
  var vwLastPer = null;

  function renderVwList() {
    if (!vwList) return;
    vwList.innerHTML = '';
    var stats = VW ? VW.sampleStats() : [];
    var thr = VW ? VW.threshold() : 0;

    stats.forEach(function (s, i) {
      var li = document.createElement('li');
      li.className = 'vw__item';

      var play = document.createElement('button');
      play.type = 'button';
      play.className = 'vw__play';
      play.textContent = '▶';
      if (!s.audio) {
        play.disabled = true;
        play.title = 'Tento vzorek je z dřívější verze a zvuk k němu není. Nahraj ho znovu.';
      } else {
        play.title = 'Přehrát vzorek ' + (i + 1);
      }
      play.setAttribute('aria-label', 'Přehrát vzorek ' + (i + 1));
      play.addEventListener('click', function () {
        if (play.disabled) return;
        li.setAttribute('data-playing', 'true');
        play.textContent = '■';
        VW.playSample(i).catch(function () {}).then(function () {
          li.removeAttribute('data-playing');
          play.textContent = '▶';
        });
      });

      var name = document.createElement('span');
      name.className = 'vw__itemName';
      name.textContent = String(i + 1) + '.';

      var len = document.createElement('span');
      len.className = 'vw__itemLen';
      len.textContent = (s.ms / 1000).toFixed(2) + ' s';

      // live distance from the last attempt
      var live = document.createElement('span');
      live.className = 'vw__itemLive';
      var lv = vwLastPer && vwLastPer.length > i ? vwLastPer[i] : undefined;
      if (lv === undefined) live.textContent = '';
      else if (lv === null) live.textContent = '·';        // gated out on length
      else {
        live.textContent = lv.toFixed(2);
        live.setAttribute('data-match', String(thr > 0 && lv <= thr));
      }

      var fit = document.createElement('span');
      fit.className = 'vw__itemFit';
      if (s.nearest == null) fit.textContent = '—';
      else {
        fit.textContent = s.nearest.toFixed(2);
        // A sample further from its neighbours than the threshold is an outlier:
        // said differently, clipped, or with a cough in it. Worth re-recording.
        if (thr && s.nearest > thr) fit.setAttribute('data-outlier', 'true');
      }

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'vw__del';
      del.textContent = '×';
      del.setAttribute('aria-label', 'Smazat vzorek ' + (i + 1));
      del.addEventListener('click', function () {
        VW.removeSample(i);
        vwLastPer = null;                 // indices no longer line up
        renderVwList();
        applyWakeUI();
      });

      li.appendChild(play); li.appendChild(name); li.appendChild(len);
      li.appendChild(live); li.appendChild(fit); li.appendChild(del);
      vwList.appendChild(li);
    });

    if (!stats.length) {
      var empty = document.createElement('li');
      empty.className = 'vw__empty';
      empty.textContent = 'žádné vzorky';
      vwList.appendChild(empty);
    }

    if (vwSpread) {
      var sp = VW ? VW.spread() : null;
      vwSpread.textContent = sp
        ? 'rozptyl vzorků ' + sp.mean.toFixed(2) + ' ±' + sp.sd.toFixed(2) +
          ' · práh ' + thr.toFixed(2)
        : 'práh se spočítá ze tří a více vzorků';
    }
    if (vwRecBtn) {
      vwRecBtn.disabled = !VW || VW.count() >= VW.maxSamples;
    }
    applyVwModeUI();
  }

  function applyVwModeUI() {
    if (!vwModeVoice || !vwModeAsr) return;
    var canVoice = voiceWakeReady();
    vwModeVoice.setAttribute('aria-pressed', String(wakeMode === 'voice'));
    vwModeAsr.setAttribute('aria-pressed', String(wakeMode !== 'voice'));
    vwModeVoice.disabled = !canVoice;
    vwModeVoice.title = canVoice
      ? 'Porovnává zvuk s tvými nahrávkami — offline'
      : 'Nahraj nejdřív ' + (VW ? VW.minSamples : 3) + ' vzorky';
  }

  function setWakeMode(mode) {
    wakeMode = mode === 'voice' ? 'voice' : 'asr';
    try { localStorage.setItem(LS_WAKE_MODE, wakeMode); } catch (e) {}
    applyVwModeUI();
    applyWakeUI();
    superviseWake();
  }

  function flashVwHit(info) {
    if (!vwScore) return;
    vwScore.setAttribute('data-hit', 'true');
    setTimeout(function () { vwScore.removeAttribute('data-hit'); }, 500);
    if (!state.muted) playWakeChime();      // hear what a match feels like
  }

  function showScore(info) {
    if (!vwPanelOpen || !vwFill || !vwScore) return;
    if (info.perTemplate) { vwLastPer = info.perTemplate; renderVwList(); }
    var thr = info.threshold || (VW ? VW.threshold() : 0);
    if (!thr) {
      vwScore.textContent = 'nejdřív nahraj vzorky';
      vwFill.style.width = '0%';
      return;
    }
    // Distance bar with the threshold pinned at the halfway mark: below half is
    // a match. Showing the raw number too, because that is what you tune on.
    var frac = isFinite(info.score) ? Math.min(1, info.score / (thr * 2)) : 1;
    vwFill.style.width = (frac * 100).toFixed(1) + '%';
    vwFill.setAttribute('data-hit', String(!!info.hit));
    // Infinity is not "no reading" — it is the matcher giving up early because
    // the distance already ran far past the threshold. Say that, so a near miss
    // (a real number) is distinguishable from something else entirely.
    vwScore.textContent = (isFinite(info.score) ? info.score.toFixed(2) : 'mimo rozsah') +
      ' / práh ' + thr.toFixed(2) + ' · ' + (info.ms / 1000).toFixed(2) + ' s' +
      (info.hit ? ' ✓' : '');
  }

  function openVoicePanel(open) {
    if (!vwPanel) return;
    vwPanelOpen = !!open;
    vwPanel.hidden = !open;
    if (vwOpenBtn) vwOpenBtn.setAttribute('aria-expanded', String(!!open));

    if (open) {
      if (vwSens && VW) { vwSens.value = String(VW.sensitivity()); updateSensLabel(); }
      vwLastPer = null;                  // stale numbers from a previous session
      renderVwList();
      if (vwScore) vwScore.textContent = 'řekni „KC“ a sleduj skóre';
      if (vwFill) vwFill.style.width = '0%';
      if (vwRecNote) vwRecNote.textContent = '';
    } else {
      if (VW) VW.cancelCapture();
      if (vwLevel) vwLevel.style.setProperty('--lvl', '0');
    }
    superviseWake();       // panel open holds the engine on; closing lets it go
    applyWakeUI();
  }

  /* Show the multiplier next to the number: "70" means nothing on its own, but
     "70 · 1.36x" says plainly that the threshold has been loosened by a third. */
  function updateSensLabel() {
    if (!vwSensVal || !VW) return;
    var s = VW.sensitivity();
    var f = s <= 50 ? 0.80 + 0.004 * s : 1 + 0.018 * (s - 50);
    vwSensVal.textContent = s + ' · ' + f.toFixed(2) + '×';
  }

  /* Dead time after the button press. A mouse click or a screen tap is a sharp
     transient — the speech detector opens on it, closes 220 ms later, and the
     "sample" you just stored is the sound of the button. Every comparison after
     that is then made against a click, which is exactly as unreliable as it
     sounds. The note tells you to wait rather than letting you speak into it. */
  var VW_ARM_MS = 350;

  function recordSample() {
    if (!VW || !vwRecNote) return;
    vwRecBtn.disabled = true;
    vwRecNote.textContent = 'spouštím mikrofon…';

    VW.start().then(function () {
      VW.deafen(VW_ARM_MS);
      vwRecNote.textContent = 'chvilku…';
      setTimeout(function () {
        if (vwPanelOpen && vwRecBtn.disabled) vwRecNote.textContent = 'řekni „KC“';
      }, VW_ARM_MS);
      // Give the full listening window on top of the dead time, not inside it.
      return VW.captureOne(7000 + VW_ARM_MS);
    }).then(function (sample) {
      if (!VW.addSample(sample)) {
        vwRecNote.textContent = 'víc vzorků se už nevejde';
      } else {
        var n = VW.count();
        vwRecNote.textContent = n < VW.minSamples
          ? 'uloženo · ještě ' + (VW.minSamples - n)
          : 'uloženo (' + n + ')';
      }
      renderVwList();
      applyWakeUI();
    }).catch(function (err) {
      if (err && err.message === 'timeout') vwRecNote.textContent = 'nic jsem neslyšela';
      else if (err && err.message === 'cancelled') vwRecNote.textContent = '';
      else onVoiceWakeError(err);
      renderVwList();
    }).then(function () {
      if (vwRecBtn && VW) vwRecBtn.disabled = VW.count() >= VW.maxSamples;
    });
  }

  if (VW) {
    VW.onDetect(onVoiceDetect);
    VW.onScore(showScore);
    VW.onLevel(function (v) {
      if (vwPanelOpen && vwLevel) vwLevel.style.setProperty('--lvl', v.toFixed(3));
    });

    try {
      var savedMode = localStorage.getItem(LS_WAKE_MODE);
      if (savedMode === 'asr' || savedMode === 'voice') wakeMode = savedMode;
    } catch (e) { /* private mode */ }
  }

  if (vwOpenBtn) vwOpenBtn.addEventListener('click', function () { openVoicePanel(true); });
  if (vwCloseBtn) vwCloseBtn.addEventListener('click', function () { openVoicePanel(false); });
  if (vwPanel) {
    vwPanel.addEventListener('click', function (ev) {
      if (ev.target === vwPanel) openVoicePanel(false);
    });
  }
  if (vwRecBtn) vwRecBtn.addEventListener('click', recordSample);
  if (vwClearBtn) {
    vwClearBtn.addEventListener('click', function () {
      if (!VW) return;
      VW.clearSamples();
      setWakeMode('asr');            // nothing left to match against
      renderVwList();
      applyWakeUI();
    });
  }
  if (vwSens) {
    vwSens.addEventListener('input', function () {
      if (!VW) return;
      VW.setSensitivity(Number(vwSens.value));
      updateSensLabel();
      renderVwList();
    });
  }
  if (vwModeVoice) vwModeVoice.addEventListener('click', function () { setWakeMode('voice'); });
  if (vwModeAsr) vwModeAsr.addEventListener('click', function () { setWakeMode('asr'); });

  /* Long-press the wake button to reach the voiceprint. A sixth icon in the
     top bar would crowd it, and the panel is also reachable from Settings. */
  if (wakeBtn) {
    var lpTimer = 0, lpFired = false;
    wakeBtn.addEventListener('pointerdown', function () {
      lpFired = false;
      clearTimeout(lpTimer);
      lpTimer = setTimeout(function () { lpFired = true; openVoicePanel(true); }, 550);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (evName) {
      wakeBtn.addEventListener(evName, function () { clearTimeout(lpTimer); });
    });
    // Registered before the boot wiring adds toggleWake, so this can cancel it.
    wakeBtn.addEventListener('click', function (ev) {
      if (!lpFired) return;
      lpFired = false;
      ev.preventDefault();
      ev.stopImmediatePropagation();
    });
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && vwPanel && !vwPanel.hidden) {
      openVoicePanel(false);
      ev.stopImmediatePropagation();
      ev.preventDefault();
    }
  }, true);

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
  var preambleDone = false;   // has this turn already split off its opening line?

  /* ---- telemetry rails --------------------------------------------------
     Every field is real application state. Nothing here is simulated: a HUD
     full of invented gauges would make the genuine readings untrustworthy,
     which is the opposite of what an instrument panel is for. -------------- */

  var tm = {
    state: $('tmState'), model: $('tmModel'), mcp: $('tmMcp'), session: $('tmSession'),
    turns: $('tmTurns'), tool: $('tmTool'), toolCount: $('tmToolCount'),
    voice: $('tmVoice'), lang: $('tmLang'), tts: $('tmTts'), synth: $('tmSynth'),
  };
  var telemetry = { turns: 0, toolCalls: 0, lastTool: '—', lastSynthMs: null, mcp: '—' };

  function setTm(el, value, flag) {
    if (!el) return;
    el.textContent = value;
    if (flag === 'warn') el.setAttribute('data-warn', '1');
    else el.removeAttribute('data-warn');
    if (flag === 'bad') el.setAttribute('data-bad', '1');
    else el.removeAttribute('data-bad');
  }

  function updateTelemetry() {
    setTm(tm.state, orbState.toUpperCase(),
      orbState === 'offline' || orbState === 'error' ? 'bad' : null);
    setTm(tm.mcp, telemetry.mcp, telemetry.mcp === 'connected' ? null : 'warn');
    setTm(tm.session, state.sessionId ? state.sessionId.slice(0, 8) : '—');
    setTm(tm.turns, String(telemetry.turns));
    setTm(tm.tool, telemetry.lastTool);
    setTm(tm.toolCount, String(telemetry.toolCalls));
    setTm(tm.voice, state.voice === 'browser' ? 'BROWSER' : state.voice);
    setTm(tm.lang, state.lang);
    setTm(tm.tts, String(state.ttsPending), state.ttsPending > 0 ? 'warn' : null);
    setTm(tm.synth, telemetry.lastSynthMs === null ? '—' : telemetry.lastSynthMs + ' ms');
  }

  function onServer(msg) {
    switch (msg.type) {
      case 'ready':
        readyInfo = t().readyInfo(
          typeof msg.model === 'string' ? msg.model : '?',
          Array.isArray(msg.mcpServers) ? msg.mcpServers.filter(function (s) { return typeof s === 'string'; }) : []
        );
        connLabel.textContent = t().online;
        conn.title = readyInfo;
        setTm(tm.model, typeof msg.model === 'string' ? msg.model : '?');
        telemetry.mcp = (Array.isArray(msg.mcpServers) && msg.mcpServers.length)
          ? 'connected' : 'none';
        updateTelemetry();
        flashHint(readyInfo, false, 4200);
        break;

      case 'session':
        state.sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
        if (state.sessionId) conn.title = readyInfo + ' · ' + state.sessionId;
        updateTelemetry();
        break;

      case 'thinking':
        state.streaming = true;
        preambleDone = false;          // a fresh turn may open with its own line
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
        if (msg.phase === 'start') {
          // Only the FIRST tool of a turn splits the bubble. toolDepth returns
          // to 0 after every tool, so it cannot be used for this — a second
          // lookup would chop the answer itself into fragments.
          if (!preambleDone) { preambleDone = true; sealPreamble(); }
          toolDepth++;
          telemetry.toolCalls++;
          telemetry.lastTool = String(msg.name || '—');
          updateTelemetry();
          flashHint(t().tool(String(msg.name || '')), true, 12000);
        }
        else {
          toolDepth = Math.max(0, toolDepth - 1);
          if (!toolDepth) { hintLocked = false; clearTimeout(hintTimer); syncOrb(); }
          // She writes the calendar through conversation, so an open viewer must
          // pick that up rather than sit on stale rows.
          if (/calendar/i.test(String(msg.name || '')) && window.kaceyCalendarRefresh) {
            window.kaceyCalendarRefresh();
          }
        }
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

    /* Commands are intercepted here — before the transport, before the log,
       before telemetry — so nothing about them reaches Kacey or the transcript.
       Checked on the typed path too, so the composer accepts them as well. */
    var cmd = window.KaceyClosing ? window.KaceyClosing.classify(msg) : null;
    if (cmd) {
      // The command IS the composer's contents here, so clear it outright.
      input.value = '';
      baseText = '';
      input.classList.remove('is-interim');
      if (cmd === 'interrupt') bargeIn();
      else endListening();
      return;
    }

    cancelSpeech();                       // a new message always silences the old answer

    if (state.streaming) {
      transport.send({ type: 'interrupt' });
      endAssistant(true);
    }

    if (!transport.isOpen()) {
      showAlert(t().errOfflineSend);
      return;
    }

    telemetry.turns++;
    updateTelemetry();

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
    if (!synth && state.voice === 'browser') {
      muteBtn.disabled = true; muteBtn.title = s.errNoTTS; muteBtn.setAttribute('aria-label', s.errNoTTS);
    } else {
      muteBtn.disabled = false;
    }
  }

  /* =======================================================================
     THEME — one hue drives the whole interface
     ======================================================================= */

  var LS_HUE = 'kacey.hue';
  var DEFAULT_HUE = 193;
  var hue = DEFAULT_HUE;

  var hueRing = $('hueRing'), hueKnob = $('hueKnob'), hueValue = $('hueValue');
  var sheet = $('settingsPanel'), settingsBtn = $('settings'), settingsClose = $('settingsClose');

  /* The alert hue sits opposite the chosen one. If the user picks a hue close
     to the default red-family alert, that would make errors look like ordinary
     readings — so it is pushed to the far side instead. */
  function dangerHueFor(h) {
    var preferred = 352;                       // red reads as "alert" everywhere
    var d = Math.abs(h - preferred);
    d = Math.min(d, 360 - d);                  // shortest way round the wheel
    // Keep red unless the chosen hue is itself red-adjacent, in which case an
    // alert would be indistinguishable from every other reading.
    return d < 45 ? (h + 165) % 360 : preferred;
  }

  function applyHue(h, persist) {
    hue = ((Math.round(h) % 360) + 360) % 360;
    var root = document.documentElement;
    root.style.setProperty('--h', String(hue));
    root.style.setProperty('--h-danger', String(dangerHueFor(hue)));

    if (hueKnob) hueKnob.style.transform = 'rotate(' + hue + 'deg) translateY(-75px)';
    if (hueValue) hueValue.textContent = String(hue);
    if (hueRing) {
      hueRing.setAttribute('aria-valuenow', String(hue));
      hueRing.setAttribute('aria-valuetext', 'odstín ' + hue);
    }
    Array.prototype.forEach.call(document.querySelectorAll('.preset'), function (b) {
      if (Number(b.dataset.h) === hue) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });
    // keep the browser UI (address bar on mobile) in step with the theme
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', 'hsl(' + hue + ' 62% 3%)');

    if (persist) { try { localStorage.setItem(LS_HUE, String(hue)); } catch (e) {} }
  }

  /* The knob sits at translateY(-75px) after rotate(hue), i.e. hue 0 points up.
     Convert a pointer position to the same convention. */
  function angleFromEvent(ev) {
    var r = hueRing.getBoundingClientRect();
    var dx = ev.clientX - (r.left + r.width / 2);
    var dy = ev.clientY - (r.top + r.height / 2);
    return (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  }

  if (hueRing) {
    var dragging = false;

    hueRing.addEventListener('pointerdown', function (ev) {
      dragging = true;
      hueRing.setPointerCapture(ev.pointerId);
      applyHue(angleFromEvent(ev), false);
      ev.preventDefault();
    });
    hueRing.addEventListener('pointermove', function (ev) {
      if (dragging) applyHue(angleFromEvent(ev), false);
    });
    hueRing.addEventListener('pointerup', function (ev) {
      if (!dragging) return;
      dragging = false;
      try { hueRing.releasePointerCapture(ev.pointerId); } catch (e) {}
      applyHue(hue, true);                       // commit once, not on every move
    });
    hueRing.addEventListener('pointercancel', function () {
      dragging = false; applyHue(hue, true);
    });

    hueRing.addEventListener('keydown', function (ev) {
      var step = ev.shiftKey ? 10 : 1;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') { applyHue(hue + step, true); ev.preventDefault(); }
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') { applyHue(hue - step, true); ev.preventDefault(); }
      else if (ev.key === 'Home') { applyHue(DEFAULT_HUE, true); ev.preventDefault(); }
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.preset'), function (b) {
    b.addEventListener('click', function () { applyHue(Number(b.dataset.h), true); });
  });

  function openSettings(open) {
    if (!sheet) return;
    sheet.hidden = !open;
    settingsBtn.setAttribute('aria-expanded', String(open));
    if (open && hueRing) hueRing.focus();
    else if (settingsBtn) settingsBtn.focus();
  }

  if (settingsBtn) settingsBtn.addEventListener('click', function () { openSettings(sheet.hidden); });
  if (settingsClose) settingsClose.addEventListener('click', function () { openSettings(false); });
  if (sheet) {
    sheet.addEventListener('click', function (ev) {
      if (ev.target === sheet) openSettings(false);        // click the backdrop
    });
  }
  /* Capture phase: Escape must close the panel instead of reaching the
     interrupt handler registered earlier on document. */
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && sheet && !sheet.hidden) {
      openSettings(false);
      ev.stopImmediatePropagation();
      ev.preventDefault();
    }
  }, true);

  try {
    var savedHue = parseInt(localStorage.getItem(LS_HUE), 10);
    if (!isNaN(savedHue)) hue = savedHue;
  } catch (e) { /* private mode */ }
  // ?hue=<0-359> overrides for this load only — handy for screenshots and for
  // sharing a look without touching someone else's saved preference.
  var hueParam = /[?&]hue=(\d{1,3})/.exec(location.search);
  if (hueParam) hue = Number(hueParam[1]);
  applyHue(hue, false);
  // ?openSettings=1 opens the dial on load, so a headless browser can capture it.
  if (/[?&]openSettings=1/.test(location.search)) openSettings(true);

  /* restore persisted preferences */
  try {
    var savedLang = localStorage.getItem(LS_LANG);
    if (savedLang && LANGS.indexOf(savedLang) !== -1) state.lang = savedLang;
    state.muted = localStorage.getItem(LS_MUTED) === '1';
    var savedWake = localStorage.getItem(LS_WAKE);
    if (savedWake !== null) wakeEnabled = savedWake === '1';
    var savedVoice = localStorage.getItem(LS_VOICE);
    if (savedVoice) state.voice = savedVoice;
  } catch (e) { /* private mode: defaults are fine */ }

  /* Voice picker. The XTTS voices come from the server; the browser engine is
     always offered as the fast fallback, and becomes the only option when the
     local XTTS server is not running. */
  function buildVoicePicker() {
    return fetch('/api/voices')
      .then(function (r) { return r.json(); })
      .then(function (info) {
        voiceSel.innerHTML = '';
        if (info.xtts) {
          (info.voices || []).forEach(function (v) {
            var o = document.createElement('option');
            o.value = v.id;
            o.textContent = v.label + (v.preferred ? ' ★' : '');
            voiceSel.appendChild(o);
          });
        }
        var b = document.createElement('option');
        b.value = 'browser';
        b.textContent = synth ? 'Prohlížeč (rychlé)' : 'Prohlížeč (nedostupné)';
        b.disabled = !synth;
        voiceSel.appendChild(b);

        var ids = Array.prototype.map.call(voiceSel.options, function (o) { return o.value; });
        if (ids.indexOf(state.voice) === -1) {
          // saved voice is gone (XTTS server down) — fall back rather than break
          state.voice = info.xtts ? (info.defaultVoice || ids[0]) : 'browser';
        }
        voiceSel.value = state.voice;
        if (!info.xtts) {
          voiceSel.title = 'Hlasový server neběží (npm run xtts) — jen prohlížečový hlas.';
        }
        applyMuteToUI();
      })
      .catch(function () {
        voiceSel.innerHTML = '<option value="browser">Prohlížeč</option>';
        state.voice = 'browser';
      });
  }

  voiceSel.addEventListener('change', function () {
    cancelSpeech();                     // never let the old voice finish the sentence
    state.voice = voiceSel.value;
    try { localStorage.setItem(LS_VOICE, state.voice); } catch (e) {}
    applyMuteToUI();
  });

  buildVoicePicker();

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    submit(input.value);
  });

  input.addEventListener('input', function () {
    input.classList.remove('is-interim');
    state.resumeVoiceLoop = false;      // typing opts out of the hands-free loop
  });

  sendBtn.addEventListener('click', primeTTS);
  // Any first interaction counts — tapping the orb or the page is enough, so a
  // voice-only user who never touches the send button still gets audio unlocked.
  document.addEventListener('pointerdown', primeTTS, { once: true });
  document.addEventListener('keydown', primeTTS, { once: true });
  stopBtn.addEventListener('click', interrupt);
  micBtn.addEventListener('click', toggleMic);

  if (wakeBtn) {
    wakeBtn.addEventListener('click', toggleWake);
    applyWakeUI();
    // Dull but unwedgeable: re-evaluate rather than hooking every transition
    // (dictation start/stop, TTS, tab switch, reconnect, engine timeout).
    setInterval(superviseWake, 1500);
    superviseWake();
  }

  /* Barge-in gets its own, faster supervisor — and one that does not depend on
     the wake button existing, since it has nothing to do with it.

     syncOrb alone was not enough, and that is why "ticho" only worked after the
     reply: the single start attempt lands in the exact window where dictation
     has been told to stop but its onend has not fired yet, so the microphone is
     still taken and the start is refused. Nothing then asked again. A reply
     lasts seconds, so this polls in fractions of one. */
  setInterval(superviseBarge, 300);

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
  // Speech recognition needs a secure context. Served from a desktop over plain
  // http://<lan-ip> the API often exists but silently never fires, which reads as
  // a broken mic rather than a browser policy — so say so plainly instead.
  if (!SR) disableMic(t().errUnsupported);
  else if (!window.isSecureContext) disableMic(t().errInsecure);

  applyLangToUI();
  if (MOCK) mockBadge.hidden = false;
  // the page can be loaded while already backgrounded — visibilitychange never fires then
  document.body.classList.toggle('is-hidden', document.hidden);

  transport = MOCK ? makeMockTransport(onServer, onConn) : makeSocketTransport(onServer, onConn);
  onConn('connecting');
  transport.start();
  syncOrb();

  /* small test surface for the browser console / automation */
  window.kaceyWake = {
    isWakePhrase: isWakePhrase,
    normalize: normalizeHeard,
    status: function () {
      return {
        enabled: wakeEnabled, running: wakeRunning, blocked: wakeBlocked,
        shouldRun: wakeShouldRun(), hits: wakeHits,
        mode: wakeMode,
        voice: {
          supported: voiceWakeUsable(),
          enrolled: voiceWakeUsable() && VW.enrolled(),
          samples: voiceWakeUsable() ? VW.count() : 0,
          active: voiceWakeActive(),
          priority: voiceWakePriority(),
          shouldRun: voiceShouldRun(),
          running: voiceWakeUsable() && VW.running(),
          threshold: voiceWakeUsable() ? VW.threshold() : 0,
          sensitivity: voiceWakeUsable() ? VW.sensitivity() : null,
          hits: voiceHits,
          sr: voiceWakeUsable() ? VW._sr() : null
        }
      };
    },
    setMode: setWakeMode,
    panel: openVoicePanel,
    // Run the voice trigger path without a microphone.
    fireVoice: function () {
      onVoiceDetect({ score: 0, threshold: 1, template: 0 });
      return true;
    },
    // Simulate what the engine would have heard, so the trigger path can be
    // tested without a microphone.
    feed: function (text) {
      if (!isWakePhrase(text)) return false;
      stopWake(true);
      state.micDesired = true;
      playWakeChime();
      setTimeout(startRecognition, WAKE_CHIME_MS + 60);
      return true;
    },
  };

  window.kacey = {
    state: state,
    classifyClosing: function (s) {
      return window.KaceyClosing ? window.KaceyClosing.classify(s) : null;
    },
    endListening: endListening,
    bargeIn: bargeIn,
    barge: function () {
      return {
        available: bargeAvailable, running: bargeRunning,
        shouldRun: bargeShouldRun(), hits: bargeHits,
        spokenGuard: !!(window.KaceyClosing &&
          window.KaceyClosing.mentionsInterrupt(bargeSpoken))
      };
    },
    send: submit,
    inject: onServer,
    conn: onConn,
    orb: function () { return orbState; }
  };
})();

/* =========================================================================
   CALENDAR VIEWER  (self-contained IIFE — read-only)

   Reads /api/calendar, which reads klaus_memory's `calendar_event` table
   directly. Editing deliberately stays in the conversation for now: Kacey
   writes through her calendar_create tool, and this view refreshes when she
   does, so a spoken "poznamenej mi..." shows up here without a manual reload.
   ========================================================================= */
(function () {
  'use strict';

  var btn = document.getElementById('calBtn');
  var sheet = document.getElementById('calPanel');
  if (!btn || !sheet) return;

  var closeBtn = document.getElementById('calClose');
  var reloadBtn = document.getElementById('calReload');
  var prevBtn = document.getElementById('calPrev');
  var nextBtn = document.getElementById('calNext');
  var todayBtn = document.getElementById('calToday');
  var body = document.getElementById('calBody');
  var meta = document.getElementById('calMeta');
  var monthEl = document.getElementById('calMonth');
  var jumpEl = document.getElementById('calJump');

  var DOW = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];
  // genitive for "3. srpna", nominative for the month heading
  var MON = ['ledna', 'února', 'března', 'dubna', 'května', 'června',
             'července', 'srpna', 'září', 'října', 'listopadu', 'prosince'];
  var MON_NOM = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen',
                 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];

  var month = null;        // 'YYYY-MM'; null = whatever the server calls current
  var loading = false;

  function shiftMonth(m, delta) {
    var p = m.split('-').map(Number);
    var d = new Date(p[0], p[1] - 1 + delta, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function monthName(m) {
    var p = m.split('-').map(Number);
    return MON_NOM[p[1] - 1] + ' ' + p[0];
  }

  function hhmm(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function dayLabel(date) {
    var p = date.split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return { dow: DOW[d.getDay()], text: Number(p[2]) + '. ' + MON[Number(p[1]) - 1] };
  }

  function tag(text, cls) {
    var s = document.createElement('span');
    s.className = 'cal__tag' + (cls ? ' cal__tag--' + cls : '');
    s.textContent = text;
    return s;
  }

  function renderEvent(e) {
    var row = document.createElement('div');
    row.className = 'cal__event';

    var time = document.createElement('span');
    time.className = 'cal__time';
    var from = hhmm(e.starts_at), to = hhmm(e.ends_at);
    time.textContent = to && to !== from ? from + '–' + to : from;
    row.appendChild(time);

    // Titles come from the model and from external calendars — textContent only.
    var title = document.createElement('span');
    title.className = 'cal__title';
    title.textContent = e.title || '(bez názvu)';
    row.appendChild(title);

    var tags = document.createElement('span');
    tags.className = 'cal__tags';
    if (e.sync_state === 'pending') tags.appendChild(tag('čeká', 'pending'));
    if (e.sync_state === 'failed') tags.appendChild(tag('chyba', 'failed'));
    if (e.origin === 'external') tags.appendChild(tag('externí', 'ext'));
    if (e.sensitivity === 'local_only') tags.appendChild(tag('local', 'local'));
    if (tags.children.length) row.appendChild(tags);

    if (e.sync_error) row.title = e.sync_error;

    var acts = document.createElement('span');
    acts.className = 'cal__tags';

    var edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'cal__act';
    edit.textContent = '✎';
    edit.title = 'Upravit';
    edit.setAttribute('aria-label', 'Upravit ' + (e.title || 'událost'));
    edit.onclick = function () { openEditor(row, e); };
    acts.appendChild(edit);

    /* Delete is two-step on purpose. An event is real data, and a mis-click on a
       12px icon should not be able to destroy it — the second click is the
       consent, and it reverts on blur or after a few seconds. */
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'cal__act cal__act--del';
    del.textContent = '×';
    del.title = 'Smazat';
    del.setAttribute('aria-label', 'Smazat ' + (e.title || 'událost'));
    var armed = false, disarm = 0;
    function reset() {
      armed = false;
      clearTimeout(disarm);
      del.textContent = '×';
      del.className = 'cal__act cal__act--del';
    }
    del.onclick = function () {
      if (!armed) {
        armed = true;
        del.textContent = 'smazat?';
        del.className = 'cal__act cal__act--confirm';
        disarm = setTimeout(reset, 5000);
        return;
      }
      reset();
      removeEvent(row, e);
    };
    del.onblur = reset;
    acts.appendChild(del);

    row.appendChild(acts);
    return row;
  }

  /* --- writes ------------------------------------------------------------
     These go through /api/calendar/:id/{update,delete}, which runs
     klaus_memory rather than touching SQLite — conflicts, updated_at and the
     external write-through all belong to it. */

  function localInput(iso) {
    // <input type="datetime-local"> wants 'YYYY-MM-DDTHH:MM' in local time.
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function offsetIso(localValue) {
    // Back to ISO with this machine's offset, which is what klaus_memory stores.
    if (!localValue) return null;
    var d = new Date(localValue);
    if (isNaN(d)) return null;
    var off = -d.getTimezoneOffset();
    var sign = off >= 0 ? '+' : '-';
    var p = function (n) { return String(Math.abs(n)).padStart(2, '0'); };
    return localValue + ':00' + sign + p(Math.floor(Math.abs(off) / 60)) + ':' + p(off % 60);
  }

  function openEditor(row, e) {
    if (row.nextSibling && row.nextSibling.classList &&
        row.nextSibling.classList.contains('cal__edit')) {
      row.parentNode.removeChild(row.nextSibling);       // toggle closed
      return;
    }

    var form = document.createElement('div');
    form.className = 'cal__edit';

    function field(labelText, type, value) {
      var l = document.createElement('label');
      var s = document.createElement('span');
      s.textContent = labelText;
      var i = document.createElement('input');
      i.type = type;
      i.value = value || '';
      l.appendChild(s); l.appendChild(i);
      return { label: l, input: i };
    }

    var title = field('název', 'text', e.title || '');
    form.appendChild(title.label);

    // Start AND end together: klaus_memory rejects an update that leaves the end
    // before the start, so editing one in isolation fails confusingly.
    var times = document.createElement('div');
    times.className = 'cal__edit-row';
    var from = field('od', 'datetime-local', localInput(e.starts_at));
    var to = field('do', 'datetime-local', e.ends_at ? localInput(e.ends_at) : '');
    times.appendChild(from.label); times.appendChild(to.label);
    form.appendChild(times);

    var err = document.createElement('p');
    err.className = 'cal__edit-err';
    err.hidden = true;

    var actions = document.createElement('div');
    actions.className = 'cal__edit-actions';
    var save = document.createElement('button');
    save.type = 'button';
    save.className = 'cal__btn';
    save.textContent = 'uložit';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'cal__btn';
    cancel.textContent = 'zpět';
    cancel.onclick = function () { form.parentNode.removeChild(form); };
    actions.appendChild(save); actions.appendChild(cancel);
    form.appendChild(actions);
    form.appendChild(err);

    save.onclick = function () {
      var payload = {};
      if (title.input.value.trim() && title.input.value.trim() !== e.title) {
        payload.title = title.input.value.trim();
      }
      var startIso = offsetIso(from.input.value);
      if (startIso && startIso !== e.starts_at) payload.starts_at = startIso;
      var endIso = to.input.value ? offsetIso(to.input.value) : null;
      if (endIso !== (e.ends_at || null)) payload.ends_at = endIso;   // null clears it

      if (!Object.keys(payload).length) { form.parentNode.removeChild(form); return; }

      save.disabled = true;
      err.hidden = true;
      fetch('/api/calendar/' + encodeURIComponent(e.event_id) + '/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j.ok) throw new Error(j.error || 'zápis selhal');
          load();                                    // redraw the month
        })
        .catch(function (ex) {
          save.disabled = false;
          err.textContent = ex.message;
          err.hidden = false;
        });
    };

    row.parentNode.insertBefore(form, row.nextSibling);
    title.input.focus();
  }

  function removeEvent(row, e) {
    row.classList.add('cal__event--busy');
    fetch('/api/calendar/' + encodeURIComponent(e.event_id) + '/delete', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || 'smazání selhalo');
        load();
      })
      .catch(function (ex) {
        row.classList.remove('cal__event--busy');
        meta.textContent = 'Smazání selhalo: ' + ex.message;
      });
  }

  /* Chips for every month that actually holds something, so a sparse calendar
     does not have to be walked one empty month at a time. */
  function renderJump(data) {
    jumpEl.innerHTML = '';
    var months = data.monthsWithEvents || [];
    if (!months.length) { jumpEl.hidden = true; return; }

    var label = document.createElement('span');
    label.className = 'cal__jump-label';
    label.textContent = 'kde něco je';
    jumpEl.appendChild(label);

    months.forEach(function (m) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'cal__chip';
      if (m.month === data.month) chip.setAttribute('aria-current', 'true');
      var b = document.createElement('b');
      b.textContent = monthName(m.month);
      chip.appendChild(b);
      chip.appendChild(document.createTextNode(' ' + m.count));
      chip.onclick = function () { month = m.month; load(); };
      jumpEl.appendChild(chip);
    });
    jumpEl.hidden = false;
  }

  function render(data) {
    month = data.month;
    monthEl.textContent = monthName(data.month);
    renderJump(data);

    body.innerHTML = '';
    var withEvents = 0;

    data.days.forEach(function (day) {
      var isToday = day.date === data.today;
      var isPast = day.date < data.today;

      var wrap = document.createElement('div');
      wrap.className = 'cal__day' +
        (day.events.length ? '' : ' cal__day--empty') +
        (isToday ? ' cal__day--today' : '') +
        (isPast ? ' cal__day--past' : '');

      var head = document.createElement('div');
      head.className = 'cal__date';
      var l = dayLabel(day.date);
      var dow = document.createElement('span');
      dow.className = 'cal__dow';
      dow.textContent = l.dow;
      head.appendChild(dow);
      var b = document.createElement('b');
      b.textContent = l.text;
      head.appendChild(b);
      if (isToday) {
        var now = document.createElement('span');
        now.textContent = '· dnes';
        head.appendChild(now);
      }
      wrap.appendChild(head);

      if (day.events.length) {
        withEvents++;
        day.events.forEach(function (e) { wrap.appendChild(renderEvent(e)); });
      } else {
        var none = document.createElement('p');
        none.className = 'cal__none';
        none.textContent = '—';
        wrap.appendChild(none);
      }
      body.appendChild(wrap);
    });

    meta.textContent = data.monthEvents === 0
      ? 'v tomto měsíci nic · ' + data.total + ' událostí celkem'
      : data.monthEvents + ' událostí v měsíci · ' + withEvents + ' dnů s programem' +
        ' · ' + data.total + ' celkem';

    // A month is ~30 rows. Land on today in the current month; otherwise start at
    // the first day that actually has something, so a jump lands on content.
    var anchor = body.querySelector('.cal__day--today');
    if (!anchor) {
      var firstWith = body.querySelector('.cal__day:not(.cal__day--empty)');
      anchor = firstWith || null;
    }
    body.scrollTop = anchor ? Math.max(0, anchor.offsetTop - body.offsetTop - 4) : 0;
  }

  function load() {
    if (loading) return;
    loading = true;
    meta.textContent = 'načítám…';
    fetch('/api/calendar' + (month ? '?month=' + encodeURIComponent(month) : ''))
      .then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
          return j;
        });
      })
      .then(render)
      .catch(function (err) {
        body.innerHTML = '';
        var p = document.createElement('p');
        p.className = 'cal__err';
        p.textContent = 'Kalendář se nepodařilo načíst: ' + err.message;
        body.appendChild(p);
        meta.textContent = '—';
      })
      .then(function () { loading = false; });
  }

  function open(yes) {
    sheet.hidden = !yes;
    btn.setAttribute('aria-expanded', String(yes));
    if (yes) load();
  }

  btn.addEventListener('click', function () { open(sheet.hidden); });
  closeBtn.addEventListener('click', function () { open(false); });
  reloadBtn.addEventListener('click', load);
  prevBtn.addEventListener('click', function () { if (month) { month = shiftMonth(month, -1); load(); } });
  nextBtn.addEventListener('click', function () { if (month) { month = shiftMonth(month, 1); load(); } });
  todayBtn.addEventListener('click', function () { month = null; load(); });
  sheet.addEventListener('click', function (ev) { if (ev.target === sheet) open(false); });
  document.addEventListener('keydown', function (ev) {
    if (sheet.hidden) return;
    // Arrows page through months while the viewer has focus.
    if (ev.key === 'Escape') { ev.preventDefault(); open(false); }
    else if (ev.key === 'ArrowLeft' && month) { ev.preventDefault(); month = shiftMonth(month, -1); load(); }
    else if (ev.key === 'ArrowRight' && month) { ev.preventDefault(); month = shiftMonth(month, 1); load(); }
  });

  /* Kacey edits the calendar through conversation, so refresh when one of her
     calendar tools finishes — otherwise the view silently goes stale. */
  window.kaceyCalendarRefresh = function () { if (!sheet.hidden) load(); };
})();
