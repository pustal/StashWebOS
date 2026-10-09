/**
 * Saved filters and the Stash front page.
 *
 * Stash stores a saved filter's criteria (`object_filter`) in the format of
 * its web UI, not in the format its GraphQL API accepts. For example a tag
 * criterion is saved as
 *   { modifier: 'INCLUDES', value: { items: [{ id: '3', label: 'Outdoor' }], excluded: [], depth: 0 } }
 * but must be sent as
 *   { modifier: 'INCLUDES', value: ['3'], excludes: [], depth: 0 }
 *
 * Rather than hard-coding every field of every filter type (they change
 * between Stash versions), the converter asks the server which input type
 * each field has (GraphQL introspection, cached for the session) and
 * converts by type. Unknown fields are dropped instead of failing the query.
 */
import { getClient } from './stash.js';
import * as api from './stash.js';

/** FilterMode → what the app needs to query and render that mode. */
export const MODES = {
  SCENES: { kind: 'scene', type: 'SceneFilterType', find: api.findScenes, noun: 'scenes' },
  PERFORMERS: { kind: 'performer', type: 'PerformerFilterType', find: api.findPerformers, noun: 'performers' },
  STUDIOS: { kind: 'studio', type: 'StudioFilterType', find: api.findStudios, noun: 'studios' },
  TAGS: { kind: 'tag', type: 'TagFilterType', find: api.findTags, noun: 'tags' },
  GALLERIES: { kind: 'gallery', type: 'GalleryFilterType', find: api.findGalleries, noun: 'galleries' },
  IMAGES: { kind: 'image', type: 'ImageFilterType', find: api.findImages, noun: 'images' },
  GROUPS: { kind: 'group', type: 'GroupFilterType', find: api.findGroups, noun: 'groups' },
  SCENE_MARKERS: { kind: 'marker', type: 'SceneMarkerFilterType', find: api.findMarkers, noun: 'markers' },
  MOVIES: { kind: 'group', type: 'GroupFilterType', find: api.findGroups, noun: 'groups' },
};

/** Browse section → FilterMode. */
export const SECTION_MODES = {
  scenes: 'SCENES',
  performers: 'PERFORMERS',
  studios: 'STUDIOS',
  tags: 'TAGS',
  galleries: 'GALLERIES',
  images: 'IMAGES',
  groups: 'GROUPS',
  markers: 'SCENE_MARKERS',
};

const SAVED_FILTER_FIELDS = 'id name mode find_filter { q sort direction per_page } object_filter';

/** Saved filters for a mode (alphabetical). */
export async function findSavedFilters(mode) {
  const data = await getClient().query(`query ($m: FilterMode) {
    findSavedFilters(mode: $m) { ${SAVED_FILTER_FIELDS} }
  }`, { m: mode });
  return data.findSavedFilters.slice().sort((a, b) => a.name.localeCompare(b.name));
}

