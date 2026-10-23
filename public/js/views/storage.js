/* =========================================================================
   ÚLOŽIŠTĚ — any file up from one device, down on another.

   One list of files on kaceybody, newest first (or by name, or by size): the
   name, how big, when and from which device it came. A file goes up by
   Nahrát soubory, or dropped anywhere on the list on a computer; it goes up
   as the File itself, so the server streams it to disk and the row shows the
   real progress. One upload at a time, the rest wait in line.

   A picture, video, sound, PDF or text opens in the náhled (core/filekind.js
   says which): its name, or Zobrazit, shows it as it is, ‹ › step through the
   others that open. Any other name is the download; on a computer each row
   also has Stáhnout and a two-tap Smazat. The tick boxes pick several:
   Stáhnout and Smazat then work on all of them (a phone deletes this way
   only). Deleting toasts with Vrátit — the server keeps a deleted file for a
   day.

   A `storage` frame says a file came or went on the other device; the list
   follows, and a file from the other device toasts.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { el, fill } from '../core/el.js';
import * as bus from '../core/bus.js';
import { onEnter, currentView, go } from '../ui/router.js';
import { say } from '../ui/toast.js';
import { isOnline } from '../net/protocol.js';
import { viewOf } from '../core/filekind.js';

var SORT_KEY = 'kacey.storage.sort';
var ORIGIN = 'p' + Math.random().toString(36).slice(2, 10);

var files = [];
var totals = { total_bytes: 0, free_bytes: null, max_file_bytes: 4 * 1024 * 1024 * 1024 };
var loaded = false, failed = false;
var find = '', sort = 'new';
var picked = {};                     // id → true
var armed = null, armTimer = 0;      // a row's id, or 'sel' for the selection bar
var queue = [];                      // uploads: { key, file, name, size, state, sent, error, xhr }
var uploading = false;
var fresh = {};                      // ids that just arrived from the other device
var shownNow = [];                   // the list as drawn: the náhled's ‹ › follow it
var viewing = null;                  // the id open in the náhled
var viewArmed = false, viewTimer = 0;
var TEXT_BYTES = 1024 * 1024;        // a text shows its first megabyte
var TABLE_ROWS = 1000;

/* ---- words -------------------------------------------------------------------- */

function plural(n, one, few, many) { return n === 1 ? one : n >= 2 && n <= 4 ? few : many; }
function souboru(n) { return n + ' ' + plural(n, 'soubor', 'soubory', 'souborů'); }

export function size(bytes) {
  var b = Number(bytes) || 0;
  if (b < 1024) return b + ' B';
  var units = ['kB', 'MB', 'GB', 'TB'], u = -1;
  do { b /= 1024; u++; } while (b >= 1024 && u < units.length - 1);
  return (b >= 100 || u === 0 ? Math.round(b) : b.toFixed(1)).toString().replace('.', ',') + ' ' + units[u];
}

function when(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return '';
  var now = new Date();
  var clock = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  var y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'dnes ' + clock;
  if (d.toDateString() === y.toDateString()) return 'včera ' + clock;
  return d.getDate() + '. ' + (d.getMonth() + 1) + '.' + (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '') + ' ' + clock;
}

var FROM = { desktop: 'z počítače', phone: 'z telefonu', kacey: 'od Kacey' };

function ext(name) {
  var m = /\.([a-z0-9]{1,5})$/i.exec(String(name || ''));
  return m ? m[1].toUpperCase() : '';
}

function fold(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

/** Which kind of device this page runs on — the row says where a file came from. */
function device() {
  return (window.matchMedia && matchMedia('(pointer: coarse)').matches) || window.innerWidth <= 760 ? 'phone' : 'desktop';
}

/* Relative on purpose: a plain link is not rewritten by the comparison's shim, but
   its <base href="/preview/"> does move a relative one onto the preview's server. */
function downloadUrl(f) { return 'api/storage/' + encodeURIComponent(f.id) + '/download'; }
function viewUrl(f) { return 'api/storage/' + encodeURIComponent(f.id) + '/view'; }

/* ---- loading ------------------------------------------------------------------ */

function load() {
  return fetch('/api/storage', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok) throw new Error(j.error);
      files = j.files || [];
      totals = { total_bytes: j.total_bytes || 0, free_bytes: j.free_bytes, max_file_bytes: j.max_file_bytes || totals.max_file_bytes };
      // A file deleted on the other device cannot stay picked here.
      var have = {};
      files.forEach(function (f) { have[f.id] = true; });
      Object.keys(picked).forEach(function (id) { if (!have[id]) delete picked[id]; });
      if (viewing && !have[viewing]) closeView();
      loaded = true; failed = false;
      render();
    })
    .catch(function () { failed = true; render(); });
}

