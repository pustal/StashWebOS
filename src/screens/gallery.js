/**
 * Gallery page: cover, facts, a Slideshow button, chapters, people and
 * tags, linked scenes, and the gallery's images.
 */
import { Screen } from '../ui/router.js';
import { h, icon } from '../util/dom.js';
import { Collection } from '../ui/collection.js';
import { createRow } from '../ui/row.js';
import { personChip, stashImage, tagChip } from '../ui/cards.js';
import { openItem } from '../ui/navigate.js';
import { focus, focusFirst, getFocused } from '../nav/focus.js';
import { editButton } from '../ui/editor.js';
import { toast } from '../ui/overlay.js';
import * as api from '../api/stash.js';
import { countOf, formatDate, galleryTitle, stars } from '../util/format.js';

/** Gallery images in file order, which is the order Stash numbers chapters by. */
const GALLERY_IMAGE_SORTS = [{ key: 'path', label: 'File name', direction: 'ASC' }]
  .concat(api.IMAGE_SORTS.filter((s) => s.key !== 'path'));

export class GalleryScreen extends Screen {
  /** @param {{id: string}} gallery  card data is shown while the rest loads */
  constructor(gallery) {
    super();
    this.gallery = gallery;
    this.el.classList.add('screen-entity', 'screen-gallery');
    this.header = h('header', { class: 'entity-header' });
    this.extras = h('div', { class: 'gallery-extras' });
    this.collection = new Collection({
      types: ['image'],
      sorts: { image: GALLERY_IMAGE_SORTS },
      initialSort: { image: 'path' },
      autofocus: false, // the header's main button gets the highlight
      filter: () => api.filters.gallery(this.gallery.id),
    });
    this.el.appendChild(this.header);
    this.el.appendChild(this.extras);
    this.el.appendChild(this.collection.el);
    this.renderHeader(gallery);
  }

  async mount() {
    try {
      const full = await api.getGallery(this.gallery.id);
      if (!full) throw new Error('This gallery no longer exists.');
      this.gallery = full;
      const hadFocus = this.header.contains(getFocused());
      this.renderHeader(full);
      this.renderExtras(full);
      // Re-rendering replaced the highlighted button; put the highlight back.
      if (this.isTop() && (hadFocus || !document.documentElement.contains(getFocused()))) focusFirst(this.header);
    } catch (err) {
      toast(`Couldn't load the gallery: ${err.message}`, 'error');
    }
  }

  renderHeader(g) {
    const rating = stars(g.rating100);
    const facts = [
      formatDate(g.date),
      g.studio ? g.studio.name : null,
      g.photographer ? `Photos by ${g.photographer}` : null,
      countOf(g.image_count, 'image'),
      rating ? `${rating} ★` : null,
    ].filter(Boolean);
    this.header.innerHTML = '';
    this.header.appendChild(h('div', { class: 'entity-art entity-art-gallery' },
      g.paths && g.paths.cover ? stashImage(g.paths.cover, 'gallery', { eager: true }) : null));
    this.header.appendChild(h('div', { class: 'entity-copy' }, [
      h('h1', { class: 'detail-title' }, galleryTitle(g)),
      facts.length ? h('div', { class: 'detail-facts' }, facts.map((f) => h('span', null, f))) : null,
      g.details ? h('p', { class: 'detail-text' }, g.details) : null,
      h('div', { class: 'detail-actions nav-group' }, [
        h('div', {
          class: 'button primary focusable' + (g.image_count ? '' : ' disabled'),
          onSelect: () => this.openViewer(0, true),
        }, [icon('play'), 'Slideshow']),
        editButton('gallery', () => this.gallery, () => this.afterEdit()),
      ]),
    ]));
  }

  /** Re-renders the header after an edit and keeps the highlight on Edit. */
  afterEdit() {
    this.renderHeader(this.gallery);
    const b = this.header.querySelector('.edit-button');
    if (b && this.isTop()) focus(b);
  }

  /** Chapters, performers, studio, tags and linked scenes. */
  renderExtras(g) {
    this.extras.innerHTML = '';
    const chipSection = (title, chips) => (chips.length ? h('section', { class: 'chip-section', 'data-scroll': 'align' }, [
      h('h2', { class: 'row-title' }, title),
      h('div', { class: 'chip-list nav-group' }, chips),
    ]) : null);
    const chapters = (g.chapters || []).slice().sort((a, b) => a.image_index - b.image_index);
    const sections = [
      chipSection('Chapters', chapters.map((c) => h('div', {
        class: 'chip focusable',
        onSelect: () => this.openViewer(c.image_index - 1, false),
      }, [c.title, h('span', { class: 'chip-hint' }, `#${c.image_index}`)]))),
      chipSection('Performers', (g.performers || []).map((p) => personChip(p, (x) => openItem('performer', x)))),
      chipSection('Studio', g.studio ? [tagChip(g.studio, (x) => openItem('studio', x))] : []),
      chipSection('Tags', (g.tags || []).map((t) => tagChip(t, (x) => openItem('tag', x)))),
    ];
    for (const s of sections) if (s) this.extras.appendChild(s);
    if (g.scenes && g.scenes.length) {
      this.extras.appendChild(createRow({ title: 'Scenes', kind: 'scene', items: g.scenes }).el);
    }
  }

  /**
   * Opens the viewer at an image index (0-based) over the whole gallery.
   * @param {number} index
   * @param {boolean} slideshow
   */
  openViewer(index, slideshow) {
    const grid = this.collection.grid;
    if (!this.gallery.image_count && !grid.loaded) return;
    openItem('image', null, {
      items: grid.items.slice(),
      index: Math.max(0, index),
      count: grid.count || this.gallery.image_count,
      perPage: grid.perPage,
      fetchPage: grid.fetchPage,
      slideshow,
    });
  }

  focusDefault() {
    if (!focusFirst(this.header)) this.collection.focus();
  }
}
