/**
 * Stash server settings that make sense from a TV remote, opened from
 * Settings → Stash server:
 * - library folders: add (browsing the server's folders), remove, and
 *   whether each holds videos, images or both
 * - transcoding: maximum sizes and hardware acceleration
 * - parallel tasks
 * - plugins: turn on or off, run their tasks, install or update packages
 *
 * Everything is saved in Stash straight away; its web UI shows the same
 * settings.
 */
import { chooseOption, confirmDialog, toast } from './overlay.js';
import { openLinesPanel } from './panel.js';
import { openScrapers } from './libraryPanels.js';
import * as tasks from '../api/tasks.js';

/** Stash's StreamingResolutionEnum, smallest first. */
const SIZES = [
  ['LOW', '240p'], ['STANDARD', '480p'], ['STANDARD_HD', '720p'], ['FULL_HD', '1080p'], ['FOUR_K', '4K'], ['ORIGINAL', 'Original'],
];
const sizeLabel = (v) => (SIZES.find((x) => x[0] === v) || [v, v || 'Original'])[1];

/**
 * Browses the server's folders and resolves with the chosen path.
 * @param {string} [start]  folder to start in (default: the server's own start)
 * @returns {Promise<string|undefined>}
 */
async function browseFolder(start) {
  let path = start;
  for (;;) {
    let dir;
    try {
      dir = await tasks.serverDirectory(path); // eslint-disable-line no-await-in-loop
    } catch (err) {
      toast(`Couldn't open the folder: ${err.message}`, 'error');
      return undefined;
    }
    const name = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
    const choice = await chooseOption({ // eslint-disable-line no-await-in-loop
      title: dir.path || 'Folders',
      options: [{ label: 'Use this folder', value: { use: dir.path } }]
        .concat(dir.parent ? [{ label: '.. (up one level)', value: { go: dir.parent } }] : [])
        .concat((dir.directories || []).map((d) => ({ label: name(d), value: { go: d } }))),
    });
    if (!choice) return undefined;
    if (choice.use) return choice.use;
    path = choice.go;
  }
}

/** Library folders. */
async function openLibraryFolders(onJob) {
  let settings;
  try {
    settings = await tasks.generalSettings();
  } catch (err) {
    toast(`Couldn't read the settings: ${err.message}`, 'error');
    return;
  }
  let stashes = settings.stashes || [];
  let panel = null;
  const save = async (next, message) => {
    try {
      await tasks.saveGeneral({ stashes: next });
      stashes = next;
      toast(message);
    } catch (err) {
      toast(`Couldn't save: ${err.message}`, 'error');
    }
    panel.render();
  };
  const what = (s) => (s.excludeVideo && s.excludeImage ? 'Nothing'
    : s.excludeVideo ? 'Images' : s.excludeImage ? 'Videos' : 'Videos and images');
  panel = openLinesPanel({
    title: 'Library folders',
    subtitle: 'Where Stash looks for files when scanning.',
    lines: () => stashes.map((s, i) => ({
      key: `f:${s.path}`,
      // The folder's name; its full path is the menu title when chosen.
      label: s.path.split(/[\\/]/).filter(Boolean).pop() || s.path,
      value: what(s),
      run: async () => {
        const choice = await chooseOption({
          title: s.path,
          options: [
            { label: 'Videos and images', value: 'both' },
            { label: 'Videos only', value: 'video' },
            { label: 'Images only', value: 'image' },
            { label: 'Remove this folder…', value: 'remove' },
          ],
        });
        if (!choice) return;
        if (choice === 'remove') {
          const ok = await confirmDialog({
            title: `Remove ${s.path}?`,
            message: 'Stash stops scanning it. Its files stay on disk; Clean removes them from Stash.',
            confirm: 'Remove',
            safe: true,
          });
          if (ok) await save(stashes.filter((_, n) => n !== i), 'Folder removed');
          return;
        }
        const next = stashes.slice();
        next[i] = { path: s.path, excludeVideo: choice === 'image', excludeImage: choice === 'video' };
        await save(next, 'Saved');
      },
    })).concat([{
      key: 'add',
      label: 'Add a folder…',
      run: async () => {
        const path = await browseFolder(stashes.length ? stashes[0].path : undefined);
        if (!path) return;
        if (stashes.some((s) => s.path === path)) {
          toast('That folder is already in the library.');
          return;
        }
        await save(stashes.concat([{ path, excludeVideo: false, excludeImage: false }]), `Added ${path}`);
        const scan = await confirmDialog({ title: 'Scan now?', message: 'Scan the library to find the new files.', confirm: 'Scan' });
        if (scan) {
          try {
            await tasks.startTask('scan');
            toast('Scan started');
            if (onJob) onJob();
          } catch (err) {
            toast(`Couldn't start: ${err.message}`, 'error');
          }
        }
      },
    }]),
  });
}

