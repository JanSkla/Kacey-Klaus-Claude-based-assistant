/* =========================================================================
   THE MORNING SCREEN.

   What the bedside kiosk shows when the room lights reach their brightest
   white (docs/DREAM.md §12; Claude Design "Kacey DREAM" 1a–1e). Full-bleed,
   legible from bed: the time, the brief read aloud line by line, the fixed
   checklist in big targets, and what the night's rules added for today.

   The server starts it with a `morning` frame. Only the kiosk page (?kiosk=1)
   opens it and plays by itself, and it acknowledges, which is how the server
   knows the brief was delivered. Any other page gets a toast offering to open
   it — a phone left open at 07:00 must not start talking too.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { el, fill } from '../core/el.js';
import { KIOSK } from '../core/state.js';
import * as store from '../core/store.js';
import { go, onEnter, currentView } from '../ui/router.js';
import { say } from '../ui/toast.js';
import { sendFrame } from '../net/protocol.js';
import { night, onNight, loadMorning, tickMorning, morningIdle, loadProposals, loadRules } from '../net/nightapi.js';
import { makeLinePlayer, clockText } from './lineplayer.js';
import { tasks, toggleTask } from './tasks.js';
import { parseDue, logicalToday } from '../core/due.js';
import { feedTTS, flushTTS, primeTTS } from '../voice/tts.js';

var player = makeLinePlayer(function (what) {
  render();
  if (what === 'end') renderPlayer();
});
var clockTimer = 0;
var saidDone = false;

var DAYS = ['Neděle', 'Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota'];
var MONTHS = ['ledna', 'února', 'března', 'dubna', 'května', 'června', 'července', 'srpna', 'září', 'října', 'listopadu', 'prosince'];

function hm(d) { return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }

function rec() { return night.morningRec; }

/* ---- the morning frame ------------------------------------------------------ */

function onMorningFrame(m) {
  if (!m) return;
  saidDone = false;
  player.setLines(m.lines || [], m.audio || []);
  if (KIOSK || m.manual) {
    go('morning');
    if ((m.lines || []).length) {
      player.play(true);
      sendFrame({ type: 'morning_ack', logical_date: m.logical_date });
    }
  } else {
    say('Ráno je připravené.', { label: 'Otevřít', run: function () { go('morning'); } });
  }
  loadMorning();
  loadProposals();
}

/* ---- rendering ---------------------------------------------------------------- */

function renderBar() {
  var r = rec();
  var st = !r ? 'Ráno' : r.state === 'done' ? 'Ráno · hotovo'
    : player.playing() ? 'Ráno · brief hraje'
    : player.finished() ? 'Ráno · brief dočten' : 'Ráno';
  $('mState').textContent = st;
  $('mStateDot').setAttribute('data-st', r && r.state === 'done' ? 'ok' : player.playing() ? 'acc' : 'pend');
  var ls = night.state && night.state.lightsd;
  $('mLights').textContent = ls && ls.mode !== 'down' ? (ls.sleeping ? 'světla · noc' : 'světla · den') : 'světla · lightsd nedostupné';
}

function renderClock() {
  var now = new Date();
  $('mClock').textContent = hm(now);
  $('mDate').textContent = DAYS[now.getDay()] + ' ' + now.getDate() + '. ' + MONTHS[now.getMonth()];
  $('mDoneClock').textContent = hm(now);
}

function renderPlayer() {
  var lines = player.lines(), index = player.index(), finished = player.finished();
  fill($('mLines'), lines.length ? lines.map(function (text, i) {
    var current = i === index && !finished && (player.playing() || index > 0);
    var said = finished || i < index;
    return el('button.briefline.briefline--big' + (current ? '.is-current' : said ? '.is-said' : ''), {
      type: 'button', onclick: function () { player.jump(i); }
    }, [el('span.briefline__text', text), el('span.briefline__tag', current ? 'teď' : said ? 'znovu' : '')]);
  }) : el('p.empty', 'Brief na dnešek není — noční běh ho nenapsal.'));
  var playing = player.playing();
  var play = $('mPlay');
  play.textContent = playing ? 'Pauza' : (finished ? 'Přehrát znovu' : 'Přehrát');
  play.classList.toggle('btn--accent', !playing);
  var total = player.totalSeconds() || 1, done = player.elapsedSeconds();
  $('mProgress').style.width = Math.round(done / total * 100) + '%';
  $('mPlayClock').textContent = clockText(done) + ' / ' + clockText(total);
}

