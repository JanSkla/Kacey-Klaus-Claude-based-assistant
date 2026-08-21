/* =========================================================================
   Kacey — spoken commands that are NOT messages.

   Both families below are handled entirely in the browser. Nothing is sent to
   Kacey, nothing is written to the log, and she does not reply — replying to
   "to je vše, díky" with a farewell only adds another thing to sit through.
   The log also has to mirror what the model actually saw, so a command that
   never reached it must not appear there either.

     'end'        stop the hands-free loop. Said AFTER a reply has finished:
                  the microphone closes and does not re-open. Nothing else
                  changes — the wake word is left exactly as configured, so
                  "KC" starts the next conversation as usual.

     'interrupt'  said DURING a reply: stop talking and stop generating, now.
                  The conversation stays open.

   WHY A LIST AND NOT THE MODEL
   These have to take effect before deciding whether to re-open the microphone,
   and 'interrupt' has to take effect while a reply is still streaming — asking
   the model would mean waiting for the very thing being cancelled. A list is
   instant, deterministic, works offline, and can be unit tested.

   HOW IT AVOIDS FIRING ON ORDINARY SPEECH
   1. Long utterances are ignored outright — a command is short.
   2. Politeness and filler are stripped from the ENDS only ("tak to je vše,
      díky Kacey" -> "to je vše"), never from the middle, so a request that
      happens to contain those words is untouched.
   3. What remains must match EXACTLY. "To je vše, co potřebuju vědět o té
      schůzce" matches nothing and is sent on as the question it is.
   4. A small set of unmistakable closings is also matched at the END of a longer
      utterance, so "zapiš mi schůzku v deset, to je vše" is not possible — that
      one has to be sent. Only phrases that cannot be part of a request qualify.

   Getting this wrong in the 'end' direction is quiet and annoying: you keep
   talking and she stopped listening. So the matching is deliberately narrow.
   ========================================================================= */

