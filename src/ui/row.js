/**
 * Horizontal row of cards ("shelf"), as used on Home, Search and detail
 * screens. The track slides with a transform (see nav/focus.js) instead of
 * scrolling, which is much cheaper on TV GPUs.
 */
import { h } from '../util/dom.js';
import { RENDERERS, skeletonCard } from './cards.js';
import { openItem } from './navigate.js';

/**
 * Creates a row.
 * @param {Object} opts
 * @param {string} opts.title
 * @param {'scene'|'performer'|'studio'|'tag'|'marker'|'gallery'|'image'|'group'} opts.kind
 * @param {() => Promise<Array>} [opts.load]  async loader; or pass `items`
 * @param {Array} [opts.items]
 * @param {(item: Object) => void} [opts.onSelect] default: open the item
 * @param {boolean} [opts.hideWhenEmpty=true]
 * @param {string} [opts.emptyText]
 * @param {(el: HTMLElement) => void} [opts.onFocusItem]
 * @returns {{el: HTMLElement, ready: Promise<number>}} ready resolves with the item count
 */
export function createRow(opts) {
  const kind = opts.kind;
  const track = h('div', { class: 'row-track' });
  track.__pad = 0;
  const el = h('section', { class: `row row-${kind} nav-group`, 'data-scroll': 'align' }, [
    h('h2', { class: 'row-title' }, opts.title),
    h('div', { class: 'row-viewport' }, track),
  ]);
  const render = RENDERERS[kind];
  /** Items currently shown, so the image viewer can step through the row. */
  let shown = [];
  const select = opts.onSelect || ((item) => (kind === 'image'
    ? openItem('image', item, { items: shown, index: shown.indexOf(item) })
    : openItem(kind, item)));

  const fill = (items) => {
    shown = items;
    track.innerHTML = '';
    if (!items.length) {
      if (opts.hideWhenEmpty !== false) el.style.display = 'none';
      else track.appendChild(h('div', { class: 'row-empty' }, opts.emptyText || 'Nothing here yet.'));
      return 0;
    }
    el.style.display = '';
    for (const item of items) {
      const card = render(item, select);
      if (opts.onFocusItem) card.__onFocus = opts.onFocusItem;
      track.appendChild(card);
    }
    return items.length;
  };

  let ready;
  if (opts.items) {
    ready = Promise.resolve(fill(opts.items));
  } else {
    for (let i = 0; i < 6; i += 1) track.appendChild(skeletonCard(kind === 'marker' ? 'scene' : kind));
    ready = opts.load().then(fill, (err) => {
      console.warn('row failed', opts.title, err);
      track.innerHTML = '';
      track.appendChild(h('div', { class: 'row-empty' }, `Couldn't load: ${err.message}`));
      return 0;
    });
  }
  return { el, ready };
}