function items() {
  var r = rec();
  return r && r.items ? r.items : [];
}

function renderSegs(host, list) {
  fill(host, list.map(function (i) { return el('span.segbar__seg' + (i.done ? '.is-done' : '')); }));
}

function renderChecklist() {
  var list = items();
  var done = list.filter(function (i) { return i.done; }).length;
  $('mCount').textContent = done + ' / ' + list.length;
  renderSegs($('mSegs'), list);
  fill($('mCheck'), list.map(function (i) {
    var isProp = i.key === 'proposals';
    var sub = isProp ? (i.done ? i.total + ' / ' + i.total + ' rozhodnuto' : (i.total - i.pending) + ' / ' + i.total + ' rozhodnuto · otevřít') : '';
    return el('button.checkitem' + (i.done ? '.is-done' : '') + (isProp ? '.checkitem--wide' : '') + (isProp && !i.done ? '.is-open' : ''), {
      type: 'button', 'aria-pressed': String(!!i.done),
      onclick: function () {
        if (isProp) { go('proposals'); return; }
        tickMorning(i.key, !i.done).catch(function (e) { say(e.message); });
      }
    }, [
      el('span.checkitem__box', { 'aria-hidden': 'true' }, i.done ? '✓' : ''),
      el('span.checkitem__text', [el('span.checkitem__label', i.label), sub ? el('span.checkitem__sub', sub) : null]),
      isProp && !i.done ? el('span.checkitem__go', { 'aria-hidden': 'true' }, '→') : null
    ]);
  }));
}

/* Today's tasks the night's rules made: which rule, and the overlap caveat. */
function ruleTasks() {
  var today = logicalToday();
  return tasks().filter(function (t) {
    var p = parseDue(t.due_at);
    return t.origin === 'rule' && p && p.date === today;
  }).sort(function (a, b) { return a.due_at < b.due_at ? -1 : 1; });
}

function ruleName(id) {
  var sets = night.rulesets || [];
  for (var i = 0; i < sets.length; i++) {
    for (var j = 0; j < sets[i].rules.length; j++) if (sets[i].rules[j].id === id) return sets[i].rules[j].name;
  }
  return null;
}

function renderRuleTasks() {
  var list = ruleTasks();
  fill($('mRuleTasks'), list.length ? list.map(function (t) {
    var p = parseDue(t.due_at);
    var name = ruleName(t.rule_id);
    return el('div.ruletask' + (t.done ? '.is-done' : ''), [
      el('button.check', {
        type: 'button', 'aria-pressed': String(!!t.done), 'aria-label': 'Přepnout úkol',
        onclick: function () { toggleTask(t.id); }
      }, t.done ? '✓' : ''),
      el('span.ruletask__text', [
        el('span.ruletask__label', t.label),
        el('span.ruletask__origin', (name ? 'pravidlo ' + name : 'pravidlo') + (t.reason ? ' · ' + t.reason : '')),
        t.note ? el('span.ruletask__warn', t.note) : null
      ]),
      el('span.ruletask__when.num', p && p.time ? p.time : 'dnes')
    ]);
  }) : el('p.empty', 'Pravidla na dnešek nic nepřidala.'));
}

function nextThing() {
  var now = new Date();
  var t = tasks().filter(function (x) { var p = parseDue(x.due_at); return !x.done && p && p.time && new Date(x.due_at) > now; })
    .sort(function (a, b) { return a.due_at < b.due_at ? -1 : 1; })[0];
  return t ? t.label.toLowerCase() + ' v ' + t.due_at.slice(11, 16) : null;
}

