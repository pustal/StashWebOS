/**
 * Edit panel: changes an item's metadata in Stash from the TV.
 *
 * What can be edited (things that work well with a remote):
 * - scenes: title, rating, O-count, organized, tags, performers
 * - images: title, rating, O-count, organized
 * - galleries: title, rating, organized
 * - groups: rating
 * - performers and studios: rating, favourite
 * - tags: favourite
 *
 * Every change is saved immediately (there is no separate Save step) and
 * reported back through `onSaved(patch)` so the calling screen can update.
 * Editing can be turned off in Settings (e.g. for a shared TV).
 */
import { h, icon } from '../util/dom.js';
import {
  chooseOption, openModal, pickBySearch, promptText, toast,
} from './overlay.js';
import { focus, getFocused } from '../nav/focus.js';
import { getSettings } from '../settings.js';
import * as api from '../api/stash.js';
import {
  galleryTitle, imageTitle, sceneTitle, stars,
} from '../util/format.js';

/** True when editing is allowed (Settings → Editing). */
export function canEdit() {
  return getSettings().allowEditing !== false;
}

/** Rating choices: none, then half stars up to five (rating100 = stars × 20). */
const RATING_OPTIONS = [{ label: 'No rating', value: null }].concat(
  [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5].map((n) => ({ label: `${n} ★`, value: Math.round(n * 20) })),
);

/** Field definitions per kind, in display order. */
const FIELDS = {
  scene: ['title', 'rating', 'o', 'organized', 'tags', 'performers'],
  image: ['title', 'rating', 'o', 'organized'],
  gallery: ['title', 'rating', 'organized'],
  group: ['rating'],
  performer: ['rating', 'favorite'],
  studio: ['rating', 'favorite'],
  tag: ['favorite'],
};

/** Display name of an item for the panel title. */
function nameOf(kind, item) {
  if (kind === 'scene') return sceneTitle(item);
  if (kind === 'image') return imageTitle(item);
  if (kind === 'gallery') return galleryTitle(item);
  return item.name || item.title || '';
}

/**
 * Opens the edit panel for an item.
 * @param {'scene'|'image'|'gallery'|'group'|'performer'|'studio'|'tag'} kind
 * @param {Object} item  the item as loaded by its screen (fields are read
 *   from it and updated in place)
 * @param {(patch: Object) => void} [onSaved] called after each saved change
 * @param {(changed: boolean) => void} [onClose] called when the panel closes
 */
