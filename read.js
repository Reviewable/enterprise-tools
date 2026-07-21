#!/usr/bin/env node

import {writeFileSync} from 'fs';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';
// import {inspect} from 'util';

const args = yargs(hideBin(process.argv))
  .usage(
    '$0 <path> [options]\n' +
    '$0 --path <path> [options]\n\n' +
    'Reads a given path from Firebase and prints the result, decrypting if necessary. ' +
    'REVIEWABLE_FIREBASE_URL, REVIEWABLE_FIREBASE_CREDENTIALS_FILE, and ' +
    'REVIEWABLE_ENCRYPTION_AES_KEY must be set.'
  )
  .option('path', {
    alias: 'p', type: 'string',
    describe: 'The path in Firebase from which to read data. You can omit the leading slash.'
  })
  .option('output', {
    alias: 'o', type: 'string',
    describe: 'The path of the output file to write to instead of the console.'
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
    return true;
  })
  .version(false)
  .help()
  .parse();

if (args.path === undefined) args.path = String(args._[0]);


async function read() {
  await import('./lib/loadFirebase.js');
  args.path = args.path.replace(/^\//, '');
  const value = await db.child(args.path).get();
  // console.log(inspect(value, {depth: null}));
  if (args.output) {
    writeFileSync(args.output, JSON.stringify(value, null, 2));
  } else {
    console.log(JSON.stringify(value, null, 2));
  }
}

read().then(() => {
  process.exit(0);
}, e => {
  console.log(e);
  process.exit(1);
});
