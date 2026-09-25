/* =========================================================================
   THE CONTROLLER.

   What is connected, and what Kacey is allowed to use. Everything here is a
   real switch: the tool chips are sent to the agent as the allow-list when the
   next session opens, and the data sources and memory sections are stored where
   the rest of the app reads them.

   The telemetry readouts live in this view too (js/ui/telemetry.js fills them).
   They belong with the switches: this is the page you open when you want to
   know what Kacey is actually doing.

   A row marked "not built yet" is not a stub pretending to work — the switch
   is visibly dashed and says so when tapped. Better than hiding the plan.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { el, fill } from '../core/el.js';
import * as store from '../core/store.js';
import { onEnter, currentView } from '../ui/router.js';
import { say } from '../ui/toast.js';
import { primeTTS, cancelSpeech, feedTTS, flushTTS } from '../voice/tts.js';
import { night, onNight, runNightNow } from '../net/nightapi.js';

var SOURCES = [
  { key: 'cal_osobni', name: 'Kalendář · osobní', meta: 'čte se z klaus_memory' },
  { key: 'cal_prace', name: 'Kalendář · práce', meta: 'čte se z klaus_memory' },
  { key: 'cal_rodina', name: 'Kalendář · rodina', meta: 'čte se z klaus_memory' },
  { key: 'mail', name: 'Pošta', meta: 'v plánu · souhrny jen ke čtení', planned: true },
  { key: 'health', name: 'Zdraví — spánek, běhy', meta: 'export z hodinek · v plánu', planned: true },
  // lightsd is a separate app; this switch decides whether Kacey shows it.
  { key: 'lights', name: 'Světla v místnosti', meta: 'lightsd :8080 · samostatná aplikace' },
  { key: 'music', name: 'Hudba — Spotify', meta: 'nowplayingd :8081 · barvy obalu do světel · v plánu', planned: true }
];

var MEMORY = [
  { key: 'people', name: 'Lidé', meta: 'entity a vztahy' },
  { key: 'work', name: 'Práce', meta: 'projekty a rozhodnutí' },
  { key: 'health', name: 'Tělo a zdraví', meta: 'poznámky' },
  { key: 'journal', name: 'Deník', meta: 'zápisy, souhrny' },
  { key: 'dreams', name: 'Noční konsolidace', meta: 'v plánu · noční shrnování', planned: true }
];

function toggleRow(group, row) {
  var on = (store.data.settings[group] || {})[row.key] !== false;

  var sw = el('button.switch', {
    type: 'button', 'aria-label': 'Přepnout ' + row.name,
    'aria-pressed': String(row.planned ? false : on),
    disabled: row.planned || false,
    onclick: function () {
      if (row.planned) { say(row.name + ' zatím není hotové — přepínač ožije, až to dorazí.'); return; }
      store.flip(group, row.key);
    }
  }, el('span.switch__knob'));

  // A disabled button does not fire click, so the explanation needs its own
  // target — otherwise tapping a planned row does nothing at all.
  var wrap = row.planned
    ? el('span', {
        onclick: function () { say(row.name + ' zatím není hotové — přepínač ožije, až to dorazí.'); },
        style: 'display:contents'
      }, sw)
    : sw;

  return el('div.srow', [
    el('span.srow__text', [el('b', row.name), el('em', row.meta)]),
    el('span.srow__state' + (row.planned ? '.is-planned' : ''),
      row.planned ? 'zatím není' : (on ? 'používá se' : 'vypnuto')),
    wrap
  ]);
}

/** A tool's short name — the MCP prefix is the same on every one of them. */
function shortName(tool) {
  var parts = String(tool).split('__');
  return parts[parts.length - 1] || tool;
}

