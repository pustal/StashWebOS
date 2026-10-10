/**
 * Collection: a paged grid with a sort menu and, optionally, tabs for
 * several content types (Scenes / Galleries / Images / Groups).
 *
 * Used on performer, studio, tag, group and gallery pages, which all show
 * "the things that belong to X" with the same filter applied to each type.
 *
 * On the Scenes tab the toolbar also has Play all and Shuffle (see
 * ui/playQueue.js): the tab's scenes, in its sort order or shuffled, played
 * one after the other.
 */
import { h, icon } from '../util/dom.js';
import { Grid } from './grid.js';
import { chooseOption } from './overlay.js';
import { focusFirst } from '../nav/focus.js';
import * as api from '../api/stash.js';
import { playButtons, playScenes } from './playQueue.js';
import { countOf } from '../util/format.js';

/** Per content type: tab label, count noun, finder and sort options. */
export const CONTENT_TYPES = {
  scene: {
    label: 'Scenes', noun: 'scene', find: api.findScenes, sorts: api.SCENE_SORTS, sort: 'date', empty: 'No scenes yet.',
  },
  gallery: {
    label: 'Galleries', noun: 'gallery', plural: 'galleries', find: api.findGalleries, sorts: api.GALLERY_SORTS, sort: 'date', empty: 'No galleries yet.',
  },
  image: {
    label: 'Images', noun: 'image', find: api.findImages, sorts: api.IMAGE_SORTS, sort: 'date', empty: 'No images yet.',
  },
  marker: {
    label: 'Markers', noun: 'marker', find: api.findMarkers, sorts: api.MARKER_SORTS, sort: 'created_at', empty: 'No markers yet.',
  },
  group: {
    label: 'Groups', noun: 'group', find: api.findGroups, sorts: api.GROUP_SORTS, sort: 'date', empty: 'No groups yet.',
  },
};

export class Collection {
  /**
   * @param {Object} opts
   * @param {Array<'scene'|'gallery'|'image'|'group'>} opts.types  tabs, in order
   * @param {(type: string) => Object} opts.filter   filter object for a type
   * @param {Object<string, Array>} [opts.sorts]     per-type sort list override
   * @param {Object<string, string>} [opts.initialSort] per-type initial sort key
   * @param {Object<string, number>} [opts.counts]   per-type counts; types with 0 are hidden
   * @param {boolean} [opts.autofocus=true] highlight the first card when it loads
   *   (off on pages whose header has the main action, e.g. Play all)
   * @param {boolean} [opts.playButtons=true] Play all / Shuffle on the Scenes
   *   tab's toolbar (off when the page has them in its header, see play())
   */
  constructor(opts) {
    this.opts = opts;
    this.seed = Math.floor(Math.random() * 1e8);
    this.sortByType = {};
    this.counts = opts.counts || {};
    this.type = null;
    this.grid = null;

    this.countEl = h('span', { class: 'page-count' });
    this.tabs = {};
    const tabEls = opts.types.map((t) => {
      const el = h('div', { class: 'button ghost toggle tab focusable', onSelect: () => this.switchTo(t, false) },
        h('span', null, CONTENT_TYPES[t].label));
      this.tabs[t] = el;
      return el;
    });
    this.sortLabel = h('span');
    this.sortButton = h('div', { class: 'button ghost focusable', onSelect: () => this.pickSort() }, [icon('sort'), this.sortLabel]);
    // Shown only while the Scenes tab is open (see switchTo).
    this.playButtons = opts.playButtons !== false && opts.types.indexOf('scene') >= 0
      ? playButtons((perPage, sortOverride) => this.query('scene', 1, perPage, sortOverride))
      : [];
    this.gridHolder = h('div', { class: 'collection-grid' });
    this.el = h('div', { class: 'collection' }, [
      h('div', { class: 'entity-bar' }, [
        this.countEl,
        h('div', { class: 'toolbar nav-group', 'data-no-memory': true }, tabEls.concat([this.sortButton], this.playButtons)),
      ]),
      this.gridHolder,
    ]);
    this.applyCounts();
    this.switchTo(opts.types[0], opts.autofocus !== false);
  }

