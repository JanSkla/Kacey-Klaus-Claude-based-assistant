/* =========================================================================
   THE GALLERY.

   Photos kept on kaceybody (gallery.js on the server): taken here, uploaded,
   dropped onto the grid, or saved from the chat ("ulož mi tuto fotku"). Kacey
   writes each one's title, caption and tags — the owner never edits them —
   and the search ranks by meaning, so "hory v zimě" finds the snowy ridge
   whose caption never said "zima".

   The grid fills in as it happens: a photo on its way up is a local preview
   ("Nahrávám…"), then the server's row ("Popisuji…"), then the described
   photo, each step a `gallery` frame from the server (protocol.js → bus).

   The same frames draw the gallery's part of the chat: a saved photo as a
   card under Kacey's words, a search as a strip of thumbnails.
   ========================================================================= */

import { $ } from '../core/dom.js';
import * as dom from '../core/dom.js';
import { el, fill } from '../core/el.js';
import * as bus from '../core/bus.js';
import { go, onEnter, currentView } from '../ui/router.js';
import { say } from '../ui/toast.js';
import { addFiles } from '../ui/attachments.js';

var TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
var THUMB_EDGE = 480;          // the grid's copy
var MODEL_EDGE = 1568;         // what the model reads; wider gains nothing
var MAX_BYTES = 25 * 1024 * 1024;

var photos = [];               // what the server last listed (plus local uploads on top)
var uploads = [];              // { key, file, url, name, state: 'uploading' | 'error', error, offline }
var tags = [];
var total = 0, describing = 0, index = null;
var query = '', tag = '';
var openId = null;             // the photo in the sheet
var armedDelete = false;
var loadSeq = 0, queryTimer = 0;
var loaded = false, stale = false;   // a list has come at least once; the last load failed

/* ---- words ------------------------------------------------------------------- */

function plural(n, one, few, many) { return n === 1 ? one : n >= 2 && n <= 4 ? few : many; }
function fotek(n) { return n + ' ' + plural(n, 'fotka', 'fotky', 'fotek'); }

function dayLabel(iso, withTime) {
  var d = new Date(iso);
  if (isNaN(d)) return '';
  var now = new Date();
  var clock = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  var y = new Date(now); y.setDate(now.getDate() - 1);
  var day = d.toDateString() === now.toDateString() ? 'dnes'
    : d.toDateString() === y.toDateString() ? 'včera'
    : d.getDate() + '. ' + (d.getMonth() + 1) + '.' + (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '');
  return withTime ? day + ' · ' + clock : day;
}

function sizeLabel(bytes) {
  if (!bytes) return '';
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' kB';
}

/* Cosine scores mean nothing as percentages; five bars against the best hit do. */
function strength(score, best) {
  if (score == null || !best) return 0;
  return Math.max(1, Math.min(5, Math.round(score / best * 5)));
}

/* ---- loading ------------------------------------------------------------------ */

function load() {
  var seq = ++loadSeq;
  var qs = new URLSearchParams();
  if (query.trim()) qs.set('q', query.trim());
  if (tag) qs.set('tag', tag);
  return fetch('/api/gallery?' + qs.toString(), { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (seq !== loadSeq) return;
      if (!j.ok) throw new Error(j.error || 'chyba');
      loaded = true; stale = false;
      photos = j.photos || [];
      tags = j.tags || [];
      total = j.total || 0;
      describing = j.describing || 0;
      index = j.index || null;
      render();
    })
    .catch(function () {
      if (seq !== loadSeq) return;
      stale = true;
      var off = navigator.onLine === false;
      // What was loaded before stays on screen; only an empty grid says it failed.
      if (loaded) {
        $('galHint').hidden = false;
        $('galHint').textContent = off ? 'Jsi offline — ukazuju, co jsem načetla naposledy.' : 'Server kaceybody neodpovídá — ukazuju, co jsem načetla naposledy.';
        return;
      }
      $('galGrid').classList.add('is-empty');
      fill($('galGrid'), el('div.galempty', [
        el('span.galempty__mark.galempty__mark--err', { 'aria-hidden': 'true' }),
        el('h3', off ? 'Jsi offline.' : 'Galerii se nepodařilo načíst.'),
        el('p', off ? 'Fotky jsou na kaceybody. Načtu je, až se připojíš.' : 'Server kaceybody neodpovídá. Zkusím to znovu, až se připojí.'),
        el('button.btn', { type: 'button', onclick: load }, 'Zkusit znovu')
      ]));
    });
}

