#!/usr/bin/env node

import {createHash} from 'crypto';
import {readFileSync, writeFileSync} from 'fs';
import {deleteApp, SDK_VERSION} from 'firebase-admin/app';
import {enableLogging} from 'firebase-admin/database';
import _ from 'lodash';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

const args = yargs(hideBin(process.argv))
  .parserConfiguration({'parse-positional-numbers': false})
  .usage(
    '$0 <path> (--read | --transaction) [options]\n' +
    '$0 --path <path> (--read | --transaction) [options]\n\n' +
    'Diagnoses a possibly stuck Firebase transaction at a Firecrypt-managed logical path. ' +
    'The transaction is a raw no-op that returns its current stored input. ' +
    'REVIEWABLE_FIREBASE_URL and Firebase credentials must be set. Set ' +
    'REVIEWABLE_ENCRYPTION_AES_KEY only when Firecrypt encryption is enabled.'
  )
  .option('path', {
    alias: 'p', type: 'string',
    describe: 'The logical Firebase path to probe. You can omit the leading slash.'
  })
  .option('read', {
    type: 'boolean', default: false,
    describe: 'Read and summarize the logical value before exiting or starting the transaction.'
  })
  .option('transaction', {
    type: 'boolean', default: false,
    describe: 'Attempt a bounded no-op transaction. This is a Firebase write attempt.'
  })
  .option('logging', {
    type: 'boolean', default: true,
    describe: 'Capture filtered Firebase wire logs verbatim; they may contain stored values.'
  })
  .option('max-attempts', {
    type: 'number', default: 6,
    describe: 'Abort on this transaction callback invocation if the transaction has not committed.'
  })
  .option('timeout', {
    type: 'number', default: 30000,
    describe: 'Client wait bound in milliseconds; a timeout leaves the server outcome unknown.'
  })
  .option('attachment', {
    alias: 'a', type: 'string',
    describe: 'A Sentry attachment JSON file to compare with read and transaction input values.'
  })
  .option('include-values', {
    type: 'boolean', default: false,
    describe: 'Include logical values in the report. Otherwise only summaries and digests appear.'
  })
  .option('output', {
    alias: 'o', type: 'string',
    describe: 'Write the final JSON report to this file instead of stdout.'
  })
  .strictOptions()
  .check(parsedArgs => {
    const pathOptionProvided = parsedArgs.path !== undefined;
    if (pathOptionProvided && parsedArgs._.length) {
      throw new Error('Specify the Firebase path either positionally or with --path, not both.');
    }
    if (parsedArgs._.length > 1) throw new Error('Only one Firebase path may be specified.');
    if (!pathOptionProvided && !parsedArgs._.length) {
      throw new Error('A Firebase path is required.');
    }
    const firebasePath = String(parsedArgs.path ?? parsedArgs._[0]).replace(/^\/+|\/+$/g, '');
    if (!firebasePath) throw new Error('The Firebase root may not be probed.');
    if (!parsedArgs.read && !parsedArgs.transaction) {
      throw new Error('Specify --read, --transaction, or both.');
    }
    if (!Number.isSafeInteger(parsedArgs.maxAttempts) || parsedArgs.maxAttempts < 1) {
      throw new Error('--max-attempts must be a positive integer.');
    }
    if (!Number.isSafeInteger(parsedArgs.timeout) || parsedArgs.timeout < 1) {
      throw new Error('--timeout must be a positive integer number of milliseconds.');
    }
    return true;
  })
  .version(false)
  .help()
  .parse();

const firebasePath = String(args.path ?? args._[0]).replace(/^\/+|\/+$/g, '');
const startedAt = new Date().toISOString();
const report = {
  startedAt,
  path: firebasePath,
  process: {
    node: process.version,
    firebaseAdmin: SDK_VERSION,
    platform: process.platform,
    arch: process.arch
  },
  options: {
    read: args.read,
    transaction: args.transaction,
    logging: args.logging,
    maxAttempts: args.maxAttempts,
    timeout: args.timeout,
    includeValues: args.includeValues
  },
  wire: []
};

