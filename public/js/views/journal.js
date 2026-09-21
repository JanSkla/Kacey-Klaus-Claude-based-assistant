/* =========================================================================
   THE JOURNAL.

   One entry at a time, dictated or typed, autosaved. The microphone here is
   doing a different job from the one in the composer: the words are the entry,
   not a request, so the journal registers a dictation sink and the transcript
   lands in the textarea instead of being sent to Kacey.

   Dictation is continuous, which the recogniser is not: it finalises after a
   pause and stops. A supervisor re-opens it, the same pattern the wake word
   and the barge-in listener use, because a single start attempt loses the race
   with the engine winding down.

   "konec" ends the session. It is checked here rather than in closing.js
   because it only means that while the journal is recording — the rest of the
   time it is an ordinary word.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { el, fill } from '../core/el.js';
import { state } from '../core/state.js';
import * as store from '../core/store.js';
import { go, onEnter, currentView } from '../ui/router.js';
import { say } from '../ui/toast.js';
import {
  setDictationSink, startRecognition, stopRecognition, recognitionAvailable
} from '../voice/recognition.js';

var STOP_WORDS = /^\s*(konec|finish|hotovo|dokončit|to je vše)\s*[.!]?\s*$/i;

var currentId = null;
var dictating = false;
var started = 0;
var clockTimer = 0;
var supervisor = 0;
var saveTimer = 0;
var interimText = '';
var chat = [];
var draft = null;          // a started session with nothing written in it yet

/* ---- entries ------------------------------------------------------------ */

function entries() { return store.data.journal.entries || []; }

function entryById(id) {
  return entries().filter(function (e) { return e.id === id; })[0] || null;
}

function writeEntries(next) {
  store.patch('journal', Object.assign({}, store.data.journal, { entries: next }));
}

function wordCount(text) {
  var trimmed = String(text || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Begin a session.
 *
 * Nothing is written yet. An entry only reaches the store once it has words in
 * it (see commit() below) — opening the journal, looking at it and leaving must
 * not leave an empty "rozepsané" card behind in the library, which is exactly
 * what it used to do on every visit.
 */
export function newEntry() {
  currentId = null;
  draft = {
    id: 'j' + Date.now(),
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    title: '',
    text: '',
    tags: [],
    unfinished: true
  };
  chat = [{ who: 'Kacey', text: 'Nahrávám. Řekni „konec“, až budeš hotov.' }];
  renderAll();
  return draft;
}

/** Write the pending draft into the store. First words only. */
function commit(text) {
  if (!draft) return null;
  var entry = Object.assign({}, draft, {
    text: text, title: derivedTitle(text), updated: new Date().toISOString()
  });
  draft = null;
  currentId = entry.id;
  writeEntries(entries().concat([entry]));
  return entry;
}

/** The entry being written, whether or not it has reached the store. */
function activeEntry() {
  return draft || entryById(currentId);
}

function openEntry(id) {
  draft = null;              // an unwritten session is discarded, not filed
  currentId = id;
  stopDictation();
  renderAll();
}

/* The title is the first few words of the entry: asking for one up front is
   the fastest way to stop somebody writing anything at all. */
function derivedTitle(text) {
  var first = String(text || '').trim().split(/[.\n]/)[0] || '';
  var words = first.split(/\s+/).slice(0, 6).join(' ');
  return words || 'Bez názvu';
}

function saveText(text) {
  var hasWords = String(text || '').trim().length > 0;

  // Nothing written yet, and nothing stored yet: there is nothing to save.
  if (!currentId && !hasWords) { $('jSaved').textContent = 'nová relace'; return; }

  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    if (!currentId) {
      if (!hasWords) return;
      commit(text);
      renderUnfinished();
    } else {
      writeEntries(entries().map(function (e) {
        return e.id === currentId
          ? Object.assign({}, e, { text: text, title: derivedTitle(text), updated: new Date().toISOString() })
          : e;
      }));
    }
    $('jSaved').textContent = 'uloženo právě teď';
  }, 600);
  $('jSaved').textContent = 'ukládám…';
}

