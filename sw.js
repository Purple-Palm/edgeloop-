// EdgeLoop service worker: offline fallback without stale updates.
//
// Strategy: network first for everything, falling back to the cache when the
// network is unavailable. That way a deployed update is picked up on the next
// load (the app is a live-updating single page), while the cockpit still opens
// offline once it has been visited. Bump CACHE_VERSION when the precache list
// changes; old caches are removed on activate.

const CACHE_VERSION = 'edgeloop-v5';

// Every module the page imports, directly or through another module, belongs
// here. One import that fails fails the whole module graph, so a module
// missing from this list is not a missing feature offline, it is a page that
// never starts: 1.1.0 left five of them out, and the first offline open after
// that update showed the page with not one of its modules running. The fetch
// handler's own copies cannot cover for a gap. A first visit loads every
// module before this worker exists, and activating an update deletes the
// previous cache together with every copy the fetch handler had put in it.
// src/js/precache.test.js walks the import graph from index.html and fails
// when a module is missing here.
const PRECACHE = [
    './',
    './index.html',
    './CHANGELOG.md',
    './src/js/version.js',
    './manifest.json',
    './icon.svg',
    './src/js/app.js',
    './src/js/state.js',
    './src/js/engine.js',
    './src/js/patterns.js',
    './src/js/session-rules.js',
    './src/js/settings-schema.js',
    './src/js/hr-watchdog.js',
    './src/js/supervision.js',
    './src/js/screen-wake-lock.js',
    './src/js/start-gate.js',
    './src/js/funscript.js',
    './src/js/storage.js',
    './src/js/write-coalescer.js',
    './src/js/backup.js',
    './src/js/alert-banner.js',
    './src/js/chart.js',
    './src/js/voice.js',
    './src/js/voice-queue.js',
    './src/js/voice-cues.js',
    './src/js/voice-status.js',
    './src/js/webrtc.js',
    './src/js/peer-messages.js',
    './src/js/hardware/ble.js',
    './src/js/hardware/ble-protocol.js',
    './src/js/hardware/handy.js',
    './src/js/hardware/handy-protocol.js',
    './src/js/hardware/handy-fields.js',
    './src/js/hardware/intiface.js',
    './src/js/hardware/buttplug-protocol.js',
    './src/js/hardware/stroke-planner.js',
    './src/js/hardware/tcode.js',
    './src/js/hardware/tcode-protocol.js'
];

// The two scripts index.html loads from a CDN, precached for the same two
// reasons: a first visit fetches them before this worker exists, and the
// copies the fetch handler keeps later go with the cache an update deletes.
// Without Tailwind, every panel the page keeps out of sight with its `hidden`
// class - the modals and the setup wizard among them - is on screen at once.
// They are fetched the way the page's own <script> tags fetch them, without
// CORS, because the Tailwind CDN sends no CORS header; the opaque reply that
// gives is one cache.add refuses, so it is put in by hand.
const PRECACHE_CDN = [
    'https://cdn.tailwindcss.com',
    'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION)
            // addAll rejects on the first failure; cache what we can instead.
            .then((cache) => Promise.allSettled([
                ...PRECACHE.map((url) => cache.add(url)),
                ...PRECACHE_CDN.map((url) => fetch(new Request(url, { mode: 'no-cors' }))
                    .then((response) => cache.put(url, response)))
            ]))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    // Never intercept device APIs or signalling: the Handy cloud API, Intiface
    // websockets and PeerJS must always go to the network.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.hostname.endsWith('handyfeeling.com') || url.hostname.endsWith('peerjs.com')) return;

    event.respondWith(
        fetch(request)
            .then((response) => {
                // Same-origin and CORS replies are cached when ok; opaque replies (the CDN script tags) have no
                // readable status, so they are cached as-is to keep the cockpit styled offline.
                if (response && (response.ok || response.type === 'opaque')) {
                    const copy = response.clone();
                    caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
                }
                return response;
            })
            .catch(() => caches.match(request, { ignoreSearch: url.origin === self.location.origin })
                .then((cached) => cached || (request.mode === 'navigate' ? caches.match('./index.html') : undefined))
                .then((cached) => cached || Response.error()))
    );
});
