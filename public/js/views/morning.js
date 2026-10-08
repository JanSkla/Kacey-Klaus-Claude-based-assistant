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
import { night, onNight, loadMorning, tickMorning, morningIdle, loadProposals, loadRules, editMorningToday } from '../net/nightapi.js';
import { makeLinePlayer, clockText } from './lineplayer.js';
import { tasks } from './tasks.js';
import { parseDue, vTime } from '../core/due.js';
import { renderDayTimeline, todayEvents } from '../ui/calendar.js';
import { isPhone } from '../ui/psheet.js';
import { renderRows, addRow } from '../ui/checkedit.js';
import { newKey, MAX_ITEMS } from '../core/checklist.js';
import { feedTTS, flushTTS, primeTTS } from '../voice/tts.js';

var player = makeLinePlayer(function (what) {
  render();
  if (what === 'end') renderPlayer();
});
var clockTimer = 0;
var saidDone = false;
var editing = false;       // the checklist editor (1f) is open: the brief waits
var lights = null;         // GET /api/lights/state, for the bar

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

/* "Ráno · brief hraje" on the bar; on a phone the short word, "hraje". */
function renderBar() {
  var r = rec();
  var st = !r ? ['Ráno', ''] : r.state === 'done' ? ['Ráno · hotovo', 'hotovo']
    : editing ? ['Ráno · úprava checklistu', 'úprava']
    : player.playing() ? ['Ráno · brief hraje', 'hraje']
    : player.finished() ? ['Ráno · brief dočten', 'dočteno'] : ['Ráno', ''];
  $('mState').textContent = st[0];
  $('mStateShort').textContent = st[1];
  $('mStateDot').setAttribute('data-st', r && r.state === 'done' ? 'ok' : player.playing() && !editing ? 'acc' : 'pend');
  $('mLights').textContent = !lights || !lights.ok || !lights.known ? 'světla · lightsd nedostupné'
    : lights.on ? 'světla ' + lights.brightness + ' %' + (lights.mode === 'white' ? ' · bílá' : lights.mode ? ' · barva' : '')
    : 'světla vypnuto';
}

