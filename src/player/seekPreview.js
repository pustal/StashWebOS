/**
 * Seek thumbnails from Stash's sprite sheet.
 *
 * Stash generates, per scene, one sprite image (a grid of small frames) and
 * a WebVTT file mapping time ranges to `sprite.jpg#xywh=x,y,w,h`. Both are
 * loaded once per playback, kept in memory only and freed when the player
 * closes, so they never use storage.
 */
import { getClient } from '../api/stash.js';

export class SeekPreview {
  /**
   * @param {string|null} vttUrl  scene.paths.vtt
   */
  constructor(vttUrl) {
    this.vttUrl = vttUrl;
    this.cues = [];
    this.spriteUrl = null;
    this.objectUrl = null;
    this.ready = false;
  }

  /** Downloads and parses the VTT and sprite. Failures leave previews off. */
  async load() {
    if (!this.vttUrl) return;
    try {
      const headers = getClient().authHeaders();
      const res = await fetch(this.vttUrl, { headers, cache: 'no-store', credentials: 'omit' });
      if (!res.ok) return;
      this.cues = parseVtt(await res.text());
      if (!this.cues.length) return;
      const sprite = new URL(this.cues[0].image, this.vttUrl).toString();
      const img = await fetch(sprite, { headers, cache: 'no-store', credentials: 'omit' });
      if (!img.ok) return;
      this.objectUrl = URL.createObjectURL(await img.blob());
      this.ready = true;
    } catch (e) {
      this.ready = false;
    }
  }

  /**
   * Applies the frame for `time` to an element as a background.
   * @param {HTMLElement} el
   * @param {number} time seconds
   * @returns {boolean} false when no frame is available
   */
  apply(el, time) {
    if (!this.ready) return false;
    const cue = this.find(time);
    if (!cue) return false;
    el.style.backgroundImage = `url("${this.objectUrl}")`;
    el.style.backgroundPosition = `-${cue.x}px -${cue.y}px`;
    el.style.width = `${cue.w}px`;
    el.style.height = `${cue.h}px`;
    return true;
  }

  /** Binary search for the cue containing `time`. */
  find(time) {
    let lo = 0;
    let hi = this.cues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = this.cues[mid];
      if (time < c.start) hi = mid - 1;
      else if (time >= c.end) lo = mid + 1;
      else return c;
    }
    return this.cues[Math.max(0, Math.min(this.cues.length - 1, lo))];
  }

  /** Frees the sprite image. */
  destroy() {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.ready = false;
    this.cues = [];
  }
}

/** Parses "hh:mm:ss.mmm" or "mm:ss.mmm" to seconds. */
function toSeconds(ts) {
  const parts = ts.trim().split(':').map(parseFloat);
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return s;
}

/**
 * Parses Stash's thumbnail VTT.
 * @param {string} text
 * @returns {Array<{start: number, end: number, image: string, x: number, y: number, w: number, h: number}>}
 */
export function parseVtt(text) {
  const cues = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.indexOf('-->') < 0) continue;
    const [a, b] = line.split('-->');
    const target = (lines[i + 1] || '').trim();
    const m = /^(.*)#xywh=(\d+),(\d+),(\d+),(\d+)$/.exec(target);
    if (!m) continue;
    cues.push({
      start: toSeconds(a),
      end: toSeconds(b.trim().split(' ')[0]),
      image: m[1],
      x: +m[2],
      y: +m[3],
      w: +m[4],
      h: +m[5],
    });
  }
  cues.sort((p, q) => p.start - q.start);
  return cues;
}
