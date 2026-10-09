/**
 * Full-screen image viewer with slideshow.
 *
 * Remote controls
 * - Left/Right: previous/next image (loads further pages of the grid it was
 *   opened from as needed)
 * - OK or Up/Down: show/hide the details panel
 * - Play: start the slideshow; Pause/Stop/OK: stop it; Play/Pause toggles
 * - Back: hide the details, else leave the viewer
 *
 * Storage: full-size images are never written to storage. Each one is
 * downloaded once, scaled down to the screen size on a canvas (a 24 MP
 * photo would otherwise need ~100 MB of RAM to display) and kept only in
 * the small in-memory tier of the image cache. Animated GIFs are shown as
 * downloaded so they keep moving; clips play in a <video>.
 */
import { Screen } from '../ui/router.js';
import { h, icon } from '../util/dom.js';
import { KEY, isBack } from '../util/keys.js';
import { resolveImage } from '../cache/imageCache.js';
import { getClient } from '../api/stash.js';
import { getSettings } from '../settings.js';
import {
  formatBytes, formatDate, galleryTitle, imageKind, imageTitle,
} from '../util/format.js';
import { toast } from '../ui/overlay.js';

/** Largest animated GIF shown in full; bigger ones are shown as a still. */
const MAX_GIF_BYTES = 12 * 1024 * 1024;

export class ViewerScreen extends Screen {
  /**
   * @param {Object|null} image  the image to open (or null with ctx.index)
   * @param {Object} ctx
   * @param {Array} ctx.items          images to step through (includes `image`)
   * @param {number} [ctx.index]       position of `image` in items
   * @param {number} [ctx.count]       total number of images, when paged
   * @param {number} [ctx.perPage]     page size used by fetchPage
   * @param {(page: number, perPage: number) => Promise<{count: number, items: Array}>} [ctx.fetchPage]
   * @param {boolean} [ctx.slideshow]  start the slideshow immediately
   */
  constructor(image, ctx) {
    super();
    this.fullscreen = true;
    this.el.classList.add('screen-viewer', 'no-scroll');
    const c = ctx || {};
    // `items` may be shorter than `index` (e.g. opening a gallery chapter that
    // is not loaded yet); missing entries are fetched by page on demand.
    this.items = c.items ? c.items.slice() : [image];
    this.index = Math.max(0, c.index !== undefined && c.index >= 0 ? c.index : this.items.indexOf(image));
    this.count = c.count || this.items.length;
    this.perPage = c.perPage || 40;
    this.fetchPage = c.fetchPage || null;
    this.loadingPage = null;
    this.slideTimer = null;
    this.playing = false;
    this.generation = 0;
    this.gifUrl = null;

    this.img = h('img', { class: 'viewer-img', alt: '' });
    this.video = h('video', { class: 'viewer-video', loop: true, playsinline: true });
    this.spinner = h('div', { class: 'player-spinner' });
    this.counter = h('div', { class: 'viewer-counter' });
    this.state = h('div', { class: 'viewer-state' });
    this.infoTitle = h('h1', { class: 'viewer-title' });
    this.infoFacts = h('div', { class: 'detail-facts' });
    this.info = h('div', { class: 'viewer-info' }, [this.infoTitle, this.infoFacts]);
    this.hint = h('div', { class: 'viewer-hint' }, 'Left/Right to browse · OK for details · Play for a slideshow');

    this.el.appendChild(this.img);
    this.el.appendChild(this.video);
    this.el.appendChild(this.spinner);
    this.el.appendChild(h('div', { class: 'viewer-top' }, [this.counter, this.state]));
    this.el.appendChild(this.info);
    this.el.appendChild(this.hint);
    this.startSlideshow = !!c.slideshow;
  }

  mount() {
    this.show(this.index);
    if (this.startSlideshow) this.play();
    // The hint fades out after a few seconds; it is only a reminder.
    this.hintTimer = setTimeout(() => this.hint.classList.add('hidden'), 4000);
  }

  focusDefault() {}

  destroy() {
    this.destroyed = true;
    this.stop(true);
    clearTimeout(this.hintTimer);
    this.video.pause();
    this.video.removeAttribute('src');
    try { this.video.load(); } catch (e) { /* ignore */ }
    this.releaseGif();
    super.destroy();
  }

