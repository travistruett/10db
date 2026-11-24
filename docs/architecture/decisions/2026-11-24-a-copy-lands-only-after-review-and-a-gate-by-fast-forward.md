# A copy lands only after review and a gate on the exact commit, by fast-forward only

- **Date:** 2026-11-24

## Decision

10db moves the base branch of a Commit Directly project to a copy's work only after review accepted the run and the full gate passed on the exact commit that lands. The move is `Git.promoteFastForward`: one repo lock, bound to the base's tip T and the candidate C, and only when C descends from T. Nothing is ever merged in the builder's folder. A journal records each step so a restart finishes, retries or raises one card; it never guesses. Design: spec §5 and §8.

## Why

A merge could land an ungated commit, and a lock taken twice deadlocks. A fast-forward bound to T and C means what passed the gate is byte for byte what lands, and a base that moved makes the landing wait and gate again instead of landing something untested.
