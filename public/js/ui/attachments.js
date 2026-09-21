/* =========================================================================
   ATTACHMENTS.

   Images on the way to Kacey. Three ways in, because each one is the obvious
   one to somebody: paste (Ctrl+V, which is how a screenshot arrives), the
   paperclip, and drag-and-drop onto the composer.

   Held as base64 here rather than as File objects: that is what goes on the
   wire, and converting at send time would make the send path async for no
   reason. The cost is holding a few MB in memory, which is the same few MB the
   browser is already holding for the preview.

   Large screenshots are downscaled before they are sent. A 4K screenshot of a
   calendar is several megabytes of mostly-flat colour, and the model reads a
   1568px-wide one just as well — that width is where the API stops gaining
   detail, so anything above it is paid for and thrown away.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { el, fill } from '../core/el.js';
import { say } from './toast.js';

var TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
var MAX = 4;
var MAX_BYTES = 5 * 1024 * 1024;
var MAX_EDGE = 1568;          // the widest the model gains anything from

var items = [];               // { id, name, media_type, data, url }
var onChange = function () {};

export function attachments() {
  return items.map(function (i) { return { media_type: i.media_type, data: i.data }; });
}

export function hasAttachments() { return items.length > 0; }

export function clearAttachments() {
  items.forEach(function (i) { URL.revokeObjectURL(i.url); });
  items = [];
  render();
  onChange();
}

/* ---- reading a file ----------------------------------------------------- */

function readAsDataURL(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(reader.result); };
    reader.onerror = function () { reject(new Error('nelze přečíst soubor')); };
    reader.readAsDataURL(file);
  });
}

/* Downscale through a canvas, but only when it is actually too big. A GIF is
   left alone — drawing one to a canvas throws away the animation, and the
   first frame is not what the user attached. */
function shrink(dataUrl, mediaType) {
  if (mediaType === 'image/gif') return Promise.resolve({ dataUrl: dataUrl, type: mediaType });

  return new Promise(function (resolve) {
    var img = new Image();
    img.onload = function () {
      var scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
      if (scale === 1 && dataUrl.length * 3 / 4 <= MAX_BYTES) {
        resolve({ dataUrl: dataUrl, type: mediaType });
        return;
      }
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      // PNG for screenshots: a re-encoded JPEG of small text is mush, and text
      // is the whole point of a screenshot of a calendar.
      resolve({ dataUrl: canvas.toDataURL('image/png'), type: 'image/png' });
    };
    img.onerror = function () { resolve({ dataUrl: dataUrl, type: mediaType }); };
    img.src = dataUrl;
  });
}

export async function addFiles(files) {
  var list = Array.prototype.slice.call(files || []);
  if (!list.length) return;

  for (var i = 0; i < list.length; i++) {
    var file = list[i];

    if (TYPES.indexOf(file.type) === -1) {
      say('Zatím umím jen obrázky (PNG, JPEG, WebP, GIF) — „' + file.name + '“ ne.');
      continue;
    }
    if (items.length >= MAX) {
      say('Najednou jde poslat nejvýš ' + MAX + ' obrázky.');
      break;
    }

    try {
      var raw = await readAsDataURL(file);
      var small = await shrink(raw, file.type);
      var data = small.dataUrl.split(',')[1] || '';

      if (data.length * 3 / 4 > MAX_BYTES) {
        say('„' + file.name + '“ je i po zmenšení moc velký.');
        continue;
      }

      items.push({
        id: 'a' + Date.now() + '-' + i,
        name: file.name || 'obrázek',
        media_type: small.type,
        data: data,
        url: URL.createObjectURL(file)
      });
    } catch (err) {
      say('Přílohu nelze načíst: ' + err.message);
    }
  }

  render();
  onChange();
}

function remove(id) {
  var gone = items.filter(function (i) { return i.id === id; })[0];
  if (gone) URL.revokeObjectURL(gone.url);
  items = items.filter(function (i) { return i.id !== id; });
  render();
  onChange();
}

/* ---- the strip above the composer --------------------------------------- */

function render() {
  var host = $('attachStrip');
  if (!host) return;
  host.hidden = items.length === 0;
  fill(host, items.map(function (item) {
    return el('span.attach', [
      el('img.attach__thumb', { src: item.url, alt: item.name }),
      el('span.attach__name', item.name),
      el('button.attach__x', {
        type: 'button', 'aria-label': 'Odebrat přílohu ' + item.name,
        onclick: function () { remove(item.id); }
      }, '×')
    ]);
  }));
}

/* ---- wiring ------------------------------------------------------------- */

export function initAttachments(notify) {
  onChange = typeof notify === 'function' ? notify : function () {};

  var picker = $('attachInput');
  var button = $('attachBtn');
  var composer = $('composer');
  if (!picker || !button || !composer) return;

  button.addEventListener('click', function () { picker.click(); });
  picker.addEventListener('change', function () {
    addFiles(picker.value ? picker.files : []);
    picker.value = '';            // same file twice in a row must still fire
  });

  /* Paste anywhere that is not a text box: a screenshot goes to the clipboard
     and the obvious next move is Ctrl+V on the page, not in a particular
     field. Pasting INTO the journal textarea still means text, so that is
     left alone. */
  document.addEventListener('paste', function (ev) {
    var target = ev.target;
    if (target && target.tagName === 'TEXTAREA') return;
    var files = ev.clipboardData && ev.clipboardData.files;
    if (!files || !files.length) return;
    ev.preventDefault();
    addFiles(files);
  });

  ['dragenter', 'dragover'].forEach(function (name) {
    composer.addEventListener(name, function (ev) {
      if (!ev.dataTransfer || ev.dataTransfer.types.indexOf('Files') === -1) return;
      ev.preventDefault();
      composer.classList.add('is-dropping');
    });
  });
  ['dragleave', 'drop'].forEach(function (name) {
    composer.addEventListener(name, function () { composer.classList.remove('is-dropping'); });
  });
  composer.addEventListener('drop', function (ev) {
    if (!ev.dataTransfer || !ev.dataTransfer.files.length) return;
    ev.preventDefault();
    addFiles(ev.dataTransfer.files);
  });

  render();
}