/* ---- dictation ---------------------------------------------------------- */

function appendDictated(text) {
  var area = $('jText');
  var base = area.value.replace(/\s+$/, '');
  area.value = (base ? base + ' ' : '') + text;
  area.scrollTop = area.scrollHeight;
  saveText(area.value);
  paintStats();
}

export function startDictation() {
  if (!recognitionAvailable()) { say('Mikrofon není k dispozici.'); return; }
  if (!currentId && !draft) newEntry();
  dictating = true;
  started = Date.now();

  setDictationSink(function (text, isFinal) {
    if (!isFinal) { interimText = text; paintRecState(); return; }
    interimText = '';
    if (STOP_WORDS.test(text)) { finish(); return; }
    appendDictated(text);
    paintRecState();
  });

  state.micDesired = true;
  startRecognition();

  clearInterval(clockTimer);
  clockTimer = setInterval(paintClock, 1000);
  /* Re-open the microphone after each utterance. Polled rather than hooked to
     onend: the engine can refuse a start while it is still winding down, and
     nothing would ask again. */
  clearInterval(supervisor);
  supervisor = setInterval(function () {
    if (!dictating) return;
    if (state.listening || state.ttsPending > 0 || state.streaming || document.hidden) return;
    state.micDesired = true;
    startRecognition();
  }, 700);

  paintClock(); paintRecState();
}

export function stopDictation() {
  if (!dictating) { setDictationSink(null); return; }
  dictating = false;
  interimText = '';
  clearInterval(clockTimer); clearInterval(supervisor);
  state.micDesired = false;
  stopRecognition(true);
  setDictationSink(null);
  paintClock(); paintRecState();
}

function toggleDictation() { dictating ? stopDictation() : startDictation(); }

function finish() {
  stopDictation();
  var text = $('jText').value;

  if (!String(text).trim()) {
    // Nothing was said. End the session rather than filing a blank entry.
    draft = null; currentId = null;
    renderAll();
    say('Prázdná relace — nic k uložení.');
    return;
  }
  clearTimeout(saveTimer);
  if (!currentId) commit(text);
  writeEntries(entries().map(function (e) {
    return e.id === currentId
      ? Object.assign({}, e, {
          text: text, title: derivedTitle(text), unfinished: false,
          updated: new Date().toISOString()
        })
      : e;
  }));
  say('Zápis dokončen · ' + wordCount(text) + ' slov.');
  renderAll();
}

/* ---- the side chat ------------------------------------------------------
   A question asked while writing, answered without ending the session. It goes
   to Kacey through the same socket as everything else, but the reply belongs
   here rather than in the main transcript — so this keeps its own list and the
   main log is left alone. */

function renderChat() {
  fill($('jChat'), chat.map(function (m) {
    var mine = m.who === 'You' || m.who === 'Ty';
    return el('div.msg.msg--' + (mine ? 'user' : 'assistant'), [
      el('span.msg__who', mine ? 'Ty' : 'Kacey'),
      el('p.msg__bubble', m.text)
    ]);
  }));
  var box = $('jChat');
  box.scrollTop = box.scrollHeight;
}

/* ---- painting ----------------------------------------------------------- */

function paintClock() {
  var secs = dictating ? Math.floor((Date.now() - started) / 1000) : 0;
  $('jClock').textContent = ('0' + Math.floor(secs / 60)).slice(-2) + ':' + ('0' + (secs % 60)).slice(-2);
}

function paintRecState() {
  var note = $('jRecState');
  if (!dictating) { note.textContent = 'Připraveno · klepni na Diktovat nebo piš'; }
  else if (interimText) { note.textContent = '… ' + interimText; }
  else { note.textContent = 'Nahrávám · řekni „konec“ pro ukončení'; }

  var btn = $('jDictate');
  btn.setAttribute('aria-pressed', String(dictating));
  $('jDictateLabel').textContent = dictating ? 'Pauza diktování' : 'Diktovat';
}

