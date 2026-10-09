/**
 * Full-screen image viewer: slideshow, zoom, rotate and quick edits.
 *
 * Remote controls (panel hidden)
 * - Left/Right: previous/next image (loads further pages of the grid it was
 *   opened from as needed); when zoomed in, they move around the image
 * - Up/Down: show the panel; when zoomed in, move around the image
 * - OK: show the panel (or stop a running slideshow)
 * - Play: start the slideshow; Pause/Stop: stop it; Play/Pause toggles
 * - Back: zoomed in → back to the whole image; else leave the viewer
 *
 * The panel shows the image's details and buttons for Zoom in/out, Rotate,
 * Slideshow and Edit; Back hides it.
 *
 * Storage: full-size images are never written to storage. Each one is
 * downloaded once, scaled to the screen on a canvas (a 24 MP photo would
 * otherwise need ~100 MB of RAM to display) and kept only in the small
 * in-memory tier of the image cache. Zooming in fetches a sharper decode,
 * capped at 4096 px, also memory only. Animated GIFs are shown as
 * downloaded so they keep moving; clips play in a <video>.
 *
 * Rotation is for viewing only; it is not saved to Stash.
 */
import { Screen } from '../ui/router.js';
import { h, icon } from '../util/dom.js';
import { KEY, isBack } from '../util/keys.js';
import { resolveImage } from '../cache/imageCache.js';
import { getClient } from '../api/stash.js';
import { getSettings } from '../settings.js';
import { focus, focusFirst } from '../nav/focus.js';
import {
  formatBytes, formatDate, galleryTitle, imageKind, imageTitle, stars,
} from '../util/format.js';
import { toast } from '../ui/overlay.js';
import { canEdit, openEditor } from '../ui/editor.js';

