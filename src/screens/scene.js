/**
 * Scene detail: backdrop, title and facts, Play/Resume, performers, studio,
 * groups, galleries, tags and markers.
 */
import { Screen } from '../ui/router.js';
import { h, icon } from '../util/dom.js';
import { createRow } from '../ui/row.js';
import { personChip, tagChip } from '../ui/cards.js';
import { openItem } from '../ui/navigate.js';
import { focus, focusFirst } from '../nav/focus.js';
import { canEdit, openEditor } from '../ui/editor.js';
import { bindImage } from '../cache/imageCache.js';
import * as api from '../api/stash.js';
import {
  formatBytes, formatDate, formatDuration, galleryTitle, resolutionLabel, sceneTitle, stars,
} from '../util/format.js';

export class SceneScreen extends Screen {
  /** @param {{id: string}} scene  at least the id; a card's data is shown while loading */
  constructor(scene) {
    super();
    this.sceneId = scene.id;
    this.preview = scene;
    this.scene = null;
    this.el.classList.add('screen-detail', 'screen-scene');
    this.el.setAttribute('data-scroll-top', '0.1');
    this.backdrop = h('img', { class: 'detail-backdrop-img', alt: '' });
    this.body = h('div', { class: 'detail-body' });
    this.el.appendChild(h('div', { class: 'detail-backdrop' }, this.backdrop));
    this.el.appendChild(this.body);
    this.renderHeader(scene, true);
  }

  async mount() {
    try {
      this.scene = await api.getScene(this.sceneId);
      if (!this.scene) throw new Error('This scene no longer exists.');
      this.render();
    } catch (err) {
      this.body.appendChild(h('div', { class: 'grid-empty' }, `Couldn't load the scene: ${err.message}`));
    }
  }

  /** Re-fetches after returning from the player so resume/play count are fresh. */
  async onShow() {
    if (this.needsRefresh && this.scene) {
      this.needsRefresh = false;
      // Markers may have been added or changed in the player.
      const markerKey = (sc) => JSON.stringify((sc.scene_markers || []).map((m) => [m.id, m.seconds, m.title, m.primary_tag && m.primary_tag.id]));
      const before = markerKey(this.scene);
      try {
        this.scene = await api.getScene(this.sceneId);
        if (markerKey(this.scene) !== before) this.render();
        else this.updateActions();
      } catch (e) { /* keep the old data */ }
    }
  }

  onHide() {
    this.needsRefresh = true;
  }

  /** Title block; `partial` = only card data is known so far. */
  renderHeader(s, partial) {
    const file = s.files && s.files[0];
    const facts = [
      s.studio ? s.studio.name : null,
      formatDate(s.date),
      file && file.duration ? formatDuration(file.duration) : null,
      file && file.height ? resolutionLabel(file.height) : null,
    ].filter(Boolean);
    const rating = stars(s.rating100);

    this.titleBlock = h('div', { class: 'detail-head' }, [
      h('h1', { class: 'detail-title' }, sceneTitle(s)),
      h('div', { class: 'detail-facts' }, facts.map((f) => h('span', null, f)).concat(
        rating ? [h('span', { class: 'rating' }, [icon('star'), String(rating)])] : [],
      )),
    ]);
    this.actions = h('div', { class: 'detail-actions nav-group' });
    this.body.innerHTML = '';
    this.body.appendChild(this.titleBlock);
    this.body.appendChild(this.actions);
    if (partial) {
      this.actions.appendChild(h('div', { class: 'button focusable disabled' }, [icon('play'), 'Loading…']));
    }
    if (s.paths && s.paths.screenshot) {
      bindImage(this.backdrop, s.paths.screenshot, { width: 1280, quality: 0.8, persist: false, eager: true });
    }
  }

