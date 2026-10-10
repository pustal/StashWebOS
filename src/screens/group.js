/**
 * Group page (Stash's "movies"): front cover, facts and synopsis, Play all
 * and Shuffle, back cover, sub-groups, and the group's scenes in running
 * order. Play all follows the scene list's sort (running order unless
 * another sort is picked).
 */
import { Screen } from '../ui/router.js';
import { h, icon } from '../util/dom.js';
import { Collection } from '../ui/collection.js';
import { createRow } from '../ui/row.js';
import { hasRealImage, stashImage, tagChip } from '../ui/cards.js';
import { openItem } from '../ui/navigate.js';
import { focus, focusFirst, getFocused } from '../nav/focus.js';
import { editButton } from '../ui/editor.js';
import { toast } from '../ui/overlay.js';
import * as api from '../api/stash.js';
import {
  countOf, formatDate, formatDuration, stars,
} from '../util/format.js';

export class GroupScreen extends Screen {
  /** @param {{id: string}} group */
  constructor(group) {
    super();
    this.group = group;
    this.el.classList.add('screen-entity', 'screen-group');
    this.header = h('header', { class: 'entity-header' });
    this.extras = h('div', { class: 'gallery-extras' });
    this.collection = new Collection({
      types: ['scene'],
      sorts: { scene: [api.GROUP_ORDER_SORT].concat(api.SCENE_SORTS) },
      initialSort: { scene: api.GROUP_ORDER_SORT.key },
      autofocus: false, // the header's main button gets the highlight
      playButtons: false, // they're in the header
      filter: () => api.filters.group(this.group.id),
    });
    this.el.appendChild(this.header);
    this.el.appendChild(this.extras);
    this.el.appendChild(this.collection.el);
    this.renderHeader(group);
  }

  async mount() {
    try {
      const full = await api.getGroup(this.group.id);
      if (!full) throw new Error('This group no longer exists.');
      this.group = full;
      const hadFocus = this.header.contains(getFocused());
      this.renderHeader(full);
      this.renderExtras(full);
      // Re-rendering replaced the highlighted button; put the highlight back.
      if (this.isTop() && (hadFocus || !document.documentElement.contains(getFocused()))) focusFirst(this.header);
    } catch (err) {
      toast(`Couldn't load the group: ${err.message}`, 'error');
    }
  }

  renderHeader(g) {
    const rating = stars(g.rating100);
    const facts = [
      formatDate(g.date),
      g.duration ? formatDuration(g.duration) : null,
      g.studio ? g.studio.name : null,
      g.director ? `Directed by ${g.director}` : null,
      countOf(g.scene_count, 'scene'),
      rating ? `${rating} ★` : null,
    ].filter(Boolean);
    const none = g.scene_count === 0 ? ' disabled' : '';
    const actions = [
      h('div', { class: 'button primary focusable' + none, onSelect: () => this.collection.play(false) }, [icon('play'), 'Play all']),
      h('div', { class: 'button ghost focusable' + none, onSelect: () => this.collection.play(true) }, [icon('shuffle'), 'Shuffle']),
    ];
    if (g.back_image_path) {
      actions.push(h('div', { class: 'button ghost focusable', onSelect: () => this.showCovers(1) }, [icon('image'), 'Back cover']));
    }
    const edit = editButton('group', () => this.group, () => this.afterEdit());
    if (edit) actions.push(edit);
    this.header.innerHTML = '';
    this.header.appendChild(h('div', {
      class: 'entity-art entity-art-group',
    }, hasRealImage(g.front_image_path) ? stashImage(g.front_image_path, 'group', { eager: true }) : null));
    this.header.appendChild(h('div', { class: 'entity-copy' }, [
      h('h1', { class: 'detail-title' }, g.name || ''),
      g.aliases ? h('div', { class: 'detail-facts' }, h('span', null, `Also: ${g.aliases}`)) : null,
      facts.length ? h('div', { class: 'detail-facts' }, facts.map((f) => h('span', null, f))) : null,
      g.synopsis ? h('p', { class: 'detail-text' }, g.synopsis) : null,
      h('div', { class: 'detail-actions nav-group' }, actions),
    ]));
  }

  /** Re-renders the page after an edit and keeps the highlight on Edit. */
  afterEdit() {
    this.renderHeader(this.group);
    // Links (performers, studio, tags, scenes) may have changed too.
    this.renderExtras(this.group);
    const b = this.header.querySelector('.edit-button');
    if (b && this.isTop()) focus(b);
  }

  renderExtras(g) {
    this.extras.innerHTML = '';
    const chips = [];
    for (const c of g.containing_groups || []) chips.push(tagChip(c.group, (x) => openItem('group', x)));
    if (chips.length) {
      this.extras.appendChild(h('section', { class: 'chip-section', 'data-scroll': 'align' }, [
        h('h2', { class: 'row-title' }, 'Part of'),
        h('div', { class: 'chip-list nav-group' }, chips),
      ]));
    }
    if (g.tags && g.tags.length) {
      this.extras.appendChild(h('section', { class: 'chip-section', 'data-scroll': 'align' }, [
        h('h2', { class: 'row-title' }, 'Tags'),
        h('div', { class: 'chip-list nav-group' }, g.tags.map((t) => tagChip(t, (x) => openItem('tag', x)))),
      ]));
    }
    const subs = (g.sub_groups || []).map((s) => s.group);
    if (subs.length) this.extras.appendChild(createRow({ title: 'Sub-groups', kind: 'group', items: subs }).el);
  }

  /** Front/back covers in the image viewer. */
  showCovers(index) {
    const g = this.group;
    const asImage = (url, title) => ({
      id: title, title, paths: { image: url }, visual_files: [],
    });
    const items = [asImage(g.front_image_path, `${g.name}, front`)];
    if (g.back_image_path) items.push(asImage(g.back_image_path, `${g.name}, back`));
    openItem('image', items[index] || items[0], { items, index: Math.min(index, items.length - 1) });
  }

  focusDefault() {
    if (!focusFirst(this.header)) this.collection.focus();
  }
}
