/* =========================================================================
   Dictation without Web Speech — record here, transcribe on the server.

   The bedside kiosk runs Epiphany (WebKitGTK), which has no working speech
   recognition. This is a stand-in with the same shape as a SpeechRecognition
   object — lang, start(), stop(), abort(), and the onstart / onaudiostart /
   onspeechstart / onresult / onerror / onend events — so recognition.js drives
   it exactly as it drives the browser's own engine. One utterance per start():

     microphone -> Web Audio -> an energy gate decides when speech began and
     ended -> 16 kHz mono WAV -> POST /api/stt -> Whisper on this machine ->
     one final result.

   WAV assembled here rather than MediaRecorder: no codec the browser may or
   may not have, and Whisper takes it as it is. The audio goes only to Kacey's
   own server, which hands it to a sidecar on the same machine.
   ========================================================================= */

var TARGET_RATE = 16000;
var NO_SPEECH_MS = 7000;        // nothing said this long after start -> 'no-speech'
var END_SILENCE_MS = 1200;      // this much quiet after speech -> the utterance is over
var MAX_MS = 20000;             // a request, not a dictation session
var MIN_SPEECH_MS = 250;        // shorter than this is a cough, not a word

var NO_FRAMES_MS = 2500;        // the mic opened but no audio arrived -> the context is dead

/* Loudness, as the RMS of one buffer. The gate that says "speech" sits a few
   times above the room but never above GATE_MAX: a fixed 0.012 floor, or a
   floor taken as the loudest of the first 300 ms, was above a quiet laptop mic
   or above anyone who started talking at once — the gate never opened, the
   recording was thrown away and the page said "Nic jsem neslyšela". */
var GATE_MIN = 0.005;
var GATE_MAX = 0.02;
var SEND_PEAK = 0.003;          // anything this loud goes to Whisper, gate or not: its VAD decides
var SILENT_PEAK = 0.0003;       // never louder than this -> a muted or wrong input, not a quiet room

/* ---- the sidecar's state -----------------------------------------------
   Whisper large v3 or its turbo variant; the sidecar holds one at a time and
   takes a minute to load the other, and during that minute it cannot
   transcribe. So the state is re-read rather than remembered: every few
   seconds while a model loads, once a minute otherwise. A page that cached
   "yes" sent the next utterance into a sidecar that was restarting. */

export var STT_MODELS = ['large-v3', 'turbo'];
var status = { ok: false, known: false, model: null, choice: null, loading: false, error: '', last: null };
var listeners = [];
var pollTimer = 0;

export function sttStatus() { return status; }
export function onSttStatus(fn) { listeners.push(fn); fn(status); }

function publish(next) {
  status = Object.assign({}, status, next, { known: true });
  listeners.forEach(function (fn) { try { fn(status); } catch (e) { console.error('[kacey] stt status listener failed', e); } });
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refreshSttStatus, status.loading ? 2500 : 60000);
}

export function refreshSttStatus() {
  return fetch('/api/stt/health', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      publish({
        ok: !!(j && j.ok), loading: !!(j && j.loading), error: (j && j.error) || '',
        model: (j && j.model) || null, choice: (j && (j.choice || j.model)) || null
      });
      return status.ok;
    })
    .catch(function () { publish({ ok: false, loading: false }); return false; });
}

/** Ask the sidecar for the other model. Resolves once it has started loading. */
export function setSttModel(name) {
  if (STT_MODELS.indexOf(name) === -1) return Promise.reject(new Error('unknown model'));
  publish({ choice: name, loading: true, ok: false, error: '' });
  return fetch('/api/stt/model', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name })
  })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j; }); })
    .then(function () { return refreshSttStatus(); })
    .catch(function (err) { refreshSttStatus(); throw err; });
}

/** Is the server's Whisper there and ready? Asks now. */
export function serverSttAvailable() { return refreshSttStatus(); }
export function serverSttKnown() { return status.ok; }

/** The microphone needs a secure page (https or localhost) — without one the
    API is simply missing, and that must read as a reason, not a broken mic. */
