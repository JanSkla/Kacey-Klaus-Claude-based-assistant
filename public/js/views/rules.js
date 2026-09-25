/* =========================================================================
   THE RULES EDITOR.

   The night routine's rules (docs/DREAM.md §8; Claude Design "Kacey DREAM"
   3a–3j): "when the calendar or the routine has X, create task Y at time Z".
   Desktop: rulesets and their rules on the left, the editor in the middle, a
   live 7-day preview on the right. A phone walks the same three panes one at
   a time (sets → rules in a set → the editor), keyed off `data-step`.

   The server validates with the same schema Kacey's rule_upsert tool uses,
   and the preview is the same function the night run executes — so what the
   preview shows is what the night will create. Kacey can also write rules by
   talking; they appear here through app_changed.
   ========================================================================= */

import { $ } from '../core/dom.js';
import * as dom from '../core/dom.js';
import { el, fill } from '../core/el.js';
import { CATS, CATEGORY_KEYS } from '../core/routine-cats.js';
import { go, onEnter, currentView } from '../ui/router.js';
import { say } from '../ui/toast.js';
import {
  night, onNight, loadRules, saveRule, deleteRule, saveRuleset, previewRule, closeOffer
} from '../net/nightapi.js';

var setId = null;          // the ruleset open on the left
var ruleId = null;         // the rule in the editor; 'new' for an unsaved one; null for none
var draft = null;          // the editor's working copy
var saved = null;          // JSON of what is stored, to tell "uloženo" from "neuloženo"
var previewTimer = 0;
var previewSeq = 0;
var deleteArmed = 0;
var offerKind = null;      // the rule being written came from a learning-loop offer (§13)

var TIMING = [
  { key: 'evening_before', label: 'Večer předem', at: '20:00' },
  { key: 'morning_of', label: 'Ráno v den', at: '07:00' },
  { key: 'before_start', label: 'X min před' }
];
var LENGTHS = [null, 5, 10, 15, 30];

/* ---- the model --------------------------------------------------------------- */

function sets() { return night.rulesets || []; }
function currentSet() { return sets().find(function (s) { return s.id === setId; }) || null; }
function findRule(id) {
  for (var i = 0; i < sets().length; i++) {
    var r = sets()[i].rules.find(function (x) { return x.id === id; });
    if (r) return r;
  }
  return null;
}

function blankRule() {
  return {
    name: 'Nové pravidlo', enabled: true,
    trigger: { sources: ['calendar'], calendar_match: [] },
    timing: { anchor: 'evening_before', at: '20:00' },
    task: { label: '' }
  };
}

function toDraft(rule) {
  var t = rule.trigger || {}, tm = rule.timing || {}, k = rule.task || {};
  return {
    name: rule.name || '',
    enabled: rule.enabled !== false,
    sources: (t.sources || ['calendar']).slice(),
    kw: (t.calendar_match || []).slice(),
    cat: t.routine_category || 'gym',
    noteKw: (t.routine_note_match || []).slice(),
    beforeOn: !!t.starts_before,
    before: t.starts_before || '10:00',
    anchor: tm.anchor || 'evening_before',
    at: tm.at || (TIMING.find(function (x) { return x.key === tm.anchor; }) || TIMING[0]).at || '20:00',
    offset: tm.offset_min == null ? 60 : tm.offset_min,
    label: k.label || '',
    meta: k.meta || '',
    duration: k.duration_min || null,
    items: (k.checklist || []).slice()
  };
}

/** The draft as the server's rule shape. */
function payload(d) {
  var trigger = { sources: d.sources.slice() };
  if (d.sources.indexOf('calendar') !== -1) trigger.calendar_match = d.kw.slice();
  if (d.sources.indexOf('routine') !== -1) {
    trigger.routine_category = d.cat;
    if (d.noteKw.length) trigger.routine_note_match = d.noteKw.slice();
  }
  if (d.beforeOn && d.before) trigger.starts_before = d.before;
  var timing = { anchor: d.anchor };
  if (d.anchor === 'before_start') timing.offset_min = Math.max(0, Math.min(1440, Number(d.offset) || 0));
  else timing.at = d.at;
  var task = { label: d.label.trim() };
  if (d.meta.trim()) task.meta = d.meta.trim();
  if (d.duration) task.duration_min = d.duration;
  if (d.items.length) task.checklist = d.items.slice();
  return { name: d.name.trim() || 'Pravidlo', enabled: d.enabled, trigger: trigger, timing: timing, task: task };
}

