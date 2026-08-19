/* =========================================================================
   The transcript, the status line, and the alert strip.

   Everything the user reads. Server text reaches the DOM through textContent
   and nothing else — a reply is untrusted input, and there is no case where
   Kacey needs to emit markup.

   The log also has to mirror what the model actually saw: anything the browser
   handled by itself (a spoken command, a wake word) must not appear here.
   ========================================================================= */

import { state } from '../core/state.js';
import { t } from '../core/i18n.js';
import * as dom from '../core/dom.js';
import { syncOrb } from './orb.js';
import { flushTTS, feedTTS } from '../voice/tts.js';

/* ---- scrolling -------------------------------------------------------- */

/* Follow the tail unless the user has scrolled up to read something. */
var stick = true;
dom.logwrap.addEventListener('scroll', function () {
  stick = dom.logwrap.scrollHeight - dom.logwrap.scrollTop - dom.logwrap.clientHeight < 140;
}, { passive: true });

function scrollEnd(force) {
  if (force) stick = true;
  if (stick) dom.logwrap.scrollTop = dom.logwrap.scrollHeight;
}

/* ---- rows ------------------------------------------------------------- */

export function addMessage(role, text) {
  var li = document.createElement('li');
  li.className = 'msg msg--' + role;

  if (role !== 'system') {
    var who = document.createElement('p');
    who.className = 'msg__who';
    who.textContent = role === 'user' ? t().you : t().kacey;
    li.appendChild(who);
  }

  var bubble = document.createElement('p');
  bubble.className = 'msg__bubble';
  var node = document.createTextNode(text || '');
  bubble.appendChild(node);
  li.appendChild(bubble);

  dom.log.appendChild(li);
  scrollEnd(role === 'user');
  return { li: li, bubble: bubble, node: node };
}

var current = null; // the assistant bubble currently being streamed into

/* Kacey speaks once BEFORE reaching for memory or the calendar ("Podívám se do
   kalendáře.") and again after. Those are two different utterances, so they get
   two bubbles — and the first one is sealed and spoken the moment the tool call
   starts, which is the earliest instant we know it is complete. Waiting for a
   sentence boundary would delay the very thing that exists to feel immediate. */
export function sealPreamble() {
  if (!current || !current.node.nodeValue.trim()) return;
  current.bubble.classList.remove('is-streaming');
  current.bubble.classList.add('msg__bubble--preamble');
  current.li.classList.add('msg--preamble');
  current = null;                    // the answer will open a fresh bubble
  flushTTS();                        // speak it now, terminator or not
}

export function beginAssistant() {
  if (current) return current;
  current = addMessage('assistant', '');
  current.bubble.classList.add('is-streaming');
  return current;
}

export function appendDelta(chunk) {
  if (typeof chunk !== 'string' || chunk === '') return;
  beginAssistant();
  current.node.nodeValue += chunk;   // raw concatenation: chunks may split mid-word
  scrollEnd();
  feedTTS(chunk);
}

export function endAssistant(quiet) {
  if (current) {
    current.bubble.classList.remove('is-streaming');
    var full = current.node.nodeValue;
    if (!full) current.li.remove();
    else if (!quiet) dom.announcer.textContent = full;   // one polite SR announcement per turn
    current = null;
  }
  state.streaming = false;
  dom.stopBtn.hidden = true;
  dom.sendBtn.hidden = false;
  syncOrb();
}

/* ---- transient status line -------------------------------------------- */

/* While locked, a flash owns the hint and the orb must not overwrite it. */
var hintLocked = false, hintTimer = 0;

function setHint(text, busy) {
  dom.hintEl.textContent = text || '';
  dom.hintEl.classList.toggle('is-busy', !!busy && !!text);
}

export function flashHint(text, busy, ms) {
  hintLocked = true;
  clearTimeout(hintTimer);
  setHint(text, busy);
  hintTimer = setTimeout(function () { hintLocked = false; syncOrb(); }, ms || 2600);
}

/* Hand the hint back to the orb before the flash has expired — a tool that
   finished, a turn that ended. */
export function unlockHint() { hintLocked = false; }
export function clearHintTimer() { clearTimeout(hintTimer); }

/* Subscribed to the orb in app.js: the ambient hint follows the orb unless
   something transient owns it. */
export function followOrbHint(next) {
  if (hintLocked) return;
  if (next === 'thinking') setHint(t().thinking, true);
  else if (next === 'speaking') setHint(t().speaking, true);
  else if (next === 'listening') setHint(t().listening, true);
  else setHint('');
}

/* ---- alerts ----------------------------------------------------------- */

var alertTimer = 0;

export function showAlert(message, alsoInLog) {
  var msg = String(message == null ? '' : message);
  dom.alertEl.textContent = msg;
  dom.alertEl.hidden = !msg;
  // When the message also gets a permanent row in the log, keep the role="alert"
  // node for the assertive screen-reader announcement but do not show the text
  // twice on screen.
  dom.alertEl.classList.toggle('sr-only', !!alsoInLog);
  clearTimeout(alertTimer);
  if (msg) {
    alertTimer = setTimeout(function () {
      dom.alertEl.hidden = true; dom.alertEl.textContent = ''; dom.alertEl.classList.remove('sr-only');
    }, 8000);
    state.errorUntil = Date.now() + 2200;
    syncOrb();
    setTimeout(syncOrb, 2300);
    if (alsoInLog) { addMessage('system', msg); scrollEnd(true); }
  }
}
