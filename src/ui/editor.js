/**
 * Edit panel: changes an item's metadata in Stash from the TV.
 *
 * What can be edited (see FIELDS for the exact lines per kind):
 * - details: titles/names, codes, dates, director, photographer, longer
 *   descriptions, links (URLs), aliases, performer gender/country/height…
 * - images from a URL (performers, studios, tags, group covers) and a
 *   scene's cover from a video frame
 * - ratings, favourites, O-count and Organized
 * - links: studio, performers, tags, galleries, scenes, groups (with the
 *   scene's number), markers (see markerEditor.js)
 * - hierarchies: parent tags/sub-tags, parent studio, containing groups and
 *   sub-groups
 * - scenes, images, galleries, groups and performers can be scraped (see
 *   scraper.js), and every kind can be deleted (scenes, images and galleries
 *   optionally with their files)
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
  chooseOption, confirmDialog, openModal, pickBySearch, promptText, toast,
} from './overlay.js';
import { focus, getFocused } from '../nav/focus.js';
import { pickPerformer, pickStudio, pickTag } from './panel.js';
import { getSettings } from '../settings.js';
import * as api from '../api/stash.js';
import {
  countOf, formatDate, formatDuration, galleryTitle, imageTitle, parseDuration, sceneTitle, stars,
} from '../util/format.js';
import { scrapeItem } from './scraper.js';
import { goBack } from './navigate.js';
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
/**
 * Field definitions per kind, in display order. Entries starting with '#'
 * are section headings.
 */
const FIELDS = {
  scene: ['#Details', 'title', 'code', 'date', 'director', 'details', 'urls',
    '#Rating', 'rating', 'o', 'organized',
    '#Links', 'studio', 'performers', 'tags', 'groups', 'galleries', 'markers',
    '#Tools', 'cover', 'scrape', 'delete'],
  image: ['#Details', 'title', 'code', 'date', 'photographer', 'details', 'urls',
    '#Rating', 'rating', 'o', 'organized',
    '#Links', 'studio', 'performers', 'tags', 'galleries',
    '#Tools', 'scrape', 'delete'],
  gallery: ['#Details', 'title', 'code', 'date', 'photographer', 'details', 'urls',
    '#Rating', 'rating', 'organized',
    '#Links', 'studio', 'performers', 'tags', 'scenes',
    '#Tools', 'scrape', 'delete'],
  group: ['#Details', 'name', 'aliasText', 'date', 'duration', 'director', 'synopsis', 'urls', 'frontImage', 'backImage',
    '#Rating', 'rating',
    '#Links', 'studio', 'tags', 'containing', 'subgroups',
    '#Tools', 'scrape', 'delete'],
  performer: ['#Details', 'name', 'disambiguation', 'aliasList', 'gender', 'birthdate', 'deathDate', 'country', 'height',
    'details', 'urls', 'image',
    '#Rating', 'rating', 'favorite',
    '#Links', 'tags',
    '#Tools', 'scrape', 'delete'],
  studio: ['#Details', 'name', 'aliases', 'details', 'urls', 'image',
    '#Rating', 'rating', 'favorite',
    '#Links', 'parent', 'tags',
    '#Tools', 'delete'],
  tag: ['#Details', 'name', 'aliases', 'description', 'image',
    '#Rating', 'favorite',
    '#Links', 'parents', 'children',
    '#Tools', 'delete'],
};

/** Gender values (GenderEnum) and how they are shown. */
const GENDERS = [
  ['FEMALE', 'Female'], ['MALE', 'Male'], ['TRANSGENDER_FEMALE', 'Transgender female'],
  ['TRANSGENDER_MALE', 'Transgender male'], ['INTERSEX', 'Intersex'], ['NON_BINARY', 'Non-binary'],
];

