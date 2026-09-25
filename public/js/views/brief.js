/* =========================================================================
   THE DAILY BRIEF.

   A spoken summary of the day, read aloud line by line. The night run writes
   it while the owner sleeps (docs/DREAM.md §10) and the morning screen plays
   it at the sunrise's peak; this view shows the same draft, and can still
   ask Kacey for a new one — a real turn through the real session, with the
   prompt in the side panel and whichever data blocks are switched on.

   That reply comes back through the aside channel rather than the transcript:
   the brief is not a conversation, and having it turn up twice would be worse
   than useless.

   The left column is the real night, not a plan: when the button was
   pressed, when sleep was confirmed, how the night run went, when the sunrise
   came and whether the brief was heard (`.timeline`, from /api/night/cycle).
   ========================================================================= */

import { $ } from '../core/dom.js';
import { el, fill } from '../core/el.js';
import { state } from '../core/state.js';
import * as store from '../core/store.js';
import { askAside } from '../net/protocol.js';
import { onEnter, currentView, go } from '../ui/router.js';
import { say } from '../ui/toast.js';
import { taskSummary } from './tasks.js';
import { todaySummary } from '../ui/calendar.js';
import { makeLinePlayer, clockText } from './lineplayer.js';
import { logicalToday } from '../core/due.js';
import {
  night, onNight, loadCycle, loadMorning, runNightNow, startMorningNow, shiftSunrise
} from '../net/nightapi.js';

var player = makeLinePlayer(function () { render(); });
var generating = false;
var madeAt = null;
var source = null;            // 'night' | 'refresh' | 'chat' — where the lines came from

/* ---- the lines -------------------------------------------------------------- */

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
  player.setLines(['Připravuju brief…']);

  var prompt = (store.data.settings.briefPrompt || 'Shrň mi den.') + contextBlock();

  askAside(prompt, function (reply) {
    generating = false;
    madeAt = new Date();
    source = 'chat';
    // One line per sentence: the brief is meant to be tapped through.
    var lines = String(reply).split(/\n+|(?<=[.!?])\s+/).map(function (s) { return s.trim(); }).filter(Boolean);
    player.setLines(lines.length ? lines : [String(reply).trim() || 'Kacey neodpověděla.']);
  });
}

/** The night's draft for today, if there is one and nothing newer is showing. */
function useDraft() {
  var rec = night.morningRec;
  var brief = rec && rec.brief;
  if (!brief || rec.logical_date !== logicalToday() || !brief.lines || !brief.lines.length) return false;
  if (source === 'chat') return true;                       // the user asked for a newer one
  if (madeAt && brief.made_at && new Date(brief.made_at) <= madeAt && player.lines().length) return true;
  madeAt = brief.made_at ? new Date(brief.made_at) : null;
  source = brief.trigger === 'refresh' ? 'refresh' : 'night';
  player.setLines(brief.lines, brief.audio);
  return true;
}

/* ---- the night timeline ----------------------------------------------------
   One step per thing that happened. The dot carries the state — grey done,
   ok / warn / err only where something happened, hollow for what is still
   ahead. Actions only when there is something to catch up. */

var WEEKDAY = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];

