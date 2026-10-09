/**
 * Filter panel for the browse screens: rating, tags, performers, studios,
 * organized and resolution, depending on the section.
 *
 * Criteria are kept in the format Stash's web UI saves (see the top of
 * api/savedFilters.js), for two reasons:
 * - a saved filter's criteria can be shown and changed here as they are, and
 *   saved back without losing anything the TV can't edit;
 * - the same converter that runs saved filters turns them into the API's
 *   format, so there is one code path for both.
 *
 * Criteria this panel doesn't know (made in the web UI) are kept and counted
 * under "Other criteria", where they can be removed.
 */
import { chooseOption } from './overlay.js';
import {
  editList, openLinesPanel, pickPerformer, pickStudio, pickTag,
} from './panel.js';

/** Criteria offered per browse section, in display order. */
export const SECTION_CRITERIA = {
  scenes: ['rating100', 'tags', 'performers', 'studios', 'organized', 'resolution'],
  groups: ['rating100', 'tags', 'performers', 'studios'],
  markers: ['tags', 'scene_tags', 'performers'],
  galleries: ['rating100', 'tags', 'performers', 'studios', 'organized'],
  images: ['rating100', 'tags', 'performers', 'studios', 'organized', 'resolution'],
  performers: ['rating100', 'tags', 'studios'],
  studios: ['rating100', 'tags'],
};

/** Resolution choices, as the web UI names them. */
const RESOLUTIONS = ['480p', '720p', '1080p', '1440p', '4k'];

/**
 * Criteria toggles set from the browse toolbar; not "other" criteria.
 * (Kept in sync with the `uiFilter` of the toggles in screens/browse.js.)
 */
const TOGGLE_KEYS = ['play_count', 'resume_time', 'filter_favorites', 'favorite'];

// ---------------------------------------------------------------------------
// Reading and writing the web UI's criterion format
// ---------------------------------------------------------------------------

/** [{id, label}] items of a list criterion → [{id, name}]. */
function itemsOf(c) {
  const v = c && c.value;
  const items = v && !Array.isArray(v) ? v.items : v;
  return (items || []).map((x) => ({ id: String(x.id), name: x.label || x.name || String(x.id) }));
}

/**
 * Builds a list criterion.
 * @param {Array<{id, name}>} list
 * @param {string} modifier  INCLUDES (any) or INCLUDES_ALL
 * @param {number|null} depth  for tags/studios: 0 = exact, -1 = with sub-tags; null = none
 * @param {Object} [prev]    the previous criterion (its exclusions are kept)
 */
function listCriterion(list, modifier, depth, prev) {
  const pv = prev && prev.value && !Array.isArray(prev.value) ? prev.value : {};
  const value = { items: list.map((x) => ({ id: x.id, label: x.name })), excluded: pv.excluded || [] };
  if (depth !== null) value.depth = depth;
  return { modifier, value };
}

/** Stars (1–5) of a "rating at least" criterion, or null for anything else. */
function minStars(c) {
  if (!c || c.modifier !== 'GREATER_THAN') return null;
  const v = c.value && typeof c.value === 'object' ? c.value.value : c.value;
  return Math.round((Number(v) + 1) / 20 * 2) / 2;
}

/** Short text for a list: "A, B and 2 more". */
function names(list) {
  if (!list.length) return 'Any';
  if (list.length <= 2) return list.map((x) => x.name).join(', ');
  return `${list[0].name}, ${list[1].name} +${list.length - 2}`;
}

/**
 * Number of criteria in use (for the toolbar button), counting only real
 * criteria, not the toolbar toggles.
 */
