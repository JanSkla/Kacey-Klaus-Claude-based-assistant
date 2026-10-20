/* =========================================================================
   Where an answer from the web came from.

   Kacey never reads an address aloud, so the sources of a turn that went to
   the web are shown here instead: one quiet card under her answer, with the
   pages she read first and the search hits after. The `web` frames arrive
   while she is still working (server.js, web.js); the card is drawn once
   the turn is done, so it lands under the answer, not between the preamble
   and the answer. A conversation reopened from the history brings the same
   frames back (`{ role: 'web', frames }`, ui/history.js).

   Every address is a plain link to a new tab. Titles and hosts go in as
   text — they come from the open web. The merging lives in core/websrc.js.
   ========================================================================= */

import { el } from '../core/el.js';
import * as dom from '../core/dom.js';
import { say } from './toast.js';
import { newTurn, addFrame, summary, metaOf } from '../core/websrc.js';

var SHOWN = 3;            // the rest behind "Další zdroje"

var turn = null;          // core/websrc.js newTurn() while a turn collects

/** One `web` frame from the server. */
export function noteWeb(msg) {
  if (!turn) turn = newTurn();
  addFrame(turn, msg);
}

/** A turn that ended in an error leaves nothing behind. */
export function dropWeb() { turn = null; }

/* Offline, a new tab would only show the browser's own error page. */
function follow(ev) {
  if (navigator.onLine !== false) return;
  ev.preventDefault();
  say('Jsi offline — stránka se otevře, až se připojíš.');
}

function row(s) {
  return el('li', el('a.webchat__src' + (s.read && !s.ok ? '.is-failed' : ''),
    { href: s.url, target: '_blank', rel: 'noopener noreferrer', title: s.url, onclick: follow }, [
      el('span.webchat__title', s.title),
      el('span.webchat__host', metaOf(s))
    ]));
}

function card(t) {
  var sum = summary(t);
  var list = sum.sources;
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

  return el('li.msg.msg--assistant.msg--web', el('div.webchat' + (sum.failed ? '.is-err' : ''), [
    el('p.webchat__kicker', sum.kicker),
    list.length ? rows : el('p.webchat__empty', sum.empty),
    more
  ]));
}

/** The turn is done: draw what it found, if it went to the web at all. */
export function flushWeb() {
  var t = turn;
  turn = null;
  if (!t) return;
  dom.log.appendChild(card(t));
  var w = dom.logwrap;
  if (w.scrollHeight - w.scrollTop - w.clientHeight < 240) w.scrollTop = w.scrollHeight;
}

/** A turn from the history: the frames the server rebuilt from the stored session. */
export function showWeb(frames) {
  if (!Array.isArray(frames) || !frames.length) return;
  var t = newTurn();
  frames.forEach(function (f) { addFrame(t, f); });
  dom.log.appendChild(card(t));
}
