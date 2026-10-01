/* =========================================================================
   Kacey — personal wake word by voice template matching.

   WHY THIS EXISTS
   The first wake word ran the transcript of a continuous SpeechRecognition
   stream through a list of spellings ("kc", "kejsi", "kaca", …). That cannot be
   made reliable: a two-syllable non-word has no correct Czech spelling, so the
   cloud recogniser guesses differently every time, and the list can only ever
   chase yesterday's guess. It also needed the network, and it shipped every
   sound in the room to a third party all day.

   This matches the SOUND against recordings of one specific person saying it.
   No transcription, no network, no list of spellings. It is speaker-dependent
   by design — that is the whole point, and it is also why it is more accurate
   than a general recogniser here.

   HOW
     mic -> 16 kHz mono -> 25 ms frames / 10 ms hop -> mel filterbank -> MFCC
     -> per-utterance mean/variance normalisation -> + delta coefficients
     -> energy-gated segmentation -> DTW against each enrolled template
     -> best normalised distance vs a calibrated threshold

   Choices worth knowing:
   - c0 (loudness) is dropped and CMVN is applied per utterance, so distance is
     invariant to how loud you were and to which microphone you used.
   - Deltas are included: DTW aligns time away, so without derivatives two words
     with the same phones in a different order look similar.
   - The threshold is not a guess. It is derived from how far the enrolled
     samples sit from EACH OTHER — the natural spread of one person saying one
     word — and the sensitivity dial scales that.
   - Long segments are dropped before any matching, and every remaining length
     gate is relative to the enrolled samples. Ordinary conversation is mostly
     long segments, so this alone removes the bulk of the false positives for
     free — while a wake word said in 0.15 s is still perfectly legal.

    - The room is described by its last 3 s outside any segment: a floor (20th
     percentile) and a usual loud level (80th). A segment opens above both,
     closes when the level falls near the floor OR 15 dB under the word's own
     peak, and is cut to the burst around that peak. A segment must also clear
     the room's loud level by 8 dB (10 dB for a sample) to count at all: the
     wake word is said at the device, over the TV, not under it.
   - Calibration works from the median distance between the samples, so one
     bad take does not loosen the threshold for all the others.

   Limits, stated plainly: a 300 ms word matched against a handful of samples
   will never be as sharp as a trained neural spotter. Expect it to want a
   sensitivity nudge, and expect a rare false trigger on a similar-sounding
   word. Enrol more samples, and enrol them in the room you actually use.
   ========================================================================= */

