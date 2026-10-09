/**
 * Card renderers for scenes, performers, studios, tags and markers.
 *
 * Every card is a `.focusable` element whose image is bound through the
 * bounded image cache at the size the card is actually displayed. Widths
 * below are the stored pixel widths, not CSS widths.
 */
import { h, icon } from '../util/dom.js';
import { bindImage } from '../cache/imageCache.js';
import { formatDate, formatDuration, resolutionLabel, sceneTitle } from '../util/format.js';
import { getSettings, THUMB_QUALITY } from '../settings.js';

/** Stored-thumbnail width and quality for a card kind. */
function thumbOpts(kind) {
  const q = THUMB_QUALITY[getSettings().thumbQuality] || THUMB_QUALITY.standard;
  switch (kind) {
    case 'scene': return { width: q.sceneWidth, quality: q.jpeg };
    case 'performer': return { width: Math.round(q.sceneWidth * 0.7), quality: q.jpeg };
    case 'studio': return { width: Math.round(q.sceneWidth * 0.8), quality: q.jpeg, alpha: true };
    case 'tag': return { width: Math.round(q.sceneWidth * 0.5), quality: q.jpeg, alpha: true };
    case 'avatar': return { width: 160, quality: q.jpeg };
    default: return { width: q.sceneWidth, quality: q.jpeg };
  }
}

/**
 * Creates a lazily-loaded <img> for a Stash image URL.
 * @param {string|null} url
 * @param {string} kind  card kind for sizing (see thumbOpts)
 * @param {Object} [extra] overrides (eager, persist)
 */
export function stashImage(url, kind, extra) {
  const img = h('img', { class: 'thumb-img', alt: '', draggable: 'false' });
  bindImage(img, url, Object.assign(thumbOpts(kind), extra || {}));
  return img;
}

/**
 * Scene card (16:9 thumbnail, duration, resume bar, title, studio and date).
 * @param {Object} scene    SceneCard fragment
 * @param {(scene: Object) => void} onSelect
 */
export function sceneCard(scene, onSelect) {
  const file = scene.files && scene.files[0];
  const duration = file ? file.duration : 0;
  const progress = duration && scene.resume_time ? Math.min(1, scene.resume_time / duration) : 0;
  const sub = [scene.studio ? scene.studio.name : null, formatDate(scene.date)].filter(Boolean);
  const card = h('div', { class: 'card card-scene focusable', onSelect: () => onSelect(scene) }, [
    h('div', { class: 'thumb ratio-16x9' }, [
      stashImage(scene.paths && scene.paths.screenshot, 'scene'),
      duration ? h('span', { class: 'badge badge-duration' }, formatDuration(duration)) : null,
      file && file.height >= 1000 ? h('span', { class: 'badge badge-res' }, resolutionLabel(file.height)) : null,
      progress ? h('div', { class: 'resume-bar' }, h('div', { style: { width: `${progress * 100}%` } })) : null,
      scene.play_count > 0 && !progress ? h('span', { class: 'badge badge-watched' }, icon('check')) : null,
    ]),
    h('div', { class: 'card-text' }, [
      h('div', { class: 'card-title' }, sceneTitle(scene)),
      sub.length ? h('div', { class: 'card-sub' }, sub.map((s) => h('span', null, s))) : null,
    ]),
  ]);
  card.__item = scene;
  card.__kind = 'scene';
  return card;
}

/** Performer card (2:3 portrait, name, scene count). */
export function performerCard(p, onSelect) {
  const card = h('div', { class: 'card card-performer focusable', onSelect: () => onSelect(p) }, [
    h('div', { class: 'thumb ratio-2x3' }, [
      stashImage(p.image_path, 'performer'),
      p.favorite ? h('span', { class: 'badge badge-fav' }, icon('heartFilled')) : null,
    ]),
    h('div', { class: 'card-text' }, [
      h('div', { class: 'card-title' }, p.name),
      h('div', { class: 'card-sub' }, h('span', null, countLabel(p.scene_count))),
    ]),
  ]);
  card.__item = p;
  card.__kind = 'performer';
  return card;
}

