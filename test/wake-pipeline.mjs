/* End-to-end test of the runtime path, no microphone involved.

   Feeds synthetic audio through exactly the entry point the AudioWorklet uses,
   so this covers the parts the DSP test skipped: the adaptive VAD, segment
   gates, enrolment via captureOne/addSample, threshold calibration, and the
   detect callback.
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Defaults to the shipped module; pass a path to test a different copy.
const DEFAULT_SRC = process.argv[2] ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'wake-voice.js');

const SR = 16000;

globalThis.window = {};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.atob = (b) => Buffer.from(b, 'base64').toString('binary');

new Function(fs.readFileSync(DEFAULT_SRC, 'utf8'))();
const VW = globalThis.window.KaceyWakeVoice;

// ---- synthetic speech (same generator as dsp-test) ----------------------
function segment(ms, f0, f1, f2, gain) {
  const n = Math.round(SR * ms / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (let h = 1; h <= 24; h++) {
      const f = f0 * h;
      if (f > 7000) break;
      const w1 = 1 / (1 + Math.pow((f - f1) / 110, 2));
      const w2 = 0.8 / (1 + Math.pow((f - f2) / 160, 2));
      v += (w1 + w2) * Math.sin(2 * Math.PI * f * t) / h;
    }
    const env = Math.min(1, i / (SR * 0.012)) * Math.min(1, (n - i) / (SR * 0.02));
    out[i] = v * env * gain;
  }
  return out;
}
function silence(ms, noise = 0.0004) {
  const out = new Float32Array(Math.round(SR * ms / 1000));
  for (let i = 0; i < out.length; i++) out[i] = (Math.random() - 0.5) * noise;
  return out;
}
function join(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function utter(spec, { f0 = 190, rate = 1, gain = 0.3, lead = 350, tail = 420 } = {}) {
  return join([
    silence(lead),
    ...spec.map((s) => segment(s.ms * rate, f0 * (s.f0k || 1), s.f1, s.f2, gain)),
    silence(tail),
  ]);
}

const WORD_A = [
  { ms: 130, f1: 750, f2: 1750, f0k: 1.00 },
  { ms: 170, f1: 400, f2: 2300, f0k: 0.92 },
];
const WORD_B = [
  { ms: 150, f1: 400, f2: 2300, f0k: 0.95 },
  { ms: 140, f1: 700, f2: 1100, f0k: 1.05 },
  { ms: 120, f1: 300, f2: 900,  f0k: 0.90 },
];

// ---- observe the callbacks ---------------------------------------------
let detects = [], scores = [];
VW.onDetect((i) => detects.push(i));
VW.onScore((s) => scores.push(s));

VW._testInit(SR);

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); };

// ---- 1. enrolment ------------------------------------------------------
const enrolTakes = [
  utter(WORD_A, { f0: 190, rate: 1.00, gain: 0.30 }),
  utter(WORD_A, { f0: 205, rate: 1.12, gain: 0.12 }),
  utter(WORD_A, { f0: 176, rate: 0.92, gain: 0.50 }),
];
for (const [i, audio] of enrolTakes.entries()) {
  const p = VW.captureOne(5000);
  VW._feed(audio);
  const sample = await p;                       // segment closed -> capture resolved
  check(`enrol ${i + 1} captured`, sample && sample.n > 0, sample && `${sample.ms}ms`);
  check(`enrol ${i + 1} stored`, VW.addSample(sample));
}
check('enrolled after 3', VW.enrolled(), `count=${VW.count()} thr=${VW.threshold().toFixed(3)}`);
check('calibration produced a threshold', VW.threshold() > 0, `spread=${JSON.stringify(
  VW.spread() && { mean: +VW.spread().mean.toFixed(3), sd: +VW.spread().sd.toFixed(3) })}`);

// ---- 2. a fresh take of the same word must fire ------------------------
detects = []; scores = [];
VW._feed(utter(WORD_A, { f0: 197, rate: 1.05, gain: 0.24 }));
check('same word detected', detects.length === 1,
  `score=${scores.at(-1) && scores.at(-1).score.toFixed(3)} thr=${VW.threshold().toFixed(3)}`);

// ---- 3. a different word must not ---------------------------------------
await new Promise((r) => setTimeout(r, 1300));      // clear the re-arm window
detects = []; scores = [];
VW._feed(utter(WORD_B, { f0: 192, gain: 0.30 }));
check('different word rejected', detects.length === 0,
  `score=${scores.at(-1) ? scores.at(-1).score.toFixed(3) : 'no segment'}`);

// ---- 4. silence produces no segment at all ------------------------------
detects = []; scores = [];
VW._feed(silence(2000));
check('silence ignored', detects.length === 0 && scores.length === 0,
  `segments=${scores.length}`);

// ---- 5. continuous speech is dropped before matching --------------------
// This is the gate that keeps ordinary conversation from reaching the matcher.
detects = []; scores = [];
const rant = join([silence(300), ...Array.from({ length: 9 }, (_, i) =>
  segment(240, 180 + i * 9, 500 + i * 60, 1400 + i * 110, 0.3)), silence(400)]);
VW._feed(rant);
check('long utterance never matched', detects.length === 0 && scores.length === 0,
  `segments=${scores.length}`);

// ---- 6. the re-arm window suppresses a double trigger -------------------
detects = []; scores = [];
VW._feed(utter(WORD_A, { f0: 190, gain: 0.30, tail: 300 }));
const firstFired = detects.length;
VW._feed(utter(WORD_A, { f0: 190, gain: 0.30, lead: 300, tail: 300 }));
check('re-arm blocks an immediate repeat', firstFired === 1 && detects.length === 1,
  `first=${firstFired} total=${detects.length} segments=${scores.length}`);

// ---- 7. sensitivity moves the threshold in the right direction ----------
const mid = VW.threshold();
VW.setSensitivity(0);   const strict = VW.threshold();
VW.setSensitivity(100); const loose = VW.threshold();
VW.setSensitivity(50);
check('sensitivity scales threshold', strict < mid && mid < loose,
  `${strict.toFixed(3)} < ${mid.toFixed(3)} < ${loose.toFixed(3)}`);

// ---- 8. a stream that opens on digital silence must not go deaf ----------
// Seeded from the first frame, an all-zero buffer put the floor at -120 dB:
// every sound then read as speech, the segment never closed, the runaway guard
// abandoned it, and nothing was heard for seconds. Exactly the reported symptom.
VW.clearSamples();
VW._testInit(SR);
detects = []; scores = [];
VW._feed(new Float32Array(Math.round(SR * 0.5)));        // true digital silence
const capAfterSilence = VW.captureOne(5000);
VW._feed(utter(WORD_A, { f0: 190, gain: 0.30 }));
let heardAfterSilence = null;
try { heardAfterSilence = await capAfterSilence; } catch { /* stayed deaf */ }
check('hears speech after a silent stream open', !!heardAfterSilence,
  heardAfterSilence ? `${heardAfterSilence.ms}ms` : 'NOTHING CAPTURED');

