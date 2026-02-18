// rss-action — src/index.js
// Fetches RSS/Atom feeds, appends new links to a markdown file with UTM
// parameters, enforces a configurable max-link cap, and opens a PR.

'use strict';

const core   = require('@actions/core');
const ghLib  = require('@actions/github');
const exec   = require('@actions/exec');
const Parser = require('rss-parser');
const fs     = require('fs');
const path   = require('path');

// ─── Constants ───────────────────────────────────────────────────────────────

const MARKER_START = '<!-- rss-action:start -->';
const MARKER_END   = '<!-- rss-action:end -->';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Read an action input from the env var GitHub Actions sets automatically. */
function getInput(name, required = false) {
  const key = `INPUT_${name.toUpperCase().replace(/-/g, '_')}`;
  const val = (process.env[key] || '').trim();
  if (required && !val) throw new Error(`Required input "${name}" is missing.`);
  return val;
}

/** Today as YYYY-MM-DD. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Append UTM parameters to a URL.
 * utm_source = platform  → always "github"
 * utm_medium = org/owner → GitHub organisation or user
 * utm_campaign = repo    → repository name
 */
function addUTM(rawUrl, owner, repo) {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set('utm_source',   'github');
    url.searchParams.set('utm_medium',   owner);
    url.searchParams.set('utm_campaign', repo);
    return url.toString();
  } catch {
    // Non-parseable URL — return as-is rather than crashing.
    return rawUrl;
  }
}

/** Strip UTM params so we can deduplicate across runs. */
function stripUTM(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.searchParams.delete('utm_source');
    url.searchParams.delete('utm_medium');
    url.searchParams.delete('utm_campaign');
    return url.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Parse the managed section out of a file's content.
 * Returns { before, after, links[] } where links are ordered newest→oldest.
 * If no markers are present, the entire content becomes "before" so the
 * managed section will be appended.
 */
function parseSection(content) {
  const si = content.indexOf(MARKER_START);
  const ei = content.indexOf(MARKER_END);

  if (si === -1 || ei === -1 || si >= ei) {
    // No valid markers — append section at end.
    const trimmed = content.trimEnd();
    return {
      before: trimmed ? trimmed + '\n\n' : '',
      after:  '\n',
      links:  [],
    };
  }

  const sectionBody = content.slice(si + MARKER_START.length, ei);
  const links  = [];
  // Matches:  - [title](url) - YYYY-MM-DD
  const lineRe = /^- \[(.+?)\]\(([^)]+)\)(?: - (\d{4}-\d{2}-\d{2}))?/gm;
  let m;
  while ((m = lineRe.exec(sectionBody)) !== null) {
    links.push({ title: m[1], url: m[2], date: m[3] || today() });
  }

  return {
    before: content.slice(0, si),
    after:  content.slice(ei + MARKER_END.length),
    links,
  };
}

/** Render the managed section as a markdown string. */
function renderSection(links) {
  const lines = links.map(l => `- [${l.title}](${l.url}) - ${l.date}`);
  const body  = lines.length ? '\n' + lines.join('\n') + '\n' : '\n';
  return `${MARKER_START}${body}${MARKER_END}`;
}

