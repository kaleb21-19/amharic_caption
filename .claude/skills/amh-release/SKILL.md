---
name: amh-release
description: Release a change of Amharic Captions Pro safely - pick the right version, bump it everywhere, run all tests, get a full CI build, hand the owner one PR link. Use whenever a change goes into the customer zip, or when CI says "release tag vX already points at".
---
# Release

1. `python tools/agent/release_state.py` - is main's version published? Are merged commits waiting?
   - "already points at" error: the version was published by an earlier merge -> new branch from origin/main + next version (step 2). Never reuse a number.
2. `python tools/agent/bump.py X.Y.Z` (it refuses old or published numbers).
3. `python tools/agent/test.py all` - every suite must pass. Fix, do not skip.
4. Commit: why (the problem), what changed, how it was verified. Co-author line as usual.
5. Push the branch, then `git push -f origin HEAD:ci/build-1.10.20` for the full Windows + Mac build (new `ci/build-*` branches do not start it). Wait for `build-zips` and `mac-smoke` (poll the public API every 150 s, not faster).
6. Give the owner: the PR link, what is in it (plain words), "merge only this one; it publishes vX.Y.Z", and any deploy step (bot: `npm.cmd run migrate` BEFORE `npm.cmd run deploy`).
7. After he merges: check the release is public with all files (`python tools/agent/facts.py --online`).
8. From now on that version counts as published: any later change = new branch + new version.
