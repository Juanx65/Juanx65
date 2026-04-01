import { readFile, writeFile } from "node:fs/promises";

const README_PATH = new URL("../README.md", import.meta.url);
const username =
  process.env.GITHUB_USERNAME ||
  process.env.GITHUB_REPOSITORY?.split("/")[0] ||
  "Juanx65";
const token = process.env.GITHUB_TOKEN;

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": `${username}-profile-readme-updater`,
};

if (token) {
  headers.Authorization = `Bearer ${token}`;
}

async function fetchJson(url, requestHeaders = headers) {
  const response = await fetch(url, { headers: requestHeaders });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText} (${url})`);
  }

  return response.json();
}

function formatUtcDate(value) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function formatShortDate(value) {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function replaceSection(content, sectionName, nextContent) {
  const pattern = new RegExp(
    `<!--START_SECTION:${sectionName}-->[\\s\\S]*?<!--END_SECTION:${sectionName}-->`,
    "m",
  );

  const replacement = `<!--START_SECTION:${sectionName}-->\n${nextContent}\n<!--END_SECTION:${sectionName}-->`;

  if (!pattern.test(content)) {
    throw new Error(`Missing README markers for section "${sectionName}"`);
  }

  return content.replace(pattern, replacement);
}

function describeEvent(event) {
  const repoLink = `<a href="https://github.com/${event.repo.name}">${escapeHtml(event.repo.name)}</a>`;

  switch (event.type) {
    case "PushEvent": {
      const commits = event.payload?.size ?? event.payload?.commits?.length ?? 0;
      const commitLabel = commits === 1 ? "commit" : "commits";
      return `Pushed ${commits} ${commitLabel} to ${repoLink}`;
    }
    case "PullRequestEvent": {
      const action = event.payload?.action || "updated";
      const number = event.payload?.number ? `#${event.payload.number}` : "a PR";
      return `${capitalize(action)} pull request ${number} in ${repoLink}`;
    }
    case "IssuesEvent": {
      const action = event.payload?.action || "updated";
      const number = event.payload?.issue?.number ? `#${event.payload.issue.number}` : "an issue";
      return `${capitalize(action)} issue ${number} in ${repoLink}`;
    }
    case "IssueCommentEvent": {
      const number = event.payload?.issue?.number ? `#${event.payload.issue.number}` : "an issue";
      return `Commented on ${number} in ${repoLink}`;
    }
    case "CreateEvent": {
      const refType = event.payload?.ref_type || "resource";
      const refName = event.payload?.ref ? ` <code>${escapeHtml(event.payload.ref)}</code>` : "";
      return `Created ${refType}${refName} in ${repoLink}`;
    }
    case "DeleteEvent": {
      const refType = event.payload?.ref_type || "resource";
      const refName = event.payload?.ref ? ` <code>${escapeHtml(event.payload.ref)}</code>` : "";
      return `Deleted ${refType}${refName} in ${repoLink}`;
    }
    case "ReleaseEvent": {
      const tag = event.payload?.release?.tag_name ? ` <code>${escapeHtml(event.payload.release.tag_name)}</code>` : "";
      return `Published release${tag} in ${repoLink}`;
    }
    case "ForkEvent":
      return `Forked ${repoLink}`;
    case "WatchEvent":
      return `Starred ${repoLink}`;
    default:
      return `${event.type.replace(/Event$/, "")} on ${repoLink}`;
  }
}

function capitalize(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildOverview(user, repos) {
  const publicRepos = repos.filter((repo) => !repo.fork);
  const totalStars = publicRepos.reduce((sum, repo) => sum + repo.stargazers_count, 0);
  const primaryLanguages = [...new Map(
    publicRepos
      .filter((repo) => repo.language)
      .sort((left, right) => new Date(right.updated_at) - new Date(left.updated_at))
      .map((repo) => [repo.language, repo.language]),
  ).keys()]
    .slice(0, 5)
    .join(", ") || "Not enough language data yet";

  const latestRepo = publicRepos
    .slice()
    .sort((left, right) => new Date(right.updated_at) - new Date(left.updated_at))[0];

  const rows = [
    ["Public repos", user.public_repos],
    ["Followers", user.followers],
    ["Following", user.following],
    ["Total stars", totalStars],
    ["Top stack", primaryLanguages],
    ["Latest repo", latestRepo ? latestRepo.name : "No public repositories yet"],
  ];

  return [
    "<table>",
    ...rows.map(
      ([label, value]) =>
        `  <tr><td><strong>${escapeHtml(label)}</strong></td><td align="right"><code>${escapeHtml(value)}</code></td></tr>`,
    ),
    "</table>",
    `<p><sub>Updated ${escapeHtml(formatUtcDate(new Date().toISOString()))} UTC</sub></p>`,
  ].join("\n");
}

function toFeaturedRepoRow(repo) {
  const description = repo.description?.trim() || "No description yet.";
  const language = repo.language || "Mixed";

  return [
    "  <tr>",
    `    <td valign="top"><strong><a href="${repo.html_url}">${escapeHtml(repo.name)}</a></strong><br/><sub>${escapeHtml(description)}</sub></td>`,
    `    <td valign="top" align="right"><code>${escapeHtml(language)}</code><br/><sub>${repo.stargazers_count} stars</sub><br/><sub>updated ${escapeHtml(formatShortDate(repo.updated_at))}</sub></td>`,
    "  </tr>",
  ].join("\n");
}

function buildFeaturedRepos(repos) {
  const featured = repos
    .filter((repo) => !repo.fork && repo.name.toLowerCase() !== username.toLowerCase())
    .sort((left, right) => {
      if (right.stargazers_count !== left.stargazers_count) {
        return right.stargazers_count - left.stargazers_count;
      }

      return new Date(right.updated_at) - new Date(left.updated_at);
    })
    .slice(0, 4);

  if (featured.length === 0) {
    return "<p><sub>Add public repositories to show featured work here.</sub></p>";
  }

  return [
    "<table>",
    ...featured.map(toFeaturedRepoRow),
    "</table>",
  ].join("\n");
}

function toActivityRow(event) {
  return [
    "  <tr>",
    `    <td valign="top"><strong>${describeEvent(event)}</strong></td>`,
    `    <td valign="top" align="right"><sub>${escapeHtml(formatShortDate(event.created_at))}</sub></td>`,
    "  </tr>",
  ].join("\n");
}

function buildRecentActivity(events) {
  const visibleEvents = events
    .filter((event) => !["PublicEvent"].includes(event.type))
    .slice(0, 5);

  if (visibleEvents.length === 0) {
    return "<p><sub>No recent public activity available yet.</sub></p>";
  }

  return [
    "<table>",
    ...visibleEvents.map(toActivityRow),
    "</table>",
  ].join("\n");
}

async function main() {
  const [user, repos, events] = await Promise.all([
    fetchJson(`https://api.github.com/users/${username}`),
    fetchJson(`https://api.github.com/users/${username}/repos?per_page=100&sort=updated`),
    fetchJson(`https://api.github.com/users/${username}/events/public?per_page=10`),
  ]);

  const originalReadme = await readFile(README_PATH, "utf8");

  let nextReadme = originalReadme;
  nextReadme = replaceSection(nextReadme, "profile-overview", buildOverview(user, repos));
  nextReadme = replaceSection(nextReadme, "featured-repos", buildFeaturedRepos(repos));
  nextReadme = replaceSection(nextReadme, "recent-activity", buildRecentActivity(events));

  if (nextReadme !== originalReadme) {
    await writeFile(README_PATH, nextReadme, "utf8");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
