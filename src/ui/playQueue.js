/**
 * Play all / Shuffle for scene lists.
 *
 * A scene list (the Scenes section, a group, the Scenes tab of a performer,
 * studio or tag) hands over a function that queries its scenes the same way
 * its grid does: same filter, search text and sort. Play all asks for the
 * list in that order; Shuffle asks Stash for the same scenes in a new random
 * order, so a shuffle of a big library draws from all of it, not just from
 * the first page. Either way the player gets the scenes as a queue and plays
 * them one after the other, with Previous and Next in its controls (see
 * screens/player.js).
 */
import { h, icon } from '../util/dom.js';
import { toast } from './overlay.js';
import { openItem } from './navigate.js';
import * as api from '../api/stash.js';

/**
 * Most scenes one queue holds. Each is a full card (files, paths, studio…),
 * so this keeps the request and the TV's memory use reasonable.
 */
export const MAX_QUEUE = 200;

/**
 * Queries a list's scenes.
 * @callback SceneQuery
 * @param {number} perPage  how many scenes to return (from the first)
 * @param {{sort: string, direction: string}} [sortOverride]  replaces the
 *   list's own sort (Shuffle uses it for a random order)
 * @returns {Promise<{count: number, items: Array<Object>}>}
 */

/**
 * Fetches a list's scenes and starts playing them as a queue.
 * @param {SceneQuery} query
 * @param {boolean} [shuffle]  random order instead of the list's sort
 */
export async function playScenes(query, shuffle) {
  try {
    // A new seed each time, so every Shuffle press gives a new order.
    const sortOverride = shuffle
      ? { sort: api.sortKey('random', Math.floor(Math.random() * 1e8)), direction: 'ASC' }
      : undefined;
    const res = await query(MAX_QUEUE, sortOverride);
    if (!res.items.length) {
      toast('There are no scenes to play.');
      return;
    }
    if (res.count > res.items.length) {
      toast(`${shuffle ? 'Shuffling' : 'Playing'} ${res.items.length} of ${res.count} scenes`);
    }
    openItem('player', res.items[0], { start: 0, queue: res.items, queueIndex: 0 });
  } catch (err) {
    toast(`Couldn't start playback: ${err.message}`, 'error');
  }
}

/**
 * The Play all and Shuffle toolbar buttons for a scene list.
 * @param {SceneQuery} query
 * @param {string} [className]  button style (default: ghost toolbar button)
 * @returns {[HTMLElement, HTMLElement]}
 */
export function playButtons(query, className) {
  const cls = `button ${className || 'ghost'} focusable`;
  return [
    h('div', { class: cls, onSelect: () => playScenes(query, false) }, [icon('play'), h('span', null, 'Play all')]),
    h('div', { class: 'button ghost focusable', onSelect: () => playScenes(query, true) }, [icon('shuffle'), h('span', null, 'Shuffle')]),
  ];
}
