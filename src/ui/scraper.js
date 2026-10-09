/**
 * Scraping metadata from the TV, with the scrapers and stash-box servers
 * configured in Stash: scenes, galleries, images, groups and performers.
 *
 * Flow: choose a source → (performers: search by name) → if several
 * results, choose one → review panel listing each field that would change,
 * each of which can be skipped → "Apply". Studios, performers and tags Stash
 * doesn't know yet are created (name only) when applied; the review marks
 * them "new".
 *
 * How each kind is scraped:
 * - scenes, galleries, images, groups: by the item itself ("fragment":
 *   file name, hashes, URLs…) or from a page URL
 * - performers: by name (scrapers return search results; the chosen one is
 *   then scraped in full), or from a page URL
 */
import { chooseOption, promptText, toast } from './overlay.js';
import { openLinesPanel } from './panel.js';
import * as api from '../api/stash.js';
import { formatDate, parseDuration } from '../util/format.js';

const LINKED = 'studio { stored_id name } performers { stored_id name } tags { stored_id name }';

/**
 * Per kind: the scrape query, its input, what it returns and how the
 * result's plain fields map onto the item.
 * `text`: [scraped field, label, item field (default: same)].
 */
const KINDS = {
  scene: {
    spec: 'scene',
    by: 'FRAGMENT',
    single: 'scrapeSingleScene',
    input: 'ScrapeSingleSceneInput',
    idField: 'scene_id',
    url: 'scrapeSceneURL',
    fields: `title code details director urls date image ${LINKED}`,
    text: [['title', 'Title'], ['code', 'Studio code'], ['director', 'Director'], ['details', 'Details']],
    image: [['image', 'Cover image', 'cover_image']],
  },
  gallery: {
    spec: 'gallery',
    by: 'FRAGMENT',
    single: 'scrapeSingleGallery',
    input: 'ScrapeSingleGalleryInput',
    idField: 'gallery_id',
    url: 'scrapeGalleryURL',
    fields: `title code details photographer urls date ${LINKED}`,
    text: [['title', 'Title'], ['code', 'Studio code'], ['photographer', 'Photographer'], ['details', 'Details']],
  },
  image: {
    spec: 'image',
    by: 'FRAGMENT',
    single: 'scrapeSingleImage',
    input: 'ScrapeSingleImageInput',
    idField: 'image_id',
    url: 'scrapeImageURL',
    fields: `title code details photographer urls date ${LINKED}`,
    text: [['title', 'Title'], ['code', 'Studio code'], ['photographer', 'Photographer'], ['details', 'Details']],
  },
  group: {
    spec: 'group',
    by: 'FRAGMENT',
    single: 'scrapeSingleGroup',
    input: 'ScrapeSingleGroupInput',
    idField: 'group_id',
    url: 'scrapeGroupURL',
    fields: 'name aliases duration date director synopsis urls front_image back_image studio { stored_id name } tags { stored_id name }',
    text: [['name', 'Name'], ['aliases', 'Aliases'], ['director', 'Director'], ['synopsis', 'Synopsis']],
    image: [['front_image', 'Front cover', 'front_image'], ['back_image', 'Back cover', 'back_image']],
  },
  performer: {
    spec: 'performer',
    by: 'NAME',
    single: 'scrapeSinglePerformer',
    input: 'ScrapeSinglePerformerInput',
    url: 'scrapePerformerURL',
    fields: `name disambiguation gender urls birthdate death_date country ethnicity eye_color hair_color height weight
      measurements career_start career_end tattoos piercings aliases details images tags { stored_id name }`,
    text: [['name', 'Name'], ['disambiguation', 'Disambiguation'], ['country', 'Country'], ['ethnicity', 'Ethnicity'],
      ['eye_color', 'Eye colour'], ['hair_color', 'Hair colour'], ['measurements', 'Measurements'],
      ['career_start', 'Career start'], ['career_end', 'Career end'], ['tattoos', 'Tattoos'], ['piercings', 'Piercings'],
      ['details', 'Details']],
  },
};

/** Fields a chosen performer search result may carry into the full scrape. */
const PERFORMER_INPUT = ['stored_id', 'name', 'disambiguation', 'gender', 'urls', 'birthdate', 'ethnicity', 'country',
  'eye_color', 'height', 'measurements', 'career_start', 'career_end', 'tattoos', 'piercings', 'aliases', 'details',
  'death_date', 'hair_color', 'weight'];

