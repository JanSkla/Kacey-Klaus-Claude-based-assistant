/* =========================================================================
   The router: which view is showing.

   Ten views, one at a time, all of them already in the document. Switching is
   a `hidden` flip rather than a render, because the chat log, the composer and
   the microphone have to survive a trip to the calendar and back.

   Views announce themselves on a hash so a reload lands where you were, and so
   the back button does the obvious thing.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { clear as clearToast } from './toast.js';

var VIEWS = ['main', 'tasks', 'journal', 'library', 'calendar', 'brief', 'timer', 'controller', 'task', 'focus'];

var LABELS = {
  main: 'main', tasks: 'úkoly', journal: 'deník', library: 'knihovna deníku',
  calendar: 'kalendář', brief: 'ranní brief', timer: 'časovače',
  controller: 'controller', task: 'úkol probíhá', focus: 'focus'
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

  var nodes = document.querySelectorAll('.view');
  for (var i = 0; i < nodes.length; i++) {
    nodes[i].hidden = nodes[i].getAttribute('data-view') !== view;
  }
  var label = $('viewLabel');
  if (label) label.textContent = LABELS[view] || view;

  if (location.hash.slice(1) !== view) {
    try { history.replaceState(null, '', '#' + view); } catch (e) { /* file:// */ }
  }

  var hooks = enterHooks[view] || [];
  for (var h = 0; h < hooks.length; h++) {
    try { hooks[h](); } catch (e) { console.error('[kacey] view hook failed', e); }
  }
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
