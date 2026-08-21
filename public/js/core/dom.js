/* =========================================================================
   The elements of the main chrome, looked up once.

   Only the shared furniture lives here — the orb, the log, the composer, the
   top-bar buttons. Elements belonging to exactly one panel (the voiceprint
   sheet, the telemetry rails, the hue dial, the calendar) are looked up by
   the module that owns them, so a panel can be read on its own.

   Safe to resolve at import time: app.js is a module script, which the browser
   defers until the document has been parsed.
   ========================================================================= */

export var $ = function (id) { return document.getElementById(id); };

export var orb = $('orb'), orbAmp = $('orbAmp');
export var conn = $('conn'), connLabel = $('connLabel');
export var logwrap = $('logwrap'), log = $('log');
export var hintEl = $('hint'), alertEl = $('alert'), announcer = $('announcer');
export var form = $('composer'), input = $('input'), sendBtn = $('send'), stopBtn = $('stop');
export var micBtn = $('mic'), micNote = $('micNote');
export var muteBtn = $('mute'), langSel = $('lang'), langLabel = $('langLabel');
export var voiceSel = $('voice');
export var wakeBtn = $('wake');
export var inputLabel = $('inputLabel'), mockBadge = $('mockBadge');

/* Motion preference is read like an element: one live object everything shares,
   with a no-op stand-in so callers never have to feature-test it. */
export var reduceMotion = window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : { matches: false, addEventListener: function () {} };
