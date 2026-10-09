/**
 * Bounded image cache for thumbnails.
 *
 * Why this exists
 * ---------------
 * LG TVs have only a few GB of storage for all apps. Android TV Stash clients
 * have been known to fill that space, mostly with tag and performer images:
 * Stash serves *original* images (a tag image can be several MB), every image
 * URL carries a `?t=<updated_at>` cache buster so each edit creates a brand new
 * cache entry, and the disk cache keeps the full-size originals.
 *
 * What this module does instead
 * -----------------------------
 * 1. Images are fetched with `cache: 'no-store'`, so the browser's own HTTP
 *    cache never writes them to disk.
 * 2. Each image is downscaled on a canvas to the size it is shown at (a scene
 *    card is ~400px wide) and re-encoded. A 2 MB original becomes ~20–40 KB.
 * 3. Only that small thumbnail is persisted, in IndexedDB, keyed by the image
 *    path *without* the `t=` buster. A newer version replaces the old one
 *    rather than sitting next to it.
 * 4. The store has a hard byte budget (Settings → Image cache). When it is
 *    exceeded, least-recently-used thumbnails are deleted. Budget 0 keeps
 *    thumbnails in RAM only and writes nothing to storage.
 * 5. "Last used" timestamps are only rewritten when they are older than a few
 *    hours, so browsing does not turn into a constant stream of flash writes.
 * 6. Large images (detail backdrops, sprite sheets) can be requested with
 *    `persist: false`; they live only in the RAM tier.
 *
 * The RAM tier is a small LRU of object URLs, also bounded in bytes, so the
 * app does not leak memory during long browsing sessions.
 */

const DB_NAME = 'stash-thumbs';
const STORE = 'thumbs';
const DB_VERSION = 1;

/** Max decoded-blob bytes kept as object URLs in RAM. */
const MEMORY_BUDGET = 24 * 1024 * 1024;
/** Max simultaneous image downloads (TV Wi-Fi + CPU are both limited). */
const MAX_CONCURRENT = 4;
/** Only rewrite an entry's last-used time when it is older than this. */
const TOUCH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** When evicting, go this far below the budget to avoid evicting on every write. */
const EVICT_TARGET = 0.85;
/** Images smaller than this (bytes) and already small enough are stored as-is. */
const PASSTHROUGH_BYTES = 48 * 1024;

/** @type {IDBDatabase|null} */
let db = null;
let dbReady = null;
let budgetBytes = 50 * 1024 * 1024;
let storedBytes = 0;
let authHeaders = {};

/** RAM tier: key → { url, bytes, version }. Map keeps insertion order = LRU order. */
const memory = new Map();
let memoryBytes = 0;

/** Downloads in progress, keyed by cache key, so duplicates share one fetch. */
const inflight = new Map();

/** Pending load jobs (LIFO: the most recently requested image is usually the one on screen). */
const queue = [];
let active = 0;

let webpSupported = null;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * Opens the store and enforces the budget. Safe to call more than once.
 * @param {Object} opts
 * @param {number} opts.budgetBytes  persistent budget; 0 disables persistence
 * @param {Object} [opts.headers]    auth headers for image requests
 */
export function initImageCache(opts) {
  budgetBytes = Math.max(0, opts.budgetBytes || 0);
  authHeaders = opts.headers || {};
  if (!dbReady) dbReady = openDb().then(scanSize).then(upgradeFormat).catch((e) => {
    console.warn('image cache: IndexedDB unavailable, using RAM only', e);
    db = null;
  });
  return dbReady.then(() => evictIfNeeded());
}

/** Updates auth headers (after the API key changes). */
export function setImageAuthHeaders(headers) {
  authHeaders = headers || {};
}

