import type { PostLink, TaskPostFacts } from './slack-task-facts';

// The words of a pictures post, for the builder's teammates in the project's channel: who did what, why,
// how it went, and one link to dig in (the Linear issue, the pull request). Every value is escaped, and a
// link is always `<url|label>`, never a bare address.

/** The most pages a pass's post lists by name; the rest are counted. */
const MAX_LISTED_PAGES = 10;

/** A skip's reason is cut here, so a post with no pictures stays within the 3,000 characters a Slack section holds. */
const MAX_REASON_CHARS = 300;

/** Slack reads these three characters as markup. */
const escapeSlack = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** An address as it goes inside `<…|…>`: the characters that would end or split the link are encoded. */
const linkUrl = (url: string): string =>
  url.replace(/\|/g, '%7C').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/\s/g, '%20');

/** A Slack link with an escaped label. */
const slackLink = (url: string, label: string): string => `<${linkUrl(url)}|${escapeSlack(label)}>`;

/** A branch name in a code span; a backtick would close it early. */
const branchCode = (branch: string): string => `\`${escapeSlack(branch.replace(/`/g, ''))}\``;

/** `PR #12` for a GitHub pull request's address, else `the pull request`. */
function prLabel(url: string): string {
  const number = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url)?.[1];
  return number === undefined ? 'the pull request' : `PR #${number}`;
}

const issueLink = (link: PostLink | null): string =>
  link === null ? '' : `${slackLink(link.url, link.id)} `;

/** The headline: project, issue, task and where it landed. */
function headline(project: string, title: string, facts: TaskPostFacts): string {
  const parts = [`*${escapeSlack(project)}*`, `${issueLink(facts.link)}*${escapeSlack(title)}*`];
  const landing = facts.landing;
  if (landing !== null)
    switch (landing.kind) {
      case 'pull_request':
        parts.push(
          `${slackLink(landing.url, prLabel(landing.url))} ${landing.merged ? 'merged' : 'opened'}`,
        );
        break;
      case 'branch':
        parts.push(`landed on ${branchCode(landing.branch)}`);
        break;
    }
  return parts.join(' · ');
}

/** The one-line how-it-went: runs, review, checks and commit, each only when recorded. */
function contextLine(facts: TaskPostFacts): string | null {
  const parts = [
    ...(facts.runs > 0 ? [`${String(facts.runs)} ${facts.runs === 1 ? 'run' : 'runs'}`] : []),
    ...(facts.reviewApproved ? ['review approved'] : []),
    ...(facts.checks === null ? [] : [`checks ${facts.checks}`]),
    ...(facts.commit === null ? [] : [`commit \`${facts.commit}\``]),
  ];
  return parts.length === 0 ? null : parts.join(' · ');
}

/** The task's why as one italic line; null when it has none. */
function whyLine(why: string): string | null {
  const line = why.replace(/\s+/g, ' ').trim();
  return line === '' ? null : `_${escapeSlack(line)}_`;
}

/** A reason that reads on after a colon: one line, cut to length, its first letter lowercased unless it starts a word in capitals. */
function continued(reason: string): string {
  const line = reason.replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
  const cut = line.length > MAX_REASON_CHARS ? `${line.slice(0, MAX_REASON_CHARS - 1)}…` : line;
  return /^[A-Z][a-z]/.test(cut) ? cut.charAt(0).toLowerCase() + cut.slice(1) : cut;
}

export interface TaskPostText {
  readonly project: string;
  readonly title: string;
  readonly why: string;
  readonly facts: TaskPostFacts;
}

/** A finished task's post: headline, why, how it went, and a line about its pictures when one is owed. */
export function taskPostText(
  input: TaskPostText,
  pictures: { readonly more: number } | { readonly skipped: string },
): string {
  const tail =
    'skipped' in pictures
      ? `No before and after pictures: ${escapeSlack(continued(pictures.skipped))}.`
      : pictures.more > 0
        ? `${String(pictures.more)} more ${pictures.more === 1 ? 'picture is' : 'pictures are'} in 10db.`
        : null;
  return [
    headline(input.project, input.title, input.facts),
    whyLine(input.why),
    contextLine(input.facts),
    tail,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/** A pass's post: the pull request, then each signed-off page with its issue. */
export function passPostText(input: {
  readonly project: string;
  readonly pass: string;
  readonly url: string;
  readonly pages: readonly { readonly title: string; readonly link: PostLink | null }[];
  readonly more: number;
}): string {
  const count = input.pages.length;
  const hidden = count - MAX_LISTED_PAGES;
  return [
    `*${escapeSlack(input.project)}* · *${escapeSlack(input.pass)}* · ${slackLink(input.url, prLabel(input.url))} opened`,
    `${String(count)} ${count === 1 ? 'page' : 'pages'} signed off:`,
    ...input.pages
      .slice(0, MAX_LISTED_PAGES)
      .map((page) => `• ${issueLink(page.link)}${escapeSlack(page.title)}`),
    ...(hidden > 0 ? [`• and ${String(hidden)} more`] : []),
    ...(input.more > 0
      ? [
          `${String(input.more)} more ${input.more === 1 ? 'picture is' : 'pictures are'} in the pull request.`,
        ]
      : []),
  ].join('\n');
}
