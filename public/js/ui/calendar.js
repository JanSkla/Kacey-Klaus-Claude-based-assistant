/* =========================================================================
   THE CALENDAR VIEWER.

   Reads /api/calendar, which reads klaus_memory's `calendar_event` table
   directly. Writes go through /api/calendar/:id/{update,delete}, which run
   klaus_memory rather than touching SQLite — conflicts, updated_at and the
   external write-through all belong to it.

   Kacey also writes the calendar through conversation, so protocol.js calls
   refreshCalendar() when one of her calendar tools finishes; otherwise an open
   viewer would sit on rows that are no longer true.

   Titles come from the model and from external calendars, so every one of them
   reaches the DOM through textContent.
   ========================================================================= */

/* The whole module is inert without its panel — index.html may not have it. */
var btn = document.getElementById('calBtn');
var sheet = document.getElementById('calPanel');
var present = !!(btn && sheet);


var closeBtn = document.getElementById('calClose');
var reloadBtn = document.getElementById('calReload');
var prevBtn = document.getElementById('calPrev');
var nextBtn = document.getElementById('calNext');
var todayBtn = document.getElementById('calToday');
var body = document.getElementById('calBody');
var meta = document.getElementById('calMeta');
var monthEl = document.getElementById('calMonth');
var jumpEl = document.getElementById('calJump');

var DOW = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];
// genitive for "3. srpna", nominative for the month heading
var MON = ['ledna', 'února', 'března', 'dubna', 'května', 'června',
           'července', 'srpna', 'září', 'října', 'listopadu', 'prosince'];
var MON_NOM = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen',
               'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];

var month = null;        // 'YYYY-MM'; null = whatever the server calls current
var loading = false;

function shiftMonth(m, delta) {
  var p = m.split('-').map(Number);
  var d = new Date(p[0], p[1] - 1 + delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function monthName(m) {
  var p = m.split('-').map(Number);
  return MON_NOM[p[1] - 1] + ' ' + p[0];
}

function hhmm(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d)) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/* Date and time together, for the hover detail on a spanning event. */
function hhmmDate(iso) {
  if (!iso) return '?';
  var d = new Date(iso);
  if (isNaN(d)) return '?';
  return d.getDate() + '. ' + MON[d.getMonth()] + ' ' + hhmm(iso);
}

function dayLabel(date) {
  var p = date.split('-');
  var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return { dow: DOW[d.getDay()], text: Number(p[2]) + '. ' + MON[Number(p[1]) - 1] };
}

function tag(text, cls) {
  var s = document.createElement('span');
  s.className = 'cal__tag' + (cls ? ' cal__tag--' + cls : '');
  s.textContent = text;
  return s;
}

/* What to put in the time column. A multi-day event covers several rows, so
   repeating "12:00–12:00" on each of them says nothing — the arrow says which
   end of the event this day is, and the middle days have no clock time at all. */
function timeLabel(e) {
  var from = hhmm(e.starts_at), to = hhmm(e.ends_at);
  var span = e.span && e.span.count > 1;

  // An all-day event has no clock time on any of its days, including the first.
  if (e.all_day) return 'celý den';
  if (!span) return to && to !== from ? from + '–' + to : from;
  if (e.span.first) return from + ' →';
  if (e.span.last) return '→ ' + to;
  return '⋯';                                  // a whole day in the middle
}

/* A value out of source_meta, which is free-form JSON from whatever produced the
   event. Objects and arrays are stringified rather than skipped: seeing the raw
   shape is more useful than pretending the key is not there. */
function metaValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch (err) { return '?'; } }
  return String(v);
}

