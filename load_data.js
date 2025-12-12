#!/usr/bin/env node

import _ from 'lodash';
import * as fs from 'fs';
import * as zlib from 'zlib';
import es from 'event-stream';
import commandLineArgs from 'command-line-args';
import getUsage from 'command-line-usage';
import nodefireModule from 'nodefire';
import Hubkit from 'hubkit';
import {PromiseReadable} from 'promise-readable';
import Pace from 'pace';
import {Throttle} from 'stream-throttle';
import {uploadedFilesUrl, PLACEHOLDER_URL} from './lib/derivedInfo.js';
import {fetchToken} from './lib/tokens.js';

const NodeFire = nodefireModule.default;

const commandLineOptions = [
  {name: 'input', alias: 'i', typeLabel: '{underline data.ndjson}',
    description: 'Input ndJSON file with extracted data.'},
  {name: 'admin', alias: 'a', typeLabel: '{underline github:NNNN}',
    description: 'The user id of a GHE user with valid OAuth credentials in Reviewable.'},
  {name: 'help', alias: 'h', type: Boolean,
    description: 'Display these usage instructions.'}
];

const usageSpec = [
  {header: 'Data upload tool',
    content:
      'Uploads all data related to a set of repos (previously extracted with extract_data.js) to ' +
      'a Reviewable datastore and resyncs some data with GitHub Enterprise.'
  },
  {header: 'Options', optionList: commandLineOptions}
];

const args = commandLineArgs(commandLineOptions);
if (args.help) {
  console.log(getUsage(usageSpec));
  process.exit(0);
}
for (const property of ['input', 'admin']) {
  if (!(property in args)) {
    console.log('Missing required option: ' + property + '.');
    process.exit(1);
  }
}

if (!process.env.REVIEWABLE_ENCRYPTION_AES_KEY) {
  console.warn('WARNING: not encrypting uploaded data as REVIEWABLE_ENCRYPTION_AES_KEY not given');
}

let placeholderUrlRegex, gh;
if (uploadedFilesUrl) {
  if (!process.env.REVIEWABLE_GITHUB_URL) {
    console.log(
      'ERROR: no REVIEWABLE_GITHUB_URL specified, unable to rewrite uploaded image URLs in comments'
    );
    process.exit(1);
  }
  placeholderUrlRegex = new RegExp(_.escapeRegExp(PLACEHOLDER_URL), 'g');
} else {
  console.warn(
    'WARNING: no REVIEWABLE_UPLOADS_PROVIDER or REVIEWABLE_UPLOADED_FILES_URL specified, ' +
    'so not rewriting uploaded image URLs in comments.');
}

async function load() {
  await import('./lib/loadFirebase.js');
  const host = process.env.REVIEWABLE_GITHUB_URL === 'https://github.com' ?
    'https://api.github.com' : process.env.REVIEWABLE_GITHUB_URL + '/api/v3';
  gh = new Hubkit({host, token: await fetchToken(args.admin)});

  let sizeRead = 0;
  let fatalError;

  const pace = Pace(fs.statSync(args.input).size);  // eslint-disable-line new-cap
  const reader = fs.createReadStream(args.input)
    .pipe(new Throttle({rate: 200000, chunksize: 50000}))
    .pipe(es.mapSync(chunk => {
      sizeRead += chunk.length;
      pace.op(sizeRead);
      return chunk;
    }))
    .pipe(es.split())
    .pipe(es.parse({error: true}))
    .pipe(es.map(async (item, callback) => {  // eslint-disable-line lodash/prefer-lodash-method
      await processLine(item);
      callback();
    }))
    .on('error', error => {
      fatalError = error;
    });
  await new PromiseReadable(reader).once('end');
  if (fatalError) throw fatalError;
}

load().then(() => {
  process.exit(0);
}, e => {
  console.log();
  if (e.errors) console.log(e.errors);
  console.log(e.stack);
  if (e.extra && e.extra.debug) console.log(e.extra.debug);
  process.exit(1);
});


async function processLine([key, value, flags]) {
  if (uploadedFilesUrl && !_.isEmpty(value)) {
    if (_.startsWith(key, 'reviews/')) {
      await tweakReview(value);
    } else if (_.startsWith(key, 'archivedReviews/') && flags?.placeholdersPresent) {
      const review = JSON.parse(zlib.gunzipSync(Buffer.from(value.payload, 'base64')).toString());
      await tweakReview(review);
      value.payload =
        zlib.gzipSync(JSON.stringify(review), {level: zlib.constants.Z_BEST_COMPRESSION})
          .toString('base64');
    }
  }

  if (!_.isEmpty(value)) {
    try {
      if (_.startsWith(key, 'system/oldestUsed')) {
        await db.child(key).transaction(oldValue => {
          return oldValue ? Math.min(oldValue, value) : value;
        });
      } else {
        await db.child(key).update(value);
      }
    } catch (e) {
      e.message += ` (at ${key})`;
      throw e;
    }
  }

  if (_.startsWith(key, 'reviews/')) {
    const syncOptions = {
      userKey: args.admin, prNumber: value.core.pullRequestId,
      owner: _.toLower(value.core.ownerName), repo: _.toLower(value.core.repoName),
      updateReview: true, syncComments: true, syncStatus: true, mustSucceed: true,
      overrideBadge: true, timestamp: NodeFire.SERVER_TIMESTAMP
    };
    await db.child(
      'queues/githubPullRequestSync/:owner|:repo|:prNumber|:userKey', syncOptions
    ).update(syncOptions);
  } else if (_.startsWith(key, 'users/')) {
    await db.child('queues/requests').push({
      action: 'fillUserProfile', userKey: args.admin, userId: key.match(/users\/github:(\d+)/)[1]
    });
  }
}

async function tweakReview(review) {
  const fullRepoName = `${review.core.ownerName}/${review.core.repoName}`;
  const promises = [];
  _.forEach(review.discussions, discussion => {
    _.forEach(discussion.comments, comment => {
      if (!comment.markdownBody) return;
      const body = comment.markdownBody.replace(placeholderUrlRegex, uploadedFilesUrl);
      if (body === comment.markdownBody) return;
      comment.markdownBody = body;
      promises.push(
        gh.request('POST /markdown', {body: {
          text: body, mode: 'gfm', context: fullRepoName
        }}).then(htmlBody => {
          comment.htmlBody = htmlBody;
        })
      );
    });
  });
  if (promises.length) await Promise.all(promises);
}
