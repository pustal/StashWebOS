/**
 * Getting a Stash server ready from the TV:
 * - first-time setup of a new Stash (where its settings file, library
 *   folders, database and generated files go), like the web UI's setup
 *   wizard
 * - upgrading ("migrating") a database from an older Stash version
 *
 * Both are offered by the connection screen when the server reports it
 * needs them (see session.connectTo).
 */
import {
  chooseOption, confirmDialog, promptText, toast,
} from './overlay.js';
import { openLinesPanel } from './panel.js';
import { browseServerFolder } from './configPanel.js';
import * as api from '../api/stash.js';
import { startTask } from '../api/tasks.js';

/** Waits until the server reports `wanted` (or gives up after ~2 minutes). */
async function waitForStatus(wanted) {
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 2000)); // eslint-disable-line no-await-in-loop
    try {
      const s = await api.systemStatus(); // eslint-disable-line no-await-in-loop
      if (s.status === wanted) return true;
    } catch (e) { /* restarting: try again */ }
  }
  return false;
}

/** Joins a folder and a name with the server's separator. */
function join(dir, name, os) {
  const sep = os === 'windows' ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

/**
 * The setup wizard as one panel: each line is a choice with a sensible
 * default, and the last line sets Stash up.
 * @param {Object} status  systemStatus of the server
 * @returns {Promise<boolean>} true when Stash was set up
 */
export function runSetupWizard(status) {
  return new Promise((resolve) => {
    const os = status.os;
    const choices = {
      configLocation: join(status.workingDir, 'config.yml', os),
      stashes: [],
      databaseFile: '',
      generatedLocation: '',
      cacheLocation: '',
      storeBlobsInDatabase: false,
      blobsLocation: '',
    };
    let panel = null;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    const orDefault = (v, what) => v || `Default (${what} next to the settings file)`;

    const pickPath = async (key, title) => {
      const how = await chooseOption({
        title,
        options: [
          { label: 'Default (next to the settings file)', value: 'default' },
          { label: 'Choose a folder on the server…', value: 'browse' },
        ],
      });
      if (!how) return;
      if (how === 'default') choices[key] = '';
      else {
        const p = await browseServerFolder(status.workingDir);
        if (!p) return;
        choices[key] = key === 'databaseFile' ? join(p, 'stash-go.sqlite', os) : p;
      }
      panel.render();
    };

    panel = openLinesPanel({
      title: 'Set up Stash',
      subtitle: 'This Stash server is new. These choices can be changed later in Stash.',
      onDismiss: () => finish(false),
      lines: () => [
        {
          key: 'config',
          label: 'Settings file',
          value: choices.configLocation,
          run: async () => {
            const v = await chooseOption({
              title: 'Where Stash keeps its settings',
              options: [
                { label: `With the program (${join(status.workingDir, 'config.yml', os)})`, value: join(status.workingDir, 'config.yml', os) },
                { label: `In the home folder (${join(join(status.homeDir, '.stash', os), 'config.yml', os)})`, value: join(join(status.homeDir, '.stash', os), 'config.yml', os) },
              ],
              selected: choices.configLocation,
            });
            if (v) choices.configLocation = v;
            panel.render();
          },
        },
        {
          key: 'stashes',
          label: 'Library folders',
          value: choices.stashes.length ? choices.stashes.map((s) => s.path.split(/[\\/]/).pop()).join(', ') : 'None yet',
          run: async () => {
            const choice = await chooseOption({
              title: 'Library folders',
              options: [{ label: 'Add a folder…', value: '__add' }].concat(choices.stashes.map((s, i) => ({ label: s.path, hint: 'Remove', value: i }))),
            });
            if (choice === undefined) return;
            if (choice === '__add') {
              const p = await browseServerFolder(status.workingDir);
              if (p && !choices.stashes.some((s) => s.path === p)) choices.stashes.push({ path: p, excludeVideo: false, excludeImage: false });
            } else {
              choices.stashes.splice(choice, 1);
            }
            panel.render();
          },
        },
        { key: 'db', label: 'Database', value: orDefault(choices.databaseFile, 'stash-go.sqlite'), run: () => pickPath('databaseFile', 'Database file') },
        { key: 'generated', label: 'Generated files', value: orDefault(choices.generatedLocation, 'generated'), run: () => pickPath('generatedLocation', 'Generated files (previews, sprites…)') },
        { key: 'cache', label: 'Cache', value: orDefault(choices.cacheLocation, 'cache'), run: () => pickPath('cacheLocation', 'Cache folder') },
        {
          key: 'blobs',
          label: 'Covers and images',
          value: choices.storeBlobsInDatabase ? 'In the database' : orDefault(choices.blobsLocation, 'blobs'),
          run: async () => {
            const v = await chooseOption({
              title: 'Where covers and images are stored',
              options: [
                { label: 'In a folder (recommended)', value: 'folder' },
                { label: 'In the database', value: 'db' },
              ],
            });
            if (!v) return;
            choices.storeBlobsInDatabase = v === 'db';
            if (v === 'folder') await pickPath('blobsLocation', 'Folder for covers and images');
            panel.render();
          },
        },
        {
          key: 'go',
          label: 'Set up Stash',
          run: async () => {
            if (!choices.stashes.length) {
              const ok = await confirmDialog({
                title: 'No library folders?',
                message: 'Stash will have nothing to scan until you add a folder (Settings → Stash server → Library folders).',
                confirm: 'Set up anyway',
                safe: true,
              });
              if (!ok) return;
            }
            try {
              toast('Setting up Stash…');
              await api.setupServer(choices);
            } catch (err) {
              toast(`Setup failed: ${err.message}`, 'error');
              return;
            }
            const ready = await waitForStatus('OK');
            panel.close();
            if (!ready) {
              toast('Stash is still starting. Try connecting again in a moment.', 'error');
              finish(false);
              return;
            }
            toast('Stash is set up');
            // With library folders, the next step is always a scan.
            if (choices.stashes.length) {
              const scan = await confirmDialog({
                title: 'Scan the library now?', message: 'Stash finds the videos and images in your library folders.', confirm: 'Scan',
              });
              if (scan) {
                try {
                  await startTask('scan');
                  toast('Scan started. Progress is in Settings → Library tasks.');
                } catch (err) {
                  toast(`Couldn't start the scan: ${err.message}`, 'error');
                }
              }
            }
            finish(true);
          },
        },
      ],
    });
  });
}

/**
 * Offers to upgrade an older database, backing it up first.
 * @param {Object} status  systemStatus of the server
 * @returns {Promise<boolean>} true when the database was upgraded
 */
export async function runMigration(status) {
  const ok = await confirmDialog({
    title: 'Upgrade the database?',
    message: `This Stash version needs its database upgraded (schema ${status.databaseSchema} → ${status.appSchema}). A backup is made first.`,
    confirm: 'Upgrade',
    safe: true,
  });
  if (!ok) return false;
  // An empty backup path lets Stash pick its default (next to the database).
  const backup = await promptText({
    title: 'Back up to', value: status.databasePath ? `${status.databasePath}.${status.databaseSchema}.bak` : '', placeholder: 'Leave as is for the default', confirm: 'Upgrade',
  });
  if (backup === undefined) return false;
  try {
    toast('Upgrading the database…');
    await api.migrateDatabase(backup.trim());
  } catch (err) {
    toast(`Upgrade failed: ${err.message}`, 'error');
    return false;
  }
  const ready = await waitForStatus('OK');
  toast(ready ? 'Database upgraded' : 'Still upgrading. Try connecting again in a moment.', ready ? undefined : 'error');
  return ready;
}
