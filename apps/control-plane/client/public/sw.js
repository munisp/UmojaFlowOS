/*
 * UmojaFlowOS control-plane service worker.
 *
 * Scope is deliberately narrow: it caches only the static application shell
 * (same-origin GET assets under /assets and the PWA icons/manifest) so the
 * console stays installable and opens on a flaky connection. It NEVER caches
 * /trpc, /api, or any authenticated payload — compliance and payment records
 * must always come from the live server; serving a stale record would be a
 * false claim about system state. When the network is unavailable the
 * navigation fallback explains that live data is unreachable rather than
 * showing anything cached.
 */

const SHELL_CACHE = "uf-shell-v1";
const SHELL_PREFIXES = ["/assets/", "/pwa-icon", "/manifest.webmanifest", "/favicon"];

self.addEventListener("install", (event) => {
  // Take over immediately; there is no legacy cached data to preserve.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Live control-plane traffic: straight to network, no cache, ever.
  if (url.pathname.startsWith("/trpc") || url.pathname.startsWith("/api")) return;

  // Static shell: cache-first with background population.
  if (SHELL_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(SHELL_CACHE);
          cache.put(request, response.clone());
        }
        return response;
      })(),
    );
    return;
  }

  // Navigations: network-first; offline gets an honest notice, not stale data.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          return new Response(
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>UmojaFlowOS offline</title></head>" +
              "<body style=\"font-family:sans-serif;padding:2rem\">" +
              "<h1>Control plane unreachable</h1>" +
              "<p>UmojaFlowOS only displays live, server-verified records. Reconnect and reload; " +
              "no cached compliance or payment data is ever shown.</p>" +
              "</body></html>",
            { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
          );
        }
      })(),
    );
  }
});
