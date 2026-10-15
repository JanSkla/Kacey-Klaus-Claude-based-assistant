/* =========================================================================
   Improving the app from the chat (Claude Design "Kacey Self-Update").

   The server owns the job (selfupdate.js) and sends it as `upgrade` frames;
   this paints it, everywhere it shows:

     - the popup: confirm the brief (1a), or answer up to three questions first
       (1b), and the "Zrušit vylepšení?" / "Zahodit návrh?" confirmations;
     - the header chip: Navrhuji · 3/5 → Ke schválení → Dokončuji · 2/4 →
       Nová verze připravena, with its step dropdown while busy;
     - a progress card and Kacey's short notices in the chat;
     - the comparison view (#upgrade): the running app and the branch's live
       preview side by side, a draggable divider; a toggle on a phone; revision
       tabs and "Upravit promptem";
     - the toasts "Návrh je připravený k porovnání." and "Nová verze aplikace
       je připravená." — the latter's "Přepnout teď" merges and restarts, and
       the page reloads into the new version on its own.

   Nothing here decides anything: every button is one POST to /api/upgrade/*,
   and the answer comes back as the next frame.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { EMBED } from '../core/state.js';
import * as dom from '../core/dom.js';
import { el, fill } from '../core/el.js';
import { go, onEnter, currentView } from '../ui/router.js';
import { showAlert } from '../ui/log.js';

var snap = { enabled: false, job: null, last: null };
var job = null;
var prevStage = null;
var started = false;          // the first frame has been painted

/* What only this page holds: which popup is open and what is typed into it. */
var ui = {
  modal: null,           // 'confirm' | 'questions' | 'cancel' | 'discard'
  cancelFrom: null,
  q: 0, ans: [], note: '',
  keep: false,
  refine: false,
  show: 'new',           // the phone's toggle
  split: 0.5,
  toast: null,           // 'review' | 'ready'
  toastFor: null,        // the job id the toast was dismissed for
  card: null,            // the progress card in the chat
};

var BUSY = ['drafting', 'refining', 'finalizing', 'switching'];
var PHONE = window.matchMedia ? window.matchMedia('(max-width: 760px)') : { matches: false };

/* ---- the wire ------------------------------------------------------------ */

function post(action, body) {
  return fetch('/api/upgrade/' + action, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (data) {
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      if (data.job !== undefined) receiveUpgrade(data);
      return data;
    });
  }).catch(function (err) { showAlert(err.message); throw err; });
}

/* ---- the frame ------------------------------------------------------------ */

export function receiveUpgrade(msg) {
  var before = prevStage;
  snap = { enabled: !!msg.enabled, job: msg.job || null, last: msg.last || null };
  job = snap.job;
  var stage = job ? job.stage : null;
  if (msg.switching) showSwitching(msg.switching);
  if (started) transition(before, stage);
  else boot(stage);
  prevStage = stage;
  started = true;
  paint();
}

/* The first frame after a page load: open what is waiting, say nothing new. */
function boot(stage) {
  if (stage === 'confirm' || stage === 'questions') openModal(stage);
  if (stage === 'drafting' || stage === 'finalizing') ensureCard();
  if (stage === 'ready') ui.toast = 'ready';
  var flag = null;
  try { flag = sessionStorage.getItem('kacey.switched'); sessionStorage.removeItem('kacey.switched'); } catch (e) { /* private mode */ }
  if (flag && snap.last) {
    systemLine('Přepnuto na KC ' + snap.last.version + ' · ' + snap.last.short);
    notice('Hotovo. Nová verze běží — ' + snap.last.title + '.', viewLabel(snap.last.view), function () { go(snap.last.view); });
  }
  try {
    var draft = sessionStorage.getItem('kacey.draft');
    sessionStorage.removeItem('kacey.draft');
    if (draft && !dom.input.value) dom.input.value = draft;
  } catch (e) { /* private mode */ }
}

