/**
 * Formatting helpers for durations, dates, sizes and Stash entity names.
 */

/**
 * Formats seconds as h:mm:ss or m:ss.
 * @param {number} sec
 */
export function formatDuration(sec) {
  if (!sec || !isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const hrs = Math.floor(sec / 3600);
  const ss = String(s).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Formats a Stash date ("2024-03-11") as "11 Mar 2024". Partial dates
 * ("2024" or "2024-03") are returned in the same reduced precision.
 * @param {string|null} date
 */
export function formatDate(date) {
  if (!date) return '';
  const parts = String(date).split('-');
  if (parts.length === 1) return parts[0];
  const month = MONTHS[parseInt(parts[1], 10) - 1] || '';
  if (parts.length === 2) return `${month} ${parts[0]}`;
  return `${parseInt(parts[2], 10)} ${month} ${parts[0]}`;
}

/**
 * Formats a byte count as e.g. "12.4 MB".
 * @param {number} bytes
 */
export function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  return `${mb.toFixed(1)} MB`;
}

/**
 * Age in whole years from a birthdate, optionally at a given date.
 * @param {string|null} birthdate  "YYYY-MM-DD"
 * @param {string|null} [at]       defaults to today
 */
export function ageFrom(birthdate, at) {
  if (!birthdate) return null;
  const b = new Date(birthdate);
  const d = at ? new Date(at) : new Date();
  if (isNaN(b.getTime())) return null;
  let age = d.getFullYear() - b.getFullYear();
  const m = d.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && d.getDate() < b.getDate())) age -= 1;
  return age;
}

/**
 * Display title for a scene: its title, or the primary file name without
 * extension when the scene has no title (as Stash's own UI does).
 * @param {{title?: string, files?: Array<{basename?: string}>}} scene
 */
export function sceneTitle(scene) {
  if (scene.title) return scene.title;
  const f = scene.files && scene.files[0];
  if (f && f.basename) return f.basename.replace(/\.[^.]+$/, '');
  return `Scene ${scene.id}`;
}

/**
 * Short resolution label from a video height, e.g. 2160 → "4K".
 * @param {number} height
 */
export function resolutionLabel(height) {
  if (!height) return '';
  if (height >= 2100) return '4K';
  if (height >= 1400) return '1440p';
  if (height >= 1000) return '1080p';
  if (height >= 700) return '720p';
  if (height >= 470) return '480p';
  return `${height}p`;
}

/** Country code to a readable name where the engine supports it. */
export function countryName(code) {
  if (!code) return '';
  try {
    if (typeof Intl !== 'undefined' && Intl.DisplayNames) {
      return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code;
    }
  } catch (e) { /* older engines: fall through */ }
  return code;
}

/** Converts Stash's 0–100 rating to a 0–5 star value (one decimal). */
export function stars(rating100) {
  if (rating100 === null || rating100 === undefined) return null;
  return Math.round(rating100 / 2) / 10;
}

/** Humanises a gender enum ("NON_BINARY" → "Non-binary"). */
export function genderLabel(g) {
  if (!g) return '';
  const map = {
    MALE: 'Male', FEMALE: 'Female', TRANSGENDER_MALE: 'Trans man',
    TRANSGENDER_FEMALE: 'Trans woman', INTERSEX: 'Intersex', NON_BINARY: 'Non-binary',
  };
  return map[g] || g;
}
