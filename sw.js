// ══════════════════════════════════════════════════════════════════════════════
// sw.js — image-caching service worker for the game board and deck builder
//
// Why this exists: GitHub Pages serves every file with `cache-control:
// max-age=600` and stamps a fresh ETag on EVERY file on EVERY deploy. So the
// browser's own HTTP cache revalidates each card image every 10 minutes and
// re-downloads the whole card-images/ mirror (~9 MB) after each push. This
// worker keeps images in a Cache Storage bucket that ignores those headers:
// once a card image has been seen it is served locally, instantly, forever.
//
// Scope is deliberately narrow — IMAGES ONLY:
//   • same-origin *.jpg / *.png (card-images/, assets/energy/, back.jpg, coins)
//   • the hi-res card scans on images.pokemontcg.io used by "View Card"
// HTML, JS, CSS, cards.json and Firebase traffic are never touched, so the
// existing ?v=<hash> cache-busting in push_to_github.sh keeps working exactly
// as before, and a code deploy is picked up on the next page load as usual.
//
// If an image file is ever REPLACED at the same path (re-scanned card art, a
// new coin), bump IMG_CACHE below so returning players fetch the new file.
// Adding NEW images needs no bump — unseen URLs simply miss and get fetched.
// ══════════════════════════════════════════════════════════════════════════════
const IMG_CACHE = 'tcg-img-v1';

// Small set that every page load needs; fetched once at install so the very
// first board render doesn't wait on them.
const PRECACHE = [
  'back.jpg', 'coin-heads.jpg', 'coin-tails.jpg',
  'assets/energy/colorless.png', 'assets/energy/fighting.png',
  'assets/energy/fire.png', 'assets/energy/grass.png',
  'assets/energy/lightning.png', 'assets/energy/psychic.png',
  'assets/energy/water.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(IMG_CACHE);
      // One missing file must not block installation — add each independently.
      await Promise.allSettled(PRECACHE.map(u => cache.add(u)));
    } catch (e) { /* offline or storage disabled: install anyway, cache lazily */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop caches from older IMG_CACHE versions.
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith('tcg-img-') && k !== IMG_CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isImageRequest(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    return /\.(jpe?g|png|webp|gif)$/i.test(url.pathname);
  }
  return url.hostname === 'images.pokemontcg.io';
}

self.addEventListener('fetch', (event) => {
  if (!isImageRequest(event.request)) return; // let the browser handle it
  event.respondWith(cacheFirst(event.request));
});

async function cacheFirst(request) {
  let cache = null;
  try {
    cache = await caches.open(IMG_CACHE);
    const hit = await cache.match(request);
    if (hit) return hit;
  } catch (e) { /* Cache Storage unavailable — fall through to the network */ }

  const response = await fetch(request);
  // Cache real successes and opaque cross-origin image responses (status 0 is
  // what a no-cors <img> fetch to images.pokemontcg.io returns). Never cache a
  // 404 — a missing card image would otherwise be "missing" forever.
  if (cache && (response.ok || response.type === 'opaque')) {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}
