/* =========================================================================
   THE JOURNAL LIBRARY.

   Every entry, filterable and searchable. Cards rather than rows because what
   you are looking for is usually a feeling you half-remember, and a summary is
   the only thing that finds it.

   Filters are derived from the entries' own tags rather than fixed, so a tag
   Kacey adds in conversation turns up here without anything being changed.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { el, fill } from '../core/el.js';
import * as store from '../core/store.js';
import { go, onEnter } from '../ui/router.js';
import { say } from '../ui/toast.js';
import { openEntry, newEntry, wordCount, forgetEntry } from './journal.js';

var filter = 'all';
var query = '';
var pendingDelete = null;   // entry id awaiting its second tap

function entries() { return store.data.journal.entries || []; }

function allTags() {
  var seen = {};
  entries().forEach(function (e) {
    (e.tags || []).forEach(function (t) { seen[t] = (seen[t] || 0) + 1; });
  });
  // Commonest first, then alphabetical — a long tail of one-offs at the end is
  // noise in a filter bar.
  return Object.keys(seen).sort(function (a, b) {
    return seen[b] - seen[a] || (a < b ? -1 : 1);
  }).slice(0, 6);
}

function matching() {
  var q = query.trim().toLowerCase();
  return entries().filter(function (e) {
    var okFilter = filter === 'all'
      || (filter === 'unfinished' ? !!e.unfinished : (e.tags || []).indexOf(filter) >= 0);
    if (!okFilter) return false;
    if (!q) return true;
    return ((e.title || '') + ' ' + (e.text || '') + ' ' + (e.summary || '')).toLowerCase().indexOf(q) >= 0;
  }).slice().reverse();
}

function whenLabel(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return '—';
  var today = new Date();
  var clock = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === today.toDateString()) return 'Dnes ' + clock;
  return d.getDate() + '. ' + (d.getMonth() + 1) + '. ' + clock;
}

/** The first two sentences — enough to recognise an entry, short enough to scan. */
function excerpt(text) {
  var t = String(text || '').trim();
  if (!t) return 'Prázdný zápis.';
  var cut = t.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
  return cut.length > 220 ? cut.slice(0, 217) + '…' : cut;
}

function renderFilters() {
  var options = ['all', 'unfinished'].concat(allTags());
  fill($('libFilters'), options.map(function (f) {
    return el('button.chip.chip--filter', {
      type: 'button', 'aria-pressed': String(filter === f),
      onclick: function () { filter = f; render(); }
    }, f === 'all' ? 'Vše' : f === 'unfinished' ? 'Rozepsané' : f);
  }));
}

/* Two taps, not a dialog. A journal entry is worth confirming — it is the one
   thing here nobody can write again — but a modal for every tidy-up is worse
   than the risk. The armed state reverts on its own after a few seconds. */
function deleteButton(entry) {
  var armed = pendingDelete === entry.id;
  return el('button.btn.btn--sm' + (armed ? '.btn--dangerfill' : '.btn--dangerghost'), {
    type: 'button',
    'aria-label': armed ? 'Opravdu smazat zápis' : 'Smazat zápis',
    onclick: function () {
      if (!armed) {
        pendingDelete = entry.id;
        render();
        setTimeout(function () {
          if (pendingDelete === entry.id) { pendingDelete = null; render(); }
        }, 4000);
        return;
      }
      pendingDelete = null;
      forgetEntry(entry.id);
      store.patch('journal', Object.assign({}, store.data.journal, {
        entries: entries().filter(function (x) { return x.id !== entry.id; })
      }));
      say('Zápis smazán · ' + (entry.title || 'bez názvu'));
    }
  }, armed ? 'Opravdu?' : '×');
}

function render() {
  if (!$('libEntries')) return;
  renderFilters();

  var list = matching();
  var total = entries().length;
  $('libCount').textContent = list.length + ' z ' + total + ' zobrazeno';

  fill($('libEntries'), list.length ? list.map(function (e) {
    return el('article.entry' + (e.unfinished ? '.is-unfinished' : ''), [
      el('div.entry__head', [
        el('span.entry__when', whenLabel(e.created) + (e.unfinished ? ' · rozepsané' : '')),
        el('span', wordCount(e.text) + ' sl.')
      ]),
      el('h3', e.title || 'Bez názvu'),
      el('p', excerpt(e.text)),
      e.summary ? el('p.entry__diag', e.summary) : null,
      el('div.entry__foot', [
        (e.tags || []).map(function (t) {
          return el('button.chip', { type: 'button', onclick: function () { filter = t; render(); } }, t);
        }),
        el('button.btn.btn--sm.push', {
          type: 'button',
          onclick: function () { openEntry(e.id); go('journal'); }
        }, 'Otevřít'),
        deleteButton(e)
      ])
    ]);
  }) : el('div.entry', { style: 'grid-column:1/-1;padding:28px' }, [
    el('h3', 'Nic neodpovídá.'),
    el('p', 'Zruš filtr, nebo začni novou relaci a promluv si o tom.'),
    el('button.btn.btn--accent', {
      type: 'button',
      onclick: function () { filter = 'all'; query = ''; $('libQuery').value = ''; render(); }
    }, 'Zrušit filtry')
  ]));

  renderMonthNote();
}

/* A real observation about the month, computed from the entries — a made-up
   one would make the rest of the numbers here untrustworthy. */
function renderMonthNote() {
  var now = new Date();
  var thisMonth = entries().filter(function (e) {
    var d = new Date(e.created);
    return !isNaN(d) && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  if (!thisMonth.length) {
    $('libMonthNote').textContent = 'Tenhle měsíc zatím nic.';
    return;
  }
  var late = thisMonth.filter(function (e) {
    var h = new Date(e.created).getHours();
    return h >= 22 || h < 2;
  }).length;
  $('libMonthNote').textContent = thisMonth.length + ' zápisů' +
    (late ? '. ' + late + ' z nich mezi 22:00 a 02:00.' : '.');
}

export function initLibrary() {
  if (!$('libEntries')) return;

  $('libQuery').addEventListener('input', function () { query = $('libQuery').value; render(); });
  $('libNew').addEventListener('click', function () { newEntry(); go('journal'); });
  $('libReport').addEventListener('click', function () {
    say('Přehled vzorců se počítá z tvých zápisů — zeptej se na něj Kacey v chatu.');
  });
  $('libExport').addEventListener('click', exportEntries);

  onEnter('library', render);
  store.onChange(function () { if (!$('#library')) render(); });
}

/* Markdown, one file, downloaded locally. Nothing leaves the machine — the
   journal is the most private thing in the app and an export that posted it
   somewhere would be the wrong default. */
function exportEntries() {
  var list = entries();
  if (!list.length) { say('Není co exportovat.'); return; }

  var text = list.map(function (e) {
    return '## ' + (e.title || 'Bez názvu') + '\n\n' +
      '*' + whenLabel(e.created) + (e.tags && e.tags.length ? ' · ' + e.tags.join(', ') : '') + '*\n\n' +
      (e.text || '') + '\n';
  }).join('\n---\n\n');

  var blob = new Blob(['# Deník\n\n' + text], { type: 'text/markdown' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'kacey-denik-' + new Date().toISOString().slice(0, 10) + '.md';
  a.click();
  URL.revokeObjectURL(url);
  say('Exportováno ' + list.length + ' zápisů do Markdownu.');
}