let attachmentValue;

let transactionStarted = false;
const transactionRequestIds = new Set();

function normalizeValue(value) {
  if (_.isArray(value)) return _.map(value, normalizeValue);
  if (_.isObject(value)) {
    return _(value).keys().sortBy()
      .map(key => [key, normalizeValue(value[key])])
      .fromPairs().value();
  }
  return value;
}

function summarizeValue(value) {
  if (value === undefined) return {type: 'undefined'};
  const normalized = normalizeValue(value);
  const json = JSON.stringify(normalized);
  const summary = {
    type: value === null ? 'null' : _.isArray(value) ? 'array' : typeof value,
    bytes: Buffer.byteLength(json, 'utf8'),
    // This is a local report fingerprint, not the SHA-1 hash sent by Firebase transactions.
    reportSha256: createHash('sha256').update(json).digest('hex')
  };
  if (_.isArray(value)) summary.items = value.length;
  else if (_.isObject(value)) summary.keys = _.keys(value).length;
  return summary;
}

function sameValue(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return summarizeValue(left).reportSha256 === summarizeValue(right).reportSha256;
}

function resolveStoredReference(firecryptRef) {
  // Firecrypt does not expose the transformed native reference publicly. Keep this private API use
  // isolated and fail loudly if its shape changes, since calling FirecryptReference.transaction()
  // would put Firecrypt back into the operation under investigation.
  const crypto = firecryptRef?._firecrypt?._crypto;
  const logicalRef = firecryptRef?._ref;
  if (!crypto?.encryptRef || !crypto?.refToPath || !crypto?.transformValue || !logicalRef) {
    throw new Error(
      'Unsupported Firecrypt version: unable to resolve the native stored reference.'
    );
  }
  const logicalPath = crypto.refToPath(logicalRef);
  return {
    ref: crypto.encryptRef(logicalRef),
    decode(value) {
      return crypto.transformValue(logicalPath, structuredClone(value), 'decrypt');
    }
  };
}

function recordWire(event) {
  const entry = {timestamp: new Date().toISOString(), ...event};
  report.wire.push(entry);
  console.error(`[firebase-wire] ${JSON.stringify(entry)}`);
}

function parseJsonAfter(line, marker) {
  const markerIndex = line.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const jsonStart = line.indexOf('{', markerIndex + marker.length);
  if (jsonStart < 0) return undefined;
  try {
    return JSON.parse(_.trim(line.slice(jsonStart)));
  } catch {
    return undefined;
  }
}

function firebaseLogger(message) {
  const originalMessage = String(message);
  const line = _.trim(originalMessage);

  // Outgoing compare-and-put requests are the only puts that include a hash.
  const outgoing = parseJsonAfter(line, '');
  if (outgoing?.a === 'p' && outgoing.b?.h !== undefined) {
    transactionRequestIds.add(outgoing.r);
    recordWire({
      direction: 'client-to-server',
      requestId: outgoing.r,
      message: originalMessage
    });
    return;
  }

  const incoming = parseJsonAfter(line, 'from server:');
  if (incoming && transactionRequestIds.has(incoming.r)) {
    recordWire({
      direction: 'server-to-client',
      requestId: incoming.r,
      message: originalMessage
    });
    return;
  }

  if (!transactionStarted || !_.includes(line, 'handleServerMessage')) return;
  const match = line.match(/handleServerMessage\s+([dm])\s+/);
  if (!match) return;
  const update = parseJsonAfter(line, match[0]);
  if (!update) return;
  recordWire({
    direction: 'server-push',
    message: originalMessage
  });
}

function withTimeout(promise, operation) {
  let timeoutId;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`${operation} timed out after ${args.timeout}ms`);
      error.code = 'PROBE_TIMEOUT';
      reject(error);
    }, args.timeout);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

function errorDetails(error) {
  return {
    name: error?.name,
    message: error?.message ?? String(error),
    code: error?.code,
    stack: error?.stack
  };
}