function transition(from, to) {
  if (from === to) return;
  if (!to) {
    // Gone: cancelled, discarded, or switched.
    closeModal();
    removeCard();
    ui.refine = false; ui.toast = null;
    if (from === 'confirm' || from === 'questions') systemLine('Vylepšení zrušeno · nic se nezměnilo');
    else if (from !== 'switching') systemLine(ui.discarded || 'Návrh zahozen');
    ui.discarded = null;
    if (currentView() === 'upgrade') go('main');
    return;
  }
  if (to === 'confirm' || to === 'questions') { openModal(to); return; }
  if (to === 'drafting') {
    closeModal();
    notice('Spouštím návrh na větvi ' + job.branch + '. Až bude náhled hotový, ozvu se — můžeš zatím pokračovat.');
    ensureCard();
  }
  if (to === 'review' && (from === 'drafting' || from === 'refining' || from === 'finalizing')) {
    removeCard();
    if (from === 'drafting') {
      notice('Návrh je hotový. Porovnej celou aplikaci před a po.', 'Otevřít porovnání', openCompare);
      if (currentView() !== 'upgrade') showToast('review');
    }
    if (from === 'finalizing') notice(job.error || 'Dokončení se nepovedlo.', 'Otevřít porovnání', openCompare);
  }
  if (to === 'finalizing') {
    ui.refine = false;
    if (currentView() === 'upgrade') go('main');
    notice('Dokončuji funkci pro produkci na pozadí — data, ukládání, telefon, testy. Dám vědět.');
    ensureCard();
  }
  if (to === 'ready') {
    removeCard();
    notice('Nová verze KC ' + job.versionTo + ' je připravená.', 'Přepnout teď', switchNow);
    showToast('ready');
  }
  if (to === 'failed') {
    removeCard();
    systemLine(job.error || 'Vylepšení se nepovedlo.');
  }
}

/* ---- Kacey's notices in the chat ------------------------------------------- */

function scrollLog() { dom.logwrap.scrollTop = dom.logwrap.scrollHeight; }

/* A line from Kacey that the page writes, not the model: the job's milestones,
   with at most one action. They are not in the conversation she remembers. */
function notice(text, actLabel, act) {
  var bubble = el('div.msg__bubble.msg__bubble--act', [el('span', text)]);
  if (actLabel) {
    bubble.appendChild(el('button.btn.btn--outlineaccent.msg__act', { type: 'button', onclick: act }, actLabel));
  }
  dom.log.appendChild(el('li.msg.msg--assistant.msg--notice', [el('p.msg__who', 'Kacey'), bubble]));
  scrollLog();
}

function systemLine(text) {
  dom.log.appendChild(el('li.msg.msg--rule', { role: 'note' }, [el('span', text)]));
  scrollLog();
}

/* The progress card (1c): the steps as a segmented bar and a list. */
function ensureCard() {
  if (ui.card && ui.card.isConnected) return;
  ui.card = el('li.upcard', { 'aria-live': 'polite' });
  dom.log.appendChild(ui.card);
  paintCard();
  scrollLog();
}

function removeCard() {
  if (ui.card) ui.card.remove();
  ui.card = null;
}

function paintCard() {
  if (!ui.card || !job) return;
  var steps = job.steps || [];
  fill(ui.card, [
    el('div.upcard__head', [
      el('span.upcard__dot', { 'aria-hidden': 'true' }),
      el('b.upcard__title', job.short),
      el('span.upcard__sub', subline()),
    ]),
    el('div.upcard__bar', { 'aria-hidden': 'true' }, steps.map(function (_, i) {
      return el('span.upcard__seg' + (i < job.cur ? '.is-done' : i === job.cur ? '.is-current' : ''));
    })),
    stepList(steps, job.cur, 'ol.upsteps.upcard__steps'),
    el('div.upcard__foot', [
      el('span.muted-3', 'Aplikace běží dál beze změny.'),
      el('button.link.link--muted.push', { type: 'button', onclick: askDiscard }, 'Zastavit'),
    ]),
  ]);
}

function stepItems(steps, cur) {
  return steps.map(function (label, i) {
    var st = i < cur ? 'done' : i === cur ? 'cur' : 'todo';
    return el('li', { 'data-st': st }, [el('span.upsteps__box', { 'aria-hidden': 'true' }), el('span', label + (st === 'cur' ? '…' : ''))]);
  });
}

function stepList(steps, cur, spec) { return el(spec, stepItems(steps, cur)); }

function subline() {
  if (!job) return '';
  if (job.stage === 'finalizing') return 'Dokončování pro produkci';
  if (job.stage === 'refining') return 'Revize ' + (job.revs.length + 1);
  return 'Návrh · ' + job.branch;
}

/* ---- the chip -------------------------------------------------------------- */

