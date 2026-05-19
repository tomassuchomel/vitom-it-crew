// Tenký wrapper kolem GitHub REST API – jen pro vytvoření draft PR.
//
// Žádné externí dependencies (octokit by tahly hodně kódu pro jednu operaci).
// Token nikdy nelogujeme; sanitace v activityLogu pak zachytí, kdyby se omylem
// dostal do details.

const GITHUB_API = 'https://api.github.com';

/**
 * @typedef {Object} PullRequest
 * @property {number} number
 * @property {string} html_url
 * @property {string} title
 * @property {string} state
 */

/**
 * Vytvoří draft Pull Request.
 * @param {Object} opts
 * @param {string} opts.token   GitHub PAT s repo:write
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} opts.head    branch s commity (např. "claude/task-42")
 * @param {string} opts.base    cílový branch (typicky "main")
 * @param {string} opts.title
 * @param {string} opts.body    plný markdown
 * @param {boolean} [opts.draft=true]
 * @returns {Promise<PullRequest>}
 */
export async function createPullRequest({ token, owner, repo, head, base, title, body, draft = true }) {
  if (!token) throw new Error('createPullRequest: chybí GitHub token');
  if (!owner || !repo) throw new Error('createPullRequest: chybí owner/repo');
  if (!head || !base) throw new Error('createPullRequest: chybí head/base');
  if (!title) throw new Error('createPullRequest: chybí title');

  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body, head, base, draft }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = await res.json();
  return {
    number: json.number,
    html_url: json.html_url,
    title: json.title,
    state: json.state,
  };
}

/**
 * Vytáhne {owner, repo} z git remote URL.
 * Podporuje:
 *   – https://github.com/owner/repo.git
 *   – https://github.com/owner/repo
 *   – git@github.com:owner/repo.git
 * @param {string} url
 * @returns {{ owner: string, repo: string }}
 */
export function parseGitHubRemote(url) {
  if (typeof url !== 'string') throw new Error('parseGitHubRemote: URL musí být string');
  const httpsMatch = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(\.git)?\/?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  throw new Error(`parseGitHubRemote: nepodařilo se odvodit owner/repo z URL "${url}"`);
}
