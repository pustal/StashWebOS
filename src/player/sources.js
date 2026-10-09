/**
 * Chooses which Stash stream to play and in what order to try the others.
 *
 * Stash offers, per scene: the original file ("Direct stream"), an MKV
 * remux, and live transcodes as HLS, MP4, WebM and DASH at several
 * resolutions. LG TVs decode H.264, HEVC and VP9 (AV1 on newer models) in
 * MP4/MKV/WebM containers in hardware, so the original file usually plays
 * directly, which costs the server nothing. HLS is the safest fallback:
 * webOS plays it natively and it supports seeking.
 */

/** Codecs the TV's hardware decoder handles (lower-case Stash/ffprobe names). */
const DIRECT_VIDEO = ['h264', 'hevc', 'h265', 'vp9', 'vp8', 'av1', 'mpeg4', 'mpeg2video'];
/** Containers webOS opens directly. */
const DIRECT_CONTAINERS = ['mp4', 'mov', 'm4v', 'matroska', 'mkv', 'webm', 'mpegts', 'avi'];
/** Audio codecs webOS decodes (DTS support varies by model, so it is not listed). */
const DIRECT_AUDIO = ['aac', 'mp3', 'ac3', 'eac3', 'opus', 'vorbis', 'flac', 'pcm_s16le', ''];

/** Stash resolution names from largest to smallest. */
const RES_ORDER = ['ORIGINAL', 'FOUR_K', 'FULL_HD', 'STANDARD_HD', 'STANDARD', 'LOW'];

/**
 * @typedef {Object} Source
 * @property {string} url
 * @property {string} label       shown in the Source menu
 * @property {'direct'|'hls'|'progressive'} type
 *   progressive = live-transcoded MP4/WebM; seeking restarts it with ?start=
 */

/** Resolution parameter of a Stash stream URL, or null. */
function resolutionOf(url) {
  const m = /[?&]resolution=([A-Z_]+)/.exec(url);
  return m ? m[1] : null;
}

/**
 * Highest-resolution stream of a family that does not exceed `max`.
 * @param {Array<{url: string, label: string}>} streams
 * @param {string} prefix  label prefix, e.g. "HLS"
 * @param {string} max     Stash resolution name
 */
function pickTranscode(streams, prefix, max) {
  const maxIdx = Math.max(0, RES_ORDER.indexOf(max));
  const family = streams.filter((s) => s.label && s.label.indexOf(prefix) === 0);
  family.sort((a, b) => RES_ORDER.indexOf(resolutionOf(a.url)) - RES_ORDER.indexOf(resolutionOf(b.url)));
  return family.find((s) => RES_ORDER.indexOf(resolutionOf(s.url)) >= maxIdx) || family[family.length - 1] || null;
}

/**
 * Readable label for a transcode, e.g. "HLS HD (720p)" → "Transcode HD (720p), HLS".
 * Stash labels the original-resolution stream with the bare format name.
 */
function transcodeLabel(stashLabel, format) {
  const size = stashLabel.slice(format.length).trim() || 'original size';
  return `Transcode ${size}, ${format}`;
}

/**
 * True when the TV should be able to play the original file.
 * @param {Object} file  VideoFile
 */
export function canPlayDirect(file) {
  if (!file) return false;
  const v = (file.video_codec || '').toLowerCase();
  const c = (file.format || '').toLowerCase();
  const a = (file.audio_codec || '').toLowerCase();
  return DIRECT_VIDEO.indexOf(v) >= 0 && DIRECT_CONTAINERS.indexOf(c) >= 0 && DIRECT_AUDIO.indexOf(a) >= 0;
}

/**
 * Ordered list of sources to try.
 * @param {Object} scene    full scene (sceneStreams, files, paths)
 * @param {{playbackMode: string, maxTranscode: string}} settings
 * @returns {Source[]}
 */
export function buildSources(scene, settings) {
  const streams = scene.sceneStreams || [];
  const directStream = streams.find((s) => s.label === 'Direct stream');
  const direct = directStream
    ? { url: directStream.url, label: 'Original file', type: 'direct' }
    : (scene.paths && scene.paths.stream ? { url: scene.paths.stream, label: 'Original file', type: 'direct' } : null);

  const hlsStream = pickTranscode(streams, 'HLS', settings.maxTranscode);
  const hls = hlsStream ? { url: hlsStream.url, label: transcodeLabel(hlsStream.label, 'HLS'), type: 'hls' } : null;
  const mp4Stream = pickTranscode(streams, 'MP4', settings.maxTranscode);
  const mp4 = mp4Stream ? { url: mp4Stream.url, label: transcodeLabel(mp4Stream.label, 'MP4'), type: 'progressive' } : null;

  const file = scene.files && scene.files[0];
  let order;
  if (settings.playbackMode === 'transcode') order = [hls, mp4, direct];
  else if (settings.playbackMode === 'direct') order = [direct, hls, mp4];
  else order = canPlayDirect(file) ? [direct, hls, mp4] : [hls, mp4, direct];
  return order.filter(Boolean);
}

/**
 * Every playable stream, for the manual Source menu.
 * @returns {Source[]}
 */
export function allSources(scene) {
  const out = [];
  for (const s of scene.sceneStreams || []) {
    if (!s.label || s.label.indexOf('DASH') === 0 || s.label.indexOf('WEBM') === 0) continue;
    let type = 'progressive';
    if (s.label === 'Direct stream' || s.label === 'MKV') type = 'direct';
    else if (s.label.indexOf('HLS') === 0) type = 'hls';
    let label = s.label;
    if (s.label === 'Direct stream') label = 'Original file';
    else if (s.label === 'MKV') label = 'Original file, MKV remux';
    else if (type === 'hls') label = transcodeLabel(s.label, 'HLS');
    else if (s.label.indexOf('MP4') === 0) label = transcodeLabel(s.label, 'MP4');
    out.push({ url: s.url, label, type });
  }
  return out;
}

/**
 * URL for a progressive transcode starting at `seconds`.
 * @param {Source} source
 * @param {number} seconds
 */
export function withStart(source, seconds) {
  if (source.type !== 'progressive' || !seconds) return source.url;
  return source.url + (source.url.indexOf('?') >= 0 ? '&' : '?') + `start=${seconds.toFixed(1)}`;
}
