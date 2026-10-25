// Shows push notifications and opens the chat they belong to. No offline cache:
// every page load comes fresh from this machine.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

self.addEventListener('push', event => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {}
  const title = data.title || 'Nako'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.session || 'nako',
      renotify: true,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { session: data.session || null }
    })
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const session = event.notification.data?.session
  const target = session ? `/#/c/${session}` : '/'
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus()
          return client.navigate(target)
        }
      }
      return self.clients.openWindow(target)
    })()
  )
})
