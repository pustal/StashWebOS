/**
 * A settings panel built from Stash's schema: every simple field of a
 * settings section (or a chosen subset) becomes a line, edited to suit its
 * type, and saved straight away.
 *
 * - yes/no fields toggle
 * - text and numbers are typed in (long text, such as custom CSS, in a box)
 * - choices (enums) come from the server's list
 * - lists of text (extensions, exclusions…) are typed one item per line
 * - folder settings (…Path) can also be chosen by browsing the server
 *
 * Fields the panel can't show (objects such as library folders) are left
 * out; they have their own panels or stay in Stash's web UI.
 */
import { chooseOption, promptText, toast } from './overlay.js';
import { openLinesPanel } from './panel.js';
import * as tasks from '../api/tasks.js';

/** Long text edited in a box. */
const MULTILINE = ['css', 'javascript', 'customLocales'];

/** "maxSessionAge" → "Max session age"; "logOut" → "Log out". */
function humanize(key) {
  const words = key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** How a field is edited, or null when the panel can't. */
function fieldKind(f) {
  if (f.kind === 'ENUM') return f.list ? null : 'enum';
  if (f.kind !== 'SCALAR') return null;
  if (f.list) return f.name === 'String' ? 'list' : null;
  if (f.name === 'Boolean') return 'bool';
  if (f.name === 'Int' || f.name === 'Float') return 'number';
  if (f.name === 'String') return 'text';
  return null;
}

/**
 * Browses the server's folders; resolves with a path or undefined.
 * @param {string} [start]
 */
export async function browseServerFolder(start) {
  let path = start;
  for (;;) {
    let dir;
    try {
      dir = await tasks.serverDirectory(path); // eslint-disable-line no-await-in-loop
    } catch (err) {
      // A path that doesn't exist (yet): start from the server's default.
      if (path) {
        path = undefined;
        continue; // eslint-disable-line no-continue
      }
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

/**
 * Opens a settings panel.
 * @param {Object} opts
 * @param {'general'|'interface'|'dlna'|'scraping'} opts.section
 * @param {string} opts.title
 * @param {string} [opts.subtitle]
 * @param {string[]} [opts.fields]  only these fields, in this order (default: all simple fields)
 * @param {string[]} [opts.skip]    fields never shown
 * @param {Object<string, string>} [opts.labels]  nicer names for fields
 */
export async function openConfigPanel(opts) {
  let input;
  let output;
  try {
    [input, output] = await Promise.all([
      tasks.schemaFields(tasks.configInputType(opts.section)),
      tasks.schemaFields({
        general: 'ConfigGeneralResult', interface: 'ConfigInterfaceResult', dlna: 'ConfigDLNAResult', scraping: 'ConfigScrapingResult',
      }[opts.section]),
    ]);
  } catch (err) {
    toast(`Couldn't read the settings: ${err.message}`, 'error');
    return;
  }
  // Editable (in the input type), readable (in the result) and simple.
  const names = (opts.fields || Object.keys(input))
    .filter((k) => input[k] && output[k] && fieldKind(input[k]) && (opts.skip || []).indexOf(k) < 0);
  if (!names.length) {
    toast('This Stash version has none of these settings.');
    return;
  }
  let values;
  try {
    values = await tasks.readConfig(opts.section, names);
  } catch (err) {
    toast(`Couldn't read the settings: ${err.message}`, 'error');
    return;
  }
  const label = (k) => (opts.labels && opts.labels[k]) || humanize(k);
  let panel = null;

  const save = async (k, v) => {
    try {
      await tasks.saveConfig(opts.section, { [k]: v });
      values[k] = v;
      toast(`${label(k)} saved`);
    } catch (err) {
      toast(`Couldn't save: ${err.message}`, 'error');
    }
    panel.render();
  };

  const show = (k) => {
    const v = values[k];
    const kind = fieldKind(input[k]);
    if (kind === 'bool') return v ? 'On' : 'Off';
    if (kind === 'list') return v && v.length ? `${v.length} item${v.length === 1 ? '' : 's'}` : 'None';
    if (v === null || v === undefined || v === '') return '—';
    const t = String(v);
    return t.length > 28 ? `…${t.slice(-27)}` : t;
  };

  const edit = async (k) => {
    const f = input[k];
    const kind = fieldKind(f);
    const v = values[k];
    if (kind === 'bool') {
      await save(k, !v);
      return;
    }
    if (kind === 'enum') {
      const options = (await tasks.enumValues(f.name)).map((e) => ({ label: humanize(e.toLowerCase()), value: e }));
      const pick = await chooseOption({ title: label(k), options, selected: v });
      if (pick && pick !== v) await save(k, pick);
      return;
    }
    if (kind === 'list') {
      const t = await promptText({
        title: label(k), value: (v || []).join('\n'), multiline: true, placeholder: 'One per line',
      });
      if (t === undefined) return;
      await save(k, t.split(/\n|,/).map((x) => x.trim()).filter(Boolean));
      return;
    }
    if (kind === 'number') {
      const t = await promptText({ title: label(k), value: v === null || v === undefined ? '' : String(v) });
      if (t === undefined || t.trim() === String(v)) return;
      const n = Number(t.trim());
      if (t.trim() === '' || Number.isNaN(n) || (f.name === 'Int' && Math.round(n) !== n)) {
        toast(f.name === 'Int' ? 'Enter a whole number.' : 'Enter a number.', 'error');
        return;
      }
      await save(k, n);
      return;
    }
    // Text; folders can also be browsed.
    if (/Path$/.test(k) || /path$/i.test(k)) {
      const how = await chooseOption({
        title: label(k),
        options: [{ label: 'Choose a folder on the server…', value: 'browse' }, { label: 'Type a path…', value: 'type' }],
      });
      if (!how) return;
      if (how === 'browse') {
        const p = await browseServerFolder(v || undefined);
        if (p && p !== v) await save(k, p);
        return;
      }
    }
    const t = await promptText({ title: label(k), value: v || '', multiline: MULTILINE.indexOf(k) >= 0 });
    if (t === undefined || t === (v || '')) return;
    await save(k, t);
  };

  panel = openLinesPanel({
    title: opts.title,
    subtitle: opts.subtitle || 'Settings of the Stash server, saved straight away.',
    lines: () => names.map((k) => ({
      key: k, label: label(k), value: show(k), run: () => edit(k),
    })),
  });
}
