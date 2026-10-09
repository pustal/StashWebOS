/**
 * Settings: image cache (with live usage), playback, server, library,
 * library tasks (with editing on) and about.
 */
import { Screen } from '../ui/router.js';
import { h } from '../util/dom.js';
import { chooseOption, confirmDialog, toast } from '../ui/overlay.js';
import {
  CACHE_BUDGETS_MB, PLAYBACK_MODES, THUMB_QUALITY, TRANSCODE_RESOLUTIONS, getSettings, updateSettings,
} from '../settings.js';
import {
  cacheStats, clearImageCache, setCacheBudget, setKeepAnimated,
} from '../cache/imageCache.js';
import { formatBytes } from '../util/format.js';
import { getServerInfo } from '../session.js';
import { canEdit } from '../ui/editor.js';
import {
  TASKS, jobQueue, startTask, stopAllJobs,
} from '../api/tasks.js';
import { openScrapers, openStashBoxes, openTaskOptions } from '../ui/libraryPanels.js';

/* global __APP_VERSION__ */

export class SettingsScreen extends Screen {
  /** @param {{onDisconnect: () => void}} opts */
  constructor(opts) {
    super();
    this.section = 'settings';
    this.opts = opts;
    this.el.classList.add('screen-settings');
    this.render();
  }

  onShow() {
    this.refreshUsage();
    this.pollJobs();
  }

  onHide() {
    clearTimeout(this.jobTimer);
    this.jobTimer = null;
  }

  // -------------------------------------------------------------------------
  // Library tasks
  // -------------------------------------------------------------------------

  /** Lines for Stash's library tasks (shown when editing is on). */
  taskLines() {
    if (!canEdit()) return [];
    this.jobsEl = h('span', { class: 'setting-value' }, '…');
    this.stopLine = this.line('Stop running tasks', () => '', async () => {
      try {
        await stopAllJobs();
        toast('Stopping tasks');
      } catch (err) {
        toast(`Couldn't stop: ${err.message}`, 'error');
      }
      this.pollJobs();
    });
    this.stopLine.style.display = 'none';
    const lines = [
      h('h2', { class: 'settings-heading' }, 'Library tasks'),
      h('div', { class: 'setting' }, [
        h('div', { class: 'setting-text' }, [h('span', { class: 'setting-label' }, 'Status')]),
        this.jobsEl,
      ]),
    ];
    for (const key of Object.keys(TASKS)) {
      const t = TASKS[key];
      lines.push(this.line(t.label, () => '', async () => {
        const ok = await confirmDialog({
          title: `${t.label}?`,
          message: `${t.note} Stash runs it in the background with the options saved in its Tasks page.`,
          confirm: 'Start',
          safe: !!t.danger,
        });
        if (!ok) return;
        try {
          await startTask(key);
          toast(`${t.label} started`);
        } catch (err) {
          toast(`Couldn't start: ${err.message}`, 'error');
        }
        this.pollJobs();
      }, t.note));
    }
    lines.push(this.stopLine);
    lines.push(this.line('Task options', () => '', () => openTaskOptions(), 'What Scan and Generate do, and the sources Identify uses.'));
    lines.push(this.line('Scrapers', () => '', () => openScrapers(() => this.pollJobs()), 'Install, update or remove scrapers.'));
    lines.push(this.line('Stash-box servers', () => '', () => openStashBoxes(), 'For scraping and Identify (e.g. StashDB).'));
    return lines;
  }

  /** Shows the job queue, refreshing every few seconds while tasks run. */
  async pollJobs() {
    clearTimeout(this.jobTimer);
    if (!this.jobsEl) return;
    let jobs = [];
    try {
      jobs = await jobQueue();
    } catch (err) {
      this.jobsEl.textContent = "Couldn't read the task queue";
      return;
    }
    const running = jobs.filter((j) => j.status === 'RUNNING' || j.status === 'READY' || j.status === 'STOPPING');
    if (!running.length) {
      this.jobsEl.textContent = 'Idle';
    } else {
      const j = running[0];
      const pct = j.progress !== null && j.progress !== undefined && j.progress >= 0 ? ` ${Math.round(j.progress * 100)}%` : '';
      this.jobsEl.textContent = `${j.description}${pct}${running.length > 1 ? ` (+${running.length - 1} queued)` : ''}`;
    }
    this.stopLine.style.display = running.length ? '' : 'none';
    if (running.length && this.isTop()) this.jobTimer = setTimeout(() => this.pollJobs(), 2000);
  }

  /** One settings line. `value` is a function so lines can refresh. */
  line(label, value, onSelect, note) {
    const valueEl = h('span', { class: 'setting-value' }, value());
    const el = h('div', { class: 'setting focusable', onSelect: () => onSelect(valueEl) }, [
      h('div', { class: 'setting-text' }, [
        h('span', { class: 'setting-label' }, label),
        note ? h('span', { class: 'setting-note' }, note) : null,
      ]),
      valueEl,
    ]);
    el.__refresh = () => {
      valueEl.textContent = value();
    };
    return el;
  }

  /** A line that opens a choice menu and saves the result. */
  choice(label, key, options, note, after) {
    const s = getSettings;
    const labelOf = (v) => {
      const o = options.find((x) => x.value === v);
      return o ? o.label : String(v);
    };
    const el = this.line(label, () => labelOf(s()[key]), async () => {
      const v = await chooseOption({ title: label, options, selected: s()[key] });
      if (v === undefined) return;
      updateSettings({ [key]: v });
      el.__refresh();
      if (after) after(v);
    }, note);
    return el;
  }