export function micReachable() {
  return !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

function encodeWav(samples, rate) {
  var buf = new ArrayBuffer(44 + samples.length * 2);
  var v = new DataView(buf);
  function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (var i = 0, o = 44; i < samples.length; i++, o += 2) {
    var s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** Linear resample to 16 kHz — plenty for speech. */
function downsample(chunks, fromRate) {
  var total = 0;
  chunks.forEach(function (c) { total += c.length; });
  var joined = new Float32Array(total);
  var at = 0;
  chunks.forEach(function (c) { joined.set(c, at); at += c.length; });
  if (fromRate === TARGET_RATE) return joined;
  var ratio = fromRate / TARGET_RATE;
  var out = new Float32Array(Math.floor(total / ratio));
  for (var i = 0; i < out.length; i++) {
    var pos = i * ratio, j = Math.floor(pos), f = pos - j;
    out[i] = joined[j] * (1 - f) + (joined[j + 1] || 0) * f;
  }
  return out;
}

export function ServerRecognition() {
  this.lang = 'cs-CZ';
  this.continuous = false;
  this.interimResults = false;
  this.maxAlternatives = 1;
  this.onstart = this.onaudiostart = this.onspeechstart = this.onspeechend = this.onresult = this.onerror = this.onend = null;
  this.onlevel = null;           // not in Web Speech: the mic's live loudness 0–1, for the orb
  this._busy = false;
  this._gen = 0;                 // bumped by abort(): a transcript arriving later is dropped
}

ServerRecognition.prototype._emit = function (name, ev) {
  var fn = this['on' + name];
  if (typeof fn === 'function') { try { fn.call(this, ev || {}); } catch (e) { console.error('[kacey] stt ' + name + ' handler failed', e); } }
};

ServerRecognition.prototype._release = function () {
  var s = this._s;
  this._s = null;
  if (!s) return;
  clearTimeout(s.timer);
  clearInterval(s.watch);
  try { s.proc.disconnect(); } catch (e) {}
  try { s.src.disconnect(); } catch (e) {}
  try { s.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
  try { s.ctx.close(); } catch (e) {}
  this._emit('level', { level: 0 });
};

ServerRecognition.prototype.start = function () {
  if (this._busy) { var err = new Error('already started'); err.name = 'InvalidStateError'; throw err; }
  var self = this;
  if (!micReachable()) {
    // Async, like every other failure: the caller has to finish start() first.
    setTimeout(function () { self._emit('error', { error: 'insecure' }); self._emit('end'); }, 0);
    return;
  }
  this._busy = true;
  /* The audio context is made HERE, inside the tap, and resumed at once. Made
     after getUserMedia resolved — outside the user gesture — it started
     suspended in Chrome and Safari: the processor never ran, nothing was
     recorded, and the no-speech check (which ran inside the processor) never
     fired either. The button sat on "Poslouchám" for 20 s and then said it
     heard nothing. That was the dead microphone. */
  var Ctx = window.AudioContext || window.webkitAudioContext;
  var ctx;
  try { ctx = new Ctx(); } catch (e) { ctx = null; }
  if (ctx && ctx.resume) ctx.resume().catch(function () {});
  var gen = this._gen;
  var held = null;
  // autoGainControl on: a laptop's built-in mic on Linux comes in very quiet.
  navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    .then(function (stream) {
      held = stream;
      if (gen !== self._gen || !self._busy) {      // aborted while the permission prompt was up
        stream.getTracks().forEach(function (t) { t.stop(); });
        if (ctx) ctx.close().catch(function () {});
        return;
      }
      if (!ctx) ctx = new Ctx();
      if (ctx.state === 'suspended') ctx.resume().catch(function () {});
      var src;
      try {
        src = ctx.createMediaStreamSource(stream);
      } catch (e) {
        // Firefox will not join a mic and a context running at different
        // rates: make the context again at the mic's rate.
        var track = stream.getAudioTracks()[0];
        var rate = track && track.getSettings ? track.getSettings().sampleRate : 0;
        ctx.close().catch(function () {});
        ctx = rate ? new Ctx({ sampleRate: rate }) : new Ctx();
        if (ctx.state === 'suspended') ctx.resume().catch(function () {});
        src = ctx.createMediaStreamSource(stream);
      }
      // ScriptProcessor rather than an AudioWorklet: deprecated, but present in
      // every engine this has to run in, WebKitGTK included, and one file.
      var proc = ctx.createScriptProcessor(4096, 1, 1);
      var s = self._s = {
        stream: stream, ctx: ctx, src: src, proc: proc, chunks: [], started: Date.now(),
        floor: null, peak: 0, speechAt: 0, lastLoud: 0, timer: 0, watch: 0, frames: 0, finished: false
      };
      /* The clock, not the audio, decides "nothing was said" and "the mic is
         dead": both have to fire precisely when no audio arrives. After the
         no-speech wait, anything that was louder than silence still goes to
         Whisper — a quiet voice is not no voice. */
      s.watch = setInterval(function () {
        if (!self._s || s.finished) return;
        var now = Date.now();
        if (!s.frames && now - s.started > NO_FRAMES_MS) { self._fail('no-audio'); return; }
        if (!s.speechAt && now - s.started > NO_SPEECH_MS) {
          if (s.peak >= SEND_PEAK) self._finish();
          else self._fail(s.peak < SILENT_PEAK ? 'no-audio' : 'no-speech');
        }
      }, 250);
      proc.onaudioprocess = function (e) {
        if (!self._s || s.finished) return;
        s.frames++;
        var data = e.inputBuffer.getChannelData(0);
        s.chunks.push(new Float32Array(data));
        var sum = 0;
        for (var i = 0; i < data.length; i++) sum += data[i] * data[i];
        var rms = Math.sqrt(sum / data.length);
        var now = Date.now();
        if (rms > s.peak) s.peak = rms;
        // What the orb shows: the mic itself, so a dead one is seen at once.
        self._emit('level', { level: Math.min(1, Math.sqrt(rms) * 3.2) });
        // The first ~300 ms set the room's noise floor — its quietest buffer,
        // so someone who starts talking at once does not raise it.
        if (now - s.started < 300) { s.floor = s.floor === null ? rms : Math.min(s.floor, rms); return; }
        var gate = Math.min(GATE_MAX, Math.max(GATE_MIN, (s.floor || 0) * 3));
        if (rms > gate) {
          if (!s.speechAt) { s.speechAt = now; self._emit('speechstart'); }
          s.lastLoud = now;
        }
        if (s.speechAt && now - s.lastLoud > END_SILENCE_MS) self._finish();
      };
      src.connect(proc);
      proc.connect(ctx.destination);         // WebKit only runs the processor when it is connected
      s.timer = setTimeout(function () { self._finish(); }, MAX_MS);
      self._emit('start');
      self._emit('audiostart');
    })
    .catch(function (err) {
      // Failed after the mic opened (the context would not take it): let go of it.
      if (self._s) self._release();
      else {
        if (held) held.getTracks().forEach(function (t) { t.stop(); });
        if (ctx) ctx.close().catch(function () {});
      }
      if (gen !== self._gen) return;
      self._busy = false;
      var code = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError') ? 'not-allowed' : 'audio-capture';
      self._emit('error', { error: code });
      self._emit('end');
    });
};

ServerRecognition.prototype._fail = function (code) {
  if (!this._s || this._s.finished) return;
  this._s.finished = true;
  this._release();
  this._busy = false;
  this._emit('error', { error: code });
  this._emit('end');
};

/** The utterance is over: send it, and report what Whisper heard as one final result. */
ServerRecognition.prototype._finish = function () {
  var s = this._s;
  if (!s || s.finished) return;
  s.finished = true;
  // A word the gate missed is still worth sending; only silence is not.
  var spoke = (s.speechAt && (s.lastLoud - s.speechAt >= MIN_SPEECH_MS)) || s.peak >= SEND_PEAK;
  var rate = s.ctx.sampleRate;
  var chunks = s.chunks;
  var dead = s.peak < SILENT_PEAK;
  this._release();
  var self = this;
  if (!spoke) {
    this._busy = false;
    this._emit('error', { error: dead ? 'no-audio' : 'no-speech' });
    this._emit('end');
    return;
  }
  this._emit('speechend');                    // listening is over; Whisper is writing it down

  var wav = encodeWav(downsample(chunks, rate), TARGET_RATE);
  var gen = this._gen;
  var sent = Date.now();
  fetch('/api/stt?lang=' + encodeURIComponent(this.lang || 'cs-CZ'), { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav })
    .then(function (r) {
      return r.json().then(function (j) {
        if (r.status === 503) { var e = new Error('loading'); e.code = 'stt-loading'; throw e; }
        if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
        return j;
      });
    })
    .then(function (j) {
      // How long the last sentence took, for the Přepis řeči card.
      publish({ last: { seconds: (Date.now() - sent) / 1000, model: (j && j.model) || status.model } });
      if (gen !== self._gen) return;           // aborted while Whisper was working
      var text = String((j && j.text) || '').trim();
      if (!text) { self._emit('error', { error: 'no-speech' }); return; }
      var alt = { transcript: text, confidence: 1 };
      var result = [alt];
      result.isFinal = true;
      self._emit('result', { resultIndex: 0, results: [result] });
    })
    .catch(function (err) {
      if (err && err.code === 'stt-loading') refreshSttStatus();
      if (gen === self._gen) self._emit('error', { error: (err && err.code) || 'network' });
    })
    .then(function () { if (gen !== self._gen) return; self._busy = false; self._emit('end'); });
};

/** Stop listening now and transcribe what was said so far. */
ServerRecognition.prototype.stop = function () { if (this._s) this._finish(); };

/** Stop listening and drop it: nothing is sent. */
ServerRecognition.prototype.abort = function () {
  if (!this._s) {
    // Mid-transcription: drop the answer when it comes, and end now.
    if (this._busy) { this._gen++; this._busy = false; this._emit('error', { error: 'aborted' }); this._emit('end'); }
    return;
  }
  this._s.finished = true;
  this._release();
  this._busy = false;
  this._emit('error', { error: 'aborted' });
  this._emit('end');
};