function chipLabel() {
  if (!job) return '';
  var n = (job.cur || 0) + 1, of = (job.steps || []).length;
  var phone = PHONE.matches;
  switch (job.stage) {
    case 'drafting': return 'Navrhuji' + (of ? ' · ' + n + '/' + of : '');
    case 'refining': return 'Upravuji · revize ' + (job.revs.length + 1);
    case 'finalizing': return 'Dokončuji' + (of ? ' · ' + n + '/' + of : '');
    case 'review': return 'Ke schválení' + (job.revs.length > 1 ? ' · revize ' + job.viewRev : '');
    case 'ready': return phone ? 'Připraveno' : 'Nová verze připravena';
    case 'switching': return 'Přepínám…';
    case 'failed': return 'Nepovedlo se';
    default: return '';
  }
}

function paintChip() {
  var wrap = $('upChipWrap');
  var show = !!job && job.stage !== 'confirm' && job.stage !== 'questions';
  wrap.hidden = !show;
  if (!show) { $('upDrop').hidden = true; return; }
  var chip = $('upChip');
  var st = BUSY.indexOf(job.stage) !== -1 ? 'busy' : job.stage === 'review' ? 'review' : job.stage === 'ready' ? 'ready' : 'failed';
  chip.setAttribute('data-st', st);
  $('upChipLabel').textContent = chipLabel();
  var of = (job.steps || []).length;
  $('upChipProg').style.width = st === 'busy' && of ? Math.round(((job.cur + 0.5) / of) * 100) + '%' : '0';
  chip.setAttribute('aria-expanded', String(!$('upDrop').hidden));
  // The dropdown only while a step runs (or after it failed, to say why).
  if (st !== 'busy' && st !== 'failed') $('upDrop').hidden = true;
  $('upDropTitle').textContent = job.short;
  $('upDropSub').textContent = job.stage === 'failed' ? (job.error || '') : subline();
  fill($('upDropSteps'), job.stage === 'failed' ? [] : stepItems(job.steps || [], job.cur));
  $('upDropStop').textContent = job.stage === 'failed' ? 'Zahodit' : 'Zastavit a zahodit';
}

function chipClick() {
  if (!job) return;
  if (job.stage === 'review') return openCompare();
  if (job.stage === 'ready') return switchNow();
  var drop = $('upDrop');
  drop.hidden = !drop.hidden;
  $('upChip').setAttribute('aria-expanded', String(!drop.hidden));
}

/* ---- the popup --------------------------------------------------------------- */

function openModal(kind) {
  if (kind === 'questions' || kind === 'confirm') {
    if (ui.modal !== 'questions' && ui.modal !== 'confirm' && ui.modal !== 'cancel') {
      ui.q = 0; ui.ans = (job.questions || []).map(function () { return null; }); ui.note = job.note || '';
    }
  }
  ui.modal = kind;
  paintModal();
}

function closeModal() { ui.modal = null; paintModal(); }

function ansOf(i) { return ui.ans[i] || job.questions[i].def; }
function ansText(i) {
  var q = job.questions[i];
  return ansOf(i).map(function (k) { return q.options[k]; }).join(', ');
}

function dlg(spec, label, head, body, foot) {
  return el(spec, { role: label.alert ? 'alertdialog' : 'dialog', 'aria-modal': 'true', 'aria-label': label.text }, [head, body, foot]);
}

function dlgHead(kicker, title, sub, onClose, extra) {
  return el('div.updlg__head', [
    el('div.updlg__titles', [
      el('span.updlg__kicker' + (kicker.err ? '.is-err' : ''), kicker.text),
      el('h2.updlg__title', title),
      sub ? el('span.updlg__sub', sub) : null,
    ]),
    extra || null,
    onClose ? el('button.updlg__x', { type: 'button', 'aria-label': 'Zavřít', onclick: onClose }, '×') : null,
  ]);
}

function dlgFoot(buttons) {
  return el('div.updlg__foot.updlg__foot--' + buttons.length, buttons.map(function (b) {
    return el('button.updlg__btn' + (b.kind ? '.updlg__btn--' + b.kind : ''), { type: 'button', onclick: b.run, disabled: b.disabled }, b.label);
  }));
}