(function () {
  'use strict';

  /* Deliberately a private copy rather than a shared helper: this file has to
     stand alone to be loadable in a test harness without the DOM. */
  function normalize(s) {
    var out = String(s == null ? '' : s).toLowerCase();
    if (out.normalize) out = out.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return out.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  var MAX_WORDS = 9;         // a command is short; anything longer is a request

  /* Strippable from the edges only. Note what is NOT here: "nic" is load-bearing
     inside phrases, and a bare "díky" mid-conversation is ordinary courtesy
     rather than a goodbye — it only counts as padding AROUND a command. */
  var PAD = [
    // Czech courtesy and filler
    'diky', 'dik', 'dekuji', 'dekuju', 'moc', 'prosim', 'tak', 'no', 'jo',
    'ok', 'okej', 'dobre', 'fajn', 'super', 'ti', 'tobe', 'vam', 'te', 'uz',
    'kacey', 'kc', 'kejsi', 'kaca',
    // English
    'thanks', 'thank', 'you', 'please', 'okay', 'okey', 'alright', 'right',
    'cool', 'great', 'so', 'well', 'hey', 'and', 'then', 'now'
  ];

  /* ---- 'interrupt': be quiet, right now -------------------------------
     Checked before 'end', because it is the more urgent of the two and because
     these phrases are about her OUTPUT, not about the microphone. */
  var INTERRUPT = [
    'ticho', 'bud ticho', 'ticho uz',
    'mlc', 'mlcte', 'bud potichu', 'potichu',
    'prestan mluvit', 'nemluv', 'nemluv uz', 'dost uz',
    'quiet', 'be quiet', 'hush', 'stop talking', 'stop speaking', 'shut up'
  ];

  /* ---- 'end': that is us finished --------------------------------------- */
  var END = [
    // Czech — "that is everything"
    'to je vse', 'to je vsechno', 'to bude vse', 'to bude vsechno',
    'to je zatim vse', 'to je pro dnes vse', 'to je vse pro dnes',
    'vse', 'vsechno',
    // nothing further
    'nic', 'nic dalsiho', 'nic vic', 'nic dalsiho nepotrebuji',
    // "už stačí" reaches here as "stačí", since "už" strips as padding
    'to staci', 'staci to', 'staci',
    // done
    'koncime', 'konec', 'hotovo', 'jsme hotovi', 'skoncili jsme',
    // farewells
    'dobrou noc', 'dobrou', 'na shledanou', 'nashledanou', 'sbohem', 'mej se',
    // dismissal, in the register the persona uses
    'muzes jit', 'jsi volna', 'odpocin si', 'to je vse muzes jit',
    // "stop listening" now means the same as any other goodbye: the loop ends,
    // and the wake word is a separate setting with its own button.
    'prestan poslouchat', 'prestan me poslouchat', 'uz neposlouchej',
    'neposlouchej', 'uz me neposlouchej', 'vypni mikrofon', 'vypni si mikrofon',
    'vypni poslouchani', 'nech me byt', 'dej mi pokoj',

    // English
    "that's all", 'that is all', 'that will be all', 'that would be all',
    'nothing else', 'nothing more', "that's enough", 'that is enough',
    'goodbye', 'good bye', 'bye', 'bye bye', 'good night', 'goodnight',
    "we're done", 'we are done', "i'm done", 'i am done',
    'you can go', 'can go', 'that will do',
    'stop listening', 'stop the mic', 'mute the mic', 'turn off the mic',
    'turn the mic off', 'stop recording', 'leave me alone'
  ];

  /* Also matched at the END of a longer utterance. Only phrases that cannot
     plausibly be part of a request belong here — "nic" or "stačí" can answer a
     question, so they stay out. */
  var END_TAIL = [
    'to je vse', 'to je vsechno', 'to bude vse', 'to bude vsechno',
    'to je zatim vse', 'to je vse pro dnes', 'to je pro dnes vse',
    'dobrou noc', 'na shledanou', 'nashledanou',
    "that's all", 'that is all', 'that will be all', 'good night'
  ];

  // Patterns are authored readably and normalised once, so "that's all" and the
  // transcript "that s all" are the same thing here.
  function prep(list) {
    var out = {};
    for (var i = 0; i < list.length; i++) out[normalize(list[i])] = true;
    return out;
  }
  function prepArr(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(normalize(list[i]));
    return out;
  }

  var END_SET = prep(END);
  var INTERRUPT_SET = prep(INTERRUPT);
  var INTERRUPT_ARR = prepArr(INTERRUPT);
  var TAIL_ARR = prepArr(END_TAIL);
  var PAD_SET = prep(PAD);

  function stripPadding(words) {
    var a = 0, b = words.length;
    while (a < b && PAD_SET[words[a]]) a++;
    while (b > a && PAD_SET[words[b - 1]]) b--;
    return words.slice(a, b);
  }

  function endsWithPhrase(words, phrase) {
    var p = phrase.split(' ');
    if (p.length >= words.length) return false;      // that is a whole match, not a tail
    for (var i = 0; i < p.length; i++) {
      if (words[words.length - p.length + i] !== p[i]) return false;
    }
    return true;
  }

  /* -> 'interrupt' | 'end' | null */
  function classify(text) {
    var norm = normalize(text);
    if (!norm) return null;

    var words = norm.split(' ');
    if (words.length > MAX_WORDS) return null;

    var core = stripPadding(words);
    if (!core.length) return null;                   // pure courtesy, not a command
    var joined = core.join(' ');

    if (INTERRUPT_SET[joined] || INTERRUPT_SET[norm]) return 'interrupt';
    if (END_SET[joined] || END_SET[norm]) return 'end';

    for (var i = 0; i < TAIL_ARR.length; i++) {
      if (endsWithPhrase(core, TAIL_ARR[i])) return 'end';
    }
    return null;
  }

  /* Does this text CONTAIN an interrupt phrase anywhere?

     Used to stop Kacey interrupting herself. The barge-in listener hears her
     through the speakers, so if the reply being spoken contains "ticho", a
     microphone hearing "ticho" is the loudspeaker rather than the room. */
  function mentionsInterrupt(text) {
    var n = normalize(text);
    if (!n) return false;
    var padded = ' ' + n + ' ';
    for (var i = 0; i < INTERRUPT_ARR.length; i++) {
      if (padded.indexOf(' ' + INTERRUPT_ARR[i] + ' ') !== -1) return true;
    }
    return false;
  }

  window.KaceyClosing = {
    classify: classify,
    mentionsInterrupt: mentionsInterrupt,
    normalize: normalize,
    // exposed so the test harness can report coverage rather than guess at it
    _counts: function () {
      return {
        end: END.length, tail: END_TAIL.length,
        interrupt: INTERRUPT.length, pad: PAD.length
      };
    }
  };
})();