/** The scrapers and stash-box servers that can scrape this kind. */
async function sources(conf) {
  const data = await api.getClient().query(`query ($t: [ScrapeContentType!]!) {
    listScrapers(types: $t) { id name ${conf.spec} { supported_scrapes } }
    configuration { general { stashBoxes { endpoint name } } }
  }`, { t: [conf.spec.toUpperCase()] });
  const out = [];
  // stash-box servers can look up scenes and performers.
  if (conf.spec === 'scene' || conf.spec === 'performer') {
    for (const sb of data.configuration.general.stashBoxes || []) {
      out.push({ label: sb.name || sb.endpoint, hint: 'stash-box', value: { stash_box_endpoint: sb.endpoint } });
    }
  }
  for (const s of data.listScrapers || []) {
    const kinds = (s[conf.spec] && s[conf.spec].supported_scrapes) || [];
    if (kinds.indexOf(conf.by) >= 0) out.push({ label: s.name, hint: 'Scraper', value: { scraper_id: s.id } });
  }
  return out;
}

/** Runs a single-item scrape. */
async function scrapeSingle(conf, source, input) {
  const data = await api.getClient().query(`query ($s: ScraperSourceInput!, $i: ${conf.input}!) {
    ${conf.single}(source: $s, input: $i) { ${conf.fields} }
  }`, { s: source, i: input });
  return data[conf.single] || [];
}

/** Scrapes a page by its URL (needs a scraper for that site). */
async function scrapeUrl(conf, url) {
  const data = await api.getClient().query(`query ($u: String!) { ${conf.url}(url: $u) { ${conf.fields} } }`, { u: url });
  return data[conf.url] ? [data[conf.url]] : [];
}

/** Short text for a list of names: "A, B +3". */
function names(list) {
  const shown = list.slice(0, 3).map((x) => x.name + (x.stored_id ? '' : ' (new)'));
  return shown.join(', ') + (list.length > 3 ? ` +${list.length - 3}` : '');
}

/** The ids for scraped items, creating those Stash doesn't have yet. */
async function idsFor(kind, list) {
  const out = [];
  for (const x of list) {
    if (x.stored_id) out.push(x.stored_id);
    else out.push((await api.createNamed(kind, x.name)).id); // eslint-disable-line no-await-in-loop
  }
  return out;
}

