/**
 * Creating, changing and deleting scene markers from the TV.
 *
 * A Stash marker needs a time and a primary tag; the title is optional (Stash
 * shows the tag's name when it is empty) and it can carry more tags.
 *
 * Used from the player (add a marker at the current time, edit one, move it
 * to the current time) and from the scene editor (add a marker at a typed
 * time, edit one).
 */
import { confirmDialog, promptText, toast } from './overlay.js';
import {
  editList, openLinesPanel, pickTag,
} from './panel.js';
import * as api from '../api/stash.js';
import { formatDuration, parseDuration } from '../util/format.js';

/** What a marker is called in menus: its title, else its tag. */
export function markerName(m) {
  return m.title || (m.primary_tag && m.primary_tag.name) || 'Marker';
}

/**
 * Asks for a time in the scene ("12:05").
 * @param {string} title
 * @param {number} [initial] seconds shown to start with
 * @param {number} [max] the scene's length; later times are refused
 * @returns {Promise<number|undefined>}
 */
export async function askTime(title, initial, max) {
  let value = initial !== undefined ? formatDuration(initial) : '';
  for (;;) {
    const text = await promptText({ title, value, placeholder: 'Minutes:seconds, e.g. 12:05', confirm: 'OK' }); // eslint-disable-line no-await-in-loop
    if (text === undefined) return undefined;
    const sec = parseDuration(text);
    if (sec !== null && (!max || sec <= max)) return sec;
    toast(sec === null ? `“${text}” isn't a time. Use minutes:seconds.` : `The scene is only ${formatDuration(max)} long.`, 'error');
    value = text;
  }
}

/**
 * Creates a marker: asks for its tag, then an optional title.
 * @param {string} sceneId
 * @param {number} seconds
 * @returns {Promise<Object|null>} the new marker, or null when cancelled/failed
 */
export async function addMarker(sceneId, seconds) {
  const tag = await pickTag(`Tag for the marker at ${formatDuration(seconds)}`);
  if (!tag) return null;
  const title = await promptText({
    title: 'Marker title', placeholder: `Optional (shows “${tag.name}” when empty)`, confirm: 'Add marker',
  });
  if (title === undefined) return null;
  try {
    const m = await api.createMarker({
      scene_id: sceneId, seconds, primary_tag_id: tag.id, title: title.trim(),
    });
    toast(`Added “${markerName(m)}” at ${formatDuration(seconds)}`);
    return m;
  } catch (err) {
    toast(`Couldn't add the marker: ${err.message}`, 'error');
    return null;
  }
}

/**
 * Opens the edit panel for a marker. Every change is saved straight away.
 * @param {Object} marker  updated in place
 * @param {Object} [opts]
 * @param {() => number} [opts.now]  current playback time: adds a "Move to
 *   the current time" line (player)
 * @param {number} [opts.duration]   scene length, to check typed times
 * @returns {Promise<{changed: boolean, deleted: boolean}>} when the panel closes
 */
export function editMarker(marker, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let changed = false;
    let panel = null;
    const finish = (deleted) => resolve({ changed: changed || deleted, deleted });

    /** Saves a patch and copies the server's answer into `marker`. */
    const save = async (patch, message) => {
      try {
        const updated = await api.updateMarker(marker.id, patch);
        Object.assign(marker, updated);
      } catch (err) {
        toast(`Couldn't save: ${err.message}`, 'error');
        return;
      }
      changed = true;
      toast(message);
      panel.setSubtitle(subtitle());
      panel.render();
    };

    const subtitle = () => `${markerName(marker)} · ${formatDuration(marker.seconds)}`;

    const lines = () => {
      const out = [
        {
          key: 'title',
          label: 'Title',
          value: marker.title || '—',
          run: async () => {
            const v = await promptText({ title: 'Marker title', value: marker.title || '', placeholder: 'Empty shows the tag name' });
            if (v === undefined || v.trim() === (marker.title || '')) return;
            await save({ title: v.trim() }, 'Title saved');
          },
        },
        {
          key: 'tag',
          label: 'Tag',
          value: marker.primary_tag ? marker.primary_tag.name : '—',
          run: async () => {
            const tag = await pickTag('Marker tag');
            if (!tag) return;
            await save({ primary_tag_id: tag.id }, `Tag: ${tag.name}`);
          },
        },
        {
          key: 'tags',
          label: 'More tags',
          value: String((marker.tags || []).length),
          run: async () => {
            const res = await editList({
              title: 'More tags', noun: 'tag', current: marker.tags || [], pick: pickTag,
            });
            if (!res || !res.list) return;
            await save({ tag_ids: res.list.map((t) => t.id) }, res.message);
          },
        },
        {
          key: 'time',
          label: 'Time',
          value: formatDuration(marker.seconds),
          run: async () => {
            const sec = await askTime('Marker time', marker.seconds, o.duration);
            if (sec === undefined || sec === marker.seconds) return;
            await save({ seconds: sec }, `Moved to ${formatDuration(sec)}`);
          },
        },
      ];
      if (o.now) {
        const now = Math.floor(o.now());
        out.push({
          key: 'now',
          label: 'Move to the current time',
          value: formatDuration(now),
          run: () => save({ seconds: Math.floor(o.now()) }, `Moved to ${formatDuration(o.now())}`),
        });
      }
      out.push({
        key: 'delete',
        label: 'Delete marker…',
        danger: true,
        run: async () => {
          const ok = await confirmDialog({
            title: `Delete “${markerName(marker)}”?`,
            message: 'The marker is removed from Stash.',
            confirm: 'Delete',
            safe: true,
          });
          if (!ok) return;
          try {
            await api.deleteMarker(marker.id);
          } catch (err) {
            toast(`Couldn't delete: ${err.message}`, 'error');
            return;
          }
          toast(`Deleted “${markerName(marker)}”`);
          panel.close();
          finish(true);
        },
      });
      return out;
    };

    panel = openLinesPanel({
      title: 'Edit marker',
      subtitle: subtitle(),
      lines,
      onDismiss: () => finish(false),
    });
  });
}
