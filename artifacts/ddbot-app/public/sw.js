// Comprehensive Service Worker for Deriv Bot Offline Functionality
const CACHE_NAME = 'app-cache-v2';
const OFFLINE_URL = '/offline.html';

// Files to cache immediately on install
const PRECACHE_URLS = ['/', '/index.html', '/offline.html', '/manifest.json', '/deriv-logo.svg'];

console.log('[SW] Service worker script loaded');

// Install event - cache essential files
self.addEventListener('install', event => {
    console.log('[SW] Installing service worker...');

    event.waitUntil(
        (async () => {
            try {
                const cache = await caches.open(CACHE_NAME);
                console.log('[SW] Caching precache URLs');

                // Cache essential files
                await cache.addAll(PRECACHE_URLS);
                console.log('[SW] Precache URLs cached successfully');

                // Force activation
                await self.skipWaiting();
                console.log('[SW] Service worker installed and skipping waiting');
            } catch (error) {
                console.error('[SW] Install failed:', error);
                // Still skip waiting even if caching fails
                await self.skipWaiting();
            }
        })()
    );
});

// Activate event - clean up old caches and take control
self.addEventListener('activate', event => {
    console.log('[SW] Activating service worker...');

    event.waitUntil(
        (async () => {
            try {
                // Delete ALL old caches (version bump ensures fresh start)
                const cacheNames = await caches.keys();
                await Promise.all(
                    cacheNames.map(cacheName => {
                        if (cacheName !== CACHE_NAME) {
                            console.log('[SW] Deleting old cache:', cacheName);
                            return caches.delete(cacheName);
                        }
                    })
                );

                // Take control of all clients
                await self.clients.claim();
                console.log('[SW] Service worker activated and claimed clients');

                // Notify all clients that SW is ready
                const clients = await self.clients.matchAll();
                clients.forEach(client => {
                    client.postMessage({
                        type: 'SW_ACTIVATED',
                        message: 'Service worker is ready for offline functionality',
                    });
                });
            } catch (error) {
                console.error('[SW] Activation failed:', error);
            }
        })()
    );
});

// Fetch event - handle all network requests
self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);

    // Skip non-GET requests
    if (request.method !== 'GET') {
        return;
    }

    // Skip chrome-extension and other non-http requests
    if (!request.url.startsWith('http')) {
        return;
    }

    // ── Critical bypass: never intercept WebSocket upgrades, API calls,
    //    or auth traffic — let them go straight to the network.
    if (
        request.url.startsWith('ws:') ||
        request.url.startsWith('wss:') ||
        url.pathname.includes('/api') ||
        url.pathname.includes('/auth')
    ) {
        return;
    }

    // Skip JavaScript chunks, CSS, and module files entirely
    if (
        url.pathname.includes('.js') ||
        url.pathname.includes('.css') ||
        url.pathname.includes('/static/js/') ||
        url.pathname.includes('/static/css/') ||
        url.pathname.includes('chunk') ||
        url.pathname.includes('.mjs')
    ) {
        return;
    }

    // Skip authentication requests
    if (isAuthRequest(url)) {
        return;
    }

    // Skip API / WS requests
    if (isApiRequest(url)) {
        return;
    }

    // Skip requests with no-cache headers
    if (request.headers.get('cache-control') === 'no-cache') {
        return;
    }

    // Skip requests with authentication headers
    if (request.headers.get('authorization') || request.headers.get('x-auth-token')) {
        return;
    }

    event.respondWith(handleRequest(request));
});

async function handleRequest(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
        if (isNavigationRequest(request)) {
            return await handleNavigation(request);
        } else if (isStaticAsset(pathname)) {
            return await handleStaticAsset(request);
        } else if (isApiRequest(url)) {
            return await handleApiRequest(request);
        } else {
            return await handleGenericRequest(request);
        }
    } catch (error) {
        console.error('[SW] Request handling failed:', error);
        return await handleOfflineFallback(request);
    }
}

