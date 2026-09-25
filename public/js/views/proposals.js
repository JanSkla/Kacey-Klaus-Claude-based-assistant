/* =========================================================================
   PROPOSAL REVIEW — one card at a time.

   What the night's reasoning pass suggested for the day's unusual events
   (docs/DREAM.md §11; Claude Design "Kacey DREAM" 2a–2d). The task, its
   suggested due time, WHY, the event it is about and how sure Kacey is.
   Přijmout / Upravit (name and due, in the card) / Zamítnout. Accepting makes
   a task with origin 'dream'; every decision is kept — they are what the
   learning loop learns from. After the last one, back to the morning.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { el, fill } from '../core/el.js';
import { go, onEnter, currentView } from '../ui/router.js';
import { say } from '../ui/toast.js';
import { night, onNight, loadProposals, decideProposal } from '../net/nightapi.js';
import { addDays, logicalToday, dueLabel } from '../core/due.js';

var session = [];          // this sitting's proposals, in order, with what was decided
var cursor = 0;
var editing = false;
var draft = { label: '', date: '', time: '' };
var backTimer = 0;
var busy = false;

function pending() { return night.proposals.filter(function (p) { return p.status === 'pending'; }); }

/* A sitting starts with whatever is pending, and keeps its order while you go
   through it — a list that reshuffled under your thumb would be worse than
   useless. Decided ones stay in `session` for the summary. */
function startSession() {
  var ids = session.map(function (p) { return p.proposal_id; });
  pending().forEach(function (p) { if (ids.indexOf(p.proposal_id) === -1) session.push({ proposal_id: p.proposal_id, p: p, result: null }); });
  session = session.filter(function (s) { return s.result || pending().some(function (p) { return p.proposal_id === s.proposal_id; }); });
  cursor = session.findIndex(function (s) { return !s.result; });
  if (cursor < 0) cursor = session.length;
}

function current() { return session[cursor] || null; }

function confidence(c) {
  var n = Math.max(1, Math.min(5, Math.round(c * 5)));
  return { bars: n, word: c >= 0.7 ? 'vysoká' : c >= 0.45 ? 'střední' : 'nízká' };
}

/** "Zubař MUDr. Nová · do zítra 09:45" — the event, and until when the proposal makes sense. */
function aboutText(p) {
  if (!p.about_end) return p.about_title;
  var d = new Date(p.about_end);
  var pad = function (n) { return ('0' + n).slice(-2); };
  var stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  return p.about_title + ' · do ' + dueLabel(stamp);
}

/* ---- rendering ------------------------------------------------------------------ */

function renderHead() {
  var total = session.length;
  var decided = session.filter(function (s) { return s.result; }).length;
  $('pCount').textContent = Math.min(decided + (cursor < total ? 1 : 0), total) + ' / ' + total;
  fill($('pSegs'), session.map(function (s, i) {
    return el('span.segbar__seg' + (s.result ? '.is-done' : i === cursor ? '.is-current' : ''));
  }));
}

function whenOptions() {
  var today = logicalToday();
  var names = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];
  var out = [{ label: 'Dnes', date: today }, { label: 'Zítra', date: addDays(today, 1) }];
  for (var i = 2; i <= 3; i++) {
    var d = addDays(today, i), p = d.split('-').map(Number);
    var wd = names[new Date(p[0], p[1] - 1, p[2], 12).getDay()];
    out.push({ label: wd.charAt(0).toUpperCase() + wd.slice(1) + ' ' + p[2] + '.', date: d });
  }
  return out;
}

