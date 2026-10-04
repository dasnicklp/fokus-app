// Service Worker: Offline-Cache, Push-Empfang und Klicks auf Benachrichtigungen
const CACHE = 'fokus-v4';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
const ICON = 'icon-192.png';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Netzwerk zuerst, Cache als Rückfall (so kommen Updates an, und es geht trotzdem offline).
// Nur eigene Dateien, nie die Backend-Aufrufe.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});

/* ---------- Zugang zum Backend (Code liegt in IndexedDB, vom Client gesetzt) ---------- */
function idbGet(k) {
  return new Promise((res) => {
    const q = indexedDB.open('fokus-sw', 1);
    q.onupgradeneeded = () => q.result.createObjectStore('kv');
    q.onerror = () => res(null);
    q.onsuccess = () => {
      try {
        const g = q.result.transaction('kv').objectStore('kv').get(k);
        g.onsuccess = () => res(g.result || null);
        g.onerror = () => res(null);
      } catch (e) { res(null); }
    };
  });
}
async function apiSW(path, body) {
  const c = await idbGet('cfg');
  if (!c || !c.api || !c.code) throw new Error('nocfg');
  const r = await fetch(c.api + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + c.code, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error('http ' + r.status);
  return r.json();
}

/* ---------- Push: Gerät fragt nach, was fällig ist ---------- */
self.addEventListener('push', (e) => { e.waitUntil(onPush()); });

async function onPush() {
  let data = null;
  try { data = await apiSW('/api/pending'); } catch (err) { /* offline oder nicht eingerichtet */ }
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  wins.forEach((c) => c.postMessage({ type: 'sync' }));
  if (wins.some((c) => c.visibilityState === 'visible')) return; // App im Vordergrund zeigt es selbst
  const reg = self.registration;
  const list = (data && data.pending) || [];
  if (data && data.test) {
    await reg.showNotification('Test erfolgreich', { body: 'So meldet sich Fokus, auch wenn die App geschlossen ist.', icon: ICON, badge: ICON, tag: 'fokus-test' });
  }
  if (!data) {
    await reg.showNotification('Fokus', { body: 'Du hast eine fällige Erinnerung. Öffne die App.', icon: ICON, badge: ICON, tag: 'fokus-due', vibrate: [200, 100, 200] });
    return;
  }
  if (!list.length) {
    if (!data.test) {
      await reg.showNotification('Fokus', { body: 'Alles erledigt.', icon: ICON, badge: ICON, tag: 'fokus-quiet', silent: true });
      await new Promise((r) => setTimeout(r, 2500));
      (await reg.getNotifications({ tag: 'fokus-quiet' })).forEach((n) => n.close());
    }
    return;
  }
  for (const p of list) {
    await reg.showNotification(p.title, {
      body: p.note || '', tag: p.id, renotify: true, requireInteraction: true,
      icon: ICON, badge: ICON, vibrate: [200, 100, 200, 100, 200], data: { id: p.id },
      actions: p.kind === 'timer' ? [{ action: 'done', title: 'OK' }, { action: 'snooze', title: '+5 Min' }]
        : [{ action: 'done', title: p.kind === 'event' ? 'Gesehen' : 'Erledigt' }, { action: 'snooze', title: `Snooze ${p.snoozeDefault || 10} Min` }],
    });
  }
}

/* ---------- Klick auf Benachrichtigung oder ihre Knöpfe ---------- */
self.addEventListener('notificationclick', (e) => {
  const data = e.notification.data || {};
  const action = e.action || 'open';
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Mit Backend: Aktion direkt dort ausführen, ohne die App zu öffnen
    if ((action === 'done' || action === 'snooze') && data.id) {
      try {
        const r = await apiSW('/api/action', { id: data.id, action });
        if (r && r.ok) { wins.forEach((c) => c.postMessage({ type: 'sync' })); return; }
      } catch (err) { /* ohne Backend weiter wie bisher */ }
    }
    if (wins.length) {
      wins[0].postMessage({ type: 'notif-action', id: data.id, action });
      return wins[0].focus();
    }
    const url = './index.html?id=' + encodeURIComponent(data.id || '') + '&action=' + action;
    return self.clients.openWindow(url);
  })());
});
