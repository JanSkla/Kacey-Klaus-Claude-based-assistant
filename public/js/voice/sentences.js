/* =========================================================================
   Sentence boundaries — the one piece of pure logic in the frontend.

   Speech has to start before the reply has finished arriving, so the stream is
   cut into complete sentences and each one is spoken as soon as it is whole.
   Getting this wrong is audible in both directions: cut too eagerly and she
   reads "3" and "14" as two sentences, cut too late and there is a long
   silence before the first word.

   No DOM, no state, no imports — which is what makes this the one part of the
   frontend that can be tested directly.
   ========================================================================= */

/* Split off every COMPLETE sentence, keep the tail buffered.
   A boundary is . ! ? … or a newline, followed by whitespace (or, on the
   final flush, by end of text). Decimals like "3.14" are not boundaries. */
var CLOSERS = '"\')]»”’…!?.';

export function takeSentences(buf, final) {
  var out = [], start = 0, i = 0;
  while (i < buf.length) {
    var c = buf.charAt(i);
    if (c === '\n') {
      out.push(buf.slice(start, i + 1)); start = i + 1; i = start; continue;
    }
    if (c === '.' || c === '!' || c === '?' || c === '…') {
      if (c === '.' && /\d/.test(buf.charAt(i - 1)) && /\d/.test(buf.charAt(i + 1))) { i++; continue; }
      var j = i + 1;
      while (j < buf.length && CLOSERS.indexOf(buf.charAt(j)) !== -1) j++;
      if (j < buf.length && /\s/.test(buf.charAt(j))) {
        out.push(buf.slice(start, j + 1)); start = j + 1; i = start; continue;
      }
      /* Streaming models routinely drop the space between sentences, so
         "…for today.Do oběda…" arrived as ONE chunk and cost 19s of silence
         before the first audio. A terminator followed straight by an
         uppercase letter is a boundary too. The digit guard above already
         protects decimals. */
      if (j < buf.length && /\p{Lu}/u.test(buf.charAt(j))) {
        out.push(buf.slice(start, j)); start = j; i = start; continue;
      }
      if (j >= buf.length && final) { out.push(buf.slice(start)); start = buf.length; break; }
      i = j; continue;
    }
    i++;
  }
  var rest = buf.slice(start);
  if (final && rest.trim()) { out.push(rest); rest = ''; }
  // never speak a lone stray character
  var keep = [];
  for (var k = 0; k < out.length; k++) {
    if (out[k].trim().length > 1 || final) keep.push(out[k]);
    else rest = out[k] + rest;
  }
  return { sentences: keep, rest: rest };
}

/* What of a sentence is said out loud. The persona keeps addresses out of
   her answers — the sources are under the answer in the chat (ui/websources.js)
   — but a slipped "https://www.ordinace-novakova.cz/hodiny" read letter by
   letter is the worst thing a voice can do, so it is caught here as well:
   a Markdown link keeps its words, a bare address goes. */
var MD_LINK = /\[([^\]\n]+)\]\((?:https?:\/\/|www\.)[^)\s]*\)/gi;
var BARE_URL = /\b(?:https?:\/\/|www\.)[^\s<>"«»“”]*[^\s<>"«»“”.,;:!?)\]]/gi;

export function forSpeech(text) {
  var s = String(text == null ? '' : text);
  if (!/https?:\/\/|www\./i.test(s)) return s;
  return s.replace(MD_LINK, '$1')
    .replace(BARE_URL, '')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]+([,.;:!?…])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ');
}
