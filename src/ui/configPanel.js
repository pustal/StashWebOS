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
 * - groups of settings (e.g. the web UI's image lightbox) open a panel of
 *   their own
 *
 * Lists of objects (such as library folders) are left out; they have their
 * own panels.
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
  // Groups of settings (e.g. the web UI's image lightbox): an input object
  // whose result is an object; their simple fields are read and edited in
  // a panel of their own.
  const groups = {};
  for (const k of Object.keys(input)) {
    if (input[k].kind === 'INPUT_OBJECT' && !input[k].list && output[k] && output[k].kind === 'OBJECT') {
      try {
        const [inSub, outSub] = await Promise.all([tasks.schemaFields(input[k].name), tasks.schemaFields(output[k].name)]); // eslint-disable-line no-await-in-loop
        const subNames = Object.keys(inSub).filter((n) => outSub[n] && fieldKind(inSub[n]));
        if (subNames.length) groups[k] = { input: inSub, names: subNames };
      } catch (e) { /* leave this group out */ }
    }
  }
  // Editable (in the input type), readable (in the result) and simple.
  const names = (opts.fields || Object.keys(input))
    .filter((k) => input[k] && output[k] && (fieldKind(input[k]) || groups[k]) && (opts.skip || []).indexOf(k) < 0);
  if (!names.length) {
    toast('This Stash version has none of these settings.');
    return;
  }
  let values;
  try {
    values = await tasks.readConfig(opts.section, names.map((k) => (groups[k] ? `${k} { ${groups[k].names.join(' ')} }` : k)));
  } catch (err) {
    toast(`Couldn't read the settings: ${err.message}`, 'error');
    return;
  }
  const label = (k) => (opts.labels && opts.labels[k]) || humanize(k);
  let panel = null;
  panel = openFieldsPanel({
    title: opts.title,
    subtitle: opts.subtitle || 'Settings of the Stash server, saved straight away.',
    input,
    names,
    values,
    label,
    groups,
    save: async (k, v) => {
      await tasks.saveConfig(opts.section, { [k]: v });
      values[k] = v;
    },
  });
  return panel;
}

/**
 * The lines of a settings panel (shared by top-level panels and groups).
 * @param {Object} o
 * @param {string} o.title
 * @param {string} [o.subtitle]
 * @param {Object} o.input   field types (schemaFields of the input type)
 * @param {string[]} o.names fields to show, in order
 * @param {Object} o.values  current values (kept up to date)
 * @param {(k: string) => string} o.label
 * @param {Object} [o.groups]  grouped fields: {field: {input, names}}
 * @param {(k: string, v: *) => Promise<void>} o.save  saves one field
 */
function openFieldsPanel(o) {
  const { input, names, values, label } = o;
  const groups = o.groups || {};
  let panel = null;

  const save = async (k, v) => {
    try {
      await o.save(k, v);
      toast(`${label(k)} saved`);
    } catch (err) {
      toast(`Couldn't save: ${err.message}`, 'error');
    }
    panel.render();
  };

  const show = (k) => {
    if (groups[k]) return `${groups[k].names.length} settings`;
    const v = values[k];
    const kind = fieldKind(input[k]);
    if (kind === 'bool') return v ? 'On' : 'Off';
    if (kind === 'list') return v && v.length ? `${v.length} item${v.length === 1 ? '' : 's'}` : 'None';
    if (v === null || v === undefined || v === '') return '—';
    const t = String(v);
    return t.length > 28 ? `…${t.slice(-27)}` : t;
  };

  const edit = async (k) => {
    if (groups[k]) {
      // The whole group is saved each time, with one field changed.
      const g = groups[k];
      const sub = Object.assign({}, values[k] || {});
      openFieldsPanel({
        title: label(k),
        subtitle: o.subtitle,
        input: g.input,
        names: g.names,
        values: sub,
        label: humanize,
        save: async (n, v) => {
          const next = Object.assign({}, sub, { [n]: v });
          await o.save(k, next);
          sub[n] = v;
        },
      });
      return;
    }
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
    title: o.title,
    subtitle: o.subtitle,
    lines: () => names.map((k) => ({
      key: k, label: label(k), value: show(k), run: () => edit(k),
    })),
  });
  return panel;
}
