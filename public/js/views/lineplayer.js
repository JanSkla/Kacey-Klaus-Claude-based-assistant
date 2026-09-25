/* =========================================================================
   Reading a brief aloud, one line at a time.

   The Brief view and the morning screen both do this, so it is here once:
   the lines, which one is current, and the advance that waits for the speech
   queue to drain rather than racing it — a slow XTTS run must not let the
   highlight run ahead of the voice. Tapping a line re-reads that line.

   Speech goes through the same TTS as everything else (voice/tts.js).
   ========================================================================= */

import { state } from '../core/state.js';
import { feedTTS, flushTTS, cancelSpeech, primeTTS, playClip } from '../voice/tts.js';

/* Roughly how long a line takes to say — for the progress bar and the clock
   only; the advance itself waits for the queue. */
export function secondsFor(text) { return Math.max(2, Math.round(String(text).length / 14)); }

export function clockText(secs) {
  return ('0' + Math.floor(secs / 60)).slice(-2) + ':' + ('0' + (secs % 60)).slice(-2);
}

/**
 * A player. `onChange(what)` fires on every change: 'lines', 'line' (the
 * current line moved), 'play', 'pause', 'end' (the last line finished).
 */
export function makeLinePlayer(onChange) {
  var lines = [];
  var audio = [];            // per line: a URL of a clip rendered ahead of time, or null
  var index = 0;
  var playing = false;
  var finished = false;
  var timer = 0;

  function changed(what) { try { onChange(what); } catch (e) { console.error('[kacey] player listener failed', e); } }

  function speak(i) {
    if (state.muted || !lines[i]) return;
    primeTTS();
    cancelSpeech();
    // A clip the night rendered plays as it is; otherwise synthesise now.
    if (audio[i]) { playClip(audio[i], lines[i]); return; }
    feedTTS(lines[i] + ' ');
    flushTTS();
  }

  function tick() {
    clearTimeout(timer);
    if (!playing) return;
    timer = setTimeout(function () {
      if (state.ttsPending > 0) { tick(); return; }
      if (index + 1 >= lines.length) {
        playing = false; finished = true;
        changed('end');
        return;
      }
      index++;
      speak(index);
      changed('line');
      tick();
    }, 900);
  }

  var api = {
    lines: function () { return lines; },
    index: function () { return index; },
    playing: function () { return playing; },
    finished: function () { return finished; },

    /** `clips` (optional): per line, the URL of audio rendered ahead of time. */
    setLines: function (next, clips) {
      clearTimeout(timer);
      if (playing) cancelSpeech();
      lines = Array.isArray(next) ? next.slice() : [];
      audio = Array.isArray(clips) ? clips.slice() : [];
      index = 0; playing = false; finished = false;
      changed('lines');
    },

    play: function (on) {
      if (on && !lines.length) return;
      if (on && finished) { index = 0; finished = false; }
      playing = !!on;
      if (playing) { speak(index); tick(); changed('play'); }
      else { clearTimeout(timer); cancelSpeech(); changed('pause'); }
    },

    /** Re-read line `i` (tap a line); keeps playing on from there if it was. */
    jump: function (i) {
      if (i < 0 || i >= lines.length) return;
      index = i; finished = false;
      speak(i);
      changed('line');
      if (playing) tick();
    },

    restart: function () { index = 0; finished = false; api.play(true); },

    stop: function () { if (playing) api.play(false); },

    totalSeconds: function () { return lines.reduce(function (a, l) { return a + secondsFor(l); }, 0); },
    elapsedSeconds: function () {
      if (finished) return api.totalSeconds();
      return lines.slice(0, index + 1).reduce(function (a, l) { return a + secondsFor(l); }, 0);
    }
  };
  return api;
}
