/**
 * Performer, studio and tag screens: a header about the entity and a grid
 * of its scenes, with a sort menu.
 */
import { Screen } from '../ui/router.js';
import { h, icon } from '../util/dom.js';
import { Grid } from '../ui/grid.js';
import { stashImage } from '../ui/cards.js';
import { chooseOption, toast } from '../ui/overlay.js';
import { focusFirst } from '../nav/focus.js';
import * as api from '../api/stash.js';
import {
  ageFrom, countryName, formatDate, genderLabel,
} from '../util/format.js';

const KINDS = {
  performer: { load: api.getPerformer, filter: api.filters.performer, imageKind: 'performer' },
  studio: { load: api.getStudio, filter: api.filters.studio, imageKind: 'studio' },
  tag: { load: api.getTag, filter: api.filters.tag, imageKind: 'tag' },
};

export class EntityScreen extends Screen {
  /**
   * @param {'performer'|'studio'|'tag'} kind
   * @param {{id: string, name?: string, image_path?: string}} item
   */
  constructor(kind, item) {
    super();
    this.kind = kind;
    this.conf = KINDS[kind];
    this.item = item;
    this.seed = Math.floor(Math.random() * 1e8);
    this.sort = api.SCENE_SORTS[1]; // release date, newest first
    this.el.classList.add('screen-entity', `screen-entity-${kind}`);

    this.header = h('header', { class: 'entity-header' });
    this.sortLabel = h('span', null, this.sort.label);
    this.countEl = h('span', { class: 'page-count' });
    this.toolbar = h('div', { class: 'toolbar nav-group', 'data-no-memory': true }, [
      h('div', { class: 'button ghost focusable', onSelect: () => this.pickSort() }, [icon('sort'), this.sortLabel]),
    ]);
    this.grid = new Grid({
      kind: 'scene',
      emptyText: 'No scenes yet.',
      fetchPage: (page, perPage) => api.findScenes({
        page,
        perPage,
        sort: api.sortKey(this.sort.key, this.seed),
        direction: this.sort.direction,
        filter: this.conf.filter(this.item.id),
      }),
      onCount: (n) => {
        this.countEl.textContent = n === 1 ? '1 scene' : `${n.toLocaleString()} scenes`;
      },
    });

    this.el.appendChild(this.header);
    this.el.appendChild(h('div', { class: 'entity-bar' }, [this.countEl, this.toolbar]));
    this.el.appendChild(this.grid.el);
    this.renderHeader(item);
  }

  async mount() {
    try {
      const full = await this.conf.load(this.item.id);
      if (full) {
        this.item = full;
        this.renderHeader(full);
      }
    } catch (err) {
      toast(`Couldn't load details: ${err.message}`, 'error');
    }
  }

  renderHeader(e) {
    const facts = [];
    let text = '';
    if (this.kind === 'performer') {
      const age = ageFrom(e.birthdate, e.death_date);
      if (e.disambiguation) facts.push(e.disambiguation);
      if (e.gender) facts.push(genderLabel(e.gender));
      if (age !== null && age !== undefined) facts.push(`${age} years`);
      if (e.country) facts.push(countryName(e.country));
      if (e.height_cm) facts.push(`${e.height_cm} cm`);
      if (e.career_start) facts.push(`Active since ${e.career_start}`);
      text = e.details || '';
    } else if (this.kind === 'studio') {
      if (e.parent_studio) facts.push(`Part of ${e.parent_studio.name}`);
      text = e.details || '';
    } else {
      if (e.aliases && e.aliases.length) facts.push(`Also: ${e.aliases.slice(0, 3).join(', ')}`);
      text = e.description || '';
    }
    if (this.kind === 'performer' && e.birthdate) facts.push(`Born ${formatDate(e.birthdate)}`);

    const actions = [];
    if (this.kind === 'performer' && e.favorite !== undefined) {
      actions.push(h('div', {
        class: 'button ghost focusable' + (e.favorite ? ' on' : ''),
        onSelect: (b) => this.toggleFavorite(b),
      }, [icon(e.favorite ? 'heartFilled' : 'heart'), e.favorite ? 'Favourite' : 'Add to favourites']));
    }

    this.header.innerHTML = '';
    const imgKind = this.conf.imageKind;
    const showImage = e.image_path && !(this.kind === 'tag' && /default=true/.test(e.image_path));
    this.header.appendChild(h('div', { class: `entity-art entity-art-${this.kind}` },
      showImage ? stashImage(e.image_path, imgKind, { eager: true }) : null));
    this.header.appendChild(h('div', { class: 'entity-copy' }, [
      h('h1', { class: 'detail-title' }, e.name || ''),
      facts.length ? h('div', { class: 'detail-facts' }, facts.map((f) => h('span', null, f))) : null,
      text ? h('p', { class: 'detail-text' }, text) : null,
      actions.length ? h('div', { class: 'detail-actions nav-group' }, actions) : null,
    ]));
  }

  async toggleFavorite(button) {
    const next = !this.item.favorite;
    try {
      await api.setPerformerFavorite(this.item.id, next);
      this.item.favorite = next;
      this.renderHeader(this.item);
      focusFirst(this.header);
      toast(next ? 'Added to favourites' : 'Removed from favourites');
    } catch (err) {
      toast(`Couldn't update: ${err.message}`, 'error');
      button.classList.toggle('on', !next);
    }
  }

  async pickSort() {
    const key = await chooseOption({
      title: 'Sort scenes by',
      options: api.SCENE_SORTS.map((s) => ({ label: s.label, value: s.key })),
      selected: this.sort.key,
    });
    if (!key) return;
    if (key === 'random') this.seed = Math.floor(Math.random() * 1e8);
    this.sort = api.SCENE_SORTS.find((s) => s.key === key);
    this.sortLabel.textContent = this.sort.label;
    this.grid.reset();
  }

  focusDefault() {
    if (!focusFirst(this.grid.el)) focusFirst(this.el);
  }
}
