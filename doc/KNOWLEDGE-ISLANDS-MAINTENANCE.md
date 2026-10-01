# Knowledge Islands maintained Paperclip

This fork maintains a small set of tested repairs for Knowledge Islands' local Paperclip installation. The first baseline is upstream `v2026.916.1` (`d554c4789ed3930f8a53ac9fdf6503b3187097da`). The upstream repository is <https://github.com/paperclipai/paperclip>; the maintained fork is <https://github.com/knowledgeislands/paperclip>.

## Branches and delivery

- `master` mirrors upstream `master`. Do not put local repairs on it.
- `ki/stable` contains the maintained source. Start each repair on a `fix/<name>` branch from it, add regression tests, review the resulting change, then merge the verified branch.
- `upgrade/<version>` starts from `ki/stable` and merges one named upstream release or commit. Resolve conflicts, check which repairs upstream now supplies, and verify the combined result before merging it into `ki/stable`.
- Tag an approved deployment candidate as `ki/v<upstream-version>-<revision>`. Record the full commit and artifact checksum in the host deployment record. A moving branch name is not a deployed-version identity.

Normal maintenance merges preserve history. Rebuilding the maintained branch or rebasing published history requires a separate, explicit decision. Do not replay a repair that is already present or superseded. Keep each repair's tests when upstream takes over its behaviour.

Merging source, publishing refs, and deploying the service are separate operations. Repository updates do not trigger deployment. Keep the previous build available until the replacement passes its live checks. This fork does not publish packages to a public registry.

## Ownership

The fork owns source changes, synthetic regression tests and the repair register below. The host environment repository owns installation, the deployed commit, service management, backup and restart procedures. Paperclip owns credentials, database state, company records, private issue aliases, uploads, logs and workspaces. Those runtime files stay outside this public fork.

Do not add machine-specific configuration or copy the host's captured issue-alias map into this repository. Test fixtures use invented identifiers and credentials. Authentication code must preserve company boundaries, authorised connection ownership and secret redaction.

## Repairs

| Repair | Source intent | Verification | Upstream relationship |
| --- | --- | --- | --- |
| OpenAI project authentication | Managed OpenAI execution ignores the host user's Codex configuration while retaining project checks. | Auth-boundary regression tests. | Local repair; compare on every upstream update. |
| Historical issue identifiers | Current identifiers resolve first; historical aliases resolve through a private runtime map. | Synthetic lookup and company-boundary tests; host verifies its retained aliases. | Local repair; remove only after upstream preserves the required historical identities. |
| Claude subscription renewal | Retain renewable credentials and safely refresh them for shared-agent execution. | Synthetic import, renewal, concurrent refresh and secret-redaction tests. | Local repair; upstream tracking is pending. |
| Embedded PostgreSQL libraries | Supply missing native library aliases only when the payload needs them. | Host installation checks `initdb --version`. | Remains a host installation workaround; no application-source change is needed. |

This table records intended repair scope. Commit history and recorded verification establish which repairs have actually landed. Add the public upstream issue or pull-request URL when one is opened; do not invent a tracking number.

## Verification and deployment

Install the baseline's pinned dependencies with `pnpm install --frozen-lockfile`. Begin with the affected test suites, then run the repository's full hand-off checks: `pnpm -r typecheck`, `pnpm test:run` and `pnpm build`. Record any unavailable or failing check rather than treating a partial result as complete. Build without connecting a development server or tests to the live instance.

The host deployment procedure must identify the candidate commit, verification result, built artifact and previous installation. Check that the candidate preserves the live database schema and private alias lookup. Any database migration needs its own backup and recovery assessment.

Before a live replacement, use the host's maintenance drain and wait for active runs to finish. Verify service identity and health after restart, then verify provider access and historical links. Source tests do not prove that a subscription is connected. A Claude connection that retained only a raw access token needs a new approved connection/import to obtain renewable credentials; the missing refresh token cannot be reconstructed from the old value.

## Upstream review

Review upstream releases and changes to files touched by our repairs before choosing an upgrade baseline. Use specific upstream commits for any fix needed between releases. Do not deploy upstream `master` automatically. A weekly upstream review should identify relevant changes, propose a tested update and flag repairs that can be retired; this document does not create a scheduler or activate that review.
