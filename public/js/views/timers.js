/* =========================================================================
   TIMERS.

   Running timers live in the browser and nowhere else: a timer is about the
   next twenty minutes, and one that survived a reload three hours later would
   be a lie. The saved presets DO persist — those are a preference.

   A finished timer says so out loud through the same chime the rest of the app
   uses, because the point of a kitchen timer is that you are not looking at
   the screen.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { el, fill, mmss } from '../core/el.js';
import * as store from '../core/store.js';
import { say } from '../ui/toast.js';
import { currentView } from '../ui/router.js';
import { playWakeChime } from '../voice/chime.js';

var QUICK = [60, 180, 300, 600, 900, 1200, 1500, 2700, 3600, 5400, 7200, 14400];

var running = [];          // { id, label, total, left, running }
var customMin = 25, customSec = 0;
var ticker = 0;

function label(secs) {
  if (secs % 3600 === 0) return (secs / 3600) + ' h';
  if (secs >= 3600) return Math.floor(secs / 3600) + ' h ' + Math.round((secs % 3600) / 60);
  return (secs / 60) + ' min';
}

export function startTimer(secs, name) {
  running = [{ id: Date.now(), label: String(name || '').trim(), total: secs, left: secs, running: true }]
    .concat(running);
  tick();
  render();
  say('Časovač spuštěn · ' + (name || mmss(secs)));
}

function tick() {
  clearInterval(ticker);
  if (!running.some(function (t) { return t.running && t.left > 0; })) return;
  ticker = setInterval(function () {
    var finished = [];
    running = running.map(function (t) {
      if (!t.running || t.left <= 0) return t;
      var left = t.left - 1;
      if (left <= 0) finished.push(t.label || mmss(t.total));
      return Object.assign({}, t, { left: Math.max(0, left), running: left > 0 });
    });
    if (finished.length) {
      playWakeChime();
      say('Časovač doběhl · ' + finished.join(', '));
    }
    render();
    if (!running.some(function (t) { return t.running && t.left > 0; })) clearInterval(ticker);
  }, 1000);
}

/* ---- rendering ---------------------------------------------------------- */

function renderPresets() {
  fill($('timerPresets'), QUICK.map(function (secs) {
    return el('button.btn', { type: 'button', onclick: function () { startTimer(secs, ''); } }, label(secs));
  }));

  var saved = (store.data.timers.presets || []);
  fill($('namedPresets'), saved.length ? saved.map(function (p) {
    return el('button.btn', {
      type: 'button', onclick: function () { startTimer(p.secs, p.label); }
    }, [el('span', p.label), el('span.num.muted-3', mmss(p.secs))]);
  }) : el('p.muted-3', 'Žádné uložené. Pojmenuj vlastní časovač a uloží se sem.'));
}

function renderActive() {
  var host = $('activeTimers');
  if (!host) return;

  fill(host, running.length ? running.map(function (t) {
    var done = t.left === 0;
    return el('div.timercard' + (done ? '.is-done' : ''), [
      el('div.timercard__head', [
        el('b', t.label || (mmss(t.total) + ' časovač')),
        el('em', done ? 'doběhlo' : t.running ? 'běží' : 'pauza')
      ]),
      el('p.timercard__big', mmss(t.left)),
      el('span.bar', el('span.bar__fill', {
        style: 'width:' + Math.round(t.left / t.total * 100) + '%;' +
               'background:' + (t.running ? 'var(--acc)' : 'var(--ink3)') + ';transition:width 900ms linear'
      })),
      el('span.row', [
        el('button.btn.btn--sm', {
          type: 'button',
          onclick: function () {
            running = running.map(function (x) {
              return x.id === t.id
                ? Object.assign({}, x, done
                    ? { left: x.total, running: true }
                    : { running: !x.running })
                : x;
            });
            tick(); render();
          }
        }, done ? 'Znovu' : t.running ? 'Pauza' : 'Pokračovat'),
        el('button.btn.btn--sm', {
          type: 'button',
          onclick: function () {
            running = running.map(function (x) {
              return x.id === t.id
                ? Object.assign({}, x, { left: x.left + 60, total: x.total + 60, running: true })
                : x;
            });
            tick(); render();
          }
        }, '+1 min'),
        el('button.btn.btn--sm.btn--x.btn--dangerghost', {
          type: 'button', 'aria-label': 'Zrušit časovač',
          onclick: function () {
            running = running.filter(function (x) { return x.id !== t.id; });
            tick(); render();
          }
        }, '×')
      ])
    ]);
  }) : el('div.card.card--pad', [
    el('p.strong', 'Nic neběží.'),
    el('p.muted', 'Vyber délku vlevo, nebo to řekni nahlas. Časovače běží dál, i když jsi jinde v aplikaci.')
  ]));

  $('timerCount').textContent = running.filter(function (t) { return t.running; }).length +
    ' běží · ' + running.length + ' celkem';
  $('customLabel').textContent = mmss(customMin * 60 + customSec);
}

function render() {
  if (!$('timerPresets')) return;
  renderPresets();
  renderActive();
}

/* ---- wiring ------------------------------------------------------------- */

export function initTimers() {
  if (!$('timerPresets')) return;

  $('minDown').addEventListener('click', function () { customMin = Math.max(0, customMin - 1); render(); });
  $('minUp').addEventListener('click', function () { customMin = Math.min(600, customMin + 1); render(); });
  $('secDown').addEventListener('click', function () { customSec = (customSec + 45) % 60; render(); });
  $('secUp').addEventListener('click', function () { customSec = (customSec + 15) % 60; render(); });

  $('customTimer').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var secs = customMin * 60 + customSec;
    if (secs < 5) { say('Nastav aspoň pět sekund.'); return; }
    var name = $('timerLabel').value.trim();
    startTimer(secs, name);
    // A named custom timer is worth keeping; an anonymous one is not.
    if (name && !(store.data.timers.presets || []).some(function (p) { return p.label === name; })) {
      store.patch('timers', Object.assign({}, store.data.timers, {
        presets: (store.data.timers.presets || []).concat([{ label: name, secs: secs }])
      }));
    }
    $('timerLabel').value = '';
  });

  store.onChange(function () { if (currentView() === 'timer') render(); });
  render();
}

/** Running timers, for anything that wants to show them elsewhere. */
export function activeTimers() { return running; }