/** Largest animated GIF shown in full; bigger ones are shown as a still. */
const MAX_GIF_BYTES = 12 * 1024 * 1024;
/** Zoom steps. */
const ZOOMS = [1, 1.5, 2, 3, 4];
/** Largest decode used for zooming, in pixels. */
const MAX_DECODE = 4096;
/** Fraction of the screen moved per arrow press when panning. */
const PAN_STEP = 0.2;

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
    this.item = null;

    // View transform
    this.zoomIndex = 0;
    this.rotation = 0;
    this.panX = 0;
    this.panY = 0;
    this.decodedWidth = 0;

    this.img = h('img', { class: 'viewer-img', alt: '' });
    this.img.onload = () => this.layout();
    this.video = h('video', { class: 'viewer-video', loop: true, playsinline: true });
    this.video.addEventListener('loadedmetadata', () => this.layout());
    this.spinner = h('div', { class: 'player-spinner' });
    this.counter = h('div', { class: 'viewer-counter' });
    this.state = h('div', { class: 'viewer-state' });
    this.infoTitle = h('h1', { class: 'viewer-title' });
    this.infoFacts = h('div', { class: 'detail-facts' });

    this.zoomOutButton = this.action('zoomOut', 'Zoom out', () => this.zoomBy(-1));
    this.slideButton = this.action('play', 'Slideshow', () => {
      this.hidePanel();
      this.play();
    });
    this.editButton = this.action('edit', 'Edit', () => this.edit());
    this.actions = h('div', { class: 'viewer-actions nav-group', 'data-no-memory': true }, [
      this.action('zoomIn', 'Zoom in', () => this.zoomBy(1)),
      this.zoomOutButton,
      this.action('rotate', 'Rotate', () => this.rotate()),
      this.slideButton,
      this.editButton,
    ]);
    this.info = h('div', { class: 'viewer-info' }, [this.infoTitle, this.infoFacts, this.actions]);
    this.hint = h('div', { class: 'viewer-hint' }, 'Left/Right to browse · OK for zoom, rotate and details · Play for a slideshow');

    this.el.appendChild(this.img);
    this.el.appendChild(this.video);
    this.el.appendChild(this.spinner);
    this.el.appendChild(h('div', { class: 'viewer-top' }, [this.counter, this.state]));
    this.el.appendChild(this.info);
    this.el.appendChild(this.hint);
    this.startSlideshow = !!c.slideshow;
    this.onResize = () => this.layout();
  }

  /** A panel button (same look as the player controls). */
  action(iconName, label, fn) {
    return h('div', { class: 'ctrl focusable', onSelect: fn }, [icon(iconName), h('span', { class: 'ctrl-label' }, label)]);
  }

  mount() {
    window.addEventListener('resize', this.onResize);
    this.editButton.style.display = canEdit() ? '' : 'none';
    this.show(this.index);
    if (this.startSlideshow) this.play();
    // The hint fades out after a few seconds; it is only a reminder.
    this.hintTimer = setTimeout(() => this.hint.classList.add('hidden'), 4000);
  }

  focusDefault() {}

  destroy() {
    this.destroyed = true;
    window.removeEventListener('resize', this.onResize);
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

  /** Decode width for the current zoom (screen width × zoom, capped). */
  wantedWidth() {
    const base = window.innerWidth * Math.min(2, window.devicePixelRatio || 1);
    return Math.min(MAX_DECODE, Math.round(base * ZOOMS[this.zoomIndex]));
  }

  /** Screen-sized (or zoom-sized) decode of a photo, memory only. */
  photoUrl(item, width) {
    return resolveImage(item.paths.image, { width: width || this.wantedWidth(), quality: 0.88, persist: false });
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

  /** Displays image `i` (view resets to the whole, unrotated image). */
  async show(i) {
    const gen = ++this.generation;
    this.index = i;
    this.resetView();
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
    this.item = item;
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
        const width = this.wantedWidth();
        const url = kind === 'gif' ? await this.gifObjectUrl(item) : await this.photoUrl(item, width);
        if (gen !== this.generation || this.destroyed) {
          if (kind === 'gif' && url.indexOf('blob:') === 0) URL.revokeObjectURL(url);
          return;
        }
        this.releaseGif();
        if (kind === 'gif') this.gifUrl = url;
        this.decodedWidth = kind === 'gif' ? Infinity : width;
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
      if (item && imageKind(item) === 'photo') this.photoUrl(item, this.wantedWidthAt(0)).catch(() => {});
    } catch (e) { /* best effort */ }
  }

  /** Decode width at a given zoom step (used for preloading at 1×). */
  wantedWidthAt(zoomIndex) {
    const base = window.innerWidth * Math.min(2, window.devicePixelRatio || 1);
    return Math.min(MAX_DECODE, Math.round(base * ZOOMS[zoomIndex]));
  }

  renderInfo(item) {
    const f = item.visual_files && item.visual_files[0];
    const rating = stars(item.rating100);
    const facts = [
      formatDate(item.date),
      item.studio ? item.studio.name : null,
      item.performers && item.performers.length ? item.performers.map((p) => p.name).join(', ') : null,
      item.galleries && item.galleries.length ? galleryTitle(item.galleries[0]) : null,
      f && f.width ? `${f.width}×${f.height}` : null,
      f && f.size ? formatBytes(f.size) : null,
      rating ? `${rating} ★` : null,
      item.o_counter ? `O ${item.o_counter}` : null,
    ].filter(Boolean);
    this.infoTitle.textContent = imageTitle(item);
    this.infoFacts.innerHTML = '';
    for (const x of facts) this.infoFacts.appendChild(h('span', null, x));
    // Editing needs a real Stash image (group covers shown here are not).
    this.editButton.style.display = canEdit() && /^\d+$/.test(String(item.id)) ? '' : 'none';
  }

  // -------------------------------------------------------------------------
  // Zoom, rotate, pan
  // -------------------------------------------------------------------------

  resetView() {
    this.zoomIndex = 0;
    this.rotation = 0;
    this.panX = 0;
    this.panY = 0;
    this.el.classList.remove('zoomed');
    this.layout();
  }

  /** The visible media element and its natural size. */
  media() {
    if (this.video.style.display !== 'none' && this.video.videoWidth) {
      return { el: this.video, w: this.video.videoWidth, h: this.video.videoHeight };
    }
    return { el: this.img, w: this.img.naturalWidth, h: this.img.naturalHeight };
  }

  /**
   * Positions the image: fitted to the screen for the current rotation, then
   * rotated, zoomed and panned with a single CSS transform.
   */
  layout() {
    const m = this.media();
    if (!m.w || !m.h) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const sideways = this.rotation % 180 !== 0;
    const boxW = sideways ? m.h : m.w;
    const boxH = sideways ? m.w : m.h;
    const fit = Math.min(W / boxW, H / boxH);
    const dw = m.w * fit;
    const dh = m.h * fit;
    const z = ZOOMS[this.zoomIndex];

    // Keep the pan inside the zoomed image.
    const maxX = Math.max(0, (boxW * fit * z - W) / 2);
    const maxY = Math.max(0, (boxH * fit * z - H) / 2);
    this.panX = Math.max(-maxX, Math.min(maxX, this.panX));
    this.panY = Math.max(-maxY, Math.min(maxY, this.panY));

    const s = m.el.style;
    s.width = `${dw}px`;
    s.height = `${dh}px`;
    s.left = `${(W - dw) / 2}px`;
    s.top = `${(H - dh) / 2}px`;
    s.transform = `translate(${this.panX}px, ${this.panY}px) rotate(${this.rotation}deg) scale(${z})`;
    this.zoomOutButton.classList.toggle('disabled', this.zoomIndex === 0);
  }

  zoomBy(delta) {
    const next = Math.max(0, Math.min(ZOOMS.length - 1, this.zoomIndex + delta));
    if (next === this.zoomIndex) return;
    this.zoomIndex = next;
    if (next === 0) {
      this.panX = 0;
      this.panY = 0;
    }
    this.el.classList.toggle('zoomed', next > 0);
    this.layout();
    this.sharpen();
    // Zoom out just became disabled: move the highlight to Zoom in.
    if (next === 0 && this.panelVisible()) focus(this.actions.firstChild);
  }

  /** Loads a sharper decode when zoomed in beyond the current one. */
  async sharpen() {
    const item = this.item;
    if (!item || imageKind(item) !== 'photo') return;
    const width = this.wantedWidth();
    if (width <= this.decodedWidth) return;
    const gen = this.generation;
    try {
      const url = await this.photoUrl(item, width);
      if (gen !== this.generation || this.destroyed) return;
      this.decodedWidth = width;
      this.img.src = url;
    } catch (e) { /* keep the current decode */ }
  }

  rotate() {
    this.rotation = (this.rotation + 90) % 360;
    this.layout();
  }

  /** Moves around a zoomed image; arrow direction = where you look. */
  pan(dx, dy) {
    this.panX -= dx * window.innerWidth * PAN_STEP;
    this.panY -= dy * window.innerHeight * PAN_STEP;
    this.layout();
  }

  // -------------------------------------------------------------------------
  // Panel, editing
  // -------------------------------------------------------------------------

  panelVisible() {
    return this.el.classList.contains('show-info');
  }

  showPanel() {
    this.el.classList.add('show-info');
    focusFirst(this.actions);
  }

  hidePanel() {
    this.el.classList.remove('show-info');
  }

  edit() {
    if (!this.item) return;
    openEditor('image', this.item, (updated) => {
      Object.assign(this.item, updated);
      this.renderInfo(this.item);
    });
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

  onKey(e) {
    if (isBack(e)) return false;
    this.hint.classList.add('hidden');
    const k = e.keyCode;

    // Media keys work in every state.
    switch (k) {
      case KEY.PLAY:
        this.hidePanel();
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
      case KEY.REWIND:
        this.step(-1);
        return true;
      case KEY.FAST_FORWARD:
        this.step(1);
        return true;
      default:
        break;
    }

    // Panel open: arrows move between its buttons, OK presses them.
    if (this.panelVisible()) return false;

    const zoomed = this.zoomIndex > 0;
    switch (k) {
      case KEY.LEFT:
        if (zoomed) this.pan(-1, 0);
        else {
          this.step(-1);
          if (this.playing) this.scheduleNext();
        }
        return true;
      case KEY.RIGHT:
        if (zoomed) this.pan(1, 0);
        else {
          this.step(1);
          if (this.playing) this.scheduleNext();
        }
        return true;
      case KEY.UP:
        if (zoomed) this.pan(0, -1);
        else this.showPanel();
        return true;
      case KEY.DOWN:
        if (zoomed) this.pan(0, 1);
        else this.showPanel();
        return true;
      case KEY.ENTER:
        if (this.playing) this.stop();
        else this.showPanel();
        return true;
      default:
        return true; // nothing else is navigable here
    }
  }

  onBack() {
    if (this.panelVisible()) {
      this.hidePanel();
      return true;
    }
    if (this.zoomIndex > 0 || this.rotation) {
      this.resetView();
      return true;
    }
    return false;
  }
}
