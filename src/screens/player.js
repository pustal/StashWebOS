/**
 * Video player.
 *
 * Remote controls
 * - OK: play/pause and show the controls
 * - Left/Right: seek back/forward (presses add up; the jump happens when
 *   you stop pressing), with sprite thumbnails when Stash generated them
 * - Up/Down: show the controls
 * - Play, Pause, Stop, Rewind, Fast-forward: as labelled
 * - Channel up/down: next/previous marker
 * - Set cover (with editing on): the frame on screen becomes the scene's cover
 * - Markers button: jump to a marker, or (with editing on) add a marker at
 *   the current time and edit or delete markers (see ui/markerEditor.js)
 * - Back: hide the controls, or leave the player (progress is saved)
 *
 * Queue: when opened with `queue` (e.g. a group's Play all), the next scene
 * starts automatically a few seconds after one ends, and a Next button
 * appears in the controls.
 *
 * Progress is saved to Stash with the same rules as other Stash TV clients:
 * nothing under 5 s watched; within the last 30 s the resume point is
 * cleared; play count goes up once per viewing after Stash's
 * "minimum play percent" (at least 5 s).
 */
import { Screen } from '../ui/router.js';
import { h, icon } from '../util/dom.js';
import { focus, getFocused } from '../nav/focus.js';
import { chooseOption, confirmDialog, toast } from '../ui/overlay.js';
import { KEY, isBack } from '../util/keys.js';
import { formatDuration, sceneTitle } from '../util/format.js';
import { getSettings } from '../settings.js';
import { getServerInfo } from '../session.js';
import * as api from '../api/stash.js';
import { allSources, buildSources, withStart } from '../player/sources.js';
import { SeekPreview } from '../player/seekPreview.js';
import { canEdit } from '../ui/editor.js';
import {
  addMarker, editMarker, markerName, markerTime,
} from '../ui/markerEditor.js';

const HIDE_CONTROLS_MS = 5000;
const SEEK_COMMIT_MS = 700;
const SAVE_EVERY_S = 30;
const START_TIMEOUT_MS = 20000;

export class PlayerScreen extends Screen {
  /**
   * @param {Object} scene   full scene (from getScene) or at least {id}
   * @param {{start?: number, queue?: Array<Object>, queueIndex?: number}} [opts]
   *   queue: scenes to play in order; queueIndex: position of `scene` in it
   */
  constructor(scene, opts) {
    super();
    this.fullscreen = true;
    this.scene = scene;
    this.startAt = (opts && opts.start) || 0;
    this.queue = (opts && opts.queue) || null;
    this.queueIndex = (opts && opts.queueIndex) || 0;
    this.nextTimer = null;
    this.el.classList.add('screen-player', 'no-scroll');

    this.sources = [];
    this.sourceIndex = 0;
    this.source = null;
    /** Seconds the current progressive transcode started at (see sources.js). */
    this.offset = 0;
    this.duration = 0;

    // Activity tracking
    this.lastPos = null;
    this.watched = 0;
    this.unsaved = 0;
    this.playCounted = false;

    this.seekTarget = null;
    this.seekTimer = null;
    this.hideTimer = null;
    this.startTimer = null;
    this.subtitleUrl = null;

    this.build();
    this.onVisibility = () => {
      if (document.hidden) {
        this.video.pause();
        this.saveProgress();
      }
    };
  }

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------

