/**
 * Stash server settings that make sense from a TV remote, opened from
 * Settings → Stash server:
 * - library folders: add (browsing the server's folders), remove, and
 *   whether each holds videos, images or both
 * - transcoding: maximum sizes and hardware acceleration
 * - parallel tasks
 * - plugins: turn on or off, change their settings, run their tasks,
 *   install or update packages
 * - security: username and password, a new API key
 * - more: paths and files, previews and sprites, the web interface, DLNA,
 *   scraping, logs (settings and recent lines) and the database (backup,
 *   optimise), most of them built from Stash's schema (configPanel.js)
 *
 * Everything is saved in Stash straight away; its web UI shows the same
 * settings.
 */
import {
  chooseOption, confirmDialog, promptText, toast,
} from './overlay.js';
import { openLinesPanel } from './panel.js';
import { openScrapers } from './libraryPanels.js';
import { browseServerFolder, openConfigPanel } from './configPanel.js';
import * as tasks from '../api/tasks.js';
import { getSettings } from '../settings.js';
import { connectTo, connectWithPassword } from '../session.js';

/** Stash's StreamingResolutionEnum, smallest first. */
const SIZES = [
  ['LOW', '240p'], ['STANDARD', '480p'], ['STANDARD_HD', '720p'], ['FULL_HD', '1080p'], ['FOUR_K', '4K'], ['ORIGINAL', 'Original'],
];
const sizeLabel = (v) => (SIZES.find((x) => x[0] === v) || [v, v || 'Original'])[1];

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
        const path = await browseServerFolder(stashes.length ? stashes[0].path : undefined);
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
          options: [{ label: p.enabled ? 'Turn off' : 'Turn on', value: '__toggle' }, { label: 'Settings…', value: '__settings' }]
            .concat(p.enabled ? (p.tasks || []).map((t) => ({ label: `Run: ${t.name}`, hint: t.description || '', value: t.name })) : []),
        });
        if (!choice) return;
        if (choice === '__settings') {
          openPluginSettings(p);
          return;
        }
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

/** A plugin's own settings (yes/no, numbers and text). */
async function openPluginSettings(plugin) {
  let data;
  try {
    data = await tasks.pluginSettings(plugin.id);
  } catch (err) {
    toast(`Couldn't read the settings: ${err.message}`, 'error');
    return;
  }
  if (!data.settings.length) {
    toast(`${plugin.name} has no settings.`);
    return;
  }
  const values = Object.assign({}, data.values);
  let panel = null;
  const save = async (name, v) => {
    const next = Object.assign({}, values, { [name]: v });
    try {
      await tasks.savePluginSettings(plugin.id, next);
      values[name] = v;
      toast('Saved');
    } catch (err) {
      toast(`Couldn't save: ${err.message}`, 'error');
    }
    panel.render();
  };
  panel = openLinesPanel({
    title: plugin.name,
    subtitle: 'Plugin settings.',
    lines: () => data.settings.map((st) => {
      const v = values[st.name];
      return {
        key: st.name,
        label: st.display_name || st.name,
        value: st.type === 'BOOLEAN' ? (v ? 'On' : 'Off') : (v === undefined || v === null || v === '' ? '—' : String(v)),
        run: async () => {
          if (st.type === 'BOOLEAN') {
            await save(st.name, !v);
            return;
          }
          const t = await promptText({
            title: st.display_name || st.name, value: v === undefined || v === null ? '' : String(v), placeholder: st.description || '',
          });
          if (t === undefined) return;
          if (st.type === 'NUMBER') {
            const n = Number(t.trim());
            if (t.trim() === '' || Number.isNaN(n)) {
              toast('Enter a number.', 'error');
              return;
            }
            await save(st.name, n);
          } else {
            await save(st.name, t);
          }
        },
      };
    }),
  });
}

/**
 * Security: Stash's username and password, and a new API key. The app
 * keeps working afterwards because it connects with the API key, which it
 * fetches again when needed.
 */
