const CACHE_NAME = 'coyote3-v1.1.0';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/ble.js',
  './js/pose.js',
  './js/state-machine.js',
  './js/safety.js',
  './js/store.js',
  './js/audio.js',
  './js/app.js',
  './lib/mediapipe/vision_bundle.mjs',
  './lib/mediapipe/wasm/vision_wasm_internal.js',
  './lib/mediapipe/wasm/vision_wasm_internal.wasm',
  './lib/mediapipe/wasm/vision_wasm_nosimd_internal.js',
  './lib/mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
  './lib/models/pose_landmarker_lite.task',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => k !== CACHE_NAME ? caches.delete(k) : null))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // 不缓存 MediaPipe CDN 资源
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      return cached || fetch(e.request).then(resp => {
        if (resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return resp;
      }).catch(() => cached);
    })
  );
});
