const CACHE_NAME = 'dsh-remote-web-shell-v1'
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // Strip fragment so cached shell keys never hold transient pairing state
  const normalizedPath = url.pathname
  const isShellPath =
    normalizedPath.endsWith('/') ||
    normalizedPath.endsWith('/index.html') ||
    normalizedPath.endsWith('/styles.css') ||
    normalizedPath.endsWith('/app.js') ||
    normalizedPath.endsWith('/manifest.webmanifest') ||
    normalizedPath.endsWith('/icon.svg')

  if (!isShellPath) return

  event.respondWith(
    fetch(req)
      .then((networkResp) => {
        if (networkResp && networkResp.status === 200 && networkResp.type === 'basic') {
          const clone = networkResp.clone()
          void caches.open(CACHE_NAME).then((cache) => cache.put(req, clone))
        }
        return networkResp
      })
      .catch(async () => (await caches.match(req)) || caches.match('./index.html')),
  )
})