(function () {
  'use strict';

  var LS_KEY = 'kacey.wake.voice.v2';      // v2 adds the raw audio for playback
  var LS_KEY_V1 = 'kacey.wake.voice.v1';   // read once, then migrated

  /* ---- signal layout ---------------------------------------------------- */
  var TARGET_SR = 16000;      // speech has nothing above 8 kHz worth matching
  var FRAME = 400;            // 25 ms
  var HOP = 160;              // 10 ms -> 100 frames/s
  var NFFT = 512;
  var MEL = 26;
  var NCEP = 12;              // c1..c12; c0 is loudness and is deliberately gone
  var DIM = NCEP * 2;         // static + delta
  var F_LO = 80;
  var F_HI = 7600;

  /* ---- segmentation ----------------------------------------------------
     No "wake word length" is imposed on ENROLMENT. How briefly the owner says
     their own wake word is not this code's decision, and a fixed 200 ms floor
     rejected a quick "KC" outright. What is left is the point below which
     features cannot be computed at all, plus a ceiling that keeps continuous
     conversation away from the matcher.

     The matcher's length gate is relative to the enrolled samples (see match()),
     not a constant — otherwise a short wake word could enrol happily and then
     never match anything. */
  var MIN_ENROL_FRAMES = 6;   // 60 ms — fewer frames than deltas need
  var MIN_MATCH_FRAMES = 8;   // a click or a chair scrape, not a word
  var MAX_FRAMES = 140;       // 1.4 s baseline; raised for longer templates
  var MAX_ENROL_FRAMES = 300; // 3 s hard stop so one segment cannot grow forever
  var PRE_ROLL = 8;           // 80 ms before onset, enough for a soft plosive
  var HANG_FRAMES = 22;       // 220 ms of quiet closes the segment
  var TAIL_KEEP = 2;          // frames of that quiet kept in the segment
  var ON_DB = 7;              // dB above the tracked noise floor to open
  var OFF_DB = 5;             // ... and to stay open (hysteresis)
  var PEAK_DROP_DB = 15;      // ... or this far below the segment's own peak closes it
  var BG_MARGIN_DB = 3;       // to open, also this far above the room's usual loud level
  var ENROL_SNR_DB = 10;      // a sample's peak must clear the room's loud level by this
  var MATCH_SNR_DB = 8;       // ... and a live segment's, to be compared at all
  var BRIDGE_FRAMES = 15;     // a dip this short inside a word (the stop in "ká-cé") is bridged
  var ROOM_FRAMES = 300;      // 3 s of level history for the room statistics
  var SMOOTH = 0.35;          // level smoothing for the open/close decisions
  var ABS_FLOOR_DB = -58;     // below this it is a dead mic, not speech
  var FLOOR_MIN_DB = -75;     // ... and the tracked floor never sits below this
  var FLOOR_WARMUP = 12;      // frames observed before the floor is trusted
  var START_DEAFEN_MS = 250;  // ignored after the device opens (pop, AGC settling)

  /* ---- enrolment / matching ------------------------------------------- */
  var MIN_TEMPLATES = 3;
  var MAX_TEMPLATES = 20;
  var REARM_MS = 1200;        // ignore everything for a moment after a hit
  var QUANT = 24;             // int8 scale for storage; features are ~N(0,1)

  /* =====================================================================
     DSP PRIMITIVES
     ===================================================================== */

  function melOf(f) { return 2595 * Math.log(1 + f / 700) / Math.LN10; }
  function invMel(m) { return 700 * (Math.pow(10, m / 2595) - 1); }

  /* Iterative radix-2 Cooley-Tukey. Real input, so only the first NFFT/2+1
     power bins are meaningful. */
  function Fft(n) {
    this.n = n;
    var bits = Math.round(Math.log(n) / Math.LN2);
    this.rev = new Uint16Array(n);
    for (var i = 0; i < n; i++) {
      var r = 0;
      for (var b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (var k = 0; k < n / 2; k++) {
      this.cos[k] = Math.cos(-2 * Math.PI * k / n);
      this.sin[k] = Math.sin(-2 * Math.PI * k / n);
    }
    this.re = new Float32Array(n);
    this.im = new Float32Array(n);
  }

  /* in: windowed frame (length <= n, zero padded). out: power, n/2+1 bins. */
  Fft.prototype.power = function (input, out) {
    var n = this.n, re = this.re, im = this.im, i;
    for (i = 0; i < n; i++) { re[i] = i < input.length ? input[i] : 0; im[i] = 0; }

    for (i = 0; i < n; i++) {
      var r = this.rev[i];
      if (r > i) {
        var tr = re[i]; re[i] = re[r]; re[r] = tr;
        var ti = im[i]; im[i] = im[r]; im[r] = ti;
      }
    }
    for (var size = 2; size <= n; size <<= 1) {
      var half = size >> 1, step = n / size;
      for (var off = 0; off < n; off += size) {
        for (var j = off, k = 0; j < off + half; j++, k += step) {
          var wr = this.cos[k], wi = this.sin[k];
          var xr = re[j + half] * wr - im[j + half] * wi;
          var xi = re[j + half] * wi + im[j + half] * wr;
          re[j + half] = re[j] - xr; im[j + half] = im[j] - xi;
          re[j] += xr; im[j] += xi;
        }
      }
    }
    for (i = 0; i <= n / 2; i++) out[i] = re[i] * re[i] + im[i] * im[i];
    return out;
  };

  function hamming(n) {
    var w = new Float32Array(n);
    for (var i = 0; i < n; i++) w[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (n - 1));
    return w;
  }

  function melBank(sr) {
    var nb = NFFT / 2 + 1;
    var hi = Math.min(F_HI, sr / 2 - 100);
    var m0 = melOf(F_LO), m1 = melOf(hi);
    var edge = [];
    for (var i = 0; i < MEL + 2; i++) {
      edge.push(Math.floor((NFFT + 1) * invMel(m0 + (m1 - m0) * i / (MEL + 1)) / sr));
    }
    var bank = [];
    for (var m = 1; m <= MEL; m++) {
      var row = new Float32Array(nb);
      var a = edge[m - 1], b = edge[m], c = edge[m + 1];
      for (var k = a; k < b; k++) if (k >= 0 && k < nb) row[k] = (k - a) / (b - a);
      for (var k2 = b; k2 < c; k2++) if (k2 >= 0 && k2 < nb) row[k2] = (c - k2) / (c - b);
      if (b >= 0 && b < nb) row[b] = 1;
      bank.push(row);
    }
    return bank;
  }

  function dctRows() {
    var rows = [];
    for (var i = 1; i <= NCEP; i++) {          // from 1: c0 is energy, unwanted
      var row = new Float32Array(MEL);
      for (var j = 0; j < MEL; j++) row[j] = Math.cos(Math.PI * i * (j + 0.5) / MEL);
      rows.push(row);
    }
    return rows;
  }

  /* =====================================================================
     FEATURES

     Static coefficients are collected per frame while a segment is open;
     CMVN and deltas need the whole segment, so they run once at close.
     ===================================================================== */

  function Featurizer(sr) {
    this.sr = sr;
    this.fft = new Fft(NFFT);
    this.win = hamming(FRAME);
    this.bank = melBank(sr);
    this.dct = dctRows();
    this.spec = new Float32Array(NFFT / 2 + 1);
    this.buf = new Float32Array(FRAME);
    this.melBuf = new Float32Array(MEL);
  }

  /* -> { c: Float32Array(NCEP), db: number } */
  Featurizer.prototype.frame = function (samples, offset) {
    var i, sum = 0;
    for (i = 0; i < FRAME; i++) {
      var s = samples[offset + i];
      sum += s * s;
      this.buf[i] = s * this.win[i];
    }
    var db = 10 * Math.log(sum / FRAME + 1e-12) / Math.LN10;

    this.fft.power(this.buf, this.spec);

    for (i = 0; i < MEL; i++) {
      var row = this.bank[i], acc = 0;
      for (var k = 0; k < row.length; k++) if (row[k]) acc += row[k] * this.spec[k];
      this.melBuf[i] = Math.log(acc + 1e-10);
    }

    var c = new Float32Array(NCEP);
    for (i = 0; i < NCEP; i++) {
      var d = this.dct[i], a = 0;
      for (var j = 0; j < MEL; j++) a += d[j] * this.melBuf[j];
      c[i] = a;
    }
    return { c: c, db: db };
  };

  /* Per-utterance mean/variance normalisation + deltas.
     statics: Array<Float32Array(NCEP)> -> Float32Array(nFrames * DIM) */
  function finishFeatures(statics) {
    var n = statics.length, i, j;
    var mean = new Float32Array(NCEP), sd = new Float32Array(NCEP);

    for (j = 0; j < NCEP; j++) {
      var s = 0;
      for (i = 0; i < n; i++) s += statics[i][j];
      mean[j] = s / n;
    }
    for (j = 0; j < NCEP; j++) {
      var v = 0;
      for (i = 0; i < n; i++) { var d = statics[i][j] - mean[j]; v += d * d; }
      sd[j] = Math.sqrt(v / n) || 1;      // a constant coefficient contributes nothing
    }

    var norm = [];
    for (i = 0; i < n; i++) {
      var row = new Float32Array(NCEP);
      for (j = 0; j < NCEP; j++) row[j] = (statics[i][j] - mean[j]) / sd[j];
      norm.push(row);
    }

    // Regression delta over +-2 frames, edges clamped. Denominator 2*(1+4)=10.
    var out = new Float32Array(n * DIM);
    for (i = 0; i < n; i++) {
      var base = i * DIM;
      for (j = 0; j < NCEP; j++) {
        out[base + j] = norm[i][j];
        var num = 0;
        for (var th = 1; th <= 2; th++) {
          var hiI = Math.min(n - 1, i + th), loI = Math.max(0, i - th);
          num += th * (norm[hiI][j] - norm[loI][j]);
        }
        out[base + NCEP + j] = num / 10;
      }
    }
    return out;
  }

  /* =====================================================================
     DTW

     Symmetric step pattern, Sakoe-Chiba band, cost normalised by (na+nb) so
     that a long utterance is not penalised for being long.
     ===================================================================== */

  function dtw(a, na, b, nb, bandFrac, ceiling) {
    // The band must at least cover the length difference, or the path can never
    // reach the corner and two takes of one word said at different speeds
    // come out "infinitely" far apart (which also broke calibration).
    var band = Math.max(10, Math.round(bandFrac * Math.max(na, nb)), Math.abs(na - nb) + 5);
    var INF = 1e18;
    var prev = new Float64Array(nb + 1), cur = new Float64Array(nb + 1);
    var i, j;

    for (j = 0; j <= nb; j++) prev[j] = INF;
    prev[0] = 0;

    for (i = 1; i <= na; i++) {
      var jLo = Math.max(1, i - band), jHi = Math.min(nb, i + band);
      for (j = 0; j <= nb; j++) cur[j] = INF;
      var rowMin = INF;

      for (j = jLo; j <= jHi; j++) {
        var best = prev[j - 1];
        if (prev[j] < best) best = prev[j];
        if (cur[j - 1] < best) best = cur[j - 1];
        if (best >= INF) continue;

        var pa = (i - 1) * DIM, pb = (j - 1) * DIM, acc = 0;
        for (var d = 0; d < DIM; d++) { var t = a[pa + d] - b[pb + d]; acc += t * t; }
        cur[j] = best + Math.sqrt(acc);
        if (cur[j] < rowMin) rowMin = cur[j];
      }

      // Early exit: the cost only grows, so once every live cell already
      // exceeds the ceiling this template cannot win.
      if (ceiling && rowMin / (na + nb) > ceiling) return Infinity;

      var swap = prev; prev = cur; cur = swap;
    }
    return prev[nb] >= INF ? Infinity : prev[nb] / (na + nb);
  }

  /* =====================================================================
     STORAGE — int8 quantised, base64. ~2 kB per sample.
     ===================================================================== */

  function toB64(f32) {
    var q = new Int8Array(f32.length);
    for (var i = 0; i < f32.length; i++) {
      var v = Math.round(f32[i] * QUANT);
      q[i] = v > 127 ? 127 : v < -128 ? -128 : v;
    }
    var bytes = new Uint8Array(q.buffer), s = '';
    for (var o = 0; o < bytes.length; o += 8192) {
      s += String.fromCharCode.apply(null, bytes.subarray(o, o + 8192));
    }
    return btoa(s);
  }

  function fromB64(b64) {
    var s = atob(b64), bytes = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    var q = new Int8Array(bytes.buffer);
    var f = new Float32Array(q.length);
    for (var j = 0; j < q.length; j++) f[j] = q[j] / QUANT;
    return f;
  }

  /* Audio needs more than 8 bits — int8 PCM is audibly grainy, and the point of
     playback is judging recording quality. int16 at 16 kHz is ~32 kB/s, so ten
     half-second samples cost about 220 kB of localStorage once base64'd. */
  function pcmToB64(f32) {
    var q = new Int16Array(f32.length);
    for (var i = 0; i < f32.length; i++) {
      var v = Math.round(f32[i] * 32767);
      q[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
    var bytes = new Uint8Array(q.buffer), s = '';
    for (var o = 0; o < bytes.length; o += 8192) {
      s += String.fromCharCode.apply(null, bytes.subarray(o, o + 8192));
    }
    return btoa(s);
  }

  function pcmFromB64(b64) {
    var s = atob(b64), bytes = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    var q = new Int16Array(bytes.buffer);
    var f = new Float32Array(q.length);
    for (var j = 0; j < q.length; j++) f[j] = q[j] / 32767;
    return f;
  }

  /* =====================================================================
     ENGINE
     ===================================================================== */

  var AC = window.AudioContext || window.webkitAudioContext;

  var templates = [];        // { feat: Float32Array, n: int, ms: int, sr: int }
  var sens = 50;             // 0..100, 50 == the calibrated threshold as-is
  var baseThr = 0;           // from enrolment spread; 0 until calibrated
  var selfSpread = null;     // { mean, sd, worst } — shown in the UI

  var ctx = null, node = null, source = null, stream = null, lowpass = null;
  var effSr = TARGET_SR;
  var fz = null;
  var starting = null;       // in-flight start() promise, so callers cannot race
  var runningFlag = false;

  var cbDetect = null, cbScore = null, cbLevel = null;
  var capturePending = null;

  /* segmentation state */
  var pending = new Float32Array(0);
  var noiseFloor = null;
  var inSpeech = false;
  var quiet = 0;
  var segStatics = [];
  var segAbs = [];            // absolute sample index of each frame in segStatics
  var segDb = [];             // smoothed level of each frame in segStatics
  var segPeak = -Infinity;    // the loudest smoothed frame of the open segment
  var level = null;           // smoothed frame level, dB
  var quietDb = [];           // levels of the frames counted as quiet so far
  var room = [];              // smoothed levels of recent frames outside any segment
  var roomLoud = null;        // 80th percentile of `room`: the room's usual loud level
  var roomTick = 0;
  var preRoll = [];
  var preRollAbs = [];
  var analysisMutedUntil = 0; // set while a sample is being auditioned
  var rearmUntil = 0;
  var lastLevelPost = 0;
  var suppressed = false;     // runaway abandoned — wait for real silence
  var floorInit = [];         // first frames after a start, used to seed the floor

  /* 50 is the calibrated threshold untouched. The loose half now reaches 1.9x
     rather than 1.3x: the calibration only knows how much the enrolled samples
     differ from EACH OTHER, and a live utterance in a different position or room
     can sit well outside that spread while still plainly being the wake word.
     The old ceiling made that unreachable, which read as "it just does not work"
     with no way to argue back. */
  function threshold() {
    if (!baseThr) return 0;
    var f = sens <= 50 ? 0.80 + 0.004 * sens : 1 + 0.018 * (sens - 50);
    return baseThr * f;
  }

  /* The spread among the enrolled samples IS the tolerance: it is how much this
     person varies saying this word. Anything tighter rejects their own voice. */
  function calibrate() {
    baseThr = 0;
    selfSpread = null;
    if (templates.length < 2) return;

    var best = [];
    for (var i = 0; i < templates.length; i++) {
      var m = Infinity;
      for (var j = 0; j < templates.length; j++) {
        if (i === j) continue;
        var d = dtw(templates[i].feat, templates[i].n, templates[j].feat, templates[j].n, 0.2, 0);
        if (d < m) m = d;
      }
      if (isFinite(m)) best.push(m);
    }
    if (!best.length) return;

    var mean = best.reduce(function (a, b) { return a + b; }, 0) / best.length;
    var varc = best.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / best.length;
    var sd = Math.sqrt(varc);
    var worst = Math.max.apply(null, best);

    /* From the median, not the worst: one bad take (a cough, the room in the
       background) otherwise stretches the tolerance to cover it, and the room's
       own noises start to match. That take is still flagged as an outlier in
       the panel, where it can be heard and deleted. Headroom over the median,
       widened when the takes genuinely vary (MAD), capped at 1.8x. */
    var sorted = best.slice().sort(function (a, b) { return a - b; });
    var median = sorted[Math.floor(sorted.length / 2)];
    if (sorted.length % 2 === 0) median = (median + sorted[sorted.length / 2 - 1]) / 2;
    var dev = sorted.map(function (d) { return Math.abs(d - median); }).sort(function (a, b) { return a - b; });
    var mad = dev[Math.floor(dev.length / 2)] * 1.4826;
    baseThr = Math.min(Math.max(median * 1.25, median + 2.5 * mad), median * 1.8);
    selfSpread = { mean: mean, sd: sd, worst: worst };
  }

  function save() {
    var payload = {
      v: 2, sr: effSr, dim: DIM, sens: sens,
      samples: templates.map(function (t) {
        var row = { n: t.n, ms: t.ms, sr: t.sr, d: toB64(t.feat) };
        if (t.audio) row.a = pcmToB64(t.audio);
        return row;
      })
    };
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
      return true;
    } catch (e) {
      // Audio is what makes this big enough to hit a quota. Detection does not
      // need it, so drop it and keep the templates rather than losing the lot.
      try {
        payload.samples.forEach(function (row) { delete row.a; });
        localStorage.setItem(LS_KEY, JSON.stringify(payload));
      } catch (e2) { return false; }   // private mode — detection still works
      return true;
    }
  }

  function load() {
    var raw = null, legacy = false;
    try {
      raw = localStorage.getItem(LS_KEY);
      if (!raw) { raw = localStorage.getItem(LS_KEY_V1); legacy = !!raw; }
    } catch (e) { return; }
    if (!raw) return;
    try {
      var o = JSON.parse(raw);
      // v1 carried the same feature layout, just no audio: keep those templates
      // working rather than silently wiping an enrolment on an upgrade.
      if (!o || (o.v !== 1 && o.v !== 2) || o.dim !== DIM) return;
      if (typeof o.sens === 'number') sens = o.sens;
      templates = (o.samples || []).map(function (s) {
        return {
          feat: fromB64(s.d), n: s.n, ms: s.ms, sr: s.sr || TARGET_SR,
          audio: s.a ? pcmFromB64(s.a) : null
        };
      }).filter(function (t) { return t.n > 0 && t.feat.length === t.n * DIM; });
      calibrate();
      if (legacy && templates.length) save();     // adopt the v2 key
    } catch (e) { templates = []; }
  }

  /* ---- segmentation ---------------------------------------------------- */

  function resetSeg() {
    pending = new Float32Array(0);
    inSpeech = false; quiet = 0;
    segStatics = []; segAbs = []; segDb = []; segPeak = -Infinity; quietDb = [];
    preRoll = []; preRollAbs = [];
    suppressed = false;
    floorInit = [];
    level = null;
    // Keep noiseFloor: the room does not change between two starts a second apart.
  }

  /* ---- raw audio ring --------------------------------------------------
     Features alone cannot be played back: c0 is dropped, CMVN removes level,
     and the phase is gone. So the last few seconds of raw audio are kept in a
     ring, and a closed segment copies its own span out of it. This is what makes
     "listen to sample 2" possible, and it is worth the memory purely because a
     bad enrolment is otherwise invisible — you cannot tell a clipped or
     half-swallowed recording from a good one by looking at a number.
     ---------------------------------------------------------------------- */
  var RING_SEC = 6;
  var ring = null;            // Float32Array
  var ringWrote = 0;          // total samples ever written (absolute clock)
  var mergedAbs = 0;          // absolute index of pending[0]

  function writeRing(block) {
    if (!ring || ring.length !== RING_SEC * Math.round(effSr)) {
      ring = new Float32Array(RING_SEC * Math.round(effSr));
      ringWrote = 0;
      mergedAbs = 0;
    }
    var len = ring.length;
    for (var i = 0; i < block.length; i++) ring[(ringWrote + i) % len] = block[i];
    ringWrote += block.length;
  }

  /* Absolute [from, to) out of the ring, or null if it has been overwritten. */
  function readRing(from, to) {
    if (!ring || to <= from) return null;
    var len = ring.length;
    if (from < ringWrote - len || to > ringWrote) return null;
    var out = new Float32Array(to - from);
    for (var i = 0; i < out.length; i++) out[i] = ring[(from + i) % len];
    return out;
  }

  function onBlock(block) {
    writeRing(block);

    var merged = new Float32Array(pending.length + block.length);
    merged.set(pending, 0);
    merged.set(block, pending.length);

    var off = 0;
    while (off + FRAME <= merged.length) {
      handleFrame(merged, off, mergedAbs + off);
      off += HOP;
    }
    pending = merged.slice(off);
    mergedAbs += off;

    var now = Date.now();
    if (cbLevel && now - lastLevelPost > 60) {
      lastLevelPost = now;
      var rms = 0;
      for (var i = 0; i < block.length; i++) rms += block[i] * block[i];
      rms = Math.sqrt(rms / block.length);
      // ~-50 dBFS..0 mapped to 0..1; enough for a meter, not a measurement.
      cbLevel(Math.max(0, Math.min(1, (20 * Math.log(rms + 1e-9) / Math.LN10 + 50) / 50)));
    }
  }

  /* Stop analysing for a while, and abandon anything in flight.

     Two callers, same underlying need — there is audio coming that is not the
     owner speaking, and treating it as speech corrupts things:
       - auditioning a stored sample through the speakers (it IS the wake word),
       - the click or tap that started a recording (a sharp transient that trips
         the onset detector, so the "sample" captured was the button, not the
         word — and every later comparison was then made against a mouse click).

     The in-flight segment is dropped rather than paused: resuming across a gap
     would splice together audio that was never contiguous. */
  function deafen(ms) {
    analysisMutedUntil = Date.now() + (ms || 0);
    inSpeech = false; quiet = 0;
    segStatics = []; segAbs = []; segDb = []; segPeak = -Infinity; quietDb = [];
    preRoll = []; preRollAbs = [];
    suppressed = false;
  }

  /* The room, from its recent history outside any segment: the floor is the
     quiet end (20th percentile), roomLoud the usual loud end (80th). A single
     slow floor cannot describe a room with a TV, music or traffic in it — the
     floor sits in the lulls and every burst of background opens a segment. */
  function noteRoom(db) {
    room.push(db);
    if (room.length > ROOM_FRAMES) room.shift();
    // Sorting 300 numbers every 10 ms is waste; every tenth frame is plenty.
    if (room.length < FLOOR_WARMUP || ++roomTick % 10) return;
    var sorted = room.slice().sort(function (a, b) { return a - b; });
    noiseFloor = Math.max(FLOOR_MIN_DB, sorted[Math.floor(sorted.length * 0.2)]);
    roomLoud = sorted[Math.floor(sorted.length * 0.8)];
  }

  function openLine() {
    return Math.max(noiseFloor + ON_DB, roomLoud === null ? -Infinity : roomLoud + BG_MARGIN_DB);
  }

  function handleFrame(samples, off, abs) {
    if (Date.now() < analysisMutedUntil) return;

    var f = fz.frame(samples, off);
    /* Decisions run on a smoothed level. Room noise flickers frame to frame by
       10 dB or more; unsmoothed, one loud frame in every 220 ms is enough to keep
       a segment open for good. */
    level = level === null ? f.db : level + SMOOTH * (f.db - level);
    var db = level;

    /* Seed the floor from a short warmup rather than from the first frame.
       A capture stream often opens on digital silence, which is -120 dB: seeded
       from that, EVERY sound is 60 dB "above the floor" so a segment opens
       instantly and never closes, the runaway guard abandons it, and the
       detector then waits for a -115 dB pause that a real room never provides.
       The result was several seconds of total deafness after every start —
       which looks exactly like "it does not hear me". */
    if (noiseFloor === null) {
      floorInit.push(db);
      if (floorInit.length < FLOOR_WARMUP) return;
      var sorted = floorInit.slice().sort(function (a, b) { return a - b; });
      noiseFloor = sorted[Math.floor(sorted.length * 0.25)];   // low quartile
      room = floorInit.slice();
      floorInit = [];
    }
    // Belt and braces: clamped, the pathological case cannot come back by
    // another route (a muted track, a silent virtual device).
    if (noiseFloor < FLOOR_MIN_DB) noiseFloor = FLOOR_MIN_DB;

    if (!inSpeech) {
      // Falls at once (a lull is real), otherwise follows the room's history.
      // Not while a runaway is being waited out: that is somebody talking, and
      // counted as "the room" it would raise the bar for the next few seconds
      // so that a "KC" right after a sentence opened late and came out split.
      if (db < noiseFloor) noiseFloor = Math.max(FLOOR_MIN_DB, db);
      if (!suppressed) noteRoom(db);

      if (suppressed) {
        // A runaway was just abandoned mid-sentence. Refuse to open again until
        // the room has genuinely gone quiet: otherwise the tail of continuous
        // speech forms a wake-word-sized segment and reaches the matcher, which
        // is precisely the false positive the length gate was meant to prevent.
        preRoll.length = 0; preRollAbs.length = 0;
        if (db < Math.max(noiseFloor + OFF_DB, roomLoud === null ? -Infinity : roomLoud)) { if (++quiet >= HANG_FRAMES) { suppressed = false; quiet = 0; } }
        else quiet = 0;
        return;
      }

      if (db > openLine() && db > ABS_FLOOR_DB) {
        inSpeech = true;
        quiet = 0; quietDb = [];
        segStatics = preRoll.slice();
        segAbs = preRollAbs.slice();
        segDb = segStatics.map(function () { return noiseFloor; });
        segPeak = db;
        preRoll = []; preRollAbs = [];
        segStatics.push(f.c); segAbs.push(abs); segDb.push(db);
      } else {
        preRoll.push(f.c); preRollAbs.push(abs);
        if (preRoll.length > PRE_ROLL) { preRoll.shift(); preRollAbs.shift(); }
      }
      return;
    }

    segStatics.push(f.c); segAbs.push(abs); segDb.push(db);
    if (db > segPeak) segPeak = db;

    /* Quiet is "back near the floor" OR "well below this word's own peak". The
       second half is what a real room needs: with a fan, traffic or music the
       level after the word never gets within a few dB of the floor, so the
       segment used to run on to the 3 s stop (enrolment) or the runaway guard
       (detection) and a "KC" was never matched on its own. */
    if (db < Math.max(noiseFloor + OFF_DB, segPeak - PEAK_DROP_DB)) {
      quietDb.push(db);
      if (++quiet >= HANG_FRAMES) { closeSegment(true); return; }
    } else {
      quiet = 0; quietDb = [];
    }

    // Enrolment is allowed to run long (someone may enrol a whole phrase); only
    // a hard stop applies, and what was captured is kept rather than thrown away.
    if (capturePending) {
      if (segStatics.length >= MAX_ENROL_FRAMES) closeSegment(false);
      return;
    }

    // Runaway (continuous speech): abandon without matching. Cheap, and it is
    // the single biggest source of false positives in a normal conversation.
    if (segStatics.length > runawayCap() + HANG_FRAMES) {
      inSpeech = false; segStatics = []; segAbs = []; segDb = []; segPeak = -Infinity; quietDb = [];
      preRoll = []; preRollAbs = []; quiet = 0;
      suppressed = true;
    }
  }

  /* Long enrolled samples must still be matchable, so the conversation guard
     follows them upward. It never tightens below the baseline. */
  function runawayCap() {
    var longest = 0;
    for (var i = 0; i < templates.length; i++) if (templates[i].n > longest) longest = templates[i].n;
    return Math.max(MAX_FRAMES, Math.round(longest * 2.2));
  }

  function closeSegment(trimHangover) {
    var statics = segStatics, absList = segAbs, dbs = segDb, peak = segPeak;
    var quietLevels = quietDb;
    inSpeech = false; quiet = 0;
    segStatics = []; segAbs = []; segDb = []; segPeak = -Infinity; quietDb = [];
    preRoll = []; preRollAbs = [];

    // The quiet tail is room sound: it belongs in the room statistics.
    for (var r = 0; r < quietLevels.length; r++) noteRoom(quietLevels[r]);

    if (trimHangover) {
      // Drop the trailing silence the hangover collected, keeping a couple of
      // frames of it. On a short word that silence is a large fraction of the
      // segment, and it dilutes the comparison.
      var keep = Math.max(0, statics.length - HANG_FRAMES + TAIL_KEEP);
      statics = statics.slice(0, keep);
      absList = absList.slice(0, keep);
      dbs = dbs.slice(0, keep);
    }

    /* Keep the burst around the peak and nothing else: room sound before or
       after the word (the segment may have opened on a noise, or hit the 3 s
       stop) dilutes the comparison. Enrolment and detection are cut the same
       way, so a live "KC" is compared like with like. */
    if (dbs.length) {
      var span = burstSpan(dbs, peak);
      statics = statics.slice(span[0], span[1]);
      absList = absList.slice(span[0], span[1]);
    }

    /* ENROLMENT: no length judgement. If the owner says a 0.15 s "KC", that is
       the wake word, and a threshold calibrated from those samples will match it
       on the way back. The only floor is arithmetic — deltas need a few frames. */
    /* Loud enough to be addressed to her? The wake word is said at the device,
       clearly over whatever the room is doing; a burst of the TV or of talk in
       the next room is not. Without this the first background burst after
       "nahrát vzorek" became the sample. */
    var over = peak - (roomLoud === null ? noiseFloor : roomLoud);

    if (capturePending) {
      if (statics.length < MIN_ENROL_FRAMES || over < ENROL_SNR_DB) return;
      var done = capturePending;
      capturePending = null;
      // Audio is kept only for enrolment. A detection segment is thrown away a
      // moment later, so copying its audio out of the ring would be pure waste.
      done.resolve(makeSample(statics, absList));
      return;
    }

    if (statics.length < MIN_MATCH_FRAMES) return;
    if (over < MATCH_SNR_DB) {
      if (cbScore) cbScore({ score: Infinity, threshold: threshold(), hit: false, ms: statics.length * 10, quiet: true, over: over });
      return;
    }
    match(makeSample(statics, null), over);
  }

  /* [from, to) of the burst around the loudest frame: out from the peak while
     the level stays within PEAK_DROP_DB of it, bridging dips up to
     BRIDGE_FRAMES (the stop in "ká-cé"), plus a little either side. */
  function burstSpan(dbs, peak) {
    var n = dbs.length, top = 0;
    for (var i = 1; i < n; i++) if (dbs[i] > dbs[top]) top = i;
    var line = peak - PEAK_DROP_DB;
    var lo = top, hi = top, gap = 0, j;
    for (j = top - 1; j >= 0; j--) {
      if (dbs[j] >= line) { lo = j; gap = 0; } else if (++gap > BRIDGE_FRAMES) break;
    }
    gap = 0;
    for (j = top + 1; j < n; j++) {
      if (dbs[j] >= line) { hi = j; gap = 0; } else if (++gap > BRIDGE_FRAMES) break;
    }
    return [Math.max(0, lo - 2), Math.min(n, hi + 1 + TAIL_KEEP)];
  }

  function makeSample(statics, absList) {
    var s = {
      feat: finishFeatures(statics),
      n: statics.length,
      ms: statics.length * 10,
      sr: effSr,
      audio: null
    };
    if (absList && absList.length) {
      // The frame span covers absList[0] .. last frame start + FRAME.
      s.audio = readRing(absList[0], absList[absList.length - 1] + FRAME);
    }
    return s;
  }

  function match(sample, over) {
    if (templates.length < MIN_TEMPLATES || !baseThr) return;

    var thr = threshold();
    var best = Infinity, bestIdx = -1;
    // Per-template distances, so the panel can show WHICH samples matched. A
    // sample that never matches anything is dead weight and should be redone.
    var perTemplate = new Array(templates.length);
    for (var i = 0; i < templates.length; i++) {
      perTemplate[i] = null;
      var t = templates[i];
      // Length gate, relative to THIS template rather than to a constant: a
      // short wake word gets a proportionally short window. Deliberately wide,
      // because a brief word varies proportionally more between takes than a
      // long one, and the distance threshold is the real arbiter anyway.
      var ratio = sample.n / t.n;
      if (ratio < 0.5 || ratio > 2) continue;
      // Ceiling scaled off the loosest reachable threshold, not the current one:
      // otherwise turning sensitivity down would also stop the panel showing you
      // the numbers you need in order to turn it back up.
      var d = dtw(sample.feat, sample.n, t.feat, t.n, 0.2, baseThr * 2.6);
      perTemplate[i] = isFinite(d) ? d : null;
      if (d < best) { best = d; bestIdx = i; }
    }

    var hit = isFinite(best) && best <= thr && Date.now() >= rearmUntil;
    if (cbScore) {
      cbScore({
        score: best, threshold: thr, hit: hit, ms: sample.ms,
        template: bestIdx, perTemplate: perTemplate, over: over
      });
    }
    if (hit) {
      rearmUntil = Date.now() + REARM_MS;
      if (cbDetect) cbDetect({ score: best, threshold: thr, template: bestIdx });
    }
  }

  /* ---- audio graph ----------------------------------------------------- */

  function supported() {
    // `in` rather than reading AC.prototype.audioWorklet: that is an accessor on
    // the prototype and touching it off an instance throws "Illegal invocation".
    return !!(AC && window.AudioWorkletNode &&
      navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
      'audioWorklet' in AC.prototype);
  }

  function start() {
    if (runningFlag) return Promise.resolve(true);
    if (starting) return starting;
    if (!supported()) return Promise.reject(new Error('unsupported'));

    starting = (function () {
      // A dedicated 16 kHz context lets the browser do the resampling in C++,
      // and removes the decimation/anti-alias problem entirely. Not every
      // engine honours the hint, so the fallback still handles it.
      if (!ctx) {
        try { ctx = new AC({ sampleRate: TARGET_SR, latencyHint: 'interactive' }); }
        catch (e) { ctx = new AC(); }
      }
      var decim = Math.max(1, Math.round(ctx.sampleRate / TARGET_SR));
      effSr = ctx.sampleRate / decim;
      if (!fz || fz.sr !== effSr) fz = new Featurizer(effSr);

      var ready = node ? Promise.resolve()
        : ctx.audioWorklet.addModule('wake-worklet.js').then(function () {
            node = new AudioWorkletNode(ctx, 'kacey-wake-tap', {
              numberOfInputs: 1, numberOfOutputs: 0,
              processorOptions: { decimation: decim, blockSize: HOP * 2 }
            });
            node.port.onmessage = function (ev) { if (runningFlag) onBlock(ev.data); };
          });

      return ready.then(function () {
        return navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            // Echo cancellation matters here: without it the wake listener hears
            // Kacey's own replies through the speakers.
            echoCancellation: true,
            noiseSuppression: true,
            // AGC off on purpose — it pumps the level mid-word, which moves the
            // features around. CMVN already makes loudness irrelevant.
            autoGainControl: false,
            sampleRate: TARGET_SR
          }, video: false
        });
      }).then(function (s) {
        stream = s;
        source = ctx.createMediaStreamSource(s);
        if (decim > 1) {
          // Only needed when we decimate ourselves: kill everything above the
          // new Nyquist first, or it folds back as noise.
          lowpass = ctx.createBiquadFilter();
          lowpass.type = 'lowpass';
          lowpass.frequency.value = effSr / 2 * 0.9;
          lowpass.Q.value = 0.7;
          source.connect(lowpass);
          lowpass.connect(node);
        } else {
          source.connect(node);
        }
        if (ctx.state === 'suspended') return ctx.resume().then(function () { return s; });
        return s;
      }).then(function () {
        resetSeg();
        runningFlag = true;
        starting = null;
        // Capture devices commonly pop or thump as they open, and AGC/DC offset
        // takes a moment to settle. Analysing that produces a phantom onset on
        // the very first thing the detector ever hears.
        deafen(START_DEAFEN_MS);
        return true;
      }).catch(function (err) {
        starting = null;
        teardown();
        throw err;
      });
    })();

    return starting;
  }

  function teardown() {
    try { if (source) source.disconnect(); } catch (e) {}
    try { if (lowpass) lowpass.disconnect(); } catch (e) {}
    // Stop the tracks so the browser's recording indicator actually goes out.
    if (stream) {
      stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    }
    source = null; lowpass = null; stream = null;
    runningFlag = false;
  }

  function stop() {
    teardown();
    capturePending = null;
    resetSeg();
    // The context and the worklet node survive: re-adding the module on every
    // idle/busy transition would be wasteful, and the supervisor flips this
    // several times a minute.
    if (ctx && ctx.state === 'running') { try { ctx.suspend(); } catch (e) {} }
  }

  /* ---- enrolment ------------------------------------------------------- */

  function captureOne(timeoutMs) {
    if (capturePending) capturePending.reject(new Error('superseded'));
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        if (capturePending && capturePending.id === id) {
          capturePending = null;
          reject(new Error('timeout'));
        }
      }, timeoutMs || 6000);
      var id = {};
      capturePending = {
        id: id,
        resolve: function (s) { clearTimeout(timer); resolve(s); },
        reject: function (e) { clearTimeout(timer); reject(e); }
      };
    });
  }

  function cancelCapture() {
    if (capturePending) { capturePending.reject(new Error('cancelled')); capturePending = null; }
  }

  function addSample(sample) {
    if (!sample || !sample.n) return false;
    if (templates.length >= MAX_TEMPLATES) return false;
    templates.push(sample);
    calibrate();
    save();
    return true;
  }

  /* Audition a stored sample. Played through the engine's own 16 kHz context so
     there is no resampling between what was recorded and what you hear — if it
     sounds clipped or half-swallowed, that is genuinely what is being matched.

     Returns a promise that settles when playback ends, so the UI can show which
     row is playing. Rejects when the sample predates audio storage. */
  function playSample(i, onEnded) {
    var t = templates[i];
    if (!t || !t.audio || !t.audio.length) return Promise.reject(new Error('no-audio'));
    if (!AC) return Promise.reject(new Error('unsupported'));

    if (!ctx) {
      try { ctx = new AC({ sampleRate: TARGET_SR, latencyHint: 'interactive' }); }
      catch (e) { try { ctx = new AC(); } catch (e2) { return Promise.reject(e2); } }
    }

    var durMs = t.audio.length / (t.sr || TARGET_SR) * 1000;
    // Duration plus a margin for the speaker tail.
    deafen(durMs + 250);

    var resume = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();
    return resume.then(function () {
      var buf = ctx.createBuffer(1, t.audio.length, t.sr || TARGET_SR);
      buf.copyToChannel ? buf.copyToChannel(t.audio, 0)
                        : buf.getChannelData(0).set(t.audio);
      var src = ctx.createBufferSource();
      var gain = ctx.createGain();
      gain.gain.value = 1;
      src.buffer = buf;
      src.connect(gain);
      gain.connect(ctx.destination);
      return new Promise(function (resolve) {
        src.onended = function () { if (onEnded) onEnded(); resolve(durMs); };
        src.start();
      });
    });
  }

  function hasAudio(i) {
    return !!(templates[i] && templates[i].audio && templates[i].audio.length);
  }

  function removeSample(i) {
    if (i < 0 || i >= templates.length) return false;
    templates.splice(i, 1);
    calibrate();
    save();
    return true;
  }

  function clearSamples() {
    templates = [];
    baseThr = 0;
    selfSpread = null;
    save();
  }

  /* How far each sample sits from its nearest neighbour — a sample well above
     the rest is a bad recording (coughed, clipped, said differently) and is
     worth re-recording. */
  function sampleStats() {
    return templates.map(function (t, i) {
      var m = Infinity;
      for (var j = 0; j < templates.length; j++) {
        if (i === j) continue;
        var d = dtw(t.feat, t.n, templates[j].feat, templates[j].n, 0.2, 0);
        if (d < m) m = d;
      }
      return {
        ms: t.ms, nearest: isFinite(m) ? m : null, sr: t.sr,
        audio: !!(t.audio && t.audio.length)
      };
    });
  }

  load();

  window.KaceyWakeVoice = {
    supported: supported,
    running: function () { return runningFlag; },
    start: start,
    stop: stop,

    enrolled: function () { return templates.length >= MIN_TEMPLATES && baseThr > 0; },
    count: function () { return templates.length; },
    minSamples: MIN_TEMPLATES,
    maxSamples: MAX_TEMPLATES,

    captureOne: captureOne,
    cancelCapture: cancelCapture,
    addSample: addSample,
    removeSample: removeSample,
    clearSamples: clearSamples,
    sampleStats: sampleStats,
    spread: function () { return selfSpread; },
    playSample: playSample,
    hasAudio: hasAudio,
    deafen: deafen,

    threshold: threshold,
    sensitivity: function () { return sens; },
    setSensitivity: function (v) {
      sens = Math.max(0, Math.min(100, Math.round(v)));
      save();
    },

    onDetect: function (fn) { cbDetect = fn; },
    onScore: function (fn) { cbScore = fn; },
    onLevel: function (fn) { cbLevel = fn; },

    /* ---- test surface ----
       _featuresFrom runs the entire analysis chain (FFT -> mel -> MFCC -> CMVN
       -> deltas) over a raw buffer, which is what makes the maths verifiable
       without a microphone: synthesise two utterances, and check that two takes
       of the same one land closer together than two different ones. */
    _featuresFrom: function (samples, sr) {
      var f = new Featurizer(sr || TARGET_SR);
      var statics = [];
      for (var off = 0; off + FRAME <= samples.length; off += HOP) {
        statics.push(f.frame(samples, off).c);
      }
      if (statics.length < 2) return null;
      return { feat: finishFeatures(statics), n: statics.length, ms: statics.length * 10 };
    },
    /* _feed pushes a buffer through exactly the path the worklet feeds, so the
       segmentation, the VAD and the enrol/match handoff are all exercisable
       without a microphone. Requires _testInit first, since the featurizer is
       normally built by start(). */
    _testInit: function (sr) {
      effSr = sr || TARGET_SR;
      fz = new Featurizer(effSr);
      noiseFloor = null;
      room = []; roomLoud = null;
      resetSeg();
    },
    _feed: function (samples) {
      // in worklet-sized blocks, so block boundaries are exercised too
      var step = HOP * 2;
      for (var o = 0; o < samples.length; o += step) {
        onBlock(samples.subarray(o, Math.min(samples.length, o + step)));
      }
    },
    _match: match,
    _dtw: dtw,
    _finish: finishFeatures,
    _dim: DIM,
    _sr: function () { return effSr; },
    room: function () { return { floor: noiseFloor, loud: roomLoud, level: level }; }
  };
})();