function timingWords(tm) {
  if (tm.anchor === 'evening_before') return 'večer předem ' + (tm.at || '20:00');
  if (tm.anchor === 'morning_of') return 'ráno v den ' + (tm.at || '07:00');
  return (tm.offset_min == null ? 60 : tm.offset_min) + ' min před';
}

/** "Posilovna → večer předem 20:00 → Sbalit tašku" — the same words as the server's describeRule. */
function summary(rule) {
  return rule.name + ' → ' + timingWords(rule.timing || {}) + ' → ' + ((rule.task && rule.task.label) || '…');
}

function isDirty() { return !!draft && JSON.stringify(payload(draft)) !== saved; }

function plural(n) { return n === 1 ? '1 pravidlo' : n >= 2 && n <= 4 ? n + ' pravidla' : n + ' pravidel'; }

function setStep(step) {
  var view = document.querySelector('.view[data-view="rules"]');
  if (view) view.setAttribute('data-step', step);
}

/* ---- opening things ---------------------------------------------------------------- */

function openSet(id) {
  setId = id;
  setStep('set');
  renderLists();
}

function openRule(id) {
  // Switching away drops unsaved edits; say so rather than lose them silently.
  if (isDirty() && id !== ruleId) say('Neuložené úpravy pravidla „' + draft.name + '“ zahozeny.');
  var rule = id === 'new' ? blankRule() : findRule(id);
  if (!rule) return;
  ruleId = id;
  draft = toDraft(rule);
  saved = id === 'new' ? null : JSON.stringify(payload(draft));
  deleteArmed = 0;
  setStep('edit');
  renderAll();
  schedulePreview();
}

/* ---- rendering ----------------------------------------------------------------------- */

function switchFor(on, label, onToggle) {
  return el('button.switch', {
    type: 'button', 'aria-pressed': String(!!on), 'aria-label': label,
    onclick: function (ev) { ev.stopPropagation(); onToggle(!on); }
  }, el('span.switch__knob'));
}

function renderLists() {
  var list = sets();
  if (setId && !currentSet()) setId = null;
  if (!setId && list.length) setId = list[0].id;

  fill($('rSets'), list.length ? list.map(function (s) {
    var n = s.rules.length;
    return el('div.ruleset' + (s.id === setId ? '.is-current' : ''), {
      role: 'button', tabindex: '0',
      onclick: function () { openSet(s.id); },
      onkeydown: function (ev) { if (ev.key === 'Enter') openSet(s.id); }
    }, [
      el('span.ruleset__text', [el('b', s.name), el('em', plural(n) + (s.enabled ? '' : ' · vypnuto'))]),
      switchFor(s.enabled, 'Zapnout sadu ' + s.name, function (on) {
        saveRuleset(s.id, { enabled: on }).catch(function (e) { say(e.message); });
      }),
      el('span.ruleset__go.phone-only', { 'aria-hidden': 'true' }, '›')
    ]);
  }) : el('p.empty', 'Žádná sada. Založ první — nebo řekni Kacey, co si má hlídat.'));

  var set = currentSet();
  $('rSetTitle').textContent = set ? 'Pravidla · ' + set.name : 'Pravidla';
  fill($('rSetSwitch'), set ? switchFor(set.enabled, 'Zapnout sadu', function (on) {
    saveRuleset(set.id, { enabled: on }).catch(function (e) { say(e.message); });
  }) : null);
  $('rAddRule').disabled = !set;
  fill($('rRules'), set ? (set.rules.length ? set.rules.map(function (r) {
    return el('div.ruleset' + (r.id === ruleId ? '.is-current' : '') + (r.invalid ? '.is-invalid' : ''), {
      role: 'button', tabindex: '0',
      onclick: function () { openRule(r.id); },
      onkeydown: function (ev) { if (ev.key === 'Enter') openRule(r.id); }
    }, [
      el('span.ruleset__text', [el('b', r.name), el('em', r.invalid ? 'neplatné: ' + r.invalid : summary(r))]),
      switchFor(r.enabled, 'Zapnout pravidlo ' + r.name, function (on) {
        saveRule(r.id, { enabled: on }).catch(function (e) { say(e.message); });
      })
    ]);
  }) : el('p.empty', 'V sadě zatím nic není.')) : null);
}

