const CACHE_NAME = 'cplayer5-test-old';

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.put(
                new Request(new URL('./index.html', self.registration.scope)),
                new Response('old cached shell', {
                    headers: { 'Content-Type': 'text/html; charset=utf-8' }
                })
            ))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});
