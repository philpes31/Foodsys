// Service worker do Balcão: deixa o app instalável e abre a última versão das telas mesmo com internet instável.
// Estratégia "rede primeiro": sempre busca a versão nova; se a rede falhar, usa a cópia guardada.
// Dados (Supabase, pagamentos) nunca são guardados aqui.
const CACHE = 'balcao-v1';
const SHELL = ['/', '/index.html', '/app.js', '/legal.js', '/config.js', '/style.css', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // só arquivos do próprio site
  const isPage = req.mode === 'navigate';
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(isPage ? '/index.html' : req, copy)); }
      return res;
    }).catch(() => caches.match(isPage ? '/index.html' : req).then(r => r || caches.match('/index.html')))
  );
});