/* ---- picking ------------------------------------------------------------------- */

function pickedFiles() { return files.filter(function (f) { return picked[f.id]; }); }

function toggle(id) {
  if (picked[id]) delete picked[id]; else picked[id] = true;
  disarm();
  render();
}

function clearPick() { picked = {}; disarm(); render(); }

function arm(what) {
  armed = what;
  clearTimeout(armTimer);
  armTimer = setTimeout(function () { armed = null; render(); }, 4000);
  render();
}

function disarm() { armed = null; clearTimeout(armTimer); }

/* ---- downloading ---------------------------------------------------------------- */

function downloadMany(list) {
  if (!list.length) return;
  if (!isOnline()) { say('Jsi offline — stáhnout půjde, až se připojím.'); return; }
  // One hidden link after another: a browser takes a quick burst of clicks as one.
  list.forEach(function (f, i) {
    setTimeout(function () {
      var a = el('a', { href: downloadUrl(f), download: f.name, hidden: true });
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { a.remove(); }, 1000);
    }, i * 350);
  });
  if (list.length > 1) say('Stahuji ' + souboru(list.length) + ' — prohlížeč se může zeptat, jestli smí stáhnout víc souborů najednou.');
}

/* ---- deleting --------------------------------------------------------------------- */

function remove(list) {
  disarm();
  if (!list.length) return;
  if (!isOnline()) { render(); say('Jsi offline — smazat půjde, až se připojím.'); return; }
  var ids = list.map(function (f) { return f.id; });
  fetch('/api/storage/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ids, origin: ORIGIN })
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) throw new Error(j.error);
    files = files.filter(function (f) { return ids.indexOf(f.id) === -1; });
    ids.forEach(function (id) { delete picked[id]; });
    totals.total_bytes = files.reduce(function (s, f) { return s + f.bytes; }, 0);
    render();
    say(list.length === 1 ? 'Soubor „' + list[0].name + '“ smazán.' : 'Smazáno ' + souboru(list.length) + '.', {
      label: 'Vrátit',
      run: function () {
        fetch('/api/storage/restore', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ids, origin: ORIGIN })
        }).then(function (r) { return r.json(); }).then(function (k) {
          if (!k.ok) throw new Error(k.error);
          load();
          say(k.files.length === 1 ? 'Soubor „' + k.files[0].name + '“ je zpátky.' : souboru(k.files.length) + ' zpátky.');
        }).catch(function () { say('Vrátit se nepovedlo.'); });
      }
    });
  }).catch(function (err) { render(); say('Smazat se nepovedlo — ' + (err.message || 'zkus to znovu') + '.'); });
}

/* ---- uploading -------------------------------------------------------------------- */

function addUploads(list) {
  list = Array.prototype.slice.call(list || []);
  if (!list.length) return;
  if (!isOnline()) { say('Jsi offline — nahrát půjde, až se připojím.'); return; }
  var free = totals.free_bytes;
  list.forEach(function (file) {
    var u = { key: 'u' + Math.random().toString(36).slice(2), file: file, name: file.name || 'soubor', size: file.size, state: 'wait', sent: 0, error: '' };
    if (file.size > totals.max_file_bytes) { u.state = 'failed'; u.error = 'Větší než ' + size(totals.max_file_bytes) + ' — tohle se sem nevejde.'; u.final = true; }
    else if (free != null && file.size > free) { u.state = 'failed'; u.error = 'Na disku není dost místa (volno ' + size(free) + ').'; u.final = true; }
    queue.push(u);
  });
  render();
  next();
}