/* Back online, or the socket is up again: what failed is loaded and sent again. */
function reconnected() {
  if (stale) load();
  uploads.filter(function (u) { return u.state === 'error' && u.offline; }).forEach(function (u) { uploadOne(u.file, u); });
}

/* ---- the grid ------------------------------------------------------------------- */

function tile(p, best) {
  var state = p.status === 'describing' ? '.is-describing' : p.status === 'failed' ? '.is-failed' : '';
  var bars = query.trim() && p.score != null ? strength(p.score, best) : 0;
  return el('button.gtile' + state, {
    type: 'button', 'data-id': p.id,
    'aria-label': (p.title || 'Fotka') + (p.status === 'describing' ? ', popisuji' : ''),
    onclick: function () { openPhoto(p.id); }
  }, [
    el('span.gtile__frame', [
      el('img.gtile__img', { src: p.thumb_url, alt: '', loading: 'lazy', decoding: 'async' }),
      p.status === 'describing' ? el('span.gtile__badge', [el('span.gtile__dot', { 'aria-hidden': 'true' }), 'Popisuji…']) : null,
      p.status === 'failed' ? el('span.gtile__badge.gtile__badge--err', 'Bez popisu') : null,
      p.source === 'chat' && p.status === 'ready' ? el('span.gtile__from', { title: 'Uloženo z chatu' }, 'z chatu') : null
    ]),
    el('span.gtile__title', p.status === 'ready' ? p.title : p.status === 'failed' ? 'Popis se nepovedl' : 'Kacey píše popis…'),
    el('span.gtile__meta', [
      el('span', dayLabel(p.taken_at || p.created_at)),
      p.status === 'ready' && p.tags.length ? el('span.gtile__tags', ' · ' + p.tags.slice(0, 2).join(', ')) : null,
      bars ? el('span.confbar.gtile__match', { title: 'Shoda s hledáním', 'aria-label': 'Shoda ' + bars + ' z 5' },
        [1, 2, 3, 4, 5].map(function (i) { return el('span.confbar__bar' + (i <= bars ? '.is-on' : '')); })) : null
    ])
  ]);
}

function uploadTile(u) {
  return el('div.gtile.is-uploading' + (u.state === 'error' ? '.is-failed' : ''), [
    el('span.gtile__frame', [
      el('img.gtile__img', { src: u.url, alt: '' }),
      el('span.gtile__badge' + (u.state === 'error' ? '.gtile__badge--err' : ''),
        u.state === 'error' ? 'Neuloženo' : [el('span.gtile__dot', { 'aria-hidden': 'true' }), 'Nahrávám…'])
    ]),
    el('span.gtile__title', u.state === 'error' ? u.error : u.name),
    el('span.gtile__meta', u.state === 'error'
      ? [u.retryable ? el('button.link', { type: 'button', onclick: function () { uploadOne(u.file, u); } }, 'Zkusit znovu') : null,
         u.retryable ? el('span', ' · ') : null,
         el('button.link.link--muted', { type: 'button', onclick: function () { dropUpload(u.key); } }, 'Zahodit')]
      : 'ukládám na kaceybody')
  ]);
}

function renderTags() {
  var shown = tags.slice(0, 10);
  // A tag picked from a photo that is not among the commonest still shows.
  if (tag && !shown.some(function (t) { return t.name === tag; })) shown.unshift({ name: tag, count: 0 });
  fill($('galTags'), tags.length ? [el('button.chip.chip--filter', {
    type: 'button', 'aria-pressed': String(!tag), onclick: function () { setTag(''); }
  }, 'Vše')].concat(shown.map(function (t) {
    return el('button.chip.chip--filter', {
      type: 'button', 'aria-pressed': String(tag === t.name), onclick: function () { setTag(tag === t.name ? '' : t.name); }
    }, [t.name, t.count ? el('span.chip__count', ' ' + t.count) : null]);
  })) : null);
  $('galTags').hidden = !tags.length;
}