// ---- 9. a genuinely short wake word enrols and matches ------------------
// 140 ms total — the length the old fixed 200 ms floor rejected outright.
const SHORT = [
  { ms: 70, f1: 750, f2: 1750, f0k: 1.00 },
  { ms: 70, f1: 400, f2: 2300, f0k: 0.92 },
];
VW.clearSamples();
VW._testInit(SR);
const shortEnrol = [[190, 1.00, 0.30], [203, 1.10, 0.14], [178, 0.92, 0.46]];
const shortLens = [];
for (const [f0, rate, gain] of shortEnrol) {
  const p = VW.captureOne(5000);
  VW._feed(utter(SHORT, { f0, rate, gain }));
  let s = null;
  try { s = await p; } catch { /* rejected */ }
  if (s) { shortLens.push(s.ms); VW.addSample(s); }
}
check('short word enrols', VW.count() === 3, `captured ${shortLens.join('/')} ms`);
check('short word calibrates', VW.enrolled() && VW.threshold() > 0,
  `thr=${VW.threshold().toFixed(3)}`);

await new Promise((r) => setTimeout(r, 1300));
detects = []; scores = [];
VW._feed(utter(SHORT, { f0: 196, rate: 1.04, gain: 0.25 }));
check('short word then detected', detects.length === 1,
  `score=${scores.at(-1) ? scores.at(-1).score.toFixed(3) : 'no segment'} thr=${VW.threshold().toFixed(3)}`);

