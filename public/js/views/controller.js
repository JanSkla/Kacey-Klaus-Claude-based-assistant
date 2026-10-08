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
import { go } from '../ui/router.js';
import { lightsUrl } from './lights.js';
import { renderRows, addRow } from '../ui/checkedit.js';
import { newKey, itemsWord, MAX_ITEMS } from '../core/checklist.js';

var SOURCES = [
  { key: 'cal_osobni', name: 'Kalendář · osobní', meta: 'čte se z klaus_memory' },
  { key: 'cal_prace', name: 'Kalendář · práce', meta: 'čte se z klaus_memory' },
  { key: 'cal_rodina', name: 'Kalendář · rodina', meta: 'čte se z klaus_memory' },
  { key: 'mail', name: 'Pošta', meta: 'v plánu · souhrny jen ke čtení', planned: true },
  { key: 'health', name: 'Zdraví — spánek, běhy', meta: 'export z hodinek · v plánu', planned: true },
  // lightsd is a separate app; this switch decides whether Kacey shows it.
  { key: 'lights', name: 'Světla v místnosti', meta: 'lightsd :8080 · hlavní + u postele' },
  // Off hides the header's mini player (views/miniplayer.js); nowplayingd itself runs on.
  { key: 'music', name: 'Hudba — Spotify', meta: 'nowplayingd :8081 · barvy obalu do světel' }
];

