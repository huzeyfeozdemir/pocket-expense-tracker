// Service worker: lets the phone install the site as an app and open it offline.
// Strategy: always try the network first (so updates arrive right away);
// if there is no internet, use the copy saved in the cache last time.
const CACHE = 'cep-butce-v3';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Share target: a bank app shared a PDF with us ("Paylaş" → Cep Bütçe).
  // Save the files in a cache, then open the app; app.js imports them.
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req, { cache: 'no-cache' }) // always ask the server for the newest version
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});

async function receiveShare(req) {
  const form = await req.formData();
  const files = form.getAll('statements').filter((f) => f && f.size);
  const cache = await caches.open('shared-files');
  for (const old of await cache.keys()) await cache.delete(old);
  for (let i = 0; i < files.length; i++) {
    await cache.put(`shared-${i}`, new Response(files[i], { headers: { 'X-File-Name': encodeURIComponent(files[i].name) } }));
  }
  return Response.redirect(new URL('./?shared=' + files.length, self.registration.scope).href, 303);
}