/** Transcoding sizes, hardware acceleration and parallel tasks. */
async function openSystem() {
  let g;
  try {
    g = await tasks.generalSettings();
  } catch (err) {
    toast(`Couldn't read the settings: ${err.message}`, 'error');
    return;
  }
  let panel = null;
  const save = async (patch) => {
    try {
      await tasks.saveGeneral(patch);
      Object.assign(g, patch);
      toast('Saved');
    } catch (err) {
      toast(`Couldn't save: ${err.message}`, 'error');
    }
    panel.render();
  };
  const sizeLine = (key, label) => ({
    key,
    label,
    value: sizeLabel(g[key]),
    run: async () => {
      const v = await chooseOption({ title: label, options: SIZES.map(([value, l]) => ({ label: l, value })), selected: g[key] || 'ORIGINAL' });
      if (v && v !== g[key]) await save({ [key]: v });
    },
  });
  panel = openLinesPanel({
    title: 'Transcoding and tasks',
    subtitle: 'Settings of the Stash server.',
    lines: () => [
      sizeLine('maxTranscodeSize', 'Largest generated transcode'),
      sizeLine('maxStreamingTranscodeSize', 'Largest live transcode'),
      {
        key: 'hw',
        label: 'Hardware acceleration',
        value: g.transcodeHardwareAcceleration ? 'On' : 'Off',
        run: () => save({ transcodeHardwareAcceleration: !g.transcodeHardwareAcceleration }),
      },
      {
        key: 'parallel',
        label: 'Parallel tasks',
        value: g.parallelTasks ? String(g.parallelTasks) : 'Automatic',
        run: async () => {
          const v = await chooseOption({
            title: 'Parallel tasks',
            options: [{ label: 'Automatic', value: 0 }].concat([1, 2, 4, 8].map((n) => ({ label: String(n), value: n }))),
            selected: g.parallelTasks || 0,
          });
          if (v !== undefined && v !== g.parallelTasks) await save({ parallelTasks: v });
        },
      },
    ],
  });
}

/** Plugins: on/off, their tasks, and plugin packages. */
async function openPlugins(onJob) {
  let list = [];
  let panel = null;
  const refresh = async () => {
    try {
      list = await tasks.plugins();
    } catch (err) {
      toast(`Couldn't list plugins: ${err.message}`, 'error');
    }
    if (panel) panel.render();
  };
  await refresh();
  panel = openLinesPanel({
    title: 'Plugins',
    subtitle: list.length ? 'Choose a plugin to turn it on or off, or run its tasks.' : 'No plugins are installed.',
    lines: () => list.map((p) => ({
      key: `p:${p.id}`,
      label: p.name,
      value: p.enabled ? 'On' : 'Off',
      run: async () => {
        const choice = await chooseOption({
          title: p.name,
          options: [{ label: p.enabled ? 'Turn off' : 'Turn on', value: '__toggle' }]
            .concat(p.enabled ? (p.tasks || []).map((t) => ({ label: `Run: ${t.name}`, hint: t.description || '', value: t.name })) : []),
        });
        if (!choice) return;
        try {
          if (choice === '__toggle') {
            await tasks.setPluginEnabled(p.id, !p.enabled);
            toast(p.enabled ? `${p.name} turned off` : `${p.name} turned on`);
            await refresh();
          } else {
            await tasks.runPluginTask(p.id, choice);
            toast(`${choice} started`);
            if (onJob) onJob();
          }
        } catch (err) {
          toast(`Couldn't do that: ${err.message}`, 'error');
        }
      },
    })).concat([{
      key: 'packages',
      label: 'Install or update plugins…',
      run: () => openScrapers(onJob, 'Plugin'),
    }]),
  });
}

/**
 * Settings lines for the Stash server section.
 * @param {(label: string, note: string, run: () => void) => HTMLElement} line  makes a settings line
 * @param {() => void} onJob  shows task progress after starting a job
 */
export function serverSettingsLines(line, onJob) {
  return [
    line('Library folders', 'Where Stash looks for videos and images.', () => openLibraryFolders(onJob)),
    line('Transcoding and tasks', 'Transcode sizes, hardware acceleration, parallel tasks.', () => openSystem()),
    line('Plugins', 'Turn plugins on or off, run their tasks, install more.', () => openPlugins(onJob)),
  ];
}
