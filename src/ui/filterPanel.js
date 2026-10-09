/**
 * Filter panel for the browse screens: rating, tags, performers and studios
 * (each with exclusions), organized, resolution, length, date, O-count and
 * gender, depending on the section.
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
import { formatDate } from '../util/format.js';
import {
  editList, openLinesPanel, pickPerformer, pickStudio, pickTag,
} from './panel.js';

/** Criteria offered per browse section, in display order. */
export const SECTION_CRITERIA = {
  scenes: ['rating100', 'tags', 'performers', 'studios', 'organized', 'resolution', 'duration', 'date', 'o_counter'],
  groups: ['rating100', 'tags', 'performers', 'studios', 'date'],
  markers: ['tags', 'scene_tags', 'performers'],
  galleries: ['rating100', 'tags', 'performers', 'studios', 'organized', 'date'],
  images: ['rating100', 'tags', 'performers', 'studios', 'organized', 'resolution', 'o_counter'],
  performers: ['rating100', 'gender', 'tags', 'studios'],
  studios: ['rating100', 'tags'],
};

/** Gender choices, as the web UI names them. */
const GENDERS = ['Female', 'Male', 'Transgender Female', 'Transgender Male', 'Intersex', 'Non-Binary'];

/** "YYYY-MM-DD" for a Date. */
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Date presets, relative to today. They are stored as fixed dates (that's
 * what Stash saves), so a saved "Last year" filter keeps its start date.
 */
function datePresets() {
  const now = new Date();
  const back = (days) => isoDate(new Date(now.getTime() - days * 86400000));
  return [
    { label: 'Last 30 days', c: { modifier: 'GREATER_THAN', value: { value: back(30) } } },
    { label: 'Last year', c: { modifier: 'GREATER_THAN', value: { value: back(365) } } },
    { label: 'Last 5 years', c: { modifier: 'GREATER_THAN', value: { value: back(5 * 365) } } },
    { label: 'Older than 5 years', c: { modifier: 'LESS_THAN', value: { value: back(5 * 365) } } },
  ];
}

/** "After 1 Mar 2025" for a date criterion that isn't one of today's presets. */
function describeDate(c) {
  const v = c.value && typeof c.value === 'object' ? c.value : { value: c.value, value2: c.value2 };
  if (c.modifier === 'GREATER_THAN') return `After ${formatDate(v.value)}`;
  if (c.modifier === 'LESS_THAN') return `Before ${formatDate(v.value)}`;
  if (c.modifier === 'BETWEEN') return `${formatDate(v.value)} to ${formatDate(v.value2)}`;
  return '';
}

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

/** Excluded items of a list criterion → [{id, name}]. */
function excludedOf(c) {
  const v = c && c.value;
  const ex = v && !Array.isArray(v) ? v.excluded : c && c.excludes;
  return (ex || []).map((x) => (typeof x === 'object'
    ? { id: String(x.id), name: x.label || x.name || String(x.id) }
    : { id: String(x), name: String(x) }));
}

/**
 * Builds a list criterion, or null when it has no items at all.
 * @param {Array<{id, name}>} list      items to match
 * @param {Array<{id, name}>} excluded  items the results must not have
 * @param {string} modifier  INCLUDES (any) or INCLUDES_ALL
 * @param {number|null} depth  for tags/studios: 0 = exact, -1 = with sub-tags; null = none
 */
