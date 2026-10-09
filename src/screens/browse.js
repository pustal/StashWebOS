/**
 * Library browsers: Scenes, Groups, Galleries, Images, Performers, Studios
 * and Tags.
 *
 * One screen class driven by a config: a toolbar with a sort menu and
 * filter toggles, and a paged grid. The chosen sort is remembered per
 * section.
 */
import { Screen } from '../ui/router.js';
import { h, icon } from '../util/dom.js';
import { Grid } from '../ui/grid.js';
import { chooseOption, toast } from '../ui/overlay.js';
import { SECTION_MODES, findSavedFilters, resolveSavedFilter } from '../api/savedFilters.js';
import { focusFirst } from '../nav/focus.js';
import { openItem } from '../ui/navigate.js';
import * as api from '../api/stash.js';
import { getSettings, updateSettings } from '../settings.js';

const SORT_STORE = 'stash.sorts.v1';

function loadSort(section) {
  try {
    return JSON.parse(window.localStorage.getItem(SORT_STORE) || '{}')[section] || null;
  } catch (e) {
    return null;
  }
}

function saveSort(section, key) {
  try {
    const all = JSON.parse(window.localStorage.getItem(SORT_STORE) || '{}');
    all[section] = key;
    window.localStorage.setItem(SORT_STORE, JSON.stringify(all));
  } catch (e) { /* storage full or unavailable: not important */ }
}

/** Per-section configuration. */
const CONFIGS = {
  scenes: {
    title: 'Scenes',
    kind: 'scene',
    sorts: api.SCENE_SORTS,
    find: api.findScenes,
    toggles: [
      { id: 'unwatched', label: 'Unwatched', filter: { play_count: { value: 0, modifier: 'EQUALS' } } },
      { id: 'inprogress', label: 'In progress', filter: api.filters.inProgress() },
    ],
    empty: 'No scenes match. Try another filter.',
  },
  groups: {
    title: 'Groups',
    kind: 'group',
    sorts: api.GROUP_SORTS,
    find: api.findGroups,
    toggles: [],
    empty: 'No groups yet. Groups (formerly movies) collect scenes into series.',
  },
  galleries: {
    title: 'Galleries',
    kind: 'gallery',
    sorts: api.GALLERY_SORTS,
    find: api.findGalleries,
    toggles: [],
    empty: 'No galleries yet.',
  },
  images: {
    title: 'Images',
    kind: 'image',
    sorts: api.IMAGE_SORTS,
    find: api.findImages,
    toggles: [],
    empty: 'No images yet.',
  },
  performers: {
    title: 'Performers',
    kind: 'performer',
    sorts: api.PERFORMER_SORTS,
    find: api.findPerformers,
    toggles: [{ id: 'favorites', label: 'Favourites', filter: { filter_favorites: true } }],
    empty: 'No performers match.',
  },
  studios: {
    title: 'Studios',
    kind: 'studio',
    sorts: api.STUDIO_SORTS,
    find: api.findStudios,
    toggles: [{ id: 'favorites', label: 'Favourites', filter: { favorite: true } }],
    empty: 'No studios match.',
  },
  tags: {
    title: 'Tags',
    kind: 'tag',
    sorts: api.TAG_SORTS,
    find: api.findTags,
    toggles: [{ id: 'favorites', label: 'Favourites', filter: { favorite: true } }],
    /** Tags with no scenes are hidden unless turned off in Settings. */
    baseFilter: () => (getSettings().hideEmptyTags ? { scene_count: { value: 0, modifier: 'GREATER_THAN' } } : null),
    empty: 'No tags match.',
  },
};