function tagList(host, words, onRemove, onAdd, placeholder) {
  var input = el('input.input.tag__input', {
    type: 'text', placeholder: placeholder || 'Přidat…', 'aria-label': placeholder || 'Přidat',
    onkeydown: function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ',') return;
      ev.preventDefault();
      var v = input.value.trim().replace(/,$/, '');
      if (v) { onAdd(v); }
    },
    onblur: function () { var v = input.value.trim(); if (v) onAdd(v); }
  });
  fill(host, words.map(function (w, i) {
    return el('span.tag', [w, el('button.tag__x', { type: 'button', 'aria-label': 'Odebrat ' + w, onclick: function () { onRemove(i); } }, '×')]);
  }).concat(input));
}

function seg(host, options, current, onPick) {
  fill(host, options.map(function (o) {
    return el('button.seg__opt', {
      type: 'button', 'aria-pressed': String(o.value === current),
      onclick: function () { onPick(o.value); }
    }, o.label);
  }));
}

function change(fn) {
  return function () { fn.apply(null, arguments); renderEditor(); schedulePreview(); };
}

function renderEditor() {
  var has = !!draft;
  $('rForm').hidden = !has;
  $('rFoot').hidden = !has;
  $('rNone').hidden = has;
  $('rNameRow').hidden = !has;
  if (!has) { renderPreview(null); return; }
  var d = draft;

  if (document.activeElement !== $('rName')) $('rName').value = d.name;
  $('rSaved').textContent = ruleId === 'new' ? 'neuloženo' : (isDirty() ? 'neuloženo' : 'uloženo');

  var src = d.sources.length === 2 ? 'both' : d.sources[0];
  seg($('rSource'), [
    { value: 'calendar', label: 'Kalendář' }, { value: 'routine', label: 'Rutina' }, { value: 'both', label: 'Obojí' }
  ], src, change(function (v) { d.sources = v === 'both' ? ['calendar', 'routine'] : [v]; }));

  $('rKwBox').hidden = d.sources.indexOf('calendar') === -1;
  $('rCatBox').hidden = d.sources.indexOf('routine') === -1;
  tagList($('rKw'), d.kw, change(function (i) { d.kw.splice(i, 1); }), change(function (v) { if (d.kw.indexOf(v) === -1) d.kw.push(v); }), 'Přidat…');
  tagList($('rNoteKw'), d.noteKw, change(function (i) { d.noteKw.splice(i, 1); }), change(function (v) { if (d.noteKw.indexOf(v) === -1) d.noteKw.push(v); }), 'Přidat…');

  fill($('rCats'), CATEGORY_KEYS.map(function (k) {
    return el('button.catpick__opt', {
      type: 'button', 'aria-pressed': String(d.cat === k), style: '--cat:' + CATS[k].color,
      onclick: change(function () { d.cat = k; })
    }, [el('span.catpick__sw', { 'aria-hidden': 'true' }), CATS[k].label]);
  }));

  $('rBeforeOn').checked = d.beforeOn;
  $('rBefore').disabled = !d.beforeOn;
  if (document.activeElement !== $('rBefore')) $('rBefore').value = d.before;

  seg($('rTiming'), TIMING.map(function (t) { return { value: t.key, label: t.label }; }), d.anchor, change(function (v) {
    d.anchor = v;
    var t = TIMING.find(function (x) { return x.key === v; });
    if (t && t.at) d.at = t.at;
  }));
  var mins = d.anchor === 'before_start';
  $('rAt').hidden = mins;
  $('rOffset').hidden = !mins;
  $('rTimingLabel').textContent = mins ? 'minut před začátkem' : 'v';
  if (document.activeElement !== $('rAt')) $('rAt').value = d.at;
  if (document.activeElement !== $('rOffset')) $('rOffset').value = d.offset;

  if (document.activeElement !== $('rTask')) $('rTask').value = d.label;
  $('rTask').classList.toggle('is-missing', !d.label.trim());
  if (document.activeElement !== $('rMeta')) $('rMeta').value = d.meta;

  seg($('rLen'), LENGTHS.map(function (n) { return { value: n, label: n ? n + ' min' : '—' }; }), d.duration, change(function (v) { d.duration = v; }));

  fill($('rItems'), d.items.map(function (label, i) {
    return el('div.ruleitem', [
      el('span.ruleitem__box', { 'aria-hidden': 'true' }),
      el('span.ruleitem__label', label),
      el('button.tag__x', { type: 'button', 'aria-label': 'Odebrat ' + label, onclick: change(function () { d.items.splice(i, 1); }) }, '×')
    ]);
  }));

  $('rDelete').hidden = ruleId === 'new';
  $('rDelete').textContent = deleteArmed ? 'Opravdu smazat?' : 'Smazat pravidlo';
}