function hintText() {
  var q = query.trim();
  var n = photos.length;
  if (q && tag) return n ? fotek(n) + ' k „' + q + '“ se štítkem ' + tag + ' · podle podobnosti' : '';
  if (q) return n ? fotek(n) + ' k „' + q + '“ · nejpodobnější první' : '';
  if (tag) return 'Štítek ' + tag + ' · ' + fotek(n);
  return total ? 'Nejnovější první' : '';
}

function render() {
  var grid = $('galGrid');
  if (!grid) return;
  renderTags();
  paintCounts();

  var q = query.trim();
  $('galClear').hidden = !q && !tag;
  $('galHint').textContent = hintText();
  $('galHint').hidden = !hintText();

  var best = photos.reduce(function (m, p) { return Math.max(m, p.score || 0); }, 0);
  var tiles = (q || tag ? [] : uploads.map(uploadTile)).concat(photos.map(function (p) { return tile(p, best); }));

  if (tiles.length) { fill(grid, tiles); grid.classList.remove('is-empty'); return; }
  grid.classList.add('is-empty');

  if (!total && !uploads.length) {
    fill(grid, el('div.galempty', [
      el('span.galempty__mark', { 'aria-hidden': 'true' }),
      el('h3', 'Galerie je zatím prázdná.'),
      el('p', 'Vyfoť něco, nahraj fotky, nebo pošli fotku do chatu a řekni „ulož mi tuto fotku“. Popis a štítky napíšu sama.'),
      el('div.row.center', [
        el('button.btn.btn--accent', { type: 'button', onclick: shoot }, 'Vyfotit'),
        el('button.btn', { type: 'button', onclick: function () { $('galFile').click(); } }, 'Nahrát fotky')
      ])
    ]));
    return;
  }
  fill(grid, el('div.galempty', [
    el('h3', 'Nic podobného jsem nenašla.'),
    el('p', q ? 'Zkus to popsat jinak — třeba co na fotce je, kde nebo kdy to bylo.' : 'S tímhle štítkem tu nic není.'),
    el('button.btn.btn--accent', { type: 'button', onclick: clearSearch }, 'Zrušit hledání')
  ]));
}

function paintCounts() {
  $('galCount').textContent = total ? fotek(total) : '';
  $('galStatCount').textContent = fotek(total);
  $('galStatMeta').textContent = total
    ? tags.length + ' ' + plural(tags.length, 'štítek', 'štítky', 'štítků')
      + (describing ? ' · ' + describing + ' se ' + plural(describing, 'popisuje', 'popisují', 'popisuje') : '')
    : 'Zatím žádná fotka.';
  $('galStatIndex').textContent = index
    ? 'Hledám podle významu — vektorový index na kaceybody, ' + index.vectors + ' ' + plural(index.vectors, 'vektor', 'vektory', 'vektorů') + '.'
    : 'Hledám podle významu, ne jen podle slov.';
  var badge = $('navBadgeGallery');
  if (badge) badge.textContent = total ? String(total) : '';
  var more = $('moreGalleryMeta');
  if (more) more.textContent = total ? fotek(total) : '';
}

/* ---- search --------------------------------------------------------------------- */

function setTag(t) { tag = t; load(); }

function clearSearch() {
  query = ''; tag = '';
  $('galQuery').value = '';
  load();
}

/** Open the gallery on a search — from the chat's "Ukázat v galerii". */
export function showSearch(q, t) {
  query = q || ''; tag = t || '';
  $('galQuery').value = query;
  go('gallery');
}

/* ---- uploading -------------------------------------------------------------------- */

function readAsDataURL(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(reader.result); };
    reader.onerror = function () { reject(new Error('soubor nejde přečíst')); };
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.onload = function () { resolve(img); };
    img.onerror = function () { reject(new Error('tohle není obrázek, který umím otevřít')); };
    img.src = src;
  });
}

function scaled(img, edge, quality) {
  var s = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight));
  var c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s);
  c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return { media_type: 'image/jpeg', data: c.toDataURL('image/jpeg', quality).split(',')[1] || '' };
}

function dropUpload(key) {
  var u = uploads.filter(function (x) { return x.key === key; })[0];
  if (u) URL.revokeObjectURL(u.url);
  uploads = uploads.filter(function (x) { return x.key !== key; });
  render();
}

/* Resolves true when the photo is on the server. `again` is a failed upload
   tried once more ("Zkusit znovu", or by itself when the connection is back). */
