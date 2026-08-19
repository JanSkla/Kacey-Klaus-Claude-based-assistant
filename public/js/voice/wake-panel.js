/* =========================================================================
   WAKE WORD BY VOICE — matching the sound, not the transcript, plus the
   tuning sheet that makes it adjustable.

   The transcript path in wake.js asks a Czech recogniser to spell a
   two-syllable non-word, then guesses at the spellings it might produce. That
   is a losing game: there is no correct spelling, so the answer changes between
   takes and the list can only chase the last one.

   This path compares the SOUND against recordings of one particular person
   saying it — see wake-voice.js for the DSP. It is speaker-dependent, which is
   exactly what a personal wake word wants, and it needs no network.

   Three things this buys beyond consistency:
     - no audio leaves the machine (the transcript path streamed the room to a
       cloud recogniser all day long),
     - no restart churn from the recogniser timing itself out,
     - it works while offline.

   The panel is not decoration. "It did not hear me" is unanswerable without
   numbers, so every sample shows its distance from the last live attempt and
   from its neighbours, and can be played back exactly as the detector hears it.

   wake.js and this module import each other: that one owns the on/off switch
   and the arbitration, this one owns the engine and the UI describing it.
   ========================================================================= */

import { state, LS_WAKE_MODE } from '../core/state.js';
import { $ } from '../core/dom.js';
import { primeTTS } from './tts.js';
import { playWakeChime, WAKE_CHIME_MS } from './chime.js';
import { startRecognition } from './recognition.js';
import {
  wakeIsEnabled, wakeIsBlocked, setWakeBlocked, applyWakeUI, superviseWake
} from './wake.js';

/* The DSP lives in wake-voice.js, a classic script, because the Node tests in
   test/wake-dsp.mjs load it by evaluating the source. It is inert without
   enrolled samples, and absent entirely on a browser with no AudioWorklet. */
var VW = window.KaceyWakeVoice || null;

var mode = 'voice';            // preference; falls back on its own if unusable
var voiceHits = 0;
var voiceFailUntil = 0;        // after a mic failure, stop hammering the device
var vwPanelOpen = false;

var vwPanel = $('vwPanel'), vwOpenBtn = $('vwOpen'), vwCloseBtn = $('vwClose');
var vwState = $('vwState'), vwList = $('vwList'), vwRecBtn = $('vwRec');
var vwRecNote = $('vwRecNote'), vwFill = $('vwFill'), vwScore = $('vwScore');
var vwSens = $('vwSens'), vwSensVal = $('vwSensVal'), vwClearBtn = $('vwClear');
var vwLevel = $('vwLevel'), vwModeVoice = $('vwModeVoice'), vwModeAsr = $('vwModeAsr');
var vwSpread = $('vwSpread');

export function wakeMode() { return mode; }

function voiceWakeUsable() { return !!(VW && VW.supported()); }

function voiceWakeReady() { return voiceWakeUsable() && VW.enrolled(); }

/* Which detector the supervisor should run. The panel forces the voice engine
   on even with nothing enrolled — otherwise you could never record the first
   sample, because the transcript listener would be holding the microphone. */
export function voiceWakePriority() {
  if (!voiceWakeUsable()) return false;
  return vwPanelOpen || (mode === 'voice' && VW.enrolled());
}

export function voiceWakeActive() { return mode === 'voice' && voiceWakeReady(); }

function voiceShouldRun() {
  if (!voiceWakeUsable() || Date.now() < voiceFailUntil) return false;
  // Never while Kacey is speaking: echo cancellation helps but does not make
  // her own voice inaudible to her own detector.
  if (state.ttsPending > 0 || document.hidden) return false;
  if (vwPanelOpen) return true;                 // tuning needs it live
  if (!wakeIsEnabled() || wakeIsBlocked()) return false;
  if (state.listening || state.micDesired) return false;
  return VW.enrolled() && state.conn === 'online';
}

export function voiceWakeSupervise() {
  if (voiceShouldRun()) {
    if (!VW.running()) {
      VW.start().catch(function (err) { onVoiceWakeError(err); });
    }
  } else if (VW.running()) {
    VW.stop();
  }
}

export function voiceWakeStop() { if (VW && VW.running()) VW.stop(); }

function onVoiceWakeError(err) {
  var name = (err && err.name) || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    // Same microphone, same refusal — the transcript path cannot work either.
    setWakeBlocked(true);
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

export function onVoiceDetect(info) {
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
  return mode === 'voice' ? n + ' vzorků · aktivní' : n + ' vzorků · vypnuto';
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
  vwModeVoice.setAttribute('aria-pressed', String(mode === 'voice'));
  vwModeAsr.setAttribute('aria-pressed', String(mode !== 'voice'));
  vwModeVoice.disabled = !canVoice;
  vwModeVoice.title = canVoice
    ? 'Porovnává zvuk s tvými nahrávkami — offline'
    : 'Nahraj nejdřív ' + (VW ? VW.minSamples : 3) + ' vzorky';
}

export function setWakeMode(next) {
  mode = next === 'voice' ? 'voice' : 'asr';
  try { localStorage.setItem(LS_WAKE_MODE, mode); } catch (e) {}
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

export function openVoicePanel(open) {
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

/* The wake button's label describes whichever engine is live, so wake.js asks
   this module to repaint its own line rather than reaching for the element. */
export function refreshVoiceStateLabel() {
  if (vwState) vwState.textContent = voiceStateLabel();
}

/* ---- console surface --------------------------------------------------- */

export function voiceStatus() {
  var usable = voiceWakeUsable();
  return {
    supported: usable,
    enrolled: usable && VW.enrolled(),
    samples: usable ? VW.count() : 0,
    active: voiceWakeActive(),
    priority: voiceWakePriority(),
    shouldRun: voiceShouldRun(),
    running: usable && VW.running(),
    threshold: usable ? VW.threshold() : 0,
    sensitivity: usable ? VW.sensitivity() : null,
    hits: voiceHits,
    sr: usable ? VW._sr() : null
  };
}

/* ---- wiring ------------------------------------------------------------
   Called once from app.js. The engine callbacks and the panel controls are
   registered together because they are two halves of the same thing: the panel
   exists to show what the engine is hearing. */

export function initVoiceWake() {
  if (VW) {
    VW.onDetect(onVoiceDetect);
    VW.onScore(showScore);
    VW.onLevel(function (v) {
      if (vwPanelOpen && vwLevel) vwLevel.style.setProperty('--lvl', v.toFixed(3));
    });

    try {
      var savedMode = localStorage.getItem(LS_WAKE_MODE);
      if (savedMode === 'asr' || savedMode === 'voice') mode = savedMode;
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

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && vwPanel && !vwPanel.hidden) {
      openVoicePanel(false);
      ev.stopImmediatePropagation();
      ev.preventDefault();
    }
  }, true);
}