  build() {
    this.video = h('video', { class: 'player-video', preload: 'auto', playsinline: true });
    this.spinner = h('div', { class: 'player-spinner' });
    this.message = h('div', { class: 'player-message' });

    this.played = h('div', { class: 'progress-played' });
    this.buffered = h('div', { class: 'progress-buffered' });
    this.seekMark = h('div', { class: 'progress-seek' });
    this.ticks = h('div', { class: 'progress-ticks' });
    this.preview = h('div', { class: 'seek-preview' }, [h('div', { class: 'seek-frame' }), h('div', { class: 'seek-time' })]);
    this.progress = h('div', { class: 'progress focusable', onSelect: () => this.togglePlay() }, [
      h('div', { class: 'progress-track' }, [this.buffered, this.played, this.ticks, this.seekMark]),
      this.preview,
    ]);
    this.timeNow = h('span', { class: 'time-now' }, '0:00');
    this.timeEnd = h('span', { class: 'time-end' }, '0:00');
    this.playButton = this.ctrl('play', 'Play', () => this.togglePlay());

    this.controlsRow = h('div', { class: 'controls-row nav-group', 'data-no-memory': true }, [
      this.ctrl('restart', 'Start over', () => this.seekTo(0)),
      this.ctrl('back10', 'Back', () => this.seekBy(-getSettings().skipBack)),
      this.playButton,
      this.ctrl('fwd30', 'Forward', () => this.seekBy(getSettings().skipForward)),
      this.markersButton = this.ctrl('markers', 'Markers', () => this.pickMarker()),
      this.captionsButton = this.ctrl('captions', 'Subtitles', () => this.pickSubtitles()),
      this.ctrl('stream', 'Source', () => this.pickSource()),
      canEdit() ? this.ctrl('image', 'Set cover', () => this.setCover()) : null,
      this.nextScene() ? this.ctrl('next', 'Next', () => this.playNext()) : null,
    ]);
    this.title = h('div', { class: 'player-title' }, sceneTitle(this.scene));
    this.sourceLabel = h('div', { class: 'player-source' });

    this.controls = h('div', { class: 'player-controls' }, [
      h('div', { class: 'player-top' }, [this.title, this.sourceLabel]),
      h('div', { class: 'player-bottom' }, [
        this.progress,
        h('div', { class: 'time-row' }, [this.timeNow, this.timeEnd]),
        this.controlsRow,
      ]),
    ]);

    // Mini bar shown while seeking with the controls hidden.
    this.osdPlayed = h('div', { class: 'progress-played' });
    this.osdSeek = h('div', { class: 'progress-seek' });
    this.osdPreview = h('div', { class: 'seek-preview' }, [h('div', { class: 'seek-frame' }), h('div', { class: 'seek-time' })]);
    this.osd = h('div', { class: 'player-osd' }, [
      h('div', { class: 'progress' }, [h('div', { class: 'progress-track' }, [this.osdPlayed, this.osdSeek]), this.osdPreview]),
    ]);

    this.el.appendChild(this.video);
    this.el.appendChild(this.spinner);
    this.el.appendChild(this.message);
    this.el.appendChild(this.osd);
    this.el.appendChild(this.controls);

    // Every handler is ignored once the player is closing: tearing the
    // video down fires pause/error events we must not react to.
    const on = (name, fn) => this.video.addEventListener(name, () => {
      if (!this.destroyed) fn();
    });
    on('timeupdate', () => this.onTime());
    on('playing', () => this.onPlaying());
    on('pause', () => this.onPause());
    on('waiting', () => this.el.classList.add('buffering'));
    on('canplay', () => this.el.classList.remove('buffering'));
    on('ended', () => this.onEnded());
    on('error', () => this.onError());
    on('progress', () => this.drawBuffered());
  }