function paintStats() {
  var entry = activeEntry();
  var text = $('jText').value;
  $('jStats').textContent = wordCount(text) + ' slov' + (entry && !entry.unfinished ? ' · dokončeno' : '');
  $('jTitle').textContent = 'Deník' + (entry ? ' · ' + timeLabel(entry.created) : '');
}

function timeLabel(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return '';
  var today = new Date();
  var sameDay = d.toDateString() === today.toDateString();
  var clock = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return (sameDay ? 'dnes' : d.getDate() + '. ' + (d.getMonth() + 1) + '.') + ' ' + clock;
}

function renderUnfinished() {
  var list = entries().filter(function (e) { return e.unfinished; }).slice().reverse();
  fill($('jUnfinished'), list.length ? list.map(function (e) {
    return el('button.btn.btn--fn', {
      type: 'button',
      style: e.id === currentId ? 'border-color:var(--acc)' : '',
      onclick: function () { openEntry(e.id); }
    }, [
      el('span', [
        el('span.rowbtn__time', { style: e.id === currentId ? 'color:var(--acc)' : '' }, timeLabel(e.created)),
        el('span.rowbtn__title', (e.title || 'Bez názvu') + ' — ' + wordCount(e.text) + ' slov')
      ])
    ]);
  }) : el('p.muted-3', { style: 'padding:0 12px 10px' }, 'Nic rozepsaného.'));
}

function renderAll() {
  if (!$('jText')) return;
  var entry = activeEntry();
  if (entry && document.activeElement !== $('jText')) $('jText').value = entry.text || '';
  if (!entry) $('jText').value = '';
  $('jSaved').textContent = currentId ? 'uloženo' : 'nová relace';
  paintStats(); paintClock(); paintRecState(); renderUnfinished(); renderChat();
}

/* ---- wiring ------------------------------------------------------------- */

export function initJournal(askKacey) {
  if (!$('jText')) return;

  $('jText').addEventListener('input', function () {
    saveText($('jText').value);
    paintStats();
  });

  $('jDictate').addEventListener('click', toggleDictation);
  $('jFinish').addEventListener('click', finish);
  $('jNew').addEventListener('click', function () { newEntry(); say('Nová relace deníku.'); });
  $('jTag').addEventListener('click', function () {
    if (!currentId) { say('Nejdřív něco napiš — tagovat jde až uložený zápis.'); return; }
    var tag = prompt('Tag pro tenhle zápis:');
    if (!tag) return;
    writeEntries(entries().map(function (e) {
      return e.id === currentId
        ? Object.assign({}, e, { tags: (e.tags || []).concat([String(tag).trim().toLowerCase()]) })
        : e;
    }));
    say('Tag přidán · ' + tag);
  });

  $('jChatForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var text = $('jChatInput').value.trim();
    if (!text) return;
    $('jChatInput').value = '';
    chat = chat.concat([{ who: 'Ty', text: text }]);
    renderChat();
    askKacey(text, function (reply) {
      chat = chat.concat([{ who: 'Kacey', text: reply }]);
      renderChat();
    });
  });

  onEnter('journal', function () {
    if (!currentId) {
      // Resume the most recent unfinished entry rather than opening a blank
      // one on top of it — an interrupted session is the common case.
      var open = entries().filter(function (e) { return e.unfinished; }).pop();
      if (open) currentId = open.id; else newEntry();
    }
    renderAll();
  });

  // Leaving the view must let go of the microphone.
  ['main', 'tasks', 'calendar', 'brief', 'timer', 'controller', 'library', 'focus', 'task']
    .forEach(function (v) { onEnter(v, stopDictation); });

  store.onChange(function () { if (currentView() === 'journal') renderAll(); });
}

/** Called by the library when it removes the entry currently open here. */
export function forgetEntry(id) {
  if (currentId === id) { currentId = null; draft = null; renderAll(); }
}

export { openEntry, entries, wordCount };
