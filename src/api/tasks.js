/**
 * Library tasks (Stash → Settings → Tasks): scan, generate, auto tag,
 * identify and clean, plus the job queue.
 *
 * Each task runs with the defaults saved in Stash (the options last used in
 * its web UI's Tasks page), so the TV doesn't need its own copy of the many
 * task options. Option fields differ between Stash versions, so the defaults
 * query and the task inputs are built from the server's schema
 * (introspection) rather than hard-coded.
 */
import { getClient } from './stash.js';

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

/** typeName → Promise<{field: {kind, name}}> for output and input types. */
const typeCache = {};

/** NON_NULL/LIST wrappers → {kind, name, list} of the named type. */
function unwrap(t) {
  let cur = t;
  let list = false;
  while (cur && (cur.kind === 'NON_NULL' || cur.kind === 'LIST')) {
    if (cur.kind === 'LIST') list = true;
    cur = cur.ofType;
  }
  return { kind: cur && cur.kind, name: cur && cur.name, list };
}

/** Fields of a type (output fields, or input fields for input types). */
function typeFields(name) {
  if (!typeCache[name]) {
    const T = 'type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }';
    typeCache[name] = getClient().query(`query ($n: String!) { __type(name: $n) { fields { name ${T} } inputFields { name ${T} } } }`, { n: name })
      .then((d) => {
        const out = {};
        const t = d.__type || {};
        // Input types answer `fields` with an empty list, not null.
        const list = t.fields && t.fields.length ? t.fields : t.inputFields;
        for (const f of list || []) out[f.name] = unwrap(f.type);
        return out;
      }, (err) => {
        delete typeCache[name];
        throw err;
      });
  }
  return typeCache[name];
}

/** GraphQL selection of every field of an output type (nested types too). */
async function selection(typeName, depth) {
  const fields = await typeFields(typeName);
  const parts = [];
  for (const name of Object.keys(fields)) {
    const f = fields[name];
    if (f.kind === 'OBJECT') {
      if ((depth || 0) < 4) parts.push(`${name} { ${await selection(f.name, (depth || 0) + 1)} }`); // eslint-disable-line no-await-in-loop
    } else {
      parts.push(name);
    }
  }
  return parts.join(' ');
}

/**
 * Keeps only what an input type accepts (recursively), dropping nulls, so
 * a saved default can be sent as a task input.
 */
