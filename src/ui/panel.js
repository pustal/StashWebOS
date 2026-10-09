/**
 * Building blocks shared by the side panels that edit things line by line
 * (marker editor, filter panel):
 *
 * - {@link openLinesPanel}: a side panel of "label … value" lines that is
 *   redrawn after each change, keeping the highlight on the same line.
 * - {@link pickNamed} (and pickTag, pickPerformer, pickStudio): search-as-
 *   you-type pickers for one item, optionally offering to create it.
 * - {@link editList}: the add/remove menu for a list of tags, performers…
 */
import { h } from '../util/dom.js';
import {
  chooseOption, openModal, pickBySearch, toast,
} from './overlay.js';
import { focus, getFocused } from '../nav/focus.js';
import * as api from '../api/stash.js';
import { countOf } from '../util/format.js';

/**
 * @typedef {Object} PanelLine
 * @property {string} key    stable id (keeps the highlight across redraws)
 * @property {string} label
 * @property {string} [value] shown on the right
 * @property {() => *} run    called when the line is chosen
 * @property {boolean} [danger] drawn in the warning colour (Delete…)
 */

/**
 * Opens a side panel of lines.
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} [opts.subtitle]
 * @param {() => PanelLine[]} opts.lines  called on every redraw
 * @param {() => void} [opts.onDismiss]   Back pressed (the panel is closed)
 * @returns {{close: () => void, render: () => void, setSubtitle: (t: string) => void}}
 */
export function openLinesPanel(opts) {
  const list = h('div', { class: 'menu-list scroll-y' });
  const subtitle = h('p', { class: 'editor-subject' }, opts.subtitle || '');
  const panel = h('div', { class: 'menu-panel editor-panel' }, [h('h2', { class: 'menu-title' }, opts.title), subtitle, list]);
  const close = openModal(panel, { side: true, onDismiss: opts.onDismiss });
  let focusedKey = null;
  let first = true;

  function render() {
    list.innerHTML = '';
    let toFocus = null;
    for (const line of opts.lines()) {
      const el = h('div', {
        class: 'menu-item focusable' + (line.danger ? ' danger' : ''),
        onSelect: () => {
          focusedKey = line.key;
          line.run();
        },
      }, [
        h('span', { class: 'menu-label' }, line.label),
        line.value ? h('span', { class: 'menu-hint' }, line.value) : null,
      ]);
      if (line.key === focusedKey) toFocus = el;
      list.appendChild(el);
    }
    // Back on the redrawn line, unless the highlight is somewhere else that
    // still exists (another dialog on top of this panel).
    // The first draw always takes the highlight.
    const f = getFocused();
    if (!toFocus && first) toFocus = list.firstChild;
    if (toFocus && (first || !f || !document.documentElement.contains(f) || list.contains(f))) focus(toFocus);
    first = false;
  }

  render();
  return {
    close,
    render,
    setSubtitle: (t) => {
      subtitle.textContent = t;
    },
  };
}

/** How each kind is searched, for {@link pickNamed}. */
const FINDERS = {
  tag: (o) => api.findTags(o),
  performer: (o) => api.findPerformers(o),
  studio: (o) => api.findStudios(o),
};

/**
 * Search-as-you-type picker for one tag, performer or studio.
 *
 * With `create`, a "Create …" line is offered when nothing found has exactly
 * the typed name; choosing it creates the item in Stash (name only).
 * @param {'tag'|'performer'|'studio'} kind
 * @param {string} title
 * @param {Array<{id: string}>} [exclude]  items not to offer (already chosen)
 * @param {{create?: boolean}} [opts]
 * @returns {Promise<{id: string, name: string}|undefined>}
 */
export async function pickNamed(kind, title, exclude, opts) {
  const create = !!(opts && opts.create);
  const picked = await pickBySearch({
    title,
    search: (text) => FINDERS[kind]({
      q: text, perPage: 20, sort: 'scenes_count', direction: 'DESC',
    }).then((r) => {
      const out = r.items.filter((x) => !(exclude || []).some((e) => e.id === x.id))
        .map((x) => ({ label: x.name, hint: countOf(x.scene_count, 'scene'), value: { id: x.id, name: x.name } }));
      const name = text.trim();
      const exact = r.items.some((x) => x.name.toLowerCase() === name.toLowerCase());
      if (create && name && !exact) out.push({ label: `Create ${kind} “${name}”`, hint: 'New', value: { create: name } });
      return out;
    }),
  });
  if (!picked || !picked.create) return picked;
  try {
    const made = await api.createNamed(kind, picked.create);
    toast(`Created ${kind} “${made.name}”`);
    return { id: made.id, name: made.name };
  } catch (err) {
    toast(`Couldn't create “${picked.create}”: ${err.message}`, 'error');
    return undefined;
  }
}

/** Picker for one tag (see {@link pickNamed}). */
export const pickTag = (title, exclude, opts) => pickNamed('tag', title, exclude, opts);
/** Picker for one performer (see {@link pickNamed}). */
export const pickPerformer = (title, exclude, opts) => pickNamed('performer', title, exclude, opts);
/** Picker for one studio (see {@link pickNamed}). */
export const pickStudio = (title, exclude, opts) => pickNamed('studio', title, exclude, opts);

/**
 * Add/remove menu for a list of {id, name} items.
 * @param {Object} opts
 * @param {string} opts.title       menu title, e.g. "Tags"
 * @param {string} opts.noun        "tag" → "Add a tag…"
 * @param {Array<{id: string, name: string}>} opts.current
 * @param {(title: string, exclude: Array, o: Object) => Promise<Object>} opts.pick  e.g. pickTag
 * @param {boolean} [opts.create]   offer to create a new item while adding
 * @param {Array<{label: string, value: string, hint?: string}>} [opts.extra]
 *   more options after "Add" (their value is returned as `{action: value}`)
 * @returns {Promise<{list: Array, message: string}|{action: string}|undefined>}
 *   the new list, an extra action, or undefined when nothing changed
 */
export async function editList(opts) {
  const current = opts.current || [];
  const choice = await chooseOption({
    title: opts.title,
    options: [{ label: `Add a ${opts.noun}…`, value: '__add' }]
      .concat(opts.extra || [])
      .concat(current.map((x) => ({ label: x.name, hint: 'Remove', value: `id:${x.id}` }))),
  });
  if (choice === undefined) return undefined;
  if (choice === '__add') {
    const picked = await opts.pick(`Add a ${opts.noun}`, current, { create: !!opts.create });
    if (!picked) return undefined;
    return { list: current.concat([picked]), message: `Added ${picked.name}` };
  }
  if (choice.indexOf('id:') !== 0) return { action: choice };
  const id = choice.slice(3);
  const removed = current.find((x) => x.id === id);
  return { list: current.filter((x) => x.id !== id), message: `Removed ${removed ? removed.name : opts.noun}` };
}
