#!/usr/bin/env node

import fs from 'fs';
import readline from 'readline';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';
import {eachLimit} from 'async';
import ms from 'ms';
import Pace from 'pace';
import _ from 'lodash';

const UPDATE_SIZE = 20;
const MAX_PARALLEL_UPDATES = 3;
const REF_REGEXP = /^refs\/reviewable\/(pr\d+\/r\d+)$/;

function parseArgs() {
  return yargs(hideBin(process.argv))
    .usage('Usage: $0 <filename> --repo=owner/repo [options]')
    .positional('filename', {
      describe: 'The file to read Git refs from, one per line',
      type: 'string'
    })
    .option('repo', {
      describe: 'The repository (e.g. Reviewable/enterprise-tools) the refs are stored in',
    })
    .option('max-delay', {
      type: 'string',
      describe: 'The amount of time over which to distribute tasks in the cleanup work queue, ' +
        'to avoid overloading the GitHub server',
      default: '1d',
    })
    .option('validate-only', {
      type: 'boolean',
      describe: 'Do not schedule refs for cleanup, only validate input file'
    })
    .option('ignore-invalid', {
      type: 'boolean',
      describe: 'Do not fail when encountering invalid refs but continue to ' +
        'schedule cleanup of remaining valid refs'
    })
    .demandCommand(1, 'You must provide a filename')
    .check(argv => {
      if (!argv.repo && !argv.validateOnly) {
        throw new Error('Option --repo is required');
      }
      if (argv.validateOnly && argv.ignoreInvalid) {
        throw new Error('--validate-only and --ignore-invalid are mutually exclusive');
      }
      return true;
    })
    .version(false)
    .help()
    .parse();
}

async function validate(filename, ignoreInvalid) {
  const refs = new Set();
  let lineno = 0;
  let valid = true;
  for await (const line of readline.createInterface(fs.createReadStream(filename))) {
    lineno++;
    const ref = _.trim(line);
    if (!ref) continue;  // Silently ignore blank lines
    if (ref.match(REF_REGEXP)) {refs.add(ref); continue;}
    console.warn(`Line ${lineno}, invalid ref: ${ref}`);
    valid = false;
  }
  if (!valid && !ignoreInvalid) process.exit(1);
  return Array.from(refs);
}

async function main() {
  const args = parseArgs();
  const refs = await validate(args._[0], args.ignoreInvalid);
  if (!args.repo) return;
  await import('./lib/loadFirebase.js');
  const [, owner, repo] = _.toLower(args.repo).match(/([^/]*)\/?(.*)/);
  const ldb = db.scope({owner, repo});
  if (!await ldb.child('repositories/:owner/:repo/core').get()) {
    console.error('Repository does not exist.');
    process.exit(1);
  }
  if (args.validateOnly) return;
  const pace = Pace(refs.length);
  const maxDelay = ms(args.maxDelay);
  let saved = 0;
  await eachLimit(_.chunk(refs, UPDATE_SIZE), MAX_PARALLEL_UPDATES, async refsBatch => {
    const updates = {};
    _.forEach(refsBatch, ref => {
      const delay = Math.round(Math.random() * maxDelay);
      const task = {owner, repo, ref, _lease: {expiry: db.now + delay}};
      const shortRef = ref.match(REF_REGEXP)[1].replaceAll('/', '-');
      ldb.scope({shortRef}).assign(updates, {'queues/refCleanup/:owner|:repo|:shortRef': task});
    });
    await ldb.update(updates);
    saved += refsBatch.length;
    pace.op(saved);
  });
}

await main();
process.exit(0);
