'use strict';

const SHELL_CACHE = 'tremble-shell-v2.15.0';
const RUNTIME_CACHE = 'tremble-runtime-v2.15.0';
const OFFLINE_DOCUMENT_CACHE = 'tremble-offline-documents-v1';

const SHELL_ASSETS = [
    './',
    './index.html',
    './style.css?v=2.9.5',
    './planning.css?v=2.15.0',
    './forum.css?v=2.9.5',
    './forum_v2.css?v=2.9.5',
    './script.js?v=2.12.1',
    './planning.js?v=2.15.0',
    './forum.js?v=2.9.5',
    './forum_v2.js?v=2.9.5',
    './manifest.webmanifest',
    './site-logo.svg',
    './pwa-icon-192.png',
    './pwa-icon-512.png'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(SHELL_CACHE)
            .then(cache => cache.addAll(SHELL_ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys
            .filter(key => (key.startsWith('tremble-shell-') && key !== SHELL_CACHE) || (key.startsWith('tremble-runtime-') && key !== RUNTIME_CACHE))
            .map(key => caches.delete(key)));
        await self.clients.claim();
    })());
});

function isNavigationRequest(request) {
    return request.mode === 'navigate';
}

function isSupabaseApi(url) {
    return /\.supabase\.co$/i.test(url.hostname)
        && (url.pathname.includes('/rest/v1/') || url.pathname.includes('/auth/v1/') || url.pathname.includes('/realtime/v1/'));
}

function isPublicStorage(url) {
    return /\.supabase\.co$/i.test(url.hostname)
        && url.pathname.includes('/storage/v1/object/public/');
}

async function networkFirst(request) {
    const cache = await caches.open(SHELL_CACHE);
    try {
        const response = await fetch(request);
        if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
        return response;
    } catch {
        return (await cache.match(request)) || (await cache.match('./index.html')) || Response.error();
    }
}

async function staleWhileRevalidate(request) {
    const cache = await caches.open(RUNTIME_CACHE);
    const cached = await cache.match(request);
    const network = fetch(request).then(response => {
        if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone()).catch(() => {});
        return response;
    }).catch(() => null);
    return cached || (await network) || Response.error();
}

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);

    if (isNavigationRequest(request) && url.origin === self.location.origin) {
        event.respondWith(networkFirst(request));
        return;
    }

    if (isSupabaseApi(url)) return;

    // Les documents sauvegardés hors connexion passent avant le cache réseau.
    event.respondWith((async () => {
        const offlineCache = await caches.open(OFFLINE_DOCUMENT_CACHE);
        const saved = await offlineCache.match(request, { ignoreVary: true });
        if (saved) return saved;

        if (isPublicStorage(url)) return fetch(request);
        if (url.origin === self.location.origin || /cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/i.test(url.hostname)) {
            return staleWhileRevalidate(request);
        }
        return fetch(request);
    })());
});

self.addEventListener('message', event => {
    const data = event.data || {};
    const reply = payload => {
        try { event.ports?.[0]?.postMessage(payload); } catch {}
    };

    if (data.type === 'CACHE_OFFLINE_DOCUMENT') {
        event.waitUntil((async () => {
            try {
                const url = String(data.url || '');
                if (!/^https?:\/\//i.test(url)) throw new Error('Adresse de fichier invalide.');
                const response = await fetch(url, { credentials: 'omit' });
                if (!response || (!response.ok && response.type !== 'opaque')) throw new Error(`Téléchargement impossible (${response?.status || 'réseau'}).`);
                const cache = await caches.open(OFFLINE_DOCUMENT_CACHE);
                await cache.put(url, response.clone());
                reply({ ok: true });
            } catch (error) {
                reply({ ok: false, error: error?.message || 'Impossible de mettre le fichier hors connexion.' });
            }
        })());
        return;
    }

    if (data.type === 'REMOVE_OFFLINE_DOCUMENT') {
        event.waitUntil((async () => {
            try {
                const cache = await caches.open(OFFLINE_DOCUMENT_CACHE);
                await cache.delete(String(data.url || ''), { ignoreVary: true });
                reply({ ok: true });
            } catch (error) {
                reply({ ok: false, error: error?.message || 'Suppression impossible.' });
            }
        })());
    }
});
