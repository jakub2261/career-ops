// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
import { decodeEntities } from './_html-entities.mjs';
import { htmlToText, visibleText } from './_html-to-text.mjs';

// Backpacker Job Board (New Zealand) provider — board-wide aggregator of
// seasonal / working-holiday jobs (hospitality, farms, orchards, tourism).
// Employers post directly on the board, and a candidate reads and applies
// without registering.
//
// Source: the server-rendered region or category listing pages, e.g.
//   https://www.backpackerjobboard.co.nz/jobs-in/south-island/
//   https://www.backpackerjobboard.co.nz/jobs-in/queenstown/
//   https://www.backpackerjobboard.co.nz/jobs/farm-jobs/
// robots.txt (checked 2026-10-29) allows /jobs-in/{region}/ and /job/{id}/ and
// disallows /search, /post, the /feed variants and the work-type sub-filters
// (/jobs-in/*/fulltime etc.). resolveListUrl() only accepts the allowed shapes,
// so a portals.yml entry can never point the scanner at a disallowed path.
//
// Card markup (one per posting):
//   <h3 class="job-title"><a href="https://www.backpackerjobboard.co.nz/job/{id}/{slug}/" title="…">
//   <p class="job-company"> … <span>{Company}</span> …</p>
//   <p class="job-location"> … <span>{Town}</span>, <span>{Region}</span> …</p>
//   <p class="job-description show-for-medium"><span>{snippet}</span></p>
//   <p class="job-published show-for-medium"> 1d ago … </p>
//
// Opt-in enrichment (per-job request, skipped while probing):
//   backpackerjobboard: { fetchDetails: true, detailLimit: 60 }
// reads each /job/{id}/ page for the full description (itemprop="description"),
// the exact publish date (itemprop="datePosted") and the postcode.
//
// Wire in via a job_boards: entry; detect() claims the board host.

const TRUSTED_HOSTS = new Set(['www.backpackerjobboard.co.nz', 'backpackerjobboard.co.nz']);
const ORIGIN = 'https://www.backpackerjobboard.co.nz';
const LIST_PATH_RE = /^\/(?:jobs-in\/[a-z0-9-]+|jobs\/[a-z0-9-]+(?:\/[a-z0-9-]+)?)\/?$/;
// Work-type filters and feeds are disallowed by robots.txt even though they
// match the general shape above.
const DISALLOWED_SEGMENTS = new Set(['feed', 'fulltime', 'parttime', 'casual', 'temp', 'permanent']);
const JOB_URL_RE = /^https:\/\/www\.backpackerjobboard\.co\.nz\/job\/(\d+)\/[^"'\s<>]*$/;
const MAX_JOBS = 500;
const DETAIL_BATCH = 4;
const DETAIL_PACE_MS = 1500;
const DAY_MS = 86_400_000;

/** @param {unknown} v @param {number} dflt @param {number} min @param {number} max */
function intInRange(v, dflt, min, max) {
  return Number.isInteger(v) && /** @type {number} */ (v) >= min && /** @type {number} */ (v) <= max
    ? /** @type {number} */ (v)
    : dflt;
}

/**
 * Resolve a robots-allowed listing URL from careers_url / api. Exported for tests.
 * @param {any} entry
 * @returns {string | null}
 */
export function resolveListUrl(entry) {
  const raw = entry?.api || entry?.careers_url || '';
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!TRUSTED_HOSTS.has(u.host.toLowerCase())) return null;
  const path = u.pathname.toLowerCase();
  if (!LIST_PATH_RE.test(path)) return null;
  const segments = path.split('/').filter(Boolean);
  if (segments.some((s) => DISALLOWED_SEGMENTS.has(s))) return null;
  return `${ORIGIN}/${segments.join('/')}/`;
}

/**
 * "1d ago" / "5h ago" / "3w ago" → approximate epoch ms (relative to `now`).
 * Returns undefined for anything else.
 * @param {string} rel @param {number} now
 */
export function relativeAgeToEpoch(rel, now) {
  const m = /(\d+)\s*(m|h|d|w|mo)\b/i.exec(rel || '');
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? DAY_MS : unit === 'w' ? 7 * DAY_MS : 30 * DAY_MS;
  return now - n * ms;
}

/**
 * Parse a listing page into normalized jobs. Exported for tests.
 * @param {string} html
 * @param {number} [now]
 */
