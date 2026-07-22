#!/usr/bin/env node

import fs from 'fs';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

const args = yargs(hideBin(process.argv))
  .usage(
    '$0 [options]\n\n' +
    'Writes a JSON file to a given path in Firebase, encrypting if necessary. ' +
    'REVIEWABLE_FIREBASE_URL, REVIEWABLE_FIREBASE_CREDENTIALS_FILE, and ' +
    'REVIEWABLE_ENCRYPTION_AES_KEY must be set.'
  )
  .option('path', {
    alias: 'p', type: 'string', demandOption: true,
    describe: 'The path in Firebase to which to write data. You can omit the leading slash.'
  })
  .option('file', {
    alias: 'f', type: 'string', demandOption: true,
    describe: 'The JSON file containing the data'
  })
  .strict()
  .version(false)
  .help()
  .parse();

async function write() {
  await import('./lib/loadFirebase.js');
  args.path = args.path.replace(/^\//, '');
  const value = JSON.parse(fs.readFileSync(args.file));
  await db.child(args.path).set(value);
  console.log('Done');
}

write().then(() => {
  process.exit(0);
}, e => {
  console.log(e);
  process.exit(1);
});
