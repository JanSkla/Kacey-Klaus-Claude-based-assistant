/* =========================================================================
   The conversation history (Claude Design "Kacey Self-Update" prototype):
   a button at the chat's top right opens the earlier conversations, grouped
   by day, the current one lit; one marked "vylepšení" asked for an app
   improvement. Picking one repaints the log from its transcript and
   reconnects with ?resume=<id>, so Kacey picks it up where it ended.
   "Nová konverzace" starts a fresh session.

   The server keeps the list (/api/chat/sessions); the transcripts are the
   Claude SDK's own.
   ========================================================================= */

import { $ } from '../core/dom.js';
import * as dom from '../core/dom.js';
import { state, EMBED } from '../core/state.js';
import { el, fill } from '../core/el.js';
import { addMessage, showAlert } from './log.js';
import { reconnect } from '../net/protocol.js';

var btn = null, panel = null;

function open(yes) {
  panel.hidden = !yes;
  btn.setAttribute('aria-expanded', String(yes));
  btn.classList.toggle('is-open', yes);
  if (yes) load();
}

function load() {
  fill($('histList'), el('p.empty', 'Načítám…'));
  fetch('/api/chat/sessions').then(function (r) { return r.json(); }).then(function (data) {
    paint(Array.isArray(data.sessions) ? data.sessions : []);
  }, function () { fill($('histList'), el('p.empty', 'Historii se nepodařilo načíst.')); });
}

function startOfDay(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

function dayGroup(iso) {
  var days = Math.round((startOfDay(new Date()) - startOfDay(new Date(iso))) / 86400000);
  if (days <= 0) return 'DNES';
  if (days === 1) return 'VČERA';
  var now = new Date(), monday = startOfDay(now);
  monday.setDate(monday.getDate() - ((now.getDay() + 6) % 7));
  if (new Date(iso) >= monday) return 'TENTO TÝDEN';
  var lastMonday = new Date(monday); lastMonday.setDate(lastMonday.getDate() - 7);
  if (new Date(iso) >= lastMonday) return 'MINULÝ TÝDEN';
  return 'DŘÍV';
}

function messages(n) { return n + (n === 1 ? ' zpráva' : n >= 2 && n <= 4 ? ' zprávy' : ' zpráv'); }

var DAYS = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];

function when(iso, group) {
  var d = new Date(iso);
  if (Date.now() - d < 5 * 60000) return 'teď';
  if (group === 'DNES' || group === 'VČERA') return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  if (group === 'TENTO TÝDEN') return DAYS[d.getDay()];
  return d.getDate() + '. ' + (d.getMonth() + 1) + '.';
}

function paint(list) {
  var cur = state.sessionId;
  if (!list.length) { fill($('histList'), el('p.empty', 'Zatím žádné uložené konverzace.')); return; }
  var out = [], last = '';
  list.forEach(function (c) {
    var g = dayGroup(c.updated_at || c.started_at);
    if (g !== last) { out.push(el('p.histpanel__day', g)); last = g; }
    var title = [el('span.histpanel__title', c.title || 'Konverzace'), c.upgrade ? el('span.histpanel__tag', 'vylepšení') : null];
    var meta = el('span.histpanel__meta', when(c.updated_at || c.started_at, g) + ' · ' + messages(c.count || 0));
    out.push(c.id === cur
      ? el('div.histpanel__row.is-current', { 'aria-current': 'true' }, [el('span.histpanel__line', title), meta])
      : el('button.histpanel__row', { type: 'button', onclick: function () { resume(c.id); } }, [el('span.histpanel__line', title), meta]));
  });
  fill($('histList'), out);
}

function resume(id) {
  open(false);
  fetch('/api/chat/sessions/' + encodeURIComponent(id)).then(function (r) {
    return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status); return d; });
  }).then(function (data) {
    dom.log.textContent = '';
    (data.messages || []).forEach(function (m) { addMessage(m.role === 'user' ? 'user' : 'assistant', m.text); });
    reconnect(id);
  }, function (err) { showAlert(err.message); });
}

function fresh() {
  open(false);
  dom.log.textContent = '';
  reconnect(null);
}

export function initHistory() {
  btn = $('histBtn'); panel = $('histPanel');
  if (!btn || !panel) return;
  if (EMBED) { btn.hidden = true; return; }
  btn.addEventListener('click', function () { open(panel.hidden); });
  $('histNew').addEventListener('click', fresh);
  document.addEventListener('click', function (ev) {
    if (!panel.hidden && !panel.contains(ev.target) && !btn.contains(ev.target)) open(false);
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !panel.hidden) { ev.stopPropagation(); open(false); btn.focus(); }
  }, true);
}