async function uploadOne(file, again) {
  var u = again || { key: 'u' + Date.now() + Math.random().toString(36).slice(2, 6), file: file, url: URL.createObjectURL(file), name: file.name || 'fotka' };
  u.state = 'uploading'; u.error = ''; u.offline = false; u.retryable = false;
  if (!again) uploads.unshift(u);
  // Uploads show at the top of the unfiltered grid; a search would hide them.
  if (query.trim() || tag) { query = ''; tag = ''; $('galQuery').value = ''; load(); } else render();

  try {
    if (file.size > MAX_BYTES) throw new Error('moc velká (limit 25 MB)');
    if (navigator.onLine === false) { u.offline = true; throw new Error('jsi offline. Uložím ji, až se připojíš'); }
    var dataUrl = await readAsDataURL(file);
    var img = await loadImage(dataUrl);
    var big = Math.max(img.naturalWidth, img.naturalHeight) > MODEL_EDGE || file.size > 4.5 * 1048576 || file.type === 'image/gif';
    var body = {
      image: { media_type: file.type, data: dataUrl.split(',')[1] || '' },
      thumb: scaled(img, THUMB_EDGE, 0.82),
      small: big ? scaled(img, MODEL_EDGE, 0.86) : null,
      name: file.name || '', width: img.naturalWidth, height: img.naturalHeight,
      taken_at: file.lastModified ? new Date(file.lastModified).toISOString() : undefined
    };
    var r;
    try {
      r = await fetch('/api/gallery', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      u.offline = true;
      throw new Error(navigator.onLine === false ? 'jsi offline. Uložím ji, až se připojíš' : 'server kaceybody neodpovídá');
    }
    var j = await r.json().catch(function () { return {}; });
    if (r.status === 413) throw new Error('moc velká pro server');
    if (!r.ok || !j.ok) { u.retryable = r.status >= 500; throw new Error(j.error || 'server fotku nepřijal'); }
    upsert(j.photo);
    dropUpload(u.key);
    return true;
  } catch (err) {
    u.state = 'error';
    if (u.offline) u.retryable = true;
    u.error = 'Neuloženo — ' + String(err.message || err).replace(/^\w/, function (c) { return c.toLowerCase(); });
    render();
    return false;
  }
}

async function uploadFiles(list) {
  var files = Array.prototype.slice.call(list || []);
  var ok = files.filter(function (f) { return TYPES.indexOf(f.type) !== -1; });
  if (ok.length < files.length) say('Uložím jen fotky (JPEG, PNG, WebP, GIF) — ' + (files.length - ok.length) + ' ' + plural(files.length - ok.length, 'soubor', 'soubory', 'souborů') + ' jsem vynechala.');
  if (!ok.length) return;
  go('gallery');
  var saved = 0;
  for (var i = 0; i < ok.length; i++) if (await uploadOne(ok[i])) saved++;
  if (!saved) return;   // each failed tile says why
  if (saved < ok.length) say(fotek(saved) + ' na kaceybody, ' + (ok.length - saved) + ' se nepovedlo — u nich je proč.');
  else say(saved === 1 ? 'Fotka je na kaceybody. Popis a štítky dopíšu za chvilku.' : fotek(saved) + ' na kaceybody. Popisy dopíšu za chvilku.');
}

/* The server's row for a photo replaces whatever the grid had for it. */
function upsert(p) {
  if (!p || !p.id) return;
  var at = -1;
  photos.forEach(function (x, i) { if (x.id === p.id) at = i; });
  if (at >= 0) photos[at] = Object.assign({}, photos[at], p);
  else if (!query.trim() && !tag) { photos.unshift(p); total++; }
  describing = photos.filter(function (x) { return x.status === 'describing'; }).length;
  render();
  if (openId === p.id) paintSheet();
}

/* ---- the camera ------------------------------------------------------------------- */

var stream = null;

/* A phone has a better camera app than anything drawn here: hand it over.
   A computer gets its webcam in a sheet. */
function shoot() {
  var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (coarse || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('galFileCamera').click(); return; }
  openCamera();
}

function camState(text) { $('galCamState').textContent = text; }

function openCamera() {
  var sheet = $('galCamera');
  sheet.hidden = false;
  showShot(false);
  camState('kamera se zapíná…');
  $('galCamTake').disabled = true;
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 } }, audio: false })
    .then(function (s) {
      if (sheet.hidden) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
      stream = s;
      $('galCamVideo').srcObject = s;
      camState('fotka se uloží na kaceybody');
      $('galCamTake').disabled = false;
    })
    .catch(function () {
      camState('kamera není dostupná — vyber fotku ze souboru');
    });
}