// a long utterance must still be rejected when the templates are short
await new Promise((r) => setTimeout(r, 1300));
detects = []; scores = [];
VW._feed(utter(WORD_B, { f0: 192, gain: 0.30 }));
check('short templates still reject a longer word', detects.length === 0,
  `segments=${scores.length} score=${scores.at(-1) ? scores.at(-1).score.toFixed(3) : 'n/a'}`);

// restore the long-word enrolment for the storage test below
VW.clearSamples();
VW._testInit(SR);
for (const audio of enrolTakes) {
  const p = VW.captureOne(5000);
  VW._feed(audio);
  VW.addSample(await p);
}

// ---- 10. the button press must not become the sample --------------------
// A click is a sharp transient: it opens the detector, closes 220 ms later, and
// resolves the pending capture. First half of this test demonstrates that; the
// second half shows the dead time preventing it.
function click(gain = 0.5) {
  const n = Math.round(SR * 0.012);
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = (Math.random() * 2 - 1) * gain * Math.exp(-i / (SR * 0.003));
  return o;
}

VW.clearSamples();
VW._testInit(SR);
VW._feed(silence(400));                              // let the floor settle
{
  const p = VW.captureOne(3000);
  VW._feed(join([click(), silence(500)]));
  let got = null;
  try { got = await p; } catch { /* nothing captured */ }
  check('a click alone WOULD be captured (the bug)', !!got,
    got ? `captured ${got.ms}ms of click` : 'not captured');
}
{
  const p = VW.captureOne(3000);
  VW.deafen(300);                                    // the fix: ignore the press
  VW._feed(join([click(), silence(500)]));
  let got = null;
  try { got = await Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error('none')), 150))]); }
  catch { /* expected */ }
  check('with dead time the click is ignored', got === null,
    got ? `WRONGLY captured ${got.ms}ms` : 'ignored');

  // ... and the word said after the dead time still lands
  await new Promise((r) => setTimeout(r, 320));
  VW._feed(utter(WORD_A, { f0: 190, gain: 0.30 }));
  let word = null;
  try { word = await p; } catch { /* missed */ }
  check('the word after the dead time is captured', !!word && word.ms > 200,
    word ? `${word.ms}ms` : 'MISSED');
}

// ---- 11. enrolled samples keep their audio, for playback ----------------
// Features cannot be played back (c0 dropped, CMVN applied, phase gone), so the
// raw segment is copied out of the ring. Playback is how a clipped or
// half-swallowed recording becomes visible at all.
VW.clearSamples();
VW._testInit(SR);
const kept = await (async () => {
  const p = VW.captureOne(5000);
  VW._feed(utter(WORD_A, { f0: 190, gain: 0.30 }));
  try { return await p; } catch { return null; }
})();
check('sample carries audio', !!(kept && kept.audio && kept.audio.length),
  kept && kept.audio ? `${kept.audio.length} samples` : 'none');
if (kept && kept.audio) {
  const HOP = 160, FRAME = 400;
  const expect = (kept.n - 1) * HOP + FRAME;
  check('audio span matches the frame span', kept.audio.length === expect,
    `${kept.audio.length} vs ${expect}`);
  let peak = 0;
  for (const v of kept.audio) peak = Math.max(peak, Math.abs(v));
  check('audio is not silent', peak > 0.01, `peak ${peak.toFixed(3)}`);
  VW.addSample(kept);
  check('hasAudio reports it', VW.hasAudio(0) === true);
}

