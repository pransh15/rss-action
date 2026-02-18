# rss-action

A GitHub Action that polls RSS/Atom feeds every 6 hours, appends new blog and
newsletter links (with UTM tracking parameters) to a markdown file, enforces a
configurable link-count cap, and opens a pull request with the diff.

---

## Features

| | |
|---|---|
| **Scheduled polling** | Runs every 6 hours via `cron: '0 */6 * * *'` |
| **Multi-feed support** | Accept any number of RSS or Atom feed URLs |
| **UTM parameters** | Automatically appended to every link |
| **Deduplication** | Already-tracked links are never added twice |
| **Max-link cap** | Configurable (default `10`); oldest entries are removed when exceeded |
| **Auto PR** | Opens a pull request for every batch of new links |

---

## UTM Parameters

The action appends the following UTM parameters to every link:

| Parameter | Value | Purpose |
|---|---|---|
| `utm_source` | `github` | Platform |
| `utm_medium` | `<owner>` | GitHub org or user that owns the repo |
| `utm_campaign` | `<repo>` | Repository name |

Example:
```
https://example.com/post?utm_source=github&utm_medium=my-org&utm_campaign=my-repo
```

---

## Quick Start

### 1. Add the workflow to your repo

Create `.github/workflows/rss-fetch.yml`:

```yaml
name: Fetch RSS Feeds

on:
  schedule:
    - cron: '0 */6 * * *'   # 00:00 / 06:00 / 12:00 / 18:00 UTC
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  rss-to-pr:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: <your-org>/rss-action@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          rss_urls: |
            https://github.blog/feed/
            https://css-tricks.com/feed/
          max_links: 10
          output_file: links.md
          base_branch: main
```

### 2. That's it

On first run the action creates `links.md` (if it doesn't exist), wraps its
managed section in HTML comment markers, and opens a PR.

---

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `github_token` | **yes** | — | Token used to push branches and open PRs. Use `${{ secrets.GITHUB_TOKEN }}` or a PAT if you need cross-repo access or want the PR to trigger other workflows. |
| `rss_urls` | **yes** | — | Newline- or comma-separated list of RSS/Atom feed URLs. |
| `max_links` | no | `10` | Maximum number of links kept in the file. Oldest entries are dropped when this is exceeded. Set to `5` for a tighter list. |
| `output_file` | no | `links.md` | Repo-relative path to the markdown file that receives the link list. |
| `branch_prefix` | no | `rss-update` | Prefix for auto-created branch names. |
| `base_branch` | no | `main` | PR target branch. |

## Outputs

| Output | Description |
|---|---|
| `pr_url` | HTML URL of the opened PR, or empty string if nothing changed. |
| `new_items_count` | Number of new links added in the run. |

---

## Markdown File Format

The action manages a fenced section inside the markdown file using HTML comment
markers. Everything outside the markers is left untouched.

```markdown
# My Reading List

Some intro text you can write freely here.

<!-- rss-action:start -->
- [Post title](https://example.com/post?utm_source=github&utm_medium=org&utm_campaign=repo) - 2025-06-01
- [Another post](https://example.com/other?utm_source=github&utm_medium=org&utm_campaign=repo) - 2025-05-28
<!-- rss-action:end -->

Footer content also untouched.
```

If the markers are absent, the managed section is appended to the end of the
file (and the markers are inserted on first run).

---

## How the cap works

```
Run 1: 3 items fetched, 0 existing → 3 total  (cap: 5)  → no trim
Run 2: 4 items fetched, 3 existing → 7 total  (cap: 5)  → trim 2 oldest → 5 kept
Run 3: 0 new unique items          → no change, no PR opened
```

The oldest entries (bottom of the list) are removed first to keep the list
fresh and within the configured limit.

---

## Using a PAT instead of GITHUB_TOKEN

`GITHUB_TOKEN` cannot trigger other workflows (e.g. CI on the PR). If you need
that, create a [fine-grained PAT](https://github.com/settings/tokens) with
**Contents** (read & write) and **Pull requests** (read & write) scopes, store
it as a repository secret (e.g. `RSS_PAT`), and use it instead:

```yaml
- uses: actions/checkout@v4
  with:
    token: ${{ secrets.RSS_PAT }}

- uses: <your-org>/rss-action@v1
  with:
    github_token: ${{ secrets.RSS_PAT }}
    ...
```

---

## Development

```bash
# Install dependencies
npm install

# Syntax-check the source
npm run lint

# (Optional) bundle into dist/ for a JavaScript action distribution
npm run build
```

Dependencies: [`@actions/core`](https://github.com/actions/toolkit/tree/main/packages/core), [`@actions/exec`](https://github.com/actions/toolkit/tree/main/packages/exec), [`@actions/github`](https://github.com/actions/toolkit/tree/main/packages/github), [`rss-parser`](https://github.com/rbren/rss-parser).

---

## License

MIT
