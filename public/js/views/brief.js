/* =========================================================================
   THE DAILY BRIEF.

   A spoken summary of the day, written by Kacey and read aloud line by line.
   It is a real turn through the real session: the prompt in the side panel is
   sent verbatim, with whichever data blocks are switched on appended to it, and
   the answer is split into lines that can be replayed one at a time.

   The reply comes back through the aside channel rather than the transcript —
   the brief is not a conversation, and having it turn up twice (once here, once
   in the chat) would be worse than useless.

   Speech goes through the same TTS as everything else, one line at a time, so
   tapping a line really does re-read that line.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { el, fill, hhmm } from '../core/el.js';
import { state } from '../core/state.js';
import * as store from '../core/store.js';
import { askAside } from '../net/protocol.js';
import { feedTTS, flushTTS, cancelSpeech, primeTTS } from '../voice/tts.js';
import { onEnter, currentView } from '../ui/router.js';
import { say } from '../ui/toast.js';
import { taskSummary } from './tasks.js';
import { todaySummary } from '../ui/calendar.js';

var lines = [];
var index = 0;
var playing = false;
var generating = false;
var madeAt = null;
var timer = 0;

/* Roughly how long a line takes to say. Used for the progress bar and the
   clock only — the actual advance waits for the speech queue to drain, so a
   slow XTTS run does not desynchronise the highlight from the audio. */
function secondsFor(text) { return Math.max(2, Math.round(String(text).length / 14)); }

function totalSeconds() {
  return lines.reduce(function (a, l) { return a + secondsFor(l); }, 0);
}

function elapsedSeconds() {
  return lines.slice(0, index + 1).reduce(function (a, l) { return a + secondsFor(l); }, 0);
}

function clock(secs) {
  return ('0' + Math.floor(secs / 60)).slice(-2) + ':' + ('0' + (secs % 60)).slice(-2);
}

/* ---- generating --------------------------------------------------------- */

/** What the user switched on in "Injected data", spelled out for the model. */
function contextBlock() {
  var on = store.data.settings.injected || {};
  var parts = [];
  if (on.cal) {
    var cal = todaySummary();
    parts.push('Kalendář dnes: ' + cal.count + ' událostí' + (cal.first ? ', první v ' + cal.first : '') + '.');
  }
  if (on.tasks) {
    var t = taskSummary();
    parts.push('Úkoly: ' + t.due + ' na dnes, ' + t.overdue + ' po termínu, ' + t.open + ' otevřených celkem.');
  }
  if (on.weather) parts.push('Počasí: použij, co víš, nebo ho vynech, když ho nemáš.');
  if (on.mail) parts.push('Pošta: není připojená.');
  return parts.length ? '\n\nData k dispozici:\n' + parts.join('\n') : '';
}

