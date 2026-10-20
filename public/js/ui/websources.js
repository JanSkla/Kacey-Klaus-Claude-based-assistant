/* =========================================================================
   Where an answer from the web came from.

   Kacey never reads an address aloud, so the sources of a turn that went to
   the web are shown here instead: one quiet card under her answer, with the
   pages she read first and the search hits after. The `web` frames arrive
   while she is still working (server.js webFrame); the card is drawn once
   the turn is done, so it lands under the answer, not between the preamble
   and the answer.

   Every address is a plain link to a new tab. Titles and hosts go in as
   text — they come from the open web.
   ========================================================================= */

import { el } from '../core/el.js';
import * as dom from '../core/dom.js';

var SHOWN = 3;            // the rest behind "Další zdroje"

var turn = null;          // { queries: [], fetched: [], hits: [] } while a turn collects

function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; }
}

/** One `web` frame from the server. */
export function noteWeb(msg) {
  if (!turn) turn = { queries: [], fetched: [], hits: [] };
  var list = Array.isArray(msg.sources) ? msg.sources : [];
  if (msg.tool === 'fetch') {
    list.forEach(function (s) { if (s && s.url) turn.fetched.push({ url: s.url, title: s.title || '', ok: msg.ok !== false }); });
  } else {
    if (msg.query && turn.queries.indexOf(msg.query) === -1) turn.queries.push(msg.query);
    list.forEach(function (s) { if (s && s.url) turn.hits.push({ url: s.url, title: s.title || '' }); });
  }
}

/** A turn that ended in an error leaves nothing behind. */
export function dropWeb() { turn = null; }

function sources(t) {
  var seen = {}, out = [];
  var titles = {};
  t.hits.forEach(function (h) { if (h.title && !titles[h.url]) titles[h.url] = h.title; });
  t.fetched.forEach(function (f) {
    if (seen[f.url]) return;
    seen[f.url] = true;
    out.push({ url: f.url, title: f.title || titles[f.url] || host(f.url), read: true, ok: f.ok });
  });
  t.hits.forEach(function (h) {
    if (seen[h.url]) return;
    seen[h.url] = true;
    out.push({ url: h.url, title: h.title || host(h.url), read: false, ok: true });
  });
  return out;
}

function row(s) {
  var meta = host(s.url) + (s.read ? (s.ok ? ' · přečteno' : ' · nešlo otevřít') : '');
  return el('li', el('a.webchat__src' + (s.read && !s.ok ? '.is-failed' : ''),
    { href: s.url, target: '_blank', rel: 'noopener noreferrer', title: s.url }, [
      el('span.webchat__title', s.title),
      el('span.webchat__host', meta)
    ]));
}

/** The turn is done: draw what it found, if it went to the web at all. */
export function flushWeb() {
  var t = turn;
  turn = null;
  if (!t) return;

  var list = sources(t);
  var q = t.queries[0] || '';
  var kicker = 'Z INTERNETU' + (q ? ' · „' + q + '“' : '');
  var rows = el('ul.webchat__list', list.slice(0, SHOWN).map(row));
  var more = list.length > SHOWN
    ? el('button.link.webchat__more', {
        type: 'button',
        onclick: function (ev) {
          list.slice(SHOWN).forEach(function (s) { rows.appendChild(row(s)); });
          ev.currentTarget.remove();
        }
      }, 'Další zdroje (' + (list.length - SHOWN) + ')')
    : null;

  dom.log.appendChild(el('li.msg.msg--assistant.msg--web', el('div.webchat', [
    el('p.webchat__kicker', kicker),
    list.length ? rows : el('p.webchat__empty', 'Hledání nic nenašlo.'),
    more
  ])));
  var w = dom.logwrap;
  if (w.scrollHeight - w.scrollTop - w.clientHeight < 240) w.scrollTop = w.scrollHeight;
}