function listCriterion(list, excluded, modifier, depth) {
  if (!list.length && !excluded.length) return null;
  const value = {
    items: list.map((x) => ({ id: x.id, label: x.name })),
    excluded: excluded.map((x) => ({ id: x.id, label: x.name })),
  };
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

  /**
   * A line for a tag/performer/studio list criterion: items to match (all or
   * any of them), items to exclude, and for tags/studios whether sub-tags or
   * sub-studios count.
   */
  const listLine = (key, label, noun, pick, hierarchical, defaultModifier) => {
    const c = criteria[key];
    const list = itemsOf(c);
    const excluded = excludedOf(c);
    const modifier = (c && c.modifier) || defaultModifier;
    const depth = c && c.value && c.value.depth !== undefined ? c.value.depth : 0;
    const subs = noun === 'tag' ? 'sub-tags' : 'sub-studios';
    let value = list.length ? names(list) : '';
    if (list.length > 1) value += modifier === 'INCLUDES_ALL' ? ' (all)' : ' (any)';
    if (excluded.length) value += `${value ? ' · ' : ''}not ${names(excluded)}`;
    /** Applies new lists (keeping the match mode and depth unless given). */
    const apply = (l, ex, mod, dep) => set(key, listCriterion(l, ex, mod || modifier, hierarchical ? (dep === undefined ? depth : dep) : null));
    return {
      key,
      label,
      value: value || 'Any',
      run: async () => {
        const extra = [{ label: `Exclude a ${noun}…`, value: 'exclude' }];
        if (list.length > 1) {
          extra.push({
            label: modifier === 'INCLUDES_ALL' ? 'Match: all of them' : 'Match: any of them',
            hint: 'Change',
            value: 'match',
          });
        }
        if (hierarchical) {
          extra.push({ label: `Include ${subs}: ${depth === -1 ? 'yes' : 'no'}`, hint: 'Change', value: 'depth' });
        }
        for (const x of excluded) extra.push({ label: `Not ${x.name}`, hint: 'Remove', value: `ex:${x.id}` });
        const res = await editList({
          title: label, noun, current: list, pick: (t) => pick(t, list.concat(excluded)), extra,
        });
        if (!res) return;
        if (res.list) {
          apply(res.list, excluded);
        } else if (res.action === 'exclude') {
          const picked = await pick(`Exclude a ${noun}`, list.concat(excluded));
          if (picked) apply(list, excluded.concat([picked]));
        } else if (res.action === 'match') {
          apply(list, excluded, modifier === 'INCLUDES_ALL' ? 'INCLUDES' : 'INCLUDES_ALL');
        } else if (res.action === 'depth') {
          if (list.length || excluded.length) apply(list, excluded, modifier, depth === -1 ? 0 : -1);
        } else if (res.action.indexOf('ex:') === 0) {
          const id = res.action.slice(3);
          apply(list, excluded.filter((x) => x.id !== id));
        }
      },
    };
  };

  /**
   * A line that picks one of a few preset criteria (e.g. Length: under 5
   * minutes). A criterion that matches no preset (made in the web UI) is
   * described by `describe` and can still be replaced or cleared.
   * @param {string} key
   * @param {string} label
   * @param {Array<{label: string, c: Object}>} presets
   * @param {(c: Object) => string} [describe]
   */
  const presetLine = (key, label, presets, describe) => {
    const c = criteria[key];
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const index = c ? presets.findIndex((p) => same(p.c, c)) : -1;
    const value = !c ? 'Any' : index >= 0 ? presets[index].label : (describe && describe(c)) || 'Set in Stash';
    return {
      key,
      label,
      value,
      run: async () => {
        const choice = await chooseOption({
          title: label,
          options: [{ label: 'Any', value: -1 }].concat(presets.map((p, i) => ({ label: p.label, value: i }))),
          selected: c ? index : -1,
        });
        if (choice === undefined) return;
        set(key, choice < 0 ? null : presets[choice].c);
      },
    };
  };

  const builders = {
    duration: () => presetLine('duration', 'Length', [
      { label: 'Under 5 minutes', c: { modifier: 'LESS_THAN', value: { value: 300 } } },
      { label: '5 to 20 minutes', c: { modifier: 'BETWEEN', value: { value: 300, value2: 1200 } } },
      { label: '20 to 60 minutes', c: { modifier: 'BETWEEN', value: { value: 1200, value2: 3600 } } },
      { label: 'Over an hour', c: { modifier: 'GREATER_THAN', value: { value: 3600 } } },
    ]),
    date: () => presetLine('date', 'Date', datePresets(), describeDate),
    o_counter: () => presetLine('o_counter', 'O-count', [
      { label: 'At least one', c: { modifier: 'GREATER_THAN', value: { value: 0 } } },
      { label: 'None', c: { modifier: 'EQUALS', value: { value: 0 } } },
    ]),
    gender: () => presetLine('gender', 'Gender', GENDERS.map((g) => ({ label: g, c: { modifier: 'INCLUDES', value: [g] } })),
      (c) => (Array.isArray(c.value) ? c.value.join(', ') : '')),
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
