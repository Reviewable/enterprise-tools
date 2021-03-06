#!/usr/bin/env node --max-old-space-size=8192
'use strict';

const commandLineArgs = require('command-line-args');
const getUsage = require('command-line-usage');
const util = require('util');

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
      'REVIEWABLE_FIREBASE, REVIEWABLE_FIREBASE_CREDENTIALS_FILE, and ' +
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

require('./lib/loadFirebase.js');

async function read() {
  args.path = args.path.replace(/^\//, '');
  const value = await db.child(args.path).get();
  console.log(util.inspect(value, {depth: null}));
}

read().then(() => {
  process.exit(0);
}, e => {
  console.log(e);
  process.exit(1);
});