/** Sanitise a feed item title so it doesn't break markdown links. */
function sanitiseTitle(raw) {
  return (raw || 'Untitled')
    .replace(/[\[\]]/g, '')   // strip brackets
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  // 1. Read inputs ────────────────────────────────────────────────────────────
  const rssUrlsRaw  = getInput('rss_urls',      true);
  const maxLinks    = Math.max(1, parseInt(getInput('max_links')    || '10', 10));
  const outputFile  = getInput('output_file')  || 'links.md';
  const token       = getInput('github_token',  true);
  const branchPfx   = getInput('branch_prefix') || 'rss-update';
  const baseBranch  = getInput('base_branch')   || 'main';

  const rssUrls = rssUrlsRaw
    .split(/[\n,]+/)
    .map(u => u.trim())
    .filter(Boolean);

  if (rssUrls.length === 0) {
    core.setFailed('No RSS URLs provided.');
    return;
  }

  core.info(`max_links=${maxLinks}  output_file=${outputFile}  base_branch=${baseBranch}`);

  const { context } = ghLib;
  const octokit     = ghLib.getOctokit(token);
  const { owner, repo } = context.repo;

  // 2. Fetch feeds ────────────────────────────────────────────────────────────
  const parser     = new Parser({ timeout: 15_000 });
  const freshItems = [];

  for (const feedUrl of rssUrls) {
    try {
      core.info(`Fetching: ${feedUrl}`);
      const feed  = await parser.parseURL(feedUrl);
      const items = (feed.items || []).slice(0, 20); // max 20 per feed per run

      for (const item of items) {
        const link = item.link || item.guid;
        if (!link) continue;

        freshItems.push({
          title: sanitiseTitle(item.title),
          url:   link,
          date:  item.pubDate
            ? new Date(item.pubDate).toISOString().slice(0, 10)
            : today(),
        });
      }

      core.info(`  ✓ "${feed.title || feedUrl}" — ${items.length} item(s)`);
    } catch (err) {
      core.warning(`  ✗ Failed to fetch "${feedUrl}": ${err.message}`);
    }
  }

  if (freshItems.length === 0) {
    core.info('No items fetched from any feed. Exiting without creating a PR.');
    core.setOutput('pr_url',          '');
    core.setOutput('new_items_count', '0');
    return;
  }

  // 3. Apply UTM parameters ───────────────────────────────────────────────────
  for (const item of freshItems) {
    item.url = addUTM(item.url, owner, repo);
  }

  // 4. Read the existing output file ─────────────────────────────────────────
  const filePath = path.resolve(process.cwd(), outputFile);
  let existingContent = '';

  if (fs.existsSync(filePath)) {
    existingContent = fs.readFileSync(filePath, 'utf8');
  } else {
    core.info(`"${outputFile}" not found — it will be created.`);
    existingContent = `# RSS Links\n\n${MARKER_START}\n${MARKER_END}\n`;
  }

  const { before, after, links: existingLinks } = parseSection(existingContent);

  // 5. Deduplicate ────────────────────────────────────────────────────────────
  const existingBaseUrls = new Set(existingLinks.map(l => stripUTM(l.url)));

  const newItems = freshItems.filter(
    item => !existingBaseUrls.has(stripUTM(item.url))
  );

  if (newItems.length === 0) {
    core.info('All fetched items already exist in the file — nothing to update.');
    core.setOutput('pr_url',          '');
    core.setOutput('new_items_count', '0');
    return;
  }

  core.info(`${newItems.length} new item(s) to add.`);

  // 6. Merge & enforce max_links ─────────────────────────────────────────────
  // New items prepended (newest first), then existing, then oldest trimmed.
  let allLinks = [...newItems, ...existingLinks];
  let removedCount = 0;

  if (allLinks.length > maxLinks) {
    removedCount = allLinks.length - maxLinks;
    core.info(`Trimming ${removedCount} oldest link(s) to enforce max_links=${maxLinks}`);
    allLinks = allLinks.slice(0, maxLinks);
  }

  // 7. Write the updated file ─────────────────────────────────────────────────
  const newContent = before + renderSection(allLinks) + after;
  const fileDir    = path.dirname(filePath);
  if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
  fs.writeFileSync(filePath, newContent, 'utf8');
  core.info(`Wrote ${allLinks.length} link(s) to "${outputFile}".`);

  // 8. Git: configure, branch, commit, push ──────────────────────────────────
  const ts         = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const branchName = `${branchPfx}/${ts}`;

  // Authenticate pushes via HTTPS token
  const remoteUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

  await exec.exec('git', ['config', '--local', 'user.email',
    '41898282+github-actions[bot]@users.noreply.github.com']);
  await exec.exec('git', ['config', '--local', 'user.name', 'github-actions[bot]']);
  await exec.exec('git', ['remote', 'set-url', 'origin', remoteUrl]);
  await exec.exec('git', ['checkout', '-b', branchName]);
  await exec.exec('git', ['add', outputFile]);
  await exec.exec('git', ['commit', '-m',
    `chore(rss): add ${newItems.length} new link(s) [automated]`]);
  await exec.exec('git', ['push', '--set-upstream', 'origin', branchName]);

  // 9. Open a pull request ───────────────────────────────────────────────────
  const newLinkLines = newItems
    .map(i => `- [${i.title}](${i.url})`)
    .join('\n');

  const removedNote = removedCount > 0
    ? `\n> Removed **${removedCount}** oldest link(s) to stay within \`max_links: ${maxLinks}\`.`
    : '';

  const prBody = [
    '## RSS Feed Update',
    '',
    `Added **${newItems.length}** new link(s) from RSS feeds.${removedNote}`,
    '',
    '### New links',
    newLinkLines,
    '',
    '---',
    `_Automatically created by [rss-action](https://github.com/${owner}/${repo})_`,
  ].join('\n');

  const { data: pr } = await octokit.rest.pulls.create({
    owner,
    repo,
    title: `chore(rss): ${newItems.length} new link(s) — ${ts.slice(0, 10)}`,
    head:  branchName,
    base:  baseBranch,
    body:  prBody,
  });

  core.info(`Pull request created: ${pr.html_url}`);
  core.setOutput('pr_url',          pr.html_url);
  core.setOutput('new_items_count', String(newItems.length));
}

run().catch(err => core.setFailed(err.message));
