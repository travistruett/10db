# The builder allows a project's network hosts ahead of a card

- **Date:** 2026-10-29

## Decision

`GET`, `POST` and `DELETE /projects/:projectId/network-hosts` list, add and remove a project's allowed hosts. A
host is the project-wide (`workstreamId` null) `SandboxNetworkAccess` rule an Allow for the project card stores, so
lanes, gates and approved MCP servers read it as they read a card's rule. Adding goes through `storableRule`, the
card path's host check, and then refuses what a project may not be given:

- a host the sandbox profile can't list (an underscore name, an IPv6 address, a URL, a port, an empty label);
- loopback (`localhost`, `*.localhost`, `127.x.x.x`, `0.0.0.0`, `::1`), which has its own "Allow localhost" setting;
- `*`, a bare top-level domain, and a wildcard over one (`*.com`).

The host is trimmed and lower-cased. Adding a host already allowed answers 200 with the existing host and stores
nothing. Removing a host removes every project-wide copy, whatever added it (a card or this API); other tools' rules
and workstream-scoped rules stay. Each change appends a `network_hosts.changed` event, which the UI uses to refresh.
Settings has a "Network hosts" section for it.

## Why

A gate's denied host raises no card, so cargo got `CONNECT tunnel failed, response 403` and the builder had no way
to allow `index.crates.io` short of waiting for a lane to ask. The trust is the same as a card's Allow for the
project: the builder names a host that code in the project's sandbox may send data to. Reusing the stored rule means
no second place decides what a host rule is. The refusals are stricter than a card's because a typed host, unlike
one a command reached for, can be over-broad by mistake. Remove by host, not by rule ID, because a card can store
the same host more than once and the builder sees one row per host.
