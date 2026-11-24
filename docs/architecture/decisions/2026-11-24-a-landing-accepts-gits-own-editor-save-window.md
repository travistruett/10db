# A landing accepts git's own editor-save window, the same as git pull

- **Date:** 2026-11-24

## Decision

A landing refuses when the builder's folder has edits in the files it writes. Between git's check of each file and its write, a save in the builder's editor can be overwritten. 10db accepts that window, as `git pull` does, and no test claims it closed. This is the builder's decision.

## Why

Closing it needs a lock the editor does not take, so it would mean refusing to land while the builder works. The same window exists in the builder's daily `git pull`, and the landing already waits when the folder is off the base or has edits in the way.