function next() {
  if (uploading) return;
  var u = queue.find(function (x) { return x.state === 'wait'; });
  if (!u) return;
  uploading = true;
  u.state = 'up'; u.sent = 0;
  var xhr = new XMLHttpRequest();
  u.xhr = xhr;
  xhr.open('POST', '/api/storage');
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.setRequestHeader('X-File-Name', encodeURIComponent(u.name));
  xhr.setRequestHeader('X-File-Type', encodeURIComponent(u.file.type || ''));
  xhr.setRequestHeader('X-Device', device());
  xhr.setRequestHeader('X-Origin', ORIGIN);
  var painted = 0;
  xhr.upload.onprogress = function (ev) {
    u.sent = ev.loaded;
    // The row repaints at most ten times a second.
    var t = Date.now();
    if (t - painted > 100) { painted = t; paintUpload(u); }
  };
  var done = function (error) {
    uploading = false;
    u.xhr = null;
    if (error === null) {
      queue = queue.filter(function (x) { return x !== u; });
    } else if (error === 'cancel') {
      queue = queue.filter(function (x) { return x !== u; });
    } else {
      u.state = 'failed'; u.error = error;
    }
    render();
    next();
  };
  xhr.onload = function () {
    var j = null;
    try { j = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
    if (xhr.status === 200 && j && j.ok) {
      if (!files.some(function (f) { return f.id === j.file.id; })) files.unshift(j.file);
      totals.total_bytes += j.file.bytes;
      if (totals.free_bytes != null) totals.free_bytes = Math.max(0, totals.free_bytes - j.file.bytes);
      done(null);
      if (!queue.some(function (x) { return x.state === 'wait' || x.state === 'up'; })) {
        say(queue.length ? 'Nahráno. Co nešlo, je v seznamu nahoře.' : 'Nahráno — stáhneš si to na kterémkoli zařízení.');
      }
    } else {
      done((j && j.error) || 'Soubor se nepodařilo uložit.');
    }
  };
  xhr.onerror = function () { done(isOnline() ? 'Spojení se přerušilo.' : 'Jsi offline.'); };
  xhr.onabort = function () { done('cancel'); };
  xhr.send(u.file);
}

function cancelUpload(u) {
  if (u.xhr) { u.xhr.abort(); return; }
  queue = queue.filter(function (x) { return x !== u; });
  render();
}

function retry(u) {
  if (!isOnline()) { say('Jsi offline — nahrát půjde, až se připojím.'); return; }
  u.state = 'wait'; u.error = ''; u.sent = 0;
  render();
  next();
}

/* ---- the list ------------------------------------------------------------------------ */

function fileIcon(name) {
  var e = ext(name);
  return el('span.fileicon' + (e ? '' : '.fileicon--blank'), { 'aria-hidden': 'true' }, e ? el('span.fileicon__ext', e) : null);
}

function uploadRow(u) {
  var pct = u.size ? Math.min(100, Math.round(u.sent / u.size * 100)) : 0;
  var meta;
  if (u.state === 'up') meta = el('span.frow__progress', [
    el('span.bar.frow__bar', el('span.bar__fill', { style: 'width:' + pct + '%' })),
    el('span.frow__pct.num', 'Nahrávám · ' + pct + ' % · ' + size(u.sent) + ' z ' + size(u.size))
  ]);
  else if (u.state === 'wait') meta = el('span.frow__meta.num', size(u.size) + ' · čeká, až se nahraje předchozí');
  else meta = el('span.frow__meta.frow__err', 'Neuloženo — ' + u.error.charAt(0).toLowerCase() + u.error.slice(1).replace(/\.$/, '') + '.');
  var acts = u.state === 'failed'
    ? [u.final ? null : el('button.link', { type: 'button', onclick: function () { retry(u); } }, 'Zkusit znovu'),
       el('button.link.link--muted', { type: 'button', onclick: function () { cancelUpload(u); } }, 'Zahodit')]
    : [el('button.link.link--muted', { type: 'button', onclick: function () { cancelUpload(u); } }, 'Zrušit')];
  return el('div.frow.is-uploading' + (u.state === 'failed' ? '.is-failed' : '') + (u.state === 'wait' ? '.is-waiting' : ''), { 'data-key': u.key }, [
    el('span.frow__tick'),
    fileIcon(u.name),
    el('span.frow__main', [el('span.frow__name', u.name), meta]),
    el('span.frow__size.num', size(u.size)),
    el('span.frow__when', u.state === 'up' ? 'teď' : ''),
    el('span.frow__acts', acts)
  ]);
}

/* Progress without rebuilding the list, so a click in it is never lost. */
function paintUpload(u) {
  var row = document.querySelector('.frow[data-key="' + u.key + '"]');
  if (!row) return;
  var pct = u.size ? Math.min(100, Math.round(u.sent / u.size * 100)) : 0;
  var fillEl = row.querySelector('.bar__fill'), txt = row.querySelector('.frow__pct');
  if (fillEl) fillEl.style.width = pct + '%';
  if (txt) txt.textContent = 'Nahrávám · ' + pct + ' % · ' + size(u.sent) + ' z ' + size(u.size);
}

/* The download arrow — the upload button's, turned round. el() makes HTML elements, so by hand. */
function downIcon() {
  var NS = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16'); svg.setAttribute('aria-hidden', 'true');
  var p = document.createElementNS(NS, 'path');
  p.setAttribute('d', 'M12 4v11M7.5 10.5 12 15l4.5-4.5M4 15v5h16v-5');
  svg.appendChild(p);
  return svg;
}

function fileRow(f) {
  var on = !!picked[f.id];
  var from = FROM[f.device] || '';
  var shows = !!viewOf(f.name);
  var open = function () { openView(f.id); };
  var link = shows
    ? el('button.frow__name.frow__open', { type: 'button', title: 'Zobrazit ' + f.name, onclick: open }, f.name)
    : el('a.frow__name', { href: downloadUrl(f), download: f.name, title: 'Stáhnout ' + f.name }, f.name);
  return el('div.frow' + (on ? '.is-picked' : '') + (fresh[f.id] ? '.is-new' : ''), [
    el('button.tickbox.frow__tick', {
      type: 'button', 'aria-pressed': String(on), 'aria-label': (on ? 'Odebrat z výběru ' : 'Vybrat ') + f.name,
      onclick: function () { toggle(f.id); }
    }, on ? '✓' : ''),
    fileIcon(f.name),
    el('span.frow__main', [
      link,
      el('span.frow__meta.num', [size(f.bytes), when(f.created_at), from].filter(Boolean).join(' · '))
    ]),
    el('span.frow__size.num', size(f.bytes)),
    el('span.frow__when.num', [when(f.created_at), from ? el('span.frow__from', from) : null]),
    el('span.frow__acts', [
      shows && armed !== f.id ? el('button.link.frow__view', { type: 'button', onclick: open, 'aria-label': 'Zobrazit ' + f.name }, 'Zobrazit') : null,
      el('a.btn.btn--sm.frow__get', { href: downloadUrl(f), download: f.name, 'aria-label': 'Stáhnout ' + f.name }, [
        downIcon(),
        el('span.frow__getlabel', 'Stáhnout')
      ]),
      armed === f.id
        ? el('button.btn.btn--sm.btn--dangerfill.frow__del', { type: 'button', onclick: function () { remove([f]); } }, 'Opravdu smazat?')
        : el('button.link.link--muted.frow__del', { type: 'button', onclick: function () { arm(f.id); } }, 'Smazat')
    ])
  ]);
}

function sorted(list) {
  var out = list.slice();
  if (sort === 'name') out.sort(function (a, b) { return a.name.localeCompare(b.name, 'cs', { numeric: true, sensitivity: 'base' }); });
  else if (sort === 'size') out.sort(function (a, b) { return b.bytes - a.bytes; });
  return out;
}

function paintCounts() {
  var n = files.length;
  $('stCount').textContent = loaded ? souboru(n) + (n ? ' · ' + size(totals.total_bytes) : '') : '—';
  $('stStatCount').textContent = loaded ? souboru(n) : '—';
  $('stStatMeta').textContent = loaded
    ? (n ? size(totals.total_bytes) + ' zabraných' : 'zatím nic') + (totals.free_bytes != null ? ' · na disku volno ' + size(totals.free_bytes) : '')
    : '—';
  var badge = $('navBadgeStorage');
  if (badge) badge.textContent = n ? String(n) : '';
  var more = $('moreStorageMeta');
  if (more) more.textContent = n ? souboru(n) : '';
}

function paintSelection(shown) {
  var list = pickedFiles();
  var n = list.length;
  var view = document.querySelector('.view[data-view="storage"]');
  $('stSel').hidden = !n;
  $('stFind').hidden = !!n;
  if (view) view.toggleAttribute('data-picking', !!n);
  var all = $('stAll');
  var everything = shown.length && shown.every(function (f) { return picked[f.id]; });
  all.setAttribute('aria-pressed', String(!!everything));
  all.textContent = everything ? '✓' : n ? '–' : '';
  all.classList.toggle('is-some', !!n && !everything);
  all.setAttribute('aria-label', everything ? 'Zrušit výběr' : 'Vybrat všechny soubory');
  if (!n) return;
  var bytes = list.reduce(function (s, f) { return s + f.bytes; }, 0);
  $('stSelCount').textContent = n + ' ' + plural(n, 'vybraný', 'vybrané', 'vybraných') + ' · ' + size(bytes);
  $('stSelDownload').textContent = n > 1 ? 'Stáhnout (' + n + ')' : 'Stáhnout';
  var del = $('stSelDelete');
  var sure = armed === 'sel';
  del.textContent = sure ? (n > 1 ? 'Opravdu smazat ' + n + '?' : 'Opravdu smazat?') : (n > 1 ? 'Smazat (' + n + ')' : 'Smazat');
  del.classList.toggle('btn--dangerfill', sure);
  del.classList.toggle('btn--dangerghost', !sure);
}

function render() {
  paintCounts();
  var list = $('stList');
  var want = fold(find.trim());
  var shown = loaded ? sorted(want ? files.filter(function (f) { return fold(f.name).indexOf(want) !== -1; }) : files) : [];
  shownNow = shown;
  if (viewing) paintView(false);
  paintSelection(shown);
  $('stCols').hidden = !loaded || !files.length;
  if (!loaded) {
    fill(list, failed
      ? el('div.galempty', [el('span.galempty__mark.galempty__mark--err', { 'aria-hidden': 'true' }),
        el('h3', isOnline() ? 'Úložiště se nepodařilo načíst.' : 'Jsi offline.'),
        el('p', 'Soubory jsou uložené na kaceybody — ukážu je, až se spojení vrátí.'),
        el('button.btn', { type: 'button', onclick: load }, 'Zkusit znovu')])
      : el('p.empty', 'Načítám úložiště…'));
    return;
  }
  var kids = queue.map(uploadRow);
  kids = kids.concat(shown.map(fileRow));
  if (!files.length && !queue.length) {
    kids.push(el('div.galempty.stempty', [
      el('span.galempty__mark.galempty__mark--tray', { 'aria-hidden': 'true' }),
      el('h3', 'Úložiště je prázdné.'),
      el('p', 'Nahraj sem cokoliv — fotku, PDF, video, archiv — a stáhneš si to na kterémkoli zařízení. Soubory tu zůstanou, dokud je nesmažeš.'),
      el('button.btn.btn--accent', { type: 'button', onclick: function () { $('stFile').click(); } }, 'Nahrát soubory')
    ]));
  } else if (want && !shown.length) {
    kids.push(el('div.galempty.stempty', [
      el('h3', 'Žádný soubor se tak nejmenuje.'),
      el('button.btn', { type: 'button', onclick: function () { find = ''; $('stQuery').value = ''; render(); } }, 'Zrušit hledání')
    ]));
  }
  fill(list, kids);
}

/* ---- the other device ---------------------------------------------------------------- */

function onFrame(msg) {
  if (!loaded) return;
  var mine = msg.origin === ORIGIN;
  if (msg.event === 'added' && msg.file) {
    if (files.some(function (f) { return f.id === msg.file.id; })) return;
    files.unshift(msg.file);
    totals.total_bytes += msg.file.bytes;
    if (!mine) {
      fresh[msg.file.id] = true;
      setTimeout(function () { delete fresh[msg.file.id]; if (currentView() === 'storage') render(); }, 2400);
      say('Nový soubor ' + (FROM[msg.file.device] || '') + ': „' + msg.file.name + '“.', null,
        currentView() === 'storage' ? null : function () { go('storage'); });
    }
    render();
  } else if (msg.event === 'removed' && !mine) {
    var open = viewing && (msg.ids || []).indexOf(viewing) !== -1 ? byId(viewing) : null;
    if (open) { closeView(); say('Soubor „' + open.name + '“ byl smazán na druhém zařízení.'); }
    files = files.filter(function (f) { return (msg.ids || []).indexOf(f.id) === -1; });
    (msg.ids || []).forEach(function (id) { delete picked[id]; });
    totals.total_bytes = files.reduce(function (s, f) { return s + f.bytes; }, 0);
    render();
  } else if (msg.event === 'restored' && !mine) {
    load();
  }
}

/* ---- the náhled ---------------------------------------------------------------------------
   One file shown as it is, in a sheet: a picture or a video contained on --bg, a sound
   with its player, a PDF in the browser's own viewer (a phone opens it in a tab), a
   text in its first megabyte, a CSV as a table. ‹ › and ←/→ go through the files in the
   list that open, in its order; Escape closes. */

function byId(id) { return files.find(function (f) { return f.id === id; }); }
function openable() { return shownNow.filter(function (f) { return viewOf(f.name); }); }

function openView(id) {
  viewing = id;
  viewDisarm();
  paintView(true);
  $('stView').hidden = false;
  $('stViewClose').focus();
}

function closeView() {
  $('stView').hidden = true;
  viewing = null;
  viewDisarm();
  fill($('stViewStage'), null);       // a video or a sound stops with the sheet
}

function stepView(d) {
  var list = openable();
  var i = list.findIndex(function (f) { return f.id === viewing; });
  if (i < 0 || list.length < 2) return;
  viewing = list[(i + d + list.length) % list.length].id;
  viewDisarm();
  paintView(true);
}

function viewDisarm() { viewArmed = false; clearTimeout(viewTimer); }

function paintViewDelete() {
  var del = $('stViewDelete');
  del.textContent = viewArmed ? 'Opravdu smazat?' : 'Smazat';
  del.classList.toggle('btn--dangerfill', viewArmed);
  del.classList.toggle('btn--dangerghost', !viewArmed);
}

/** The head and foot; the content itself only when `full` (a repaint of the list must not restart a video). */
function paintView(full) {
  var f = byId(viewing), v = f && viewOf(f.name);
  if (!v) { closeView(); return; }
  var list = openable();
  var i = list.findIndex(function (x) { return x.id === f.id; });
  fill($('stViewIcon'), fileIcon(f.name));
  $('stViewName').textContent = f.name;
  $('stViewName').title = f.name;
  $('stViewPos').textContent = list.length > 1 && i >= 0 ? (i + 1) + ' / ' + list.length : '';
  $('stPrev').disabled = $('stNext').disabled = list.length < 2 || i < 0;
  $('stViewMeta').textContent = [v.ext.toUpperCase(), size(f.bytes), when(f.created_at), FROM[f.device]].filter(Boolean).join(' · ');
  $('stViewDownload').href = downloadUrl(f);
  $('stViewDownload').setAttribute('download', f.name);
  paintViewDelete();
  if (full) stage(f, v);
}

function viewFail(f, title, text, canDownload) {
  return el('div.galempty.fview__fail', [
    el('span.galempty__mark.galempty__mark--err', { 'aria-hidden': 'true' }),
    el('h3', title),
    el('p', text),
    canDownload ? el('a.btn', { href: downloadUrl(f), download: f.name }, 'Stáhnout') : null
  ]);
}

function stage(f, v) {
  var host = $('stViewStage');
  host.setAttribute('data-kind', v.kind);
  if (!isOnline()) { fill(host, viewFail(f, 'Jsi offline.', 'Soubor je na kaceybody — ukážu ho, až se spojení vrátí.')); return; }
  var cannot = function () {
    if (viewing !== f.id) return;
    fill(host, viewFail(f, 'Tenhle soubor ukázat neumím.', 'Prohlížeč jeho obsah nepřečetl — stáhni si ho a otevři v aplikaci, která ho zná.', true));
  };
  if (v.kind === 'image') {
    fill(host, el('div.fview__media', el('img', { src: viewUrl(f), alt: f.name, onerror: cannot })));
  } else if (v.kind === 'video') {
    fill(host, el('div.fview__media', el('video', { src: viewUrl(f), controls: true, playsinline: true, preload: 'metadata', onerror: cannot })));
  } else if (v.kind === 'audio') {
    fill(host, el('div.fview__media.fview__audio', [
      el('p.label', 'ZVUK · ' + v.ext.toUpperCase()),
      el('p.fview__audioname', f.name),
      el('audio', { src: viewUrl(f), controls: true, preload: 'metadata', onerror: cannot })
    ]));
  } else if (v.kind === 'pdf') {
    // A phone has no PDF viewer in a page: the PDF opens in a tab of its own.
    fill(host, device() === 'phone'
      ? el('div.galempty.fview__fail', [
          el('h3', 'PDF se otevře v prohlížeči.'),
          el('p', 'Telefon ho neumí ukázat přímo tady — otevře ho na nové kartě.'),
          el('a.btn.btn--accent', { href: viewUrl(f), target: '_blank', rel: 'noopener' }, 'Otevřít PDF')])
      : el('iframe.fview__frame', { src: viewUrl(f), title: f.name }));
  } else {
    showText(f, v, host);
  }
}

/* UTF-8, or the Czech Windows code page an older Excel still saves in. A cut-off
   megabyte may end inside a character: up to three bytes are let go. */
function decode(bytes, cut) {
  for (var k = 0; k <= (cut ? 3 : 0); k++) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.length - k)); } catch (e) { /* try shorter */ }
  }
  try { return new TextDecoder('windows-1250').decode(bytes); } catch (e) { return new TextDecoder('utf-8').decode(bytes); }
}