function paintModal() {
  var host = $('upModal');
  if (!ui.modal || !job) { host.hidden = true; host.textContent = ''; return; }
  var node = null;

  if (ui.modal === 'confirm') {
    // An answered question with the same name ("Oblast") stands in for the guess.
    var keys = (job.questions || []).map(function (q) { return q.key; });
    var rows = [];
    if (keys.indexOf('Oblast') === -1) rows.push(el('span.updlg__k', 'Oblast'), el('span', job.area));
    if (keys.indexOf('Platformy') === -1) rows.push(el('span.updlg__k', 'Platformy'), el('span', platforms(job.platforms)));
    (job.questions || []).forEach(function (q, i) { rows.push(el('span.updlg__k', q.key), el('span', ansText(i))); });
    rows.push(el('span.updlg__k', 'Větev'), el('code.updlg__branch', job.branch));
    node = dlg('div.updlg', { text: 'Vylepšení aplikace' },
      dlgHead({ text: 'VYLEPŠENÍ APLIKACE' }, job.title, '„' + job.request + '“', function () { closeModal(); }),
      el('div.updlg__body', [
        el('div.updlg__block', [el('span.updlg__k', 'Co navrhnu'), el('ul.updlg__list', job.bullets.map(function (b) { return el('li', b); }))]),
        el('div.updlg__facts', rows),
        ui.note ? el('div.updlg__block', [el('span.updlg__k', 'Doplnění'), el('span', ui.note)]) : null,
        el('p.updlg__note', 'Pracuju na samostatné větvi. Aktuální verze běží dál beze změny, dokud návrh neschválíš.'),
      ]),
      dlgFoot([
        { label: 'Zrušit', run: askCancel },
        { label: 'Upravit zadání', kind: 'mid', run: editRequest },
        { label: 'Spustit návrh', kind: 'go', run: startDraft },
      ]));
  }

  if (ui.modal === 'questions') {
    var q = job.questions[ui.q], cur = ui.ans[ui.q] || [];
    var answered = job.questions.slice(0, ui.q).map(function (x, i) {
      return el('button.updlg__done', { type: 'button', onclick: function () { ui.q = i; paintModal(); } }, [
        el('span.updlg__donehead', [el('span.updlg__ok', 'hotovo'), x.title]),
        el('span', ansText(i)),
      ]);
    });
    var note = el('input.updlg__input', {
      type: 'text', placeholder: 'Něco dalšího k zadání…', value: ui.note, 'aria-label': 'Něco dalšího k zadání',
      oninput: function (ev) { ui.note = ev.target.value; },
    });
    node = dlg('div.updlg', { text: 'Upřesnění zadání' },
      dlgHead({ text: 'VYLEPŠENÍ APLIKACE · UPŘESNĚNÍ' }, job.title,
        'Než začnu, potřebuju vědět ' + countWord(job.questions.length) + '.', null,
        el('span.updlg__count.num', (ui.q + 1) + ' / ' + job.questions.length)),
      el('div.updlg__body', answered.concat([
        el('div.updlg__q', [
          el('span.updlg__qtitle', q.title),
          q.multi ? el('span.updlg__hint', 'Vyber jednu nebo víc možností.') : null,
          el('div.updlg__opts', { role: 'group', 'aria-label': q.title }, q.options.map(function (label, i) {
            return el('button.updlg__opt', { type: 'button', 'aria-pressed': String(cur.indexOf(i) !== -1), onclick: function () { pick(i); } }, label);
          })),
        ]),
        note,
      ])),
      dlgFoot([
        { label: 'Zrušit', run: askCancel },
        { label: 'Rozhodni za mě', kind: 'mid', run: decideForMe },
        { label: ui.q < job.questions.length - 1 ? 'Další otázka' : 'Shrnout', kind: 'go', run: nextQ, disabled: !ui.ans[ui.q] },
      ]));
  }

  if (ui.modal === 'cancel') {
    node = dlg('div.updlg', { text: 'Zrušit vylepšení', alert: true },
      dlgHead({ text: 'ZRUŠIT VYLEPŠENÍ', err: true }, 'Zrušit zadání ' + job.short + '?',
        ui.cancelFrom === 'questions'
          ? 'Odpovědi na doplňující otázky se zahodí. Aplikace zůstane beze změny.'
          : 'Zadání se zahodí a návrh se nespustí. Aplikace zůstane beze změny.'),
      null,
      dlgFoot([
        { label: 'Pokračovat v zadání', run: function () { openModal(ui.cancelFrom || 'confirm'); } },
        { label: 'Zrušit vylepšení', kind: 'danger', run: function () { post('cancel'); } },
      ]));
  }

  if (ui.modal === 'discard') {
    node = dlg('div.updlg', { text: 'Zamítnout návrh', alert: true },
      dlgHead({ text: 'ZAMÍTNOUT NÁVRH', err: true }, 'Zahodit návrh ' + job.short + '?', null),
      el('div.updlg__body.updlg__body--tight', [
        el('p.updlg__text', ['Větev ', el('code', job.branch), ' včetně všech revizí se smaže. Běžící verze KC ' + job.versionFrom + ' zůstane beze změny.']),
        el('button.updlg__check', { type: 'button', 'aria-pressed': String(ui.keep), onclick: function () { ui.keep = !ui.keep; paintModal(); } }, [
          el('span.updlg__box', { 'aria-hidden': 'true' }), 'Ponechat větev v archivu',
        ]),
      ]),
      dlgFoot([
        { label: 'Ponechat návrh', run: closeModal },
        { label: 'Zahodit návrh', kind: 'danger', run: confirmDiscard },
      ]));
  }

  host.hidden = false;
  fill(host, node);
  var first = host.querySelector('.updlg__opt[aria-pressed="true"], .updlg__btn--go:not([disabled]), .updlg__btn');
  if (first && !host.contains(document.activeElement)) first.focus();
}

