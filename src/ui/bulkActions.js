/**
 * Actions on several items at once, from a browse screen's selection mode:
 * add or remove a tag, set the rating, mark as organized or favourite, and
 * delete (scenes, images and galleries optionally with their files).
 */
import { chooseOption, confirmDialog, toast } from './overlay.js';
import { pickTag } from './panel.js';
import * as api from '../api/stash.js';

/** What each kind supports (matching Stash's Bulk*UpdateInput types). */
const ACTIONS = {
  scene: ['tagAdd', 'tagRemove', 'rating', 'organized', 'delete'],
  image: ['tagAdd', 'tagRemove', 'rating', 'organized', 'delete'],
  gallery: ['tagAdd', 'tagRemove', 'rating', 'organized', 'delete'],
  group: ['tagAdd', 'tagRemove', 'rating', 'delete'],
  performer: ['tagAdd', 'tagRemove', 'rating', 'favorite', 'delete'],
  studio: ['tagAdd', 'tagRemove', 'rating', 'favorite', 'delete'],
  tag: ['favorite', 'delete'],
  marker: ['tagAdd', 'tagRemove', 'delete'],
};

const LABELS = {
  tagAdd: 'Add a tag…',
  tagRemove: 'Remove a tag…',
  rating: 'Set the rating…',
  organized: 'Organized…',
  favorite: 'Favourite…',
  delete: 'Delete…',
};

/** Rating choices (rating100 = stars × 20). */
const RATINGS = [{ label: 'No rating', value: 0 }].concat(
  [1, 2, 3, 4, 5].map((n) => ({ label: `${n} ★`, value: n * 20 })),
);

/** "3 scenes" / "1 gallery". */
function countText(kind, n) {
  const plural = { gallery: 'galleries' }[kind] || `${kind}s`;
  return `${n} ${n === 1 ? kind : plural}`;
}

/**
 * Shows the actions for the selected items and runs the chosen one.
 * @param {string} kind
 * @param {Array<Object>} items  the selected items
 * @returns {Promise<'changed'|'deleted'|null>} what happened
 */
export async function runBulkAction(kind, items) {
  const ids = items.map((x) => x.id);
  const what = countText(kind, ids.length);
  const action = await chooseOption({
    title: what,
    options: (ACTIONS[kind] || []).map((a) => ({ label: LABELS[a], value: a })),
  });
  if (!action) return null;

  /** Runs a bulk update and reports it. */
  const update = async (patch, message) => {
    try {
      await api.bulkUpdate(kind, ids, patch);
      toast(message);
      return 'changed';
    } catch (err) {
      toast(`Couldn't change them: ${err.message}`, 'error');
      return null;
    }
  };

  switch (action) {
    case 'tagAdd':
    case 'tagRemove': {
      const add = action === 'tagAdd';
      const tag = await pickTag(add ? `Add a tag to ${what}` : `Remove a tag from ${what}`, [], { create: add });
      if (!tag) return null;
      return update({ tag_ids: { ids: [tag.id], mode: add ? 'ADD' : 'REMOVE' } },
        add ? `Added ${tag.name} to ${what}` : `Removed ${tag.name} from ${what}`);
    }
    case 'rating': {
      const v = await chooseOption({ title: `Rating for ${what}`, options: RATINGS });
      if (v === undefined) return null;
      // 0 clears the rating (Stash treats it as "no rating").
      return update({ rating100: v || null }, v ? `Rated ${what} ${v / 20} ★` : `Cleared the rating of ${what}`);
    }
    case 'organized':
    case 'favorite': {
      const v = await chooseOption({
        title: `${action === 'organized' ? 'Organized' : 'Favourite'}: ${what}`,
        options: [{ label: 'Yes', value: true }, { label: 'No', value: false }],
      });
      if (v === undefined) return null;
      return update({ [action]: v }, `Updated ${what}`);
    }
    case 'delete': {
      let deleteFile = false;
      if (kind === 'scene' || kind === 'image' || kind === 'gallery') {
        const choice = await chooseOption({
          title: `Delete ${what}?`,
          options: [
            { label: 'Remove from Stash, keep the files', value: 'keep' },
            { label: 'Also delete the files from disk', value: 'file' },
          ],
        });
        if (!choice) return null;
        deleteFile = choice === 'file';
      }
      const ok = await confirmDialog({
        title: `Delete ${what}?`,
        message: deleteFile
          ? 'They are removed from Stash and their files are deleted from disk. This can’t be undone.'
          : 'They are removed from Stash. This can’t be undone.',
        confirm: `Delete ${what}`,
        safe: true,
      });
      if (!ok) return null;
      try {
        await api.deleteItems(kind, ids, { deleteFile });
      } catch (err) {
        toast(`Couldn't delete: ${err.message}`, 'error');
        return null;
      }
      toast(`Deleted ${what}`);
      return 'deleted';
    }
    default:
      return null;
  }
}
