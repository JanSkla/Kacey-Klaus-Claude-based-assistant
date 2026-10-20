/* =========================================================================
   The sources of one turn that went to the web — collected from its `web`
   frames (web.js on the server), merged into the list the chat shows under
   Kacey's answer (ui/websources.js): the pages she read first, then the
   search hits, each address once.

   No DOM, no state — tested in test/web.mjs.
   ========================================================================= */

/** A fresh collector for one turn. */
export function newTurn() {
  return { queries: [], fetched: [], hits: [], searches: 0, failed: 0 };
}

/** One `web` frame into the turn's collector. */
export function addFrame(turn, msg) {
  if (!msg || typeof msg !== 'object') return turn;
  var list = Array.isArray(msg.sources) ? msg.sources : [];
  if (msg.tool === 'fetch') {
    list.forEach(function (s) {
      if (s && isLink(s.url)) turn.fetched.push({ url: s.url, title: String(s.title || ''), ok: msg.ok !== false });
    });
  } else {
    turn.searches++;
    if (msg.ok === false) turn.failed++;
    if (msg.query && turn.queries.indexOf(msg.query) === -1) turn.queries.push(msg.query);
    list.forEach(function (s) {
      if (s && isLink(s.url)) turn.hits.push({ url: s.url, title: String(s.title || '') });
    });
  }
  return turn;
}

/** Only http(s): everything else stays out of the links. */
export function isLink(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/** "ordinace-novakova.cz" from the address. */
export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return String(url); }
}

/** The sources to show: { url, title, read, ok }, read pages first. */
export function mergeSources(turn) {
  var seen = {}, out = [], titles = {};
  turn.hits.forEach(function (h) { if (h.title && !titles[h.url]) titles[h.url] = h.title; });
  turn.fetched.forEach(function (f) {
    if (seen[f.url]) {
      // read twice: a later success wins over an earlier failure
      if (f.ok) out.forEach(function (o) { if (o.url === f.url) o.ok = true; });
      return;
    }
    seen[f.url] = true;
    out.push({ url: f.url, title: f.title || titles[f.url] || hostOf(f.url), read: true, ok: f.ok });
  });
  turn.hits.forEach(function (h) {
    if (seen[h.url]) return;
    seen[h.url] = true;
    out.push({ url: h.url, title: h.title || hostOf(h.url), read: false, ok: true });
  });
  return out;
}

/** What the card says: its kicker, and the line shown when there are no links
    ('' when there are). A turn whose every search failed and that found
    nothing says the web was out of reach, not that nothing was found. */
export function summary(turn) {
  var list = mergeSources(turn);
  var q = turn.queries[0] || '';
  var empty = '';
  if (!list.length) {
    empty = turn.searches && turn.failed === turn.searches
      ? 'Na internet se teď nedostanu — hledání se nepovedlo.'
      : 'Hledání nic nenašlo.';
  }
  return {
    kicker: 'Z INTERNETU' + (q ? ' · „' + q + '“' : ''),
    sources: list,
    empty: empty,
    failed: !list.length && turn.searches > 0 && turn.failed === turn.searches
  };
}

/** The line under a source's title. */
export function metaOf(s) {
  return hostOf(s.url) + (s.read ? (s.ok ? ' · přečteno' : ' · nešlo otevřít') : '');
}