function platforms(list) {
  return (list || []).map(function (p) { return p === 'telefon' ? 'telefon' : 'desktop'; })
    .join(', ').replace(/^./, function (c) { return c.toUpperCase(); });
}

function countWord(n) { return n === 1 ? 'jednu věc' : n === 2 ? 'dvě věci' : 'tři věci'; }

function pick(i) {
  var q = job.questions[ui.q];
  var cur = (ui.ans[ui.q] || []).slice();
  if (q.multi) {
    var k = cur.indexOf(i);
    if (k >= 0) cur.splice(k, 1); else cur.push(i);
    ui.ans[ui.q] = cur.length ? cur : null;
  } else ui.ans[ui.q] = [i];
  paintModal();
}

function nextQ() {
  if (ui.q < job.questions.length - 1) ui.q++;
  else ui.modal = 'confirm';
  paintModal();
}

function decideForMe() {
  ui.ans = job.questions.map(function (q, i) { return ui.ans[i] || q.def; });
  ui.modal = 'confirm';
  paintModal();
}

function askCancel() { ui.cancelFrom = ui.modal; ui.modal = 'cancel'; paintModal(); }

/* "Upravit zadání": the request goes back into the composer, the popup away. */
function editRequest() {
  var text = job.request;
  post('cancel').then(function () {
    go('main');
    dom.input.value = text;
    dom.input.focus();
  }, function () {});
}

function startDraft() {
  post('start', { answers: job.questions.map(function (q, i) { return ansOf(i); }), note: ui.note }).catch(function () {});
}

function askDiscard() {
  $('upDrop').hidden = true;
  ui.keep = false;
  ui.modal = 'discard';
  paintModal();
}

function confirmDiscard() {
  var keep = ui.keep;
  ui.discarded = keep ? 'Návrh zahozen · větev archivována' : 'Návrh zahozen · větev smazána';
  closeModal();
  post('discard', { keep: keep }).catch(function () {});
}

/* ---- the toasts ------------------------------------------------------------------ */

function showToast(kind) { ui.toast = kind; ui.toastFor = null; paintToast(); }

function paintToast() {
  var box = $('upToast');
  var kind = ui.toast;
  var valid = job && ((kind === 'review' && job.stage === 'review') || (kind === 'ready' && job.stage === 'ready'));
  if (!valid || ui.toastFor === job.id + kind || currentView() === 'upgrade' && kind === 'review') { box.hidden = true; return; }
  box.hidden = false;
  box.setAttribute('data-kind', kind);
  $('upToastTitle').textContent = kind === 'ready' ? 'Nová verze aplikace je připravená.' : 'Návrh je připravený k porovnání.';
  $('upToastSub').textContent = kind === 'ready'
    ? 'KC ' + job.versionTo + ' · ' + job.short + '. Chat i rozepsaný text zůstanou.'
    : job.short + ' · revize ' + job.viewRev + ' na větvi ' + job.branch + '.';
  var goBtn = $('upToastGo');
  goBtn.textContent = kind === 'ready' ? 'Přepnout teď' : 'Porovnat';
  goBtn.className = 'btn uptoast__go ' + (kind === 'ready' ? 'btn--okfill' : 'btn--accent');
}

