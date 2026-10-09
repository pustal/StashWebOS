/**
 * Settings panels for Stash's library setup, opened from Settings → Library
 * tasks:
 * - task options: what Scan and Generate do, and the Identify sources
 *   (saved in Stash, shared with its web UI's Tasks page)
 * - scrapers: install, update and uninstall scraper packages
 * - stash-box servers: add and remove
 */
import {
  chooseOption, confirmDialog, pickBySearch, promptText, toast,
} from './overlay.js';
import { openLinesPanel } from './panel.js';
import * as tasks from '../api/tasks.js';
import { getClient } from '../api/stash.js';

/** Friendlier names for task options; others are spelled out from the field name. */
const OPTION_LABELS = {
  rescan: 'Rescan unchanged files',
  scanGenerateCovers: 'Covers',
  scanGeneratePreviews: 'Video previews',
  scanGenerateImagePreviews: 'Animated image previews',
  scanGenerateSprites: 'Seek sprites',
  scanGeneratePhashes: 'Perceptual hashes',
  scanGenerateImagePhashes: 'Image perceptual hashes',
  scanGenerateThumbnails: 'Image thumbnails',
  scanGenerateClipPreviews: 'Image clip previews',
  covers: 'Covers',
  sprites: 'Seek sprites',
  previews: 'Video previews',
  imagePreviews: 'Animated image previews',
  markers: 'Marker previews',
  markerImagePreviews: 'Marker animated previews',
  markerScreenshots: 'Marker screenshots',
  transcodes: 'Transcodes',
  forceTranscodes: 'Force transcodes',
  phashes: 'Perceptual hashes',
  interactiveHeatmapsSpeeds: 'Interactive heatmaps',
  imagePhashes: 'Image perceptual hashes',
  imageThumbnails: 'Image thumbnails',
  clipPreviews: 'Image clip previews',
  overwrite: 'Overwrite existing files',
};

