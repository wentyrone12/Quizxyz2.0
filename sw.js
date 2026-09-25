
const CACHE_NAME = 'white-quizxyz-v2';
const ASSETS = [
  './',
  './index.html',
  './btn-flashcard.html',
  './style.css',
  './styleindex.css',
  './script.js',
  './manifest.json',
  './logo.png'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  e.respondWith(caches.match(e.request).then(res => res || fetch(e.request).catch(()=> caches.match('./index.html'))));
});