/* ---- the preview -------------------------------------------------------------------
   Debounced: typing a keyword letter by letter must not become a request per
   letter. The sequence number drops an answer that arrives after a newer one. */

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 350);
}

function runPreview() {
  if (!draft) return;
  var body = payload(draft);
  if (!body.task.label) { renderPreview([], 'Zatím nic — úkol nemá název.'); return; }
  var seq = ++previewSeq;
  previewRule({ rule: body, days: 7 }).then(function (items) {
    if (seq === previewSeq) renderPreview(items);
  }).catch(function (e) {
    if (seq === previewSeq) renderPreview([], 'Pravidlo ještě nedává smysl: ' + e.message);
  });
}

var WD = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];
function shortWhen(due) {
  var p = due.split(/[-T]/).map(Number);
  var d = new Date(p[0], p[1] - 1, p[2], 12);
  return WD[d.getDay()] + (due.length > 10 ? ' ' + due.slice(11, 16) : '');
}

function renderPreview(items, note) {
  var host = $('rPreview');
  if (!host) return;
  if (items === null) { fill(host, el('p.empty', 'Vyber pravidlo a tady uvidíš, co by v příštích 7 dnech vytvořilo.')); return; }
  var shown = (items || []).filter(function (i) { return !(i.source === 'routine' && i.overlap && i.overlap.exact); });
  fill(host, shown.length ? shown.map(function (i) {
    var flag = i.status === 'suppressed' ? ' · smazáno, nevrátí se' : i.status === 'exists' ? ' · už existuje' : '';
    return el('div.preview7__row' + (i.status === 'suppressed' ? '.is-muted' : ''), [
      el('b.num', shortWhen(i.due_at)),
      el('span', i.label),
      el('em', i.reason + flag)
    ]);
  }) : el('p.empty', note || 'V příštích 7 dnech by nevytvořilo nic — zkontroluj klíčová slova proti tomu, jak se události v kalendáři jmenují.'));
}

function renderAll() {
  if (!$('rSets') || currentView() !== 'rules') return;
  renderLists();
  renderEditor();
}

/* ---- saving ------------------------------------------------------------------------ */

function save() {
  if (!draft) return;
  var body = payload(draft);
  if (!body.task.label) { say('Úkol potřebuje název.'); $('rTask').focus(); return; }
  if (ruleId === 'new') body.ruleset_id = setId;
  saveRule(ruleId === 'new' ? null : ruleId, body).then(function (b) {
    if (b.rule) { ruleId = b.rule.id; draft = toDraft(b.rule); saved = JSON.stringify(payload(draft)); }
    // Made from an offer: that kind is a rule now, and is not offered again.
    if (offerKind) { closeOffer(offerKind, 'ruled'); offerKind = null; }
    say('Pravidlo uloženo.');
    renderAll();
    schedulePreview();
  }).catch(function (e) { say('Neuloženo: ' + e.message); });
}

function cancel() {
  if (ruleId === 'new') { ruleId = null; draft = null; saved = null; setStep('set'); renderAll(); return; }
  openRule(ruleId);
}

