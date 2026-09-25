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

/** Is the server's Whisper there? A yes is cached; a no is not — the sidecar
    may simply be starting, or slow to answer on a machine that is swapping,
    and a page that remembered "no" would never dictate until reloaded. */
var healthy = null;
export function serverSttAvailable() {
  if (healthy === true) return Promise.resolve(true);
  return fetch('/api/stt/health', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) { healthy = !!(j && j.ok); return healthy; })
    .catch(function () { healthy = false; return false; });
}
export function serverSttKnown() { return healthy === true; }

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
  this.onstart = this.onaudiostart = this.onspeechstart = this.onresult = this.onerror = this.onend = null;
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
  try { s.proc.disconnect(); } catch (e) {}
  try { s.src.disconnect(); } catch (e) {}
  try { s.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
  try { s.ctx.close(); } catch (e) {}
};

ServerRecognition.prototype.start = function () {
  if (this._busy) { var err = new Error('already started'); err.name = 'InvalidStateError'; throw err; }
  this._busy = true;
  var self = this;
  navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    .then(function (stream) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      var ctx = new Ctx();
      var src = ctx.createMediaStreamSource(stream);
      // ScriptProcessor rather than an AudioWorklet: deprecated, but present in
      // every engine this has to run in, WebKitGTK included, and one file.
      var proc = ctx.createScriptProcessor(4096, 1, 1);
      var s = self._s = {
        stream: stream, ctx: ctx, src: src, proc: proc, chunks: [], started: Date.now(),
        floor: null, speechAt: 0, lastLoud: 0, timer: 0, finished: false
      };
      proc.onaudioprocess = function (e) {
        if (!self._s || s.finished) return;
        var data = e.inputBuffer.getChannelData(0);
        s.chunks.push(new Float32Array(data));
        var sum = 0;
        for (var i = 0; i < data.length; i++) sum += data[i] * data[i];
        var rms = Math.sqrt(sum / data.length);
        var now = Date.now();
        // The first ~300 ms set the room's noise floor; speech is well above it.
        if (now - s.started < 300) { s.floor = s.floor === null ? rms : Math.max(s.floor, rms); return; }
        var gate = Math.max(0.012, (s.floor || 0) * 3);
        if (rms > gate) {
          if (!s.speechAt) { s.speechAt = now; self._emit('speechstart'); }
          s.lastLoud = now;
        }
        if (s.speechAt && now - s.lastLoud > END_SILENCE_MS) self._finish();
        else if (!s.speechAt && now - s.started > NO_SPEECH_MS) self._fail('no-speech');
      };
      src.connect(proc);
      proc.connect(ctx.destination);         // WebKit only runs the processor when it is connected
      s.timer = setTimeout(function () { self._finish(); }, MAX_MS);
      self._emit('start');
      self._emit('audiostart');
    })
    .catch(function (err) {
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
  var spoke = s.speechAt && (s.lastLoud - s.speechAt >= MIN_SPEECH_MS);
  var rate = s.ctx.sampleRate;
  var chunks = s.chunks;
  this._release();
  var self = this;
  if (!spoke) { this._busy = false; this._emit('error', { error: 'no-speech' }); this._emit('end'); return; }

  var wav = encodeWav(downsample(chunks, rate), TARGET_RATE);
  var gen = this._gen;
  fetch('/api/stt?lang=' + encodeURIComponent(this.lang || 'cs-CZ'), { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j; }); })
    .then(function (j) {
      if (gen !== self._gen) return;           // aborted while Whisper was working
      var text = String((j && j.text) || '').trim();
      if (!text) { self._emit('error', { error: 'no-speech' }); return; }
      var alt = { transcript: text, confidence: 1 };
      var result = [alt];
      result.isFinal = true;
      self._emit('result', { resultIndex: 0, results: [result] });
    })
    .catch(function () { if (gen === self._gen) self._emit('error', { error: 'network' }); })
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