export function parseListing(html, now = Date.now()) {
  if (typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  // Each card starts at a job-title heading; slice up to the next one.
  const starts = [];
  const re = /<h3\b[^>]*class="[^"]*\bjob-title\b[^"]*"[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) starts.push(m.index);
  for (let i = 0; i < starts.length; i++) {
    const block = html.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : starts[i] + 6000);
    const linkM = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!linkM) continue;
    const url = decodeEntities(linkM[1]).trim();
    const idM = JOB_URL_RE.exec(url);
    if (!idM) continue;
    const id = idM[1];
    if (seen.has(id)) continue;
    const title = visibleText(linkM[2]);
    if (!title) continue;
    const companyM = /<p\b[^>]*class="[^"]*\bjob-company\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const locationM = /<p\b[^>]*class="[^"]*\bjob-location\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippetM = /<p\b[^>]*class="[^"]*\bjob-description\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const publishedM = /<p\b[^>]*class="[^"]*\bjob-published\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const categoryM = /<p\b[^>]*class="[^"]*\bjob-category\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    seen.add(id);
    /** @type {any} */
    const job = {
      title,
      url,
      company: companyM ? visibleText(companyM[1]) : '',
      location: locationM ? visibleText(locationM[1]).replace(/\s+,/g, ',').replace(/,\s*$/, '') : '',
      externalId: id,
    };
    const snippet = snippetM ? visibleText(snippetM[1]) : '';
    const category = categoryM ? visibleText(categoryM[1]) : '';
    if (snippet || category) job.description = [category && `Category: ${category}`, snippet].filter(Boolean).join('\n');
    const postedAt = relativeAgeToEpoch(publishedM ? visibleText(publishedM[1]) : '', now);
    if (Number.isFinite(postedAt)) job.postedAt = postedAt;
    out.push(job);
    if (out.length >= MAX_JOBS) break;
  }
  return out;
}

/**
 * Parse a /job/{id}/ detail page. Exported for tests.
 * @param {string} html
 * @returns {{ description?: string, postedAt?: number, postcode?: string, employmentType?: string }}
 */
export function parseDetail(html) {
  if (typeof html !== 'string') return {};
  /** @type {{ description?: string, postedAt?: number, postcode?: string, employmentType?: string }} */
  const out = {};
  const descM = /<div\b[^>]*itemprop="description"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  if (descM) {
    const text = htmlToText(descM[1].replace(/<br\s*\/?>/gi, '\n'));
    if (text) out.description = text;
  }
  const dateM = /itemprop="datePosted"[^>]*content="([^"]+)"/i.exec(html) || /content="([^"]+)"[^>]*itemprop="datePosted"/i.exec(html);
  if (dateM) {
    const t = Date.parse(dateM[1]);
    if (Number.isFinite(t)) out.postedAt = t;
  }
  const typeM = /itemprop="employmentType"[^>]*content="([A-Z_]+)"/i.exec(html);
  if (typeM) out.employmentType = typeM[1];
  const pcM = /itemprop="postalCode"[^>]*content="(\d{4})"/i.exec(html);
  if (pcM) out.postcode = pcM[1];
  return out;
}

/** @param {number} ms @param {any} ctx */
async function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((r) => setTimeout(r, ms));
}

/** @type {Provider} */
export default {
  id: 'backpackerjobboard',

  detect(entry) {
    if (entry?.provider && entry.provider !== 'backpackerjobboard') return null;
    const url = resolveListUrl(entry);
    return url ? { url } : null;
  },

  async fetch(entry, ctx) {
    const listUrl = resolveListUrl(entry);
    if (!listUrl) {
      throw new Error(`backpackerjobboard: entry "${entry?.name || '(unnamed)'}" needs a /jobs-in/{region}/ or /jobs/{category}/ careers_url`);
    }
    const html = await ctx.fetchText(listUrl, { headers: { accept: 'text/html' } });
    const jobs = parseListing(html);

    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    const cfg = entry?.backpackerjobboard && typeof entry.backpackerjobboard === 'object' ? entry.backpackerjobboard : {};
    if (cfg.fetchDetails !== true || probing) return jobs;

    const candidates = jobs.slice(0, intInRange(cfg.detailLimit, 25, 1, 100));
    for (let i = 0; i < candidates.length; i += DETAIL_BATCH) {
      const batch = candidates.slice(i, i + DETAIL_BATCH);
      await Promise.all(batch.map(async (job) => {
        try {
          if (!JOB_URL_RE.test(job.url)) return;
          const detail = parseDetail(await ctx.fetchText(job.url, { headers: { accept: 'text/html' } }));
          if (detail.description) job.description = detail.employmentType ? `Employment type: ${detail.employmentType}\n${detail.description}` : detail.description;
          if (Number.isFinite(detail.postedAt)) job.postedAt = detail.postedAt;
          if (detail.postcode && !job.location.includes(detail.postcode)) job.location = `${job.location} ${detail.postcode}`.trim();
        } catch {
          // Opt-in enrichment: keep the listing row on failure.
        }
      }));
      if (i + DETAIL_BATCH < candidates.length) await sleep(DETAIL_PACE_MS, ctx);
    }
    return jobs;
  },
};