function loadLights() {
  fetch('/api/lights/state', { cache: 'no-store' }).then(function (r) { return r.json(); })
    .then(function (st) { lights = st; renderBar(); })
    .catch(function () { lights = null; renderBar(); });
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

/* "1 přijato · 1 zamítnuto"; while some wait, the decided counts first and
   then how many are left: "1 přijato · zbývá 2". */
function proposalSub(i) {
  var tally = [];
  if (i.accepted) tally.push(i.accepted + ' přijato');
  if (i.rejected) tally.push(i.rejected + ' zamítnuto');
  if (i.done) return tally.length ? tally.join(' · ') : i.total + ' / ' + i.total + ' rozhodnuto';
  return tally.concat(['zbývá ' + i.pending]).join(' · ');
}

function renderChecklist() {
  var list = items();
  var done = list.filter(function (i) { return i.done; }).length;
  $('mCount').textContent = done + ' / ' + list.length;
  renderSegs($('mSegs'), list);
  fill($('mCheck'), list.map(function (i) {
    var isProp = i.key === 'proposals';
    var sub = isProp ? proposalSub(i) : '';
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

/* ---- Dnes: the day as a lane (Claude Design 1a–1f) ------------------------------
   The same timeline as main's Dnes card, sized for the bedside screen; tasks a
   rule made say so ("pravidlo · 07:45", "pravidlo Domácnost"). */

/** The ruleset a rule-made task came from: "Domácnost". */
function rulesetOf(task) {
  var sets = night.rulesets || [];
  for (var i = 0; i < sets.length; i++) {
    for (var j = 0; j < sets[i].rules.length; j++) if (sets[i].rules[j].id === task.rule_id) return sets[i].name;
  }
  return '';
}

function renderToday() {
  var phone = isPhone();
  renderDayTimeline($('mToday'), {
    start: 360, end: 1320, pxh: phone ? 38 : 44, strip: phone ? 92 : 132, gutter: phone ? 44 : 52, fs: phone ? 13 : 15,
    nowOffset: phone ? 20 : 24, follow: true, metaEl: $('mTodayMeta'), metaFirst: true, ruleName: rulesetOf
  });
}

/* ---- the checklist editor (1f) ------------------------------------------------------
   Today's list, changed at once (POST /api/morning/today). An item for every
   morning changes the default list too (the app section `morning`, the same
   list as Controller → Ranní checklist); "jen dnes" ones live on today only. */

function editable() { return items().filter(function (i) { return !i.auto && i.key !== 'proposals'; }); }

function saveToday(list) {
  return editMorningToday(list.map(function (i) { return { key: i.key, label: i.label, once: !!i.once }; }))
    .catch(function (e) { say('Nepovedlo se: ' + e.message); });
}

function patchDefaults(fn) {
  store.patch('morning', function (m) {
    var cur = m || { items: [], once: [] };
    return fn({ items: cur.items.slice(), once: cur.once.slice() });
  });
}

/** Today's every-morning items in their new order, then those the default list has and today does not. */
function followOrder(m, list) {
  var keys = list.filter(function (i) { return !i.once; }).map(function (i) { return i.key; });
  var byKey = {};
  m.items.forEach(function (i) { byKey[i.key] = i; });
  m.items = keys.filter(function (k) { return byKey[k]; }).map(function (k) { return byKey[k]; })
    .concat(m.items.filter(function (i) { return keys.indexOf(i.key) === -1; }));
  return m;
}

function renderEditor() {
  if (!editing) return;
  var list = editable();
  renderRows($('mEditRows'), list, {
    variant: 'morning',
    onRename: function (key, label) {
      saveToday(list.map(function (i) { return i.key === key ? Object.assign({}, i, { label: label }) : i; }));
      patchDefaults(function (m) {
        m.items = m.items.map(function (i) { return i.key === key ? { key: key, label: label } : i; });
        return m;
      });
    },
    onRemove: function (key) {
      var gone = list.filter(function (i) { return i.key === key; })[0];
      var beforeToday = list.slice(), beforeDefault = store.data.morning;
      saveToday(list.filter(function (i) { return i.key !== key; }));
      if (gone && !gone.once) patchDefaults(function (m) { m.items = m.items.filter(function (i) { return i.key !== key; }); return m; });
      say((gone ? gone.label : 'Položka') + ' odebráno z ranního checklistu', {
        label: 'Vrátit', run: function () { saveToday(beforeToday); store.patch('morning', beforeDefault); }
      });
    },
    onMove: function (key, to) {
      var fixed = list.filter(function (i) { return !i.once; });
      var from = fixed.findIndex(function (i) { return i.key === key; });
      if (from < 0) return;
      fixed.splice(to, 0, fixed.splice(from, 1)[0]);
      var next = fixed.concat(list.filter(function (i) { return i.once; }));
      saveToday(next);
      patchDefaults(function (m) { return followOrder(m, next); });
    }
  });
}

function openEditor(open) {
  editing = open;
  $('mEditSheet').hidden = !open;
  $('mEdit').setAttribute('aria-expanded', String(open));
  if (open) {
    player.play(false);             // "brief stojí"
    renderEditor();
    var first = $('mEditRows').querySelector('input');
    if (first) first.focus();
  }
  renderBar();
}

function initEditor() {
  $('mEdit').addEventListener('click', function () { openEditor(true); });
  $('mEditDone').addEventListener('click', function () { openEditor(false); });
  var sheet = $('mEditSheet');
  sheet.addEventListener('click', function (ev) { if (ev.target === sheet) openEditor(false); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && editing) { openEditor(false); ev.stopImmediatePropagation(); ev.preventDefault(); }
  }, true);
  $('mEditAdd').appendChild(addRow({
    variant: 'morning',
    onAdd: function (label, once) {
      var list = editable();
      if (list.length >= MAX_ITEMS) { say('Checklist má už ' + MAX_ITEMS + ' položek.'); return; }
      var item = { key: newKey(), label: label, once: once };
      // A new every-morning item goes before today's one-offs.
      var fixed = list.filter(function (i) { return !i.once; }), extra = list.filter(function (i) { return i.once; });
      saveToday(once ? list.concat([item]) : fixed.concat([item], extra));
      if (!once) patchDefaults(function (m) { m.items.push({ key: item.key, label: label }); return m; });
    }
  }));
}

/** What comes next today: the earliest future event or timed task. "zubař v 10:30". */
function nextThing() {
  var now = new Date();
  var nowM = now.getHours() * 60 + now.getMinutes();
  var list = todayEvents().filter(function (e) { return e.start > nowM; })
    .map(function (e) { return { at: e.start, title: e.title }; })
    .concat(tasks().filter(function (x) { var p = parseDue(x.due_at); return !x.done && p && p.time && new Date(x.due_at) > now; })
      .map(function (x) { var p = parseDue(x.due_at); return { at: p.minutes, title: x.label }; }))
    .sort(function (a, b) { return a.at - b.at; });
  var t = list[0];
  if (!t) return null;
  var hm2 = ('0' + Math.floor(t.at / 60)).slice(-2) + ':' + ('0' + (t.at % 60)).slice(-2);
  return t.title.charAt(0).toLowerCase() + t.title.slice(1) + ' ' + vTime(hm2);
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
  renderBar(); renderClock(); renderPlayer(); renderChecklist(); renderToday(); renderDone(); renderEditor();
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
  [['moreMorningMeta', 'checklist' + (m === 'checklist' ? '' : ' ' + m)], ['fnRulesMeta', r], ['moreRulesMeta', r]].forEach(function (x) {
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
  initEditor();
  $('mReplay').addEventListener('click', function () { player.jump(player.finished() ? player.lines().length - 1 : player.index()); });
  $('mIdle').addEventListener('click', function () {
    morningIdle().catch(function () { /* the screen is the server's */ });
    go('main');
  });

  onEnter('morning', function () {
    clearInterval(clockTimer);
    clockTimer = setInterval(function () { renderClock(); renderToday(); }, 15000);
    loadLights();
    // Opened by hand (the rail, Víc): show today's brief without playing it.
    loadMorning().then(function () {
      var r = rec();
      if (!player.lines().length && r && r.brief && r.brief.lines) player.setLines(r.brief.lines, r.brief.audio);
      render();
    });
    render();
  });
  ['main', 'tasks', 'journal', 'library', 'calendar', 'brief', 'timer', 'controller', 'lights', 'rules']
    .forEach(function (v) { onEnter(v, function () { clearInterval(clockTimer); player.stop(); if (editing) openEditor(false); }); });

  onNight(function (what) {
    if (what === 'morning') onMorningFrame(night.morning);
    render();
  });
  store.onChange(function () { render(); });
}
