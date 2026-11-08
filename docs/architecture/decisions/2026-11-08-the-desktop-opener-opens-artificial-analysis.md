# The desktop opener opens Artificial Analysis's site

- **Date:** 2026-11-08
- **Amends:** `decisions/2026-11-06-connect-signs-an-account-in-from-the-app.md`, whose allow list gained
  `https://auth.openai.com/*` "and nothing wider"

## Decision

The desktop window's opener capability (`apps/desktop/src-tauri/capabilities/default.json`, `opener:allow-open-url`)
allows `https://artificialanalysis.ai/*` beside `https://github.com/*` and `https://auth.openai.com/*`.
`tests/repo/src/desktop-opener.test.ts` lists every site the opener may open, so a widening shows in its diff.

## Why

Artificial Analysis's terms ask for a linked credit beside every view of its scores (decision 65). In the Tauri
window the link could not open: the opener refused the host, and the credit showed its address in brackets for the
builder to copy. The host is fixed and the page is AA's public site.

What else can now reach the opener on that host: the task drawer's check link (`ciLink`) comes from the daemon
unfiltered by host, so a check hosted on artificialanalysis.ai would open too. That is no wider a trust than a
github.com check link, and an inbox card's link stays limited to GitHub.
