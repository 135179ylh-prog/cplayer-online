const CACHE_NAME = 'cplayer5-v61-font-footprint-optimization';
const COVER_CACHE_LIMIT = 160;
const DYNAMIC_API_PATH_SEGMENTS = new Set([
  '163_search',
  '163_music',
  '163_lyric',
  '163_playlist'
]);

// 核心资源 - 安装时缓存
const CORE_ASSETS = [
  './index.html',
  './playlist.js',
  './css/all.min.css',
  './css/noto-sans-sc.css',
  './css/tailwind.css',
  './js/color-thief.umd.js',
  './js/app.js',
  './js/core-utils.js',
  './img/icon.svg',
  './img/icon.png',
  './manifest.json'
];

function isAppShellNavigation(url) {
  const scope = new URL(self.registration.scope);
  const indexPath = new URL('./index.html', scope).pathname;
  return url.origin === scope.origin &&
    (url.pathname === scope.pathname || url.pathname === indexPath);
}

function isDynamicMusicApi(url) {
  return url.pathname
    .split('/')
    .some((segment) => DYNAMIC_API_PATH_SEGMENTS.has(segment));
}

async function cacheCoreAssets(cache) {
  const failedAssets = [];
  await Promise.all(CORE_ASSETS.map(async (asset) => {
    const request = new Request(new URL(asset, self.registration.scope), { cache: 'reload' });
    try {
      const response = await fetch(request);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      await cache.put(request, response);
    } catch (error) {
      const previous = await cache.match(request);
      if (previous) {
        await cache.put(request, previous);
      } else {
        failedAssets.push(asset);
      }
    }
  }));
  if (failedAssets.length) {
    throw new Error('核心资源缓存失败: ' + failedAssets.join(', '));
  }
}

async function trimCoverCache(cache) {
  const keys = await cache.keys();
  const covers = keys.filter((request) => new URL(request.url).hostname.includes('music.126.net'));
  const overflow = covers.length - COVER_CACHE_LIMIT;
  if (overflow > 0) {
    await Promise.all(covers.slice(0, overflow).map((request) => cache.delete(request)));
  }
}

async function storeRuntimeResponse(request, response, trimCovers) {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response);
    if (trimCovers) await trimCoverCache(cache);
  } catch (error) {
    console.warn('SW: 运行时缓存写入失败', error);
  }
}

// 安装：缓存核心资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cacheCoreAssets(cache))
  );
  self.skipWaiting();
});

// 激活：清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter(k => k.startsWith('cplayer5-') && k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => caches.open(CACHE_NAME))
      .then((cache) => trimCoverCache(cache))
      .then(() => self.clients.claim())
  );
});

// 请求策略
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // 带密钥或动态音乐接口的请求可能使用任意自定义域名，始终直连且不读写缓存
  if (url.searchParams.has('apikey') || isDynamicMusicApi(url)) {
    event.respondWith(fetch(event.request));
    return;
  }

  // API 请求：始终网络优先，不缓存
  if (url.hostname === 'api.chksz.top' || url.hostname === 'api.chksz.com' || url.hostname.endsWith('.chksz.top') || url.hostname.endsWith('.chksz.com')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 封面图片：缓存优先 (网易云 CDN)
  if (url.hostname.includes('music.126.net') && url.pathname.match(/\.(jpg|jpeg|png|webp)/i)) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => cache.match(event.request)).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(async resp => {
          if (resp.ok) {
            const clone = resp.clone();
            await storeRuntimeResponse(event.request, clone, true);
          }
          return resp;
        }).catch(() => new Response('', { status: 404 }));
      })
    );
    return;
  }

  // 音频流：不缓存；网易云 CDN 上没有明确图片扩展名的资源也保持网络直取
  if (url.pathname.match(/\.(mp3|flac|wav|ogg|m4a|aac)$/i) ||
      url.hostname.includes('music.126.net')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 页面导航：网络优先，断网时回退到最近一次可用页面
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(async (response) => {
        if (response.ok && isAppShellNavigation(url)) {
          const clone = response.clone();
          await storeRuntimeResponse('./index.html', clone, false);
        }
        return response;
      }).catch(() => caches.open(CACHE_NAME).then((cache) => cache.match('./index.html')))
    );
    return;
  }

  // 本地资源：缓存优先，回退网络
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) => cache.match(event.request)).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(async resp => {
        // 缓存成功的本地资源
        if (resp.ok && url.origin === self.location.origin) {
          const clone = resp.clone();
          await storeRuntimeResponse(event.request, clone, false);
        }
        return resp;
      }).catch(() => {
        if (event.request.mode === 'navigate') {
          return caches.open(CACHE_NAME).then((cache) => cache.match('./index.html'));
        }
        throw new Error('Network request failed');
      });
    })
  );
});
