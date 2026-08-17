/* =========================================================================
   Kacey — microphone tap for the personal wake word.

   Runs on the audio thread and does the least possible: optionally decimate,
   pack into fixed blocks, post to the main thread. All the DSP lives in
   wake-voice.js, where it is testable and where a slow frame cannot cause an
   audio glitch.

   A worklet rather than ScriptProcessorNode because the mic stays open the
   whole time the app is idle: a node on the main thread drops samples whenever
   the page does layout, and a wake word cut in half is a wake word missed.
   ========================================================================= */

class WakeTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    var o = (options && options.processorOptions) || {};
    // 1 when the context already runs at the target rate (the normal case).
    this.decim = Math.max(1, Math.round(o.decimation || 1));
    this.out = new Float32Array(Math.max(32, o.blockSize || 320));
    this.n = 0;
    this.phase = 0;
  }

  process(inputs) {
    var ch = inputs[0] && inputs[0][0];
    // No input yet (device still opening) — stay alive, do not tear the node down.
    if (!ch) return true;

    for (var i = 0; i < ch.length; i++) {
      if (this.phase === 0) {
        this.out[this.n++] = ch[i];
        if (this.n === this.out.length) {
          // Copy: this.out is reused on the next render quantum.
          this.port.postMessage(this.out.slice(0));
          this.n = 0;
        }
      }
      this.phase = (this.phase + 1) % this.decim;
    }
    return true;
  }
}

registerProcessor('kacey-wake-tap', WakeTap);