export function criteriaCount(criteria) {
  return Object.keys(criteria || {}).filter((k) => TOGGLE_KEYS.indexOf(k) < 0).length;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/**
 * Opens the filter panel. Every change is applied straight away.
 * @param {Object} opts
 * @param {string} opts.section             browse section (see SECTION_CRITERIA)
 * @param {Object} opts.criteria            current criteria (UI format); not modified
 * @param {(criteria: Object) => void} opts.onChange  called with a new object after each change
 */
export function openFilterPanel(opts) {
  let criteria = Object.assign({}, opts.criteria || {});
  const keys = SECTION_CRITERIA[opts.section] || [];
  let panel = null;

  /** Sets (or with `c` = null removes) one criterion and applies it. */
  const set = (key, c) => {
    criteria = Object.assign({}, criteria);
    if (c) criteria[key] = c;
    else delete criteria[key];
    opts.onChange(criteria);
    panel.render();
  };

  /** A line for a tag/performer/studio list criterion. */
  const listLine = (key, label, noun, pick, hierarchical, defaultModifier) => {
    const c = criteria[key];
    const list = itemsOf(c);
    const modifier = (c && c.modifier) || defaultModifier;
    const depth = c && c.value && c.value.depth !== undefined ? c.value.depth : 0;
    let value = names(list);
    if (list.length > 1) value += modifier === 'INCLUDES_ALL' ? ' (all)' : ' (any)';
    return {
      key,
      label,
      value,
      run: async () => {
        const extra = [];
        if (list.length > 1) {
          extra.push({
            label: modifier === 'INCLUDES_ALL' ? 'Match: all of them' : 'Match: any of them',
            hint: 'Change',
            value: 'match',
          });
        }
        if (hierarchical) {
          extra.push({
            label: depth === -1 ? `Include sub-${noun === 'tag' ? 'tags' : 'studios'}: yes` : `Include sub-${noun === 'tag' ? 'tags' : 'studios'}: no`,
            hint: 'Change',
            value: 'depth',
          });
        }
        const res = await editList({
          title: label, noun, current: list, pick, extra,
        });
        if (!res) return;
        if (res.action === 'match') {
          set(key, listCriterion(list, modifier === 'INCLUDES_ALL' ? 'INCLUDES' : 'INCLUDES_ALL', hierarchical ? depth : null, c));
          return;
        }
        if (res.action === 'depth') {
          if (!list.length) return; // nothing to apply it to yet
          set(key, listCriterion(list, modifier, depth === -1 ? 0 : -1, c));
          return;
        }
        set(key, res.list.length ? listCriterion(res.list, modifier, hierarchical ? depth : null, c) : null);
      },
    };
  };

  const builders = {
    rating100: () => {
      const n = minStars(criteria.rating100);
      return {
        key: 'rating100',
        label: 'Rating',
        value: criteria.rating100 ? (n ? `${n} ★ or more` : 'Set in Stash') : 'Any',
        run: async () => {
          const v = await chooseOption({
            title: 'Rating at least',
            options: [{ label: 'Any rating', value: 0 }].concat([1, 2, 3, 4, 5].map((s) => ({ label: `${s} ★ or more`, value: s }))),
            selected: n || 0,
          });
          if (v === undefined) return;
          // "At least n stars" is "more than n×20 − 1" on Stash's 0–100 scale.
          set('rating100', v ? { modifier: 'GREATER_THAN', value: { value: v * 20 - 1 } } : null);
        },
      };
    },
    tags: () => listLine('tags', opts.section === 'markers' ? 'Marker tags' : 'Tags', 'tag', pickTag, true, 'INCLUDES_ALL'),
    scene_tags: () => listLine('scene_tags', 'Scene tags', 'tag', pickTag, true, 'INCLUDES_ALL'),
    performers: () => listLine('performers', 'Performers', 'performer', pickPerformer, false, 'INCLUDES_ALL'),
    studios: () => listLine('studios', 'Studios', 'studio', pickStudio, true, 'INCLUDES'),
    organized: () => {
      const c = criteria.organized;
      const v = c ? String(c.value) === (c.modifier === 'NOT_EQUALS' ? 'false' : 'true') : null;
      return {
        key: 'organized',
        label: 'Organized',
        value: c ? (v ? 'Yes' : 'No') : 'Any',
        run: async () => {
          const choice = await chooseOption({
            title: 'Organized',
            options: [{ label: 'Any', value: 'any' }, { label: 'Organized', value: 'true' }, { label: 'Not organized', value: 'false' }],
            selected: c ? String(v) : 'any',
          });
          if (choice === undefined) return;
          set('organized', choice === 'any' ? null : { modifier: 'EQUALS', value: choice });
        },
      };
    },
    resolution: () => {
      const c = criteria.resolution;
      const cur = c ? String(c.value) : '';
      return {
        key: 'resolution',
        label: 'Resolution',
        value: c ? (c.modifier === 'EQUALS' ? cur.toUpperCase().replace('P', 'p') : 'Set in Stash') : 'Any',
        run: async () => {
          const choice = await chooseOption({
            title: 'Resolution',
            options: [{ label: 'Any', value: '' }].concat(RESOLUTIONS.map((r) => ({ label: r === '4k' ? '4K' : r, value: r }))),
            selected: c && c.modifier === 'EQUALS' ? cur : '',
          });
          if (choice === undefined) return;
          set('resolution', choice ? { modifier: 'EQUALS', value: choice } : null);
        },
      };
    },
  };

  const lines = () => {
    const out = keys.map((k) => builders[k]());
    const others = Object.keys(criteria).filter((k) => keys.indexOf(k) < 0 && TOGGLE_KEYS.indexOf(k) < 0);
    if (others.length) {
      out.push({
        key: 'others',
        label: 'Other criteria (from Stash)',
        value: String(others.length),
        run: async () => {
          const choice = await chooseOption({
            title: 'Other criteria',
            options: others.map((k) => ({ label: k.replace(/_/g, ' '), hint: 'Remove', value: k }))
              .concat(others.length > 1 ? [{ label: 'Remove all of them', value: '__all' }] : []),
          });
          if (choice === undefined) return;
          if (choice === '__all') {
            criteria = Object.assign({}, criteria);
            for (const k of others) delete criteria[k];
            opts.onChange(criteria);
            panel.render();
          } else {
            set(choice, null);
          }
        },
      });
    }
    if (criteriaCount(criteria)) {
      out.push({
        key: 'clear',
        label: 'Clear all criteria',
        danger: true,
        run: () => {
          // Toolbar toggles are kept; they have their own buttons.
          const kept = {};
          for (const k of TOGGLE_KEYS) if (criteria[k]) kept[k] = criteria[k];
          criteria = kept;
          opts.onChange(criteria);
          panel.render();
        },
      });
    }
    return out;
  };

  panel = openLinesPanel({ title: 'Filter', lines });
  return panel;
}
