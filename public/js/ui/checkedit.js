/* =========================================================================
   The morning checklist editor — one component, two places.

   Controller → Ranní checklist (`variant: 'ctrl'`): the default list for the
   coming mornings, numbered rows with ↑ ↓ ×, one-offs badged "jen zítra".
   The morning screen's "Upravit" (`variant: 'morning'`, Claude Design 1f):
   today's list, rows dragged by a ⋮⋮ handle (Alt+↑/↓ from the keyboard),
   one-offs badged "jen dnes", and an add row that picks "jen dnes" or
   "každé ráno".

   The component only draws and reports; what an edit means (which list it
   changes, what it saves) belongs to the caller:
     items     [{ key, label, once?, note? }]
     onRename(key, label) · onRemove(key) · onMove(key, toIndex) · onAdd(label, once)
   Labels are committed on change (blur or Enter); an emptied label snaps back.
   ========================================================================= */

import { el, fill } from '../core/el.js';
import { MAX_LABEL } from '../core/checklist.js';

/** Draws the rows of `items` into `host`. */
export function renderRows(host, items, opts) {
  var morning = opts.variant === 'morning';
  var fixed = items.filter(function (i) { return !i.once; }).length;   // one-offs come after, and stay there

  fill(host, items.map(function (item, index) {
    var input = el('input.checkedit__input', {
      type: 'text', value: item.label, maxlength: String(MAX_LABEL),
      'aria-label': morning ? 'Položka' : 'Položka ' + (index + 1)
    });
    input.addEventListener('change', function () {
      var v = input.value.trim();
      if (!v) { input.value = item.label; return; }
      if (v !== item.label) opts.onRename(item.key, v);
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); return; }
      if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && !item.once) {
        ev.preventDefault();
        var to = index + (ev.key === 'ArrowUp' ? -1 : 1);
        if (to >= 0 && to < fixed) opts.onMove(item.key, to);
      }
    });

    var badge = item.once ? el('span.checkedit__badge', { title: item.note || '' }, morning ? 'jen dnes' : 'jen zítra') : null;
    var remove = el('button.checkedit__x', {
      type: 'button', 'aria-label': 'Odebrat', title: 'Odebrat',
      onclick: function () { opts.onRemove(item.key); }
    }, '×');

    if (morning) {
      var handle = el('span.checkedit__handle', { 'aria-hidden': 'true', title: 'Přetažením změníš pořadí' }, '⋮⋮');
      if (!item.once) dragFrom(handle, host, item, index, fixed, opts);
      else handle.classList.add('is-off');
      return el('div.checkedit__row', { 'data-key': item.key }, [handle, input, badge, remove]);
    }

    function arrow(dir, label) {
      var to = index + dir;
      var off = item.once || to < 0 || to >= fixed;
      return el('button.checkedit__arrow', {
        type: 'button', 'aria-label': label, title: label, disabled: off,
        onclick: function () { opts.onMove(item.key, to); }
      }, dir < 0 ? '↑' : '↓');
    }
    return el('div.checkedit__row', { 'data-key': item.key }, [
      el('span.checkedit__num.num', String(index + 1)), input, badge,
      arrow(-1, 'Posunout výš'), arrow(1, 'Posunout níž'), remove
    ]);
  }));
}

/* Pointer drag on the handle: the row follows the pointer's slot among the
   fixed rows and the move is reported once, on release. */
function dragFrom(handle, host, item, index, fixed, opts) {
  handle.addEventListener('pointerdown', function (ev) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    handle.setPointerCapture(ev.pointerId);
    var rows = Array.prototype.slice.call(host.querySelectorAll('.checkedit__row')).slice(0, fixed);
    var row = rows[index];
    var to = index;
    row.classList.add('is-dragging');
    // The new index = how many of the other rows have their middle above the pointer.
    function move(e) {
      to = 0;
      rows.forEach(function (r, i) {
        if (i === index) return;
        var box = r.getBoundingClientRect();
        if (e.clientY > box.top + box.height / 2) to++;
      });
      rows.forEach(function (r, i) { r.classList.toggle('is-target', i === to && i !== index); });
    }
    function up() {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      rows.forEach(function (r) { r.classList.remove('is-target', 'is-dragging'); });
      if (to !== index) opts.onMove(item.key, to);
    }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

/**
 * The add row. Controller: a field and "Přidat" (every morning from the next).
 * Morning: a field, a "jen dnes | každé ráno" choice (jen dnes by default)
 * and "Přidat". Enter adds too.
 */
export function addRow(opts) {
  var morning = opts.variant === 'morning';
  var once = true;
  var input = el('input.input.checkedit__new', {
    type: 'text', maxlength: String(MAX_LABEL), placeholder: morning ? '' : 'Přidat položku…',
    'aria-label': 'Nová položka'
  });
  var seg = null;
  function paintSeg() {
    if (!seg) return;
    seg.querySelectorAll('.seg__opt').forEach(function (b) {
      b.setAttribute('aria-pressed', String((b.getAttribute('data-once') === '1') === once));
    });
  }
  if (morning) {
    seg = el('span.seg.checkedit__seg', { role: 'group', 'aria-label': 'Platnost' }, [
      el('button.seg__opt', { type: 'button', 'data-once': '1', onclick: function () { once = true; paintSeg(); } }, 'jen dnes'),
      el('button.seg__opt', { type: 'button', 'data-once': '0', onclick: function () { once = false; paintSeg(); } }, 'každé ráno')
    ]);
    paintSeg();
  }
  function add(ev) {
    if (ev) ev.preventDefault();
    var v = input.value.trim();
    if (!v) { input.focus(); return; }
    opts.onAdd(v, morning ? once : false);
    input.value = '';
    input.focus();
  }
  return el('form.checkedit__add' + (morning ? '.checkedit__add--morning' : ''), { onsubmit: add }, [
    input, seg, el('button.btn.checkedit__addbtn', { type: 'submit' }, 'Přidat')
  ]);
}