function renderTools() {
  var tools = store.data.settings.tools || {};
  var names = Object.keys(tools).sort();

  fill($('ctrlTools'), names.length ? names.map(function (name) {
    var on = tools[name] !== false;
    return el('button.chip.chip--tool', {
      type: 'button', 'aria-pressed': String(on), title: name,
      onclick: function () {
        store.flip('tools', name);
        say(shortName(name) + (on ? ' zakázán.' : ' povolen.') + ' Platí od příští relace.');
      }
    }, shortName(name) + (on ? '' : ' · zakázáno'));
  }) : el('p.muted-3', 'Server zatím nehlásí žádné nástroje.'));

  var denied = store.data.deniedTools || [];
  fill($('ctrlDenied'), denied.length
    ? [el('p.muted-3', 'Trvale zakázané konfigurací serveru — přepínač tu není, protože by nic nedělal:'),
       el('p.muted', denied.map(shortName).join(', '))]
    : null);
}

/* ---- the night and the morning (docs/DREAM.md §14) -------------------------
   settings.night, key by key. The server merges the same defaults under what
   is stored (config.js NIGHT_DEFAULTS); these are kept in step by hand. */

var NIGHT_DEFAULTS = {
  enabled: true, sleep_delay_min: 60, fallback_on: true, fallback: '04:00',
  morning_end: '09:00', screen_idle_min: 2, lid_check: true
};

function nightSettings() { return Object.assign({}, NIGHT_DEFAULTS, store.data.settings.night || {}); }

function setNight(key, value) {
  var next = nightSettings();
  next[key] = value;
  store.patchSettings({ night: next });
}

function hhmmPlus(hhmm, delta) {
  var p = String(hhmm).split(':').map(Number);
  var m = Math.max(6 * 60, Math.min(12 * 60, p[0] * 60 + p[1] + delta));
  return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2);
}

var NIGHT_ROWS = [
  { key: 'enabled', type: 'switch', name: 'Noční běh', meta: 'po usnutí · kalendář 48 h + rutina' },
  { key: 'sleep_delay_min', type: 'step', name: 'Zpoždění po usnutí', meta: 'klid bez dotyku a hlasu',
    show: function (v) { return v + ' min'; }, step: function (v, d) { return Math.max(15, Math.min(180, v + d * 15)); } },
  { key: 'fallback_on', type: 'switch', name: 'Záložní běh 04:00', meta: 'když spánek nepřijde' },
  { key: 'morning_end', type: 'step', name: 'Konec rána bez interakce', meta: 'ranní obrazovka zhasne',
    show: function (v) { return v; }, step: function (v, d) { return hhmmPlus(v, d * 30); } },
  { key: 'screen_idle_min', type: 'step', name: 'Uspání obrazovky', meta: 'mimo ráno, bez dotyku',
    show: function (v) { return v + ' min'; }, step: function (v, d) { return Math.max(1, Math.min(15, v + d)); } },
  { key: 'lid_check', type: 'switch', name: 'Kontrola víka', meta: 'zavřené víko = brief nepřehrát, jen uložit' }
];

function nightRow(row) {
  var s = nightSettings();
  var v = s[row.key];
  var control = row.type === 'switch'
    ? [
        el('span.srow__state' + (v ? '.is-on' : ''), v ? 'zapnuto' : 'vypnuto'),
        el('button.switch', {
          type: 'button', 'aria-pressed': String(!!v), 'aria-label': 'Přepnout ' + row.name,
          onclick: function () { setNight(row.key, !v); }
        }, el('span.switch__knob'))
      ]
    : [el('span.srow__step', [
        el('button.btn.btn--sm', { type: 'button', 'aria-label': 'Méně', onclick: function () { setNight(row.key, row.step(v, -1)); } }, '−'),
        el('span.srow__value.num', row.show(v)),
        el('button.btn.btn--sm', { type: 'button', 'aria-label': 'Více', onclick: function () { setNight(row.key, row.step(v, 1)); } }, '+')
      ])];
  return el('div.srow', [el('span.srow__text', [el('b', row.name), el('em', row.meta)])].concat(control));
}

