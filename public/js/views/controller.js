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

var SOURCES = [
  { key: 'cal_osobni', name: 'Kalendář · osobní', meta: 'čte se z klaus_memory' },
  { key: 'cal_prace', name: 'Kalendář · práce', meta: 'čte se z klaus_memory' },
  { key: 'cal_rodina', name: 'Kalendář · rodina', meta: 'čte se z klaus_memory' },
  { key: 'mail', name: 'Pošta', meta: 'v plánu · souhrny jen ke čtení', planned: true },
  { key: 'health', name: 'Zdraví — spánek, běhy', meta: 'export z hodinek · v plánu', planned: true },
  { key: 'lights', name: 'Světla v místnosti', meta: 'lokální bridge · v plánu', planned: true }
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

function render() {
  if (!$('ctrlSources')) return;
  fill($('ctrlSources'), SOURCES.map(function (r) { return toggleRow('sources', r); }));
  fill($('ctrlMemory'), MEMORY.map(function (r) { return toggleRow('memory', r); }));
  renderTools();
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

  onEnter('controller', render);
  store.onChange(function () { if (currentView() === 'controller') render(); });
}
