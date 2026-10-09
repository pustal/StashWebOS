/**
 * Search across scenes, groups, galleries, performers, studios, images and tags.
 *
 * Press OK on the field to open the TV keyboard. Results update shortly
 * after typing stops; press Down to leave the field and browse them.
 */
import { Screen } from '../ui/router.js';
import { h, icon } from '../util/dom.js';
import { createRow } from '../ui/row.js';
import { focus } from '../nav/focus.js';
import * as api from '../api/stash.js';

const DEBOUNCE_MS = 600;
const PER_ROW = 20;

export class SearchScreen extends Screen {
  constructor() {
    super();
    this.section = 'search';
    this.el.classList.add('screen-search');
    this.input = h('input', {
      class: 'search-input focusable',
      type: 'search',
      placeholder: 'Search scenes, galleries, images, people, tags',
      autocomplete: 'off',
      spellcheck: 'false',
      'data-autofocus': true,
      onInput: () => this.schedule(),
    });
    this.results = h('div', { class: 'search-results' });
    this.hint = h('p', { class: 'search-hint' }, 'Press OK to type.');
    this.el.appendChild(h('div', { class: 'search-bar' }, [icon('search'), this.input]));
    this.el.appendChild(this.hint);
    this.el.appendChild(this.results);
    this.timer = null;
    this.lastQuery = '';
    this.generation = 0;
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), DEBOUNCE_MS);
  }

  run() {
    const text = this.input.value.trim();
    if (text === this.lastQuery) return;
    this.lastQuery = text;
    this.generation += 1;
    const gen = this.generation;
    this.results.innerHTML = '';
    if (text.length < 2) {
      this.hint.textContent = 'Type at least two letters.';
      return;
    }
    this.hint.textContent = '';
    const items = (p) => p.then((r) => r.items);
    const rows = [
      createRow({ title: 'Scenes', kind: 'scene', load: () => items(api.findScenes({ q: text, perPage: PER_ROW })) }),
      createRow({ title: 'Groups', kind: 'group', load: () => items(api.findGroups({ q: text, perPage: PER_ROW })) }),
      createRow({ title: 'Galleries', kind: 'gallery', load: () => items(api.findGalleries({ q: text, perPage: PER_ROW })) }),
      createRow({ title: 'Performers', kind: 'performer', load: () => items(api.findPerformers({ q: text, perPage: PER_ROW, sort: 'scenes_count', direction: 'DESC' })) }),
      createRow({ title: 'Studios', kind: 'studio', load: () => items(api.findStudios({ q: text, perPage: PER_ROW, sort: 'scenes_count', direction: 'DESC' })) }),
      createRow({ title: 'Images', kind: 'image', load: () => items(api.findImages({ q: text, perPage: PER_ROW })) }),
      createRow({ title: 'Tags', kind: 'tag', load: () => items(api.findTags({ q: text, perPage: PER_ROW, sort: 'scenes_count', direction: 'DESC' })) }),
    ];
    for (const r of rows) this.results.appendChild(r.el);
    Promise.all(rows.map((r) => r.ready)).then((counts) => {
      if (gen !== this.generation) return;
      if (counts.every((n) => !n)) this.hint.textContent = `Nothing found for “${text}”.`;
    });
  }

  /**
   * While typing: Up/Down leave the field, OK closes the keyboard and
   * searches immediately.
   */
  onKey(e) {
    if (document.activeElement !== this.input) return false;
    if (e.keyCode === 13) {
      this.input.blur();
      clearTimeout(this.timer);
      this.run();
      return true;
    }
    if (e.keyCode === 40 || e.keyCode === 38) {
      this.input.blur();
      return false; // let navigation move the highlight
    }
    return e.keyCode === 37 || e.keyCode === 39; // keep caret movement inside the field
  }

  onBack() {
    if (document.activeElement === this.input) {
      this.input.blur();
      focus(this.input);
      return true;
    }
    return false;
  }
}