function parseTable(text, sep, max) {
  var rows = [], row = [], cell = '', q = false;
  for (var i = 0; i < text.length && rows.length <= max; i++) {
    var c = text[i];
    if (q) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else q = false;
    } else if (c === '"' && cell === '') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

function tableOf(text, ext) {
  var first = text.split('\n', 1)[0];
  var count = function (ch) { return first.split(ch).length - 1; };
  var sep = ext === 'tsv' ? '\t' : [';', '\t', ','].reduce(function (best, ch) { return count(ch) > count(best) ? ch : best; }, ',');
  return parseTable(text, sep, TABLE_ROWS + 1);
}

function showText(f, v, host) {
  if (!f.bytes) { fill(host, el('p.empty.fview__empty', 'Soubor je prázdný.')); return; }
  fill(host, el('p.empty.fview__empty', 'Načítám obsah…'));
  var id = f.id;
  fetch('/' + viewUrl(f), { headers: { Range: 'bytes=0-' + (TEXT_BYTES - 1) }, cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error(); return r.arrayBuffer(); })
    .then(function (buf) {
      if (viewing !== id) return;
      var bytes = new Uint8Array(buf);
      var cut = f.bytes > bytes.length;
      // A nul byte early on: whatever the name says, this is not text.
      if (bytes.subarray(0, 8192).indexOf(0) !== -1) {
        fill(host, viewFail(f, 'Tohle není čitelný text.', 'Soubor se jmenuje jako text, ale uvnitř je něco jiného — stáhni si ho.', true));
        return;
      }
      var text = decode(bytes, cut).replace(/^﻿/, '');
      var note = cut ? 'Ukazuji prvních ' + size(bytes.length) + ' z ' + size(f.bytes) + ' — celý soubor si stáhni.' : '';
      if (v.kind === 'table') {
        var rows = tableOf(text, v.ext);
        if (cut && rows.length <= TABLE_ROWS) rows.pop();      // the last row was cut in half
        if (rows.length > TABLE_ROWS) { rows = rows.slice(0, TABLE_ROWS); note = 'Ukazuji prvních ' + TABLE_ROWS.toLocaleString('cs-CZ') + ' řádků — celý soubor si stáhni.'; }
        var cols = rows.reduce(function (n, r) { return Math.max(n, r.length); }, 0);
        var cellOf = function (tag, s) { return el(tag + (/^\s*[-+]?[\d\s]+([.,]\d+)?\s*$/.test(s || '') ? '.is-num' : ''), { title: s && s.length > 40 ? s : null }, s || ''); };
        var padded = function (r) { var out = r.slice(); while (out.length < cols) out.push(''); return out; };
        fill(host, [
          note ? el('p.fview__note', note) : null,
          el('div.fview__tablewrap', el('table.fview__table', [
            el('thead', el('tr', padded(rows[0] || []).map(function (s) { return el('th', s); }))),
            el('tbody', rows.slice(1).map(function (r) { return el('tr', padded(r).map(function (s) { return cellOf('td', s); })); }))
          ]))
        ]);
        return;
      }
      if (v.ext === 'json' && !cut) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* shown as it is */ } }
      fill(host, [
        note ? el('p.fview__note', note) : null,
        text.trim() ? el('pre.fview__text', text) : el('p.empty.fview__empty', 'Soubor je prázdný.')
      ]);
    })
    .catch(function () {
      if (viewing !== id) return;
      fill(host, isOnline()
        ? viewFail(f, 'Obsah se nepodařilo načíst.', 'Zkus soubor otevřít znovu, nebo si ho stáhni.', true)
        : viewFail(f, 'Jsi offline.', 'Soubor je na kaceybody — ukážu ho, až se spojení vrátí.'));
    });
}

