import 'dotenv/config';
import { Octokit } from '@octokit/rest';
import { pathToFileURL } from 'node:url';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

export async function gatherActivity() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const owner = process.env.REPO_OWNER;
  const repo = process.env.REPO_NAME;

  const [pullsResp, commitsResp] = await Promise.all([
    octokit.pulls.list({
      owner,
      repo,
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: 20,
    }),
    octokit.repos.listCommits({
      owner,
      repo,
      since,
      per_page: 30,
    }),
  ]);

  const recentPulls = pullsResp.data.filter(
    (p) => new Date(p.updated_at) > new Date(since),
  );

  return {
    timestamp: new Date().toISOString(),
    window_hours: 24,
    repo: `${owner}/${repo}`,
    pulls: recentPulls.map((p) => ({
      number: p.number,
      title: p.title,
      author: p.user.login,
      state: p.state,
      merged: p.merged_at !== null,
      url: p.html_url,
      updated: p.updated_at,
    })),
    commits: commitsResp.data.map((c) => ({
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split('\n')[0],
      author: c.commit.author.name,
      date: c.commit.author.date,
    })),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await gatherActivity();
  console.log(JSON.stringify(data, null, 2));
}