export class BrowseScreen extends Screen {
  /** @param {'scenes'|'groups'|'galleries'|'images'|'performers'|'studios'|'tags'} section */
  constructor(section) {
    super();
    this.section = section;
    this.config = CONFIGS[section];
    this.el.classList.add('screen-browse');
    this.seed = Math.floor(Math.random() * 1e8);
    this.activeToggles = {};

    const savedSort = loadSort(section);
    this.sort = this.config.sorts.find((s) => s.key === savedSort) || this.config.sorts[0];

    this.countEl = h('span', { class: 'page-count' });
    this.sortLabel = h('span', null, this.sort.label);
    const sortButton = h('div', { class: 'button ghost focusable', onSelect: () => this.pickSort() }, [icon('sort'), this.sortLabel]);
    const toggleButtons = this.config.toggles.map((t) => {
      const b = h('div', { class: 'button ghost toggle focusable', onSelect: () => this.toggle(t, b) }, [icon('check', 'toggle-check'), h('span', null, t.label)]);
      return b;
    });
    const extra = section === 'images'
      ? [h('div', { class: 'button ghost focusable', onSelect: () => this.slideshow() }, [icon('play'), h('span', null, 'Slideshow')])]
      : section === 'tags'
      ? [h('div', {
        class: 'button ghost toggle focusable' + (getSettings().showTagImages ? '' : ' on'),
        onSelect: (b) => {
          updateSettings({ showTagImages: !getSettings().showTagImages });
          b.classList.toggle('on', !getSettings().showTagImages);
          this.reload();
        },
      }, [icon('check', 'toggle-check'), h('span', null, 'Names only')])]
      : [];

    // Saved filters from Stash (the button stays hidden if there are none).
    this.saved = null;
    this.savedLabel = h('span', null, 'Saved filters');
    this.savedButton = h('div', {
      class: 'button ghost toggle focusable', style: { display: 'none' }, onSelect: () => this.pickSaved(),
    }, [icon('filter'), this.savedLabel]);

    this.grid = new Grid({
      kind: this.config.kind,
      perPage: 40,
      emptyText: this.config.empty,
      fetchPage: (page, perPage) => this.fetch(page, perPage),
      onCount: (n) => {
        this.countEl.textContent = n === 1 ? '1 item' : `${n.toLocaleString()} items`;
      },
    });

    this.el.appendChild(h('header', { class: 'page-header' }, [
      h('div', { class: 'page-heading' }, [h('h1', { class: 'page-title' }, this.config.title), this.countEl]),
      h('div', { class: 'toolbar nav-group', 'data-no-memory': true }, [this.savedButton, sortButton].concat(toggleButtons, extra)),
    ]));
    this.el.appendChild(this.grid.el);
  }

  async mount() {
    // Offer Stash's saved filters for this section, if any exist.
    try {
      this.savedFilters = await findSavedFilters(SECTION_MODES[this.section]);
      if (this.savedFilters.length) this.savedButton.style.display = '';
    } catch (e) {
      this.savedFilters = [];
    }
  }

  /** Builds the query for one page from the saved filter, sort and toggles. */
  fetch(page, perPage) {
    let filter = this.config.baseFilter ? this.config.baseFilter() : null;
    if (this.saved) filter = Object.assign({}, filter || {}, this.saved.query.filter);
    for (const t of this.config.toggles) {
      if (this.activeToggles[t.id]) filter = Object.assign({}, filter || {}, t.filter);
    }
    // A saved filter brings its own sort until the user picks another one.
    const useSavedSort = this.saved && this.saved.query.sort && !this.sortChosen;
    return this.config.find({
      page,
      perPage,
      sort: useSavedSort ? this.saved.query.sort : api.sortKey(this.sort.key, this.seed),
      direction: useSavedSort ? this.saved.query.direction : this.sort.direction,
      q: this.saved ? this.saved.query.q : undefined,
      filter,
    });
  }

  /** Applies (or clears) one of Stash's saved filters. */
  async pickSaved() {
    const id = await chooseOption({
      title: 'Saved filters',
      options: [{ label: 'None', value: '' }].concat(this.savedFilters.map((f) => ({ label: f.name, value: f.id }))),
      selected: this.saved ? this.saved.id : '',
    });
    if (id === undefined) return;
    if (!id) {
      this.saved = null;
      this.savedLabel.textContent = 'Saved filters';
      this.savedButton.classList.remove('on');
      this.reload();
      return;
    }
    const f = this.savedFilters.find((x) => x.id === id);
    try {
      const resolved = await resolveSavedFilter(f);
      this.saved = { id, name: f.name, query: resolved.query };
    } catch (err) {
      toast(`Couldn't use "${f.name}": ${err.message}`, 'error');
      return;
    }
    this.sortChosen = false;
    this.savedLabel.textContent = f.name;
    this.savedButton.classList.add('on');
    this.reload();
  }

  reload() {
    window.scrollTo(0, 0);
    this.grid.reset();
  }

  async pickSort() {
    const key = await chooseOption({
      title: 'Sort by',
      options: this.config.sorts.map((s) => ({ label: s.label, value: s.key })),
      selected: this.sort.key,
    });
    if (!key) return;
    if (key === 'random') this.seed = Math.floor(Math.random() * 1e8); // new shuffle each time
    this.sort = this.config.sorts.find((s) => s.key === key);
    this.sortChosen = true;
    this.sortLabel.textContent = this.sort.label;
    saveSort(this.section, key);
    this.reload();
  }

  toggle(t, button) {
    this.activeToggles[t.id] = !this.activeToggles[t.id];
    button.classList.toggle('on', this.activeToggles[t.id]);
    this.reload();
  }

  /** Starts a slideshow over the current image results. */
  slideshow() {
    const g = this.grid;
    if (!g.loaded) return;
    openItem('image', null, {
      items: g.items.slice(), index: 0, count: g.count, perPage: g.perPage, fetchPage: g.fetchPage, slideshow: true,
    });
  }

  focusDefault() {
    if (!focusFirst(this.grid.el)) focusFirst(this.el);
  }
}