  onHide() {
    this.stop(true);
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /** Total number of images we can step through. */
  total() {
    return Math.max(this.count, this.items.length);
  }

  /**
   * Returns the item at `i`, fetching its page first when needed.
   * @returns {Promise<Object|null>}
   */
  async itemAt(i) {
    if (this.items[i]) return this.items[i];
    if (!this.fetchPage || i >= this.total()) return null;
    const page = Math.floor(i / this.perPage) + 1;
    if (!this.loadingPage) {
      this.loadingPage = this.fetchPage(page, this.perPage).then((res) => {
        const start = (page - 1) * this.perPage;
        res.items.forEach((it, k) => {
          this.items[start + k] = it;
        });
        this.count = res.count;
      }).finally(() => {
        this.loadingPage = null;
      });
    }
    await this.loadingPage;
    return this.items[i] || null;
  }

  /** Full-size URL with the API key, for <video> which can't send headers. */
  withKey(url) {
    const key = getClient().apiKey;
    if (!key) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'apikey=' + encodeURIComponent(key);
  }

  /** Screen-sized decode of a photo, memory only. */
  photoUrl(item) {
    const w = Math.round(window.innerWidth * Math.min(2, window.devicePixelRatio || 1));
    return resolveImage(item.paths.image, { width: w, quality: 0.88, persist: false });
  }

  /** Downloads an animated GIF as-is (no resize, it would stop moving). */
  async gifObjectUrl(item) {
    const f = item.visual_files[0];
    if (f.size && f.size > MAX_GIF_BYTES) return this.photoUrl(item);
    const res = await fetch(item.paths.image, { headers: getClient().authHeaders(), cache: 'no-store', credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return URL.createObjectURL(await res.blob());
  }

  releaseGif() {
    if (this.gifUrl) URL.revokeObjectURL(this.gifUrl);
    this.gifUrl = null;
  }

  /** Displays image `i`. */
  async show(i) {
    const gen = ++this.generation;
    this.index = i;
    this.el.classList.add('loading');
    this.counter.textContent = `${i + 1} / ${this.total()}`;
    let item;
    try {
      item = await this.itemAt(i);
    } catch (err) {
      if (gen === this.generation) toast(`Couldn't load: ${err.message}`, 'error');
      return;
    }
    if (gen !== this.generation || this.destroyed || !item) return;
    this.renderInfo(item);

    const kind = imageKind(item);
    try {
      if (kind === 'video') {
        this.img.style.display = 'none';
        this.video.style.display = '';
        this.video.src = this.withKey(item.paths.image);
        const p = this.video.play();
        if (p && p.catch) p.catch(() => {});
        this.el.classList.remove('loading');
      } else {
        this.video.pause();
        this.video.style.display = 'none';
        const url = kind === 'gif' ? await this.gifObjectUrl(item) : await this.photoUrl(item);
        if (gen !== this.generation || this.destroyed) {
          if (kind === 'gif' && url.indexOf('blob:') === 0) URL.revokeObjectURL(url);
          return;
        }
        this.releaseGif();
        if (kind === 'gif') this.gifUrl = url;
        this.img.style.display = '';
        this.img.src = url;
        this.el.classList.remove('loading');
      }
    } catch (err) {
      if (gen !== this.generation) return;
      this.el.classList.remove('loading');
      toast(`Couldn't show this image: ${err.message}`, 'error');
    }
    this.preload(i + 1);
    if (this.playing) this.scheduleNext();
  }

  /** Warms the next photo so the slideshow and Right feel instant. */
  async preload(i) {
    if (i >= this.total()) return;
    try {
      const item = await this.itemAt(i);
      if (item && imageKind(item) === 'photo') this.photoUrl(item).catch(() => {});
    } catch (e) { /* best effort */ }
  }

  renderInfo(item) {
    const f = item.visual_files && item.visual_files[0];
    const facts = [
      formatDate(item.date),
      item.studio ? item.studio.name : null,
      item.performers && item.performers.length ? item.performers.map((p) => p.name).join(', ') : null,
      item.galleries && item.galleries.length ? galleryTitle(item.galleries[0]) : null,
      f && f.width ? `${f.width}×${f.height}` : null,
      f && f.size ? formatBytes(f.size) : null,
    ].filter(Boolean);
    this.infoTitle.textContent = imageTitle(item);
    this.infoFacts.innerHTML = '';
    for (const x of facts) this.infoFacts.appendChild(h('span', null, x));
  }

  // -------------------------------------------------------------------------
  // Navigation / slideshow
  // -------------------------------------------------------------------------

  step(delta) {
    const total = this.total();
    if (total <= 1) return;
    let next = this.index + delta;
    if (next < 0) next = total - 1;
    if (next >= total) next = 0;
    this.show(next);
  }

  play() {
    this.playing = true;
    this.el.classList.add('playing');
    this.state.innerHTML = '';
    this.state.appendChild(icon('play'));
    this.state.appendChild(document.createTextNode(` Slideshow, ${getSettings().slideshowSeconds}s`));
    this.scheduleNext();
  }

  /** Stops the slideshow; `quiet` skips the on-screen state change. */
  stop(quiet) {
    this.playing = false;
    clearTimeout(this.slideTimer);
    if (quiet) return;
    this.el.classList.remove('playing');
    this.state.textContent = '';
  }

  scheduleNext() {
    clearTimeout(this.slideTimer);
    this.slideTimer = setTimeout(() => {
      if (this.playing) this.step(1);
    }, getSettings().slideshowSeconds * 1000);
  }

  toggleInfo() {
    this.el.classList.toggle('show-info');
  }

  onKey(e) {
    if (isBack(e)) return false;
    this.hint.classList.add('hidden');
    switch (e.keyCode) {
      case KEY.LEFT:
      case KEY.REWIND:
        this.step(-1);
        if (this.playing) this.scheduleNext();
        return true;
      case KEY.RIGHT:
      case KEY.FAST_FORWARD:
        this.step(1);
        if (this.playing) this.scheduleNext();
        return true;
      case KEY.PLAY:
        this.play();
        return true;
      case KEY.PAUSE:
      case KEY.STOP:
        this.stop();
        return true;
      case KEY.PLAY_PAUSE:
      case KEY.SPACE:
        if (this.playing) this.stop();
        else this.play();
        return true;
      case KEY.ENTER:
        if (this.playing) this.stop();
        else this.toggleInfo();
        return true;
      case KEY.UP:
      case KEY.DOWN:
        this.toggleInfo();
        return true;
      default:
        return true; // nothing else is navigable here
    }
  }

  onBack() {
    if (this.el.classList.contains('show-info')) {
      this.toggleInfo();
      return true;
    }
    return false;
  }
}