export function openEditor(kind, item, onSaved, onClose) {
  if (!canEdit()) return;
  const lines = h('div', { class: 'menu-list scroll-y' });
  const panel = h('div', { class: 'menu-panel editor-panel' }, [
    h('h2', { class: 'menu-title' }, 'Edit'),
    h('p', { class: 'editor-subject' }, nameOf(kind, item)),
    lines,
  ]);
  let changed = false;
  const close = openModal(panel, {
    side: true,
    onDismiss: () => {
      if (onClose) onClose(changed);
    },
  });

  /** Saves a patch, updates the item and the panel. */
  const save = async (patch, message) => {
    try {
      await api.updateItem(kind, item.id, patch);
    } catch (err) {
      toast(`Couldn't save: ${err.message}`, 'error');
      return false;
    }
    Object.assign(item, patch);
    changed = true;
    toast(message || 'Saved');
    render();
    if (onSaved) onSaved(patch);
    return true;
  };

  const actions = {
    title: {
      label: 'Title',
      value: () => item.title || '—',
      run: async () => {
        const v = await promptText({ title: 'Title', value: item.title || '' });
        if (v === undefined || v === (item.title || '')) return;
        await save({ title: v }, 'Title saved');
      },
    },
    rating: {
      label: 'Rating',
      value: () => (item.rating100 ? `${stars(item.rating100)} ★` : 'None'),
      run: async () => {
        const v = await chooseOption({ title: 'Rating', options: RATING_OPTIONS, selected: item.rating100 || null });
        if (v === undefined || v === (item.rating100 || null)) return;
        await save({ rating100: v }, v ? `Rated ${stars(v)} ★` : 'Rating removed');
      },
    },
    o: {
      label: 'O-count',
      value: () => String(item.o_counter || 0),
      run: async () => {
        const v = await chooseOption({
          title: 'O-count',
          options: [{ label: 'Add one', value: 1 }].concat(item.o_counter ? [{ label: 'Remove one', value: -1 }] : []),
        });
        if (!v) return;
        try {
          item.o_counter = await api.changeO(kind, item.id, v);
        } catch (err) {
          toast(`Couldn't save: ${err.message}`, 'error');
          return;
        }
        changed = true;
        toast(`O-count: ${item.o_counter}`);
        render();
        if (onSaved) onSaved({ o_counter: item.o_counter });
      },
    },
    organized: {
      label: 'Organized',
      value: () => (item.organized ? 'Yes' : 'No'),
      run: () => save({ organized: !item.organized }, item.organized ? 'Marked as not organized' : 'Marked as organized'),
    },
    favorite: {
      label: 'Favourite',
      value: () => (item.favorite ? 'Yes' : 'No'),
      run: () => save({ favorite: !item.favorite }, item.favorite ? 'Removed from favourites' : 'Added to favourites'),
    },
    tags: listAction('Tags', 'tag', 'tags', 'tag_ids', api.findTags),
    performers: listAction('Performers', 'performer', 'performers', 'performer_ids', api.findPerformers),
  };

  /**
   * Add/remove action for a list field (tags, performers).
   * @param {string} label
   * @param {string} noun
   * @param {string} field     item field holding [{id, name}]
   * @param {string} idsField  update input field (e.g. tag_ids)
   * @param {Function} finder  api.findTags / api.findPerformers
   */
  function listAction(label, noun, field, idsField, finder) {
    return {
      label,
      value: () => String((item[field] || []).length),
      run: async () => {
        const current = item[field] || [];
        const choice = await chooseOption({
          title: label,
          options: [{ label: `Add a ${noun}…`, value: '__add' }].concat(
            current.map((x) => ({ label: x.name, hint: 'Remove', value: x.id })),
          ),
        });
        if (choice === undefined) return;
        let next;
        let message;
        if (choice === '__add') {
          const picked = await pickBySearch({
            title: `Add a ${noun}`,
            search: (text) => finder({ q: text, perPage: 20, sort: 'scenes_count', direction: 'DESC' })
              .then((r) => r.items.filter((x) => !current.some((c) => c.id === x.id))
                .map((x) => ({ label: x.name, hint: x.scene_count !== undefined ? `${x.scene_count} scenes` : '', value: x }))),
          });
          if (!picked) return;
          next = current.concat([{ id: picked.id, name: picked.name, image_path: picked.image_path }]);
          message = `Added ${picked.name}`;
        } else {
          const removed = current.find((x) => x.id === choice);
          next = current.filter((x) => x.id !== choice);
          message = `Removed ${removed ? removed.name : noun}`;
        }
        const ok = await save({ [idsField]: next.map((x) => x.id) }, message);
        if (ok) {
          item[field] = next;
          delete item[idsField];
          render();
          if (onSaved) onSaved({ [field]: next });
        }
      },
    };
  }

  /** (Re)draws the lines, keeping the highlight on the same field. */
  function render() {
    const focusedKey = lines.__focusedKey;
    lines.innerHTML = '';
    let toFocus = null;
    for (const key of FIELDS[kind]) {
      const a = actions[key];
      const el = h('div', {
        class: 'menu-item focusable',
        onSelect: () => {
          lines.__focusedKey = key;
          a.run();
        },
      }, [h('span', { class: 'menu-label' }, a.label), h('span', { class: 'menu-hint' }, a.value())]);
      if (key === focusedKey) toFocus = el;
      lines.appendChild(el);
    }
    // Put the highlight back on the redrawn line, unless it is somewhere
    // else that still exists (e.g. another dialog on top of the editor).
    const f = getFocused();
    if (toFocus && (!f || !document.documentElement.contains(f) || lines.contains(f))) focus(toFocus);
  }

  render();
  focus(lines.firstChild);
  return close;
}

/**
 * An "Edit" button for a detail page header, or null when editing is off.
 * @param {string} kind
 * @param {() => Object} getItem  returns the (full) item to edit
 * @param {() => void} onChanged  called after the panel closes with changes;
 *   the screen re-renders and should re-highlight its `.edit-button`
 */
export function editButton(kind, getItem, onChanged) {
  if (!canEdit()) return null;
  return h('div', {
    class: 'button ghost focusable edit-button',
    onSelect: () => openEditor(kind, getItem(), null, (changed) => {
      if (changed) onChanged();
    }),
  }, [icon('edit'), 'Edit']);
}