function renderEvent(e) {
  var row = document.createElement('div');
  row.className = 'cal__event';
  if (e.span && e.span.count > 1) {
    row.className += ' cal__event--span';
    // Continuation days are context, not new commitments — dimmed so the day's
    // own events still read first.
    if (!e.span.first) row.className += ' cal__event--cont';
  }
  if (e.all_day) row.className += ' cal__event--allday';

  var time = document.createElement('span');
  time.className = 'cal__time';
  time.textContent = timeLabel(e);
  row.appendChild(time);

  // Titles come from the model and from external calendars — textContent only.
  var title = document.createElement('span');
  title.className = 'cal__title';
  title.textContent = e.title || '(bez názvu)';
  row.appendChild(title);

  var tags = document.createElement('span');
  tags.className = 'cal__tags';
  /* Which day of the run this is. Suppressed on a two-day TIMED event, where
     the arrows in the time column already say it and "1/2" on all sixty-odd
     overnight blocks would be pure noise. An all-day event has no arrows, so it
     needs the counter as soon as it spans at all. */
  if (e.span && (e.span.count > 2 || (e.span.count > 1 && e.all_day))) {
    tags.appendChild(tag(e.span.index + '/' + e.span.count, 'span'));
  }
  // Which calendar it came from.
  if (e.source) {
    var src = tag(e.source, 'src');
    src.setAttribute('data-src', e.source);
    tags.appendChild(src);
  }
  if (e.sync_state === 'pending') tags.appendChild(tag('čeká', 'pending'));
  if (e.sync_state === 'failed') tags.appendChild(tag('chyba', 'failed'));
  if (e.origin === 'external') tags.appendChild(tag('externí', 'ext'));
  if (e.sensitivity === 'local_only') tags.appendChild(tag('local', 'local'));
  // Whatever the source attached to the event — location, url, anything.
  if (e.source_meta) {
    Object.keys(e.source_meta).forEach(function (k) {
      var v = metaValue(e.source_meta[k]);
      if (!v) return;
      var chip = tag(k + ': ' + (v.length > 28 ? v.slice(0, 27) + '…' : v), 'meta');
      chip.title = k + ': ' + v;
      tags.appendChild(chip);
    });
  }
  if (tags.children.length) row.appendChild(tags);

  /* Hover detail: the things worth having but not worth a chip on every row. */
  var detail = [];
  if (e.span && e.span.count > 1) {
    detail.push('trvá ' + e.span.count + ' dní: ' +
      hhmmDate(e.starts_at) + ' – ' + hhmmDate(e.ends_at));
  }
  if (e.updated_at) detail.push('upraveno ' + hhmmDate(e.updated_at));
  if (e.sync_error) detail.push('chyba synchronizace: ' + e.sync_error);
  if (detail.length) row.title = detail.join('\n');

  var acts = document.createElement('span');
  acts.className = 'cal__tags';

  var edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'cal__act';
  edit.textContent = '✎';
  edit.title = 'Upravit';
  edit.setAttribute('aria-label', 'Upravit ' + (e.title || 'událost'));
  edit.onclick = function () { openEditor(row, e); };
  acts.appendChild(edit);

  /* Delete is two-step on purpose. An event is real data, and a mis-click on a
     12px icon should not be able to destroy it — the second click is the
     consent, and it reverts on blur or after a few seconds. */
  var del = document.createElement('button');
  del.type = 'button';
  del.className = 'cal__act cal__act--del';
  del.textContent = '×';
  del.title = 'Smazat';
  del.setAttribute('aria-label', 'Smazat ' + (e.title || 'událost'));
  var armed = false, disarm = 0;
  function reset() {
    armed = false;
    clearTimeout(disarm);
    del.textContent = '×';
    del.className = 'cal__act cal__act--del';
  }
  del.onclick = function () {
    if (!armed) {
      armed = true;
      del.textContent = 'smazat?';
      del.className = 'cal__act cal__act--confirm';
      disarm = setTimeout(reset, 5000);
      return;
    }
    reset();
    removeEvent(row, e);
  };
  del.onblur = reset;
  acts.appendChild(del);

  row.appendChild(acts);
  return row;
}

/* --- writes ------------------------------------------------------------
   These go through /api/calendar/:id/{update,delete}, which runs
   klaus_memory rather than touching SQLite — conflicts, updated_at and the
   external write-through all belong to it. */