/* ---- the switch -------------------------------------------------------------------- */

function switchNow() {
  if (!job || job.stage !== 'ready') return;
  ui.toastFor = job.id + 'ready';
  paintToast();
  showSwitching({ version: job.versionTo, restart: null });
  post('switch').catch(function () { $('upSwitch').hidden = true; });
}

function showSwitching(info) {
  var box = $('upSwitch');
  box.hidden = false;
  $('upSwitchText').textContent = 'Přepínám na KC ' + info.version + '…';
  var note = $('upSwitchNote');
  note.hidden = info.restart !== 'manual';
  note.textContent = info.restart === 'manual'
    ? 'Nová verze je nahraná. Kacey se sama nerestartuje — na serveru spusť: sudo systemctl restart kacey'
    : '';
  // Keep what was being typed; the page reloads when the new version answers.
  try {
    sessionStorage.setItem('kacey.switched', '1');
    if (dom.input.value) sessionStorage.setItem('kacey.draft', dom.input.value);
  } catch (e) { /* private mode */ }
}

var knownVersion = '';

/** From `ready`: a different version than this page met first means the switch happened. */
export function noteVersion(v) {
  if (!v) return;
  if (knownVersion && v !== knownVersion) {
    try {
      sessionStorage.setItem('kacey.switched', '1');
      if (dom.input.value) sessionStorage.setItem('kacey.draft', dom.input.value);
    } catch (e) { /* private mode */ }
    location.reload();
    return;
  }
  knownVersion = v;
}

/* ---- the comparison ------------------------------------------------------------------- */

function openCompare(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  ui.toastFor = job ? job.id + 'review' : null;
  paintToast();
  go('upgrade');
}

function previewURL() {
  return location.protocol + '//' + location.hostname + ':' + job.preview.port + '/?embed=1#' + job.view;
}

var frameKey = { old: '', neu: '' };

function paintCompare() {
  if (!job) return;
  $('upTitle').textContent = job.title;
  $('upBranch').textContent = job.branch;
  $('upSub').textContent = (job.summary ? 'změněno: ' + job.summary + ' · ' : '') + 'celá aplikace · náhled nemusí být plně funkční';
  var err = $('upErr');
  err.hidden = !job.error || job.stage === 'failed';
  err.textContent = job.error || '';
  $('upOldMeta').textContent = 'KC ' + job.versionFrom + ' · běžící verze';
  $('upNewMeta').textContent = 'KC ' + job.versionTo + ' · revize ' + job.viewRev;

  // Revision tabs once there is more than one.
  var revs = $('upRevs');
  revs.hidden = job.revs.length < 2;
  fill(revs, job.revs.map(function (r) {
    return el('button.uprevs__opt', {
      type: 'button', 'aria-pressed': String(r.n === job.viewRev), disabled: job.stage !== 'review',
      onclick: function () { if (r.n !== job.viewRev) post('rev', { n: r.n }).catch(function () {}); },
    }, [el('span.desk-only', 'Revize '), el('span.phone-only', 'R'), String(r.n)]);
  }));

  var review = job.stage === 'review', ready = job.stage === 'ready';
  ['upApprove', 'upApproveM'].forEach(function (id) {
    var b = $(id);
    b.disabled = !(review || ready);
    b.textContent = ready ? 'Přepnout teď' : id === 'upApproveM' ? 'Schválit' : 'Schválit a dokončit';
    b.classList.toggle('btn--okfill', ready);
    b.classList.toggle('btn--accent', !ready);
  });
  ['upRefineBtn', 'upRefineM'].forEach(function (id) { $(id).disabled = !review && job.stage !== 'refining'; });
  $('upRefineBtn').setAttribute('aria-expanded', String(ui.refine));
  $('upRefineBtn').classList.toggle('is-open', ui.refine);

  // The two frames: only reloaded when what they show changed.
  var oldKey = '/?embed=1#' + job.view;
  if (frameKey.old !== oldKey) { frameKey.old = oldKey; $('upOld').src = oldKey; }
  var newKey = job.preview.ready ? previewURL() + '|' + job.revs.length + '|' + job.viewRev + '|' + job.stage : '';
  if (job.preview.ready && frameKey.neu !== newKey) {
    frameKey.neu = newKey;
    $('upNew').src = previewURL().replace('#', '&r=' + job.revs.length + '.' + job.viewRev + '#');
  }

  var busy = $('upBusy');
  var working = job.stage === 'refining' || job.stage === 'finalizing' || !job.preview.ready;
  busy.hidden = !working;
  $('upBusyLabel').textContent = job.stage === 'refining' || job.stage === 'finalizing' ? chipLabel() : 'Spouštím náhled…';
  $('upBusyStep').textContent = job.steps && job.steps[job.cur] ? job.steps[job.cur] + '…' : '';

  // Split and the phone toggle.
  var split = $('upSplit');
  split.setAttribute('data-show', ui.show);
  split.style.gridTemplateColumns = PHONE.matches ? '' : 'minmax(0,' + ui.split + 'fr) 12px minmax(0,' + (1 - ui.split) + 'fr)';
  $('upSplitLabel').textContent = Math.round(ui.split * 100) + ' / ' + Math.round((1 - ui.split) * 100);
  var opts = document.querySelectorAll('[data-up-show]');
  for (var i = 0; i < opts.length; i++) opts[i].setAttribute('aria-pressed', String(opts[i].getAttribute('data-up-show') === ui.show));

  paintRefine();
  scaleFrames();
}