function hm(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

function nightName(date) {
  var p = date.split('-').map(Number);
  return 'noc na ' + WEEKDAY[new Date(p[0], p[1] - 1, p[2], 12).getDay()] + ' ' + p[2] + '. ' + p[1] + '.';
}

function plural(n, one, few, many) { return n + ' ' + (n === 1 ? one : n >= 2 && n <= 4 ? few : many); }

/** The steps, summary and action for one night, from /api/night/cycle. Pure. */
export function cycleModel(c, now) {
  now = now || new Date();
  var log = c.log || {}, run = c.run, m = c.morning, s = c.settings || {};
  var steps = [];

  if (log.winding_at) {
    steps.push({ time: hm(log.winding_at), title: 'Usínání', meta: log.cancelled_at ? 'zrušeno v ' + hm(log.cancelled_at) + ' — ruch v místnosti' : 'tlačítko Spát · světla zhasínají', st: 'done' });
  } else {
    steps.push({ time: '—', title: 'Usínání', meta: 'čeká na tlačítko Spát v lightsd', st: 'pend' });
  }

  if (log.asleep_at) {
    steps.push({ time: hm(log.asleep_at), title: 'Spánek', meta: 'klid ' + (s.sleep_delay_min || 60) + ' min · spánek potvrzen', st: 'done' });
  } else if (run && run.trigger !== 'sleep') {
    steps.push({ time: '—', title: 'Spánek nezaznamenán', meta: log.winding_at ? 'klid byl přerušen' : 'tlačítko Spát nepřišlo', st: 'warn' });
  } else {
    steps.push({ time: '—', title: 'Spánek', meta: 'hodina klidu po tlačítku', st: 'pend' });
  }

  var runTitle = { sleep: 'Noční běh', fallback: 'Záložní běh', catchup: 'Noční běh', manual: 'Ruční běh' };
  if (run && run.status === 'done') {
    var secs = run.finished_at ? Math.round((new Date(run.finished_at) - new Date(run.started_at)) / 1000) : null;
    steps.push({
      time: hm(run.started_at),
      title: runTitle[run.trigger] + ' ✓' + (run.trigger === 'catchup' ? ' dohnán' : ''),
      meta: plural(run.tasks, 'úkol', 'úkoly', 'úkolů') + ', ' + plural(run.proposals, 'návrh', 'návrhy', 'návrhů') + (secs != null ? ' · ' + secs + ' s' : '') +
        (run.reasoning === 'failed' ? ' · úvaha selhala' : ''),
      st: 'done'
    });
  } else if (run && run.status === 'failed') {
    steps.push({ time: hm(run.started_at), title: runTitle[run.trigger] + ' selhal', meta: run.error || 'důvod v logu serveru', st: 'err' });
  } else if (run && run.status === 'running') {
    steps.push({ time: hm(run.started_at), title: runTitle[run.trigger] + ' běží…', meta: 'kalendář, pravidla, návrhy, brief', st: 'pend' });
  } else {
    steps.push({ time: '—', title: 'Noční běh', meta: 'po usnutí' + (s.fallback_on === false ? '' : ' · záloha ' + (s.fallback || '04:00')), st: 'pend' });
  }

  var sunrise = log.sunrise_at ? hm(log.sunrise_at) : (c.wake_at || '—');
  steps.push({ time: sunrise, title: 'Svítání', meta: 'začíná ranní rampa světel', st: log.sunrise_at ? 'done' : 'pend' });

  var peak = c.morning_peak_at || '—';
  var act = null;
  if (m && (m.delivered || m.end_reason === 'done' || m.state === 'done')) {
    steps.push({ time: m.started_at ? hm(m.started_at) : peak, title: 'Brief ✓', meta: 'přečten' + (m.state === 'active' ? ' · ráno běží' : ''), st: 'done' });
  } else if (m && m.why === 'lid_closed') {
    steps.push({ time: peak, title: 'Brief', meta: 'víko zavřené — nepřehráno', st: 'warn' });
    act = { label: 'Přehrát brief teď', kind: 'play' };
  } else if (m && (m.why === 'no_page' || m.why === 'missed')) {
    steps.push({ time: peak, title: 'Brief', meta: m.why === 'missed' ? 'server byl ráno vypnutý — nepřehráno' : 'kiosek neodpověděl — nepřehráno', st: 'warn' });
    act = { label: 'Přehrát brief teď', kind: 'play' };
  } else {
    steps.push({ time: peak, title: 'Brief', meta: 'při nejjasnější bílé', st: 'pend' });
  }

  var sum, st;
  if (run && run.status === 'failed') {
    sum = 'Noční běh selhal' + (m && m.delivered ? '.' : ', brief je ze starších dat.');
    st = 'err';
    act = { label: 'Spustit běh teď', kind: 'run' };
  } else if (act && act.kind === 'play') {
    sum = m.why === 'lid_closed' ? 'Brief čeká — víko bylo zavřené.' : 'Brief čeká — nikdo ho neslyšel.';
    st = 'warn';
  } else if (run && run.status === 'done') {
    sum = run.trigger === 'fallback' ? 'Běh proběhl záložně v ' + hm(run.started_at) + '.'
      : run.trigger === 'catchup' ? 'Běh dohnán ráno v ' + hm(run.started_at) + '.'
      : (m && m.delivered ? 'Noc proběhla, brief přečten.' : 'Noc proběhla, brief připraven.');
    st = 'ok';
  } else {
    sum = log.winding_at ? 'Noc běží.' : 'Noc teprve přijde.';
    st = 'pend';
  }
  return { title: 'Noční cyklus · ' + nightName(c.date), sum: sum, st: st, steps: steps, act: act };
}

function renderCycle() {
  var host = $('cycleSteps');
  if (!host) return;
  var c = night.cycle;
  if (!c) { fill(host, el('p.empty', 'Načítám noc…')); return; }
  var model = cycleModel(c);
  $('cycleTitle').textContent = model.title;
  $('cycleSum').textContent = model.sum;
  $('cycleDot').setAttribute('data-st', model.st);
  fill(host, model.steps.map(function (s, i) {
    return el('div.timeline__step' + (i === model.steps.length - 1 ? '.is-last' : ''), { 'data-st': s.st }, [
      el('span.timeline__rail', { 'aria-hidden': 'true' }, el('span.timeline__dot')),
      el('span.timeline__time.num', s.time),
      el('span.timeline__text', [el('b', s.title), el('em', s.meta)])
    ]);
  }));
  var act = $('cycleAct');
  $('cycleActWrap').hidden = !model.act;
  if (model.act) {
    act.textContent = model.act.label;
    act.onclick = function () {
      if (model.act.kind === 'run') {
        act.disabled = true;
        runNightNow(true).then(function () { say('Noční běh spuštěn — výsledek se ukáže tady.'); })
          .catch(function (e) { say('Běh nejde spustit: ' + e.message); })
          .finally(function () { act.disabled = false; setTimeout(loadCycle, 1500); });
      } else {
        startMorningNow().then(function () { go('morning'); }).catch(function (e) { say(e.message); });
      }
    };
  }
  $('sunriseLabel').textContent = c.wake_at || '—';
}

/* ---- rendering ---------------------------------------------------------------- */

function renderLines() {
  var lines = player.lines(), index = player.index(), playing = player.playing(), finished = player.finished();
  fill($('briefLines'), lines.length ? lines.map(function (text, i) {
    var said = finished || i < index;
    return el('button.briefline' + (i === index && !finished ? '.is-current' : said ? '.is-said' : ''), {
      type: 'button', onclick: function () { player.jump(i); }
    }, text);
  }) : el('p.empty', 'Zatím žádný brief. Klepni na „Vygenerovat znovu“.'));
  $('briefPlay').textContent = playing ? 'Pauza' : 'Přečíst nahlas';
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

function renderStatus() {
  var n = player.lines().length;
  $('briefMade').textContent = madeAt
    ? (source === 'night' ? 'Napsáno v noci ' : source === 'refresh' ? 'Přepsáno ráno ' : 'Vygenerováno ') +
      clockText(madeAt.getHours() * 60 + madeAt.getMinutes()).slice(0, 5) + ' · ' + n + ' vět'
    : 'Ještě nevygenerováno pro dnešek.';
  $('briefReady').textContent = generating ? 'Píšu…' : (n ? 'Brief připraven' : 'Brief nepřipraven');
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
  renderLines(); renderTiles(); renderCycle(); renderInjected(); renderStatus();

  var total = player.totalSeconds() || 1;
  var done = player.elapsedSeconds();
  $('briefProgress').style.width = Math.round(done / total * 100) + '%';
  $('briefClock').textContent = clockText(done) + ' / ' + clockText(total);
  $('briefClockHead').textContent = clockText(total);
  $('briefTitle').textContent = 'Denní brief · ' + new Date().toLocaleDateString('cs-CZ',
    { weekday: 'long', day: 'numeric', month: 'long' });
}

/* ---- wiring --------------------------------------------------------------------- */

export function initBrief() {
  if (!$('briefLines')) return;

  $('briefPlay').addEventListener('click', function () { player.play(!player.playing()); });
  $('briefRestart').addEventListener('click', function () { player.restart(); });
  $('briefRegen').addEventListener('click', function () { player.stop(); generate(); });

  $('briefPrompt').value = store.data.settings.briefPrompt || '';
  $('briefPrompt').addEventListener('input', function () {
    store.patchSettings({ briefPrompt: $('briefPrompt').value });
  });

  /* The sunrise is lightsd's: these move its "morning" routine on every lamp.
     The brief then plays at the new peak. */
  function shift(delta) {
    shiftSunrise(delta).then(function (r) {
      say('Svítání posunuto na ' + (r.wake_at || '?') + (r.morning_peak_at ? ', brief v ' + r.morning_peak_at : '') + '.');
      loadCycle();
    }).catch(function (e) { say('Svítání nejde posunout: ' + e.message); });
  }
  $('sunriseUp').addEventListener('click', function () { shift(15); });
  $('sunriseDown').addEventListener('click', function () { shift(-15); });

  onEnter('brief', function () {
    $('briefPrompt').value = store.data.settings.briefPrompt || '';
    loadCycle();
    loadMorning().then(function () {
      if (!useDraft() && !player.lines().length && !generating) generate();
      render();
    });
    render();
  });

  // Leaving the brief stops it talking — nobody wants it following them.
  ['main', 'tasks', 'journal', 'library', 'calendar', 'timer', 'controller', 'focus', 'task', 'morning', 'proposals', 'rules']
    .forEach(function (v) { onEnter(v, function () { player.stop(); }); });

  store.onChange(function () { if (currentView() === 'brief') render(); });
  onNight(function (what) {
    if (currentView() !== 'brief') return;
    if (what === 'state') loadCycle();
    render();
  });
}
