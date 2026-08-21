/* Verify the wake-word DSP without a microphone.

   Synthesise two distinct "words" as sequences of formant-like tone pairs, take
   several variants of each (different pitch, loudness, speed, plus noise), and
   check the property the detector depends on:

       distance(same word, different take)  <<  distance(different word)

   If that ordering does not hold, no threshold can work.
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Defaults to the shipped module; pass a path to test a different copy.
const DEFAULT_SRC = process.argv[2] ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'wake-voice.js');

const SR = 16000;

// --- browser shims, enough to load the module as-is -----------------------
globalThis.window = {};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.atob = (b) => Buffer.from(b, 'base64').toString('binary');
// navigator/AudioContext are only touched by start(), which this harness never calls.

const src = fs.readFileSync(DEFAULT_SRC, 'utf8');
new Function(src)();
const VW = globalThis.window.KaceyWakeVoice;
if (!VW) throw new Error('module did not attach KaceyWakeVoice');

// --- synthetic speech ----------------------------------------------------
// A vowel-ish sound: a buzzy source at f0 shaped by two formants.
function segment(ms, f0, f1, f2, gain) {
  const n = Math.round(SR * ms / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // a few harmonics of f0, boosted near the formants
    let v = 0;
    for (let h = 1; h <= 24; h++) {
      const f = f0 * h;
      if (f > 7000) break;
      const w1 = 1 / (1 + Math.pow((f - f1) / 110, 2));
      const w2 = 0.8 / (1 + Math.pow((f - f2) / 160, 2));
      v += (w1 + w2) * Math.sin(2 * Math.PI * f * t) / h;
    }
    // per-segment attack/decay so frames are not stationary
    const env = Math.min(1, i / (SR * 0.012)) * Math.min(1, (n - i) / (SR * 0.02));
    out[i] = v * env * gain;
  }
  return out;
}

function utterance(spec, { f0 = 190, rate = 1, gain = 0.3, noise = 0.0005 } = {}) {
  const parts = [new Float32Array(Math.round(SR * 0.25))];       // leading silence
  for (const s of spec) {
    parts.push(segment(s.ms * rate, f0 * (s.f0k || 1), s.f1, s.f2, gain));
  }
  parts.push(new Float32Array(Math.round(SR * 0.3)));            // trailing silence
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  for (let i = 0; i < out.length; i++) out[i] += (Math.random() - 0.5) * noise;
  return out;
}

// "KC" — two syllables, front vowel then a diphthong-ish glide
const WORD_A = [
  { ms: 130, f1: 750, f2: 1750, f0k: 1.00 },
  { ms: 170, f1: 400, f2: 2300, f0k: 0.92 },
];
// a different word with the same phones in the other order + a third
const WORD_B = [
  { ms: 150, f1: 400, f2: 2300, f0k: 0.95 },
  { ms: 140, f1: 700, f2: 1100, f0k: 1.05 },
  { ms: 120, f1: 300, f2: 900,  f0k: 0.90 },
];

const takesA = [
  utterance(WORD_A, { f0: 190, rate: 1.00, gain: 0.30 }),
  utterance(WORD_A, { f0: 205, rate: 1.12, gain: 0.11 }),   // higher, slower, quiet
  utterance(WORD_A, { f0: 176, rate: 0.90, gain: 0.55 }),   // lower, faster, loud
  utterance(WORD_A, { f0: 198, rate: 1.05, gain: 0.22, noise: 0.004 }),
];
const takesB = [
  utterance(WORD_B, { f0: 192, rate: 1.00, gain: 0.30 }),
  utterance(WORD_B, { f0: 208, rate: 1.08, gain: 0.18 }),
];

const featsA = takesA.map((s) => VW._featuresFrom(s, SR));
const featsB = takesB.map((s) => VW._featuresFrom(s, SR));

const d = (x, y) => VW._dtw(x.feat, x.n, y.feat, y.n, 0.2, 0);

const within = [];
for (let i = 0; i < featsA.length; i++)
  for (let j = i + 1; j < featsA.length; j++) within.push(d(featsA[i], featsA[j]));

const across = [];
for (const a of featsA) for (const b of featsB) across.push(d(a, b));

const selfD = d(featsA[0], featsA[0]);

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const fmt = (a) => a.map((v) => v.toFixed(3)).join(', ');

console.log('feature dim              :', VW._dim);
console.log('frames per take (word A) :', featsA.map((f) => f.n).join(', '));
console.log('identical to itself      :', selfD.toFixed(6), '(must be 0)');
console.log('same word, other takes   :', fmt(within), ' mean', mean(within).toFixed(3));
console.log('different word           :', fmt(across), ' mean', mean(across).toFixed(3));
console.log('separation (across/within):', (mean(across) / mean(within)).toFixed(2) + 'x');
console.log('worst same >= best diff? :', Math.max(...within) >= Math.min(...across) ? 'OVERLAP' : 'clean gap');

// the calibration rule the app uses, applied to these takes
const nearest = featsA.map((x, i) => Math.min(...featsA.filter((_, j) => j !== i).map((y) => d(x, y))));
const m = mean(nearest);
const sd = Math.sqrt(mean(nearest.map((v) => (v - m) * (v - m))));
const thr = Math.min(Math.max(m + 1.5 * sd, Math.max(...nearest) * 1.08, m * 1.15), m * 2.1);
console.log('\ncalibrated threshold     :', thr.toFixed(3));
console.log('takes of A accepted      :', nearest.filter((v) => v <= thr).length + '/' + nearest.length);
console.log('takes of B rejected      :',
  featsB.filter((b) => Math.min(...featsA.map((a) => d(a, b))) > thr).length + '/' + featsB.length);

const ok = selfD < 1e-9 &&
  Math.max(...within) < Math.min(...across) &&
  nearest.every((v) => v <= thr) &&
  featsB.every((b) => Math.min(...featsA.map((a) => d(a, b))) > thr);
console.log('\nRESULT:', ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
