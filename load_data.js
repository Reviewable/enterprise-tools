#!/usr/bin/env node
'use strict';

global.Promise = require('bluebird');
Promise.co = require('co');
const fs = require('fs');
const commandLineArgs = require('command-line-args');
const getUsage = require('command-line-usage');
const _ = require('lodash');
const eachLimit = require('async-co/eachLimit');
const eachOfLimit = require('async-co/eachOfLimit');
const Firebase = require('firebase');
const NodeFire = require('nodefire');
const requireEnvVars = require('./lib/requireEnvVars.js');

NodeFire.setCacheSize(0);

const commandLineOptions = [
  {name: 'input', alias: 'o', typeLabel: '[underline]{data.json}',
   description: 'Input JSON file with extracted data (required).'},
  {name: 'admin', alias: 'a', typeLabel: '[underline]{github:NNNN}',
   description: 'The user id of a GHE user with valid OAuth credentials in Reviewable (required).'},
  {name: 'help', alias: 'h', type: Boolean,
   description: 'Display these usage instructions.'}
];

const usageSpec = [
  {header: 'Data upload tool',
   content:
    'Uploads all data related to a set of repos (previously extracted with extract_data.js) to a ' +
    'Reviewable datastore and resyncs some data with GitHub Enterprise.'
  },
  {header: 'Options', optionList: commandLineOptions}
];

const args = commandLineArgs(commandLineOptions);
if (args.help) {
  console.log(getUsage(usageSpec));
  process.exit(0);
}
for (let property of ['input', 'admin']) {
  if (!(property in args)) throw new Error('Missing required option: ' + property + '.');
}

requireEnvVars('REVIEWABLE_FIREBASE', 'REVIEWABLE_FIREBASE_AUTH');

if (process.env.REVIEWABLE_ENCRYPTION_AES_KEY) {
  require('firecrypt');
  Firebase.initializeEncryption(
    {
      algorithm: 'aes-siv', key: process.env.REVIEWABLE_ENCRYPTION_AES_KEY,
      cacheSize: 50 * 1048576
    },
    JSON.parse(fs.readFileSync('rules_firecrypt.json')));
} else {
  console.log('WARNING: not encrypting uploaded data as REVIEWABLE_ENCRYPTION_AES_KEY not given');
}

const data = JSON.parse(fs.readFileSync(args.input));
const repoEntries = _(data.repositories)
  .map((org, orgName) => _.map(org, (repo, repoName) => ({owner: orgName, repo: repoName})))
  .flattenDeep().value();
const numItems = 1 + _.size(data.reviews) + _.size(data.users) + _.size(repoEntries);
const pace = require('pace')(numItems);
const db = new NodeFire(`https://${process.env.REVIEWABLE_FIREBASE}.firebaseio.com`);

Promise.co(function*() {
  yield db.auth(process.env.REVIEWABLE_FIREBASE_AUTH);
  yield [loadOrganizations(), loadRepositories()];
  yield loadReviews();
  yield loadUsers();
}).then(() => {
  process.exit(0);
}, e => {
  console.log();
  if (e.errors) console.log(e.errors);
  console.log(e.stack);
  if (e.extra && e.extra.debug) console.log(e.extra.debug);
  process.exit(1);
});

function *loadOrganizations() {
  yield db.child('organizations').update(data.organizations);
  pace.op();
}

function *loadRepositories() {
  yield eachLimit(repoEntries, 10, function*({owner, repo}) {
    // owner and repo are already escaped
    yield db.child(`repositories/${owner}/${repo}`).update(data.repositories[owner][repo]);
    pace.op();
  });
}

function *loadReviews() {
  yield eachOfLimit(data.reviews, 25, function*(review, reviewKey) {
    const rdb = db.scope({reviewKey});
    yield rdb.child('reviews/:reviewKey').update(review);
    const linemap = data.linemaps[reviewKey], filemap = data.filemaps[reviewKey];
    yield [
      linemap ? rdb.child('linemaps/:reviewKey').set(linemap) : Promise.resolve(),
      filemap ? rdb.child('filemaps/:reviewKey').set(filemap) : Promise.resolve()
    ];
    const syncOptions = {
      userKey: args.admin, prNumber: review.core.pullRequestId,
      owner: review.core.ownerName.toLowerCase(), repo: review.core.repoName.toLowerCase(),
      updateReview: true, syncComments: true, syncStatus: true,
      timestamp: NodeFire.ServerValue.TIMESTAMP
    };
    yield rdb.child(
      'queues/githubPullRequestSync/:owner|:repo|:prNumber|:userKey', syncOptions
    ).update(syncOptions);
    pace.op();
  });
}

function *loadUsers() {
  yield eachOfLimit(data.users, 25, function*(user, userKey) {
    yield [
      db.child('users/:userKey', {userKey}).update(user),
      db.child('queues/requests').push({
        action: 'fillUserProfile', userKey: args.admin, userId: userKey.replace(/github:/, '')
      })
    ];
    pace.op();
  });
}