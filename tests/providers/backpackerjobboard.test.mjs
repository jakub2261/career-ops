// tests/providers/backpackerjobboard.test.mjs — Backpacker Job Board (NZ) listing + detail parser.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — backpackerjobboard (NZ listing + detail parser)');
try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/backpackerjobboard.mjs')).href);
  const bjb = mod.default;
  const { resolveListUrl, parseListing, parseDetail, relativeAgeToEpoch } = mod;

  if (bjb.id === 'backpackerjobboard') pass('backpackerjobboard.id is "backpackerjobboard"');
  else fail(`backpackerjobboard.id is ${JSON.stringify(bjb.id)}`);

  // resolveListUrl — only robots-allowed listing shapes on the board host.
  const ok = resolveListUrl({ careers_url: 'http://backpackerjobboard.co.nz/jobs-in/South-Island' });
  if (ok === 'https://www.backpackerjobboard.co.nz/jobs-in/south-island/') pass('resolveListUrl() normalizes host, scheme, case and trailing slash');
  else fail(`resolveListUrl() normalization wrong: ${ok}`);
  if (resolveListUrl({ careers_url: 'https://www.backpackerjobboard.co.nz/jobs/farm-jobs/' }) === 'https://www.backpackerjobboard.co.nz/jobs/farm-jobs/') pass('resolveListUrl() accepts a category listing');
  else fail('resolveListUrl() should accept /jobs/{category}/');
  const disallowed = [
    'https://www.backpackerjobboard.co.nz/jobs-in/queenstown/fulltime/',
    'https://www.backpackerjobboard.co.nz/jobs-in/queenstown/feed/',
    'https://www.backpackerjobboard.co.nz/search/?q=farm',
    'https://www.backpackerjobboard.co.nz/post/',
  ];
  if (disallowed.every((u) => resolveListUrl({ careers_url: u }) === null)) pass('resolveListUrl() refuses robots-disallowed paths');
  else fail('resolveListUrl() should refuse robots-disallowed paths');
  if (bjb.detect({ careers_url: 'https://evil.com/www.backpackerjobboard.co.nz/jobs-in/x/' }) === null
    && bjb.detect({ careers_url: 'https://www.backpackerjobboard.co.nz.evil.com/jobs-in/x/' }) === null) {
    pass('detect() rejects spoofed hosts');
  } else {
    fail('detect() should reject spoofed hosts');
  }
  if (bjb.detect({ provider: 'greenhouse', careers_url: 'https://www.backpackerjobboard.co.nz/jobs-in/x/' }) === null) pass('detect() leaves an entry pinned to another provider alone');
  else fail('detect() should not claim an entry pinned to another provider');

  // parseListing — one row per job-title card.
  const card = (id, title, company, town, region, snippet, ago) => `
    <div class="grid-x job-entry"><div class="cell"><div class="job-meta">
      <h3 class="job-title"><a href="https://www.backpackerjobboard.co.nz/job/${id}/slug-${id}/" title="${title}"><span>${title}</span></a></h3>
      <p class="job-company"><span><span>${company}</span></span></p>
      <p class="job-location"><span><span><span>${town}</span>, <span >${region}</span></span></span></p>
      <p class="job-description show-for-medium"><span>${snippet}</span></p>
    </div></div>
    <div class="cell"><p class="job-published show-for-medium">${ago} <span class="job-new">New</span></p>
    <p class="job-category"><span>Farm Jobs</span></p></div></div>`;
  const now = Date.UTC(2026, 9, 29);
  const html = '<html>' + card(5340, 'Housekeeper/host', 'Van Loggenberg', 'Franz Josef', 'West Coast', 'Busy hostel &amp; cafe', '1d ago')
    + card(5338, 'Lavender &#8211; Picker', 'Pukaki Downs', 'Lake Pukaki', '', 'Weeding', '2w ago')
    + card(5340, 'Duplicate', 'X', 'Y', 'Z', '', '1d ago') + '</html>';
  const rows = parseListing(html, now);
  if (rows.length === 2) pass('parseListing() yields one row per posting id (duplicates dropped)');
  else fail(`parseListing() returned ${rows.length}, expected 2`);
  const r0 = rows[0];
  if (r0?.title === 'Housekeeper/host' && r0.company === 'Van Loggenberg' && r0.location === 'Franz Josef, West Coast' && r0.externalId === '5340') {
    pass('parseListing() reads title, company, location and id');
  } else {
    fail(`parseListing() row wrong: ${JSON.stringify(r0)}`);
  }
  if (r0?.description?.includes('Busy hostel & cafe') && r0.description.includes('Category: Farm Jobs')) pass('parseListing() keeps the decoded snippet and category');
  else fail(`parseListing() snippet wrong: ${JSON.stringify(r0?.description)}`);
  if (r0?.postedAt === now - 86_400_000) pass('parseListing() maps "1d ago" to postedAt');
  else fail(`parseListing() postedAt wrong: ${r0?.postedAt}`);
  if (rows[1]?.title === 'Lavender – Picker' && rows[1].location === 'Lake Pukaki') pass('parseListing() decodes entities and drops an empty region');
  else fail(`parseListing() second row wrong: ${JSON.stringify(rows[1])}`);
  if (parseListing('<html>nothing</html>').length === 0 && parseListing(undefined).length === 0) pass('parseListing() returns [] for job-less / non-string input');
  else fail('parseListing() should return [] without jobs');
  if (relativeAgeToEpoch('yesterday', now) === undefined) pass('relativeAgeToEpoch() ignores unknown formats');
  else fail('relativeAgeToEpoch() should ignore unknown formats');

  // parseDetail — full description, datePosted, postcode, employment type.
  const detailHtml = `<meta itemprop="datePosted" content="2026-10-25 18:21:06" />
    <meta itemprop="employmentType" content="FULL_TIME" />
    <meta itemprop="postalCode" content="7580" />
    <div itemprop="description"><p>November start<br />Accommodation &amp; meals</p></div>`;
  const d = parseDetail(detailHtml);
  if (d.description === 'November start Accommodation & meals' && d.postcode === '7580' && d.employmentType === 'FULL_TIME' && Number.isFinite(d.postedAt)) {
    pass('parseDetail() reads description, datePosted, postcode and employment type');
  } else {
    fail(`parseDetail() wrong: ${JSON.stringify(d)}`);
  }

  // fetch — one listing request; details only when opted in and not probing.
  let calls = 0;
  const ctx = { fetchText: async (u) => { calls++; return u.includes('/job/') ? detailHtml : html; }, sleep: async () => {} };
  const plain = await bjb.fetch({ name: 'BJB', careers_url: 'https://www.backpackerjobboard.co.nz/jobs-in/south-island/' }, ctx);
  if (plain.length === 2 && calls === 1) pass('fetch() makes a single listing request by default');
  else fail(`fetch() default made ${calls} requests for ${plain.length} jobs`);
  calls = 0;
  const rich = await bjb.fetch({ name: 'BJB', careers_url: 'https://www.backpackerjobboard.co.nz/jobs-in/south-island/', backpackerjobboard: { fetchDetails: true, detailLimit: 1 } }, ctx);
  if (calls === 2 && rich[0].description.startsWith('Employment type: FULL_TIME') && rich[0].location.endsWith('7580')) pass('fetch() enriches up to detailLimit postings when fetchDetails is on');
  else fail(`fetch() enrichment wrong: calls=${calls} ${JSON.stringify(rich[0])}`);
  calls = 0;
  await bjb.fetch({ name: 'BJB', careers_url: 'https://www.backpackerjobboard.co.nz/jobs-in/south-island/', backpackerjobboard: { fetchDetails: true } }, { ...ctx, maxPages: 1 });
  if (calls === 1) pass('fetch() skips detail requests while probing');
  else fail(`fetch() should skip details while probing, made ${calls} requests`);
} catch (e) {
  fail(`backpackerjobboard provider tests crashed: ${e.message}`);
}