function showShot(shot) {
  $('galCamVideo').hidden = shot;
  $('galCamShot').hidden = !shot;
  $('galCamTake').hidden = shot;
  $('galCamAgain').hidden = !shot;
  $('galCamSave').hidden = !shot;
}

function takeShot() {
  var v = $('galCamVideo'), c = $('galCamShot');
  if (!v.videoWidth) return;
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  showShot(true);
  camState('takhle?');
}

function saveShot() {
  $('galCamShot').toBlob(function (blob) {
    if (!blob) return;
    var stamp = new Date();
    var name = 'kamera-' + stamp.toISOString().slice(0, 16).replace('T', '-').replace(':', '') + '.jpg';
    closeCamera();
    uploadFiles([new File([blob], name, { type: 'image/jpeg', lastModified: stamp.getTime() })]);
  }, 'image/jpeg', 0.9);
}

function closeCamera() {
  if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
  $('galCamVideo').srcObject = null;
  $('galCamera').hidden = true;
}

/* ---- one photo ------------------------------------------------------------------------ */

function byId(id) { return photos.filter(function (p) { return p.id === id; })[0]; }

function openPhoto(id) {
  openId = id;
  armedDelete = false;
  paintSheet();
  $('galSheet').hidden = false;
  $('galViewClose').focus();
}

function closePhoto() {
  $('galSheet').hidden = true;
  openId = null;
}

function step(d) {
  var i = photos.findIndex(function (p) { return p.id === openId; });
  if (i < 0) return;
  var next = photos[(i + d + photos.length) % photos.length];
  if (next) openPhoto(next.id);
}

function paintSheet() {
  var p = byId(openId);
  if (!p) { closePhoto(); return; }
  var i = photos.indexOf(p);
  $('galViewPos').textContent = photos.length > 1 ? '· ' + (i + 1) + ' / ' + photos.length : '';
  $('galPrev').disabled = $('galNext').disabled = photos.length < 2;
  $('galViewImg').src = p.url;
  $('galViewImg').alt = p.caption || p.title || 'Fotka';
  $('galViewWhen').textContent = (dayLabel(p.taken_at || p.created_at, true) + ' · ' + (p.source === 'chat' ? 'uloženo z chatu' : 'nahráno v galerii')).toUpperCase();

  var state = $('galViewState');
  if (p.status === 'ready') {
    state.hidden = true;
    $('galViewTitle').textContent = p.title;
    $('galViewCaption').textContent = p.caption;
  } else {
    state.hidden = false;
    $('galViewTitle').textContent = p.status === 'failed' ? 'Bez popisu' : 'Kacey píše popis…';
    $('galViewCaption').textContent = '';
    fill(state, p.status === 'failed'
      ? [el('p', 'Popis se nepovedl' + (p.error ? ' (' + p.error + ')' : '') + '. Fotka je uložená, jen ji zatím nenajdeš hledáním.'),
         el('button.btn.btn--sm.btn--outlineaccent', { type: 'button', onclick: function () { retry(p.id); } }, 'Zkusit popsat znovu')]
      : [el('span.gtile__dot', { 'aria-hidden': 'true' }), el('p', 'Dívám se na fotku a píšu popis se štítky. Pak ji půjde najít.')]);
    state.classList.toggle('is-err', p.status === 'failed');
  }

  fill($('galViewTags'), p.tags.length ? p.tags.map(function (t) {
    return el('button.chip.chip--filter', { type: 'button', title: 'Ukázat fotky se štítkem ' + t, onclick: function () { closePhoto(); query = ''; $('galQuery').value = ''; setTag(t); } }, t);
  }) : el('span.muted-3', p.status === 'ready' ? 'žádné' : '—'));

  $('galViewFile').textContent = [p.name || '', p.width && p.height ? p.width + ' × ' + p.height : '', sizeLabel(p.bytes)].filter(Boolean).join(' · ') || '—';
  $('galDownload').href = p.url;
  $('galDownload').setAttribute('download', p.name || (p.id + '.' + (p.url.split('.').pop() || 'jpg')));
  paintDelete();
}

