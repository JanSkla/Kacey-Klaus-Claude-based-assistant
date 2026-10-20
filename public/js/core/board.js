/* =========================================================================
   A whiteboard, as data — shared by the page (views/whiteboard.js) and the
   server (whiteboard.js, Kacey's tools), so both agree on what a board may
   hold and how big a new thing is.

   A board's document: { items, links, view }.
     item  { id, kind: text | rect | image | doc, x, y, w, h, color, text,
             kicker?, src?, file? { name, type, bytes, url, excerpt? }, by? }
     link  { id, from, to, label? }   — an arrow from one item to another
     view  { x, y, z }                — where the page last looked (not shared)

   Coordinates are the board's own pixels at 100 %: x to the right, y down.
   Nothing here touches the DOM or imports anything.
   ========================================================================= */

export var GRID = 24;

/* Data colours (DESIGN.md §2): the routine's and the calendar's palette, so a
   board reads like the rest of the app. Kacey names them in Czech. */
export var COLORS = [
  { key: 'grey', name: 'šedá', hex: '#8d8d8d' },
  { key: 'amber', name: 'žlutá', hex: '#d2a106' },
  { key: 'green', name: 'zelená', hex: '#24a148' },
  { key: 'teal', name: 'tyrkysová', hex: '#009d9a' },
  { key: 'blue', name: 'modrá', hex: '#78a9ff' },
  { key: 'violet', name: 'fialová', hex: '#a56eff' },
  { key: 'pink', name: 'růžová', hex: '#ee5396' },
  { key: 'red', name: 'červená', hex: '#fa4d56' }
];

export var KINDS = ['text', 'rect', 'image', 'doc'];

/* What a new thing measures when nobody said. On the grid. */
export var SIZES = {
  text: { w: 216, h: 72 },
  rect: { w: 480, h: 336 },
  image: { w: 288, h: 216 },
  doc: { w: 264, h: 72 }
};

export var DEFAULT_COLOR = { text: 'grey', rect: 'blue', image: 'grey', doc: 'grey' };

export var LIMITS = { items: 600, links: 1200, text: 4000, kicker: 60, label: 80, name: 60, excerpt: 6000 };

export function colorOf(key) {
  for (var i = 0; i < COLORS.length; i++) if (COLORS[i].key === key) return COLORS[i];
  return COLORS[0];
}

/** A colour from its key or its Czech name in any case ("modrá", "modrou", "zelenou"). */
export function colorKey(word) {
  var w = fold(word);
  if (!w) return null;
  for (var i = 0; i < COLORS.length; i++) {
    var name = fold(COLORS[i].name);
    // The first three letters already tell the eight apart.
    if (COLORS[i].key === w || name === w || (w.length >= 3 && name.slice(0, 3) === w.slice(0, 3))) return COLORS[i].key;
  }
  return null;
}