/** "scanGenerateCovers" → "Scan generate covers". */
function labelFor(key) {
  if (OPTION_LABELS[key]) return OPTION_LABELS[key];
  const words = key.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * On/off options of one task (Scan or Generate), saved as they change.
 * @param {'scan'|'generate'} key
 * @param {string} title
 * @param {Object} current  the saved defaults for that task (changed in place)
 */
async function openBooleans(key, title, current) {
  const typeName = key === 'scan' ? 'ScanMetadataInput' : 'GenerateMetadataInput';
  let keys;
  try {
    keys = await tasks.booleanOptions(typeName);
  } catch (err) {
    toast(`Couldn't read the options: ${err.message}`, 'error');
    return;
  }
  const value = current; // updated in place, so reopening shows the saved state
  let panel = null;
  panel = openLinesPanel({
    title,
    subtitle: 'Saved in Stash; its Tasks page uses them too.',
    lines: () => keys.map((k) => ({
      key: k,
      label: labelFor(k),
      value: value[k] ? 'On' : 'Off',
      run: async () => {
        value[k] = !value[k];
        try {
          await tasks.saveTaskDefaults(key, value);
        } catch (err) {
          value[k] = !value[k];
          toast(`Couldn't save: ${err.message}`, 'error');
        }
        panel.render();
      },
    })),
  });
}

/** Identify's sources (in priority order): add, remove, move up. */
async function openIdentifySources(current) {
  const id = current; // changed in place, like openBooleans
  id.sources = id.sources || [];
  const names = {};
  const choices = [];
  try {
    const data = await getClient().query(`{
      listScrapers(types: [SCENE]) { id name scene { supported_scrapes } }
      configuration { general { stashBoxes { endpoint name } } }
    }`);
    for (const sb of data.configuration.general.stashBoxes || []) {
      names[`sb:${sb.endpoint}`] = sb.name || sb.endpoint;
      choices.push({ key: `sb:${sb.endpoint}`, source: { stash_box_endpoint: sb.endpoint } });
    }
    for (const s of data.listScrapers || []) {
      names[`s:${s.id}`] = s.name;
      if ((s.scene.supported_scrapes || []).indexOf('FRAGMENT') >= 0) choices.push({ key: `s:${s.id}`, source: { scraper_id: s.id } });
    }
  } catch (err) {
    toast(`Couldn't list scrapers: ${err.message}`, 'error');
    return;
  }
  const keyOf = (src) => (src.stash_box_endpoint ? `sb:${src.stash_box_endpoint}` : `s:${src.scraper_id}`);
  const save = async () => {
    try {
      await tasks.saveTaskDefaults('identify', id);
    } catch (err) {
      toast(`Couldn't save: ${err.message}`, 'error');
    }
  };
  let panel = null;
  panel = openLinesPanel({
    title: 'Identify sources',
    subtitle: 'Tried in this order for each scene.',
    lines: () => id.sources.map((s, i) => ({
      key: keyOf(s.source),
      label: `${i + 1}. ${names[keyOf(s.source)] || keyOf(s.source)}`,
      value: 'Change',
      run: async () => {
        const action = await chooseOption({
          title: names[keyOf(s.source)] || 'Source',
          options: (i > 0 ? [{ label: 'Move up', value: 'up' }] : []).concat([{ label: 'Remove', value: 'remove' }]),
        });
        if (!action) return;
        if (action === 'up') id.sources.splice(i - 1, 0, id.sources.splice(i, 1)[0]);
        else id.sources.splice(i, 1);
        await save();
        panel.render();
      },
    })).concat([{
      key: 'add',
      label: 'Add a source…',
      run: async () => {
        const have = id.sources.map((s) => keyOf(s.source));
        const left = choices.filter((c) => have.indexOf(c.key) < 0);
        if (!left.length) {
          toast('No more scrapers or stash-box servers to add.');
          return;
        }
        const pick = await chooseOption({ title: 'Add a source', options: left.map((c) => ({ label: names[c.key], value: c.key })) });
        if (!pick) return;
        id.sources.push({ source: left.find((c) => c.key === pick).source });
        await save();
        panel.render();
      },
    }]),
  });
}

/** Task options: Scan, Generate, Identify sources. */
export async function openTaskOptions() {
  let d;
  try {
    d = await tasks.getTaskDefaults();
  } catch (err) {
    toast(`Couldn't read the task options: ${err.message}`, 'error');
    return;
  }
  openLinesPanel({
    title: 'Task options',
    subtitle: 'The options Stash uses for its tasks.',
    lines: () => [
      { key: 'scan', label: 'Scan', value: 'Options', run: () => openBooleans('scan', 'Scan options', d.scan || (d.scan = {})) },
      {
        key: 'generate',
        label: 'Generate',
        value: 'Options',
        run: () => openBooleans('generate', 'Generate options', d.generate || (d.generate = { covers: true, sprites: true, previews: true })),
      },
      {
        key: 'identify',
        label: 'Identify sources',
        value: String((d.identify && d.identify.sources || []).length),
        run: () => openIdentifySources(d.identify || (d.identify = { sources: [] })),
      },
    ],
  });
}

/** Scrapers: installed packages, install, update, uninstall, reload. */
export async function openScrapers(onJob) {
  let installed = [];
  let panel = null;
  const refresh = async () => {
    try {
      installed = await tasks.installedScrapers();
    } catch (err) {
      toast(`Couldn't list scrapers: ${err.message}`, 'error');
    }
    if (panel) panel.render();
  };
  await refresh();
  const run = async (action, packages, message) => {
    try {
      await tasks.changeScrapers(action, packages);
      toast(message);
      if (onJob) onJob();
    } catch (err) {
      toast(`Couldn't ${action}: ${err.message}`, 'error');
    }
  };
  panel = openLinesPanel({
    title: 'Scrapers',
    subtitle: 'Scraper packages installed in Stash.',
    lines: () => [
      {
        key: 'install',
        label: 'Install a scraper…',
        run: async () => {
          let sources;
          try {
            sources = await tasks.scraperSources();
          } catch (err) {
            toast(`Couldn't read scraper sources: ${err.message}`, 'error');
            return;
          }
          if (!sources.length) {
            toast('No scraper sources are set up in Stash.');
            return;
          }
          const src = sources.length === 1 ? sources[0].url
            : await chooseOption({ title: 'Source', options: sources.map((s) => ({ label: s.name || s.url, value: s.url })) });
          if (!src) return;
          let available;
          try {
            toast('Loading the scraper list…');
            available = await tasks.availableScrapers(src);
          } catch (err) {
            toast(`Couldn't load the list: ${err.message}`, 'error');
            return;
          }
          const have = installed.map((p) => p.package_id);
          const pick = await pickBySearch({
            title: 'Install a scraper',
            search: (text) => Promise.resolve(available
              .filter((p) => have.indexOf(p.package_id) < 0 && p.name.toLowerCase().indexOf(text.toLowerCase()) >= 0)
              .slice(0, 30)
              .map((p) => ({ label: p.name, hint: p.version || '', value: p }))),
          });
          if (!pick) return;
          await run('install', [pick], `Installing ${pick.name}`);
          setTimeout(refresh, 3000);
        },
      },
      {
        key: 'update',
        label: 'Update all scrapers',
        run: () => run('update', null, 'Updating scrapers'),
      },
      {
        key: 'reload',
        label: 'Reload scrapers',
        run: async () => {
          try {
            await tasks.reloadScrapers();
            toast('Scrapers reloaded');
          } catch (err) {
            toast(`Couldn't reload: ${err.message}`, 'error');
          }
        },
      },
    ].concat(installed.map((p) => ({
      key: `p:${p.package_id}`,
      label: p.name,
      value: p.version || '',
      run: async () => {
        const action = await chooseOption({
          title: p.name,
          options: [{ label: 'Update', value: 'update' }, { label: 'Uninstall…', value: 'uninstall' }],
        });
        if (action === 'update') await run('update', [p], `Updating ${p.name}`);
        if (action === 'uninstall') {
          const ok = await confirmDialog({
            title: `Uninstall ${p.name}?`, confirm: 'Uninstall', safe: true,
          });
          if (!ok) return;
          await run('uninstall', [p], `Uninstalling ${p.name}`);
          setTimeout(refresh, 3000);
        }
      },
    }))),
  });
}

/** Stash-box servers: add (name, endpoint, API key) and remove. */
export async function openStashBoxes() {
  let boxes;
  try {
    boxes = await tasks.stashBoxes();
  } catch (err) {
    toast(`Couldn't read stash-box servers: ${err.message}`, 'error');
    return;
  }
  let panel = null;
  const save = async (next, message) => {
    try {
      await tasks.saveStashBoxes(next);
      boxes = next;
      toast(message);
    } catch (err) {
      toast(`Couldn't save: ${err.message}`, 'error');
    }
    panel.render();
  };
  panel = openLinesPanel({
    title: 'Stash-box servers',
    subtitle: 'Used by scraping and Identify.',
    lines: () => boxes.map((b, i) => ({
      key: `b:${b.endpoint}`,
      label: b.name || b.endpoint,
      value: 'Remove',
      run: async () => {
        const ok = await confirmDialog({ title: `Remove ${b.name || b.endpoint}?`, confirm: 'Remove', safe: true });
        if (ok) await save(boxes.filter((_, n) => n !== i), 'Removed');
      },
    })).concat([{
      key: 'add',
      label: 'Add a stash-box…',
      run: async () => {
        const name = await promptText({ title: 'Name', value: 'StashDB', confirm: 'Next' });
        if (!name || !name.trim()) return;
        const endpoint = await promptText({
          title: 'GraphQL endpoint', value: 'https://stashdb.org/graphql', type: 'url', confirm: 'Next',
        });
        if (!endpoint || !endpoint.trim()) return;
        const key = await promptText({ title: 'API key', placeholder: 'From your account on that server', confirm: 'Add' });
        if (!key || !key.trim()) return;
        await save(boxes.concat([{ name: name.trim(), endpoint: endpoint.trim(), api_key: key.trim() }]), `Added ${name.trim()}`);
      },
    }]),
  });
}
