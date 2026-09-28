/* =========================================================================
   The mini player in the header (Claude Design "MiniVinyl").

   What is playing on kaceybody, from nowplayingd (lights repo,
   tools/nowplaying, :8081): its /ws status feed and the turntable sprite
   sheet it renders per track. Controls go to its /api/player and /api/volume;
   nothing here ever talks to Spotify.

   "Nechat hrát vinyl" keeps the bedside screen lit (Kacey's /api/screen/keep,
   screen.js) until pressed again; on the kiosk it also puts the visual up.

   Collapsed it is a 250×34 bar before the Controller button: a window onto
   the live turntable, the title, and Pauza/Hrát. Tapped, it drops a panel
   with the turntable at full size, progress, transport and volume.

   Hidden entirely when nothing is playing or nowplayingd is down. Paused, it
   stays, with the record holding its frame.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { KIOSK } from '../core/state.js';

var PORT = 8081;
var VOLUME_STEP = 5;

export function nowplayingUrl() {
  return location.protocol + '//' + (location.hostname || 'localhost') + ':' + PORT;
}

var status = null;         // nowplayingd's last status, or null while it is down
var playing = false;
var progressBase = 0, progressAt = 0, duration = 0;
var volumePending = null, volumeTimer = 0;
var keep = false;          // the screen is kept lit ("Nechat hrát vinyl")

/* ---- the turntable -------------------------------------------------------
   The same player as nowplayingd's own page (its web/index.html advance()):
   frame 0 is the needle drop, and from `loop_start` it circles the last
   revolution for as long as the song lasts. Paused holds the frame. One
   draw per frame, into both canvases; CSS scales the small one. */

var sheet = null, anim = null, position = 0, drawnFrame = -1, lastDrawAt = 0;
var sheetSrc = null;
var canvases = [];

function loadDeck(meta) {
  var src = meta && meta.src ? nowplayingUrl() + meta.src : null;
  if (src === sheetSrc) return;
  sheetSrc = src;
  if (!src) { sheet = null; anim = null; clearAll(); return; }
  var image = new Image();
  image.onload = function () {
    if (sheetSrc !== src) return;          // a newer track won
    sheet = image;
    anim = meta;
    position = playing ? 0 : meta.loop_start;
    drawnFrame = -1;
    lastDrawAt = performance.now();
  };
  image.src = src;
}

function clearAll() {
  canvases.forEach(function (c) { c.getContext('2d').clearRect(0, 0, c.width, c.height); });
}

function advance(now) {
  var dt = now - lastDrawAt;
  lastDrawAt = now;
  if (!sheet || !anim) return;
  if (playing) position += dt / anim.duration_ms;
  if (position >= anim.frames) {
    var span = Math.max(anim.frames - anim.loop_start, 1);
    position = anim.loop_start + ((position - anim.loop_start) % span);
  }
  var frame = Math.floor(position);
  if (frame === drawnFrame) return;
  drawnFrame = frame;
  var col = frame % anim.cols;
  var row = Math.floor(frame / anim.cols);
  canvases.forEach(function (c) {
    var g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, anim.width, anim.height);
    g.drawImage(sheet, col * anim.width, row * anim.height, anim.width, anim.height, 0, 0, anim.width, anim.height);
  });
}

/* ---- clock ---------------------------------------------------------------- */

function mmss(ms) {
  var total = Math.max(0, Math.round(ms / 1000));
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

function frame(now) {
  if (status) {
    advance(now);
    if (!$('miniDrop').hidden && duration > 0) {
      var elapsed = progressBase + (playing ? performance.now() - progressAt : 0);
      $('miniFill').style.width = (Math.min(elapsed / duration, 1) * 100) + '%';
      $('miniNow').textContent = mmss(elapsed);
      $('miniEnd').textContent = mmss(duration);
    }
  }
  requestAnimationFrame(frame);
}

/* ---- render --------------------------------------------------------------- */

function render() {
  var track = status && status.track;
  $('mini').hidden = !track;
  if (!track) { setOpen(false); return; }

  playing = !!status.playing;
  progressBase = status.progress_ms || 0;
  progressAt = performance.now();
  duration = track.duration_ms || 0;
  loadDeck(status.vinyl);

  $('miniTitle').textContent = track.title || 'Neznámá skladba';
  $('miniArtist').textContent = track.artist || '';
  $('miniBigTitle').textContent = track.title || 'Neznámá skladba';
  $('miniBigArtist').textContent = track.artist || '';
  $('miniPlay').textContent = playing ? 'Pauza' : 'Hrát';
  $('miniPlay').setAttribute('aria-label', playing ? 'Pozastavit' : 'Přehrát');
  $('miniToggle').textContent = playing ? 'Pauza' : 'Přehrát';
  $('miniState').textContent = (playing ? 'HRAJE' : 'POZASTAVENO') + (status.device ? ' · ' + status.device : '');

  var volume = volumePending !== null ? volumePending : status.volume_percent;
  $('miniVol').hidden = typeof volume !== 'number';
  if (typeof volume === 'number') {
    $('miniVolFill').style.width = volume + '%';
    $('miniVolNum').textContent = volume + ' %';
  }
  $('miniError').textContent = status.spotify_error || '';
  $('miniError').hidden = !status.spotify_error;
}

function setOpen(open) {
  $('miniDrop').hidden = !open;
  $('miniOpen').setAttribute('aria-expanded', String(open));
}

/* ---- the feed ------------------------------------------------------------- */

var retry = 2000;

function connect() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var ws;
  try { ws = new WebSocket(proto + '//' + (location.hostname || 'localhost') + ':' + PORT + '/ws'); }
  catch (e) { return; }
  ws.onopen = function () { retry = 2000; };
  ws.onmessage = function (ev) {
    try { status = JSON.parse(ev.data); } catch (e) { return; }
    render();
  };
  ws.onclose = function () {
    status = null;
    render();
    // nowplayingd is optional; knock politely, less often the longer it is away.
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 60000);
  };
}

