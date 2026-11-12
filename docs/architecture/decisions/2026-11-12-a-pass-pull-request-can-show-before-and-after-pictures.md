# A pass's pull request can show before and after pictures, when the project opts in

- **Date:** 2026-11-12
- **Amends:** `decisions/2026-11-10-task-pictures-come-from-a-pinned-chromium-and-stay-on-the-mac.md` (pictures
  stay on the Mac unless the project turns this on)

## Decision

A project setting, **Pictures in pull requests** (`projects.pr_pictures`), off by default. When it is on,
each time 10db writes a pass's pull request body:

- It takes each signed-off page's first before and last after, per route, in the first viewport and theme
  the route was pictured in (`delivery/pr-pictures.ts`).
- It makes a commit of those files alone, with no parent and never signed. The commit's author and committer
  are the signed-in account's GitHub no-reply address (`<id>+<login>@users.noreply.github.com`, from
  `gh api user`). It force-pushes that commit to `10db-pictures/<pass id>` on origin. The checkout, its index
  and the pass's branch are untouched.
- The body gets a Pictures section: before beside after for each page, linked as
  `https://github.com/<repo>/blob/<sha>/<file>?raw=true`.

A failure anywhere in that is logged, and the pull request goes out without the section. It works the same
on every account kind, since only git and gh are involved.

## Why

The builder wants a pull request to show what each page looked like before and after. Two checks on a
private repository, made by hand on 2026-11-12, settled the design:

- An image on a side branch, linked by `blob/<sha>/<file>?raw=true` or `raw/<sha>/<file>`, renders in an issue
  body for a collaborator. GitHub has no API for the drag-and-drop upload, and `raw.githubusercontent.com`
  does not serve private repositories.
- A push of a commit whose email is the account's private address is refused (`GH007`) when the account keeps
  its email private. So the commit uses the no-reply address.

The pictures don't go on the pass's branch, because they would merge into the base. One branch per pass,
replaced on each push, keeps every pull request's links working without a history of every rewrite.

It is off by default because a picture can show the app's own data, and anyone who can see the repository can
see the branch.
