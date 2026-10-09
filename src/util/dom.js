/**
 * Tiny DOM helpers. The app deliberately avoids a UI framework: TVs have slow
 * CPUs and little RAM, and a few hundred lines of direct DOM code keeps the
 * bundle small and the frame rate predictable.
 */

/**
 * Creates an element.
 *
 * @example h('div', { class: 'card focusable', onSelect: fn }, [h('span', null, 'Hi')])
 *
 * @param {string} tag            Tag name, e.g. 'div'.
 * @param {Object|null} [attrs]   Attributes. Special keys:
 *   - `class`: className string
 *   - `style`: object of style properties
 *   - `on<Event>`: DOM event listener (e.g. `onClick`)
 *   - `onSelect`: called when the element is activated with OK or a click
 *     (see nav/focus.js)
 *   - `dataset`: object merged into element.dataset
 *   - anything else is set with setAttribute (null/false are skipped)
 * @param {Array|Node|string|number|null} [children]
 * @returns {HTMLElement}
 */
export function h(tag, attrs, children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const val = attrs[key];
      if (val === null || val === undefined || val === false) continue;
      if (key === 'class') el.className = val;
      else if (key === 'style') Object.assign(el.style, val);
      else if (key === 'dataset') Object.assign(el.dataset, val);
      else if (key === 'onSelect') el.__onSelect = val;
      else if (key === 'onFocus') el.__onFocus = val;
      else if (key.length > 2 && key.slice(0, 2) === 'on') el.addEventListener(key.slice(2).toLowerCase(), val);
      else if (key === 'text') el.textContent = val;
      else if (key === 'html') el.innerHTML = val;
      else el.setAttribute(key, val === true ? '' : val);
    }
  }
  append(el, children);
  return el;
}

/**
 * Appends children (nested arrays, nodes, strings; null is ignored).
 * @param {Node} parent
 * @param {*} children
 */
export function append(parent, children) {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) {
    for (const c of children) append(parent, c);
  } else if (children instanceof Node) {
    parent.appendChild(children);
  } else {
    parent.appendChild(document.createTextNode(String(children)));
  }
}

/** Removes all children of an element. */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Inline SVG icon set (stroke icons, 24x24 viewBox, currentColor). */
const ICONS = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  studio: '<path d="M4 20V9l8-5 8 5v11"/><path d="M9 20v-6h6v6"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  play: '<path d="M7 4l13 8-13 8z" fill="currentColor"/>',
  pause: '<path d="M7 4h4v16H7zM14 4h4v16h-4z" fill="currentColor"/>',
  back10: '<path d="M4 12a8 8 0 1 0 3-6.3"/><path d="M4 3v5h5"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none">10</text>',
  fwd30: '<path d="M20 12a8 8 0 1 1-3-6.3"/><path d="M20 3v5h-5"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none">30</text>',
  restart: '<path d="M5 4v16"/><path d="M19 4L8 12l11 8z" fill="currentColor"/>',
  markers: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  captions: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 10.5a2.5 2.5 0 1 0 0 3M17 10.5a2.5 2.5 0 1 0 0 3"/>',
  stream: '<path d="M4 7h16M4 12h10M4 17h6"/>',
  heart: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>',
  heartFilled: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" fill="currentColor"/>',
  sort: '<path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/>',
  shuffle: '<path d="M3 7h4l10 10h4M3 17h4l3-3M14 10l3-3h4M18 4l3 3-3 3M18 14l3 3-3 3"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  images: '<rect x="3" y="5" width="15" height="13" rx="1.5"/><path d="M7 2h14v13"/><path d="M3 15l4-4 4 4 3-3 4 4"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M3 18l6-5 4 3 3-2 5 4"/>',
  group: '<rect x="3" y="9" width="18" height="12" rx="1.5"/><path d="M3.5 9l1.5-5h15l-1.5 5"/><path d="M9 4l-2 5M14 4l-2 5M19 4l-2 5"/>',
  next: '<path d="M5 4l11 8-11 8z" fill="currentColor"/><path d="M19 4v16"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4M8 11h6"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" fill="currentColor"/>',
};

/**
 * Returns an inline SVG icon element.
 * @param {keyof ICONS} name
 * @param {string} [cls] extra class names
 */
export function icon(name, cls) {
  const span = document.createElement('span');
  span.className = 'icon' + (cls ? ' ' + cls : '');
  span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + (ICONS[name] || '') + '</svg>';
  return span;
}

/**
 * The Stash logo used in the sidebar and on the connect screen: the same
 * image as the launcher icon (dist/icons/largeIcon.png, made by
 * scripts/make-icons.py), so the app and its icon always match.
 */
export function brandMark() {
  return h('img', { class: 'brand-mark', src: 'icons/largeIcon.png', alt: 'Stash' });
}