async function openSecurity() {
  let info;
  try {
    info = await tasks.securityInfo();
  } catch (err) {
    toast(`Couldn't read the settings: ${err.message}`, 'error');
    return;
  }
  const url = getSettings().serverUrl;
  let panel = null;

  /** After the credentials change, make sure the app still has a working API key. */
  const reconnect = async (username, password) => {
    if (getSettings().apiKey) {
      try {
        await connectTo(url, getSettings().apiKey);
        return true;
      } catch (e) { /* the key no longer works: sign in below */ }
    }
    if (!username) return true;
    try {
      await connectWithPassword(url, username, password);
      return true;
    } catch (err) {
      toast(`Saved, but this TV couldn't sign in again: ${err.message}. Sign in from the connection screen.`, 'error');
      return false;
    }
  };

  panel = openLinesPanel({
    title: 'Security',
    subtitle: info.username ? `Stash asks for a password (user “${info.username}”).` : 'Stash has no password.',
    lines: () => [
      {
        key: 'set',
        label: info.username ? 'Change username and password…' : 'Set a username and password…',
        run: async () => {
          const username = await promptText({ title: 'Username', value: info.username || '', confirm: 'Next' });
          if (!username || !username.trim()) return;
          const password = await promptText({ title: 'New password', type: 'password', confirm: 'Next' });
          if (!password) return;
          const again = await promptText({ title: 'The same password again', type: 'password', confirm: 'Save' });
          if (again !== password) {
            if (again !== undefined) toast('The passwords don’t match.', 'error');
            return;
          }
          try {
            await tasks.setCredentials(username.trim(), password);
          } catch (err) {
            toast(`Couldn't save: ${err.message}`, 'error');
            return;
          }
          info.username = username.trim();
          if (await reconnect(info.username, password)) toast('Username and password saved');
          panel.setSubtitle(`Stash asks for a password (user “${info.username}”).`);
          panel.render();
        },
      },
    ].concat(info.username ? [
      {
        key: 'remove',
        label: 'Remove the password…',
        danger: true,
        run: async () => {
          const ok = await confirmDialog({
            title: 'Remove the password?',
            message: 'Anyone on your network can then open Stash without signing in.',
            confirm: 'Remove',
            safe: true,
          });
          if (!ok) return;
          try {
            await tasks.setCredentials('', '');
          } catch (err) {
            toast(`Couldn't save: ${err.message}`, 'error');
            return;
          }
          info.username = '';
          toast('Password removed');
          panel.setSubtitle('Stash has no password.');
          panel.render();
        },
      },
      {
        key: 'key',
        label: 'Make a new API key…',
        run: async () => {
          const ok = await confirmDialog({
            title: 'Make a new API key?',
            message: 'The old key stops working. This TV switches to the new one; other apps need it typed in again.',
            confirm: 'Make a new key',
            safe: true,
          });
          if (!ok) return;
          try {
            const key = await tasks.newApiKey();
            await connectTo(url, key);
            toast('New API key in use');
          } catch (err) {
            toast(`Couldn't make a new key: ${err.message}`, 'error');
          }
        },
      },
    ] : []),
  });
}

/** Recent log lines; choosing one shows it in full. */
async function openLogs() {
  let lines;
  try {
    lines = await tasks.logs();
  } catch (err) {
    toast(`Couldn't read the log: ${err.message}`, 'error');
    return;
  }
  const time = (t) => {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8);
  };
  openLinesPanel({
    title: 'Log',
    subtitle: lines.length ? 'Newest first. Choose a line to read it in full.' : 'The log is empty.',
    lines: () => lines.slice(0, 200).map((l, i) => ({
      key: `l:${i}`,
      label: l.message,
      value: `${l.level.toLowerCase()} ${time(l.time)}`,
      danger: l.level === 'Error',
      run: () => confirmDialog({
        title: `${l.level} at ${time(l.time)}`, message: l.message, confirm: 'Close', cancel: 'Back',
      }),
    })),
  });
}

/** DLNA: settings, and starting or stopping the server now. */
async function openDlna() {
  let status = null;
  try {
    status = await tasks.dlnaStatus();
  } catch (e) { /* older servers: settings only */ }
  const subtitle = () => (status ? (status.running ? 'The DLNA server is running.' : 'The DLNA server is stopped.') : '');
  let panel = null;
  panel = openLinesPanel({
    title: 'DLNA',
    subtitle: subtitle(),
    lines: () => [
      {
        key: 'settings',
        label: 'DLNA settings…',
        run: () => openConfigPanel({
          section: 'dlna',
          title: 'DLNA settings',
          labels: {
            serverName: 'Server name', enabled: 'Start with Stash', whitelistedIPs: 'Allowed IP addresses', videoSortOrder: 'Video sort order',
          },
        }),
      },
    ].concat(status ? [{
      key: 'run',
      label: status.running ? 'Stop the DLNA server now' : 'Start the DLNA server now',
      run: async () => {
        try {
          await tasks.setDlnaRunning(!status.running);
          status.running = !status.running;
          toast(status.running ? 'DLNA started' : 'DLNA stopped');
        } catch (err) {
          toast(`Couldn't change DLNA: ${err.message}`, 'error');
        }
        panel.setSubtitle(subtitle());
        panel.render();
      },
    }] : []),
  });
}