function renderDone() {
  var r = rec();
  var done = !!(r && r.state === 'done');
  $('mLive').hidden = done;
  $('mDone').hidden = !done;
  $('mRewrite').hidden = done || !(r && r.rewritten_at);
  if (r && r.rewritten_at) {
    $('mRewriteText').textContent = 'Brief přepsán v ' + hm(new Date(r.rewritten_at)) + ' — od noci se změnil kalendář nebo úkoly.';
  }
  if (!done) return;
  var list = items();
  renderSegs($('mDoneSegs'), list);
  var mins = r.started_at && r.ended_at ? Math.round((new Date(r.ended_at) - new Date(r.started_at)) / 60000) : null;
  var next = nextThing();
  $('mDoneSummary').textContent = list.length + ' / ' + list.length + (mins != null ? ' za ' + mins + ' min' : '') + (next ? ' · další: ' + next : '');
  if (!saidDone && currentView() === 'morning' && KIOSK) {
    saidDone = true;
    primeTTS(); feedTTS('Hotovo, hezký den. '); flushTTS();
  }
}

function render() {
  if (!$('mLines') || currentView() !== 'morning') return;
  renderBar(); renderClock(); renderPlayer(); renderChecklist(); renderRuleTasks(); renderDone();
}

/* ---- around the app ---------------------------------------------------------------
   The menu counts ("Ráno · 3 / 7", "Pravidla · 2 sady") and the night look:
   woken by the wake word between the sleep button and the morning, the whole
   interface dims (Claude Design 5c) — same surfaces, same accent, less light. */

function paintMenus() {
  var list = items();
  var done = list.filter(function (i) { return i.done; }).length;
  var m = list.length && rec() && rec().state !== 'pending' ? done + ' / ' + list.length : 'checklist';
  var n = (night.rulesets || []).length;
  var r = n ? (n === 1 ? '1 sada' : n <= 4 ? n + ' sady' : n + ' sad') : '';
  [['fnMorningMeta', '· ' + m], ['moreMorningMeta', m], ['fnRulesMeta', r ? '· ' + r : ''], ['moreRulesMeta', r]].forEach(function (x) {
    var node = $(x[0]);
    if (node) node.textContent = x[1];
  });
}

function paintNight() {
  var s = night.state && night.state.sleep;
  document.documentElement.classList.toggle('is-night', !!s && (s.state === 'asleep' || s.state === 'winding_down'));
}

/* ---- wiring ------------------------------------------------------------------- */

export function initMorning() {
  loadRules();
  onNight(function () { paintMenus(); paintNight(); });
  if (!$('mLines')) return;

  $('mPlay').addEventListener('click', function () { player.play(!player.playing()); });
  $('mReplay').addEventListener('click', function () { player.jump(player.finished() ? player.lines().length - 1 : player.index()); });
  $('mIdle').addEventListener('click', function () {
    morningIdle().catch(function () { /* the screen is the server's */ });
    go('main');
  });

  onEnter('morning', function () {
    clearInterval(clockTimer);
    clockTimer = setInterval(renderClock, 15000);
    // Opened by hand (the rail, Víc): show today's brief without playing it.
    loadMorning().then(function () {
      var r = rec();
      if (!player.lines().length && r && r.brief && r.brief.lines) player.setLines(r.brief.lines, r.brief.audio);
      render();
    });
    render();
  });
  ['main', 'tasks', 'journal', 'library', 'calendar', 'brief', 'timer', 'controller', 'lights', 'rules']
    .forEach(function (v) { onEnter(v, function () { clearInterval(clockTimer); player.stop(); }); });

  onNight(function (what) {
    if (what === 'morning') onMorningFrame(night.morning);
    render();
  });
  store.onChange(function () { render(); });
}
