/**
 * Performer, studio and tag screens: a header about the entity and its
 * scenes, galleries, images and groups in tabs (empty tabs are hidden).
 */
import { Screen } from '../ui/router.js';
import { h, icon } from '../util/dom.js';
import { Collection } from '../ui/collection.js';
import { stashImage } from '../ui/cards.js';
import { toast } from '../ui/overlay.js';
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
    this.el.classList.add('screen-entity', `screen-entity-${kind}`);

    this.header = h('header', { class: 'entity-header' });
    this.collection = new Collection({
      types: ['scene', 'gallery', 'image', 'group'],
      filter: () => this.conf.filter(this.item.id),
      // Until the details arrive we don't know which tabs have content.
      counts: { gallery: 0, image: 0, group: 0 },
    });

    this.el.appendChild(this.header);
    this.el.appendChild(this.collection.el);
    this.renderHeader(item);
  }

  async mount() {
    try {
      const full = await this.conf.load(this.item.id);
      if (full) {
        this.item = full;
        this.renderHeader(full);
        this.collection.setCounts({
          gallery: full.gallery_count, image: full.image_count, group: full.group_count,
        });
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

  focusDefault() {
    if (!this.collection.focus()) focusFirst(this.el);
  }
}
