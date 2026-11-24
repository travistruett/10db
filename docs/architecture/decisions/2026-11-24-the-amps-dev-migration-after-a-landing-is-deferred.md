# The amps_dev migration after a landing is deferred from the pilot

- **Date:** 2026-11-24

## Decision

A landing that brings migrations raises one card telling the builder to apply them to their dev database, as they do today. 10db does not migrate `amps_dev` itself in the pilot. It is deferred, not refused; a task closes it once the pilot's numbers are in.

## Why

The after-landing command can't run inside the gate's sandbox, and provisioning is Ampsio's side. The card keeps the builder's current habit and keeps the first build to landing, journal and recovery.