function renderCard() {
  var s = current();
  var live = !!s;
  $('pLive').hidden = !live;
  $('pFinal').hidden = live || !session.length;
  $('pEmpty').hidden = live || !!session.length;
  if (!live) { renderFinal(); return; }

  var p = s.p;
  var last = session.slice(0, cursor).reverse().find(function (x) { return x.result && x.result !== 'rejected'; });
  $('pAccepted').hidden = !last || session.indexOf(last) !== cursor - 1;
  if (last) $('pAcceptedText').textContent = 'Přijato · ' + last.p.label + (last.p.due_at ? ', ' + dueLabel(last.p.due_at) : '');

  $('pView').hidden = editing;
  $('pEdit').hidden = !editing;
  $('pActs').hidden = editing;
  $('pEditActs').hidden = !editing;

  $('pName').textContent = p.label;
  $('pDue').textContent = p.due_at ? dueLabel(p.due_at) : 'bez termínu';
  $('pWhy').textContent = p.reason || '—';
  $('pEvent').textContent = aboutText(p);
  var c = confidence(Number(p.confidence) || 0);
  fill($('pConf'), [0, 1, 2, 3, 4].map(function (i) { return el('span.confbar__bar' + (i < c.bars ? '.is-on' : '')); }));
  $('pConfWord').textContent = c.word;

  if (editing) {
    $('pEditName').value = draft.label;
    var opts = whenOptions();
    var known = opts.some(function (o) { return o.date === draft.date; });
    fill($('pWhen'), opts.map(function (o) {
      return el('button.seg__opt', {
        type: 'button', 'aria-pressed': String(o.date === draft.date),
        onclick: function () { draft.date = o.date; draft.label = $('pEditName').value; renderCard(); }
      }, o.label);
    }).concat(el('button.seg__opt', {
      type: 'button', 'aria-pressed': String(!known),
      onclick: function () { draft.label = $('pEditName').value; $('pWhenDate').hidden = false; $('pWhenDate').focus(); }
    }, 'Jiný den')));
    $('pWhenDate').hidden = known;
    $('pWhenDate').value = draft.date;
    $('pWhenTime').value = draft.time;
  }
}

function renderFinal() {
  if (!session.length) return;
  var acc = session.filter(function (s) { return s.result === 'accepted' || s.result === 'edited'; }).length;
  var rej = session.filter(function (s) { return s.result === 'rejected'; }).length;
  $('pFinalSum').textContent = acc + ' ' + (acc === 1 ? 'přijat' : 'přijaty') + ' · ' + rej + ' ' + (rej === 1 ? 'zamítnut' : 'zamítnuty');
  fill($('pResults'), session.map(function (s) {
    var res = s.result === 'rejected' ? 'zamítnuto' : s.result === 'edited' ? 'upraveno a přijato' : 'přijato';
    return el('div.propresult', [el('span', s.p.label), el('span.propresult__res' + (s.result === 'rejected' ? '' : '.is-ok'), res)]);
  }));
  clearTimeout(backTimer);
  backTimer = setTimeout(function () { if (currentView() === 'proposals' && !current()) go('morning'); }, 3000);
}

function render() {
  if (!$('pLive') || currentView() !== 'proposals') return;
  renderHead(); renderCard();
}

/* ---- deciding -------------------------------------------------------------------- */

function decide(action) {
  var s = current();
  if (!s || busy) return;
  var body = { action: action };
  if (action === 'edit') {
    var label = $('pEditName').value.trim();
    var date = $('pWhenDate').hidden ? draft.date : ($('pWhenDate').value || draft.date);
    var time = $('pWhenTime').value;
    body.label = label || s.p.label;
    body.due_at = date + (time ? 'T' + time : '');
  }
  busy = true;
  decideProposal(s.proposal_id, body).then(function (out) {
    s.result = action === 'accept' ? 'accepted' : action === 'edit' ? 'edited' : 'rejected';
    if (out && out.proposal) s.p = out.proposal;
    editing = false;
    cursor++;
    render();
  }).catch(function (e) { say('Nepovedlo se: ' + e.message); })
    .finally(function () { busy = false; });
}

function startEdit() {
  var s = current();
  if (!s) return;
  var due = s.p.due_at || '';
  draft = { label: s.p.label, date: due.slice(0, 10) || logicalToday(), time: due.slice(11, 16) };
  editing = true;
  renderCard();
  $('pEditName').focus();
}

export function initProposals() {
  if (!$('pLive')) return;
  $('pAccept').addEventListener('click', function () { decide('accept'); });
  $('pEditBtn').addEventListener('click', startEdit);
  $('pReject').addEventListener('click', function () { decide('reject'); });
  $('pSave').addEventListener('click', function () { decide('edit'); });
  $('pCancel').addEventListener('click', function () { editing = false; renderCard(); });
  $('pWhenDate').addEventListener('change', function () { draft.date = $('pWhenDate').value; draft.label = $('pEditName').value; });
  $('pWhenTime').addEventListener('change', function () { draft.time = $('pWhenTime').value; });
  $('pBack').addEventListener('click', function () { go('morning'); });

  onEnter('proposals', function () {
    session = []; cursor = 0; editing = false;
    loadProposals().then(function () { startSession(); render(); });
    render();
  });
  onNight(function (what) {
    // Not mid-decision: the reload that follows our own decision would drop
    // the card before its result is recorded.
    if (what === 'proposals' && currentView() === 'proposals' && !busy) { startSession(); render(); }
  });
}
