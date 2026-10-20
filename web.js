/**
 * Kacey on the web — where an answer from the internet came from.
 *
 * She has two read-only built-ins, WebSearch and WebFetch (config.js
 * WEB_TOOLS). She never reads an address aloud, so the page shows the sources
 * under her answer instead: a `web` frame per lookup, live (server.js
 * KaceySession) and again when a conversation is reopened from the history
 * (webOfTranscript, from the SDK's own stored session — nothing extra is kept).
 *
 * Only http(s) addresses get through: the page turns them into links. Titles
 * are cut short; they come from the open web and go in as text.
 */

export const WEB_SOURCES_MAX = 4;          // hits kept per search
const TITLE_MAX = 160;
const QUERY_MAX = 200;

/** An address the page may link to, or null. */
export function webUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

/** The text of a tool_result block. */
function resultText(block) {
  const c = block?.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? b.text : '')).join('\n') : '';
}

/* The hits of a search as its result text carries them — what the model reads
   and what the stored transcript keeps: "Web search results for query: "…"",
   then one `Links: [{"title":…,"url":…}, …]` line per search round. */
function linksOf(text) {
  const hits = [];
  const re = /Links:\s*(\[[^\n]*\])/g;
  let m;
  while ((m = re.exec(text))) {
    try {
      const list = JSON.parse(m[1]);
      if (Array.isArray(list)) hits.push(...list);
    } catch { /* not the JSON it looked like */ }
  }
  return hits;
}

function queryOf(text) {
  const m = /search results for query:\s*"([^"\n]*)"/i.exec(text);
  return m ? m[1] : '';
}

/* A fetch that failed says so in its text, before any page content. */
function fetchFailed(text) {
  return /^\s*(error|failed to fetch|request failed|unable to fetch)/i.test(text)
    || /^\s*<tool_use_error>/i.test(text);
}

/**
 * The `web` frame for one finished lookup.
 *
 * `call` is the tool_use: { name: 'WebSearch' | 'WebFetch', input }.
 * `block` is its tool_result. `structured` is the SDK's tool_use_result
 * (WebSearchOutput / WebFetchOutput) when the message carried this one result
 * alone; without it (or in a stored transcript) the result text is read.
 * Returns null for a fetch without a usable address.
 */
export function webFrame(call, block, structured = null) {
  const failed = block?.is_error === true;
  const input = call?.input || {};
  const text = resultText(block);

  if (call?.name === 'WebFetch') {
    const url = webUrl(structured?.url || input.url);
    if (!url) return null;
    const code = Number(structured?.code) || 0;
    const ok = !failed && (code ? code < 400 : !fetchFailed(text));
    return { type: 'web', tool: 'fetch', ok, sources: [{ title: '', url }] };
  }

  let hits = [];
  if (Array.isArray(structured?.results)) {
    for (const r of structured.results) if (r && Array.isArray(r.content)) hits.push(...r.content);
  } else {
    hits = linksOf(text);
  }
  const seen = new Set();
  const sources = [];
  for (const h of hits) {
    const url = webUrl(h?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ title: String(h.title || '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX), url });
    if (sources.length >= WEB_SOURCES_MAX) break;
  }
  return {
    type: 'web', tool: 'search', ok: !failed,
    query: String(structured?.query || input.query || queryOf(text) || '').slice(0, QUERY_MAX),
    sources,
  };
}

/**
 * Pairs the web tool_use blocks of a stream with their results. One per
 * session (live) or per transcript (history): `use(block)` for every
 * tool_use, `result(block, structured)` for every tool_result — the latter
 * returns the frame, or null when the result was not a web lookup.
 */
export function webTracker(webTools = ['WebSearch', 'WebFetch']) {
  const calls = new Map();
  return {
    use(block) {
      if (block?.type === 'tool_use' && webTools.includes(block.name)) {
        calls.set(block.id, { name: block.name, input: block.input || {} });
      }
    },
    result(block, structured = null) {
      const call = calls.get(block?.tool_use_id);
      if (!call) return null;
      calls.delete(block.tool_use_id);
      return webFrame(call, block, structured);
    },
    clear() { calls.clear(); },
  };
}

/** A stored message the owner wrote — not a tool result, not a subagent's. */
export function isTurnStart(m) {
  if (m?.type !== 'user' || m.parent_tool_use_id) return false;
  const content = m.message?.content;
  return typeof content === 'string'
    || (Array.isArray(content) && !content.some((b) => b?.type === 'tool_result'));
}

/**
 * The lookups of each turn of a stored session, for the transcript: a list of
 * frames per turn, indexed by the turn's place among the isTurnStart messages.
 * transcriptOf (server.js) puts them after that turn's answer.
 */
export function webOfTranscript(messages, webTools) {
  const track = webTracker(webTools);
  const out = [];
  let turn = -1;
  for (const m of messages || []) {
    if (!m || m.parent_tool_use_id) continue;
    const content = m.message?.content;
    if (isTurnStart(m)) { turn++; out[turn] = []; continue; }
    if (m.type === 'user' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type !== 'tool_result') continue;
        const f = track.result(b);
        if (f && turn >= 0) out[turn].push(f);
      }
    } else if (m.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) track.use(b);
    }
  }
  return out;
}
