# Access replaces environment, and business is a question category

- **Date:** 2026-11-12

## Decision

The question categories are six: product, business, design, engineering, access and other.

- `business` is new (pricing, legal, policy, customers, commitments). Its answers are recorded as decisions,
  as product, design and engineering answers are (`DECISION_CATEGORIES`).
- `access` replaces `environment`. Its meaning is unchanged ("I need something I can't get myself": keys,
  accounts, permissions, data, a service turned on), and its answers are not recorded as decisions.
- A stored `'environment'` in `inbox_items` and `routing_rules` becomes `'access'` in migration
  `0065_question_category_access`, authored by hand with `drizzle-kit generate --custom` and never changed.
- The enum loses `environment`, which narrows the contract, so `PROTOCOL_VERSION` goes from 7 to 8. The desktop
  and the daemon ship together, so no older client sends the old value.
- `QUESTION_CATEGORY_HINTS` (`packages/contracts/src/states.ts`) is the one source of each category's hint and
  what it covers. The `ask_human` input description, the tool description, every picker and the judge's
  criteria read it.

## Why

Questions that go to a stakeholder need a category for the business side (policy, pricing, legal), which the
three decision categories did not cover. "Environment" read as a deployment setting; what a lane means by it is
that it needs something it cannot get itself, which "access" names. Finer subjects are topic routes, not more
categories. Keeping `environment` as an alias was turned down: two names for one thing would leak into every
picker and every route.
