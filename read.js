#!/usr/bin/env node

import commandLineArgs from 'command-line-args';
import getUsage from 'command-line-usage';
import {inspect} from 'util';

const commandLineOptions = [
  {name: 'path', alias: 'p', type: String, defaultOption: true,
    description: 'The path in Firebase from which to read data.  You can omit the leading slash.'},
  {name: 'help', alias: 'h', type: Boolean,
    description: 'Display these usage instructions.'}
];

const usageSpec = [
  {header: 'Data readout tool',
    content:
      'Reads a given path from Firebase and prints the result, decrypting if necessary. ' +
      'REVIEWABLE_FIREBASE_URL, REVIEWABLE_FIREBASE_CREDENTIALS_FILE, and ' +
      'REVIEWABLE_ENCRYPTION_AES_KEY must be set.'
  },
  {header: 'Options', optionList: commandLineOptions}
];

const args = commandLineArgs(commandLineOptions);
if (args.help) {
  console.log(getUsage(usageSpec));
  process.exit(0);
}
for (const property of ['path']) {
  if (!(property in args)) {
    console.log('Missing required option: ' + property + '.');
    process.exit(1);
  }
}


async function read() {
  await import('./lib/loadFirebase.js');
  args.path = args.path.replace(/^\//, '');
  const value = await db.child(args.path).get();
  // console.log(inspect(value, {depth: null}));
  console.log(JSON.stringify(value, null, 2));
}

read().then(() => {
  process.exit(0);
}, e => {
  console.log(e);
  process.exit(1);
});