// ---- 11. storage round-trips, audio included ---------------------------
// addSample -> save() -> load() is what happens across a page reload.
let saved = null;
globalThis.localStorage.setItem = (k, v) => { saved = v; };
VW.setSensitivity(37);                                  // triggers save()
check('save wrote something', !!saved, saved ? `${saved.length} chars` : 'nothing');
if (saved) {
  const parsed = JSON.parse(saved);
  check('save round-trip shape', parsed.v === 2 && parsed.samples.length === 1 &&
    parsed.sens === 37 && parsed.dim === VW._dim,
    `v=${parsed.v} n=${parsed.samples.length} sens=${parsed.sens} dim=${parsed.dim}`);
  check('audio is in the payload', !!parsed.samples[0].a,
    parsed.samples[0].a ? `${parsed.samples[0].a.length} chars base64` : 'missing');

  // int16 is the storage format: verify the decoded audio matches the original
  // closely enough that playback represents what was actually matched.
  if (parsed.samples[0].a && kept) {
    const bin = globalThis.atob(parsed.samples[0].a);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const back = new Int16Array(bytes.buffer);
    let maxErr = 0;
    for (let i = 0; i < back.length; i++) {
      maxErr = Math.max(maxErr, Math.abs(back[i] / 32767 - kept.audio[i]));
    }
    check('audio survives int16 quantisation', back.length === kept.audio.length &&
      maxErr < 1e-4, `len ${back.length} maxErr ${maxErr.toExponential(2)}`);
  }
}

// ---- 12. a noisy room: background bursts only ~10 dB under the word ------
// What kaceybody's bedroom actually sounds like (a TV or music next door): the
// level between words never falls near the floor. Every enrolment used to run
// on to the 3 s stop, and the templates were three seconds of room with a word
// somewhere in them — so nothing ever matched.
function murmur(ms, seed = 1) {
  // Voiced-ish background: short vowel-like bursts at random pitch and level.
  let x = seed;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const parts = [];
  let left = ms;
  while (left > 0) {
    const len = 60 + Math.round(rnd() * 180);
    parts.push(rnd() < 0.3 ? silence(len, 0.01)
      : segment(len, 110 + rnd() * 120, 300 + rnd() * 600, 1000 + rnd() * 1500, 0.02 + rnd() * 0.03));
    left -= len;
  }
  return join(parts);
}
function mix(a, b) { const o = new Float32Array(Math.max(a.length, b.length)); for (let i = 0; i < o.length; i++) o[i] = (a[i] || 0) + (b[i] || 0); return o; }
const inRoom = (word, seed) => mix(join([silence(600, 0), word, silence(1500, 0)]), murmur(600 + word.length / 16 + 1500, seed));

VW.clearSamples();
VW._testInit(SR);
VW._feed(murmur(2500, 7));                            // the room, before anything
const roomLens = [];
for (const [i, [f0, rate, gain]] of [[190, 1.00, 0.30], [204, 1.08, 0.26], [180, 0.94, 0.34]].entries()) {
  const p = VW.captureOne(5000);
  VW._feed(inRoom(utter(WORD_A, { f0, rate, gain, lead: 0, tail: 0 }), 11 + i));
  let got = null;
  try { got = await p; } catch { /* stayed open */ }
  if (got) { roomLens.push(got.ms); VW.addSample(got); }
}
check('noisy room: every take closes', roomLens.length === 3, `captured ${roomLens.join('/')} ms`);
check('noisy room: takes are the word, not the room', roomLens.length === 3 && roomLens.every((ms) => ms < 700),
  `${roomLens.join('/')} ms (the word is ~300 ms)`);

await new Promise((r) => setTimeout(r, 1300));
detects = []; scores = [];
VW._feed(inRoom(utter(WORD_A, { f0: 196, rate: 1.03, gain: 0.28, lead: 0, tail: 0 }), 21));
check('noisy room: a fresh take is detected', detects.length === 1,
  `score=${scores.map((x) => (isFinite(x.score) ? x.score.toFixed(2) : 'inf') + (x.hit ? '✓' : '')).join(' ')} thr=${VW.threshold().toFixed(2)}`);

await new Promise((r) => setTimeout(r, 1300));
detects = []; scores = [];
VW._feed(murmur(6000, 31));
check('noisy room: the room alone never triggers', detects.length === 0, `segments=${scores.length}`);

// ---- report -------------------------------------------------------------
let bad = 0;
for (const r of results) {
  if (!r.pass) bad++;
  console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.detail ? '   (' + r.detail + ')' : ''}`);
}
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);