/* "osobní" → its switch key "cal_osobni", the same mapping the night run uses (nightstore.js). */
function sourceKey(source) {
  return 'cal_' + String(source || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

var calCounts = null;      // { cal_osobni: 41, … } from /api/calendar/sources, or null before it answers

function loadCalCounts() {
  return fetch('/api/calendar/sources').then(function (r) { return r.ok ? r.json() : null; }).then(function (b) {
    if (!b || !b.sources) return;
    calCounts = {};
    b.sources.forEach(function (s) { calCounts[sourceKey(s.source)] = s.count; });
    if ($('ctrlSources')) fill($('ctrlSources'), SOURCES.map(function (r) { return toggleRow('sources', r); }));
  }).catch(function () { /* no numbers rather than wrong ones */ });
}

function eventsWord(n) { return n + (n === 1 ? ' událost' : n > 1 && n < 5 ? ' události' : ' událostí'); }

/** A row's meta with the number the design puts after it, when there is a real one. */
function metaOf(group, row) {
  if (group === 'sources' && calCounts && calCounts[row.key] != null) return row.meta + ' · ' + eventsWord(calCounts[row.key]);
  if (group === 'memory' && row.key === 'journal') {
    var n = ((store.data.journal || {}).entries || []).length;
    return row.meta + (n ? ' · ' + n : '');
  }
  return row.meta;
}

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
    el('span.srow__text', [el('b', row.name), el('em', metaOf(group, row))]),
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
    ? [el('p.denied__lede', ['Trvale zakázané konfigurací serveru', el('span.desk-only', ' — přepínač tu není, protože by nic nedělal'), ':']),
       el('p.denied__list', denied.map(shortName).join(', '))]
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
  { key: 'fallback_on', type: 'switch', name: 'Záložní běh', meta: 'když spánek nepřijde nebo běh selže' },
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
  // "Záložní běh 04:00": the name carries the hour that is set.
  var name = row.key === 'fallback_on' ? row.name + ' ' + s.fallback : row.name;
  return el('div.srow', [el('span.srow__text', [el('b', name), el('em', row.meta)])].concat(control));
}

/** "dnes", "včera" or "6. 10." */
function dayWord(isoOrDate) {
  var d = new Date(String(isoOrDate).length === 10 ? isoOrDate + 'T12:00' : isoOrDate);
  var a = new Date(d); a.setHours(0, 0, 0, 0);
  var t = new Date(); t.setHours(0, 0, 0, 0);
  var ago = Math.round((t - a) / 864e5);
  return ago === 0 ? 'dnes' : ago === 1 ? 'včera' : d.getDate() + '. ' + (d.getMonth() + 1) + '.';
}

function lightsPort() { return (lightsUrl().match(/:(\d+)/) || [])[1] || '8080'; }

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
    var sleepText = sl.state === 'asleep' ? 'potvrzen ' + hm(sl.since)
      : sl.state === 'winding_down' ? 'usíná do ' + hm(sl.until)
      : 'vzhůru' + (sl.reason === 'sunrise' ? ' · svítání' : '');
    // "dnes 00:11 · ok · 41 s"
    var secs = last && last.started_at && last.finished_at ? Math.round((new Date(last.finished_at) - new Date(last.started_at)) / 1000) : null;
    var lastText = last
      ? dayWord(last.started_at || last.logical_date) + ' ' + hm(last.started_at) + ' · ' +
        (last.status === 'done' ? 'ok' : last.status === 'failed' ? 'selhal' : 'běží') + (secs != null && last.status !== 'running' ? ' · ' + secs + ' s' : '')
      : 'zatím žádný';
    // "off · probudí svítání" when the screen is off and the sunrise will wake it.
    var scWord = sc.state === 'off' && ls.wake_at ? 'off · probudí svítání'
      : (sc.state && sc.state !== 'unknown' ? sc.state : 'neznámý') + (sc.reason ? ' · ' + sc.reason : '');
    rows = [
      ['SCREEN', scWord + (sc.backend === 'none' ? ' · neřízeno' : ''), sc.backend === 'none' ? 'warn' : null],
      ['LID', { open: 'otevřené', closed: 'zavřené', unknown: 'neznámé' }[sc.lid] || '—', sc.lid === 'closed' ? 'warn' : sc.lid === 'open' ? 'ok' : null],
      ['SLEEP', sleepText],
      ['LAST RUN', lastText, last ? (last.status === 'done' ? 'ok' : last.status === 'failed' ? 'bad' : null) : null],
      ['NEXT RUN', run.running ? 'běží pro ' + run.running : 'po usnutí' + (nightSettings().fallback_on ? ' · záloha ' + ((run.next && run.next.fallback) || '04:00') : '')],
      ['SVÍTÁNÍ', ls.wake_at ? ls.wake_at + ' · lightsd :' + lightsPort() : 'lightsd ' + (ls.mode === 'down' ? 'nedostupné' : '—'), ls.mode === 'down' ? 'warn' : null]
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

/* ---- the second monitor (monitor.js) ---------------------------------------
   The kiosk is hidden behind Moonlight while it runs, so this is mostly read
   from another screen: polled while the Controller shows. */

var monitor = null;          // GET /api/monitor, or null before the first answer
var monitorBusy = null;       // 'on' / 'off' while a toggle is in flight, else null

function loadMonitor() {
  return fetch('/api/monitor').then(function (r) { return r.json(); })
    .then(function (d) { monitor = d; renderMonitor(); })
    .catch(function () { /* offline: keep the last answer */ });
}

function setMonitor(on) {
  monitorBusy = on ? 'on' : 'off';
  renderMonitor();
  fetch('/api/monitor', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ on: on })
  }).then(function (r) { return r.json(); }).then(function (d) {
    monitor = d;
    if (d.error) say(d.error);
    else say(on ? 'Druhý monitor zapnutý — obrazovka u postele teď patří počítači.' : 'Druhý monitor vypnutý — zpátky Kacey.');
  }).catch(function (e) { say('Druhý monitor nejde přepnout: ' + e.message); })
    .then(function () { monitorBusy = null; renderMonitor(); });
}

/** 'v 21:04' today, 'včera 23:12', or '6. 10. 23:12'. */
function whenWord(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return '';
  var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  var day = new Date(d); day.setHours(0, 0, 0, 0);
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var ago = Math.round((today - day) / 864e5);
  return ago === 0 ? 'v ' + hm : ago === 1 ? 'včera ' + hm : d.getDate() + '. ' + (d.getMonth() + 1) + '. ' + hm;
}