  /** The sort list for a type. */
  sortsFor(type) {
    return (this.opts.sorts && this.opts.sorts[type]) || CONTENT_TYPES[type].sorts;
  }

  /** Updates per-type counts (hides empty tabs; one tab means no tab row). */
  setCounts(counts) {
    this.counts = Object.assign({}, this.counts, counts);
    this.applyCounts();
  }

  applyCounts() {
    const visible = this.opts.types.filter((t, i) => i === 0 || this.counts[t] === undefined || this.counts[t] > 0);
    for (const t of this.opts.types) {
      const show = visible.length > 1 && visible.indexOf(t) >= 0;
      this.tabs[t].style.display = show ? '' : 'none';
    }
  }

  /**
   * Shows a type's grid.
   * @param {string} type
   * @param {boolean} focusGrid  move the highlight into the new grid when it loads
   *   (true on first show; false when switching tabs, so the highlight stays
   *   on the tab row and the user can compare tabs)
   */
  switchTo(type, focusGrid) {
    if (type === this.type) return;
    this.type = type;
    const conf = CONTENT_TYPES[type];
    for (const t of Object.keys(this.tabs)) this.tabs[t].classList.toggle('on', t === type);
    for (const b of this.playButtons) b.style.display = type === 'scene' ? '' : 'none';

    if (!this.sortByType[type]) {
      const sorts = this.sortsFor(type);
      const wanted = (this.opts.initialSort && this.opts.initialSort[type]) || conf.sort;
      this.sortByType[type] = sorts.find((s) => s.key === wanted) || sorts[0];
    }
    this.sortLabel.textContent = this.sortByType[type].label;

    if (this.grid) this.grid.el.parentNode.removeChild(this.grid.el);
    this.grid = new Grid({
      kind: type,
      emptyText: conf.empty,
      autofocus: focusGrid !== false,
      fetchPage: (page, perPage) => this.query(type, page, perPage),
      onCount: (n) => {
        this.countEl.textContent = countOf(n, conf.noun, conf.plural);
      },
    });
    this.gridHolder.appendChild(this.grid.el);
  }

  /**
   * One page of a type, with the page's filter and the type's chosen sort.
   * @param {string} type
   * @param {number} page
   * @param {number} perPage
   * @param {{sort: string, direction: string}} [sortOverride]  used instead of
   *   the chosen sort (Shuffle asks for a random order this way)
   */
  query(type, page, perPage, sortOverride) {
    const s = this.sortByType[type];
    return CONTENT_TYPES[type].find({
      page,
      perPage,
      sort: sortOverride ? sortOverride.sort : api.sortKey(s.key, this.seed),
      direction: sortOverride ? sortOverride.direction : s.direction,
      filter: this.opts.filter(type),
    });
  }

  /**
   * Plays the scenes as a queue, in the Scenes tab's sort order or shuffled
   * (for pages that put Play all in their header, e.g. a group).
   * @param {boolean} [shuffle]
   */
  play(shuffle) {
    return playScenes((perPage, sortOverride) => this.query('scene', 1, perPage, sortOverride), shuffle);
  }

  async pickSort() {
    const sorts = this.sortsFor(this.type);
    const key = await chooseOption({
      title: 'Sort by',
      options: sorts.map((s) => ({ label: s.label, value: s.key })),
      selected: this.sortByType[this.type].key,
    });
    if (!key) return;
    if (key === 'random') this.seed = Math.floor(Math.random() * 1e8);
    this.sortByType[this.type] = sorts.find((s) => s.key === key);
    this.sortLabel.textContent = this.sortByType[this.type].label;
    this.grid.reset();
  }

  /** Highlights the first card, if any. */
  focus() {
    return focusFirst(this.grid.el);
  }
}
