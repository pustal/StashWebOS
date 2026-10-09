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

function unwrap(t) {
  let cur = t;
  while (cur && (cur.kind === 'NON_NULL' || cur.kind === 'LIST')) cur = cur.ofType;
  return { kind: cur && cur.kind, name: cur && cur.name };
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

/** Installed scraper packages. */
export async function installedScrapers() {
  const data = await getClient().query('{ installedPackages(type: Scraper) { package_id name version sourceURL } }');
  return (data.installedPackages || []).slice().sort((a, b) => a.name.localeCompare(b.name));
}

/** Scraper package sources (e.g. the community index). */
export async function scraperSources() {
  const data = await getClient().query('{ configuration { general { scraperPackageSources { name url } } } }');
  return data.configuration.general.scraperPackageSources || [];
}

/** Packages a source offers. */
export async function availableScrapers(sourceUrl) {
  const data = await getClient().query('query ($s: String!) { availablePackages(type: Scraper, source: $s) { package_id name version sourceURL } }', { s: sourceUrl });
  return (data.availablePackages || []).slice().sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Installs, updates or uninstalls scraper packages (a background job).
 * @param {'install'|'update'|'uninstall'} action
 * @param {Array<{package_id: string, sourceURL: string}>} [packages]  update: omit for all
 */
export function changeScrapers(action, packages) {
  const m = { install: 'installPackages', update: 'updatePackages', uninstall: 'uninstallPackages' }[action];
  const specs = packages ? packages.map((p) => ({ id: p.package_id, sourceURL: p.sourceURL })) : null;
  // Install and uninstall need a list; update takes none for "all".
  const varType = action === 'update' ? '[PackageSpecInput!]' : '[PackageSpecInput!]!';
  return getClient().query(`mutation ($p: ${varType}) { ${m}(type: Scraper, packages: $p) }`, { p: specs });
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