/** One saved filter by id. */
export async function getSavedFilter(id) {
  const data = await getClient().query(`query ($id: ID!) {
    findSavedFilter(id: $id) { ${SAVED_FILTER_FIELDS} }
  }`, { id });
  return data.findSavedFilter;
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/** typeName → Promise<{ fieldName: { kind, name } }> */
const typeCache = {};

/** Unwraps NON_NULL/LIST wrappers to the named type. */
function baseType(t) {
  let cur = t;
  let list = false;
  while (cur && (cur.kind === 'NON_NULL' || cur.kind === 'LIST')) {
    if (cur.kind === 'LIST') list = true;
    cur = cur.ofType;
  }
  return { kind: cur && cur.kind, name: cur && cur.name, list };
}

/** Fields of an input type, from the server's schema. */
function inputFields(typeName) {
  if (!typeCache[typeName]) {
    typeCache[typeName] = getClient().query(`query ($n: String!) {
      __type(name: $n) {
        inputFields { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
      }
    }`, { n: typeName }).then((data) => {
      const out = {};
      const fields = (data.__type && data.__type.inputFields) || [];
      for (const f of fields) out[f.name] = baseType(f.type);
      return out;
    }, (err) => {
      delete typeCache[typeName];
      throw err;
    });
  }
  return typeCache[typeName];
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/** IDs from the UI's list formats ([{id}], ['1'], {items: [{id}]}). */
function ids(list) {
  if (!list) return [];
  if (!Array.isArray(list)) list = list.items || [];
  return list.map((x) => (x && typeof x === 'object' ? String(x.id) : String(x)));
}

/** Labels the UI uses for resolutions → ResolutionEnum. */
const RESOLUTIONS = {
  '144p': 'VERY_LOW', '240p': 'LOW', '360p': 'R360P', '480p': 'STANDARD', '540p': 'WEB_HD', '720p': 'STANDARD_HD',
  '1080p': 'FULL_HD', '1440p': 'QUAD_HD', '4k': 'FOUR_K', '5k': 'FIVE_K', '6k': 'SIX_K', '7k': 'SEVEN_K', '8k': 'EIGHT_K', huge: 'HUGE',
};

/** "Non-Binary" / "non binary" → "NON_BINARY". */
function enumName(v) {
  return String(v).trim().toUpperCase().replace(/[\s-]+/g, '_');
}

/** A {value, value2} pair that may be nested ({value: {value, value2}}) or flat. */
function pair(c, parse) {
  const v = c.value;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const out = { modifier: c.modifier, value: parse(v.value) };
    if (v.value2 !== undefined && v.value2 !== null) out.value2 = parse(v.value2);
    return out;
  }
  const out = { modifier: c.modifier, value: parse(v) };
  if (c.value2 !== undefined && c.value2 !== null) out.value2 = parse(c.value2);
  return out;
}

const asInt = (x) => (x === undefined || x === null || x === '' ? 0 : parseInt(x, 10));
const asFloat = (x) => (x === undefined || x === null || x === '' ? 0 : parseFloat(x));
const asStr = (x) => (x === undefined || x === null ? '' : String(x));

/**
 * Converts one criterion to the GraphQL input for `type`.
 * @returns {Promise<*>} converted value, or undefined to drop the field
 */
async function convertValue(type, c) {
  if (c === null || c === undefined) return undefined;
  if (type.kind === 'SCALAR') {
    if (type.name === 'Boolean') {
      if (typeof c === 'boolean') return c;
      const v = String(c.value) === 'true';
      if (c.modifier === 'NOT_EQUALS') return !v;
      return v;
    }
    if (type.name === 'String' || type.name === 'ID') return typeof c === 'object' ? asStr(c.value) : asStr(c);
    if (type.name === 'Int') return asInt(typeof c === 'object' ? c.value : c);
    return typeof c === 'object' && 'value' in c ? c.value : c;
  }
  if (type.kind === 'ENUM') return typeof c === 'object' ? c.value : c;
  if (type.kind !== 'INPUT_OBJECT') return undefined;

  if (type.list) {
    if (!Array.isArray(c)) return undefined;
    const out = [];
    for (const item of c) {
      const v = await convertValue({ kind: type.kind, name: type.name, list: false }, item); // eslint-disable-line no-await-in-loop
      if (v !== undefined) out.push(v);
    }
    return out;
  }

  switch (type.name) {
    case 'IntCriterionInput':
      return pair(c, asInt);
    case 'FloatCriterionInput':
      return pair(c, asFloat);
    case 'DateCriterionInput':
    case 'TimestampCriterionInput':
      return pair(c, asStr);
    case 'StringCriterionInput':
      return { modifier: c.modifier, value: asStr(c.value) };
    case 'MultiCriterionInput': {
      const v = c.value;
      const out = { modifier: c.modifier, value: ids(v) };
      const ex = v && !Array.isArray(v) ? ids(v.excluded) : ids(c.excludes);
      if (ex.length) out.excludes = ex;
      return out;
    }
    case 'HierarchicalMultiCriterionInput': {
      const v = c.value;
      const out = { modifier: c.modifier, value: ids(v) };
      const ex = v && !Array.isArray(v) ? ids(v.excluded) : ids(c.excludes);
      if (ex.length) out.excludes = ex;
      const depth = v && !Array.isArray(v) && v.depth !== undefined ? v.depth : c.depth;
      if (depth !== undefined && depth !== null) out.depth = asInt(depth);
      return out;
    }
    case 'HierarchicalCountInput': {
      const out = pair(c, asInt);
      const depth = c.value && typeof c.value === 'object' ? c.value.depth : c.depth;
      if (depth !== undefined && depth !== null) out.depth = asInt(depth);
      return out;
    }
    case 'ResolutionCriterionInput': {
      const v = asStr(c.value);
      return { modifier: c.modifier, value: RESOLUTIONS[v.toLowerCase()] || enumName(v) };
    }
    case 'OrientationCriterionInput': {
      const v = Array.isArray(c.value) ? c.value : [c.value];
      return { value: v.filter(Boolean).map(enumName) };
    }
    case 'GenderCriterionInput': {
      const v = Array.isArray(c.value) ? c.value : (c.value ? [c.value] : (c.value_list || []));
      return { modifier: c.modifier, value_list: v.map(enumName) };
    }
    case 'CircumcisionCriterionInput': {
      const v = Array.isArray(c.value) ? c.value : (c.value ? [c.value] : []);
      return { modifier: c.modifier, value: v.map(enumName) };
    }
    case 'StashIDCriterionInput': {
      const v = c.value || {};
      return { modifier: c.modifier, endpoint: v.endpoint, stash_id: v.stashID || v.stash_id };
    }
    case 'StashIDsCriterionInput': {
      const v = c.value || {};
      return { modifier: c.modifier, endpoint: v.endpoint, stash_ids: v.stashIDs || v.stash_ids };
    }
    case 'PhashDistanceCriterionInput': {
      const v = c.value && typeof c.value === 'object' ? c.value : { value: c.value, distance: c.distance };
      const out = { modifier: c.modifier, value: asStr(v.value) };
      if (v.distance !== undefined) out.distance = asInt(v.distance);
      return out;
    }
    case 'DuplicationCriterionInput':
    case 'FileDuplicationCriterionInput': {
      const out = {};
      if (c.value !== undefined) out.duplicated = String(c.value) === 'true';
      if (c.distance !== undefined) out.distance = asInt(c.distance);
      for (const k of ['phash', 'url', 'stash_id', 'title']) if (c[k] !== undefined) out[k] = String(c[k]) === 'true';
      return out;
    }
    default:
      // Nested filters (performers_filter, AND/OR/NOT…) and anything newer:
      // convert field by field against that type.
      return convertFilter(type.name, c);
  }
}

/**
 * Converts a saved `object_filter` (UI format) to the GraphQL filter type.
 * @param {string} typeName  e.g. 'SceneFilterType'
 * @param {Object} filter
 * @returns {Promise<Object>}
 */
export async function convertFilter(typeName, filter) {
  if (!filter || typeof filter !== 'object') return null;
  const fields = await inputFields(typeName);
  const out = {};
  for (const key of Object.keys(filter)) {
    const type = fields[key];
    if (!type) {
      console.warn(`saved filter: ${typeName}.${key} is not supported by this server; ignored`);
      continue;
    }
    try {
      const v = await convertValue(type, filter[key]); // eslint-disable-line no-await-in-loop
      if (v !== undefined) out[key] = v;
    } catch (e) {
      console.warn(`saved filter: couldn't convert ${typeName}.${key}`, e);
    }
  }
  return out;
}

/**
 * Turns a saved filter into the options the app's finders take.
 * @param {Object} saved  from findSavedFilters/getSavedFilter
 * @returns {Promise<{mode: Object, query: {sort?: string, direction?: string, q?: string, filter: Object}}>}
 */
export async function resolveSavedFilter(saved) {
  const mode = MODES[saved.mode];
  if (!mode) throw new Error(`${saved.mode} filters aren't supported`);
  const ff = saved.find_filter || {};
  const filter = await convertFilter(mode.type, saved.object_filter || {});
  return {
    mode,
    query: {
      sort: ff.sort || undefined,
      direction: ff.direction || undefined,
      q: ff.q || undefined,
      filter,
    },
  };
}

/**
 * Rows for the home screen from Stash's own front page setting
 * (Settings → Interface in Stash). Each row is
 * { title, kind, load: () => Promise<items> }.
 * Unsupported entries (unknown filter modes) are skipped.
 * @param {Array<Object>} content  configuration.ui.frontPageContent
 * @param {number} perRow
 */
export function frontPageRows(content, perRow) {
  const rows = [];
  for (const entry of content || []) {
    const typename = String(entry.__typename || '').toLowerCase();
    if (typename === 'savedfilter') {
      const id = entry.savedFilterId || entry.savedFilterID || entry.saved_filter_id;
      if (!id) continue;
      // The title isn't known until the filter loads; the row shows it then.
      const row = { title: '', kind: null, savedFilterId: String(id) };
      row.prepare = async () => {
        const saved = await getSavedFilter(row.savedFilterId);
        if (!saved) return null;
        const resolved = await resolveSavedFilter(saved);
        row.title = saved.name;
        row.kind = resolved.mode.kind;
        row.load = () => resolved.mode.find(Object.assign({ perPage: perRow }, resolved.query)).then((r) => r.items);
        return row;
      };
      rows.push(row);
    } else if (typename === 'customfilter') {
      const mode = MODES[entry.mode];
      if (!mode) continue;
      const msg = entry.message || {};
      const id = msg.id || '';
      const sort = entry.sortBy || (id === 'recently_released_objects' ? 'date' : 'created_at');
      const label = id === 'recently_released_objects' ? 'Recently released' : 'Recently added';
      const row = {
        title: `${label} ${mode.noun}`,
        kind: mode.kind,
        load: () => mode.find({ perPage: perRow, sort, direction: entry.direction || 'DESC' }).then((r) => r.items),
      };
      row.prepare = () => Promise.resolve(row);
      rows.push(row);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Creating, updating and deleting saved filters
// ---------------------------------------------------------------------------

/**
 * Creates or overwrites a saved filter.
 *
 * `objectFilter` must be in Stash's UI format (see the top of this file),
 * so the filter also works in Stash's web UI. The app only writes the few
 * criteria it can set itself (see the `uiFilter` of the browse toggles) and
 * keeps whatever an existing filter already had.
 * @param {{id?: string, mode: string, name: string, findFilter: Object, objectFilter: Object}} f
 * @returns {Promise<Object>} the saved filter
 */
export async function saveFilter(f) {
  const input = {
    mode: f.mode,
    name: f.name,
    find_filter: f.findFilter,
    object_filter: f.objectFilter || {},
    ui_options: {},
  };
  if (f.id) input.id = f.id;
  const data = await getClient().query(`mutation ($i: SaveFilterInput!) {
    saveFilter(input: $i) { ${SAVED_FILTER_FIELDS} }
  }`, { i: input });
  return data.saveFilter;
}

/** Deletes a saved filter. */
export function deleteSavedFilter(id) {
  return getClient().query('mutation ($i: DestroyFilterInput!) { destroySavedFilter(input: $i) }', { i: { id } });
}