  /** A control button with an icon and a label under it. */
  ctrl(iconName, label, fn) {
    return h('div', { class: 'ctrl focusable', onSelect: fn }, [icon(iconName), h('span', { class: 'ctrl-label' }, label)]);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async mount() {
    document.addEventListener('visibilitychange', this.onVisibility);
    this.el.classList.add('buffering');
    try {
      if (!this.scene.sceneStreams) this.scene = await api.getScene(this.scene.id);
    } catch (err) {
      this.fail(`Couldn't load the scene: ${err.message}`);
      return;
    }
    if (this.destroyed) return; // user left while loading
    const s = this.scene;
    const file = s.files && s.files[0];
    this.duration = (file && file.duration) || 0;
    this.title.textContent = sceneTitle(s);
    this.timeEnd.textContent = formatDuration(this.duration);
    this.setMarkers(s.scene_markers || []);
    this.captionsButton.style.display = (s.captions && s.captions.length) ? '' : 'none';
    this.drawTicks();

    this.seekPreview = getSettings().seekPreview ? new SeekPreview(s.paths && s.paths.vtt) : null;
    if (this.seekPreview) this.seekPreview.load();

    this.sources = buildSources(s, getSettings());
    if (!this.sources.length) {
      this.fail('Stash offers no stream for this scene.');
      return;
    }
    this.play(0, this.startAt);
  }

  focusDefault() {
    focus(this.playButton, { scroll: false });
  }

  onHide() {
    this.saveProgress(true);
  }

  destroy() {
    this.destroyed = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    clearTimeout(this.hideTimer);
    clearTimeout(this.seekTimer);
    clearTimeout(this.startTimer);
    clearTimeout(this.nextTimer);
    // Release the hardware decoder right away; TVs only have one or two.
    this.video.pause();
    this.video.removeAttribute('src');
    try { this.video.load(); } catch (e) { /* ignore */ }
    if (this.seekPreview) this.seekPreview.destroy();
    if (this.subtitleUrl) URL.revokeObjectURL(this.subtitleUrl);
    super.destroy();
  }

  // -------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------

  /**
   * Starts a source at a position.
   * @param {number} index  index in this.sources
   * @param {number} at     seconds
   */
  play(index, at) {
    this.sourceIndex = index;
    this.source = this.sources[index];
    this.offset = this.source.type === 'progressive' ? at : 0;
    this.sourceLabel.textContent = this.source.label;
    this.message.textContent = '';
    this.el.classList.remove('failed');
    this.el.classList.add('buffering');
    this.lastPos = null;

    const v = this.video;
    v.src = withStart(this.source, at);
    if (this.source.type !== 'progressive' && at > 0) {
      const seekWhenReady = () => {
        v.removeEventListener('loadedmetadata', seekWhenReady);
        try { v.currentTime = at; } catch (e) { /* ignore */ }
      };
      v.addEventListener('loadedmetadata', seekWhenReady);
    }
    const p = v.play();
    if (p && p.catch) p.catch(() => { /* autoplay errors surface as 'error' */ });

    clearTimeout(this.startTimer);
    this.startTimer = setTimeout(() => {
      if (v.readyState < 2) this.onError();
    }, START_TIMEOUT_MS);
  }

  /** Falls back to the next source, keeping the position. */
  onError() {
    clearTimeout(this.startTimer);
    if (this.destroyed) return;
    const pos = this.position();
    if (this.sourceIndex + 1 < this.sources.length) {
      const next = this.sources[this.sourceIndex + 1];
      toast(`${this.source.label} didn't play. Trying ${next.label}.`);
      this.play(this.sourceIndex + 1, pos);
    } else {
      this.fail('This video could not be played on this TV. Try a transcode under Source, or check Stash’s transcoding settings.');
    }
  }

  fail(text) {
    this.el.classList.remove('buffering');
    this.el.classList.add('failed');
    this.message.textContent = text;
    this.showControls(true);
  }

  async pickSource() {
    const list = allSources(this.scene);
    const url = await chooseOption({
      title: 'Source',
      options: list.map((s) => ({ label: s.label, value: s.url })),
      selected: this.source && this.source.url,
    });
    if (!url || (this.source && url === this.source.url)) return;
    const chosen = list.find((s) => s.url === url);
    // Put the chosen source first and keep the others as fallbacks.
    this.sources = [chosen].concat(this.sources.filter((s) => s.url !== url));
    this.play(0, this.position());
  }

  // -------------------------------------------------------------------------
  // Position / seeking
  // -------------------------------------------------------------------------

  /** Current position in the scene (accounts for transcode start offsets). */
  position() {
    return (this.video.currentTime || 0) + this.offset;
  }

  totalDuration() {
    return this.duration || this.video.duration || 0;
  }

  /** Jumps to a position. */
  seekTo(t) {
    const d = this.totalDuration();
    const target = Math.max(0, d ? Math.min(t, d - 1) : t);
    if (this.source && this.source.type === 'progressive') {
      this.play(this.sourceIndex, target); // live transcode: restart at target
    } else {
      this.video.currentTime = target;
    }
    this.lastPos = null; // a jump is not watching
    this.drawTime(target);
  }

  seekBy(delta) {
    this.seekTo(this.position() + delta);
  }

  /**
   * Accumulates Left/Right presses and seeks once they stop, so holding the
   * key scrubs smoothly instead of firing dozens of network seeks.
   */
  nudge(direction) {
    const s = getSettings();
    const step = direction > 0 ? s.skipForward : -s.skipBack;
    const base = this.seekTarget === null ? this.position() : this.seekTarget;
    const d = this.totalDuration();
    this.seekTarget = Math.max(0, d ? Math.min(base + step, d - 1) : base + step);
    this.el.classList.add('seeking');
    this.drawSeek(this.seekTarget);
    clearTimeout(this.seekTimer);
    this.seekTimer = setTimeout(() => this.commitSeek(), SEEK_COMMIT_MS);
  }

  commitSeek() {
    if (this.seekTarget === null) return;
    const t = this.seekTarget;
    this.seekTarget = null;
    this.el.classList.remove('seeking');
    this.seekTo(t);
  }

  // -------------------------------------------------------------------------
  // Markers / subtitles
  // -------------------------------------------------------------------------

  markerLabel(m) {
    return markerName(m);
  }

  /**
   * Stores the scene's markers in time order and updates the timeline ticks
   * and the Markers button (shown when there are markers or editing is on,
   * since the menu can add one).
   */
  setMarkers(list) {
    this.markers = list.slice().sort((a, b) => a.seconds - b.seconds);
    this.markersButton.style.display = this.markers.length || canEdit() ? '' : 'none';
    this.drawTicks();
  }

  /**
   * The Markers menu: choosing a marker jumps to it. With editing on it
   * also offers adding a marker at the current time and editing one.
   */
  async pickMarker() {
    const now = Math.floor(this.position());
    const editing = canEdit();
    const options = this.markers.map((m) => ({ label: this.markerLabel(m), hint: markerTime(m), value: m.id }));
    if (editing) {
      options.unshift({ label: `Add a marker at ${formatDuration(now)}…`, value: '__add' });
      if (this.markers.length) options.push({ label: 'Edit a marker…', value: '__edit' });
    }
    const value = await chooseOption({ title: 'Markers', options });
    if (value === undefined) return;
    if (value === '__add') {
      const m = await addMarker(this.scene.id, now);
      if (m) this.setMarkers(this.markers.concat([m]));
      return;
    }
    if (value === '__edit') {
      const id = await chooseOption({
        title: 'Edit a marker',
        options: this.markers.map((m) => ({ label: this.markerLabel(m), hint: markerTime(m), value: m.id })),
      });
      const m = this.markers.find((x) => x.id === id);
      if (!m) return;
      const res = await editMarker(m, { now: () => this.position(), duration: this.totalDuration() });
      if (res.deleted) this.setMarkers(this.markers.filter((x) => x.id !== m.id));
      else if (res.changed) this.setMarkers(this.markers);
      return;
    }
    const m = this.markers.find((x) => x.id === value);
    if (m) this.seekTo(m.seconds);
  }

  /** Makes the frame on screen the scene's cover (after confirming). */
  async setCover() {
    const at = this.position();
    const ok = await confirmDialog({
      title: 'Set as cover?',
      message: `The frame at ${formatDuration(at)} becomes this scene's cover image in Stash.`,
      confirm: 'Set cover',
    });
    if (!ok) return;
    try {
      await api.sceneScreenshot(this.scene.id, at);
      toast('Cover saved');
    } catch (err) {
      toast(`Couldn't set the cover: ${err.message}`, 'error');
    }
  }

  /** Jumps to the next (+1) or previous (-1) marker. */
  jumpMarker(dir) {
    if (!this.markers || !this.markers.length) return;
    const pos = this.position();
    let target = null;
    if (dir > 0) target = this.markers.find((m) => m.seconds > pos + 1);
    else {
      for (let i = this.markers.length - 1; i >= 0; i -= 1) {
        if (this.markers[i].seconds < pos - 3) {
          target = this.markers[i];
          break;
        }
      }
    }
    if (target) {
      this.seekTo(target.seconds);
      toast(this.markerLabel(target));
    }
  }

  async pickSubtitles() {
    const caps = this.scene.captions || [];
    const value = await chooseOption({
      title: 'Subtitles',
      options: [{ label: 'Off', value: 'off' }].concat(caps.map((c, i) => ({
        label: (c.language_code || 'Unknown').toUpperCase(), hint: c.caption_type, value: String(i),
      }))),
      selected: this.subtitleChoice || 'off',
    });
    if (value === undefined) return;
    this.subtitleChoice = value;
    this.setSubtitles(value === 'off' ? null : caps[+value]);
  }

  /** Loads a caption as VTT (Stash converts SRT for us) and shows it. */
  async setSubtitles(caption) {
    const old = this.video.querySelector('track');
    if (old) this.video.removeChild(old);
    if (this.subtitleUrl) URL.revokeObjectURL(this.subtitleUrl);
    this.subtitleUrl = null;
    if (!caption) return;
    try {
      const base = this.scene.paths.caption;
      const url = `${base}${base.indexOf('?') >= 0 ? '&' : '?'}lang=${encodeURIComponent(caption.language_code)}&type=${encodeURIComponent(caption.caption_type)}`;
      const res = await fetch(url, { headers: api.getClient().authHeaders(), cache: 'no-store', credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let text = await res.text();
      // Progressive transcodes restart at `offset`: shift cues to match.
      if (this.offset) text = shiftVtt(text, -this.offset);
      this.subtitleUrl = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
      const track = h('track', { kind: 'subtitles', srclang: caption.language_code, src: this.subtitleUrl, default: true });
      this.video.appendChild(track);
      if (this.video.textTracks[0]) this.video.textTracks[0].mode = 'showing';
    } catch (err) {
      toast(`Couldn't load subtitles: ${err.message}`, 'error');
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  onPlaying() {
    clearTimeout(this.startTimer);
    this.el.classList.remove('buffering', 'paused');
    this.playButton.replaceChild(icon('pause'), this.playButton.firstChild);
    this.playButton.lastChild.textContent = 'Pause';
    this.scheduleHide();
  }

  onPause() {
    this.el.classList.add('paused');
    this.playButton.replaceChild(icon('play'), this.playButton.firstChild);
    this.playButton.lastChild.textContent = 'Play';
    this.showControls(true);
    this.saveProgress();
  }

  onEnded() {
    this.countPlay(true);
    this.saveProgress(true, true);
    const next = this.nextScene();
    if (next) {
      toast(`Up next: ${sceneTitle(next)}`);
      this.nextTimer = setTimeout(() => this.playNext(), 4000);
      return;
    }
    this.showControls(true);
  }

  /** The scene after this one in the queue, if any. */
  nextScene() {
    return this.queue ? this.queue[this.queueIndex + 1] || null : null;
  }

  /** Replaces this player with one for the next queued scene. */
  playNext() {
    clearTimeout(this.nextTimer);
    const next = this.nextScene();
    if (!next || this.destroyed) return;
    this.router.replaceTop(new PlayerScreen(next, {
      start: 0, queue: this.queue, queueIndex: this.queueIndex + 1,
    }));
  }

  onTime() {
    const pos = this.position();
    if (this.lastPos !== null && !this.video.paused) {
      const delta = pos - this.lastPos;
      // Only count normal playback, not jumps.
      if (delta > 0 && delta < 2) {
        this.watched += delta;
        this.unsaved += delta;
      }
    }
    this.lastPos = pos;
    if (this.seekTarget === null) this.drawTime(pos);
    this.countPlay(false);
    if (this.unsaved >= SAVE_EVERY_S) this.saveProgress();
  }

  // -------------------------------------------------------------------------
  // Activity tracking
  // -------------------------------------------------------------------------

  trackingEnabled() {
    const info = getServerInfo();
    return getSettings().trackActivity && (!info || info.trackActivity);
  }

  /** Adds one play once enough has been watched (or the video ended). */
  countPlay(ended) {
    if (this.playCounted || !this.trackingEnabled() || this.watched < 5) return;
    const info = getServerInfo();
    const pct = info ? info.minimumPlayPercent : 0;
    const needed = (this.totalDuration() * pct) / 100;
    if (ended || this.watched >= needed) {
      this.playCounted = true;
      api.addPlay(this.scene.id).catch(() => { this.playCounted = false; });
    }
  }

  /**
   * Saves the resume point and watched time.
   * @param {boolean} [final]  leaving the player
   * @param {boolean} [ended]  playback reached the end
   */
  saveProgress(final, ended) {
    if (!this.trackingEnabled() || !this.scene || !this.scene.id) return;
    if (this.watched < 5 && !ended) return;
    const pos = this.position();
    const d = this.totalDuration();
    const nearEnd = ended || (d && pos > d - 30);
    const resume = nearEnd ? 0 : pos;
    const played = this.unsaved;
    if (!final && played < 1) return;
    this.unsaved = 0;
    api.saveActivity(this.scene.id, resume, played).catch(() => {
      this.unsaved += played; // try again next time
    });
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  drawTime(pos) {
    const d = this.totalDuration();
    const pct = d ? Math.min(100, (pos / d) * 100) : 0;
    this.played.style.width = `${pct}%`;
    this.osdPlayed.style.width = `${pct}%`;
    this.timeNow.textContent = formatDuration(pos);
  }

  drawSeek(t) {
    const d = this.totalDuration();
    const pct = d ? Math.min(100, (t / d) * 100) : 0;
    for (const [mark, preview] of [[this.seekMark, this.preview], [this.osdSeek, this.osdPreview]]) {
      mark.style.left = `${pct}%`;
      const frame = preview.firstChild;
      const hasFrame = this.seekPreview && this.seekPreview.apply(frame, t);
      preview.classList.toggle('no-frame', !hasFrame);
      preview.lastChild.textContent = formatDuration(t);
      // Centre the preview over the position, but keep it on screen.
      const trackWidth = preview.parentElement.clientWidth;
      const half = preview.offsetWidth / 2;
      const x = Math.max(half, Math.min(trackWidth - half, (pct / 100) * trackWidth));
      preview.style.left = `${x}px`;
    }
    this.timeNow.textContent = formatDuration(t);
  }

  drawBuffered() {
    const v = this.video;
    const d = this.totalDuration();
    if (!d || !v.buffered || !v.buffered.length) return;
    const end = v.buffered.end(v.buffered.length - 1) + this.offset;
    this.buffered.style.width = `${Math.min(100, (end / d) * 100)}%`;
  }

  drawTicks() {
    this.ticks.innerHTML = '';
    const d = this.totalDuration();
    if (!d) return;
    for (const m of this.markers) {
      // A marker with an end time is drawn as a band over the stretch it covers.
      const style = { left: `${(m.seconds / d) * 100}%` };
      if (m.end_seconds > m.seconds) style.width = `${((Math.min(m.end_seconds, d) - m.seconds) / d) * 100}%`;
      this.ticks.appendChild(h('span', { class: 'tick' + (style.width ? ' range' : ''), style }));
    }
  }

  // -------------------------------------------------------------------------
  // Controls visibility
  // -------------------------------------------------------------------------

  controlsVisible() {
    return this.el.classList.contains('show-controls');
  }

  /** Shows controls; `stay` keeps them up (paused, errors). */
  showControls(stay) {
    const wasVisible = this.controlsVisible();
    this.el.classList.add('show-controls');
    if (!wasVisible) {
      const f = getFocused();
      if (!f || !this.controls.contains(f)) focus(this.playButton, { scroll: false });
    }
    if (stay) clearTimeout(this.hideTimer);
    else this.scheduleHide();
  }

  hideControls() {
    clearTimeout(this.hideTimer);
    this.el.classList.remove('show-controls');
  }

  scheduleHide() {
    clearTimeout(this.hideTimer);
    if (this.video.paused || this.el.classList.contains('failed')) return;
    this.hideTimer = setTimeout(() => this.hideControls(), HIDE_CONTROLS_MS);
  }

  togglePlay() {
    if (this.el.classList.contains('failed')) {
      this.play(this.sourceIndex, this.position());
      return;
    }
    if (this.video.paused) {
      const p = this.video.play();
      if (p && p.catch) p.catch(() => {});
    } else {
      this.video.pause();
    }
  }

  // -------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------

  onKey(e) {
    const k = e.keyCode;
    // Media keys work in every state.
    switch (k) {
      case KEY.PLAY:
        this.video.play();
        return true;
      case KEY.PAUSE:
        this.video.pause();
        return true;
      case KEY.PLAY_PAUSE:
      case KEY.SPACE:
        this.togglePlay();
        return true;
      case KEY.STOP:
        this.router.back();
        return true;
      case KEY.FAST_FORWARD:
        this.nudge(1);
        return true;
      case KEY.REWIND:
        this.nudge(-1);
        return true;
      case KEY.CHANNEL_UP:
        this.jumpMarker(1);
        return true;
      case KEY.CHANNEL_DOWN:
        this.jumpMarker(-1);
        return true;
      default:
        break;
    }
    if (isBack(e)) return false; // handled by onBack

    if (!this.controlsVisible()) {
      if (k === KEY.LEFT) this.nudge(-1);
      else if (k === KEY.RIGHT) this.nudge(1);
      else if (k === KEY.ENTER) {
        this.togglePlay();
        this.showControls();
      } else if (k === KEY.UP || k === KEY.DOWN) this.showControls();
      return true;
    }

    // Controls visible: any key keeps them up a little longer.
    this.scheduleHide();
    if (getFocused() === this.progress && (k === KEY.LEFT || k === KEY.RIGHT)) {
      this.nudge(k === KEY.RIGHT ? 1 : -1);
      return true;
    }
    return false; // normal navigation between buttons
  }

  onBack() {
    if (this.seekTarget !== null) {
      // Cancel a pending seek.
      clearTimeout(this.seekTimer);
      this.seekTarget = null;
      this.el.classList.remove('seeking');
      this.drawTime(this.position());
      return true;
    }
    if (this.controlsVisible() && !this.video.paused) {
      this.hideControls();
      return true;
    }
    return false;
  }
}

/** Shifts every timestamp in a VTT document by `delta` seconds. */
function shiftVtt(text, delta) {
  const fmt = (s) => {
    const t = Math.max(0, s);
    const hh = Math.floor(t / 3600);
    const mm = Math.floor((t % 3600) / 60);
    const ss = (t % 60).toFixed(3).padStart(6, '0');
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${ss}`;
  };
  return text.replace(/(?:(\d+):)?(\d{2}):(\d{2}\.\d{3})/g, (m, hh, mm, ss) => fmt((+(hh || 0)) * 3600 + (+mm) * 60 + (+ss) + delta));
}