function paintDelete() {
  var b = $('galDelete');
  b.className = 'btn push ' + (armedDelete ? 'btn--dangerfill' : 'btn--dangerghost');
  b.textContent = armedDelete ? 'Opravdu smazat?' : 'Smazat';
}

function deletePhoto() {
  if (!armedDelete) {
    armedDelete = true;
    paintDelete();
    var id = openId;
    setTimeout(function () { if (openId === id && armedDelete) { armedDelete = false; paintDelete(); } }, 4000);
    return;
  }
  var p = byId(openId);
  if (!p) return;
  if (navigator.onLine === false) { say('Jsi offline — smazat půjde, až se připojíš.'); return; }
  fetch('/api/gallery/' + encodeURIComponent(p.id), { method: 'DELETE' })
    // 404: already gone (deleted on another device) — the same outcome.
    .then(function (r) { if (!r.ok && r.status !== 404) throw new Error(); })
    .then(function () {
      closePhoto();
      removeLocal(p.id);
      say('Fotka smazána · ' + (p.title || 'bez popisu'));
    })
    .catch(function () { armedDelete = false; paintDelete(); say('Smazat se nepovedlo — server kaceybody neodpověděl.'); });
}

function removeLocal(id) {
  var before = photos.length;
  photos = photos.filter(function (x) { return x.id !== id; });
  if (photos.length < before) total = Math.max(0, total - 1);
  render();
}

function retry(id) {
  if (navigator.onLine === false) { say('Jsi offline — popis zkusím znovu, až se připojíš.'); return; }
  fetch('/api/gallery/' + encodeURIComponent(id) + '/retry', { method: 'POST' })
    .then(function (r) { return r.json(); })
    .then(function (j) { if (j.ok) upsert(j.photo); else say(j.error || 'Popsat znovu nejde.'); })
    .catch(function () { say('Server kaceybody neodpověděl — zkus to za chvíli.'); });
}

/* Into the composer with the photo attached: the question is the owner's. */
function askAbout() {
  var p = byId(openId);
  if (!p) return;
  fetch(p.url).then(function (r) { return r.blob(); }).then(function (blob) {
    var file = new File([blob], p.name || 'fotka.jpg', { type: blob.type || p.media_type });
    closePhoto();
    return addFiles([file]).then(function () {
      go('main');
      dom.input.focus();
      say('Fotka je v chatu — zeptej se, na co chceš.');
    });
  }).catch(function () { say('Fotku se nepodařilo načíst.'); });
}

/* ---- the gallery in the chat ------------------------------------------------------------ */

function chatRow(children) {
  dom.log.appendChild(el('li.msg.msg--assistant.msg--notice.msg--gallery', [el('p.msg__who', 'Kacey'), children]));
  dom.logwrap.scrollTop = dom.logwrap.scrollHeight;
}

function openFromChat(p) {
  go('gallery');
  if (!byId(p.id)) photos.unshift(p);
  openPhoto(p.id);
}

function chatSaved(p) {
  chatRow(el('div.gchat', [
    el('button.gchat__thumb', { type: 'button', 'aria-label': 'Otevřít fotku', onclick: function () { openFromChat(p); } },
      el('img', { src: p.thumb_url, alt: '' })),
    el('div.gchat__body', [
      el('p.gchat__kicker', 'ULOŽENO DO GALERIE'),
      el('p.gchat__title', p.title),
      el('p.gchat__caption', p.caption),
      el('div.chips', p.tags.slice(0, 6).map(function (t) { return el('span.chip', t); })),
      el('button.btn.btn--sm.btn--outlineaccent.msg__act', { type: 'button', onclick: function () { openFromChat(p); } }, 'Otevřít v galerii')
    ])
  ]));
}

function chatHits(msg) {
  var list = (msg.photos || []).slice(0, 6);
  if (!list.length) return;
  var q = msg.query || '';
  chatRow(el('div.gchat.gchat--hits', [
    el('p.gchat__kicker', ('V galerii · ' + fotek(list.length) + (q ? ' k „' + q + '“' : '')).toUpperCase()),
    el('div.gchat__strip', list.map(function (p) {
      return el('button.gchat__hit', { type: 'button', title: p.title, onclick: function () { openFromChat(p); } }, [
        el('img', { src: p.thumb_url, alt: p.title, loading: 'lazy' }),
        el('span', p.title)
      ]);
    })),
    el('button.link', { type: 'button', onclick: function () { showSearch(q, msg.tag || ''); } }, 'Ukázat hledání v galerii →')
  ]));
}

