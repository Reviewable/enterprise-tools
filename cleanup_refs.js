#!/usr/bin/env node

import fs from 'fs';
import readline from 'readline';
import {execFile} from 'child_process';
import {promisify} from 'util';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';
import {eachLimit, eachOfLimit} from 'async';
import ms from 'ms';
import Pace from 'pace';
import _ from 'lodash';

const execFileAsync = promisify(execFile);

const UPDATE_SIZE = 20;
const MAX_PARALLEL_UPDATES = 3;
const REF_PREFIX = 'refs/reviewable/';

function parseArgs() {
  return yargs(hideBin(process.argv))
    .usage('Usage: $0 <filename> [options]')
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
    .option('no-check-ref-format', {
      type: 'boolean',
      describe: 'If this option is specified no validity checks or normalization ' +
        'are performed via "git check-ref-format" on the refs provided'
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
    .help()
    .parse();
}

async function validate(filename, checkRefFormat, ignoreInvalid) {
  const refs = new Set();
  let valid = true;
  const input = readline.createInterface(fs.createReadStream(filename));
  await eachOfLimit(input, 5, async (line, i) => {
    const ref = _.trim(line);
    if (!ref) return;  // Silently ignore blank lines
    let normalizedRef = ref;
    const lineno = i + 1;
    if (checkRefFormat) {
      try {
        const result = await execFileAsync('git', ['check-ref-format', '--normalize', ref]);
        normalizedRef = _.trim(result.stdout);
      } catch (err) {
        if (err.code === 'ENOENT') {
          console.error(
            'Git is not installed, cannot check ref format. ' +
            'Please install Git or pass --no-check-ref-format.');
          process.exit(1);
        }
        console.warn(`Line ${lineno}, invalid ref: ${ref}`);
        valid = false;
        return;
      }
    }
    if (!_.startsWith(normalizedRef, REF_PREFIX)) {
      console.warn(`Line ${lineno}, ref with unrelated prefix: ${ref}`);
      valid = false;
      return;
    }
    refs.add(normalizedRef);
  });
  if (!valid && !ignoreInvalid) process.exit(1);
  return Array.from(refs);
}

async function main() {
  const args = parseArgs();
  const refs = await validate(args._[0], !args.noCheckRefFormat, args.ignoreInvalid);
  if (!args.repo) return;
  await import('./lib/loadFirebase.js');
  const [, owner, repo] = /([^/]*)\/?(.*)/.exec(_.toLower(args.repo));
  const ldb = db.scope({owner, repo});
  if (!await ldb.child('repositories/:owner/:repo').get()) {
    console.error('Repository does not exist.');
    process.exit(1);
  }
  if (args.validateOnly) return;
  const pace = Pace(refs.length);
  let saved = 0;
  const maxDelay = ms(args.maxDelay);
  await eachLimit(_.chunk(refs, UPDATE_SIZE), MAX_PARALLEL_UPDATES, async refs => {
    const updates = {};
    _.forEach(refs, ref => {
      const delay = Math.round(Math.random() * maxDelay);
      const task = {owner, repo, ref, _lease: {created: db.now + delay}};
      const shortRef = ref.slice(REF_PREFIX.length).replace(/\//g, '-');
      ldb.scope({shortRef}).assign(updates, {'queues/refCleanup/:owner|:repo|:shortRef': task});
    });
    await ldb.update(updates);
    saved += refs.length;
    pace.op(saved);
  });
}

await main();
process.exit(0);
