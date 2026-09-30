/* =========================================================================
   SHARED FROM THE PHONE.

   A screenshot (an event poster, a ticket) shared to Kacey from another app
   lands in the composer: the image attached, any shared text in the field,
   the cursor ready for an optional note. Nothing is sent by itself — the
   owner may want to say what to do with it, and a note is optional, not
   skipped.

   Two ways in, one landing:
     - The installed web app is a share target (manifest.webmanifest). The
       share arrives as a POST that sw.js catches, parks in the Cache API and
       answers with a redirect to /?share=1. This picks it up from there.
     - The Android app (android/) holds the share itself and exposes it
       through window.KaceyNative. It fires `kacey-share` on the window when
       one arrives while the page is already open.
   ========================================================================= */

import * as dom from '../core/dom.js';
import { go } from './router.js';
import { addFiles } from './attachments.js';
import { say } from './toast.js';

var CACHE = 'kacey-share';

function base64ToFile(item, i) {
  var bin = atob(item.data || '');
  var bytes = new Uint8Array(bin.length);
  for (var k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  return new File([bytes], item.name || ('sdileny-' + (i + 1) + '.png'), { type: item.media_type || 'image/png' });
}

/* Into the chat: attach, prefill, focus. A shared link comes as text; a page
   title with it is dropped when the link already says enough. */
async function land(text, files) {
  go('main');
  if (files.length) await addFiles(files);
  text = String(text || '').trim();
  if (text) {
    dom.input.value = dom.input.value ? dom.input.value + ' ' + text : text;
    dom.input.classList.remove('is-interim');
  }
  if (!files.length && !text) { say('Sdílení nic nepřineslo.'); return; }
  try { dom.input.focus(); } catch (e) { /* not focusable yet */ }
}

/* ---- the web app's share target (sw.js parked it) ----------------------- */

async function fromServiceWorker() {
  if (!/(?:^|[?&])share=1(?:&|$)/.test(location.search)) return;
  // Drop the flag at once, so a reload does not attach the same image twice.
  history.replaceState(null, '', location.pathname + location.hash);
  if (!('caches' in window)) return;
  try {
    var cache = await caches.open(CACHE);
    var meta = await cache.match('/share/meta');
    if (!meta) return;
    var info = await meta.json();
    var files = [];
    for (var i = 0; i < (info.files || []).length; i++) {
      var res = await cache.match('/share/file/' + i);
      if (!res) continue;
      var blob = await res.blob();
      files.push(new File([blob], info.files[i].name || ('sdileny-' + (i + 1)), { type: info.files[i].type || blob.type }));
    }
    await caches.delete(CACHE);
    await land([info.title, info.text, info.url].filter(Boolean).join(' '), files);
  } catch (err) {
    say('Sdílený obrázek nejde načíst: ' + err.message);
  }
}

/* ---- the Android app ----------------------------------------------------- */

async function fromNative() {
  var bridge = window.KaceyNative;
  if (!bridge || typeof bridge.takeShare !== 'function') return;
  var raw = bridge.takeShare();
  if (!raw) return;
  try {
    var share = JSON.parse(raw);
    await land(share.text, (share.images || []).map(base64ToFile));
  } catch (err) {
    say('Sdílení z aplikace se nepovedlo: ' + err.message);
  }
}

/* ---- wiring ------------------------------------------------------------- */

export function initShare() {
  /* The worker does nothing but catch shares (sw.js), so registering it
     costs nothing where the page is never installed. Secure origins only —
     the kiosk's plain-http localhost counts as one, a LAN address does not. */
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(function () { /* no install, no share target */ });
  }
  window.addEventListener('kacey-share', fromNative);
  fromServiceWorker();
  fromNative();
}