function localInput(iso) {
  // <input type="datetime-local"> wants 'YYYY-MM-DDTHH:MM' in local time.
  var d = new Date(iso);
  if (isNaN(d)) return '';
  var p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function offsetIso(localValue) {
  // Back to ISO with this machine's offset, which is what klaus_memory stores.
  if (!localValue) return null;
  var d = new Date(localValue);
  if (isNaN(d)) return null;
  var off = -d.getTimezoneOffset();
  var sign = off >= 0 ? '+' : '-';
  var p = function (n) { return String(Math.abs(n)).padStart(2, '0'); };
  return localValue + ':00' + sign + p(Math.floor(Math.abs(off) / 60)) + ':' + p(off % 60);
}

function openEditor(row, e) {
  if (row.nextSibling && row.nextSibling.classList &&
      row.nextSibling.classList.contains('cal__edit')) {
    row.parentNode.removeChild(row.nextSibling);       // toggle closed
    return;
  }

  var form = document.createElement('div');
  form.className = 'cal__edit';

  function field(labelText, type, value) {
    var l = document.createElement('label');
    var s = document.createElement('span');
    s.textContent = labelText;
    var i = document.createElement('input');
    i.type = type;
    i.value = value || '';
    l.appendChild(s); l.appendChild(i);
    return { label: l, input: i };
  }

  var title = field('název', 'text', e.title || '');
  form.appendChild(title.label);

  // Start AND end together: klaus_memory rejects an update that leaves the end
  // before the start, so editing one in isolation fails confusingly.
  var times = document.createElement('div');
  times.className = 'cal__edit-row';
  var from = field('od', 'datetime-local', localInput(e.starts_at));
  var to = field('do', 'datetime-local', e.ends_at ? localInput(e.ends_at) : '');
  times.appendChild(from.label); times.appendChild(to.label);
  form.appendChild(times);

  var err = document.createElement('p');
  err.className = 'cal__edit-err';
  err.hidden = true;

  var actions = document.createElement('div');
  actions.className = 'cal__edit-actions';
  var save = document.createElement('button');
  save.type = 'button';
  save.className = 'cal__btn';
  save.textContent = 'uložit';
  var cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'cal__btn';
  cancel.textContent = 'zpět';
  cancel.onclick = function () { form.parentNode.removeChild(form); };
  actions.appendChild(save); actions.appendChild(cancel);
  form.appendChild(actions);
  form.appendChild(err);

  save.onclick = function () {
    var payload = {};
    if (title.input.value.trim() && title.input.value.trim() !== e.title) {
      payload.title = title.input.value.trim();
    }
    var startIso = offsetIso(from.input.value);
    if (startIso && startIso !== e.starts_at) payload.starts_at = startIso;
    var endIso = to.input.value ? offsetIso(to.input.value) : null;
    if (endIso !== (e.ends_at || null)) payload.ends_at = endIso;   // null clears it

    if (!Object.keys(payload).length) { form.parentNode.removeChild(form); return; }

    save.disabled = true;
    err.hidden = true;
    fetch('/api/calendar/' + encodeURIComponent(e.event_id) + '/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || 'zápis selhal');
        load();                                    // redraw the month
      })
      .catch(function (ex) {
        save.disabled = false;
        err.textContent = ex.message;
        err.hidden = false;
      });
  };

  row.parentNode.insertBefore(form, row.nextSibling);
  title.input.focus();
}

function removeEvent(row, e) {
  row.classList.add('cal__event--busy');
  fetch('/api/calendar/' + encodeURIComponent(e.event_id) + '/delete', { method: 'POST' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok) throw new Error(j.error || 'smazání selhalo');
      load();
    })
    .catch(function (ex) {
      row.classList.remove('cal__event--busy');
      meta.textContent = 'Smazání selhalo: ' + ex.message;
    });
}

/* Chips for every month that actually holds something, so a sparse calendar
   does not have to be walked one empty month at a time. */
function renderJump(data) {
  jumpEl.innerHTML = '';
  var months = data.monthsWithEvents || [];
  if (!months.length) { jumpEl.hidden = true; return; }

  var label = document.createElement('span');
  label.className = 'cal__jump-label';
  label.textContent = 'kde něco je';
  jumpEl.appendChild(label);

  months.forEach(function (m) {
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'cal__chip';
    if (m.month === data.month) chip.setAttribute('aria-current', 'true');
    var b = document.createElement('b');
    b.textContent = monthName(m.month);
    chip.appendChild(b);
    chip.appendChild(document.createTextNode(' ' + m.count));
    chip.onclick = function () { month = m.month; load(); };
    jumpEl.appendChild(chip);
  });
  jumpEl.hidden = false;
}