// Handle navigation requests (HTML pages)
async function handleNavigation(request) {
    try {
        const networkResponse = await fetch(request);

        if (networkResponse.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, networkResponse.clone());
        }

        return networkResponse;
    } catch (error) {
        console.log('[SW] Network failed for navigation, trying cache');

        const cachedResponse = await caches.match(request);
        if (cachedResponse) return cachedResponse;

        const indexResponse = (await caches.match('/')) || (await caches.match('/index.html'));
        if (indexResponse) return indexResponse;

        const offlineResponse = await caches.match(OFFLINE_URL);
        if (offlineResponse) return offlineResponse;

        throw error;
    }
}

// Handle static assets — safe caching only (no 206, no media streams)
async function handleStaticAsset(request) {
    const response = await fetch(request);

    // Never cache invalid or partial (206 Range) responses
    if (!response || response.status !== 200) {
        return response;
    }

    const url = new URL(request.url);

    // Never cache streaming/media files
    if (url.pathname.match(/\.(mp3|mp4|wav|webm|ogg)$/i)) {
        return response;
    }

    const cache = await caches.open(CACHE_NAME);

    try {
        await cache.put(request, response.clone());
    } catch (e) {
        console.warn('[SW] Cache skipped:', e.message);
    }

    return response;
}

// Handle API requests — always network, never cache
async function handleApiRequest(request) {
    try {
        return await fetch(request);
    } catch (error) {
        return new Response(
            JSON.stringify({
                error: 'Offline',
                message: 'API not available offline',
                offline: true,
                timestamp: new Date().toISOString(),
                url: request.url,
            }),
            {
                status: 503,
                statusText: 'Service Unavailable',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Offline-Mode': 'true',
                },
            }
        );
    }
}

// Handle generic requests
async function handleGenericRequest(request) {
    try {
        const networkResponse = await fetch(request);

        // Only cache clean 200 responses (guard against 206 Partial Content)
        if (networkResponse.ok && networkResponse.status === 200) {
            const cache = await caches.open(CACHE_NAME);
            try {
                await cache.put(request, networkResponse.clone());
            } catch (e) {
                console.warn('[SW] Cache skipped:', e.message);
            }
        }

        return networkResponse;
    } catch (error) {
        const cachedResponse = await caches.match(request);
        if (cachedResponse) return cachedResponse;
        throw error;
    }
}

