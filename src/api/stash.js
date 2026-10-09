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
    /** Stash's own home page rows (Settings → Interface), used optionally. */
    frontPageContent: Array.isArray(ui.frontPageContent) ? ui.frontPageContent : [],
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
      id title code details director date urls rating100 o_counter play_count resume_time organized
      files { id basename path size duration video_codec audio_codec format width height frame_rate bit_rate }
      paths { screenshot preview stream vtt sprite caption }
      sceneStreams { url mime_type label }
      captions { language_code caption_type }
      studio { id name image_path }
      performers { id name disambiguation image_path favorite gender birthdate }
      tags { id name image_path }
      scene_markers { id title seconds end_seconds screenshot primary_tag { id name } tags { id name } }
      groups { group { id name } scene_index }
      galleries { id title image_count files { basename } folder { path } }
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
      measurements hair_color eye_color alias_list details favorite image_path rating100
      career_start career_end urls tattoos piercings
      scene_count gallery_count image_count group_count
      tags { id name }
    }
  }`, { id });
  return data.findPerformer;
}

/** Studio detail. */
export async function getStudio(id) {
  const data = await q(`query ($id: ID!) {
    findStudio(id: $id) {
      id name details image_path favorite rating100 aliases urls
      scene_count(depth: -1) gallery_count(depth: -1) image_count(depth: -1) group_count(depth: -1)
      parent_studio { id name }
      child_studios { id }
      tags { id name }
    }
  }`, { id });
  return data.findStudio;
}

/** Tag detail. */
export async function getTag(id) {
  const data = await q(`query ($id: ID!) {
    findTag(id: $id) {
      id name description aliases image_path favorite
      scene_count(depth: -1) gallery_count(depth: -1) image_count(depth: -1) group_count(depth: -1)
      scene_marker_count(depth: -1)
      parents { id name }
      children { id name }
    }
  }`, { id });
  return data.findTag;
}

/**
 * Makes a scene's cover from the video frame at `at` seconds (Stash
 * generates the screenshot and stores it as the cover).
 */
export function sceneScreenshot(id, at) {
  return q('mutation ($id: ID!, $at: Float) { sceneGenerateScreenshot(id: $id, at: $at) }', { id, at });
}

/** Create mutation per kind, for {@link createNamed}. */
const CREATES = {
  tag: ['tagCreate', 'TagCreateInput'],
  performer: ['performerCreate', 'PerformerCreateInput'],
  studio: ['studioCreate', 'StudioCreateInput'],
};

/**
 * Creates a tag, performer or studio with just a name (the rest can be
 * filled in later in Stash's web UI).
 * @param {'tag'|'performer'|'studio'} kind
 * @param {string} name
 * @returns {Promise<{id: string, name: string}>}
 */
export async function createNamed(kind, name) {
  const [mutation, type] = CREATES[kind];
  const data = await q(`mutation ($i: ${type}!) { ${mutation}(input: $i) { id name } }`, { i: { name } });
  return data[mutation];
}

/** Sets or clears a performer's favourite flag. */
export function setPerformerFavorite(id, favorite) {
  return q(`mutation ($i: PerformerUpdateInput!) { performerUpdate(input: $i) { id favorite } }`,
    { i: { id, favorite } });
}

// ---------------------------------------------------------------------------
// Galleries
// ---------------------------------------------------------------------------

const GALLERY_CARD = `
fragment GalleryCard on Gallery {
  id title date image_count
  paths { cover }
  studio { id name }
  files { basename }
  folder { path }
}`;

export const GALLERY_SORTS = [
  { key: 'created_at', label: 'Recently added', direction: 'DESC' },
  { key: 'date', label: 'Date', direction: 'DESC' },
  { key: 'title', label: 'Title', direction: 'ASC' },
  { key: 'images_count', label: 'Most images', direction: 'DESC' },
  { key: 'rating', label: 'Rating', direction: 'DESC' },
  { key: 'random', label: 'Shuffle', direction: 'ASC' },
];

/** Finds galleries (same options as {@link findScenes}; filter is a GalleryFilterType). */
export async function findGalleries(opts) {
  const o = opts || {};
  const data = await q(`${GALLERY_CARD}
    query ($filter: FindFilterType, $f: GalleryFilterType) {
      findGalleries(filter: $filter, gallery_filter: $f) {
        count
        galleries { ...GalleryCard }
      }
    }`, {
    filter: {
      page: o.page || 1, per_page: o.perPage || 40, sort: o.sort, direction: o.direction, q: o.q,
    },
    f: o.filter || null,
  });
  return { count: data.findGalleries.count, items: data.findGalleries.galleries };
}

/** Gallery detail: facts, people, chapters and linked scenes. */
export async function getGallery(id) {
  const data = await q(`${SCENE_CARD}
    query ($id: ID!) {
      findGallery(id: $id) {
        id title code date details photographer urls rating100 organized image_count
        paths { cover }
        files { basename }
        folder { path }
        studio { id name image_path }
        performers { id name image_path }
        tags { id name }
        chapters { id title image_index }
        scenes { ...SceneCard }
      }
    }`, { id });
  return data.findGallery;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/**
 * Image card + viewer data. `visual_files` tells photos (ImageFile) from
 * animated GIFs and short clips (VideoFile).
 */
const IMAGE_CARD = `
fragment ImageCard on Image {
  id title code date details photographer urls rating100 o_counter organized
  paths { thumbnail image }
  studio { id name }
  performers { id name }
  tags { id name }
  galleries { id title }
  visual_files {
    __typename
    ... on ImageFile { basename width height size }
    ... on VideoFile { basename width height size format duration }
  }
}`;

export const IMAGE_SORTS = [
  { key: 'created_at', label: 'Recently added', direction: 'DESC' },
  { key: 'date', label: 'Date', direction: 'DESC' },
  { key: 'path', label: 'File name', direction: 'ASC' },
  { key: 'rating', label: 'Rating', direction: 'DESC' },
  { key: 'random', label: 'Shuffle', direction: 'ASC' },
];

/** One image with the card/viewer fields. */
export async function getImage(id) {
  const data = await q(`${IMAGE_CARD}
    query ($id: ID!) { findImage(id: $id) { ...ImageCard } }`, { id });
  return data.findImage;
}

/** Finds images (filter is an ImageFilterType). */
export async function findImages(opts) {
  const o = opts || {};
  const data = await q(`${IMAGE_CARD}
    query ($filter: FindFilterType, $f: ImageFilterType) {
      findImages(filter: $filter, image_filter: $f) {
        count
        images { ...ImageCard }
      }
    }`, {
    filter: {
      page: o.page || 1, per_page: o.perPage || 40, sort: o.sort, direction: o.direction, q: o.q,
    },
    f: o.filter || null,
  });
  return { count: data.findImages.count, items: data.findImages.images };
}

// ---------------------------------------------------------------------------
// Groups (called "movies" before Stash 0.27)
// ---------------------------------------------------------------------------

const GROUP_CARD = `
fragment GroupCard on Group {
  id name date duration front_image_path
  scene_count
  studio { id name }
}`;

export const GROUP_SORTS = [
  { key: 'name', label: 'Name', direction: 'ASC' },
  { key: 'date', label: 'Date', direction: 'DESC' },
  { key: 'created_at', label: 'Recently added', direction: 'DESC' },
  { key: 'scenes_count', label: 'Most scenes', direction: 'DESC' },
  { key: 'rating', label: 'Rating', direction: 'DESC' },
  { key: 'random', label: 'Shuffle', direction: 'ASC' },
];

/** Finds groups (filter is a GroupFilterType). */
export async function findGroups(opts) {
  const o = opts || {};
  const data = await q(`${GROUP_CARD}
    query ($filter: FindFilterType, $f: GroupFilterType) {
      findGroups(filter: $filter, group_filter: $f) {
        count
        groups { ...GroupCard }
      }
    }`, {
    filter: {
      page: o.page || 1, per_page: o.perPage || 40, sort: o.sort, direction: o.direction, q: o.q,
    },
    f: o.filter || null,
  });
  return { count: data.findGroups.count, items: data.findGroups.groups };
}

/** Group detail, including its sub-groups. */
export async function getGroup(id) {
  const data = await q(`${GROUP_CARD}
    query ($id: ID!) {
      findGroup(id: $id) {
        id name aliases date duration director synopsis urls rating100
        front_image_path back_image_path
        scene_count
        studio { id name }
        tags { id name }
        containing_groups { group { id name } description }
        sub_groups { group { ...GroupCard } description }
      }
    }`, { id });
  return data.findGroup;
}

/** Scene sort used inside a group: the group's own running order. */
export const GROUP_ORDER_SORT = { key: 'group_scene_number', label: 'Group order', direction: 'ASC' };

// ---------------------------------------------------------------------------
// Filter builders
//
// Scene, gallery, image and group filter types use the same field names for
// performers, studios and tags, so these work for all four.
// ---------------------------------------------------------------------------

export const filters = {
  /** Scenes with a saved resume position. */
  inProgress: () => ({ resume_time: { value: 0, modifier: 'GREATER_THAN' } }),
  /** Scenes played at least once. */
  played: () => ({ play_count: { value: 0, modifier: 'GREATER_THAN' } }),
  /** Items featuring a performer. */
  performer: (id) => ({ performers: { value: [id], modifier: 'INCLUDES' } }),
  /** Items from a studio, including its sub-studios. */
  studio: (id) => ({ studios: { value: [id], modifier: 'INCLUDES', depth: -1 } }),
  /** Items with a tag, including its child tags. */
  tag: (id) => ({ tags: { value: [id], modifier: 'INCLUDES', depth: -1 } }),
  /** Scenes in a group, including its sub-groups. */
  group: (id) => ({ groups: { value: [id], modifier: 'INCLUDES', depth: -1 } }),
  /** Images in a gallery. */
  gallery: (id) => ({ galleries: { value: [id], modifier: 'INCLUDES' } }),
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

// ---------------------------------------------------------------------------
// Scene markers
// ---------------------------------------------------------------------------

const MARKER_CARD = `
fragment MarkerCard on SceneMarker {
  id title seconds end_seconds screenshot
  primary_tag { id name }
  tags { id name }
  scene { id title files { basename duration } }
}`;

export const MARKER_SORTS = [
  { key: 'created_at', label: 'Recently added', direction: 'DESC' },
  { key: 'title', label: 'Title', direction: 'ASC' },
  { key: 'scene_id', label: 'Scene', direction: 'DESC' },
  { key: 'seconds', label: 'Time in scene', direction: 'ASC' },
  { key: 'duration', label: 'Length', direction: 'DESC' },
  { key: 'random', label: 'Shuffle', direction: 'ASC' },
];

/** Finds scene markers (filter is a SceneMarkerFilterType). */
export async function findMarkers(opts) {
  const o = opts || {};
  const data = await q(`${MARKER_CARD}
    query ($filter: FindFilterType, $f: SceneMarkerFilterType) {
      findSceneMarkers(filter: $filter, scene_marker_filter: $f) {
        count
        scene_markers { ...MarkerCard }
      }
    }`, {
    filter: {
      page: o.page || 1, per_page: o.perPage || 40, sort: o.sort, direction: o.direction, q: o.q,
    },
    f: o.filter || null,
  });
  return { count: data.findSceneMarkers.count, items: data.findSceneMarkers.scene_markers };
}

/** Fields returned after creating or changing a marker (as on a scene). */
const MARKER_FIELDS = 'id title seconds end_seconds screenshot primary_tag { id name } tags { id name }';

/**
 * Creates a marker in a scene.
 * @param {{scene_id: string, seconds: number, primary_tag_id: string, title?: string, tag_ids?: string[]}} input
 * @returns {Promise<Object>} the new marker
 */
export async function createMarker(input) {
  const i = Object.assign({ title: '', tag_ids: [] }, input);
  const data = await q(`mutation ($i: SceneMarkerCreateInput!) { sceneMarkerCreate(input: $i) { ${MARKER_FIELDS} } }`, { i });
  return data.sceneMarkerCreate;
}

/**
 * Changes a marker.
 * @param {string} id
 * @param {Object} patch  fields of SceneMarkerUpdateInput (title, seconds,
 *   primary_tag_id, tag_ids…)
 * @returns {Promise<Object>} the updated marker
 */
export async function updateMarker(id, patch) {
  const data = await q(`mutation ($i: SceneMarkerUpdateInput!) { sceneMarkerUpdate(input: $i) { ${MARKER_FIELDS} } }`,
    { i: Object.assign({ id }, patch) });
  return data.sceneMarkerUpdate;
}

/** Deletes a marker. */
export function deleteMarker(id) {
  return q('mutation ($id: ID!) { sceneMarkerDestroy(id: $id) }', { id });
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/** Update mutation and input type per kind. */
const UPDATES = {
  scene: ['sceneUpdate', 'SceneUpdateInput'],
  image: ['imageUpdate', 'ImageUpdateInput'],
  gallery: ['galleryUpdate', 'GalleryUpdateInput'],
  group: ['groupUpdate', 'GroupUpdateInput'],
  performer: ['performerUpdate', 'PerformerUpdateInput'],
  studio: ['studioUpdate', 'StudioUpdateInput'],
  tag: ['tagUpdate', 'TagUpdateInput'],
};

/**
 * Saves changed fields of an item.
 * @param {'scene'|'image'|'gallery'|'group'|'performer'|'studio'|'tag'} kind
 * @param {string} id
 * @param {Object} patch  fields of the *UpdateInput, e.g. { rating100: 80 }
 */
export function updateItem(kind, id, patch) {
  const [mutation, type] = UPDATES[kind];
  return q(`mutation ($i: ${type}!) { ${mutation}(input: $i) { id } }`, { i: Object.assign({ id }, patch) });
}

/** Getter for one full item per kind (what the detail screens load). */
export function getItem(kind, id) {
  const getters = {
    scene: getScene, image: getImage, gallery: getGallery, group: getGroup, performer: getPerformer, studio: getStudio, tag: getTag,
  };
  return getters[kind](id);
}

/**
 * Deletes an item from Stash.
 * @param {'scene'|'image'|'gallery'|'group'|'performer'|'studio'|'tag'} kind
 * @param {string} id
 * @param {{deleteFile?: boolean}} [opts]  scenes, images, galleries: also
 *   delete the file(s) from disk (generated files are always removed)
 */
export function deleteItem(kind, id, opts) {
  const deleteFile = !!(opts && opts.deleteFile);
  if (kind === 'scene' || kind === 'image') {
    const m = `${kind}Destroy`;
    const t = kind === 'scene' ? 'SceneDestroyInput' : 'ImageDestroyInput';
    return q(`mutation ($i: ${t}!) { ${m}(input: $i) }`, { i: { id, delete_file: deleteFile, delete_generated: true } });
  }
  if (kind === 'gallery') {
    return q('mutation ($i: GalleryDestroyInput!) { galleryDestroy(input: $i) }', { i: { ids: [id], delete_file: deleteFile, delete_generated: true } });
  }
  const m = `${kind}Destroy`;
  const t = `${kind.charAt(0).toUpperCase()}${kind.slice(1)}DestroyInput`;
  return q(`mutation ($i: ${t}!) { ${m}(input: $i) }`, { i: { id } });
}

// ---------------------------------------------------------------------------
// Several items at once
// ---------------------------------------------------------------------------

/** Bulk update mutation and input type per kind. */
const BULK_UPDATES = {
  scene: ['bulkSceneUpdate', 'BulkSceneUpdateInput'],
  image: ['bulkImageUpdate', 'BulkImageUpdateInput'],
  gallery: ['bulkGalleryUpdate', 'BulkGalleryUpdateInput'],
  group: ['bulkGroupUpdate', 'BulkGroupUpdateInput'],
  performer: ['bulkPerformerUpdate', 'BulkPerformerUpdateInput'],
  studio: ['bulkStudioUpdate', 'BulkStudioUpdateInput'],
  tag: ['bulkTagUpdate', 'BulkTagUpdateInput'],
  marker: ['bulkSceneMarkerUpdate', 'BulkSceneMarkerUpdateInput'],
};

/**
 * Changes several items the same way.
 * @param {string} kind
 * @param {string[]} ids
 * @param {Object} patch  fields of the Bulk*UpdateInput, e.g.
 *   { tag_ids: { ids: ['3'], mode: 'ADD' } } or { organized: true }
 */
export function bulkUpdate(kind, ids, patch) {
  const [mutation, type] = BULK_UPDATES[kind];
  return q(`mutation ($i: ${type}!) { ${mutation}(input: $i) { id } }`, { i: Object.assign({ ids }, patch) });
}

/**
 * Deletes several items.
 * @param {string} kind
 * @param {string[]} ids
 * @param {{deleteFile?: boolean}} [opts]  scenes, images, galleries: also
 *   delete their files from disk
 */
export function deleteItems(kind, ids, opts) {
  const deleteFile = !!(opts && opts.deleteFile);
  if (kind === 'scene' || kind === 'image') {
    const m = `${kind}sDestroy`;
    const t = kind === 'scene' ? 'ScenesDestroyInput' : 'ImagesDestroyInput';
    return q(`mutation ($i: ${t}!) { ${m}(input: $i) }`, { i: { ids, delete_file: deleteFile, delete_generated: true } });
  }
  if (kind === 'gallery') {
    return q('mutation ($i: GalleryDestroyInput!) { galleryDestroy(input: $i) }', { i: { ids, delete_file: deleteFile, delete_generated: true } });
  }
  const m = kind === 'marker' ? 'sceneMarkersDestroy' : `${kind}sDestroy`;
  return q(`mutation ($ids: [ID!]!) { ${m}(ids: $ids) }`, { ids });
}

/**
 * Adds (+1) or removes (-1) one O for a scene or image.
 * @returns {Promise<number>} the new count
 */
export async function changeO(kind, id, delta) {
  if (kind === 'scene') {
    const m = delta > 0 ? 'sceneAddO' : 'sceneDeleteO';
    const data = await q(`mutation ($id: ID!) { ${m}(id: $id) { count } }`, { id });
    return data[m].count;
  }
  const m = delta > 0 ? 'imageIncrementO' : 'imageDecrementO';
  const data = await q(`mutation ($id: ID!) { ${m}(id: $id) }`, { id });
  return data[m];
}
