/**
 * Library browsers: Scenes, Groups, Markers, Galleries, Images, Performers,
 * Studios and Tags.
 *
 * One screen class driven by a config: a toolbar with saved filters, a
 * filter panel, a sort menu and quick toggles, and a paged grid. The chosen
 * sort is remembered per section.
 *
 * The view's criteria (`this.criteria`) are kept in Stash's saved-filter
 * format and converted for each query (see api/savedFilters.js), so a saved
 * filter can be opened, changed in the filter panel and saved back.
 */
import { Screen } from '../ui/router.js';
import { h, icon } from '../util/dom.js';
import { Grid } from '../ui/grid.js';
import {
  chooseOption, confirmDialog, promptText, toast,
} from '../ui/overlay.js';
import { canEdit } from '../ui/editor.js';
import {
  MODES, SECTION_MODES, convertFilter, deleteSavedFilter, findSavedFilters, resolveSavedFilter, saveFilter,
} from '../api/savedFilters.js';
import { SECTION_CRITERIA, criteriaCount, openFilterPanel } from '../ui/filterPanel.js';
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

/**
 * Per-section configuration. Toggles carry their filter twice: `filter` in
 * the API's format for queries, and `uiFilter` in Stash's saved-filter
 * format for saving the current view as a saved filter.
 */
