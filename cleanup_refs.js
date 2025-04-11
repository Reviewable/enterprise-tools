#!/usr/bin/env node

import fs from 'fs';
import readline from 'readline';
import {execFile} from 'child_process';
import {promisify} from 'util';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';
import {eachLimit} from 'async';
import _ from 'lodash';

const execFileAsync = promisify(execFile);

const UPDATE_SIZE = 20;
const MAX_PARALLEL_UPDATES = 3;
const REF_PREFIX = 'refs/reviewable/';

async function main() {
  const args = yargs(hideBin(process.argv))
    .usage('Usage: $0 <filename> [options]')
    .positional('filename', {
      describe: 'The file to read Git refs from, one per line',
      type: 'string'
    })
    .option('owner', {
      describe: 'The owner of the repository the refs are stored in',
      demandOption: true
    })
    .option('repo', {
      describe: 'The repository (without owner) the refs are stored in',
      demandOption: true
    })
    .option('max-delay', {
      type: 'number',
      describe: 'For each ref a task will be scheduled that will be delayed by ' +
        'a random number of milliseconds between zero and this number',
      default: 1000,
    })
    .option('skip-check-ref-format', {
      type: 'boolean',
      describe: 'If this option is specified no validity check or normalization ' +
        'are performed via "git check-ref-format" on the refs provided'
    })
    .demandCommand(1, 'You must provide a filename')
    .help()
    .parse();
  await import('./lib/loadFirebase.js');
  const owner = _.toLower(args.owner);
  const repo = _.toLower(args.repo);
  const ldb = db.scope({owner, repo});
  if (!await ldb.child('repositories/:owner/:repo').get()) {
    console.error('Owner or repository does not exist.');
    process.exit(1);
  }
  let saved = 0;
  let lastProgressLine;
  const stdout = readline.createInterface(process.stdout);
  const seenRefs = new Set();
  await eachLimit((async function* () {
    const input = readline.createInterface(fs.createReadStream(args._[0]));
    let updates = {};
    for await (const line of input) {
      let ref = _.trim(line);
      if (!ref) continue;  // Silently ignore blank lines
      if (!args.skipCheckRefFormat) {
        try {
          const result = await execFileAsync('git', ['check-ref-format', '--normalize', ref]);
          ref = _.trim(result.stdout);
        } catch (err) {
          if (err.code === 'ENOENT') {
            console.error(
              'Git is not installed, cannot check ref format. ' +
              'Please install Git or pass --skip-check-ref-format.');
            process.exit(1);
          }
          console.warn('Ignoring invalid ref:', ref);
          continue;
        }
      }
      if (!_.startsWith(ref, REF_PREFIX)) {
        console.warn('Ignoring ref with unrelated prefix:', ref);
        continue;
      }
      if (seenRefs.has(ref)) {
        console.warn('Ignoring duplicate ref:', ref);
        continue;
      }
      seenRefs.add(ref);
      const delay = Math.random() * args.maxDelay;
      const task = {owner, repo, ref, _lease: {created: db.now + delay}};
      const shortRef = ref.slice(REF_PREFIX.length).replace(/\//g, '-');
      ldb.scope({shortRef}).assign(updates, {'queues/refCleanup/:owner|:repo|:shortRef': task});
      if (_.size(updates) === UPDATE_SIZE) {
        yield updates;
        updates = {};
      }
    }
    if (!_.isEmpty(updates)) yield updates;
  })(), MAX_PARALLEL_UPDATES, async updates => {
    await db.update(updates);
    saved += _.size(updates);
    if (process.stdout.isTTY && stdout.line === lastProgressLine) {
      readline.moveCursor(process.stdout, 0, -1);
    }
    console.log(`Scheduled ${saved} refs for cleanup.`);
    lastProgressLine = stdout.line;
  });
}

await main();
process.exit(0);