function hm(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

function renderNightState() {
  var n = night.state;
  var rows;
  if (!n) rows = [['STAV', 'server nehlásí noc', 'warn']];
  else {
    var sc = n.screen || {}, sl = n.sleep || {}, run = n.run || {}, last = run.last, ls = n.lightsd || {};
    var sleepText = sl.state === 'asleep' ? 'spí od ' + hm(sl.since)
      : sl.state === 'winding_down' ? 'usíná do ' + hm(sl.until)
      : 'vzhůru' + (sl.reason === 'sunrise' ? ' · svítání' : '');
    var lastText = last
      ? last.logical_date.split('-').slice(1).reverse().map(Number).join('. ') + '. ' + hm(last.started_at) + ' · ' +
        (last.status === 'done' ? 'ok · ' + last.tasks + ' úk., ' + last.proposals + ' návr.' : last.status === 'failed' ? 'selhal' : 'běží')
      : 'zatím žádný';
    rows = [
      ['SCREEN', (sc.state || 'unknown') + (sc.reason ? ' · ' + sc.reason : '') + (sc.available === false ? ' · bez X' : '')],
      ['LID', { open: 'otevřené', closed: 'zavřené', unknown: 'neznámé' }[sc.lid] || '—', sc.lid === 'closed' ? 'warn' : sc.lid === 'open' ? 'ok' : null],
      ['SLEEP', sleepText],
      ['LAST RUN', lastText, last ? (last.status === 'done' ? 'ok' : last.status === 'failed' ? 'bad' : null) : null],
      ['NEXT RUN', run.running ? 'běží pro ' + run.running : 'po usnutí' + (nightSettings().fallback_on ? ' · záloha ' + ((run.next && run.next.fallback) || '04:00') : '')],
      ['SVÍTÁNÍ', ls.wake_at ? ls.wake_at + (ls.morning_peak_at ? ' · brief ' + ls.morning_peak_at : '') + ' · lightsd' : 'lightsd ' + (ls.mode === 'down' ? 'nedostupné' : '—'), ls.mode === 'down' ? 'warn' : null]
    ];
  }
  fill($('ctrlNightState'), rows.map(function (r) {
    var attrs = {};
    if (r[2] === 'warn') attrs['data-warn'] = '';
    if (r[2] === 'bad') attrs['data-bad'] = '';
    if (r[2] === 'ok') attrs['data-ok'] = '';
    return el('div.readout__row', [el('dt', r[0]), el('dd', attrs, r[1])]);
  }));
}

function renderNight() {
  if (!$('ctrlNight')) return;
  fill($('ctrlNight'), NIGHT_ROWS.map(nightRow));
  renderNightState();
}

function runNow(force) {
  runNightNow(force).then(function () {
    say('Noční běh spuštěn. Výsledek uvidíš ve Stavu noci a v Ranním briefu.');
  }).catch(function (e) {
    if (!force) say('Pro tento den už běh proběhl nebo běží.', { label: 'Spustit znovu', run: function () { runNow(true); } });
    else say('Běh nejde spustit: ' + e.message);
  });
}

function render() {
  if (!$('ctrlSources')) return;
  fill($('ctrlSources'), SOURCES.map(function (r) { return toggleRow('sources', r); }));
  fill($('ctrlMemory'), MEMORY.map(function (r) { return toggleRow('memory', r); }));
  renderTools();
  renderNight();
}

export function initController(restartSession) {
  if (!$('ctrlSources')) return;

  $('testVoice').addEventListener('click', function () {
    primeTTS();
    cancelSpeech();
    feedTTS('Zkouška reproduktoru. Slyšíš mě. ');
    flushTTS();
    say('Přehrávám zkušební větu.');
  });

  $('restartSession').addEventListener('click', function () {
    restartSession();
    say('Relace restartována — otevírá se nová.');
  });

  $('ctrlRunNight').addEventListener('click', function () { runNow(false); });

  onEnter('controller', render);
  store.onChange(function () { if (currentView() === 'controller') render(); });
  onNight(function (what) { if (what === 'state' && currentView() === 'controller') renderNightState(); });
}
