# Historical issue identifiers

When a company changes its issue prefix, an operator may retain old links with
an explicit snapshot mapping historical identifiers to stable issue IDs. This
does not change issue content, current identifiers, assignments, or statuses.

Set `PAPERCLIP_ISSUE_ALIASES_FILE` in the server's environment to the absolute
path of a JSON file held in private runtime storage outside the source checkout.
Agent environment settings and project settings cannot select this file. Keep
the file with the instance's private backups; never commit real mappings or
company identifiers to the application repository.

The file has an `aliases` array. Each entry contains `legacy` (old identifier),
`id` (stable issue UUID), and `companyId` (owning company UUID). An optional
`current` field and a top-level `missing` list from earlier snapshots are accepted
but do not control resolution. Capture the mapping before changing a prefix,
and verify each target against its owning company. New issues do not acquire
historical identifiers automatically.

Current identifiers always take priority. Only a missing current identifier
uses the snapshot, and the target must match the recorded issue ID, company ID,
and issue number. Existing route authorization applies to the resulting issue;
an alias never grants access across companies. Missing targets return not found.

With the environment variable unset, lookup behaves as upstream. An unreadable,
malformed, duplicate-key, symlinked, or larger-than-1-MiB configured file produces
an actionable configuration error on fallback lookup without exposing paths or
mapping contents. Valid current-identifier lookups continue to work even if the
mapping requires repair. Replace snapshots atomically when updating them.
