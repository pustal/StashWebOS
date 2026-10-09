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
import { chooseOption, promptText, toast } from './overlay.js';
import { MODES, SECTION_MODES, filterFields } from '../api/savedFilters.js';
import { formatDate } from '../util/format.js';
import {
  editList, openLinesPanel, pickPerformer, pickStudio, pickTag,
} from './panel.js';

/** Criteria offered per browse section, in display order. */
export const SECTION_CRITERIA = {
  scenes: ['rating100', 'tags', 'performers', 'studios', 'organized', 'resolution', 'duration', 'date', 'o_counter',
    'performer_count', 'has_markers', 'path'],
  groups: ['rating100', 'tags', 'performers', 'studios', 'date', 'scene_count'],
  markers: ['tags', 'scene_tags', 'performers'],
  galleries: ['rating100', 'tags', 'performers', 'studios', 'organized', 'date', 'image_count', 'path'],
  images: ['rating100', 'tags', 'performers', 'studios', 'organized', 'resolution', 'o_counter', 'path'],
  performers: ['rating100', 'gender', 'age', 'country', 'tags', 'studios', 'scene_count'],
  studios: ['rating100', 'tags', 'scene_count'],
  tags: ['scene_count'],
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

// ---------------------------------------------------------------------------
// Any other criterion ("More criteria")
// ---------------------------------------------------------------------------

/** List criteria the panel can pick items for, by field name. */
const LIST_KINDS = {
  tags: 'tag',
  scene_tags: 'tag',
  performer_tags: 'tag',
  parents: 'tag',
  children: 'tag',
  performers: 'performer',
  studios: 'studio',
};

/** Comparisons offered per kind of criterion, as [modifier, label]. */
const MODIFIERS = {
  number: [['EQUALS', 'Is'], ['NOT_EQUALS', 'Is not'], ['GREATER_THAN', 'More than'], ['LESS_THAN', 'Less than'],
    ['BETWEEN', 'Between'], ['NOT_BETWEEN', 'Not between'], ['IS_NULL', 'Is empty'], ['NOT_NULL', 'Is not empty']],
  date: [['EQUALS', 'On'], ['GREATER_THAN', 'After'], ['LESS_THAN', 'Before'], ['BETWEEN', 'Between'],
    ['NOT_BETWEEN', 'Not between'], ['IS_NULL', 'Not set'], ['NOT_NULL', 'Set']],
  text: [['INCLUDES', 'Contains'], ['EXCLUDES', 'Doesn’t contain'], ['EQUALS', 'Is'], ['NOT_EQUALS', 'Is not'],
    ['MATCHES_REGEX', 'Matches the pattern'], ['NOT_MATCHES_REGEX', 'Doesn’t match the pattern'],
    ['IS_NULL', 'Is empty'], ['NOT_NULL', 'Is not empty']],
  resolution: [['EQUALS', 'Is'], ['NOT_EQUALS', 'Is not'], ['GREATER_THAN', 'Above'], ['LESS_THAN', 'Below']],
};

/**
 * How the panel edits a field, from its input type, or null when it can't
 * (nested filters, AND/OR/NOT, lists of items it can't pick, special inputs).
 */
function genericKind(key, type) {
  if (!type) return null;
  if (type.kind === 'SCALAR') {
    if (type.name === 'Boolean') return 'bool';
    if (type.name === 'String') return 'flag'; // e.g. has_markers: "true"/"false"
    return null;
  }
  switch (type.name) {
    case 'IntCriterionInput':
    case 'FloatCriterionInput':
      return 'number';
    case 'DateCriterionInput':
    case 'TimestampCriterionInput':
      return 'date';
    case 'StringCriterionInput':
      return 'text';
    case 'ResolutionCriterionInput':
      return 'resolution';
    case 'MultiCriterionInput':
    case 'HierarchicalMultiCriterionInput':
      return LIST_KINDS[key] ? 'list' : null;
    default:
      return null;
  }
}

/** "o_counter" → "O counter". */
function humanize(key) {
  const t = key.replace(/_/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Words for a modifier, from any kind's list. */
function modifierLabel(m) {
  for (const k of Object.keys(MODIFIERS)) {
    const hit = MODIFIERS[k].find((x) => x[0] === m);
    if (hit) return hit[1].toLowerCase();
  }
  return String(m || '').toLowerCase().replace(/_/g, ' ');
}

/** Short description of any criterion: "more than 3", "contains “foo”"… */
function describeGeneric(c) {
  if (!c || typeof c !== 'object') return String(c);
  if (c.modifier === 'IS_NULL' || c.modifier === 'NOT_NULL') return modifierLabel(c.modifier);
  const v = c.value;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (v.items || v.excluded) {
      const n = (v.items || []).map((x) => x.label || x.id);
      const ex = (v.excluded || []).map((x) => x.label || x.id);
      return [n.length ? n.slice(0, 2).join(', ') + (n.length > 2 ? ` +${n.length - 2}` : '') : '',
        ex.length ? `not ${ex.slice(0, 2).join(', ')}` : ''].filter(Boolean).join(' · ') || 'Set';
    }
    if ('value' in v) {
      const two = v.value2 !== undefined && v.value2 !== null && v.value2 !== '' ? ` and ${v.value2}` : '';
      return `${modifierLabel(c.modifier)} ${v.value}${two}`;
    }
    return 'Set in Stash';
  }
  if (Array.isArray(v)) return v.join(', ');
  if (v === 'true' || v === 'false') return v === 'true' ? 'Yes' : 'No';
  return `${modifierLabel(c.modifier)} “${v}”`;
}

/**
 * Opens the filter panel. Every change is applied straight away.
 * @param {Object} opts
 * @param {string} opts.section             browse section (see SECTION_CRITERIA)
 * @param {Object} opts.criteria            current criteria (UI format); not modified
 * @param {(criteria: Object) => void} opts.onChange  called with a new object after each change
 * @param {string} [opts.query]                 current text search
 * @param {(q: string) => void} [opts.onQuery]  called when the text search changes
 */
export function openFilterPanel(opts) {
  let criteria = Object.assign({}, opts.criteria || {});
  let query = opts.query || '';
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

  /** Counts as presets: [label, modifier, value, value2?]. */
  const countPresets = (rows) => rows.map(([label, modifier, value, value2]) => ({
    label, c: { modifier, value: value2 === undefined ? { value } : { value, value2 } },
  }));

  /** A "contains text" criterion (file path, country…). */
  const textLine = (key, label, placeholder) => {
    const c = criteria[key];
    const cur = c ? String(c.value || '') : '';
    return {
      key,
      label,
      value: c ? (c.modifier === 'INCLUDES' ? `contains “${cur}”` : cur || 'Set in Stash') : 'Any',
      run: async () => {
        const t = await promptText({ title: label, value: c && c.modifier === 'INCLUDES' ? cur : '', placeholder, confirm: 'Filter' });
        if (t === undefined) return;
        set(key, t.trim() ? { modifier: 'INCLUDES', value: t.trim() } : null);
      },
    };
  };

  /** The section's filter fields and their types (from the server). */
  const fieldTypes = () => filterFields(MODES[SECTION_MODES[opts.section]].type);

  /**
   * Edits any criterion whose type the panel understands (see genericKind):
   * a choice of comparison, then the value(s).
   */
  const editGeneric = async (key, type) => {
    const kind = genericKind(key, type);
    const label = humanize(key);
    if (kind === 'list') {
      const noun = LIST_KINDS[key];
      const pickers = { tag: pickTag, performer: pickPerformer, studio: pickStudio };
      await listLine(key, label, noun, pickers[noun], type.name === 'HierarchicalMultiCriterionInput', 'INCLUDES_ALL').run();
      return;
    }
    if (kind === 'bool' || kind === 'flag') {
      const v = await chooseOption({ title: label, options: [{ label: 'Yes', value: 'true' }, { label: 'No', value: 'false' }] });
      if (v) set(key, { modifier: 'EQUALS', value: v });
      return;
    }
    if (kind === 'resolution') {
      const mod = await chooseOption({ title: label, options: MODIFIERS.resolution.map(([m, l]) => ({ label: l, value: m })) });
      if (!mod) return;
      const v = await chooseOption({ title: label, options: RESOLUTIONS.map((r) => ({ label: r === '4k' ? '4K' : r, value: r })) });
      if (v) set(key, { modifier: mod, value: v });
      return;
    }
    const mod = await chooseOption({ title: label, options: MODIFIERS[kind].map(([m, l]) => ({ label: l, value: m })) });
    if (!mod) return;
    if (mod === 'IS_NULL' || mod === 'NOT_NULL') {
      set(key, kind === 'text' ? { modifier: mod, value: '' } : { modifier: mod, value: { value: kind === 'date' ? '' : 0 } });
      return;
    }
    const ask = async (title) => {
      const placeholder = kind === 'date' ? 'YYYY-MM-DD' : kind === 'number' ? 'A number' : '';
      for (;;) {
        const t = await promptText({ title, placeholder, confirm: 'OK' }); // eslint-disable-line no-await-in-loop
        if (t === undefined) return undefined;
        const v = t.trim();
        if (kind === 'number' && !/^-?\d+(\.\d+)?$/.test(v)) toast('Enter a number.', 'error');
        else if (kind === 'date' && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(v)) toast('Use year-month-day, e.g. 2024-03-11.', 'error');
        else return kind === 'number' ? Number(v) : v;
      }
    };
    if (kind === 'text') {
      const v = await ask(label);
      if (v !== undefined) set(key, { modifier: mod, value: v });
      return;
    }
    const between = mod === 'BETWEEN' || mod === 'NOT_BETWEEN';
    const v1 = await ask(between ? `${label}: from` : label);
    if (v1 === undefined) return;
    const v2 = between ? await ask(`${label}: to`) : undefined;
    if (between && v2 === undefined) return;
    set(key, { modifier: mod, value: between ? { value: v1, value2: v2 } : { value: v1 } });
  };

  const builders = {
    performer_count: () => presetLine('performer_count', 'Performers in scene', countPresets([
      ['None', 'EQUALS', 0], ['One', 'EQUALS', 1], ['Two', 'EQUALS', 2], ['Three or more', 'GREATER_THAN', 2],
    ])),
    has_markers: () => presetLine('has_markers', 'Has markers', [
      { label: 'Yes', c: { modifier: 'EQUALS', value: 'true' } },
      { label: 'No', c: { modifier: 'EQUALS', value: 'false' } },
    ]),
    path: () => textLine('path', 'File path', 'Part of the folder or file name'),
    country: () => textLine('country', 'Country', 'Two-letter code, e.g. PT'),
    age: () => presetLine('age', 'Age', countPresets([
      ['Under 25', 'LESS_THAN', 25], ['25 to 34', 'BETWEEN', 25, 34], ['35 to 44', 'BETWEEN', 35, 44], ['45 or older', 'GREATER_THAN', 44],
    ])),
    scene_count: () => presetLine('scene_count', 'Scenes', countPresets([
      ['None', 'EQUALS', 0], ['At least one', 'GREATER_THAN', 0], ['10 or more', 'GREATER_THAN', 9], ['50 or more', 'GREATER_THAN', 49],
    ])),
    image_count: () => presetLine('image_count', 'Images', countPresets([
      ['Under 20', 'LESS_THAN', 20], ['20 to 100', 'BETWEEN', 20, 100], ['Over 100', 'GREATER_THAN', 100],
    ])),
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
    const out = [];
    if (opts.onQuery) {
      out.push({
        key: 'q',
        label: 'Text search',
        value: query ? `“${query}”` : 'None',
        run: async () => {
          const t = await promptText({
            title: 'Text search', value: query, placeholder: 'Title, file name, details…', confirm: 'Search',
          });
          if (t === undefined || t.trim() === query) return;
          query = t.trim();
          opts.onQuery(query);
          panel.render();
        },
      });
    }
    for (const k of keys) out.push(builders[k]());
    // Criteria the lines above don't cover (made in the web UI, or added
    // with "More criteria"): one line each, editable when the panel knows
    // the field's type, else removable.
    const others = Object.keys(criteria).filter((k) => keys.indexOf(k) < 0 && TOGGLE_KEYS.indexOf(k) < 0);
    for (const k of others) {
      out.push({
        key: `x:${k}`,
        label: humanize(k),
        value: describeGeneric(criteria[k]),
        run: async () => {
          const type = (await fieldTypes())[k];
          const editable = type && genericKind(k, type);
          const choice = await chooseOption({
            title: humanize(k),
            options: (editable ? [{ label: 'Change…', value: 'edit' }] : []).concat([{ label: 'Remove', value: 'remove' }]),
          });
          if (choice === 'remove') set(k, null);
          if (choice === 'edit') await editGeneric(k, type);
        },
      });
    }
    out.push({
      key: 'more',
      label: 'More criteria…',
      run: async () => {
        let types;
        try {
          types = await fieldTypes();
        } catch (err) {
          toast(`Couldn't read the filter fields: ${err.message}`, 'error');
          return;
        }
        const shown = keys.concat(Object.keys(criteria), TOGGLE_KEYS);
        const avail = Object.keys(types).filter((k) => shown.indexOf(k) < 0 && genericKind(k, types[k]))
          .sort((a, b) => humanize(a).localeCompare(humanize(b)));
        const k = await chooseOption({ title: 'More criteria', options: avail.map((x) => ({ label: humanize(x), value: x })) });
        if (k) await editGeneric(k, types[k]);
      },
    });
    if (criteriaCount(criteria) || query) {
      out.push({
        key: 'clear',
        label: 'Clear all',
        danger: true,
        run: () => {
          // Toolbar toggles are kept; they have their own buttons.
          const kept = {};
          for (const k of TOGGLE_KEYS) if (criteria[k]) kept[k] = criteria[k];
          criteria = kept;
          opts.onChange(criteria);
          if (query && opts.onQuery) {
            query = '';
            opts.onQuery('');
          }
          panel.render();
        },
      });
    }
    return out;
  };

  panel = openLinesPanel({ title: 'Filter', lines });
  return panel;
}
