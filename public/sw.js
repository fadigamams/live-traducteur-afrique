// Service worker de TAL : permet l'installation et l'ouverture hors connexion
const V = "tal-v30"; // changer ce numéro à chaque nouvelle version de l'appli
const SHELL = ["/", "/manifest.json", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== V).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/")) return; // API et services externes : toujours le réseau
  if (r.mode === "navigate") { // page : réseau d'abord (toujours à jour), copie hors ligne en secours
    e.respondWith(fetch(r).then(res => { const cp = res.clone(); caches.open(V).then(c => c.put("/", cp)); return res; }).catch(() => caches.match("/")));
    return;
  }
  e.respondWith(caches.match(r).then(h => { // images, manifeste : cache puis mise à jour discrète
    const n = fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); } return res; }).catch(() => h);
    return h || n;
  }));
});