const CONFIGS = {
  scenes: {
    title: 'Scenes',
    kind: 'scene',
    sorts: api.SCENE_SORTS,
    find: api.findScenes,
    toggles: [
      {
        id: 'unwatched', label: 'Unwatched', filter: { play_count: { value: 0, modifier: 'EQUALS' } }, uiFilter: { play_count: { modifier: 'EQUALS', value: { value: 0 } } },
      },
      {
        id: 'inprogress', label: 'In progress', filter: api.filters.inProgress(), uiFilter: { resume_time: { modifier: 'GREATER_THAN', value: { value: 0 } } },
      },
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
  markers: {
    title: 'Markers',
    kind: 'marker',
    sorts: api.MARKER_SORTS,
    find: api.findMarkers,
    toggles: [],
    empty: 'No markers yet. Markers point to moments inside scenes.',
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
    toggles: [{
      id: 'favorites', label: 'Favourites', filter: { filter_favorites: true }, uiFilter: { filter_favorites: { modifier: 'EQUALS', value: 'true' } },
    }],
    empty: 'No performers match.',
  },
  studios: {
    title: 'Studios',
    kind: 'studio',
    sorts: api.STUDIO_SORTS,
    find: api.findStudios,
    toggles: [{
      id: 'favorites', label: 'Favourites', filter: { favorite: true }, uiFilter: { favorite: { modifier: 'EQUALS', value: 'true' } },
    }],
    empty: 'No studios match.',
  },
  tags: {
    title: 'Tags',
    kind: 'tag',
    sorts: api.TAG_SORTS,
    find: api.findTags,
    toggles: [{
      id: 'favorites', label: 'Favourites', filter: { favorite: true }, uiFilter: { favorite: { modifier: 'EQUALS', value: 'true' } },
    }],
    /** Tags with no scenes are hidden unless turned off in Settings. */
    baseFilter: () => (getSettings().hideEmptyTags ? { scene_count: { value: 0, modifier: 'GREATER_THAN' } } : null),
    empty: 'No tags match.',
  },
};

export class BrowseScreen extends Screen {
  /** @param {'scenes'|'groups'|'markers'|'galleries'|'images'|'performers'|'studios'|'tags'} section */
  constructor(section) {
    super();
    this.section = section;
    this.config = CONFIGS[section];
    this.el.classList.add('screen-browse');
    this.seed = Math.floor(Math.random() * 1e8);
    this.activeToggles = {};
    /** Filter criteria in Stash's saved-filter format (see filterPanel.js). */
    this.criteria = {};
    /** Text search (Filter panel), saved as a saved filter's `q`. */
    this.query = '';
    /** True when the view differs from the saved filter in use. */
    this.dirty = false;

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

    // Filter panel (rating, tags, performers…), for sections that have criteria.
    this.filterLabel = h('span', null, 'Filter');
    this.filterButton = SECTION_CRITERIA[section] ? h('div', {
      class: 'button ghost toggle focusable', onSelect: () => this.openFilter(),
    }, [icon('sliders'), this.filterLabel]) : null;

    this.toggleButtons = toggleButtons;
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
      h('div', { class: 'toolbar nav-group', 'data-no-memory': true }, [this.savedButton, this.filterButton, sortButton].concat(toggleButtons, extra)),
    ]));
    this.el.appendChild(this.grid.el);
  }

  async mount() {
    // Offer Stash's saved filters for this section, if any exist.
    try {
      this.savedFilters = await findSavedFilters(SECTION_MODES[this.section]);
    } catch (e) {
      this.savedFilters = [];
    }
    // With editing on, the menu can also create filters, so it is always shown.
    if (this.savedFilters.length || canEdit()) this.savedButton.style.display = '';
  }

  /**
   * The criteria in the API's format. The conversion asks the server about
   * field types (cached), so it is done once per change, not once per page.
   */
  apiCriteria() {
    const key = JSON.stringify(this.criteria);
    if (this.converted && this.converted.key === key) return this.converted.promise;
    const promise = Object.keys(this.criteria).length
      ? convertFilter(MODES[SECTION_MODES[this.section]].type, this.criteria).catch((err) => {
        toast(`Couldn't apply the filter: ${err.message}`, 'error');
        return {};
      })
      : Promise.resolve({});
    this.converted = { key, promise };
    return promise;
  }

  /** Builds the query for one page from the criteria, saved filter, sort and toggles. */
  async fetch(page, perPage) {
    let filter = this.config.baseFilter ? this.config.baseFilter() : null;
    const criteria = await this.apiCriteria();
    if (Object.keys(criteria).length) filter = Object.assign({}, filter || {}, criteria);
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
      q: this.query || undefined,
      filter,
    });
  }

  /**
   * The Saved filters menu: apply one of Stash's saved filters, or (with
   * editing on) save the current view as a new filter, update, rename or
   * delete the one in use.
   */
  async pickSaved() {
    const editing = canEdit();
    const options = [{ label: 'None', value: '' }]
      .concat(this.savedFilters.map((f) => ({ label: f.name, value: f.id })));
    if (editing) {
      options.push({ label: 'Save this view as a new filter…', value: '__new' });
      if (this.saved) {
        options.push({ label: `Update “${this.saved.name}” with this view`, value: '__update' });
        options.push({ label: `Rename “${this.saved.name}”…`, value: '__rename' });
        options.push({ label: `Delete “${this.saved.name}”…`, value: '__delete' });
      }
    }
    const choice = await chooseOption({ title: 'Saved filters', options, selected: this.saved ? this.saved.id : '' });
    if (choice === undefined) return;
    if (choice === '__new') return this.saveView();
    if (choice === '__update') return this.saveView(this.saved);
    if (choice === '__rename') return this.renameSaved();
    if (choice === '__delete') return this.deleteSaved();
    if (!choice) {
      this.applySaved(null);
      return undefined;
    }
    const f = this.savedFilters.find((x) => x.id === choice);
    try {
      this.applySaved(f, await resolveSavedFilter(f));
    } catch (err) {
      toast(`Couldn't use "${f.name}": ${err.message}`, 'error');
    }
    return undefined;
  }

  /**
   * Shows a saved filter's results (or, with `f` = null, the plain section).
   * The filter's criteria become the view's criteria; those that match a
   * toolbar toggle (e.g. Unwatched) switch that toggle on instead.
   */
  applySaved(f, resolved) {
    this.saved = f ? {
      id: f.id, name: f.name, query: resolved.query, raw: f,
    } : null;
    this.sortChosen = false;
    this.criteria = f ? JSON.parse(JSON.stringify(f.object_filter || {})) : {};
    this.query = (f && resolved.query.q) || '';
    this.activeToggles = {};
    this.config.toggles.forEach((t, i) => {
      const keys = Object.keys(t.uiFilter || {});
      const on = keys.length > 0 && keys.every((k) => this.criteria[k]);
      if (on) {
        this.activeToggles[t.id] = true;
        for (const k of keys) delete this.criteria[k];
      }
      this.toggleButtons[i].classList.toggle('on', on);
    });
    this.dirty = false;
    this.updateLabels();
    this.reload();
  }

  /** Marks the view as changed from the saved filter in use. */
  markDirty() {
    if (this.saved) this.dirty = true;
    this.updateLabels();
  }

  /** Saved filter and Filter button labels. */
  updateLabels() {
    const f = this.saved;
    this.savedLabel.textContent = f ? (this.dirty ? `${f.name} (changed)` : f.name) : 'Saved filters';
    this.savedButton.classList.toggle('on', !!f);
    if (this.filterButton) {
      const n = criteriaCount(this.criteria) + (this.query ? 1 : 0);
      this.filterLabel.textContent = n ? `Filter (${n})` : 'Filter';
      this.filterButton.classList.toggle('on', n > 0);
    }
  }

  /** Opens the filter panel; each change reloads the results. */
  openFilter() {
    openFilterPanel({
      section: this.section,
      criteria: this.criteria,
      onChange: (criteria) => {
        this.criteria = criteria;
        this.markDirty();
        this.reload();
      },
      query: this.query,
      onQuery: (q) => {
        this.query = q;
        this.markDirty();
        this.reload();
      },
    });
  }

  /**
   * The current view as a saved filter: the sort, the criteria (including
   * any a saved filter brought that the TV can't edit) and the active toggles.
   */
  currentView() {
    let objectFilter = JSON.parse(JSON.stringify(this.criteria));
    for (const t of this.config.toggles) {
      if (this.activeToggles[t.id] && t.uiFilter) objectFilter = Object.assign(objectFilter, t.uiFilter);
    }
    const useSaved = this.saved && this.saved.query.sort && !this.sortChosen;
    const findFilter = {
      sort: useSaved ? this.saved.query.sort : this.sort.key,
      direction: useSaved ? this.saved.query.direction : this.sort.direction,
      per_page: 40,
    };
    if (this.query) findFilter.q = this.query;
    return { findFilter, objectFilter };
  }

  /** Saves the current view as a new filter, or over `existing`. */
  async saveView(existing) {
    let name = existing ? existing.name : '';
    if (!existing) {
      name = await promptText({ title: 'Name for this filter', confirm: 'Save' });
      if (!name || !name.trim()) return;
      name = name.trim();
    }
    const view = this.currentView();
    try {
      const saved = await saveFilter({
        id: existing ? existing.id : undefined,
        mode: SECTION_MODES[this.section],
        name,
        findFilter: view.findFilter,
        objectFilter: view.objectFilter,
      });
      await this.refreshSaved();
      // The new filter now describes the view: show it as the active filter.
      this.applySaved(saved, await resolveSavedFilter(saved));
      toast(existing ? `Updated “${name}”` : `Saved “${name}”`);
    } catch (err) {
      toast(`Couldn't save the filter: ${err.message}`, 'error');
    }
  }

  async renameSaved() {
    const cur = this.saved;
    const name = await promptText({ title: 'Rename filter', value: cur.name, confirm: 'Rename' });
    if (!name || !name.trim() || name.trim() === cur.name) return;
    try {
      const raw = cur.raw;
      const saved = await saveFilter({
        id: cur.id, mode: raw.mode, name: name.trim(), findFilter: raw.find_filter, objectFilter: raw.object_filter,
      });
      await this.refreshSaved();
      this.saved.name = saved.name;
      this.saved.raw = saved;
      this.updateLabels();
      toast(`Renamed to “${saved.name}”`);
    } catch (err) {
      toast(`Couldn't rename: ${err.message}`, 'error');
    }
  }

  async deleteSaved() {
    const cur = this.saved;
    const ok = await confirmDialog({
      title: `Delete “${cur.name}”?`,
      message: 'The filter is removed from Stash for every device and the web UI.',
      confirm: 'Delete',
      safe: true,
    });
    if (!ok) return;
    try {
      await deleteSavedFilter(cur.id);
      await this.refreshSaved();
      this.applySaved(null);
      toast(`Deleted “${cur.name}”`);
    } catch (err) {
      toast(`Couldn't delete: ${err.message}`, 'error');
    }
  }

  /** Reloads the list of saved filters for this section. */
  async refreshSaved() {
    this.savedFilters = await findSavedFilters(SECTION_MODES[this.section]);
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
    this.markDirty();
    this.reload();
  }

  toggle(t, button) {
    this.activeToggles[t.id] = !this.activeToggles[t.id];
    button.classList.toggle('on', this.activeToggles[t.id]);
    this.markDirty();
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