/** Studio card (logo on a light plate, name). */
export function studioCard(s, onSelect) {
  const card = h('div', { class: 'card card-studio focusable', onSelect: () => onSelect(s) }, [
    h('div', { class: 'thumb ratio-16x9 logo-plate' }, stashImage(s.image_path, 'studio')),
    h('div', { class: 'card-text' }, [
      h('div', { class: 'card-title' }, s.name),
      h('div', { class: 'card-sub' }, h('span', null, countLabel(s.scene_count))),
    ]),
  ]);
  card.__item = s;
  card.__kind = 'studio';
  return card;
}

/**
 * Tag card. With tag images turned off (Settings) it is a text-only tile,
 * which costs no storage at all.
 */
export function tagCard(t, onSelect) {
  const showImage = getSettings().showTagImages;
  const card = h('div', { class: 'card card-tag focusable' + (showImage ? '' : ' text-only'), onSelect: () => onSelect(t) }, [
    showImage
      ? h('div', { class: 'thumb ratio-1x1 tag-plate' }, stashImage(t.image_path, 'tag'))
      : h('div', { class: 'tag-initial' }, (t.name || '?').charAt(0).toUpperCase()),
    h('div', { class: 'card-text' }, [
      h('div', { class: 'card-title' }, t.name),
      h('div', { class: 'card-sub' }, h('span', null, countLabel(t.scene_count))),
    ]),
  ]);
  card.__item = t;
  card.__kind = 'tag';
  return card;
}

/** Marker card: screenshot at the marker, title and timestamp. */
export function markerCard(m, onSelect) {
  const title = m.title || (m.primary_tag && m.primary_tag.name) || 'Marker';
  const card = h('div', { class: 'card card-scene card-marker focusable', onSelect: () => onSelect(m) }, [
    h('div', { class: 'thumb ratio-16x9' }, [
      stashImage(m.screenshot, 'scene'),
      h('span', { class: 'badge badge-duration' }, formatDuration(m.seconds)),
    ]),
    h('div', { class: 'card-text' }, [
      h('div', { class: 'card-title' }, title),
      m.primary_tag && m.title ? h('div', { class: 'card-sub' }, h('span', null, m.primary_tag.name)) : null,
    ]),
  ]);
  card.__item = m;
  card.__kind = 'marker';
  return card;
}

/** Small round avatar chip used for performers on the scene screen. */
export function personChip(p, onSelect) {
  return h('div', { class: 'chip chip-person focusable', onSelect: () => onSelect(p) }, [
    h('div', { class: 'chip-avatar' }, stashImage(p.image_path, 'avatar')),
    h('span', null, p.name),
  ]);
}

/** Text chip used for tags on the scene screen. */
export function tagChip(t, onSelect) {
  return h('div', { class: 'chip focusable', onSelect: () => onSelect(t) }, t.name);
}

function countLabel(n) {
  if (n === undefined || n === null) return '';
  return n === 1 ? '1 scene' : `${n} scenes`;
}

/** Placeholder card shown while a row/grid page is loading. */
export function skeletonCard(kind) {
  return h('div', { class: `card card-${kind} skeleton` }, [
    h('div', { class: `thumb ${kind === 'performer' ? 'ratio-2x3' : kind === 'tag' ? 'ratio-1x1' : 'ratio-16x9'}` }),
    h('div', { class: 'card-text' }, [h('div', { class: 'skeleton-line' }), h('div', { class: 'skeleton-line short' })]),
  ]);
}

/** Renderer lookup by kind, for generic rows/grids. */
export const RENDERERS = {
  scene: sceneCard,
  performer: performerCard,
  studio: studioCard,
  tag: tagCard,
  marker: markerCard,
};