async function probe() {
  if (args.logging) enableLogging(firebaseLogger);

  let app;
  try {
    if (args.attachment) {
      report.attachment = {file: args.attachment};
      attachmentValue = JSON.parse(readFileSync(args.attachment, 'utf8'));
      report.attachment.value = summarizeValue(attachmentValue);
      if (args.includeValues) report.attachment.value.data = attachmentValue;
    }

    let database;
    ({default: app, database} = await import('./lib/initializeFirebase.js'));
    const firecryptRef = database.ref(firebasePath);
    const stored = resolveStoredReference(firecryptRef);
    let readValue;

    if (args.read) {
      const snapshot = await withTimeout(firecryptRef.once('value'), 'read');
      readValue = snapshot.val();
      report.read = {
        value: summarizeValue(readValue),
        matchesAttachment: attachmentValue === undefined ? undefined :
        sameValue(readValue, attachmentValue)
      };
      if (args.includeValues) report.read.value.data = structuredClone(readValue);
    }

    if (args.transaction) {
      let callbackCount = 0;
      let previousRawValue;
      let stoppedAtAttemptLimit = false;
      report.transaction = {
        implementation: 'native Firebase transaction on the raw stored reference',
        firecryptInTransaction: false,
        storedPath: stored.ref.toString().replace(/^https:\/\/[^/]+\/?/, '/'),
        callbacks: []
      };
      transactionStarted = true;

      const transactionPromise = stored.ref.transaction(currentRawValue => {
        callbackCount++;
        const currentValue = stored.decode(currentRawValue);
        const callback = {
          attempt: callbackCount,
          input: {
            raw: summarizeValue(currentRawValue),
            logical: summarizeValue(currentValue)
          },
          sameRawValueAsPrevious: callbackCount === 1 ? undefined :
          sameValue(currentRawValue, previousRawValue),
          matchesRead: readValue === undefined ? undefined : sameValue(currentValue, readValue),
          matchesAttachment: attachmentValue === undefined ? undefined :
          sameValue(currentValue, attachmentValue)
        };
        if (args.includeValues) callback.input.logical.data = structuredClone(currentValue);
        report.transaction.callbacks.push(callback);
        console.error(`[transaction-callback] ${JSON.stringify(callback)}`);
        previousRawValue = structuredClone(currentRawValue);

        if (callbackCount >= args.maxAttempts) {
          stoppedAtAttemptLimit = true;
          return undefined;
        }
        return currentRawValue;
      }, undefined, false);

      try {
        const result = await withTimeout(transactionPromise, 'transaction');
        const finalRawValue = result.snapshot?.val();
        const finalValue = stored.decode(finalRawValue);
        report.transaction.outcome = stoppedAtAttemptLimit ? 'attempt-limit' :
          result.committed ? 'committed' : 'aborted';
        report.transaction.committed = result.committed;
        report.transaction.callbackCount = callbackCount;
        report.transaction.finalValue = {
          raw: summarizeValue(finalRawValue),
          logical: summarizeValue(finalValue)
        };
        report.transaction.finalMatchesAttachment = attachmentValue === undefined ? undefined :
          sameValue(finalValue, attachmentValue);
        if (args.includeValues) {
          report.transaction.finalValue.logical.data = structuredClone(finalValue);
        }
      } catch (error) {
        report.transaction.outcome = 'error';
        report.transaction.callbackCount = callbackCount;
        report.transaction.error = errorDetails(error);
        throw error;
      }
    }
  } finally {
    if (app) await deleteApp(app);
    if (args.logging) enableLogging(false);
  }
}

let exitCode = 0;
try {
  await probe();
} catch (error) {
  report.error = errorDetails(error);
  exitCode = 1;
}

report.finishedAt = new Date().toISOString();
const output = `${JSON.stringify(report, null, 2)}\n`;
if (args.output) writeFileSync(args.output, output);
else process.stdout.write(output);
process.exitCode = exitCode;
