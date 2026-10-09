/**
 * Home: a "marquee" at the top that shows whatever card is highlighted,
 * and shelves of scenes, performers and tags below it.
 */
import { Screen } from '../ui/router.js';
import { h } from '../util/dom.js';
import { createRow } from '../ui/row.js';
import { focusFirst, userActions } from '../nav/focus.js';
import * as api from '../api/stash.js';
import { bindImage } from '../cache/imageCache.js';
import {
  ageFrom, countOf, formatDate, formatDuration, galleryTitle, sceneTitle,
} from '../util/format.js';

const ROW_SIZE = 20;

export class HomeScreen extends Screen {
  constructor() {
    super();
    this.section = 'home';
    this.el.classList.add('screen-home');
    // Rows align below the marquee (marquee height = 46% of the screen).
    this.el.setAttribute('data-scroll-top', '0.5');

    this.marqueeImg = h('img', { class: 'marquee-img', alt: '' });
    this.marqueeTitle = h('h1', { class: 'marquee-title' });
    this.marqueeMeta = h('div', { class: 'marquee-meta' });
    this.marqueeText = h('p', { class: 'marquee-text' });
    this.marquee = h('div', { class: 'marquee' }, [
      h('div', { class: 'marquee-art' }, this.marqueeImg),
      h('div', { class: 'marquee-copy' }, [this.marqueeTitle, this.marqueeMeta, this.marqueeText]),
    ]);
    this.rows = h('div', { class: 'home-rows' });
    this.el.appendChild(this.marquee);
    this.el.appendChild(this.rows);
    this.marqueeTimer = null;
    this.seed = Math.floor(Math.random() * 1e8);
  }

  mount() {
    const onFocusItem = (card) => this.showInMarquee(card);
    const sceneRow = (title, load) => createRow({ title, kind: 'scene', load, onFocusItem });
    const scenes = (opts) => () => api.findScenes(Object.assign({ perPage: ROW_SIZE }, opts)).then((r) => r.items);

    const rows = [
      sceneRow('Continue watching', scenes({ sort: 'last_played_at', direction: 'DESC', filter: api.filters.inProgress() })),
      sceneRow('Recently added', scenes({ sort: 'created_at', direction: 'DESC' })),
      sceneRow('New releases', scenes({ sort: 'date', direction: 'DESC' })),
      createRow({
        title: 'Favourite performers',
        kind: 'performer',
        onFocusItem,
        load: () => api.findPerformers({
          perPage: ROW_SIZE, sort: 'random', filter: { filter_favorites: true },
        }).then((r) => r.items),
      }),
      createRow({
        title: 'Recent galleries',
        kind: 'gallery',
        onFocusItem,
        load: () => api.findGalleries({ perPage: ROW_SIZE, sort: 'created_at', direction: 'DESC' }).then((r) => r.items),
      }),
      createRow({
        title: 'Groups',
        kind: 'group',
        onFocusItem,
        load: () => api.findGroups({ perPage: ROW_SIZE, sort: 'created_at', direction: 'DESC' }).then((r) => r.items),
      }),
      sceneRow('Watch again', scenes({ sort: 'last_played_at', direction: 'DESC', filter: api.filters.played() })),
      sceneRow('Something different', scenes({ sort: api.sortKey('random', this.seed) })),
      createRow({
        title: 'Popular tags',
        kind: 'tag',
        onFocusItem,
        load: () => api.findTags({ perPage: ROW_SIZE, sort: 'scenes_count', direction: 'DESC' }).then((r) => r.items),
      }),
    ];
    for (const r of rows) this.rows.appendChild(r.el);

    // Highlight the first row (in screen order) that has content, unless
    // the user already moved somewhere (e.g. into the sidebar) meanwhile.
    const actionsBefore = userActions();
    (async () => {
      for (const r of rows) {
        const n = await r.ready; // eslint-disable-line no-await-in-loop
        if (!n) continue;
        if (this.isTop() && userActions() === actionsBefore) focusFirst(r.el);
        break;
      }
    })();
    Promise.all(rows.map((r) => r.ready)).then((counts) => {
      if (counts.every((n) => !n)) {
        this.rows.appendChild(h('div', { class: 'grid-empty' }, 'Your library is empty. Run a scan in Stash, then come back.'));
      }
    });
  }

  focusDefault() {
    focusFirst(this.rows);
  }

  /**
   * Updates the marquee for the highlighted card. Debounced so that holding
   * an arrow key does not download a backdrop for every card passed.
   */
  showInMarquee(card) {
    clearTimeout(this.marqueeTimer);
    this.marqueeTimer = setTimeout(() => this.renderMarquee(card), 180);
  }

  renderMarquee(card) {
    const item = card.__item;
    const kind = card.__kind;
    if (!item) return;
    let title = item.name || '';
    let meta = [];
    let text = '';
    let image = item.image_path;

    if (kind === 'scene') {
      title = sceneTitle(item);
      const file = item.files && item.files[0];
      meta = [
        item.studio ? item.studio.name : null,
        formatDate(item.date),
        file && file.duration ? formatDuration(file.duration) : null,
        item.resume_time ? `Resume at ${formatDuration(item.resume_time)}` : null,
      ];
      image = item.paths && item.paths.screenshot;
    } else if (kind === 'performer') {
      const age = ageFrom(item.birthdate);
      meta = [age ? `${age} years` : null, item.country || null, `${item.scene_count} scenes`];
    } else if (kind === 'tag' || kind === 'studio') {
      meta = [`${item.scene_count} scenes`];
    } else if (kind === 'gallery') {
      title = galleryTitle(item);
      meta = [item.studio ? item.studio.name : null, formatDate(item.date), countOf(item.image_count, 'image')];
      image = item.paths && item.paths.cover;
    } else if (kind === 'group') {
      meta = [formatDate(item.date), item.duration ? formatDuration(item.duration) : null, countOf(item.scene_count, 'scene')];
      image = item.front_image_path;
    }

    this.marqueeTitle.textContent = title;
    this.marqueeMeta.innerHTML = '';
    for (const m of meta.filter(Boolean)) this.marqueeMeta.appendChild(h('span', null, m));
    this.marqueeText.textContent = text;
    this.marquee.className = `marquee marquee-${kind}`;

    // Backdrops are big; keep them in RAM only so they never use storage.
    this.marqueeImg.classList.remove('loaded');
    const wide = kind === 'scene' || kind === 'gallery';
    if (image) bindImage(this.marqueeImg, image, { width: wide ? 960 : 480, quality: 0.8, persist: false, eager: true });
  }

  onHide() {
    clearTimeout(this.marqueeTimer);
  }
}