function render(data) {
  month = data.month;
  monthEl.textContent = monthName(data.month);
  renderJump(data);

  body.innerHTML = '';
  var withEvents = 0;

  data.days.forEach(function (day) {
    var isToday = day.date === data.today;
    var isPast = day.date < data.today;

    var wrap = document.createElement('div');
    wrap.className = 'cal__day' +
      (day.events.length ? '' : ' cal__day--empty') +
      (isToday ? ' cal__day--today' : '') +
      (isPast ? ' cal__day--past' : '');

    var head = document.createElement('div');
    head.className = 'cal__date';
    var l = dayLabel(day.date);
    var dow = document.createElement('span');
    dow.className = 'cal__dow';
    dow.textContent = l.dow;
    head.appendChild(dow);
    var b = document.createElement('b');
    b.textContent = l.text;
    head.appendChild(b);
    if (isToday) {
      var now = document.createElement('span');
      now.textContent = '· dnes';
      head.appendChild(now);
    }
    wrap.appendChild(head);

    if (day.events.length) {
      withEvents++;
      day.events.forEach(function (e) { wrap.appendChild(renderEvent(e)); });
    } else {
      var none = document.createElement('p');
      none.className = 'cal__none';
      none.textContent = '—';
      wrap.appendChild(none);
    }
    body.appendChild(wrap);
  });

  meta.textContent = data.monthEvents === 0
    ? 'v tomto měsíci nic · ' + data.total + ' událostí celkem'
    : data.monthEvents + ' událostí v měsíci · ' + withEvents + ' dnů s programem' +
      ' · ' + data.total + ' celkem';

  // A month is ~30 rows. Land on today in the current month; otherwise start at
  // the first day that actually has something, so a jump lands on content.
  var anchor = body.querySelector('.cal__day--today');
  if (!anchor) {
    var firstWith = body.querySelector('.cal__day:not(.cal__day--empty)');
    anchor = firstWith || null;
  }
  body.scrollTop = anchor ? Math.max(0, anchor.offsetTop - body.offsetTop - 4) : 0;
}

function load() {
  if (loading) return;
  loading = true;
  meta.textContent = 'načítám…';
  fetch('/api/calendar' + (month ? '?month=' + encodeURIComponent(month) : ''))
    .then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    })
    .then(render)
    .catch(function (err) {
      body.innerHTML = '';
      var p = document.createElement('p');
      p.className = 'cal__err';
      p.textContent = 'Kalendář se nepodařilo načíst: ' + err.message;
      body.appendChild(p);
      meta.textContent = '—';
    })
    .then(function () { loading = false; });
}

function open(yes) {
  sheet.hidden = !yes;
  btn.setAttribute('aria-expanded', String(yes));
  if (yes) load();
}


/* Called by protocol.js after any calendar tool — a no-op unless the viewer is
   actually on screen. */
export function refreshCalendar() {
  if (present && !sheet.hidden) load();
}

export function initCalendar() {
  if (!present) return;

  btn.addEventListener('click', function () { open(sheet.hidden); });
  closeBtn.addEventListener('click', function () { open(false); });
  reloadBtn.addEventListener('click', load);
  prevBtn.addEventListener('click', function () { if (month) { month = shiftMonth(month, -1); load(); } });
  nextBtn.addEventListener('click', function () { if (month) { month = shiftMonth(month, 1); load(); } });
  todayBtn.addEventListener('click', function () { month = null; load(); });
  sheet.addEventListener('click', function (ev) { if (ev.target === sheet) open(false); });
  document.addEventListener('keydown', function (ev) {
    if (sheet.hidden) return;
    // Arrows page through months while the viewer has focus.
    if (ev.key === 'Escape') { ev.preventDefault(); open(false); }
    else if (ev.key === 'ArrowLeft' && month) { ev.preventDefault(); month = shiftMonth(month, -1); load(); }
    else if (ev.key === 'ArrowRight' && month) { ev.preventDefault(); month = shiftMonth(month, 1); load(); }
  });
}