function onFrame(msg) {
  if (msg.event === 'saved_chat' && msg.photo) chatSaved(msg.photo);
  else if (msg.event === 'hits') chatHits(msg);
  else if (msg.photo) {
    if (msg.event === 'removed' && openId === msg.photo.id) closePhoto();
    // A search is ranked by the server; a change cannot be slotted in here.
    if (query.trim() || tag) { clearTimeout(queryTimer); queryTimer = setTimeout(load, 400); return; }
    if (msg.event === 'removed') removeLocal(msg.photo.id);
    else upsert(msg.photo);
  }
}

/* ---- wiring ------------------------------------------------------------------------------ */

export function initGallery() {
  if (!$('galGrid')) return;

  $('galQuery').addEventListener('input', function () {
    query = $('galQuery').value;
    clearTimeout(queryTimer);
    queryTimer = setTimeout(load, 220);
  });
  $('galSearchForm').addEventListener('submit', function (ev) { ev.preventDefault(); clearTimeout(queryTimer); load(); $('galQuery').blur(); });
  $('galClear').addEventListener('click', clearSearch);

  $('galShoot').addEventListener('click', shoot);
  $('galUpload').addEventListener('click', function () { $('galFile').click(); });
  ['galFile', 'galFileCamera'].forEach(function (id) {
    $(id).addEventListener('change', function () { var f = $(id).files; uploadFiles(f).finally(function () { $(id).value = ''; }); });
  });

  // Drag and drop onto the gallery card.
  var card = $('galCard'), depth = 0;
  card.addEventListener('dragenter', function (ev) {
    if (!ev.dataTransfer || Array.prototype.indexOf.call(ev.dataTransfer.types, 'Files') < 0) return;
    ev.preventDefault(); depth++; $('galDrop').hidden = false; card.classList.add('is-dropping');
  });
  card.addEventListener('dragover', function (ev) { if (!$('galDrop').hidden) ev.preventDefault(); });
  card.addEventListener('dragleave', function () { if (--depth <= 0) { depth = 0; $('galDrop').hidden = true; card.classList.remove('is-dropping'); } });
  card.addEventListener('drop', function (ev) {
    ev.preventDefault(); depth = 0; $('galDrop').hidden = true; card.classList.remove('is-dropping');
    uploadFiles(ev.dataTransfer.files);
  });

  // The photo sheet.
  $('galViewClose').addEventListener('click', closePhoto);
  $('galPrev').addEventListener('click', function () { step(-1); });
  $('galNext').addEventListener('click', function () { step(1); });
  $('galDelete').addEventListener('click', deletePhoto);
  $('galAsk').addEventListener('click', askAbout);
  $('galSheet').addEventListener('click', function (ev) { if (ev.target === $('galSheet')) closePhoto(); });

  // The camera sheet.
  $('galCamClose').addEventListener('click', closeCamera);
  $('galCamTake').addEventListener('click', takeShot);
  $('galCamAgain').addEventListener('click', function () { showShot(false); camState('fotka se uloží na kaceybody'); });
  $('galCamSave').addEventListener('click', saveShot);
  $('galCamFile').addEventListener('click', function () { closeCamera(); $('galFile').click(); });
  $('galCamera').addEventListener('click', function (ev) { if (ev.target === $('galCamera')) closeCamera(); });

  document.addEventListener('keydown', function (ev) {
    if (!$('galCamera').hidden && ev.key === 'Escape') { ev.stopPropagation(); closeCamera(); return; }
    if ($('galSheet').hidden) return;
    if (ev.key === 'Escape') { ev.stopPropagation(); closePhoto(); }
    else if (ev.key === 'ArrowLeft') step(-1);
    else if (ev.key === 'ArrowRight') step(1);
  }, true);

  bus.on('gallery', onFrame);
  window.addEventListener('online', reconnected);
  onEnter('gallery', load);
  // The counts in the sidebar and in Víc, before anyone opens the gallery.
  if (currentView() !== 'gallery') load();
}
