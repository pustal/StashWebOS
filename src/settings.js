/**
 * User settings, persisted in localStorage.
 *
 * localStorage is fine here: the whole object is a few hundred bytes. Large
 * data (thumbnails) never goes in localStorage — see cache/imageCache.js.
 */

const STORAGE_KEY = 'stash.settings.v1';

/** Thumbnail cache size choices, in MB. 0 = keep thumbnails in RAM only. */
export const CACHE_BUDGETS_MB = [0, 25, 50, 100, 200];

/**
 * Thumbnail sharpness presets. Width is the pixel width of a stored scene
 * thumbnail; the others scale from it. Lower = less storage per image.
 */
export const THUMB_QUALITY = {
  low: { label: 'Low (smallest files)', sceneWidth: 320, jpeg: 0.7 },
  standard: { label: 'Standard', sceneWidth: 400, jpeg: 0.78 },
  high: { label: 'High (sharper, larger)', sceneWidth: 560, jpeg: 0.85 },
};

/** Playback source preference. */
export const PLAYBACK_MODES = {
  auto: 'Auto (direct when the TV can decode it)',
  direct: 'Always direct (original file)',
  transcode: 'Always transcode (HLS)',
};

/** Max transcode resolutions, matching Stash's StreamingResolutionEnum. */
export const TRANSCODE_RESOLUTIONS = {
  ORIGINAL: 'Original',
  FOUR_K: '4K (2160p)',
  FULL_HD: 'Full HD (1080p)',
  STANDARD_HD: 'HD (720p)',
  STANDARD: 'Standard (480p)',
};

/** Default values for every setting. */
export const DEFAULTS = {
  /** Base URL of the Stash server, e.g. "http://192.168.1.10:9999". */
  serverUrl: '',
  /** Stash API key (Settings → Security in Stash). Empty when auth is off. */
  apiKey: '',
  /** Persistent thumbnail cache budget in MB (see CACHE_BUDGETS_MB). */
  cacheBudgetMB: 50,
  /** Key of THUMB_QUALITY. */
  thumbQuality: 'standard',
  /** Whether to show tag images at all (tag lists can be huge). */
  showTagImages: true,
  /** Hide tags with no scenes in the Tags browser. */
  hideEmptyTags: true,
  /** Key of PLAYBACK_MODES. */
  playbackMode: 'auto',
  /** Key of TRANSCODE_RESOLUTIONS used when transcoding. */
  maxTranscode: 'FULL_HD',
  /** Seconds skipped by Left/Right in the player. */
  skipBack: 10,
  skipForward: 30,
  /** Save resume position / play count back to Stash. */
  trackActivity: true,
  /** Seconds each image stays on screen in a slideshow. */
  slideshowSeconds: 5,
  /** Show the scrubbing thumbnails (sprite sheet) while seeking. */
  seekPreview: true,
};

let current = load();
const listeners = [];

/** Reads settings from storage, falling back to defaults for missing keys. */
function load() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return Object.assign({}, DEFAULTS, parsed);
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

/** Returns the current settings object (treat as read-only). */
export function getSettings() {
  return current;
}

/**
 * Updates some settings, persists them and notifies listeners.
 * @param {Partial<typeof DEFAULTS>} patch
 */
export function updateSettings(patch) {
  const prev = current;
  current = Object.assign({}, current, patch);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch (e) {
    console.warn('could not persist settings', e);
  }
  for (const fn of listeners) fn(current, prev);
}

/**
 * Subscribes to settings changes.
 * @param {(next: typeof DEFAULTS, prev: typeof DEFAULTS) => void} fn
 */
export function onSettingsChange(fn) {
  listeners.push(fn);
}
