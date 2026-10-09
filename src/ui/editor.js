/**
 * Edit panel: changes an item's metadata in Stash from the TV.
 *
 * What can be edited (things that work well with a remote):
 * - scenes: title, rating, O-count, organized, studio, tags, performers,
 *   groups (with the scene's number in each), galleries and markers
 *   (see markerEditor.js)
 * - images: title, rating, O-count, organized, studio, performers, tags and
 *   galleries
 * - galleries: title, rating, organized, studio, performers, tags and scenes
 * - groups: rating, studio, tags, the groups they are part of and sub-groups
 * - performers: rating, favourite and tags
 * - studios: rating, favourite, parent studio and tags
 * - tags: favourite, parent tags and sub-tags
 *
 * Tags, performers and studios that don't exist yet can be created from the
 * pickers (name only).
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
import { pickPerformer, pickStudio, pickTag } from './panel.js';
import { getSettings } from '../settings.js';
import * as api from '../api/stash.js';
import {
  countOf, formatDate, formatDuration, galleryTitle, imageTitle, sceneTitle, stars,
} from '../util/format.js';
import {
  addMarker, askTime, editMarker, markerName, markerTime,
} from './markerEditor.js';

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
  scene: ['title', 'rating', 'o', 'organized', 'studio', 'tags', 'performers', 'groups', 'galleries', 'markers'],
  image: ['title', 'rating', 'o', 'organized', 'studio', 'performers', 'tags', 'galleries'],
  gallery: ['title', 'rating', 'organized', 'studio', 'performers', 'tags', 'scenes'],
  group: ['rating', 'studio', 'tags', 'containing', 'subgroups'],
  performer: ['rating', 'favorite', 'tags'],
  studio: ['rating', 'favorite', 'parent', 'tags'],
  tag: ['favorite', 'parents', 'children'],
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
    // Tags and performers can also be created from the picker.
    tags: listAction('Tags', 'tag', 'tags', 'tag_ids', null, {
      pick: (title, cur) => pickTag(title, cur, { create: true }),
    }),
    performers: listAction('Performers', 'performer', 'performers', 'performer_ids', null, {
      pick: (title, cur) => pickPerformer(title, cur, { create: true }),
    }),
    // Tag hierarchy (a tag can't be its own parent or child).
    parents: listAction('Parent tags', 'parent tag', 'parents', 'parent_ids', null, {
      pick: (title, cur) => pickTag(title, cur.concat([item]), { create: true }),
    }),
    children: listAction('Sub-tags', 'sub-tag', 'children', 'child_ids', null, {
      pick: (title, cur) => pickTag(title, cur.concat([item]), { create: true }),
    }),
    galleries: listAction('Galleries', 'gallery', 'galleries', 'gallery_ids', api.findGalleries, {
      labelOf: galleryTitle,
      sort: 'title',
      direction: 'ASC',
      hintOf: (g) => countOf(g.image_count, 'image'),
      keep: (g) => ({
        id: g.id, title: g.title, files: g.files, folder: g.folder, image_count: g.image_count,
      }),
    }),
    scenes: listAction('Scenes', 'scene', 'scenes', 'scene_ids', api.findScenes, {
      labelOf: sceneTitle,
      sort: 'title',
      direction: 'ASC',
      hintOf: (x) => formatDate(x.date) || '',
      keep: (x) => x,
    }),
    markers: {
      label: 'Markers',
      value: () => String((item.scene_markers || []).length),
      run: async () => {
        const list = (item.scene_markers || []).slice().sort((a, b) => a.seconds - b.seconds);
        const choice = await chooseOption({
          title: 'Markers',
          options: [{ label: 'Add a marker…', value: '__add' }].concat(list.map((m) => ({
            label: markerName(m), hint: markerTime(m), value: m.id,
          }))),
        });
        if (choice === undefined) return;
        const file = item.files && item.files[0];
        const duration = file ? file.duration : 0;
        if (choice === '__add') {
          const sec = await askTime('Time of the new marker', 0, duration);
          if (sec === undefined) return;
          const m = await addMarker(item.id, sec);
          if (!m) return;
          item.scene_markers = (item.scene_markers || []).concat([m]);
        } else {
          const m = list.find((x) => x.id === choice);
          const res = await editMarker(m, { duration });
          if (!res.changed) return;
          if (res.deleted) item.scene_markers = item.scene_markers.filter((x) => x.id !== m.id);
        }
        changed = true;
        render();
        if (onSaved) onSaved({ scene_markers: item.scene_markers });
      },
    },
    studio: studioAction('Studio', 'studio', 'studio_id'),
    parent: studioAction('Parent studio', 'parent_studio', 'parent_id'),
    containing: groupLinks('Part of', 'containing_groups', 'Add to a parent group…'),
    subgroups: groupLinks('Sub-groups', 'sub_groups', 'Add a sub-group…'),
    groups: {
      label: 'Groups',
      value: () => String((item.groups || []).length),
      run: async () => {
        const current = item.groups || [];
        const choice = await chooseOption({
          title: 'Groups',
          options: [{ label: 'Add to a group…', value: '__add' }].concat(current.map((gs) => ({
            label: gs.group.name, hint: gs.scene_index ? `#${gs.scene_index}, remove` : 'Remove', value: gs.group.id,
          }))),
        });
        if (choice === undefined) return;
        let next;
        let message;
        if (choice === '__add') {
          const picked = await pickBySearch({
            title: 'Add to a group',
            search: (text) => api.findGroups({ q: text, perPage: 20, sort: 'name', direction: 'ASC' })
              .then((r) => r.items.filter((x) => !current.some((c) => c.group.id === x.id))
                .map((x) => ({ label: x.name, hint: countOf(x.scene_count, 'scene'), value: x }))),
          });
          if (!picked) return;
          // The scene's position in the group (optional; Stash orders by it).
          const num = await promptText({
            title: `Scene number in ${picked.name}`,
            placeholder: 'Leave empty for none',
            value: String((picked.scene_count || 0) + 1),
            confirm: 'Add',
          });
          if (num === undefined) return;
          const index = parseInt(num, 10);
          next = current.concat([{ group: { id: picked.id, name: picked.name }, scene_index: index > 0 ? index : null }]);
          message = `Added to ${picked.name}`;
        } else {
          const removed = current.find((gs) => gs.group.id === choice);
          next = current.filter((gs) => gs.group.id !== choice);
          message = `Removed from ${removed ? removed.group.name : 'group'}`;
        }
        const groups = next.map((gs) => {
          const g = { group_id: gs.group.id };
          if (gs.scene_index) g.scene_index = gs.scene_index;
          return g;
        });
        if (await save({ groups }, message)) {
          item.groups = next;
          render();
          if (onSaved) onSaved({ groups: next });
        }
      },
    },
  };

  /**
   * Choose/remove action for a single studio field: a scene's (or gallery's,
   * image's, group's) studio, or a studio's parent studio. A new studio can
   * be created from the picker.
   * @param {string} label
   * @param {string} field    item field holding {id, name} or null
   * @param {string} idField  update input field (studio_id / parent_id)
   */
  function studioAction(label, field, idField) {
    return {
      label,
      value: () => (item[field] ? item[field].name : 'None'),
      run: async () => {
        const cur = item[field];
        const choice = cur
          ? await chooseOption({
            title: label,
            options: [{ label: 'Choose another studio…', value: 'pick' }, { label: `Remove ${cur.name}`, value: 'remove' }],
          })
          : 'pick';
        if (!choice) return;
        if (choice === 'remove') {
          if (await save({ [idField]: null }, `Removed ${cur.name}`)) {
            item[field] = null;
            delete item[idField];
            render();
          }
          return;
        }
        // A studio can't be its own parent.
        const exclude = (cur ? [cur] : []).concat(kind === 'studio' ? [item] : []);
        const picked = await pickStudio(`Choose ${label.toLowerCase()}`, exclude, { create: true });
        if (!picked) return;
        if (await save({ [idField]: picked.id }, `${label}: ${picked.name}`)) {
          item[field] = { id: picked.id, name: picked.name };
          delete item[idField];
          render();
        }
      },
    };
  }

  /**
   * Add/remove action for a group's place in the group hierarchy: the groups
   * it is part of (`containing_groups`) or its sub-groups (`sub_groups`).
   * Both are lists of {group, description}; descriptions are kept as they are.
   * @param {string} label
   * @param {string} field     'containing_groups' or 'sub_groups' (also the input field)
   * @param {string} addLabel
   */
  function groupLinks(label, field, addLabel) {
    return {
      label,
      value: () => String((item[field] || []).length),
      run: async () => {
        const current = item[field] || [];
        const choice = await chooseOption({
          title: label,
          options: [{ label: addLabel, value: '__add' }].concat(current.map((x) => ({
            label: x.group.name, hint: 'Remove', value: x.group.id,
          }))),
        });
        if (choice === undefined) return;
        let next;
        let message;
        if (choice === '__add') {
          const picked = await pickBySearch({
            title: addLabel.replace(/…$/, ''),
            search: (text) => api.findGroups({ q: text, perPage: 20, sort: 'name', direction: 'ASC' })
              .then((r) => r.items.filter((x) => x.id !== item.id && !current.some((c) => c.group.id === x.id))
                .map((x) => ({ label: x.name, hint: countOf(x.scene_count, 'scene'), value: x }))),
          });
          if (!picked) return;
          next = current.concat([{ group: picked, description: null }]);
          message = `Added ${picked.name}`;
        } else {
          const removed = current.find((x) => x.group.id === choice);
          next = current.filter((x) => x.group.id !== choice);
          message = `Removed ${removed ? removed.group.name : 'group'}`;
        }
        const input = next.map((x) => {
          const g = { group_id: x.group.id };
          if (x.description) g.description = x.description;
          return g;
        });
        if (await save({ [field]: input }, message)) {
          item[field] = next;
          render();
          if (onSaved) onSaved({ [field]: next });
        }
      },
    };
  }

  /**
   * Add/remove action for a list field (tags, performers).
   * @param {string} label
   * @param {string} noun
   * @param {string} field     item field holding [{id, name}]
   * @param {string} idsField  update input field (e.g. tag_ids)
   * @param {Function|null} finder  api.findGalleries… (not needed with opts.pick)
   * @param {Object} [opts]  labelOf, sort, direction, hintOf, keep; or
   *   pick(title, current) → Promise<{id, name}> to use another picker
   */
  function listAction(label, noun, field, idsField, finder, opts) {
    const o = Object.assign({
      labelOf: (x) => x.name,
      sort: 'scenes_count',
      direction: 'DESC',
      hintOf: (x) => (x.scene_count !== undefined ? `${x.scene_count} scenes` : ''),
      keep: (x) => ({ id: x.id, name: x.name, image_path: x.image_path }),
    }, opts || {});
    return {
      label,
      value: () => String((item[field] || []).length),
      run: async () => {
        const current = item[field] || [];
        const choice = await chooseOption({
          title: label,
          options: [{ label: `Add a ${noun}…`, value: '__add' }].concat(
            current.map((x) => ({ label: o.labelOf(x), hint: 'Remove', value: x.id })),
          ),
        });
        if (choice === undefined) return;
        let next;
        let message;
        if (choice === '__add') {
          const picked = o.pick ? await o.pick(`Add a ${noun}`, current) : await pickBySearch({
            title: `Add a ${noun}`,
            search: (text) => finder({
              q: text, perPage: 20, sort: o.sort, direction: o.direction,
            }).then((r) => r.items.filter((x) => !current.some((c) => c.id === x.id))
              .map((x) => ({ label: o.labelOf(x), hint: o.hintOf(x), value: x }))),
          });
          if (!picked) return;
          next = current.concat([o.keep(picked)]);
          message = `Added ${o.labelOf(picked)}`;
        } else {
          const removed = current.find((x) => x.id === choice);
          next = current.filter((x) => x.id !== choice);
          message = `Removed ${removed ? o.labelOf(removed) : noun}`;
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