  render() {
    const s = getSettings();
    const info = getServerInfo();

    this.usageEl = h('span', { class: 'usage-text' });
    this.usageBar = h('div', { class: 'usage-fill' });

    const budgetOptions = CACHE_BUDGETS_MB.map((mb) => ({
      value: mb,
      label: mb === 0 ? "Don't store (RAM only)" : `${mb} MB`,
      hint: mb === 50 ? 'Recommended' : null,
    }));

    this.el.appendChild(h('h1', { class: 'page-title' }, 'Settings'));
    this.el.appendChild(h('div', { class: 'settings-columns' }, [
      h('div', { class: 'settings-col nav-group nav-zone' }, [
        h('h2', { class: 'settings-heading' }, 'Image cache'),
        h('div', { class: 'usage' }, [h('div', { class: 'usage-track' }, this.usageBar), this.usageEl]),
        this.choice('Storage limit', 'cacheBudgetMB', budgetOptions,
          'Thumbnails are shrunk before saving. The oldest are removed when the limit is reached.',
          (mb) => setCacheBudget(mb * 1024 * 1024).then(() => this.refreshUsage())),
        this.choice('Thumbnail sharpness', 'thumbQuality',
          Object.keys(THUMB_QUALITY).map((k) => ({ value: k, label: THUMB_QUALITY[k].label })),
          'Applies to new thumbnails.'),
        this.choice('Animated thumbnails', 'animatedThumbs', [
          { value: false, label: 'Still', hint: 'Recommended' },
          { value: true, label: 'Animated' },
        ], 'Animated tag and image thumbnails (GIFs) use far more storage. Still keeps the first frame.',
        (on) => setKeepAnimated(on)),
        this.choice('Tag images', 'showTagImages',
          [{ value: true, label: 'Show' }, { value: false, label: 'Names only' }],
          'Names only uses no storage for tags.'),
        this.choice('Empty tags', 'hideEmptyTags',
          [{ value: true, label: 'Hide' }, { value: false, label: 'Show' }]),
        this.line('Clear image cache', () => '', async () => {
          await clearImageCache();
          this.refreshUsage();
          toast('Image cache cleared');
        }),

        h('h2', { class: 'settings-heading' }, 'Playback'),
        this.choice('Video source', 'playbackMode',
          Object.keys(PLAYBACK_MODES).map((k) => ({ value: k, label: PLAYBACK_MODES[k] })),
          'If a file will not play, the player falls back to a transcode automatically.'),
        this.choice('Transcode quality', 'maxTranscode',
          Object.keys(TRANSCODE_RESOLUTIONS).map((k) => ({ value: k, label: TRANSCODE_RESOLUTIONS[k] }))),
        this.choice('Skip back', 'skipBack', [5, 10, 15, 30].map((n) => ({ value: n, label: `${n} seconds` }))),
        this.choice('Skip forward', 'skipForward', [10, 15, 30, 60].map((n) => ({ value: n, label: `${n} seconds` }))),
        this.choice('Seek thumbnails', 'seekPreview',
          [{ value: true, label: 'On' }, { value: false, label: 'Off' }],
          'Preview frames while seeking. Kept in memory only.'),
        this.choice('Slideshow speed', 'slideshowSeconds',
          [3, 5, 8, 12, 20].map((n) => ({ value: n, label: `${n} seconds per image` }))),
        this.choice('Save progress to Stash', 'trackActivity',
          [{ value: true, label: 'On' }, { value: false, label: 'Off' }],
          'Resume position and play count.'),
      ]),
      h('div', { class: 'settings-col nav-group nav-zone' }, [
        h('h2', { class: 'settings-heading' }, 'Server'),
        h('div', { class: 'server-card' }, [
          h('div', { class: 'server-url' }, s.serverUrl),
          h('div', { class: 'server-meta' }, [
            info ? h('span', null, `Stash ${info.version}`) : null,
            info ? h('span', null, `${info.sceneCount.toLocaleString()} scenes`) : null,
            h('span', null, s.apiKey ? 'API key set' : 'No API key'),
          ]),
        ]),
        this.line('Change server', () => '', async () => {
          const ok = await confirmDialog({
            title: 'Change server?',
            message: 'You will go back to the connection screen. The image cache is cleared when you connect to a different server.',
            confirm: 'Change server',
            safe: true,
          });
          if (ok) this.opts.onDisconnect();
        }),
        h('h2', { class: 'settings-heading' }, 'Library'),
        this.choice('Home screen', 'homeLayout', [
          { value: 'app', label: "This app's rows" },
          { value: 'stash', label: "Stash's front page" },
        ], 'Stash\'s front page uses the rows and saved filters set up in Stash (Settings, Interface).'),
        this.choice('Editing', 'allowEditing',
          [{ value: true, label: 'On' }, { value: false, label: 'Off (view only)' }],
          'Ratings, favourites, tags and other links, markers and saved filters.'),
      ].concat(this.taskLines(), [
        h('h2', { class: 'settings-heading' }, 'About'),
        h('p', { class: 'about-text' }, `Stash for webOS ${__APP_VERSION__}. An unofficial client for Stash.`),
      ])),
    ]));
    this.refreshUsage();
  }

  refreshUsage() {
    if (!this.usageEl) return;
    const st = cacheStats();
    const pct = st.budgetBytes ? Math.min(100, (st.storedBytes / st.budgetBytes) * 100) : 0;
    this.usageBar.style.width = `${pct}%`;
    this.usageEl.textContent = st.budgetBytes
      ? `${formatBytes(st.storedBytes)} of ${formatBytes(st.budgetBytes)} used`
      : `Not storing thumbnails. ${formatBytes(st.memoryBytes)} in memory.`;
    if (!st.persistent && st.budgetBytes) this.usageEl.textContent += ' (storage unavailable, using memory)';
  }
}