export function generate() {
  if (generating) return;
  generating = true;
  lines = ['Připravuju brief…'];
  index = 0; playing = false;
  render();

  var prompt = (store.data.settings.briefPrompt || 'Shrň mi den.') + contextBlock();

  askAside(prompt, function (reply) {
    generating = false;
    madeAt = new Date();
    // One line per sentence: the brief is meant to be tapped through, and a
    // paragraph is not a unit anybody wants to re-hear.
    lines = String(reply)
      .split(/\n+|(?<=[.!?])\s+/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
    if (!lines.length) lines = [String(reply).trim() || 'Kacey neodpověděla.'];
    index = 0;
    render();
  });
}

/* ---- playback ----------------------------------------------------------- */

function speakLine(i) {
  if (state.muted) return;
  primeTTS();
  cancelSpeech();
  feedTTS(lines[i] + ' ');
  flushTTS();
}

function tick() {
  clearTimeout(timer);
  if (!playing) return;
  timer = setTimeout(function () {
    // Wait for the speech queue rather than racing it.
    if (state.ttsPending > 0) { tick(); return; }
    if (index + 1 >= lines.length) { playing = false; render(); return; }
    index++;
    speakLine(index);
    render();
    tick();
  }, 900);
}

function play(on) {
  playing = on;
  if (on) { speakLine(index); tick(); }
  else { clearTimeout(timer); cancelSpeech(); }
  render();
}

/* ---- rendering ---------------------------------------------------------- */

function renderLines() {
  fill($('briefLines'), lines.length ? lines.map(function (text, i) {
    return el('button.briefline' + (i === index ? '.is-current' : i < index ? '.is-said' : ''), {
      type: 'button',
      onclick: function () { index = i; speakLine(i); if (!playing) render(); else { render(); tick(); } }
    }, text);
  }) : el('p.empty', 'Zatím žádný brief. Klepni na „Vygenerovat znovu“.'));
}

function renderTiles() {
  var cal = todaySummary();
  var t = taskSummary();
  fill($('briefTiles'), [
    el('span.tile', [
      el('b', 'Kalendář'), el('strong', cal.count + ' událostí'),
      el('em', cal.first ? 'první v ' + cal.first : 'nic naplánováno')
    ]),
    el('span.tile', [
      el('b', 'Úkoly'), el('strong', t.due + ' na dnes'),
      el('em' + (t.overdue ? '.is-err' : ''), t.overdue + ' po termínu')
    ]),
    el('span.tile', [
      el('b', 'Relace'), el('strong', state.sessionId ? state.sessionId.slice(0, 8) : '—'),
      el('em', state.conn === 'online' ? 'připojeno' : 'offline')
    ])
  ]);
}

function renderCycle() {
  var wake = store.data.settings.wakeMin;
  var nowMin = new Date().getHours() * 60 + new Date().getMinutes();

  var steps = [
    { at: wake - 60, what: 'Počasí, kalendář a úkoly načteny' },
    { at: wake - 59, what: 'Brief napsán modelem' },
    { at: wake, what: 'Přečteno nahlas', meta: 'reproduktory KC serveru' },
    { at: wake + 3, what: 'Předání do chatu' }
  ];

  fill($('briefCycle'), steps.map(function (s, i) {
    var next = steps[i + 1];
    var isNow = nowMin >= s.at && (!next || nowMin < next.at);
    var done = next ? nowMin >= next.at : false;
    return el('div.cyclestep' + (isNow ? '.is-now' : done ? '.is-done' : ''), [
      el('p.when', hhmm(s.at) + ' · ' + (isNow ? 'teď' : done ? 'hotovo' : 'dál')),
      el('p.what', s.what),
      s.meta ? el('p.muted-3', s.meta) : null
    ]);
  }));

  $('wakeLabel').textContent = hhmm(wake);
  $('briefMade').textContent = madeAt
    ? 'Vygenerováno ' + clock(madeAt.getHours() * 60 + madeAt.getMinutes()).slice(0, 5) +
      ' · ' + lines.length + ' vět'
    : 'Ještě nevygenerováno pro dnešek.';
  $('briefReady').textContent = generating ? 'Píšu…' : (lines.length ? 'Brief připraven' : 'Brief nepřipraven');
}

function renderInjected() {
  var on = store.data.settings.injected || {};
  var t = taskSummary();
  var cal = todaySummary();
  var rows = [
    { k: 'cal', name: 'Dnešní kalendář', meta: cal.count + ' událostí' },
    { k: 'tasks', name: 'Dnešní úkoly', meta: t.due + ' na dnes, ' + t.overdue + ' po termínu' },
    { k: 'weather', name: 'Předpověď počasí', meta: 'neosobní' },
    { k: 'mail', name: 'Pošta', meta: 'nepřipojeno' }
  ];
  fill($('briefInjected'), rows.map(function (r) {
    return el('button.injected', {
      type: 'button', 'aria-pressed': String(!!on[r.k]),
      onclick: function () { store.flip('injected', r.k); }
    }, [r.name, el('em', r.meta)]);
  }));
}

function render() {
  if (!$('briefLines')) return;
  renderLines(); renderTiles(); renderCycle(); renderInjected();

  var total = totalSeconds() || 1;
  var done = elapsedSeconds();
  $('briefProgress').style.width = Math.round(done / total * 100) + '%';
  $('briefClock').textContent = clock(done) + ' / ' + clock(total);
  $('briefClockHead').textContent = clock(total);
  $('briefPlay').textContent = playing ? 'Pauza' : 'Přečíst nahlas';
  $('briefTitle').textContent = 'Denní brief · ' + new Date().toLocaleDateString('cs-CZ',
    { weekday: 'long', day: 'numeric', month: 'long' });
}

/* ---- wiring ------------------------------------------------------------- */

export function initBrief() {
  if (!$('briefLines')) return;

  $('briefPlay').addEventListener('click', function () { play(!playing); });
  $('briefRestart').addEventListener('click', function () { index = 0; play(true); });
  $('briefRegen').addEventListener('click', function () { play(false); generate(); });

  $('briefPrompt').value = store.data.settings.briefPrompt || '';
  $('briefPrompt').addEventListener('input', function () {
    store.patchSettings({ briefPrompt: $('briefPrompt').value });
  });

  $('wakeUp').addEventListener('click', function () { shiftWake(15); });
  $('wakeDown').addEventListener('click', function () { shiftWake(-15); });

  onEnter('brief', function () {
    $('briefPrompt').value = store.data.settings.briefPrompt || '';
    render();
    if (!lines.length && !generating) generate();
  });

  // Leaving the brief stops it talking — nobody wants it following them.
  ['main', 'tasks', 'journal', 'library', 'calendar', 'timer', 'controller', 'focus', 'task']
    .forEach(function (v) { onEnter(v, function () { if (playing) play(false); }); });

  store.onChange(function () { if (currentView() === 'brief') render(); });
}

function shiftWake(delta) {
  var next = Math.max(240, Math.min(720, (store.data.settings.wakeMin || 405) + delta));
  store.patchSettings({ wakeMin: next });
  say('Buzení posunuto na ' + hhmm(next) + '.');
}
