// Tradie AI — Service Worker
// Handles push notifications in the background

self.addEventListener('push', event => {
  // Guard: if no data came through, show a generic notification
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Tradie AI';
  const options = {
    body: data.body || 'You have a new notification',
    icon: 'https://placehold.co/192x192/0F6E56/E1F5EE?text=T',
    badge: 'https://placehold.co/72x72/0F6E56/E1F5EE?text=T',
    data: { url: data.url || '/' },
    vibrate: [200, 100, 200]
  };
  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // If app is already open, focus it
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      // Otherwise open a new window
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});