  render() {
    const s = this.scene;
    this.renderHeader(s, false);
    this.updateActions();

    if (s.details) this.body.appendChild(h('p', { class: 'detail-text' }, s.details));

    const file = s.files && s.files[0];
    if (file) {
      const tech = [
        file.video_codec && file.video_codec.toUpperCase(),
        file.audio_codec && file.audio_codec.toUpperCase(),
        file.width && file.height ? `${file.width}×${file.height}` : null,
        file.frame_rate ? `${Math.round(file.frame_rate)} fps` : null,
        file.size ? formatBytes(file.size) : null,
        s.play_count ? `Played ${s.play_count}×` : null,
      ].filter(Boolean);
      this.body.appendChild(h('div', { class: 'detail-tech' }, tech.map((t) => h('span', null, t))));
    }

    if (s.performers.length) {
      this.body.appendChild(h('section', { class: 'chip-section', 'data-scroll': 'align' }, [
        h('h2', { class: 'row-title' }, 'Performers'),
        h('div', { class: 'chip-list nav-group' }, s.performers.map((p) => personChip(p, (x) => openItem('performer', x)))),
      ]));
    }
    if (s.studio) {
      this.body.appendChild(h('section', { class: 'chip-section', 'data-scroll': 'align' }, [
        h('h2', { class: 'row-title' }, 'Studio'),
        h('div', { class: 'chip-list nav-group' }, [tagChip(s.studio, (x) => openItem('studio', x))]),
      ]));
    }
    if (s.groups && s.groups.length) {
      this.body.appendChild(h('section', { class: 'chip-section', 'data-scroll': 'align' }, [
        h('h2', { class: 'row-title' }, 'Groups'),
        h('div', { class: 'chip-list nav-group' }, s.groups.map((gs) => h('div', {
          class: 'chip focusable',
          onSelect: () => openItem('group', gs.group),
        }, [gs.group.name, gs.scene_index ? h('span', { class: 'chip-hint' }, `#${gs.scene_index}`) : null]))),
      ]));
    }
    if (s.galleries && s.galleries.length) {
      this.body.appendChild(h('section', { class: 'chip-section', 'data-scroll': 'align' }, [
        h('h2', { class: 'row-title' }, 'Galleries'),
        h('div', { class: 'chip-list nav-group' }, s.galleries.map((g) => h('div', {
          class: 'chip focusable',
          onSelect: () => openItem('gallery', g),
        }, [galleryTitle(g), h('span', { class: 'chip-hint' }, String(g.image_count))]))),
      ]));
    }
    if (s.tags.length) {
      this.body.appendChild(h('section', { class: 'chip-section', 'data-scroll': 'align' }, [
        h('h2', { class: 'row-title' }, 'Tags'),
        h('div', { class: 'chip-list nav-group' }, s.tags.map((t) => tagChip(t, (x) => openItem('tag', x)))),
      ]));
    }
    if (s.scene_markers.length) {
      const markers = s.scene_markers.slice().sort((a, b) => a.seconds - b.seconds);
      const row = createRow({
        title: 'Markers',
        kind: 'marker',
        items: markers,
        onSelect: (m) => openItem('player', s, { start: m.seconds }),
      });
      this.body.appendChild(row.el);
    }
    if (this.isTop()) this.focusDefault();
  }

  /** (Re)builds Play / Resume buttons from the current resume time. */
  updateActions() {
    const s = this.scene;
    const file = s.files && s.files[0];
    this.actions.innerHTML = '';
    if (!file) {
      this.actions.appendChild(h('div', { class: 'detail-note' }, 'This scene has no video file.'));
      return;
    }
    const resume = s.resume_time && s.resume_time > 5 && (!file.duration || s.resume_time < file.duration - 10);
    if (resume) {
      this.actions.appendChild(h('div', {
        class: 'button primary focusable',
        'data-autofocus': true,
        onSelect: () => openItem('player', s, { start: s.resume_time }),
      }, [icon('play'), `Resume from ${formatDuration(s.resume_time)}`]));
    }
    this.actions.appendChild(h('div', {
      class: 'button' + (resume ? ' ghost' : ' primary') + ' focusable',
      'data-autofocus': resume ? null : true,
      onSelect: () => openItem('player', s, { start: 0 }),
    }, [icon(resume ? 'restart' : 'play'), resume ? 'Play from start' : 'Play']));
    if (canEdit()) {
      this.editButton = h('div', { class: 'button ghost focusable', onSelect: () => this.edit() }, [icon('edit'), 'Edit']);
      this.actions.appendChild(this.editButton);
    }
    if (this.isTop()) focusFirst(this.actions);
  }

  /** Opens the edit panel; reloads the page after it closes if anything changed. */
  edit() {
    openEditor('scene', this.scene, null, async (changed) => {
      if (!changed) return;
      try {
        this.scene = await api.getScene(this.sceneId);
      } catch (e) { /* keep showing what we have */ }
      this.render();
      if (this.editButton && this.isTop()) focus(this.editButton);
    });
  }

  focusDefault() {
    if (!focusFirst(this.actions)) focusFirst(this.el);
  }
}