function paintRefine() {
  var aside = $('upRefine');
  aside.hidden = !ui.refine;
  $('upGrid').classList.toggle('has-refine', ui.refine);
  document.body.classList.toggle('is-uprefine', ui.refine);
  if (!ui.refine || !job) return;
  var next = job.revs.length + 1;
  $('upNextRev').textContent = '→ revize ' + next;
  $('upHistCount').textContent = String(job.hist.length);
  fill($('upHist'), job.hist.map(function (h) {
    return el('div.uprefine__item' + (/^Kacey/.test(h.who) ? '.is-kacey' : ''), [el('span.uprefine__who', h.who), el('p.uprefine__said', h.text)]);
  }));
  var restore = $('upRestore');
  restore.hidden = job.revs.length < 2 || job.stage !== 'review';
  $('upRestoreSub').textContent = 'Revize ' + (job.revs.length - 1) + ' · poslední úprava se zahodí';
  var go = $('upRefineGo');
  go.textContent = 'Vytvořit revizi ' + next;
  go.disabled = !$('upRefineText').value.trim() || job.stage !== 'review';
}

/* Desktop: each version is drawn at 1440px wide and scaled to its pane. */
function scaleFrames() {
  [['upOldBody', 'upOld'], ['upNewBody', 'upNew']].forEach(function (pair) {
    var body = $(pair[0]), frame = $(pair[1]);
    if (PHONE.matches) { frame.style.transform = ''; frame.style.width = ''; frame.style.height = ''; return; }
    var w = body.clientWidth, h = body.clientHeight;
    if (!w || !h) return;
    var scale = Math.max(0.05, w / 1440);
    frame.style.width = '1440px';
    frame.style.height = Math.round(h / scale) + 'px';
    frame.style.transform = 'scale(' + scale.toFixed(4) + ')';
  });
}