// Handle offline fallbacks
async function handleOfflineFallback(request) {
    if (request.headers.get('accept')?.includes('text/html')) {
        const cachedIndex = (await caches.match('/')) || (await caches.match('/index.html'));
        if (cachedIndex) return cachedIndex;

        const offlineResponse = await caches.match(OFFLINE_URL);
        if (offlineResponse) return offlineResponse;

        return new Response(
            `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Offline - CKK Edge</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0e0e0e; color: #ffffff; margin: 0; padding: 0;
            display: flex; align-items: center; justify-content: center; min-height: 100vh;
        }
        .container { text-align: center; max-width: 500px; padding: 40px 20px; }
        h1 { color: #ff444f; font-size: 2.5rem; margin-bottom: 1rem; }
        p { font-size: 1.1rem; line-height: 1.6; margin-bottom: 2rem; opacity: 0.9; }
        button {
            background: #ff444f; color: white; border: none;
            padding: 15px 30px; border-radius: 8px; cursor: pointer;
            font-size: 16px; font-weight: 600;
        }
        button:hover { background: #e63946; }
        .status {
            margin-top: 2rem; padding: 15px;
            background: rgba(255,68,79,0.1); border-radius: 8px;
            border-left: 4px solid #ff444f;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>You're Offline</h1>
        <p>CKK Edge requires an internet connection to function properly. Please check your connection and try again.</p>
        <button onclick="window.location.reload()">Try Again</button>
        <div class="status">
            <strong>Connection Status:</strong> <span id="status">Offline</span>
        </div>
    </div>
    <script>
        function updateStatus() {
            document.getElementById('status').textContent = navigator.onLine ? 'Online' : 'Offline';
        }
        window.addEventListener('online', () => { updateStatus(); setTimeout(() => window.location.reload(), 1000); });
        window.addEventListener('offline', updateStatus);
        updateStatus();
    </script>
</body>
</html>`,
            { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' } }
        );
    }

    return new Response(
        JSON.stringify({ error: 'Offline', message: 'Content not available offline', url: request.url, timestamp: new Date().toISOString() }),
        { status: 503, statusText: 'Service Unavailable', headers: { 'Content-Type': 'application/json', 'X-Offline-Mode': 'true' } }
    );
}

// Helper functions
function isNavigationRequest(request) {
    return (
        request.mode === 'navigate' ||
        (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'))
    );
}

// Only cache script, style, and image assets — skip everything else
function isStaticAsset(pathname) {
    return /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|webp|avif)$/i.test(pathname);
}

function isAuthRequest(url) {
    function isAllowedDomain(hostname, allowedDomain) {
        return hostname === allowedDomain || hostname.endsWith('.' + allowedDomain);
    }
    return (
        url.pathname.includes('/oauth') ||
        url.pathname.includes('/auth') ||
        url.pathname.includes('/login') ||
        url.pathname.includes('/logout') ||
        url.pathname.includes('/token') ||
        url.pathname.includes('/authorize') ||
        url.pathname.includes('/callback') ||
        isAllowedDomain(url.hostname, 'oauth.deriv.com') ||
        isAllowedDomain(url.hostname, 'auth.deriv.com') ||
        isAllowedDomain(url.hostname, 'accounts.deriv.com') ||
        isAllowedDomain(url.hostname, 'google.com') ||
        isAllowedDomain(url.hostname, 'googleapis.com') ||
        isAllowedDomain(url.hostname, 'facebook.com') ||
        isAllowedDomain(url.hostname, 'apple.com') ||
        isAllowedDomain(url.hostname, 'microsoft.com') ||
        isAllowedDomain(url.hostname, 'live.com') ||
        url.search.includes('code=') ||
        url.search.includes('state=') ||
        url.search.includes('token=') ||
        url.search.includes('access_token=') ||
        url.search.includes('id_token=')
    );
}

function isApiRequest(url) {
    function isAllowedDomain(hostname, allowedDomain) {
        return hostname === allowedDomain || hostname.endsWith('.' + allowedDomain);
    }
    return (
        url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/v1/') ||
        url.pathname.startsWith('/v2/') ||
        isAllowedDomain(url.hostname, 'deriv.com') ||
        isAllowedDomain(url.hostname, 'deriv.me') ||
        isAllowedDomain(url.hostname, 'binary.com') ||
        url.hostname.startsWith('api.') ||
        url.protocol === 'ws:' ||
        url.protocol === 'wss:' ||
        url.hostname.startsWith('ws.') ||
        url.hostname.includes('websocket') ||
        url.hostname.includes('analytics') ||
        url.hostname.includes('tracking') ||
        url.hostname.includes('metrics')
    );
}

// Handle messages from main thread
self.addEventListener('message', event => {
    const { type } = event.data || {};

    switch (type) {
        case 'SKIP_WAITING':
            self.skipWaiting();
            break;
        case 'GET_CACHE_STATUS':
            getCacheStatus().then(status => {
                event.ports[0]?.postMessage({ type: 'CACHE_STATUS', data: status });
            });
            break;
        case 'CLEAR_CACHE':
            clearCache().then(() => {
                event.ports[0]?.postMessage({ type: 'CACHE_CLEARED' });
            });
            break;
    }
});

async function getCacheStatus() {
    try {
        const cache = await caches.open(CACHE_NAME);
        const keys = await cache.keys();
        return { cacheName: CACHE_NAME, cachedUrls: keys.map(r => r.url), cacheSize: keys.length };
    } catch (error) {
        return { error: error.message };
    }
}

async function clearCache() {
    try {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(name => caches.delete(name)));
        console.log('[SW] All caches cleared');
    } catch (error) {
        console.error('[SW] Failed to clear cache:', error);
    }
}

console.log('[SW] Service worker setup complete');