async function fitInput(typeName, value) {
  if (Array.isArray(value)) {
    const out = [];
    for (const v of value) out.push(await fitInput(typeName, v)); // eslint-disable-line no-await-in-loop
    return out;
  }
  if (!value || typeof value !== 'object') return value;
  const fields = await typeFields(typeName);
  const out = {};
  for (const key of Object.keys(value)) {
    const f = fields[key];
    if (!f || value[key] === null || value[key] === undefined) continue;
    out[key] = f.kind === 'INPUT_OBJECT' ? await fitInput(f.name, value[key]) : value[key]; // eslint-disable-line no-await-in-loop
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** The task defaults saved in Stash (configuration.defaults). */
async function defaults() {
  const sel = await selection('ConfigDefaultSettingsResult');
  const data = await getClient().query(`{ configuration { defaults { ${sel} } } }`);
  return data.configuration.defaults || {};
}

/** Each task: label, what it does, and how to start it. */
export const TASKS = {
  scan: {
    label: 'Scan for new files',
    note: 'Finds new, changed and removed files in your library folders.',
    async start(d) {
      const input = await fitInput('ScanMetadataInput', d.scan || {});
      return run('metadataScan', 'ScanMetadataInput', input);
    },
  },
  generate: {
    label: 'Generate',
    note: 'Covers, previews, sprites and the rest, as set in Stash’s Tasks page.',
    async start(d) {
      const input = await fitInput('GenerateMetadataInput', d.generate || { covers: true, sprites: true, previews: true });
      return run('metadataGenerate', 'GenerateMetadataInput', input);
    },
  },
  autoTag: {
    label: 'Auto tag',
    note: 'Matches performers, studios and tags by file names.',
    async start(d) {
      const a = d.autoTag || {};
      // An empty list means "none" to Stash; the web UI sends "*" for all.
      const all = (list) => (list && list.length ? list : ['*']);
      return run('metadataAutoTag', 'AutoTagMetadataInput', { performers: all(a.performers), studios: all(a.studios), tags: all(a.tags) });
    },
  },
  identify: {
    label: 'Identify',
    note: 'Looks scenes up with the sources set up for Identify in Stash.',
    async start(d) {
      const id = d.identify;
      if (!id || !id.sources || !id.sources.length) {
        throw new Error('Set up Identify sources in Stash first (Settings, Tasks, Identify).');
      }
      const input = await fitInput('IdentifyMetadataInput', { sources: id.sources, options: id.options });
      return run('metadataIdentify', 'IdentifyMetadataInput', input);
    },
  },
  clean: {
    label: 'Clean',
    note: 'Removes files that no longer exist from the database.',
    danger: true,
    start() {
      return run('metadataClean', 'CleanMetadataInput', { dryRun: false });
    },
  },
};

function run(mutation, type, input) {
  return getClient().query(`mutation ($i: ${type}!) { ${mutation}(input: $i) }`, { i: input });
}

/**
 * Starts a library task with Stash's saved defaults.
 * @param {keyof TASKS} key
 * @returns {Promise<*>} resolves when the job is queued
 */
export async function startTask(key) {
  return TASKS[key].start(await defaults());
}

/** Running and queued jobs. */
export async function jobQueue() {
  const data = await getClient().query('{ jobQueue { id status description progress subTasks } }');
  return data.jobQueue || [];
}

/** Stops every running and queued job. */
export function stopAllJobs() {
  return getClient().query('mutation { stopAllJobs }');
}

// ---------------------------------------------------------------------------
// Task options (Stash's saved defaults)
// ---------------------------------------------------------------------------

/** The saved task defaults (scan, generate, autoTag, identify…). */
export function getTaskDefaults() {
  return defaults();
}

/**
 * Boolean options a task input accepts, in schema order.
 * @param {'ScanMetadataInput'|'GenerateMetadataInput'} typeName
 * @returns {Promise<string[]>}
 */
export async function booleanOptions(typeName) {
  const fields = await typeFields(typeName);
  return Object.keys(fields).filter((k) => fields[k].name === 'Boolean');
}

/**
 * Saves one task's defaults in Stash (they are what its web UI's Tasks page
 * shows, and what this app runs).
 * @param {'scan'|'generate'|'identify'} key
 * @param {Object} value  the whole option object for that task
 */
export async function saveTaskDefaults(key, value) {
  const types = { scan: 'ScanMetadataInput', generate: 'GenerateMetadataInput', identify: 'IdentifyMetadataInput' };
  const input = { [key]: await fitInput(types[key], value) };
  await getClient().query('mutation ($i: ConfigDefaultSettingsInput!) { configureDefaults(input: $i) { deleteFile } }', { i: input });
}

// ---------------------------------------------------------------------------
// Scraper packages and stash-box servers
// ---------------------------------------------------------------------------

/**
 * Installed packages.
 * @param {'Scraper'|'Plugin'} [type]
 */
export async function installedScrapers(type) {
  const data = await getClient().query(`{ installedPackages(type: ${type || 'Scraper'}) { package_id name version sourceURL } }`);
  return (data.installedPackages || []).slice().sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Package sources (e.g. the community index).
 * @param {'Scraper'|'Plugin'} [type]
 */
export async function scraperSources(type) {
  const field = type === 'Plugin' ? 'pluginPackageSources' : 'scraperPackageSources';
  const data = await getClient().query(`{ configuration { general { ${field} { name url } } } }`);
  return data.configuration.general[field] || [];
}

/**
 * Packages a source offers.
 * @param {string} sourceUrl
 * @param {'Scraper'|'Plugin'} [type]
 */
export async function availableScrapers(sourceUrl, type) {
  const data = await getClient().query(`query ($s: String!) { availablePackages(type: ${type || 'Scraper'}, source: $s) { package_id name version sourceURL } }`, { s: sourceUrl });
  return (data.availablePackages || []).slice().sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Installs, updates or uninstalls scraper packages (a background job).
 * @param {'install'|'update'|'uninstall'} action
 * @param {Array<{package_id: string, sourceURL: string}>} [packages]  update: omit for all
 * @param {'Scraper'|'Plugin'} [type]
 */
export function changeScrapers(action, packages, type) {
  const m = { install: 'installPackages', update: 'updatePackages', uninstall: 'uninstallPackages' }[action];
  const specs = packages ? packages.map((p) => ({ id: p.package_id, sourceURL: p.sourceURL })) : null;
  // Install and uninstall need a list; update takes none for "all".
  const varType = action === 'update' ? '[PackageSpecInput!]' : '[PackageSpecInput!]!';
  return getClient().query(`mutation ($p: ${varType}) { ${m}(type: ${type || 'Scraper'}, packages: $p) }`, { p: specs });
}

/** Re-reads the scraper files (after installing or editing scrapers). */
export function reloadScrapers() {
  return getClient().query('mutation { reloadScrapers }');
}

/** Configured stash-box servers (with their API keys, to save them back). */
export async function stashBoxes() {
  const data = await getClient().query('{ configuration { general { stashBoxes { name endpoint api_key max_requests_per_minute } } } }');
  return data.configuration.general.stashBoxes || [];
}

/** Replaces the list of stash-box servers. */
export function saveStashBoxes(list) {
  return getClient().query('mutation ($i: ConfigGeneralInput!) { configureGeneral(input: $i) { stashBoxes { endpoint } } }', {
    i: {
      stashBoxes: list.map((b) => ({
        name: b.name, endpoint: b.endpoint, api_key: b.api_key, max_requests_per_minute: b.max_requests_per_minute || undefined,
      })),
    },
  });
}

// ---------------------------------------------------------------------------
// Server settings (Stash → Settings → Library, System, Plugins)
// ---------------------------------------------------------------------------

/** The general settings this app can change. */
export async function generalSettings() {
  const data = await getClient().query(`{ configuration { general {
    stashes { path excludeVideo excludeImage }
    maxTranscodeSize maxStreamingTranscodeSize transcodeHardwareAcceleration parallelTasks
  } } }`);
  return data.configuration.general;
}

/**
 * Saves general settings (only the fields given are changed).
 * @param {Object} patch  fields of ConfigGeneralInput
 */
export function saveGeneral(patch) {
  return getClient().query('mutation ($i: ConfigGeneralInput!) { configureGeneral(input: $i) { parallelTasks } }', { i: patch });
}

/**
 * A folder on the Stash server and its sub-folders, for choosing library
 * folders. Without `path`, the server's starting folder.
 */
export async function serverDirectory(path) {
  const data = await getClient().query('query ($p: String) { directory(path: $p) { path parent directories } }', { p: path || null });
  return data.directory;
}

/** Installed plugins with their tasks. */
export async function plugins() {
  const data = await getClient().query('{ plugins { id name description version enabled tasks { name description } } }');
  return (data.plugins || []).slice().sort((a, b) => a.name.localeCompare(b.name));
}

/** Turns a plugin on or off. */
export function setPluginEnabled(id, enabled) {
  return getClient().query('mutation ($m: BoolMap!) { setPluginsEnabled(enabledMap: $m) }', { m: { [id]: enabled } });
}

/** Runs one of a plugin's tasks (a background job). */
export function runPluginTask(pluginId, taskName) {
  return getClient().query('mutation ($p: ID!, $t: String) { runPluginTask(plugin_id: $p, task_name: $t) }', { p: pluginId, t: taskName });
}

/** Re-reads the plugin files. */
export function reloadPlugins() {
  return getClient().query('mutation { reloadPlugins }');
}

// ---------------------------------------------------------------------------
// Any settings section, by schema (configuration.general/interface/dlna/scraping)
// ---------------------------------------------------------------------------

/**
 * Fields of a type: {name: {kind, name, list}}. Works for output and input
 * types (used by the generic settings panels).
 */
export function schemaFields(typeName) {
  return typeFields(typeName);
}

/** Values of an enum type, e.g. ['MD5', 'OSHASH']. */
const enumCache = {};
export function enumValues(name) {
  if (!enumCache[name]) {
    enumCache[name] = getClient().query('query ($n: String!) { __type(name: $n) { enumValues { name } } }', { n: name })
      .then((d) => ((d.__type && d.__type.enumValues) || []).map((v) => v.name));
  }
  return enumCache[name];
}

/**
 * Reads some fields of a settings section.
 * @param {'general'|'interface'|'dlna'|'scraping'} section
 * @param {string[]} fields  scalar fields only
 */
export async function readConfig(section, fields) {
  const data = await getClient().query(`{ configuration { ${section} { ${fields.join(' ')} } } }`);
  return data.configuration[section] || {};
}

/** Mutation and input type per settings section. */
const CONFIGURE = {
  general: ['configureGeneral', 'ConfigGeneralInput'],
  interface: ['configureInterface', 'ConfigInterfaceInput'],
  dlna: ['configureDLNA', 'ConfigDLNAInput'],
  scraping: ['configureScraping', 'ConfigScrapingInput'],
};

/** The input type of a settings section (its editable fields). */
export function configInputType(section) {
  return CONFIGURE[section][1];
}

/** Saves fields of a settings section. */
export function saveConfig(section, patch) {
  const [m, t] = CONFIGURE[section];
  return getClient().query(`mutation ($i: ${t}!) { ${m}(input: $i) { __typename } }`, { i: patch });
}

// ---------------------------------------------------------------------------
// Security, logs, database, DLNA, plugin settings
// ---------------------------------------------------------------------------

/** Whether Stash has a username/password, and its API key. */
export async function securityInfo() {
  const data = await getClient().query('{ configuration { general { username apiKey maxSessionAge } } }');
  return data.configuration.general;
}

/** Sets (or, with empty strings, removes) Stash's username and password. */
export function setCredentials(username, password) {
  return saveConfig('general', { username, password });
}

/** Makes a new API key (the old one stops working) and returns it. */
export async function newApiKey() {
  const data = await getClient().query('mutation { generateAPIKey(input: { clear: false }) }');
  return data.generateAPIKey;
}

/** Recent log lines, newest first (as Stash returns them). */
export async function logs() {
  const data = await getClient().query('{ logs { time level message } }');
  const list = (data.logs || []).slice();
  // Order by time, newest first, whatever order the server used.
  list.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  return list;
}

/** Backs up the database into Stash's backup folder; returns its message. */
export async function backupDatabase() {
  const data = await getClient().query('mutation { backupDatabase(input: { download: false }) }');
  return data.backupDatabase;
}

/** Optimises the database (a background job). */
export function optimiseDatabase() {
  return getClient().query('mutation { optimiseDatabase }');
}

/** Whether the DLNA server runs now. */
export async function dlnaStatus() {
  const data = await getClient().query('{ dlnaStatus { running until } }');
  return data.dlnaStatus;
}

/** Starts or stops the DLNA server until it is changed again (or Stash restarts). */
export function setDlnaRunning(on) {
  return on
    ? getClient().query('mutation { enableDLNA(input: {}) }')
    : getClient().query('mutation { disableDLNA(input: {}) }');
}

/** A plugin's settings (definitions) and their saved values. */
export async function pluginSettings(id) {
  const data = await getClient().query('{ plugins { id settings { name display_name description type } } configuration { plugins } }');
  const p = (data.plugins || []).find((x) => x.id === id);
  return { settings: (p && p.settings) || [], values: (data.configuration.plugins || {})[id] || {} };
}

/** Saves a plugin's settings (the whole map). */
export function savePluginSettings(id, values) {
  return getClient().query('mutation ($p: ID!, $i: Map!) { configurePlugin(plugin_id: $p, input: $i) }', { p: id, i: values });
}