/** Stash dates: "2024", "2024-03" or "2024-03-11". */
const DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

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
    // Details
    title: textAction('Title', 'title'),
    name: textAction('Name', 'name', { required: true }),
    code: textAction('Studio code', 'code'),
    director: textAction('Director', 'director'),
    photographer: textAction('Photographer', 'photographer'),
    disambiguation: textAction('Disambiguation', 'disambiguation'),
    country: textAction('Country', 'country', { placeholder: 'Two-letter code, e.g. PT' }),
    details: textAction('Details', 'details', { multiline: true }),
    synopsis: textAction('Synopsis', 'synopsis', { multiline: true }),
    description: textAction('Description', 'description', { multiline: true }),
    date: dateAction('Date', 'date'),
    birthdate: dateAction('Birth date', 'birthdate'),
    deathDate: dateAction('Death date', 'death_date'),
    height: textAction('Height (cm)', 'height_cm', {
      parse: (v) => (v ? parseInt(v, 10) : null),
      check: (v) => !v || /^\d{2,3}$/.test(v) || 'Use whole centimetres, e.g. 168.',
    }),
    duration: textAction('Length', 'duration', {
      show: (v) => (v ? formatDuration(v) : ''),
      parse: (v) => (v ? Math.round(parseDuration(v)) : null),
      check: (v) => !v || parseDuration(v) !== null || 'Use hours:minutes:seconds, e.g. 1:32:00.',
      placeholder: 'e.g. 1:32:00',
    }),
    // Aliases are a list for performers, studios and tags, and one line of
    // text for groups.
    aliasList: listTextAction('Aliases', 'alias_list'),
    aliases: listTextAction('Aliases', 'aliases'),
    aliasText: textAction('Aliases', 'aliases'),
    gender: {
      label: 'Gender',
      value: () => {
        const g = GENDERS.find((x) => x[0] === item.gender);
        return g ? g[1] : 'None';
      },
      run: async () => {
        const v = await chooseOption({
          title: 'Gender',
          options: [{ label: 'None', value: '' }].concat(GENDERS.map((g) => ({ label: g[1], value: g[0] }))),
          selected: item.gender || '',
        });
        if (v === undefined || v === (item.gender || '')) return;
        await save({ gender: v || null }, 'Gender saved');
      },
    },
    urls: {
      label: 'Links (URLs)',
      value: () => String((item.urls || []).length),
      run: async () => {
        const current = item.urls || [];
        const choice = await chooseOption({
          title: 'Links',
          options: [{ label: 'Add a link…', value: '__add' }].concat(current.map((u, i) => ({ label: u, hint: 'Remove', value: i }))),
        });
        if (choice === undefined) return;
        let next;
        if (choice === '__add') {
          const u = await promptText({
            title: 'Add a link', placeholder: 'https://…', type: 'url', confirm: 'Add',
          });
          if (!u || !u.trim()) return;
          next = current.concat([u.trim()]);
        } else {
          next = current.filter((_, i) => i !== choice);
        }
        await save({ urls: next }, choice === '__add' ? 'Link added' : 'Link removed');
      },
    },
    image: imageAction('Image', 'image', 'image_path'),
    frontImage: imageAction('Front cover', 'front_image', 'front_image_path'),
    backImage: imageAction('Back cover', 'back_image', 'back_image_path'),
    cover: {
      label: 'Cover image',
      value: () => '',
      run: async () => {
        const choice = await chooseOption({
          title: 'Cover image',
          options: [
            { label: 'Use a frame from the video…', value: 'frame' },
            { label: 'Use an image from a URL…', value: 'url' },
          ],
        });
        if (!choice) return;
        if (choice === 'url') {
          const u = await promptText({ title: 'Cover image URL', placeholder: 'https://…', type: 'url' });
          if (!u || !u.trim()) return;
          await save({ cover_image: u.trim() }, 'Cover saved');
          return;
        }
        const file = item.files && item.files[0];
        const sec = await askTime('Frame for the cover', 0, file ? file.duration : 0);
        if (sec === undefined) return;
        try {
          await api.sceneScreenshot(item.id, sec);
        } catch (err) {
          toast(`Couldn't make the cover: ${err.message}`, 'error');
          return;
        }
        changed = true;
        toast(`Cover set from ${formatDuration(sec)}`);
      },
    },
    scrape: {
      label: 'Scrape metadata…',
      value: () => '',
      run: () => scrapeItem(kind, item, async (applied) => {
        if (!applied) return;
        changed = true;
        // Reload so the panel shows the scraped values.
        try {
          Object.assign(item, await api.getItem(kind, item.id));
        } catch (e) { /* the page reloads when the panel closes anyway */ }
        render();
        if (onSaved) onSaved(item);
      }),
    },
    delete: {
      label: `Delete this ${kind}…`,
      danger: true,
      value: () => '',
      run: async () => {
        const name = nameOf(kind, item);
        let deleteFile = false;
        if (kind === 'scene' || kind === 'image' || kind === 'gallery') {
          const what = kind === 'gallery' ? 'the gallery’s files (zip or images)' : 'the file';
          const choice = await chooseOption({
            title: `Delete “${name}”?`,
            options: [
              { label: 'Remove from Stash, keep the file', value: 'keep' },
              { label: `Also delete ${what} from disk`, value: 'file' },
            ],
          });
          if (!choice) return;
          deleteFile = choice === 'file';
        }
        const ok = await confirmDialog({
          title: `Delete “${name}”?`,
          message: deleteFile
            ? 'It is removed from Stash and its file is deleted from disk. This can’t be undone.'
            : 'It is removed from Stash. This can’t be undone.',
          confirm: 'Delete',
          safe: true,
        });
        if (!ok) return;
        try {
          await api.deleteItem(kind, item.id, { deleteFile });
        } catch (err) {
          toast(`Couldn't delete: ${err.message}`, 'error');
          return;
        }
        close();
        toast(`Deleted “${name}”`);
        goBack();
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
   * Action for a line of text (or, with `multiline`, a longer text).
   * @param {string} label
   * @param {string} field  item field, also the update input field
   * @param {Object} [opts]
   * @param {boolean} [opts.multiline]  text box for long text
   * @param {boolean} [opts.required]   can't be emptied (names)
   * @param {string} [opts.placeholder]
   * @param {(v: *) => string} [opts.show]    stored value → text
   * @param {(t: string) => *} [opts.parse]   text → stored value
   * @param {(t: string) => true|string} [opts.check]  true, or an error message
   */
  function textAction(label, field, opts) {
    const o = opts || {};
    const show = o.show || ((v) => (v === null || v === undefined ? '' : String(v)));
    return {
      label,
      value: () => {
        const t = show(item[field]);
        return t ? (t.length > 40 ? `${t.slice(0, 40)}…` : t) : '—';
      },
      run: async () => {
        const before = show(item[field]);
        const t = await promptText({
          title: label, value: before, multiline: o.multiline, placeholder: o.placeholder || '',
        });
        if (t === undefined || t.trim() === before.trim()) return;
        const text = o.multiline ? t.replace(/\s+$/, '') : t.trim();
        if (o.required && !text) {
          toast(`${label} can't be empty.`, 'error');
          return;
        }
        const ok = o.check ? o.check(text) : true;
        if (ok !== true) {
          toast(ok, 'error');
          return;
        }
        await save({ [field]: o.parse ? o.parse(text) : text }, `${label} saved`);
      },
    };
  }

  /** A date field ("2024", "2024-03" or "2024-03-11"; empty clears it). */
  function dateAction(label, field) {
    return textAction(label, field, {
      placeholder: 'YYYY-MM-DD',
      show: (v) => v || '',
      parse: (t) => t || null,
      check: (t) => !t || DATE_RE.test(t) || 'Use year-month-day, e.g. 2024-03-11.',
    });
  }

  /** A list of names (aliases) edited as one comma-separated line. */
  function listTextAction(label, field) {
    return textAction(label, field, {
      placeholder: 'Separate with commas',
      show: (v) => (v || []).join(', '),
      parse: (t) => t.split(',').map((x) => x.trim()).filter(Boolean),
    });
  }

  /**
   * Sets an image (performer/studio/tag image, group covers) from a URL;
   * Stash downloads it.
   * @param {string} label
   * @param {string} inputField  e.g. 'image', 'front_image'
   * @param {string} pathField   item field with the current image's path
   */
  function imageAction(label, inputField, pathField) {
    return {
      label,
      value: () => (item[pathField] && !/default=true/.test(item[pathField]) ? 'Set' : 'None'),
      run: async () => {
        const u = await promptText({
          title: `${label} from a URL`, placeholder: 'https://… (Stash downloads it)', type: 'url', confirm: 'Use image',
        });
        if (!u || !u.trim()) return;
        if (await save({ [inputField]: u.trim() }, `${label} saved`)) {
          delete item[inputField];
          // The page reloads its image after the panel closes (new t= value).
          item[pathField] = `${(item[pathField] || '').split('?')[0]}?t=${Date.now()}`;
          render();
        }
      },
    };
  }

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
      if (key.charAt(0) === '#') {
        lines.appendChild(h('div', { class: 'menu-heading' }, key.slice(1)));
        continue;
      }
      const a = actions[key];
      const el = h('div', {
        class: 'menu-item focusable' + (a.danger ? ' danger' : ''),
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
  focus(lines.querySelector('.focusable'));
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