/** Changes the persistent budget and evicts down to it immediately. */
export function setCacheBudget(bytes) {
  budgetBytes = Math.max(0, bytes);
  return (dbReady || Promise.resolve()).then(() => (budgetBytes === 0 ? clearImageCache() : evictIfNeeded()));
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('no indexedDB'));
      return;
    }
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('used', 'used');
    };
    req.onsuccess = () => {
      db = req.result;
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Version of what the store holds. Bump it when stored thumbnails become
 * wrong for a new app version; the store is then emptied once.
 * 2 (0.4.0): animated images are no longer flattened to their first frame.
 */
const CACHE_FORMAT = 2;
const FORMAT_KEY = 'stash.imageCacheFormat';

function upgradeFormat() {
  let stored = 0;
  try {
    stored = parseInt(window.localStorage.getItem(FORMAT_KEY) || '0', 10);
  } catch (e) { /* no storage: nothing to upgrade */ }
  if (stored >= CACHE_FORMAT) return Promise.resolve();
  return clearImageCache().then(() => {
    try {
      window.localStorage.setItem(FORMAT_KEY, String(CACHE_FORMAT));
    } catch (e) { /* ignore */ }
  });
}

/** Sums the stored bytes once at startup (cursor over sizes only). */
function scanSize() {
  return new Promise((resolve) => {
    storedBytes = 0;
    if (!db) {
      resolve();
      return;
    }
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        storedBytes += cur.value.bytes || 0;
        cur.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// ---------------------------------------------------------------------------
// Public queries / maintenance
// ---------------------------------------------------------------------------

/** Current usage, for the Settings screen. */
export function cacheStats() {
  return {
    storedBytes,
    budgetBytes,
    memoryBytes,
    memoryEntries: memory.size,
    persistent: !!db,
  };
}

/** Deletes every stored thumbnail and drops the RAM tier. */
export function clearImageCache() {
  for (const entry of memory.values()) URL.revokeObjectURL(entry.url);
  memory.clear();
  memoryBytes = 0;
  if (!db) {
    storedBytes = 0;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => {
      storedBytes = 0;
      resolve();
    };
    tx.onerror = () => resolve();
  });
}

/** Deletes least-recently-used entries until under the budget. */
function evictIfNeeded() {
  if (!db || storedBytes <= budgetBytes) return Promise.resolve();
  const target = budgetBytes * EVICT_TARGET;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).index('used').openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur && storedBytes > target) {
        storedBytes -= cur.value.bytes || 0;
        cur.delete();
        cur.continue();
      }
    };
    tx.oncomplete = () => {
      storedBytes = Math.max(0, storedBytes);
      resolve();
    };
    tx.onerror = () => resolve();
  });
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * Splits an image URL into a stable cache key and a version.
 * The key ignores the host (so a changed server IP keeps the cache), the
 * `t` cache-buster and any `apikey`. The version is the `t` value.
 * @param {string} url
 * @param {number} width target width, part of the key
 */
function keyFor(url, width) {
  try {
    const u = new URL(url);
    const version = u.searchParams.get('t') || '';
    u.searchParams.delete('t');
    u.searchParams.delete('apikey');
    const rest = u.searchParams.toString();
    return { key: `${u.pathname}${rest ? '?' + rest : ''}@${width}`, version };
  } catch (e) {
    return { key: `${url}@${width}`, version: '' };
  }
}

// ---------------------------------------------------------------------------
// RAM tier
// ---------------------------------------------------------------------------

function memoryGet(key, version) {
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.version !== version) {
    memoryDelete(key);
    return null;
  }
  // re-insert to mark as most recently used
  memory.delete(key);
  memory.set(key, entry);
  return entry.url;
}

function memoryPut(key, version, blob) {
  memoryDelete(key);
  const url = URL.createObjectURL(blob);
  memory.set(key, { url, bytes: blob.size, version });
  memoryBytes += blob.size;
  while (memoryBytes > MEMORY_BUDGET && memory.size > 1) {
    const oldest = memory.keys().next().value;
    memoryDelete(oldest);
  }
  return url;
}

function memoryDelete(key) {
  const entry = memory.get(key);
  if (!entry) return;
  // Images already decoded on screen keep showing after the URL is revoked.
  URL.revokeObjectURL(entry.url);
  memoryBytes -= entry.bytes;
  memory.delete(key);
}

// ---------------------------------------------------------------------------
// Persistent tier
// ---------------------------------------------------------------------------

function dbGet(key) {
  if (!db) return Promise.resolve(null);
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(STORE, 'readonly');
    } catch (e) {
      resolve(null);
      return;
    }
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

function dbPut(record, previousBytes) {
  if (!db || budgetBytes === 0) return;
  // Never let a single image take more than a tenth of the budget.
  if (record.bytes > budgetBytes / 10) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => {
      storedBytes += record.bytes - (previousBytes || 0);
      evictIfNeeded();
    };
  } catch (e) {
    // QuotaExceeded or similar: shrink and carry on.
    evictIfNeeded();
  }
}