function wireSplit() {
  var handle = $('upHandle'), split = $('upSplit');
  handle.addEventListener('pointerdown', function (ev) {
    ev.preventDefault();
    split.classList.add('is-dragging');
    function move(e) {
      var r = split.getBoundingClientRect();
      ui.split = Math.min(0.8, Math.max(0.2, (e.clientX - r.left) / r.width));
      paintCompare();
    }
    function up() {
      split.classList.remove('is-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  handle.addEventListener('dblclick', function () { ui.split = 0.5; paintCompare(); });
  handle.addEventListener('keydown', function (ev) {
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      ui.split = Math.min(0.8, Math.max(0.2, ui.split + (ev.key === 'ArrowLeft' ? -0.05 : 0.05)));
      paintCompare();
    }
  });
  if (window.ResizeObserver) new ResizeObserver(scaleFrames).observe(split);
}

function approveOrSwitch() {
  if (!job) return;
  if (job.stage === 'ready') return switchNow();
  post('approve').catch(function () {});
}

function submitRefine() {
  var box = $('upRefineText');
  var text = box.value.trim();
  if (!text) return;
  post('refine', { text: text }).then(function () {
    box.value = '';
    if (PHONE.matches) ui.refine = false;
    paintCompare();
  }, function () {});
}

/* ---- painting ---------------------------------------------------------------------------- */

function viewLabel(view) {
  var names = { main: 'Chat', tasks: 'Úkoly', calendar: 'Kalendář', journal: 'Deník', library: 'Knihovnu deníku', brief: 'Ranní brief', timer: 'Časovače', controller: 'Controller', rules: 'Pravidla', morning: 'Ráno', lights: 'Světla' };
  return 'Otevřít ' + (names[view] || view);
}

function paint() {
  paintChip();
  paintCard();
  paintModal();
  paintToast();
  if (currentView() === 'upgrade') {
    if (!job || ['review', 'refining', 'finalizing', 'ready'].indexOf(job.stage) === -1) go('main');
    else paintCompare();
  }
}

/* ---- boot ---------------------------------------------------------------------------------- */

export function initUpgrade() {
  if (EMBED) return;
  $('upChip').addEventListener('click', chipClick);
  $('upDropChat').addEventListener('click', function () {
    $('upDrop').hidden = true;
    go('main');
    if (ui.card) ui.card.scrollIntoView({ block: 'nearest' });
  });
  $('upDropStop').addEventListener('click', askDiscard);
  document.addEventListener('click', function (ev) {
    var drop = $('upDrop');
    if (!drop.hidden && !$('upChipWrap').contains(ev.target)) { drop.hidden = true; $('upChip').setAttribute('aria-expanded', 'false'); }
  });

  $('upToastGo').addEventListener('click', function () {
    if (ui.toast === 'ready') switchNow(); else openCompare();
  });
  $('upToastLater').addEventListener('click', function () {
    if (job) ui.toastFor = job.id + ui.toast;
    paintToast();
  });

  $('upModal').addEventListener('click', function (ev) {
    // The backdrop closes only the destructive confirmations; the brief stays.
    if (ev.target === $('upModal') && (ui.modal === 'discard')) closeModal();
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape' || !ui.modal) return;
    ev.stopPropagation();
    if (ui.modal === 'cancel') openModal(ui.cancelFrom || 'confirm');
    else if (ui.modal === 'discard') closeModal();
    else askCancel();
  }, true);

  ['upDiscard', 'upDiscardM'].forEach(function (id) { $(id).addEventListener('click', askDiscard); });
  ['upApprove', 'upApproveM'].forEach(function (id) { $(id).addEventListener('click', approveOrSwitch); });
  ['upRefineBtn', 'upRefineM'].forEach(function (id) {
    $(id).addEventListener('click', function () {
      ui.refine = !ui.refine;
      paintCompare();
      if (ui.refine) $('upRefineText').focus();
    });
  });
  $('upRefineClose').addEventListener('click', function () { ui.refine = false; paintCompare(); });
  $('upRefineText').addEventListener('input', paintRefine);
  $('upRefineText').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); submitRefine(); }
  });
  $('upRefineGo').addEventListener('click', submitRefine);
  $('upRestore').addEventListener('click', function () { post('restore').catch(function () {}); });
  var opts = document.querySelectorAll('[data-up-show]');
  for (var i = 0; i < opts.length; i++) {
    opts[i].addEventListener('click', function (ev) { ui.show = ev.currentTarget.getAttribute('data-up-show'); paintCompare(); });
  }
  wireSplit();
  if (PHONE.addEventListener) PHONE.addEventListener('change', function () { paintChip(); if (currentView() === 'upgrade') paintCompare(); });

  onEnter('upgrade', function () {
    if (!job || ['review', 'refining', 'finalizing', 'ready'].indexOf(job.stage) === -1) { setTimeout(function () { go('main'); }, 0); return; }
    ui.toastFor = job.id + 'review';
    paintToast();
    paintCompare();
    requestAnimationFrame(scaleFrames);
  });
  // Leaving the comparison stops the framed copies (two whole apps are not free).
  ['main', 'tasks', 'calendar', 'journal', 'library', 'brief', 'timer', 'lights', 'controller', 'rules'].forEach(function (v) {
    onEnter(v, function () {
      if (frameKey.old || frameKey.neu) {
        $('upOld').removeAttribute('src'); $('upNew').removeAttribute('src');
        frameKey.old = ''; frameKey.neu = '';
      }
      document.body.classList.remove('is-uprefine');
      paintToast();
    });
  });

  // The job as the server has it now — a page opened mid-job picks it up.
  fetch('/api/upgrade').then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
    if (data && !started) receiveUpgrade(data);
  }, function () {});
}
