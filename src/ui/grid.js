/**
 * Paged grid of cards with load-on-demand.
 *
 * Pages are fetched when the highlight gets within two rows of the end, so
 * nothing is requested that the user is not about to see. Far-away card
 * images are released by the image cache's IntersectionObserver.
 */
import { h } from '../util/dom.js';
import { RENDERERS, skeletonCard } from './cards.js';
import { openItem } from './navigate.js';
import { focusFirst, userActions } from '../nav/focus.js';

export class Grid {
  /**
   * @param {Object} opts
   * @param {'scene'|'performer'|'studio'|'tag'|'gallery'|'image'|'group'} opts.kind
   * @param {(page: number, perPage: number) => Promise<{count: number, items: Array}>} opts.fetchPage
   * @param {number} [opts.perPage=40]
   * @param {string} [opts.emptyText]
   * @param {(count: number) => void} [opts.onCount]
   * @param {boolean} [opts.autofocus=true] highlight the first card when page 1 arrives
   */
  constructor(opts) {
    this.opts = opts;
    this.kind = opts.kind;
    this.perPage = opts.perPage || 40;
    this.el = h('div', { class: `grid grid-${this.kind} nav-group` });
    this.generation = 0;
    this.reset(opts.fetchPage);
  }

  /** Clears the grid and starts again with a new page source (sort/filter change). */
  reset(fetchPage) {
    this.fetchPage = fetchPage || this.fetchPage;
    // On a reload (sort, toggle or filter change) the highlight is on the
    // toolbar button that was just pressed, or in the filter panel: leave it
    // there, so the user can keep adjusting the view, instead of jumping
    // into the new results (behind the panel).
    const cur = this.generation > 0 ? document.querySelector('.focused') : null;
    this.holdFocus = !!(cur && document.documentElement.contains(cur) && !this.el.contains(cur));
    this.generation += 1;
    this.page = 0;
    this.count = null;
    this.loaded = 0;
    /** Every item loaded so far, in order (a new array per reset). */
    this.items = [];
    this.loading = false;
    // A new result: forget what was selected in the old one.
    if (this.selection) {
      this.selection.clear();
      if (this.onSelectionChange) this.onSelectionChange(0);
    }
    this.el.innerHTML = '';
    this.el.__last = null;
    this.el.classList.remove('is-empty');
    return this.loadMore();
  }

  // -------------------------------------------------------------------------
  // Selection (for actions on several items)
  // -------------------------------------------------------------------------

  /**
   * Turns selection mode on or off. While on, OK on a card selects or
   * unselects it instead of opening it.
   * @param {boolean} on
   * @param {(count: number) => void} [onChange]  called when the selection changes
   */
  setSelecting(on, onChange) {
    this.selection = on ? new Map() : null;
    this.onSelectionChange = onChange || null;
    this.el.classList.toggle('selecting', !!on);
    for (const card of this.el.children) card.classList.remove('selected');
  }

  /** Selects or unselects one item. */
  toggleSelected(item) {
    const sel = this.selection;
    if (sel.has(item.id)) sel.delete(item.id);
    else sel.set(item.id, item);
    for (const card of this.el.children) {
      if (card.__item === item) card.classList.toggle('selected', sel.has(item.id));
    }
    if (this.onSelectionChange) this.onSelectionChange(sel.size);
  }

  /** Selects every loaded item (or, with `none`, clears the selection). */
  selectAll(none) {
    if (!this.selection) return;
    this.selection.clear();
    if (!none) for (const it of this.items) this.selection.set(it.id, it);
    for (const card of this.el.children) {
      if (card.__item) card.classList.toggle('selected', !none);
    }
    if (this.onSelectionChange) this.onSelectionChange(this.selection.size);
  }

  /** The selected items, in grid order. */
  selectedItems() {
    return this.selection ? Array.from(this.selection.values()) : [];
  }

  /** True when all items are loaded. */
  get done() {
    return this.count !== null && this.loaded >= this.count;
  }

  /** Fetches the next page and appends its cards. */
  async loadMore() {
    if (this.loading || this.done) return;
    this.loading = true;
    const gen = this.generation;
    const actionsBefore = userActions();
    const skeletons = [];
    const skeletonCount = this.page === 0 ? 12 : 0;
    for (let i = 0; i < skeletonCount; i += 1) {
      const s = skeletonCard(this.kind);
      skeletons.push(s);
      this.el.appendChild(s);
    }
    try {
      const res = await this.fetchPage(this.page + 1, this.perPage);
      if (gen !== this.generation) return; // a reset happened meanwhile
      for (const s of skeletons) this.el.removeChild(s);
      this.page += 1;
      this.count = res.count;
      if (this.opts.onCount) this.opts.onCount(res.count);
      const render = RENDERERS[this.kind];
      const select = (item) => this.open(item);
      for (const item of res.items) {
        const card = render(item, select);
        card.__onFocus = () => this.onCardFocus(card);
        if (this.selection && this.selection.has(item.id)) card.classList.add('selected');
        this.el.appendChild(card);
      }
      this.loaded += res.items.length;
      this.items = this.items.concat(res.items);
      if (res.items.length === 0) this.count = this.loaded; // guard against bad counts
      if (this.loaded === 0) {
        this.el.classList.add('is-empty');
        this.el.appendChild(h('div', { class: 'grid-empty' }, this.opts.emptyText || 'Nothing matches.'));
      }
      // First page arrived: move the highlight into the grid unless the
      // user pressed something while waiting.
      if (this.page === 1 && this.opts.autofocus !== false && this.loaded > 0) {
        const screenEl = this.el.closest('.screen');
        const visible = screenEl && screenEl.style.display !== 'none';
        if (visible && !this.holdFocus && userActions() === actionsBefore) focusFirst(this.el);
      }
    } catch (err) {
      if (gen !== this.generation) return;
      for (const s of skeletons) if (s.parentNode) this.el.removeChild(s);
      this.el.appendChild(h('div', { class: 'grid-empty' }, `Couldn't load: ${err.message}`));
    } finally {
      if (gen === this.generation) this.loading = false;
    }
  }

  /**
   * Opens an item. Images open in the viewer with the whole grid as its
   * playlist: the viewer gets the items loaded so far plus a way to fetch
   * further pages, so Left/Right can run through the entire result.
   */
  open(item) {
    // In selection mode OK picks cards instead of opening them.
    if (this.selection) {
      this.toggleSelected(item);
      return;
    }
    if (this.kind !== 'image') {
      openItem(this.kind, item);
      return;
    }
    openItem('image', item, {
      items: this.items.slice(),
      index: this.items.indexOf(item),
      count: this.count,
      perPage: this.perPage,
      fetchPage: this.fetchPage,
    });
  }

  /** Triggers the next page when the highlight nears the end. */
  onCardFocus(card) {
    if (this.done || this.loading) return;
    const cards = this.el.children;
    let index = 0;
    for (let i = cards.length - 1; i >= 0; i -= 1) {
      if (cards[i] === card) {
        index = i;
        break;
      }
    }
    const perRow = this.columns();
    if (index >= this.loaded - perRow * 2) this.loadMore();
  }

  /** Number of cards per row, measured from layout. */
  columns() {
    const cards = this.el.children;
    if (cards.length < 2) return 1;
    const top = cards[0].offsetTop;
    let n = 0;
    while (n < cards.length && cards[n].offsetTop === top) n += 1;
    return n || 1;
  }
}
