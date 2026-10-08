/* =========================================================================
   The morning checklist as a list you can edit — shared by the browser and
   the server.

   The default list is the habit (docs/DREAM.md §12): the same every morning.
   It lives in kv `morning.checklist` (app section `morning`) as
     { items: [{ key, label }], once: [{ key, label, date, note }] }
   `items` are every morning's; `once` are one-off items for one logical date
   ("jen zítra" in the Controller, "jen dnes" on the morning screen), added by
   hand or by Kacey from the conversation (app_morning_add).

   Keys are stable: the daily history stores the keys that were ticked, so a
   renamed item keeps its key and a new one gets a fresh one. Changes to the
   list reach a morning when its record is made (morning.js, at the day roll);
   the morning screen's own editor also changes that day's record.

   ES5 and no DOM, like due.js: server modules import this file as it is.
   ========================================================================= */

export var MAX_ITEMS = 20;
export var MAX_LABEL = 80;

function label(v) {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL) : '';
}

var counter = 0;
/** A key no item has: 'c' + base36 time + a counter, so two in one millisecond differ. */
export function newKey() {
  counter = (counter + 1) % 1296;
  return 'c' + Date.now().toString(36) + counter.toString(36);
}

/**
 * A checklist as it may be stored: labels trimmed and capped, empties and
 * duplicate keys dropped, at most MAX_ITEMS of each kind, every item keyed.
 * `fallback` is the list to use when `value` is not a checklist at all.
 */
export function normalizeChecklist(value, fallback) {
  var src = value && typeof value === 'object' ? value : (fallback || { items: [], once: [] });
  var seen = {};
  function keyOf(i) {
    var k = typeof i.key === 'string' && /^[a-z0-9_-]{1,40}$/i.test(i.key) ? i.key : newKey();
    while (seen[k]) k = newKey();
    seen[k] = true;
    return k;
  }
  var items = (Array.isArray(src.items) ? src.items : []).filter(function (i) { return i && label(i.label); })
    .slice(0, MAX_ITEMS)
    .map(function (i) { return { key: keyOf(i), label: label(i.label) }; });
  var once = (Array.isArray(src.once) ? src.once : []).filter(function (i) {
    return i && label(i.label) && /^\d{4}-\d{2}-\d{2}$/.test(String(i.date || ''));
  }).slice(0, MAX_ITEMS).map(function (i) {
    var o = { key: keyOf(i), label: label(i.label), date: String(i.date) };
    if (label(i.note)) o.note = label(i.note);
    return o;
  });
  return { items: items, once: once };
}

/** The items one logical date's morning starts with: every morning's, then that date's one-offs. */
export function itemsFor(checklist, date) {
  var c = checklist || { items: [], once: [] };
  return (c.items || []).map(function (i) { return { key: i.key, label: i.label }; })
    .concat((c.once || []).filter(function (o) { return o.date === date; }).map(function (o) {
      return { key: o.key, label: o.label, once: true, note: o.note || '' };
    }));
}

/** The checklist without one-offs for dates before `date` (they have had their morning). */
export function pruneOnce(checklist, date) {
  return {
    items: (checklist.items || []).slice(),
    once: (checklist.once || []).filter(function (o) { return o.date >= date; })
  };
}

/** "1 položka", "3 položky", "6 položek". */
export function itemsWord(n) {
  return n + (n === 1 ? ' položka' : n > 1 && n < 5 ? ' položky' : ' položek');
}
