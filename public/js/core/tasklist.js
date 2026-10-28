/* =========================================================================
   A task's checklist (Seznam / Spustit on a task) — shared by the browser and
   the server.

   All of them live in kv `checklists` (app section `checklists`) as
     { [task id]: [{ id, label, note, done }] }
   The page ticks and adds in the runner (phone) or a floating window
   (desktop, ui/runwins.js); the night run writes one with a generated task
   (nightstore.js); Kacey reads them in app_read and changes them with
   app_task_list. This file is what all of them agree on: what a stored list
   may hold, how its progress reads, and the changes Kacey makes.

   ES5 and no DOM, like due.js: server modules import this file as it is.
   ========================================================================= */

export var MAX_ITEMS = 40;
export var MAX_LABEL = 120;
var MAX_NOTE = 200;

function text(v, max) {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

var counter = 0;
/** An id no item has: 'c' + base36 time + a counter, so two in one millisecond differ. */
export function newItemId() {
  counter = (counter + 1) % 1296;
  return 'c' + Date.now().toString(36) + counter.toString(36);
}

/** One task's list as it may be stored: labels trimmed and capped, empties
    and duplicate ids dropped, at most MAX_ITEMS, every item with an id. */
export function normalizeTaskList(items) {
  var seen = {};
  return (Array.isArray(items) ? items : []).filter(function (i) { return i && text(i.label, MAX_LABEL); })
    .slice(0, MAX_ITEMS)
    .map(function (i) {
      var id = typeof i.id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(i.id) ? i.id : newItemId();
      while (seen[id]) id = newItemId();
      seen[id] = true;
      return { id: id, label: text(i.label, MAX_LABEL), note: text(i.note, MAX_NOTE), done: i.done === true };
    });
}

/** Every task's list. Anything that is not { id: [items] } goes. */
export function normalizeTaskLists(all) {
  var out = {};
  if (!all || typeof all !== 'object' || Array.isArray(all)) return out;
  Object.keys(all).forEach(function (id) {
    if (!id || id.length > 120 || !Array.isArray(all[id])) return;
    out[id] = normalizeTaskList(all[id]);
  });
  return out;
}

export function doneCount(items) {
  return (items || []).filter(function (i) { return i && i.done; }).length;
}

/** "2 z 5 hotovo", or "prázdný" — the window's bar and Kacey's reading. */
export function progressText(items) {
  var n = (items || []).length;
  return n ? doneCount(items) + ' z ' + n + ' hotovo' : 'prázdný';
}

/* Words compared without case and diacritics: "ručník" finds "Ručník". */
function fold(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

/** The item `which` names: its id, its exact label, or the one label holding those words. */
export function findItem(items, which) {
  var w = fold(which);
  if (!w) return null;
  var list = items || [];
  var hit = list.filter(function (i) { return i.id === which; })[0] ||
    list.filter(function (i) { return fold(i.label) === w; })[0];
  if (hit) return hit;
  var some = list.filter(function (i) { return fold(i.label).indexOf(w) !== -1; });
  return some.length === 1 ? some[0] : null;
}

/**
 * One change to a list, as Kacey asks for it:
 *   add (labels), check / uncheck / remove (ids or words), reset (all unticked), clear (all gone).
 * Returns { items, changed: [labels], missing: [what was not found], full: [labels that did not fit] }.
 * Never throws for an item it cannot find — it says so in `missing`.
 */
export function applyListOp(items, action, which) {
  var list = normalizeTaskList(items);
  var names = (Array.isArray(which) ? which : which == null ? [] : [which])
    .map(function (s) { return text(String(s), MAX_LABEL); }).filter(Boolean);
  var out = { items: list, changed: [], missing: [], full: [] };

  if (action === 'add') {
    names.forEach(function (label) {
      if (out.items.length >= MAX_ITEMS) { out.full.push(label); return; }
      out.items = out.items.concat([{ id: newItemId(), label: label, note: '', done: false }]);
      out.changed.push(label);
    });
    return out;
  }
  if (action === 'reset') {
    out.changed = list.filter(function (i) { return i.done; }).map(function (i) { return i.label; });
    out.items = list.map(function (i) { return Object.assign({}, i, { done: false }); });
    return out;
  }
  if (action === 'clear') {
    out.changed = list.map(function (i) { return i.label; });
    out.items = [];
    return out;
  }
  if (action !== 'check' && action !== 'uncheck' && action !== 'remove') throw new Error('neznámá změna seznamu: ' + action);
  names.forEach(function (name) {
    var hit = findItem(out.items, name);
    if (!hit) { out.missing.push(name); return; }
    out.changed.push(hit.label);
    out.items = action === 'remove'
      ? out.items.filter(function (i) { return i.id !== hit.id; })
      : out.items.map(function (i) { return i.id === hit.id ? Object.assign({}, i, { done: action === 'check' }) : i; });
  });
  return out;
}