function remove() {
  if (!ruleId || ruleId === 'new') return;
  if (!deleteArmed) {
    deleteArmed = setTimeout(function () { deleteArmed = 0; renderEditor(); }, 4000);
    renderEditor();
    return;
  }
  clearTimeout(deleteArmed); deleteArmed = 0;
  var name = draft.name;
  deleteRule(ruleId).then(function () {
    ruleId = null; draft = null; saved = null;
    setStep('set');
    say('Pravidlo „' + name + '“ smazáno. Úkoly, které už vytvořilo, zůstávají.');
    renderAll();
  }).catch(function (e) { say(e.message); });
}

/* ---- wiring --------------------------------------------------------------------------- */

export function initRules() {
  if (!$('rSets')) return;

  $('rNewSet').addEventListener('click', function () {
    $('rNewSetForm').hidden = !$('rNewSetForm').hidden;
    if (!$('rNewSetForm').hidden) $('rNewSetName').focus();
  });
  $('rNewSetForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var name = $('rNewSetName').value.trim();
    if (!name) return;
    saveRuleset(null, { name: name }).then(function (b) {
      $('rNewSetName').value = ''; $('rNewSetForm').hidden = true;
      if (b.ruleset) openSet(b.ruleset.id);
    }).catch(function (e) { say(e.message); });
  });
  $('rAddRule').addEventListener('click', function () { if (setId) openRule('new'); });
  $('rBackSets').addEventListener('click', function () { setStep('sets'); });
  $('rBackSet').addEventListener('click', function () { setStep('set'); });

  $('rName').addEventListener('input', function () { draft.name = $('rName').value; renderEditor(); schedulePreview(); });
  $('rBeforeOn').addEventListener('change', function () { draft.beforeOn = $('rBeforeOn').checked; renderEditor(); schedulePreview(); });
  $('rBefore').addEventListener('change', function () { draft.before = $('rBefore').value; renderEditor(); schedulePreview(); });
  $('rAt').addEventListener('change', function () { draft.at = $('rAt').value; renderEditor(); schedulePreview(); });
  $('rOffset').addEventListener('input', function () { draft.offset = Number($('rOffset').value) || 0; renderEditor(); schedulePreview(); });
  $('rTask').addEventListener('input', function () { draft.label = $('rTask').value; renderEditor(); schedulePreview(); });
  $('rMeta').addEventListener('input', function () { draft.meta = $('rMeta').value; renderEditor(); });
  $('rItemAdd').addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    var v = $('rItemAdd').value.trim();
    if (!v) return;
    draft.items.push(v); $('rItemAdd').value = '';
    renderEditor();
  });

  $('rSave').addEventListener('click', save);
  $('rCancel').addEventListener('click', cancel);
  $('rDelete').addEventListener('click', remove);

  /* "Říct pravidlo": the chat, with the sentence started. Kacey writes the
     rule with rule_upsert and it turns up here. */
  $('rSay').addEventListener('click', function () {
    go('main');
    if (dom.input) { dom.input.value = 'Když mám '; dom.input.focus(); }
  });

  onEnter('rules', function () {
    loadRules().then(renderAll);
    renderAll();
  });
  onNight(function (what) {
    if (what !== 'rules' || currentView() !== 'rules') return;
    // Kacey (or another page) changed the rules: keep the editor on its rule if it still exists.
    if (ruleId && ruleId !== 'new' && !findRule(ruleId)) { ruleId = null; draft = null; saved = null; }
    else if (ruleId && ruleId !== 'new' && !isDirty()) { draft = toDraft(findRule(ruleId)); saved = JSON.stringify(payload(draft)); }
    renderAll();
  });
}

/**
 * Open the editor on a new rule, prefilled — the learning loop's "Vytvořit
 * pravidlo" (§13). Saved through the same endpoint and schema as every rule.
 */
export function editRuleDraft(rule, kind) {
  go('rules');
  loadRules().then(function () {
    if (!setId && sets().length) setId = sets()[0].id;
    ruleId = 'new';
    draft = toDraft(Object.assign({ enabled: true }, rule));
    saved = null;
    offerKind = kind || null;
    setStep('edit');
    renderAll();
    schedulePreview();
  });
}

/** Open the editor on one rule — the task row's "Upravit pravidlo". */
export function editRule(id) {
  go('rules');
  loadRules().then(function () {
    var r = findRule(id);
    if (!r) { say('To pravidlo už neexistuje.'); return; }
    setId = r.ruleset_id;
    openRule(id);
  });
}
