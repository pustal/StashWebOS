/**
 * Stash API surface used by the app: GraphQL documents plus typed helpers.
 *
 * Queries ask only for the fields each screen renders. Card queries in
 * particular stay slim, because a grid page may hold 60 items and the TV has
 * to parse every byte.
 */
import { StashClient, normalizeServerUrl } from './client.js';

/** The active client; set by {@link connect}. */
let client = null;

/** Creates the client for a server. */
export function connect(serverUrl, apiKey) {
  client = new StashClient(normalizeServerUrl(serverUrl), apiKey);
  return client;
}

/** Returns the active client (throws if not connected). */
export function getClient() {
  if (!client) throw new Error('Stash client not connected');
  return client;
}

/** Shorthand for the active client's query(). */
function q(query, variables) {
  return getClient().query(query, variables);
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

const SCENE_CARD = `
fragment SceneCard on Scene {
  id title date resume_time play_count rating100
  files { basename duration height }
  paths { screenshot }
  studio { id name }
}`;

const PERFORMER_CARD = `
fragment PerformerCard on Performer {
  id name disambiguation favorite image_path scene_count gender birthdate country
}`;

const STUDIO_CARD = `
fragment StudioCard on Studio {
  id name image_path scene_count favorite
}`;

const TAG_CARD = `
fragment TagCard on Tag {
  id name image_path scene_count favorite
}`;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Version, library size and the Stash UI settings this app honours
 * (minimum play percent and activity tracking).
 */
export async function serverInfo() {
  const data = await q(`{
    version { version }
    findScenes(filter: { per_page: 0 }) { count }
    configuration { ui }
  }`);
  const ui = (data.configuration && data.configuration.ui) || {};
  return {
    version: data.version.version,
    sceneCount: data.findScenes.count,
    minimumPlayPercent: typeof ui.minimumPlayPercent === 'number' ? ui.minimumPlayPercent : 0,
    trackActivity: ui.trackActivity !== false,
  };
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/**
 * Scene sort options shown in the Scenes browser. `key` is Stash's sort name.
 * "random" gets a seed appended at query time so paging stays stable.
 */
export const SCENE_SORTS = [
  { key: 'created_at', label: 'Recently added', direction: 'DESC' },
  { key: 'date', label: 'Release date', direction: 'DESC' },
  { key: 'title', label: 'Title', direction: 'ASC' },
  { key: 'last_played_at', label: 'Recently played', direction: 'DESC' },
  { key: 'play_count', label: 'Most played', direction: 'DESC' },
  { key: 'rating', label: 'Rating', direction: 'DESC' },
  { key: 'duration', label: 'Duration', direction: 'DESC' },
  { key: 'random', label: 'Shuffle', direction: 'ASC' },
];

/**
 * Finds scenes.
 * @param {Object} opts
 * @param {number} [opts.page=1]
 * @param {number} [opts.perPage=40]
 * @param {string} [opts.sort]
 * @param {'ASC'|'DESC'} [opts.direction]
 * @param {string} [opts.q] free-text query
 * @param {Object} [opts.filter] SceneFilterType
 */
export async function findScenes(opts) {
  const o = opts || {};
  const data = await q(`${SCENE_CARD}
    query ($filter: FindFilterType, $scene_filter: SceneFilterType) {
      findScenes(filter: $filter, scene_filter: $scene_filter) {
        count
        scenes { ...SceneCard }
      }
    }`, {
    filter: {
      page: o.page || 1, per_page: o.perPage || 40, sort: o.sort, direction: o.direction, q: o.q,
    },
    scene_filter: o.filter || null,
  });
  return { count: data.findScenes.count, items: data.findScenes.scenes };
}

/** Full scene for the detail screen and player. */
export async function getScene(id) {
  const data = await q(`query ($id: ID!) {
    findScene(id: $id) {
      id title code details director date rating100 o_counter play_count resume_time organized
      files { id basename path size duration video_codec audio_codec format width height frame_rate bit_rate }
      paths { screenshot preview stream vtt sprite caption }
      sceneStreams { url mime_type label }
      captions { language_code caption_type }
      studio { id name image_path }
      performers { id name disambiguation image_path favorite gender birthdate }
      tags { id name image_path }
      scene_markers { id title seconds end_seconds screenshot primary_tag { id name } }
      groups { group { id name } scene_index }
    }
  }`, { id });
  return data.findScene;
}

/**
 * Saves playback progress. `playDuration` is the number of seconds watched
 * since the previous save (Stash adds it to the scene's total).
 */
export function saveActivity(sceneId, resumeTime, playDuration) {
  return q(`mutation ($id: ID!, $r: Float, $d: Float) {
    sceneSaveActivity(id: $id, resume_time: $r, playDuration: $d)
  }`, { id: sceneId, r: resumeTime, d: playDuration });
}

/** Increments a scene's play count. */
export function addPlay(sceneId) {
  return q(`mutation ($id: ID!) { sceneAddPlay(id: $id) { count } }`, { id: sceneId });
}

// ---------------------------------------------------------------------------
// Performers, studios, tags
// ---------------------------------------------------------------------------

export const PERFORMER_SORTS = [
  { key: 'name', label: 'Name', direction: 'ASC' },
  { key: 'scenes_count', label: 'Most scenes', direction: 'DESC' },
  { key: 'created_at', label: 'Recently added', direction: 'DESC' },
  { key: 'rating', label: 'Rating', direction: 'DESC' },
  { key: 'random', label: 'Shuffle', direction: 'ASC' },
];

export const STUDIO_SORTS = [
  { key: 'name', label: 'Name', direction: 'ASC' },
  { key: 'scenes_count', label: 'Most scenes', direction: 'DESC' },
  { key: 'created_at', label: 'Recently added', direction: 'DESC' },
];

export const TAG_SORTS = [
  { key: 'scenes_count', label: 'Most scenes', direction: 'DESC' },
  { key: 'name', label: 'Name', direction: 'ASC' },
  { key: 'created_at', label: 'Recently added', direction: 'DESC' },
];

/** Generic paged finder for performers/studios/tags. */
async function findEntities(kind, opts) {
  const o = opts || {};
  const conf = {
    performer: { field: 'findPerformers', list: 'performers', filterArg: 'performer_filter', filterType: 'PerformerFilterType', frag: PERFORMER_CARD, spread: 'PerformerCard' },
    studio: { field: 'findStudios', list: 'studios', filterArg: 'studio_filter', filterType: 'StudioFilterType', frag: STUDIO_CARD, spread: 'StudioCard' },
    tag: { field: 'findTags', list: 'tags', filterArg: 'tag_filter', filterType: 'TagFilterType', frag: TAG_CARD, spread: 'TagCard' },
  }[kind];
  const data = await q(`${conf.frag}
    query ($filter: FindFilterType, $f: ${conf.filterType}) {
      ${conf.field}(filter: $filter, ${conf.filterArg}: $f) {
        count
        ${conf.list} { ...${conf.spread} }
      }
    }`, {
    filter: {
      page: o.page || 1, per_page: o.perPage || 40, sort: o.sort, direction: o.direction, q: o.q,
    },
    f: o.filter || null,
  });
  return { count: data[conf.field].count, items: data[conf.field][conf.list] };
}

export const findPerformers = (opts) => findEntities('performer', opts);
export const findStudios = (opts) => findEntities('studio', opts);
export const findTags = (opts) => findEntities('tag', opts);

/** Performer detail. */
export async function getPerformer(id) {
  const data = await q(`query ($id: ID!) {
    findPerformer(id: $id) {
      id name disambiguation gender birthdate death_date country ethnicity height_cm
      measurements hair_color eye_color alias_list details favorite image_path scene_count rating100
      career_start career_end
      tags { id name }
    }
  }`, { id });
  return data.findPerformer;
}

/** Studio detail. */
export async function getStudio(id) {
  const data = await q(`query ($id: ID!) {
    findStudio(id: $id) {
      id name details image_path scene_count favorite
      parent_studio { id name }
      child_studios { id }
    }
  }`, { id });
  return data.findStudio;
}

/** Tag detail. */
export async function getTag(id) {
  const data = await q(`query ($id: ID!) {
    findTag(id: $id) {
      id name description aliases image_path scene_count favorite
      children { id }
    }
  }`, { id });
  return data.findTag;
}

/** Sets or clears a performer's favourite flag. */
export function setPerformerFavorite(id, favorite) {
  return q(`mutation ($i: PerformerUpdateInput!) { performerUpdate(input: $i) { id favorite } }`,
    { i: { id, favorite } });
}

// ---------------------------------------------------------------------------
// Filter builders (SceneFilterType fragments used across screens)
// ---------------------------------------------------------------------------

export const filters = {
  /** Scenes with a saved resume position. */
  inProgress: () => ({ resume_time: { value: 0, modifier: 'GREATER_THAN' } }),
  /** Scenes played at least once. */
  played: () => ({ play_count: { value: 0, modifier: 'GREATER_THAN' } }),
  /** Scenes featuring a performer. */
  performer: (id) => ({ performers: { value: [id], modifier: 'INCLUDES' } }),
  /** Scenes from a studio, including its sub-studios. */
  studio: (id) => ({ studios: { value: [id], modifier: 'INCLUDES', depth: -1 } }),
  /** Scenes with a tag, including its child tags. */
  tag: (id) => ({ tags: { value: [id], modifier: 'INCLUDES', depth: -1 } }),
};

/**
 * Turns the UI's sort key into Stash's: "random" becomes "random_<seed>" so
 * that the order stays the same while the user pages through a grid.
 * @param {string} key
 * @param {number} seed
 */
export function sortKey(key, seed) {
  return key === 'random' ? `random_${seed}` : key;
}
