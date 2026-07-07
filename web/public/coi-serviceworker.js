// coi-serviceworker.js
// Custom service worker to inject COOP/COEP headers on static environments like GitHub Pages.
// This enables SharedArrayBuffer usage without server-side configuration.

if (typeof window === 'undefined') {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener("fetch", (event) => {
    if (event.request.cache === "only-if-cached" && event.request.mode !== "same-origin") {
      return;
    }
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.status === 0) {
            return response;
          }
          const newHeaders = new Headers(response.headers);
          newHeaders.set("Cross-Origin-Embedder-Policy", "require-corp");
          newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
          
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        })
        .catch((e) => {
          console.error("[coi-worker] Fetch failed:", e);
        })
    );
  });
} else {
  // Main thread: Register the service worker on the current script URL
  const sw = navigator.serviceWorker;
  if (sw) {
    const scriptSrc = (document.currentScript && document.currentScript.src) || "./coi-serviceworker.js";
    sw.register(scriptSrc, { scope: "./" })
      .then((registration) => {
        registration.addEventListener("updatefound", () => {
          window.location.reload();
        });
        if (!sw.controller) {
          // First load: wait for service worker to take control, then reload
          sw.ready.then(() => {
            window.location.reload();
          });
        }
      })
      .catch((err) => {
        console.error("[coi-worker] Registration failed:", err);
      });
  }
}
