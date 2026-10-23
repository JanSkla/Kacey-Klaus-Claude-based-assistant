/* =========================================================================
   Which files in Úložiště can be opened and shown, and as what.

   Shared by the page (views/storage.js decides which names open the náhled)
   and the server (storage.js' /view route serves only these, under the type
   given here — never the type the uploading browser claimed). Going by the
   extension alone; a file that is not what its name says simply fails to
   show, and the náhled offers Stáhnout instead.
   ========================================================================= */

var TEXT = 'text/plain; charset=utf-8';

var KINDS = {
  image: { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
           avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon' },
  // .mov as mp4: Chrome plays an H.264 .mov that way, and refuses video/quicktime.
  video: { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg' },
  audio: { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg',
           oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac' },
  pdf: { pdf: 'application/pdf' },
  table: { csv: TEXT, tsv: TEXT },
  // Always as plain text — an .html shows its source, it never runs.
  text: { txt: TEXT, md: TEXT, markdown: TEXT, json: TEXT, log: TEXT, xml: TEXT, html: TEXT, htm: TEXT,
          css: TEXT, js: TEXT, mjs: TEXT, ts: TEXT, py: TEXT, sh: TEXT, yml: TEXT, yaml: TEXT, ini: TEXT,
          toml: TEXT, conf: TEXT, cfg: TEXT, sql: TEXT, srt: TEXT, vtt: TEXT }
};

/** { kind, type, ext } for a file name that can be shown — kind is image · video · audio · pdf · table · text — or null. */
export function viewOf(name) {
  var m = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''));
  if (!m) return null;
  var ext = m[1].toLowerCase();
  for (var kind in KINDS) {
    if (KINDS[kind][ext]) return { kind: kind, type: KINDS[kind][ext], ext: ext };
  }
  return null;
}
