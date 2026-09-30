/* =========================================================================
   Kacey's service worker — the share target, and nothing else.

   Android's share sheet hands the installed web app a POST to /share-target
   (manifest.webmanifest, share_target). The server has no multipart parser
   and needs none: the share is caught here, parked in the Cache API, and the
   page is opened at /?share=1, where js/ui/share.js picks it up.

   Every other request goes straight to the network. Nothing is cached for
   offline use: Kacey without her server is not Kacey, and a stale copy of
   the app would be worse than an error.
   ========================================================================= */

var CACHE = 'kacey-share';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (ev) { ev.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function (ev) {
  var url = new URL(ev.request.url);
  if (ev.request.method !== 'POST' || url.pathname !== '/share-target') return;
  ev.respondWith(park(ev.request));
});

async function park(request) {
  try {
    var form = await request.formData();
    await caches.delete(CACHE);
    var cache = await caches.open(CACHE);
    var files = form.getAll('images').filter(function (f) { return f && typeof f === 'object' && f.size; });
    for (var i = 0; i < files.length; i++) {
      await cache.put('/share/file/' + i, new Response(files[i], { headers: { 'Content-Type': files[i].type || 'application/octet-stream' } }));
    }
    await cache.put('/share/meta', new Response(JSON.stringify({
      title: form.get('title') || '',
      text: form.get('text') || '',
      url: form.get('url') || '',
      files: files.map(function (f) { return { name: f.name, type: f.type }; })
    }), { headers: { 'Content-Type': 'application/json' } }));
  } catch (err) {
    // The page opens anyway and simply finds nothing parked.
  }
  return Response.redirect('/?share=1#main', 303);
}
