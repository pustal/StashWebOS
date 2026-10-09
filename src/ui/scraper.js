/**
 * Scraping a scene's metadata from the TV, with the scrapers and stash-box
 * servers configured in Stash.
 *
 * Flow: choose a source → (if several results) choose one → review panel
 * listing each field that would change, each of which can be skipped →
 * "Apply". Studios, performers and tags Stash doesn't know yet are created
 * (name only) when applied; the review marks them "new".
 */
import { chooseOption, promptText, toast } from './overlay.js';
import { openLinesPanel } from './panel.js';
import * as api from '../api/stash.js';
import { formatDate } from '../util/format.js';

/** What a scraped scene result contains (the fields this app can apply). */
const SCRAPED_SCENE = `
  title code details director urls date image
  studio { stored_id name }
  performers { stored_id name }
  tags { stored_id name }`;

/** The scrapers and stash-box servers that can scrape a scene. */
async function sceneSources() {
  const data = await api.getClient().query(`{
    listScrapers(types: [SCENE]) { id name scene { supported_scrapes } }
    configuration { general { stashBoxes { endpoint name } } }
  }`);
  const out = [];
  for (const sb of data.configuration.general.stashBoxes || []) {
    out.push({ label: sb.name || sb.endpoint, hint: 'stash-box', value: { stash_box_endpoint: sb.endpoint } });
  }
  for (const s of data.listScrapers || []) {
    const kinds = (s.scene && s.scene.supported_scrapes) || [];
    if (kinds.indexOf('FRAGMENT') >= 0) out.push({ label: s.name, hint: 'Scraper', value: { scraper_id: s.id } });
  }
  return out;
}

/** Runs one source for a scene. */
async function scrapeWith(source, sceneId) {
  const data = await api.getClient().query(`query ($s: ScraperSourceInput!, $i: ScrapeSingleSceneInput!) {
    scrapeSingleScene(source: $s, input: $i) { ${SCRAPED_SCENE} }
  }`, { s: source, i: { scene_id: sceneId } });
  return data.scrapeSingleScene || [];
}

/** Scrapes a scene page by its URL (needs a scraper for that site). */
async function scrapeUrl(url) {
  const data = await api.getClient().query(`query ($u: String!) { scrapeSceneURL(url: $u) { ${SCRAPED_SCENE} } }`, { u: url });
  return data.scrapeSceneURL ? [data.scrapeSceneURL] : [];
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

/**
 * The changes a scraped result would make, one entry per field.
 * @returns {Array<{key, label, value, apply: (patch: Object) => Promise<void>}>}
 */
function changesFor(scene, r) {
  const out = [];
  const text = (key, label, field) => {
    const v = r[key];
    if (v && v !== scene[field || key]) {
      out.push({
        key, label, value: v, apply: async (p) => { p[field || key] = v; },
      });
    }
  };
  text('title', 'Title');
  text('code', 'Studio code');
  text('director', 'Director');
  if (r.date && r.date !== scene.date) {
    out.push({
      key: 'date', label: 'Date', value: formatDate(r.date), apply: async (p) => { p.date = r.date; },
    });
  }
  text('details', 'Details');
  const newUrls = (r.urls || []).filter((u) => (scene.urls || []).indexOf(u) < 0);
  if (newUrls.length) {
    out.push({
      key: 'urls', label: 'Links', value: `${newUrls.length} new`, apply: async (p) => { p.urls = (scene.urls || []).concat(newUrls); },
    });
  }
  if (r.studio && (!scene.studio || r.studio.stored_id !== scene.studio.id)) {
    out.push({
      key: 'studio',
      label: 'Studio',
      value: names([r.studio]),
      apply: async (p) => { p.studio_id = (await idsFor('studio', [r.studio]))[0]; },
    });
  }
  const addList = (key, label, kind, field, idsField) => {
    const have = (scene[field] || []).map((x) => x.id);
    const extra = (r[key] || []).filter((x) => !x.stored_id || have.indexOf(x.stored_id) < 0);
    if (!extra.length) return;
    out.push({
      key,
      label: `Add ${label}`,
      value: names(extra),
      apply: async (p) => { p[idsField] = have.concat(await idsFor(kind, extra)); },
    });
  };
  addList('performers', 'performers', 'performer', 'performers', 'performer_ids');
  addList('tags', 'tags', 'tag', 'tags', 'tag_ids');
  if (r.image) {
    out.push({
      key: 'image', label: 'Cover image', value: 'From the scraper', apply: async (p) => { p.cover_image = r.image; },
    });
  }
  return out;
}

/**
 * Scrapes a scene and lets the user apply the result.
 * @param {Object} scene  full scene (from getScene)
 * @param {(changed: boolean) => void} done  called when finished
 */
export async function scrapeScene(scene, done) {
  let sources;
  try {
    sources = await sceneSources();
  } catch (err) {
    toast(`Couldn't list scrapers: ${err.message}`, 'error');
    return;
  }
  sources.push({ label: 'Scrape a URL…', value: 'url' });
  const source = await chooseOption({ title: 'Scrape with', options: sources });
  if (!source) return;

  let results;
  try {
    if (source === 'url') {
      const url = await promptText({
        title: 'Scene page URL', value: (scene.urls || [])[0] || '', placeholder: 'https://…', type: 'url', confirm: 'Scrape',
      });
      if (!url || !url.trim()) return;
      toast('Scraping…');
      results = await scrapeUrl(url.trim());
    } else {
      toast('Scraping…');
      results = await scrapeWith(source, scene.id);
    }
  } catch (err) {
    toast(`Scraping failed: ${err.message}`, 'error');
    return;
  }
  if (!results.length) {
    toast('Nothing found for this scene.');
    return;
  }
  let result = results[0];
  if (results.length > 1) {
    const i = await chooseOption({
      title: `${results.length} results`,
      options: results.map((x, n) => ({
        label: x.title || `Result ${n + 1}`,
        hint: [formatDate(x.date), x.studio && x.studio.name].filter(Boolean).join(' · '),
        value: n,
      })),
    });
    if (i === undefined) return;
    result = results[i];
  }

  const changes = changesFor(scene, result);
  if (!changes.length) {
    toast('The scraper found nothing new for this scene.');
    return;
  }
  const skip = {};
  let panel = null;
  let applying = false;

  const apply = async () => {
    if (applying) return;
    const chosen = changes.filter((c) => !skip[c.key]);
    if (!chosen.length) return;
    applying = true;
    const patch = {};
    try {
      for (const c of chosen) await c.apply(patch); // eslint-disable-line no-await-in-loop
      await api.updateItem('scene', scene.id, patch);
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
      label: (() => {
        const n = changes.filter((c) => !skip[c.key]).length;
        return n ? `Apply ${n} change${n === 1 ? '' : 's'}` : 'Nothing to apply';
      })(),
      run: apply,
    }]),
    onDismiss: () => done(false),
  });
}