/** Database: backup and optimise. */
function openDatabase(onJob) {
  openLinesPanel({
    title: 'Database',
    subtitle: 'Backups go to the backup folder set in Paths and files.',
    lines: () => [
      {
        key: 'backup',
        label: 'Back up the database',
        run: async () => {
          try {
            toast('Backing up…');
            const msg = await tasks.backupDatabase();
            toast(msg ? `Backup saved: ${msg}` : 'Backup saved');
          } catch (err) {
            toast(`Couldn't back up: ${err.message}`, 'error');
          }
        },
      },
      {
        key: 'optimise',
        label: 'Optimise the database',
        run: async () => {
          const ok = await confirmDialog({
            title: 'Optimise the database?', message: 'Stash may be slow while it runs.', confirm: 'Optimise',
          });
          if (!ok) return;
          try {
            await tasks.optimiseDatabase();
            toast('Optimising');
            if (onJob) onJob();
          } catch (err) {
            toast(`Couldn't start: ${err.message}`, 'error');
          }
        },
      },
    ],
  });
}

/** The rest of Stash's settings, grouped as in its web UI. */
function openMoreSettings(onJob) {
  openLinesPanel({
    title: 'More server settings',
    subtitle: 'Changes to paths take effect after Stash restarts.',
    lines: () => [
      {
        key: 'paths',
        label: 'Paths and files',
        run: () => openConfigPanel({
          section: 'general',
          title: 'Paths and files',
          fields: ['generatedPath', 'metadataPath', 'cachePath', 'databasePath', 'backupDirectoryPath', 'deleteTrashPath',
            'blobsPath', 'blobsStorage', 'scrapersPath', 'pluginsPath', 'ffmpegPath', 'ffprobePath', 'pythonPath',
            'customPerformerImageLocation', 'calculateMD5', 'videoFileNamingAlgorithm', 'videoExtensions', 'imageExtensions',
            'galleryExtensions', 'excludes', 'imageExcludes', 'createGalleriesFromFolders', 'galleryCoverRegex',
            'writeImageThumbnails', 'createImageClipsFromVideos'],
          labels: {
            calculateMD5: 'Calculate MD5 checksums', videoFileNamingAlgorithm: 'File naming hash', excludes: 'Excluded video paths (patterns)',
            imageExcludes: 'Excluded image paths (patterns)', createGalleriesFromFolders: 'Galleries from folders', deleteTrashPath: 'Trash folder',
          },
        }),
      },
      {
        key: 'previews',
        label: 'Previews and sprites',
        run: () => openConfigPanel({
          section: 'general',
          title: 'Previews and sprites',
          fields: ['previewAudio', 'previewSegments', 'previewSegmentDuration', 'previewExcludeStart', 'previewExcludeEnd', 'previewPreset',
            'useCustomSpriteInterval', 'spriteInterval', 'minimumSprites', 'maximumSprites', 'spriteScreenshotSize',
            'transcodeInputArgs', 'transcodeOutputArgs', 'liveTranscodeInputArgs', 'liveTranscodeOutputArgs', 'drawFunscriptHeatmapRange'],
        }),
      },
      {
        key: 'interface',
        label: 'Web interface',
        run: () => openConfigPanel({ section: 'interface', title: 'Web interface', subtitle: 'Options of Stash’s own web UI.' }),
      },
      { key: 'dlna', label: 'DLNA', run: () => openDlna() },
      { key: 'scraping', label: 'Scraping', run: () => openConfigPanel({ section: 'scraping', title: 'Scraping' }) },
      {
        key: 'logsettings',
        label: 'Log settings',
        run: () => openConfigPanel({
          section: 'general', title: 'Log settings', fields: ['logLevel', 'logFile', 'logOut', 'logAccess', 'logFileMaxSize'],
        }),
      },
      { key: 'log', label: 'Show the log', run: () => openLogs() },
      { key: 'db', label: 'Database', run: () => openDatabase(onJob) },
      {
        key: 'sessions',
        label: 'Session length',
        run: () => openConfigPanel({ section: 'general', title: 'Session length', fields: ['maxSessionAge'], labels: { maxSessionAge: 'Sign-in lasts (seconds)' } }),
      },
    ],
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
    line('Plugins', 'Turn plugins on or off, change their settings, run their tasks.', () => openPlugins(onJob)),
    line('Security', 'Username and password, API key.', () => openSecurity()),
    line('More server settings', 'Paths, previews, web interface, DLNA, scraping, logs, database.', () => openMoreSettings(onJob)),
  ];
}