/* ---- controls ------------------------------------------------------------- */

function post(path, body) {
  return fetch(nowplayingUrl() + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (res.ok) { status = data; render(); }
      else { $('miniError').textContent = data.error || 'Příkaz se nepovedl.'; $('miniError').hidden = false; }
    });
  }).catch(function () {
    $('miniError').textContent = 'nowplayingd neodpovídá.';
    $('miniError').hidden = false;
  });
}

function toggle() { post('/api/player', { action: playing ? 'pause' : 'play' }); }

function nudgeVolume(delta) {
  var base = volumePending !== null ? volumePending : (status && status.volume_percent) || 0;
  volumePending = Math.max(0, Math.min(100, Math.round((base + delta) / VOLUME_STEP) * VOLUME_STEP));
  render();
  clearTimeout(volumeTimer);
  volumeTimer = setTimeout(function () {
    var percent = volumePending;
    post('/api/volume', { percent: percent }).then(function () { volumePending = null; render(); });
  }, 300);
}

/* ---- "Nechat hrát vinyl" --------------------------------------------------- */

function renderKeep() {
  $('miniKeep').setAttribute('aria-pressed', String(keep));
  $('miniKeep').textContent = keep ? 'Vinyl hraje · vypnout' : 'Nechat hrát vinyl';
}

function readKeep() {
  fetch('/api/screen/keep').then(function (r) { return r.json(); })
    .then(function (d) { keep = !!d.keep; renderKeep(); })
    .catch(function () { /* the server's; the button just stays as it is */ });
}

function setKeep(on) {
  return fetch('/api/screen/keep', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: on }),
  }).then(function (r) { return r.json(); })
    .then(function (d) { keep = !!d.keep; renderKeep(); })
    .catch(function () { $('miniError').textContent = 'Kacey neodpovídá.'; $('miniError').hidden = false; });
}

function openVisual() {
  $('visualFrame').src = nowplayingUrl() + '/';
  $('visualOverlay').hidden = false;
}

function closeVisual() {
  $('visualOverlay').hidden = true;
  $('visualFrame').removeAttribute('src');     // stop drawing a record nobody sees
}

export function initMiniPlayer() {
  if (!$('mini')) return;
  canvases = [$('miniDeck'), $('miniBig')];
  $('miniLink').href = nowplayingUrl();
  /* The kiosk has no tabs, and cage 0.2 crashes when the browser opens a
     second window, so the visual never gets one there: it is shown over this
     page in a full-screen frame. Kacey keeps running (and listening)
     underneath, and the visual's "Otevřít Kacey" asks for the frame to close. */
  if (KIOSK) {
    $('miniLink').addEventListener('click', function (ev) {
      ev.preventDefault();
      setOpen(false);
      openVisual();
    });
    window.addEventListener('message', function (ev) {
      if (ev.origin !== nowplayingUrl() || !ev.data) return;
      if (ev.data.type === 'kacey-close-visual') {
        closeVisual();
        // Nobody keeps a screen lit for a record they just closed.
        if (keep) setKeep(false);
      }
    });
  }

  $('miniKeep').addEventListener('click', function () {
    var on = !keep;
    setKeep(on).then(function () {
      if (on && KIOSK) { setOpen(false); openVisual(); }
    });
  });

  $('miniOpen').addEventListener('click', function () {
    var open = $('miniDrop').hidden;
    setOpen(open);
    if (open) readKeep();              // the visual may have changed it
  });
  $('miniClose').addEventListener('click', function () { setOpen(false); });
  $('miniPlay').addEventListener('click', toggle);
  $('miniToggle').addEventListener('click', toggle);
  $('miniPrev').addEventListener('click', function () { post('/api/player', { action: 'previous' }); });
  $('miniNext').addEventListener('click', function () { post('/api/player', { action: 'next' }); });
  $('miniVolDown').addEventListener('click', function () { nudgeVolume(-VOLUME_STEP); });
  $('miniVolUp').addEventListener('click', function () { nudgeVolume(VOLUME_STEP); });

  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') setOpen(false); });
  document.addEventListener('pointerdown', function (ev) {
    if (!$('miniDrop').hidden && !$('mini').contains(ev.target)) setOpen(false);
  });

  connect();
  requestAnimationFrame(frame);
}
