/**
 * Service Worker - Study Companion PWA
 *
 * 策略：
 *  - App Shell (HTML/JS/CSS)：stale-while-revalidate
 *  - 靜態資源 (icons/字體/KaTeX)：cache-first
 *  - AI API (Cloudflare Worker proxy)：network-only（不快取）
 *  - localStorage 不需快取（已由瀏覽器持久化）
 */

const VERSION = "v1.0.0";
const APP_CACHE = `app-${VERSION}`;
const STATIC_CACHE = `static-${VERSION}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
];

// 安裝：預先快取 App Shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

// 啟用：清掉舊版快取
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== APP_CACHE && k !== STATIC_CACHE).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// 接收前端訊息可立即切換新版
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

const isStatic = (url) =>
  /\.(?:png|jpg|jpeg|svg|webp|ico|woff2?|ttf|css)$/i.test(url.pathname) ||
  url.hostname.includes("cdn.jsdelivr.net") ||
  url.hostname.includes("fonts.googleapis.com") ||
  url.hostname.includes("fonts.gstatic.com");

const isAI = (url) =>
  url.hostname.includes("workers.dev") ||
  url.hostname.includes("anthropic.com") ||
  url.hostname.includes("googleapis.com");

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // POST 都走網路（包含 AI 呼叫）

  const url = new URL(req.url);

  // AI API：不快取
  if (isAI(url)) return;

  // 靜態資源：cache-first
  if (isStatic(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const resp = await fetch(req);
          if (resp.ok) cache.put(req, resp.clone());
          return resp;
        } catch {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // App Shell：stale-while-revalidate
  if (req.mode === "navigate" || url.origin === self.location.origin) {
    event.respondWith(
      caches.open(APP_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const fetchPromise = fetch(req)
          .then((resp) => {
            if (resp.ok) cache.put(req, resp.clone());
            return resp;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
  }
});