/* ---- wiring ---------------------------------------------------------------------------- */

export function initStorage() {
  if (!$('stList')) return;
  try { var s = localStorage.getItem(SORT_KEY); if (s === 'name' || s === 'size') sort = s; } catch (e) { /* private mode */ }
  document.querySelectorAll('[data-st-sort]').forEach(function (b) {
    b.setAttribute('aria-pressed', String(b.getAttribute('data-st-sort') === sort));
    b.addEventListener('click', function () {
      sort = b.getAttribute('data-st-sort');
      try { localStorage.setItem(SORT_KEY, sort); } catch (e) { /* private mode */ }
      document.querySelectorAll('[data-st-sort]').forEach(function (o) { o.setAttribute('aria-pressed', String(o === b)); });
      render();
    });
  });
  $('stQuery').addEventListener('input', function () { find = $('stQuery').value; render(); });

  $('stUpload').addEventListener('click', function () { $('stFile').click(); });
  $('stFile').addEventListener('change', function () { addUploads($('stFile').files); $('stFile').value = ''; });

  $('stAll').addEventListener('click', function () {
    var want = fold(find.trim());
    var shown = files.filter(function (f) { return !want || fold(f.name).indexOf(want) !== -1; });
    var everything = shown.length && shown.every(function (f) { return picked[f.id]; });
    if (everything) picked = {}; else shown.forEach(function (f) { picked[f.id] = true; });
    disarm();
    render();
  });
  // The phone's "Vybrat vše" beside the box is part of it.
  document.querySelector('.stcols__all').addEventListener('click', function () { $('stAll').click(); });
  $('stSelDownload').addEventListener('click', function () { downloadMany(pickedFiles()); });
  $('stSelDelete').addEventListener('click', function () { if (armed === 'sel') remove(pickedFiles()); else arm('sel'); });
  $('stSelClear').addEventListener('click', clearPick);
  document.addEventListener('keydown', function (ev) {
    if (!$('stView').hidden) {
      // A player's own arrows seek; everywhere else they step through the files.
      var media = ev.target && /^(VIDEO|AUDIO)$/.test(ev.target.tagName);
      if (ev.key === 'Escape') { ev.stopPropagation(); closeView(); }
      else if (ev.key === 'ArrowLeft' && !media) stepView(-1);
      else if (ev.key === 'ArrowRight' && !media) stepView(1);
      return;
    }
    if (ev.key === 'Escape' && currentView() === 'storage' && pickedFiles().length) { ev.stopPropagation(); clearPick(); }
  }, true);

  // The náhled.
  $('stViewClose').addEventListener('click', closeView);
  $('stPrev').addEventListener('click', function () { stepView(-1); });
  $('stNext').addEventListener('click', function () { stepView(1); });
  $('stView').addEventListener('click', function (ev) { if (ev.target === $('stView')) closeView(); });
  $('stViewDelete').addEventListener('click', function () {
    var f = byId(viewing);
    if (!f) return;
    if (viewArmed) { closeView(); remove([f]); return; }
    viewArmed = true;
    clearTimeout(viewTimer);
    viewTimer = setTimeout(function () { viewArmed = false; paintViewDelete(); }, 4000);
    paintViewDelete();
  });

  // Files dragged anywhere over the list card.
  var card = $('stCard'), depth = 0;
  var dropOff = function () { depth = 0; $('stDrop').hidden = true; card.classList.remove('is-dropping'); };
  card.addEventListener('dragenter', function (ev) {
    if (!ev.dataTransfer || Array.prototype.indexOf.call(ev.dataTransfer.types, 'Files') < 0) return;
    ev.preventDefault(); depth++; $('stDrop').hidden = false; card.classList.add('is-dropping');
  });
  card.addEventListener('dragover', function (ev) { if (!$('stDrop').hidden) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; } });
  card.addEventListener('dragleave', function () { if (--depth <= 0) dropOff(); });
  card.addEventListener('drop', function (ev) { ev.preventDefault(); dropOff(); addUploads(ev.dataTransfer.files); });

  // Leaving mid-upload would lose it: the browser asks first.
  window.addEventListener('beforeunload', function (ev) { if (uploading) { ev.preventDefault(); ev.returnValue = ''; } });

  bus.on('storage', onFrame);
  var away = false;
  bus.on('conn', function (st) {
    if (st === 'offline') away = true;
    else if (st === 'online' && (away || failed)) { away = false; load(); }
  });
  onEnter('storage', load);
  // The counts in the sidebar and in Víc, before anyone opens the screen.
  if (currentView() !== 'storage') load();
}
