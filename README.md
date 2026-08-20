# enterprise-tools
Administrative tools for Reviewable Enterprise

See https://github.com/Reviewable/Reviewable/blob/master/enterprise/operations.md for usage instructions.

## Stuck transaction probe

`transaction_probe.js` diagnoses a possibly stuck transaction at a Firecrypt-managed logical
Firebase path, whether or not encryption is enabled. Run the read and cold-cache transaction in
separate processes so the read does not warm the SDK cache:

```
node transaction_probe.js 'reviews/example' --read --attachment attachment_1.json --output read-report.json
node transaction_probe.js 'reviews/example' --transaction --attachment attachment_1.json --output transaction-report.json
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
