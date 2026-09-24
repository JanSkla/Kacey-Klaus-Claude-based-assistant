/* =========================================================================
   The router: which view is showing.

   Eleven views, one at a time, all of them already in the document. Switching is
   a `hidden` flip rather than a render, because the chat log, the composer and
   the microphone have to survive a trip to the calendar and back.

   Views announce themselves on a hash so a reload lands where you were, and so
   the back button does the obvious thing.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { clear as clearToast } from './toast.js';
import { closeSheet } from './psheet.js';

var VIEWS = ['main', 'tasks', 'journal', 'library', 'calendar', 'brief', 'timer', 'lights', 'controller', 'task', 'focus'];

var LABELS = {
  main: 'main', tasks: 'úkoly', journal: 'deník', library: 'knihovna deníku',
  calendar: 'kalendář', brief: 'ranní brief', timer: 'časovače', lights: 'světla',
  controller: 'controller', task: 'úkol probíhá', focus: 'focus'
};

/* What the phone header says. The desktop header keeps the small label on the
   right; a phone has room for one word, so it is the view's name. */
var TITLES = {
  main: 'Kacey', tasks: 'Úkoly', journal: 'Deník', library: 'Knihovna deníku',
  calendar: 'Kalendář', brief: 'Ranní brief', timer: 'Časovače', lights: 'Světla',
  controller: 'Controller', task: 'Úkol', focus: 'Focus'
};

var current = 'main';
var enterHooks = {};

export function onEnter(view, fn) {
  (enterHooks[view] || (enterHooks[view] = [])).push(fn);
}

export function currentView() { return current; }

export function go(view) {
  if (VIEWS.indexOf(view) === -1) view = 'main';
  current = view;
  clearToast();
  closeSheet();
  // The phone stylesheet keys a few things off the view (the toast's height
  // above the composer, the tab bar in the full-screen views).
  document.body.setAttribute('data-view', view);

  var nodes = document.querySelectorAll('.view');
  for (var i = 0; i < nodes.length; i++) {
    nodes[i].hidden = nodes[i].getAttribute('data-view') !== view;
  }
  var label = $('viewLabel');
  if (label) label.textContent = LABELS[view] || view;
  var title = $('viewTitle');
  if (title) title.textContent = TITLES[view] || 'Kacey';

  if (location.hash.slice(1) !== view) {
    try { history.replaceState(null, '', '#' + view); } catch (e) { /* file:// */ }
  }

  paintTabs(view);

  var hooks = enterHooks[view] || [];
  for (var h = 0; h < hooks.length; h++) {
    try { hooks[h](); } catch (e) { console.error('[kacey] view hook failed', e); }
  }
}

/* The tab bar mirrors the router rather than holding its own state. Views
   reachable only from "Víc" light no tab, which is honest — none of the five
   is where you are. */
function paintTabs(view) {
  var tabs = document.querySelectorAll('.tab[data-tab]');
  for (var i = 0; i < tabs.length; i++) {
    if (tabs[i].getAttribute('data-tab') === view) tabs[i].setAttribute('aria-current', 'true');
    else tabs[i].removeAttribute('aria-current');
  }
}

function openMore(open) {
  var sheet = $('moreSheet'), button = $('tabMore');
  if (!sheet) return;
  sheet.hidden = !open;
  if (button) button.setAttribute('aria-expanded', String(open));
}

export function initRouter() {
  /* One delegated listener for every [data-go] in the document, so a view can
     add navigation buttons without wiring anything. */
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest && ev.target.closest('[data-go]');
    if (!btn) return;
    ev.preventDefault();
    go(btn.getAttribute('data-go'));
  });

  var more = $('tabMore');
  if (more) more.addEventListener('click', function () { openMore($('moreSheet').hidden); });
  var moreClose = $('moreClose');
  if (moreClose) moreClose.addEventListener('click', function () { openMore(false); });
  var moreSheet = $('moreSheet');
  if (moreSheet) {
    moreSheet.addEventListener('click', function (ev) { if (ev.target === moreSheet) openMore(false); });
    // Any destination inside it closes it on the way out.
    moreSheet.addEventListener('click', function (ev) {
      if (ev.target.closest && ev.target.closest('[data-go]')) openMore(false);
    });
  }

  var ctrl = $('controllerBtn');
  if (ctrl) ctrl.addEventListener('click', function () {
    go(current === 'controller' ? 'main' : 'controller');
  });

  window.addEventListener('hashchange', function () {
    var want = location.hash.slice(1);
    if (want && want !== current) go(want);
  });

  var initial = location.hash.slice(1);
  go(VIEWS.indexOf(initial) === -1 ? 'main' : initial);
}