function renderMonitor() {
  if (!$('ctrlMonitor')) return;
  var m = monitor || {};
  var on = m.state === 'on';
  var usable = on || !!m.available;
  var meta = !monitor ? 'zjišťuji…'
    : !usable ? (m.why || 'tady nejde')
    : monitorBusy ? (monitorBusy === 'on' ? 'spojuji s počítačem — asi 10 s' : 'vypínám — vrací se Kacey')
    : on ? 'plocha počítače je na obrazovce u postele' : 'obrazovka u postele jako druhý monitor PC';
  // The last change, or why it failed: "Naposledy: zapnuto v 21:04" / "…: <chyba> · včera 23:12".
  var last = !m.since ? '' : 'Naposledy: ' + (m.error ? m.error + ' · ' + whenWord(m.since).replace(/^v /, 'dnes ') : (on ? 'zapnuto ' : 'vypnuto ') + whenWord(m.since));
  fill($('ctrlMonitor'), [
    el('div.srow', [
      el('span.srow__text', [el('b', 'Obrazovka u postele'), el('em', meta)]),
      el('span.srow__state' + (on && !monitorBusy ? '.is-acc' : !usable && monitor ? '.is-planned' : ''), { 'aria-live': 'polite' },
        monitorBusy ? '…' : on ? 'zapnuto' : usable ? 'vypnuto' : 'nenastaveno'),
      el('button.switch' + (monitorBusy ? '.is-busy' : ''), {
        type: 'button', 'aria-pressed': String(on), 'aria-label': 'Druhý monitor',
        disabled: !usable || !!monitorBusy,
        onclick: function () { setMonitor(!on); }
      }, el('span.switch__knob'))
    ]),
    last ? el('p.srow__last', last) : null
  ]);
}

/* ---- the morning checklist ---------------------------------------------------
   The default list, for the coming mornings: today's record is not touched
   (the morning screen's own editor does that). One-offs Kacey added for the
   next morning show with "jen zítra" and can be renamed or removed here. */

function checklist() { return store.data.morning || { items: [], once: [] }; }

function patchChecklist(fn) {
  store.patch('morning', function (m) {
    var cur = m || { items: [], once: [] };
    return fn({ items: cur.items.slice(), once: cur.once.slice() });
  });
}

function renderChecklist() {
  if (!$('ctrlCheckRows')) return;
  var c = checklist();
  var rows = c.items.map(function (i) { return { key: i.key, label: i.label }; })
    .concat(c.once.map(function (o) { return { key: o.key, label: o.label, once: true, note: o.note }; }));
  $('ctrlCheckCount').textContent = itemsWord(c.items.length) + (c.once.length ? ' · ' + c.once.length + ' jen zítra' : '');
  renderRows($('ctrlCheckRows'), rows, {
    variant: 'ctrl',
    onRename: function (key, label) {
      patchChecklist(function (m) {
        m.items = m.items.map(function (i) { return i.key === key ? { key: i.key, label: label } : i; });
        m.once = m.once.map(function (o) { return o.key === key ? Object.assign({}, o, { label: label }) : o; });
        return m;
      });
    },
    onRemove: function (key) {
      var before = checklist();
      var gone = rows.filter(function (r) { return r.key === key; })[0];
      patchChecklist(function (m) {
        m.items = m.items.filter(function (i) { return i.key !== key; });
        m.once = m.once.filter(function (o) { return o.key !== key; });
        return m;
      });
      say((gone ? gone.label : 'Položka') + ' odebráno z ranního checklistu', {
        label: 'Vrátit', run: function () { store.patch('morning', before); }
      });
    },
    onMove: function (key, to) {
      patchChecklist(function (m) {
        var from = m.items.findIndex(function (i) { return i.key === key; });
        if (from < 0) return m;
        var item = m.items.splice(from, 1)[0];
        m.items.splice(to, 0, item);
        return m;
      });
    }
  });
}

function initChecklist() {
  if (!$('ctrlCheckAdd')) return;
  $('ctrlCheckAdd').appendChild(addRow({
    variant: 'ctrl',
    onAdd: function (label) {
      if (checklist().items.length >= MAX_ITEMS) { say('Checklist má už ' + MAX_ITEMS + ' položek.'); return; }
      patchChecklist(function (m) { m.items.push({ key: newKey(), label: label }); return m; });
      say(label + ' přidáno do ranního checklistu · od zítřka', null, function () { go('morning'); });
    }
  }));
}

function render() {
  if (!$('ctrlSources')) return;
  renderChecklist();
  if (!calCounts) loadCalCounts();
  renderMonitor();
  loadMonitor();
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
  initChecklist();

  onEnter('controller', render);
  setInterval(function () { if (currentView() === 'controller' && !monitorBusy) loadMonitor(); }, 5000);
  store.onChange(function () { if (currentView() === 'controller') render(); });
  onNight(function (what) { if (what === 'state' && currentView() === 'controller') renderNightState(); });
}
