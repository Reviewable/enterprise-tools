# enterprise-tools
Administrative tools for Reviewable Enterprise

## Installation

Install the published commands with npm:

```bash
npm install --global reviewable-enterprise-tools
rvbl-read --help
```

The following commands are available from any directory:

| Command | Purpose |
| --- | --- |
| `rvbl-read` | Read and decrypt a Firebase path. |
| `rvbl-write` | Write a JSON file to a Firebase path, encrypting as needed. |
| `rvbl-extract-data` | Extract repository data for migration. |
| `rvbl-load-data` | Load migrated data into a Reviewable datastore. |
| `rvbl-cleanup-refs` | Validate Git refs and schedule their cleanup. |
| `rvbl-transaction-probe` | Diagnose a possibly stuck Firebase transaction. |

Run any command with `--help` for its options. The previous `read`, `extract_data`,
`load_data`, and `transaction_probe` names remain available as compatibility aliases.

See https://github.com/Reviewable/Reviewable/blob/master/enterprise/operations.md for usage instructions.

## Development and publishing

Enable Corepack and run `yarn install --immutable` for development. The package pins its Yarn
version and uses the `node-modules` linker. Releases use `npm pack` / `npm publish` so that
`bundleDependencies` includes the tested runtime dependency tree. The `prepack` hook runs
`corepack yarn install --immutable` before npm creates the archive, including in a checkout
without `node_modules`. Runtime dependency updates require a new package version; dev-only
lockfile updates do not unless published output changes.

## Stuck transaction probe

`rvbl-transaction-probe` diagnoses a possibly stuck transaction at a Firecrypt-managed logical
Firebase path, whether or not encryption is enabled. Run the read and cold-cache transaction in
separate processes so the read does not warm the SDK cache:

```
rvbl-transaction-probe 'reviews/example' --read --attachment attachment_1.json --output read-report.json
rvbl-transaction-probe 'reviews/example' --transaction --attachment attachment_1.json --output transaction-report.json
```

Passing both `--read` and `--transaction` deliberately tests the transaction after warming the
cache. Use `--max-attempts` and `--timeout` to change the bounds, `--no-logging` to disable the
filtered Firebase wire log, and `--include-values` only when logical values should be copied into the
report. Matching wire messages are recorded verbatim and may contain raw stored values, especially
when Firecrypt encryption is disabled, so protect the report accordingly.

`--transaction` is a Firebase compare-and-put write attempt even though it returns the value
unchanged. It may evaluate write rules and should only be used on a path where this is acceptable.
The path is required and the database root is rejected.

`--timeout` only limits how long the probe waits for a response; it does not cancel a request that
Firebase has already received. If a transaction reports `outcome: "error"` with code
`PROBE_TIMEOUT`, its server-side outcome is unknown and the compare-and-put may still complete after
the probe disconnects. Verify the target path before retrying.