/** "Female" / "transgender male" → GenderEnum, or null. */
function genderEnum(v) {
  const e = String(v || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return ['FEMALE', 'MALE', 'TRANSGENDER_FEMALE', 'TRANSGENDER_MALE', 'INTERSEX', 'NON_BINARY'].indexOf(e) >= 0 ? e : null;
}

/**
 * The changes a scraped result would make, one entry per field.
 * @returns {Array<{key, label, value, apply: (patch: Object) => Promise<void>}>}
 */
function changesFor(kind, conf, item, r) {
  const out = [];
  const add = (key, label, value, apply) => out.push({
    key, label, value: String(value), apply,
  });
  for (const [key, label, field] of conf.text) {
    const v = r[key];
    const f = field || key;
    if (v && v !== item[f]) add(key, label, v, async (p) => { p[f] = v; });
  }
  if (r.date && r.date !== item.date) add('date', 'Date', formatDate(r.date), async (p) => { p.date = r.date; });
  if (kind === 'group' && r.duration) {
    const sec = /^\d+$/.test(r.duration) ? parseInt(r.duration, 10) : parseDuration(r.duration);
    if (sec && sec !== item.duration) add('duration', 'Length', r.duration, async (p) => { p.duration = Math.round(sec); });
  }
  if (kind === 'performer') {
    const g = genderEnum(r.gender);
    if (g && g !== item.gender) add('gender', 'Gender', r.gender, async (p) => { p.gender = g; });
    for (const [key, label, field] of [['birthdate', 'Birth date', 'birthdate'], ['death_date', 'Death date', 'death_date']]) {
      if (r[key] && r[key] !== item[field]) add(key, label, formatDate(r[key]), async (p) => { p[field] = r[key]; });
    }
    const cm = parseInt(r.height, 10);
    if (cm && cm !== item.height_cm) add('height', 'Height', `${cm} cm`, async (p) => { p.height_cm = cm; });
    const aliases = (r.aliases || '').split(',').map((x) => x.trim()).filter(Boolean)
      .filter((a) => (item.alias_list || []).indexOf(a) < 0);
    if (aliases.length) {
      add('aliases', 'Aliases', aliases.join(', '), async (p) => { p.alias_list = (item.alias_list || []).concat(aliases); });
    }
    if (r.images && r.images[0]) add('image', 'Image', 'From the scraper', async (p) => { p.image = r.images[0]; });
  }
  const newUrls = (r.urls || []).filter((u) => (item.urls || []).indexOf(u) < 0);
  if (newUrls.length) {
    add('urls', 'Links', `${newUrls.length} new`, async (p) => { p.urls = (item.urls || []).concat(newUrls); });
  }
  if (r.studio && (!item.studio || r.studio.stored_id !== item.studio.id)) {
    add('studio', 'Studio', names([r.studio]), async (p) => { p.studio_id = (await idsFor('studio', [r.studio]))[0]; });
  }
  const addList = (key, label, linkKind, idsField) => {
    const have = (item[key] || []).map((x) => x.id);
    const extra = (r[key] || []).filter((x) => !x.stored_id || have.indexOf(x.stored_id) < 0);
    if (!extra.length) return;
    add(key, `Add ${label}`, names(extra), async (p) => { p[idsField] = have.concat(await idsFor(linkKind, extra)); });
  };
  if (kind !== 'performer' && kind !== 'group') addList('performers', 'performers', 'performer', 'performer_ids');
  addList('tags', 'tags', 'tag', 'tag_ids');
  for (const [key, label, field] of conf.image || []) {
    if (r[key]) add(key, label, 'From the scraper', async (p) => { p[field] = r[key]; });
  }
  return out;
}

/** Lets the user pick one of several results. */
async function chooseResult(results, kind) {
  if (results.length === 1) return results[0];
  const i = await chooseOption({
    title: `${results.length} results`,
    options: results.map((x, n) => ({
      label: x.title || x.name || `Result ${n + 1}`,
      hint: kind === 'performer'
        ? [x.disambiguation, formatDate(x.birthdate), x.country].filter(Boolean).join(' · ')
        : [formatDate(x.date), x.studio && x.studio.name].filter(Boolean).join(' · '),
      value: n,
    })),
  });
  return i === undefined ? undefined : results[i];
}

/**
 * Scrapes an item and lets the user apply the result.
 * @param {'scene'|'gallery'|'image'|'group'|'performer'} kind
 * @param {Object} item  the full item (as the edit panel has it)
 * @param {(applied: boolean) => void} done  called when finished
 */
export async function scrapeItem(kind, item, done) {
  const conf = KINDS[kind];
  let list;
  try {
    list = await sources(conf);
  } catch (err) {
    toast(`Couldn't list scrapers: ${err.message}`, 'error');
    return;
  }
  list.push({ label: 'Scrape a URL…', value: 'url' });
  const source = await chooseOption({ title: 'Scrape with', options: list });
  if (!source) return;

  let result;
  try {
    if (source === 'url') {
      const url = await promptText({
        title: 'Page URL', value: (item.urls || [])[0] || '', placeholder: 'https://…', type: 'url', confirm: 'Scrape',
      });
      if (!url || !url.trim()) return;
      toast('Scraping…');
      result = await chooseResult(await scrapeUrl(conf, url.trim()), kind);
    } else if (conf.by === 'NAME') {
      const query = await promptText({ title: 'Search for', value: item.name || '', confirm: 'Search' });
      if (!query || !query.trim()) return;
      toast('Searching…');
      result = await chooseResult(await scrapeSingle(conf, source, { query: query.trim() }), kind);
      // A scraper's search results are partial; scrape the chosen one in full.
      if (result && source.scraper_id) {
        const input = {};
        for (const k of PERFORMER_INPUT) if (result[k] !== null && result[k] !== undefined) input[k] = result[k];
        const full = await scrapeSingle(conf, source, { performer_input: input });
        if (full[0]) result = full[0];
      }
    } else {
      toast('Scraping…');
      result = await chooseResult(await scrapeSingle(conf, source, { [conf.idField]: item.id }), kind);
    }
  } catch (err) {
    toast(`Scraping failed: ${err.message}`, 'error');
    return;
  }
  if (result === undefined) return;
  if (!result) {
    toast('Nothing found.');
    return;
  }

  const changes = changesFor(kind, conf, item, result);
  if (!changes.length) {
    toast('The scraper found nothing new.');
    return;
  }
  const skip = {};
  let panel = null;
  let applying = false;
  const count = () => changes.filter((c) => !skip[c.key]).length;

  const apply = async () => {
    if (applying || !count()) return;
    applying = true;
    const chosen = changes.filter((c) => !skip[c.key]);
    const patch = {};
    try {
      for (const c of chosen) await c.apply(patch); // eslint-disable-line no-await-in-loop
      await api.updateItem(kind, item.id, patch);
    } catch (err) {
      applying = false;
      toast(`Couldn't apply: ${err.message}`, 'error');
      return;
    }
    panel.close();
    toast(`Applied ${chosen.length} change${chosen.length === 1 ? '' : 's'}`);
    done(true);
  };

  panel = openLinesPanel({
    title: 'Scraped',
    subtitle: 'Choose a line to skip or keep it.',
    lines: () => changes.map((c) => ({
      key: c.key,
      label: `${skip[c.key] ? '✕' : '✓'}  ${c.label}`,
      value: skip[c.key] ? 'Skip' : (c.value.length > 34 ? `${c.value.slice(0, 34)}…` : c.value),
      run: () => {
        skip[c.key] = !skip[c.key];
        panel.render();
      },
    })).concat([{
      key: 'apply',
      label: count() ? `Apply ${count()} change${count() === 1 ? '' : 's'}` : 'Nothing to apply',
      run: apply,
    }]),
    onDismiss: () => done(false),
  });
}

/** Scrapes a scene (kept for callers from 0.6). */
export function scrapeScene(scene, done) {
  return scrapeItem('scene', scene, done);
}