function dbTouch(record) {
  if (!db || Date.now() - record.used < TOUCH_INTERVAL_MS) return;
  record.used = Date.now();
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(record);
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Download + resize
// ---------------------------------------------------------------------------

function supportsWebp() {
  if (webpSupported === null) {
    try {
      const c = document.createElement('canvas');
      c.width = 1;
      c.height = 1;
      webpSupported = c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
    } catch (e) {
      webpSupported = false;
    }
  }
  return webpSupported;
}

/** Decodes a blob into an <img> element. */
function decode(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode failed'));
    };
    img.src = url;
  });
}

/** Animated images larger than this are shown as a still to spare RAM. */
const MAX_ANIMATED_BYTES = 8 * 1024 * 1024;

/** Reads the first `max` bytes of a blob (Blob.arrayBuffer needs Chromium 76). */
function readBytes(blob, max) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => resolve(new Uint8Array(0));
    reader.readAsArrayBuffer(max ? blob.slice(0, max) : blob);
  });
}

/** Index of an ASCII marker in bytes, or -1. */
function findAscii(bytes, text, from, to) {
  const end = Math.min(bytes.length - text.length, to === undefined ? bytes.length : to);
  outer: for (let i = from || 0; i <= end; i += 1) { // eslint-disable-line no-labels
    for (let k = 0; k < text.length; k += 1) {
      if (bytes[i + k] !== text.charCodeAt(k)) continue outer; // eslint-disable-line no-labels
    }
    return i;
  }
  return -1;
}

/**
 * True for animated GIF, WebP and PNG (APNG) images.
 * - GIF: more than one Graphic Control Extension (one per frame)
 * - WebP: an ANIM chunk in the header
 * - PNG: an acTL chunk before the image data
 * @param {Blob} blob
 */
export async function isAnimated(blob) {
  const type = blob.type || '';
  if (/gif/.test(type)) {
    const b = await readBytes(blob);
    let frames = 0;
    for (let i = 0; i < b.length - 2; i += 1) {
      if (b[i] === 0x21 && b[i + 1] === 0xf9 && b[i + 2] === 0x04) {
        frames += 1;
        if (frames > 1) return true;
      }
    }
    return false;
  }
  if (/webp/.test(type)) {
    const b = await readBytes(blob, 256);
    return findAscii(b, 'ANIM') >= 0;
  }
  if (/png/.test(type)) {
    const b = await readBytes(blob, 64 * 1024);
    const idat = findAscii(b, 'IDAT');
    return findAscii(b, 'acTL', 0, idat < 0 ? undefined : idat) >= 0;
  }
  return false;
}

/**
 * Downscales an image blob to `width` pixels wide.
 * @param {Blob} blob
 * @param {number} width
 * @param {boolean} alpha  keep transparency (logos, tag icons)
 * @param {number} quality JPEG/WebP quality 0–1
 * @returns {Promise<Blob>}
 */
async function shrink(blob, width, alpha, quality) {
  const isSvg = /svg/.test(blob.type);
  // SVGs are tiny already; small images that already fit are kept untouched.
  if (isSvg) return blob;
  // Redrawing on a canvas keeps only the first frame, so animated images
  // (e.g. animated tag thumbnails) are kept as they are, unless huge.
  if (blob.size <= MAX_ANIMATED_BYTES && await isAnimated(blob)) return blob;
  const img = await decode(blob);
  const w = img.naturalWidth || img.width;
  const hgt = img.naturalHeight || img.height;
  if (!w || !hgt) return blob;
  if (w <= width && blob.size <= PASSTHROUGH_BYTES) return blob;

  const scale = Math.min(1, width / w);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(hgt * scale));
  const ctx = canvas.getContext('2d');
  if (!alpha) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const type = alpha ? (supportsWebp() ? 'image/webp' : 'image/png') : 'image/jpeg';
  const out = await new Promise((resolve) => {
    if (canvas.toBlob) canvas.toBlob(resolve, type, quality);
    else resolve(null);
  });
  // Free the canvas backing store right away (matters on low-RAM TVs).
  canvas.width = 0;
  canvas.height = 0;
  return out && out.size < blob.size ? out : blob;
}