export function fold(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

export function snap(v) { return Math.round(v / GRID) * GRID; }

function num(v, lo, hi, dflt) {
  var n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }

/* A file the board points at: only files kept by Kacey herself. */
function safeSrc(v) {
  return typeof v === 'string' && /^\/(whiteboard-files|gallery-files)\/[A-Za-z0-9._%-]+$/.test(v) ? v : '';
}

/** Whatever came in (a page, a tool, an old row), a document that is safe to draw and to store. */
export function normalizeDoc(doc) {
  var src = doc && typeof doc === 'object' ? doc : {};
  var items = [], seen = {};
  var list = Array.isArray(src.items) ? src.items.slice(0, LIMITS.items) : [];
  for (var i = 0; i < list.length; i++) {
    var it = list[i];
    if (!it || typeof it !== 'object' || KINDS.indexOf(it.kind) === -1) continue;
    var id = str(it.id, 40) || newId(it.kind[0]);
    if (seen[id]) continue;
    seen[id] = true;
    var size = SIZES[it.kind];
    var out = {
      id: id, kind: it.kind,
      x: num(it.x, -100000, 100000, 0), y: num(it.y, -100000, 100000, 0),
      w: num(it.w, 48, 4000, size.w), h: num(it.h, 32, 4000, size.h),
      color: colorOf(it.color).key === it.color ? it.color : DEFAULT_COLOR[it.kind],
      text: str(it.text, LIMITS.text)
    };
    if (it.kicker) out.kicker = str(it.kicker, LIMITS.kicker);
    if (it.by === 'kacey') out.by = 'kacey';
    if (it.kind === 'image') out.src = safeSrc(it.src);
    if (it.kind === 'doc' && it.file && typeof it.file === 'object') {
      out.file = {
        name: str(it.file.name, 160) || 'dokument', type: str(it.file.type, 100),
        bytes: num(it.file.bytes, 0, 1e10, 0), url: safeSrc(it.file.url)
      };
      if (it.file.excerpt) out.file.excerpt = str(it.file.excerpt, LIMITS.excerpt);
    }
    items.push(out);
  }
  var links = [], lseen = {};
  var ll = Array.isArray(src.links) ? src.links.slice(0, LIMITS.links) : [];
  for (var j = 0; j < ll.length; j++) {
    var l = ll[j];
    if (!l || !seen[l.from] || !seen[l.to] || l.from === l.to) continue;
    var lid = str(l.id, 40) || newId('a');
    if (lseen[lid]) continue;
    lseen[lid] = true;
    var lo = { id: lid, from: l.from, to: l.to };
    if (l.label) lo.label = str(l.label, LIMITS.label);
    links.push(lo);
  }
  var v = src.view && typeof src.view === 'object' ? src.view : {};
  return {
    items: items, links: links,
    view: { x: num(v.x, -200000, 200000, 0), y: num(v.y, -200000, 200000, 0), z: Math.max(.2, Math.min(3, Number(v.z) || 1)) }
  };
}

var idSeq = 0;
export function newId(prefix) {
  idSeq = (idSeq + 1) % 1296;
  return (prefix || 'o') + Date.now().toString(36).slice(-5) + idSeq.toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

/* ---- geometry -------------------------------------------------------------- */

export function bbox(items) {
  if (!items || !items.length) return null;
  var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y);
    x1 = Math.max(x1, it.x + it.w); y1 = Math.max(y1, it.y + it.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function centre(it) { return { x: it.x + it.w / 2, y: it.y + it.h / 2 }; }

/** The rectangle holds the item when the item's centre is inside it. */
export function holds(rect, it) {
  if (rect === it || rect.kind !== 'rect') return false;
  var c = centre(it);
  return c.x >= rect.x && c.x <= rect.x + rect.w && c.y >= rect.y && c.y <= rect.y + rect.h
    // A rectangle only holds a smaller one.
    && (it.kind !== 'rect' || it.w * it.h < rect.w * rect.h);
}

/** The innermost rectangle an item sits in, or null. */
export function parentOf(items, it) {
  var best = null;
  for (var i = 0; i < items.length; i++) {
    if (holds(items[i], it) && (!best || items[i].w * items[i].h < best.w * best.h)) best = items[i];
  }
  return best;
}

export function overlaps(a, b, pad) {
  var p = pad || 0;
  return a.x < b.x + b.w + p && a.x + a.w + p > b.x && a.y < b.y + b.h + p && a.y + a.h + p > b.y;
}

/** Where the line from the item's centre toward `p` crosses its edge. */
export function edgePoint(it, p) {
  var c = centre(it), dx = p.x - c.x, dy = p.y - c.y;
  if (!dx && !dy) return c;
  var sx = dx ? (it.w / 2) / Math.abs(dx) : Infinity;
  var sy = dy ? (it.h / 2) / Math.abs(dy) : Infinity;
  var s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

/** The two ends of an arrow between two items, each on its item's edge. */
export function linkEnds(a, b) {
  return { a: edgePoint(a, centre(b)), b: edgePoint(b, centre(a)) };
}