/**
 * Resolves an image to an object URL, going RAM → IndexedDB → network.
 * @param {string} url
 * @param {{width: number, alpha?: boolean, quality?: number, persist?: boolean}} opts
 * @returns {Promise<string>} object URL
 */
export function resolveImage(url, opts) {
  const width = opts.width || 400;
  const { key, version } = keyFor(url, width);

  const hit = memoryGet(key, version);
  if (hit) return Promise.resolve(hit);
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    const persist = opts.persist !== false && budgetBytes > 0;
    let previousBytes = 0;
    if (persist) {
      const rec = await dbGet(key);
      if (rec && rec.version === version && rec.blob) {
        dbTouch(rec);
        return memoryPut(key, version, rec.blob);
      }
      if (rec) previousBytes = rec.bytes || 0; // stale version: will be replaced
    }

    const res = await fetch(url, { headers: authHeaders, cache: 'no-store', credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Without valid credentials Stash redirects to its login page (HTML);
    // never treat that, or anything else that isn't an image, as a thumbnail.
    const type = res.headers.get('Content-Type') || '';
    if (type.indexOf('image/') !== 0) throw new Error(`not an image (${type || 'unknown type'})`);
    const original = await res.blob();
    let small;
    try {
      small = await shrink(original, width, !!opts.alpha, opts.quality || 0.8);
    } catch (e) {
      // Undecodable: show nothing rather than storing a possibly huge original.
      throw new Error('image could not be decoded');
    }
    if (persist) {
      dbPut({ key, version, blob: small, bytes: small.size, used: Date.now() }, previousBytes);
    }
    return memoryPut(key, version, small);
  })();

  inflight.set(key, job);
  const done = () => inflight.delete(key);
  job.then(done, done);
  return job;
}

// ---------------------------------------------------------------------------
// <img> binding with lazy loading
// ---------------------------------------------------------------------------

/**
 * Loads images only when near the viewport, and drops the pixels of images
 * that scroll far away, so long grids don't hold thousands of decoded bitmaps.
 */
const observer = typeof IntersectionObserver !== 'undefined'
  ? new IntersectionObserver(onIntersect, { rootMargin: '60% 60%' })
  : null;

function onIntersect(entries) {
  for (const entry of entries) {
    const img = entry.target;
    if (entry.isIntersecting || entry.intersectionRatio > 0) {
      if (!img.__loaded && !img.__queued) enqueue(img);
    } else if (img.__loaded) {
      // Far off screen: release the bitmap; it will reload (from RAM or
      // IndexedDB, not the network) if the user comes back.
      img.removeAttribute('src');
      img.classList.remove('loaded');
      img.__loaded = false;
    }
  }
}

function enqueue(img) {
  img.__queued = true;
  queue.push(img);
  // Deferred so an image created and appended in the same task is in the
  // document by the time the queue runs.
  Promise.resolve().then(pump);
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const img = queue.pop(); // LIFO
    img.__queued = false;
    // (Node.isConnected needs Chromium 54, so use contains())
    if (!img.__req || img.__loaded || !document.documentElement.contains(img)) continue;
    active += 1;
    const req = img.__req;
    resolveImage(req.url, req.opts)
      .then((objectUrl) => {
        if (img.__req !== req) return; // element was re-bound meanwhile
        img.onload = () => img.classList.add('loaded');
        img.src = objectUrl;
        img.__loaded = true;
      })
      .catch(() => {
        img.classList.add('failed');
      })
      .then(() => {
        active -= 1;
        pump();
      });
  }
}

/**
 * Binds an <img> element to a Stash image URL. The image loads when it nears
 * the viewport.
 * @param {HTMLImageElement} img
 * @param {string|null} url
 * @param {{width: number, alpha?: boolean, quality?: number, persist?: boolean, eager?: boolean}} opts
 */
export function bindImage(img, url, opts) {
  if (!url) {
    img.classList.add('failed');
    return;
  }
  img.__req = { url, opts };
  img.__loaded = false;
  if (observer && !opts.eager) {
    observer.observe(img);
  } else {
    enqueue(img);
  }
}

/** Stops observing every image inside a removed subtree. */
export function releaseImages(root) {
  if (!observer) return;
  const imgs = root.querySelectorAll('img');
  for (let i = 0; i < imgs.length; i += 1) {
    observer.unobserve(imgs[i]);
    imgs[i].__req = null;
  }
}
