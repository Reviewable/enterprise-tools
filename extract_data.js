#!/usr/bin/env node

import _ from 'lodash';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import {forEachLimit, forEachOfLimit, forEachOf, mapLimit} from 'async';
import nodefireModule from 'nodefire';
import {PromiseWritable} from 'promise-writable';
import {default as download} from 'download';
import Pace from 'pace';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';
import {uploadedFilesUrl, PLACEHOLDER_URL} from './lib/derivedInfo.js';

const NodeFire = nodefireModule.default;

const HOSTING_ENVIRONMENTS = ['saas', 'ghes'];

const args = yargs(hideBin(process.argv))
  .usage(
    '$0 [options]\n\n' +
    'Extracts all data related to a set of repos from a Reviewable datastore, in preparation ' +
    'for transforming and loading it into another datastore.'
  )
  .option('repos', {
    alias: 'r', type: 'string', demandOption: true,
    describe: 'A file with a JSON array of "owner/repo" repo names to extract.'
  })
  .option('orgs', {
    alias: 'g', type: 'string',
    describe: 'A file with a JSON object of {"source-org": "target-org"} organization mappings. ' +
      '(Optional, defaults to identity mapping for any missing orgs.)'
  })
  .option('users', {
    alias: 'u', type: 'string',
    describe: 'A file with a JSON object of {"github:MMMM": "github:NNNN"} user id mappings. ' +
      '(Optional, defaults to identity mapping.)'
  })
  .option('merge', {
    alias: 'm', type: 'boolean',
    describe: 'Extract data in a format suitable for merging users into an existing instance'
  })
  .option('source', {
    choices: HOSTING_ENVIRONMENTS, default: 'saas',
    describe: 'Source hosting environment. (Optional, defaults to saas.)'
  })
  .option('target', {
    choices: HOSTING_ENVIRONMENTS, default: 'ghes',
    describe: 'Target hosting environment. (Optional, defaults to ghes.)'
  })
  .option('output', {
    alias: 'o', type: 'string', demandOption: true,
    describe: 'Output ndJSON file for extracted data.'
  })
  .option('download', {
    alias: 'd', type: 'string', describe: 'Output directory for downloaded attachments'
  })
  .option('logging', {
    alias: 'l', type: 'boolean',
    describe: 'Turn on low-level Firebase logging for debugging purposes'
  })
  .strict()
  .version(false)
  .help()
  .parse();

let uploadedFilesUrlRegex;
if (uploadedFilesUrl) {
  uploadedFilesUrlRegex =
    new RegExp(`(${_.escapeRegExp(uploadedFilesUrl)})((?:[^())]|\\(\\d+\\))*)`, 'g');
} else {
  console.warn(
    'WARNING: no REVIEWABLE_UPLOADS_PROVIDER or REVIEWABLE_UPLOADED_FILES_URL specified, ' +
    'so not rewriting uploaded image URLs in comments.');
}

if (args.logging) NodeFire.enableFirebaseLogging(true);

const identityUserMap = !args.users;
const userMap = args.users ? JSON.parse(fs.readFileSync(args.users)) : {};
const orgMap = args.orgs ?
  _.mapKeys(JSON.parse(fs.readFileSync(args.orgs)), (value, key) => _.toLower(key)) : null;
const repoNames =
  _(args.repos).thru(fs.readFileSync).thru(JSON.parse).map(_.toLower).uniq().value();
const repoNamesSet = new Set(repoNames);
const orgNames = _(repoNames).map(name => name.replace(/\/.*/, '')).uniq().value();
const sourceGhostUserKey = args.source === 'saas' ? 'github:10137' : 'github:1';
const targetGhostUserKey = args.target === 'saas' ? 'github:10137' : 'github:1';

const out = new PromiseWritable(fs.createWriteStream(args.output));
out.stream.setMaxListeners(Infinity);

const pace = args.logging ?
  {op: _.noop, total: 0} :
  // eslint-disable-next-line new-cap
  Pace(1 + 2 + orgNames.length + 2 * repoNames.length + _.size(userMap));

let reviewKeys = [];
const reversePullRequests = {};
let ghostedUsers = [];
const unknownUsers = [];

const missingReviewKeys = [];
const missingOrgs = new Set();
const brokenFiles = [];
const downloadedFiles = new Set();

async function extract() {
  log('Connecting to Firebase');
  await import('./lib/loadFirebase.js');
  await extractSystem();
  await extractOrganizations();
  await extractRepositories();
  await extractRules();
  reviewKeys = _.uniq(reviewKeys);
  pace.total += 4 * reviewKeys.length;
  await extractReviews();
  await extractLinemaps();
  await extractFilemaps();
  await extractBasemaps();
  await extractUsers();
  await out.end();
  pace.op();
  console.log(
    `Extracted ${orgNames.length} organizations, ${repoNames.length} repositories, ` +
    `${reviewKeys.length} reviews, ${args.download ? '' : 'and '}${_.size(userMap)} users` + (
      args.download ? `, and ${downloadedFiles.size - brokenFiles.length} files` : ''
    )
  );
  logMissingReviews();
  logMissingOrgs();
  await logUnmappedUsers();
  logUnknownUsers();
  logBrokenFiles();
}

extract().then(() => {
  process.exit(0);
}, e => {
  console.log();
  if (e.errors) console.log(e.errors);
  console.log(e.stack);
  process.exit(1);
});


async function logUnmappedUsers() {
  if (!ghostedUsers.length) return;
  ghostedUsers = _.uniqBy(ghostedUsers, 'userKey');
  console.log(`\n${ghostedUsers.length} users could not be mapped over:`);
  const users = await mapLimit(ghostedUsers, 5, async item => {
    const user = await db.child('users/:userKey/core/public', {userKey: item.userKey}).get();
    return {
      username: user ? user.username : `user ${item.userKey.replace(/github:/, '')}`,
      context: item.context
    };
  });
  console.log(
    _(users)
      .sortBy(user => _.toLower(user.username))
      .map(user => `${user.username} @ ${user.context}`)
      .join('\n')
  );
}

function logUnknownUsers() {
  if (!unknownUsers.length) return;
  console.log(`\n${unknownUsers.length} users from map have no record in Reviewable:`);
  console.log(_(unknownUsers).map(userKey => userKey.replace('github:', '')).join(', '));
}

function logMissingReviews() {
  if (!missingReviewKeys.length) return;
  console.log(`\n${missingReviewKeys.length} reviews could not be found:`);
  console.log(_(missingReviewKeys).map(key => reversePullRequests[key]).sort().join('\n'));
}

function logMissingOrgs() {
  if (!missingOrgs.size) return;
  console.log(`\n${missingOrgs.size} owners could not be mapped over:`);
  console.log(_(missingOrgs).toArray().sort().join('\n'));
}

function logBrokenFiles() {
  if (!args.download || !brokenFiles.length) return;
  console.log(`\n${brokenFiles.length} files could not be downloaded:`);
  console.log(brokenFiles.join('\n'));
}

async function extractSystem() {
  log('Extracting /system');
  const system = await db.child('system').get();
  if (system.star && system.star !== '*' || system.bang && system.bang !== '!') {
    throw new Error('Bad or missing REVIEWABLE_ENCRYPTION_AES_KEY');
  }
  await writeItem('system/oldestUsedClientBuild', system.oldestUsedClientBuild);
  pace.op();
  await writeItem('system/oldestUsedServerBuild', system.oldestUsedServerBuild);
  pace.op();
}

async function extractOrganizations() {
  if (!orgNames.length) return;
  log('Extracting organizations');
  await forEachLimit(orgNames, 5, async org => {
    const organization = await db.child('organizations/:org', {org}).get();
    if (organization) {
      delete organization.owners;  // owners might be different in new instance
      delete organization.coverage;  // subscriptions might be different too
      if (!_.isEmpty(organization)) {
        await writeItem(`organizations/${toKey(mapOrg(org))}`, organization);
        if (organization.autoConnect) {
          // Ensure that the organization update recurring task is in the queue.
          await writeItem(`queues/memberships/${mapOrg(org)}`, {organization: mapOrg(org)});
        }
      }
    }
    pace.op();
  });
}

async function extractRepositories() {
  if (!repoNames.length) return;
  log('Extracting repositories');
  await forEachLimit(repoNames, 10, async repoName => {
    const [owner, repo] = repoName.split('/');
    let repository = await db.child('repositories/:owner/:repo', {owner, repo}).get();
    if (repository) {
      repository.core = _.omit(
        repository.core, 'id', 'connection', 'connector', 'reviewableBadge', 'errorCode',
        'error', 'hookEvents'
      );
      if (repository.core.renamed) {
        repository.core.renamed.ownerName = mapOrg(repository.core.renamed.ownerName);
      }
      repository = _.omit(
        repository, 'adminUserKeys', 'adminUserKeysLastUpdateTimestamp', 'pushUserKeys', 'current',
        'issues', 'protection'
      );
      reviewKeys = reviewKeys.concat(
        _.values(repository.pullRequests), _.values(repository.oldPullRequests));
      _.forEach(repository.pullRequests, (reviewKey, prNumber) => {
        reversePullRequests[reviewKey] = `${repoName}#${prNumber}`;
      });
      _.forEach(repository.oldPullRequests, (reviewKey, prNumber) => {
        reversePullRequests[reviewKey] = `${repoName}#${prNumber}`;
      });
      if (!_.isEmpty(repository)) {
        await writeItem(`repositories/${toKey(mapOrg(owner))}/${toKey(repo)}`, repository);
      }
    }
    pace.op();
  });
}

async function extractRules() {
  if (!repoNames.length) return;
  log('Extracting rules');
  await forEachLimit(repoNames, 10, async repoName => {
    const [owner, repo] = repoName.split('/');
    const rule = await db.child('rules/:owner/:repo', {owner, repo}).get();
    await writeItem(`rules/${toKey(mapOrg(owner))}/${toKey(repo)}`, rule);
    pace.op();
  });
}

async function extractReviews() {
  if (!reviewKeys.length) return;
  log('Extracting reviews');
  await forEachLimit(reviewKeys, 25, async reviewKey => {
    let review = await db.child('reviews/:reviewKey', {reviewKey}).get();
    if (review) {
      await stripReview(review, reviewKey);
      await writeItem(`reviews/${reviewKey}`, review);
    } else {
      const archive = await db.child('archivedReviews/:reviewKey', {reviewKey}).get();
      if (archive) {
        review = JSON.parse(zlib.gunzipSync(Buffer.from(archive.payload, 'base64')).toString());
        const placeholdersPresent = await stripReview(review, reviewKey);
        mapAllUserKeys(review, `reviews/${reviewKey}`);
        archive.payload =
          zlib.gzipSync(JSON.stringify(review), {level: zlib.constants.Z_BEST_COMPRESSION})
            .toString('base64');
        await writeItem(`archivedReviews/${reviewKey}`, archive, {placeholdersPresent});
      } else {
        missingReviewKeys.push(reviewKey);
      }
    }
    pace.op();
  });
}

async function stripReview(review, key) {
  let placeholderAdded = false;

  delete review.lastWebhook;
  delete review.requestedTeams;  // ids won't match in new instance; will resync
  delete review.gitHubComments;

  review.core = _.omit(review.core, 'lastSweepTimestamp', 'lastReconciliationTimestamp');
  if (review.core.ownerName) review.core.ownerName = mapOrg(review.core.ownerName);
  if (review.security) {
    review.security.lowerCaseOwnerName = _.toLower(mapOrg(review.security.lowerCaseOwnerName));
  }

  const downloadPromises = [];
  review.discussions = _.pickBy(review.discussions, discussion => {
    discussion.comments =
      _.pickBy(discussion.comments, (comment, commentKey) => !/^gh-/.test(commentKey));
    if (uploadedFilesUrl) {
      _.forEach(discussion.comments, comment => {
        if (!comment.markdownBody) return;
        const body = comment.markdownBody.replace(uploadedFilesUrlRegex, (match, host, rest) => {
          const url = host + rest;
          if (args.download && !downloadedFiles.has(url)) {
            downloadedFiles.add(url);
            const dest = path.join(args.download, path.dirname(rest.slice(1)));
            downloadPromises.push(download(url, dest).catch(e => {
              if (args.logging) log(`File download failed:\n${url}\n${e}`);
              brokenFiles.push(`${url} (${reversePullRequests[key]})`);
            }));
          }
          return PLACEHOLDER_URL + rest;
        });
        if (body !== comment.markdownBody) placeholderAdded = true;
        comment.markdownBody = body;
      });
    }
    return !_.isEmpty(discussion.comments);
  });
  if (_.isEmpty(review.discussions)) delete review.discussions;

  _.forEach(review.tracker, tracker => {
    tracker.participants = _.omitBy(tracker.participants, (participant, userKey) => {
      return !identityUserMap && !userMap[userKey] && participant.role === 'mentioned';
    });
  });

  review.sentiments = _.pickBy(review.sentiments, sentiment => {
    sentiment.comments =
      _.pickBy(sentiment.comments, (comment, commentKey) => !/^gh-/.test(commentKey));
    return !_.isEmpty(sentiment.comments);
  });
  if (_.isEmpty(review.sentiments)) delete review.sentiments;

  if (!_.isEmpty(downloadPromises)) await Promise.all(downloadPromises);
  return placeholderAdded;
}

async function extractLinemaps() {
  if (!reviewKeys.length) return;
  log('Extracting linemaps');
  await forEachLimit(reviewKeys, 25, async reviewKey => {
    const linemap = await db.child('linemaps/:reviewKey', {reviewKey}).get();
    await writeItem(`linemaps/${reviewKey}`, linemap);
    pace.op();
  });
}

async function extractFilemaps() {
  if (!reviewKeys.length) return;
  log('Extracting filemaps');
  await forEachLimit(reviewKeys, 25, async reviewKey => {
    const filemap = await db.child('filemaps/:reviewKey', {reviewKey}).get();
    await writeItem(`filemaps/${reviewKey}`, filemap);
    pace.op();
  });
}

async function extractBasemaps() {
  if (!reviewKeys.length) return;
  log('Extracting basemaps');
  await forEachLimit(reviewKeys, 25, async reviewKey => {
    const basemap = await db.child('basemaps/:reviewKey', {reviewKey}).get();
    await writeItem(`basemaps/${reviewKey}`, basemap);
    pace.op();
  });
}

async function extractUsers() {
  if (_.isEmpty(userMap)) return;
  log('Extracting users');
  await forEachOfLimit(userMap, 25, async (newUserKey, oldUserKey) => {
    if (newUserKey === targetGhostUserKey) return;
    let user = await db.child('users/:oldUserKey', {oldUserKey}).get();
    if (!user) {
      unknownUsers.push(oldUserKey);
      return;
    }
    user = _.omit(
      user, 'lastUpdateTimestamp', 'lastSeatAllocationTimestamp', 'lastOwnershipsSyncTimestamp',
      'enterpriseLicenseAdmin', 'core', 'dashboardCache', 'stripe', 'enrollments', 'notifications',
      'settings.dismissals', 'index.subscriptions', 'index.memberships'
    );
    if (user.index?.extraMentions) {
      user.index.extraMentions = _(user.index.extraMentions)
        .pick(mention => repoNamesSet.has(`${mention.owner}/${mention.repo}`))
        .mapKeys((value, key) => {
          const parts = key.split('|');
          parts[0] = mapOrg(parts[0]);
          return parts.join('|');
        })
        .mapValues(mention => {
          mention.owner = mapOrg(mention.owner);
          return mention;
        })
        .value();
      if (_.isEmpty(user.index.extraMentions)) delete user.index.extraMentions;
      if (_.isEmpty(user.index)) delete user.index;
    }
    if (user.settings?.lastDashboardOrganization) {
      user.settings.lastDashboardOrganization = mapOrg(user.settings.lastDashboardOrganization);
    }
    if (user.state) user.state = _.pick(user.state, reviewKeys);
    if (_.isEmpty(user.state)) delete user.state;
    if (args.merge) {
      const bareUser = _.omit(user, 'onboarding', 'settings', 'state', 'index');
      if (!_.isEmpty(bareUser)) await writeItem(`users/${newUserKey}`, bareUser);
      await forEachOf(['onboarding', 'settings', 'state'], async key => {
        if (!_.isEmpty(user[key])) await writeItem(`users/${newUserKey}/${key}`, user[key]);
      });
      if (user.index?.extraMentions) {
        await writeItem(`users/${newUserKey}/index/extraMentions`, user.index.extraMentions);
      }
    } else {
      await writeItem(`users/${newUserKey}`, user);
    }
    pace.op();
  });
}

async function writeItem(key, value, flags) {
  if (_.isNil(value)) return;
  value = mapAllUserKeys(value, key);
  if (flags) {
    await out.write(
      `[${JSON.stringify(key)}, ${JSON.stringify(value)}, ${JSON.stringify(flags)}]\n`);
  } else {
    await out.write(`[${JSON.stringify(key)}, ${JSON.stringify(value)}]\n`);
  }
}

function mapAllUserKeys(object, context) {
  if (_.isString(object)) {
    if (/^github:\d+$/.test(object)) return mapUserKey(object, context);
    if (/^github:\d+(\s*,\s*github:\d+)*$/.test(object)) {
      return _(object).split(/\s*,\s*/).map(mapUserKey).uniq().join(',');
    }
    if (/\|github:\d+$/.test(object)) {
      return object.replace(/\|github:\d+$/, match => `|${mapUserKey(match.slice(1))}`);
    }
  } else if (_.isObject(object)) {
    for (const key in object) {
      const value = mapAllUserKeys(object[key], context + '/' + key);
      const newKey = mapAllUserKeys(key, context + '/$key');
      if (key !== newKey) delete object[key];
      if (_.isObject(value) && _.isEmpty(value)) {
        delete object[key];
      } else {
        object[newKey] = value;
      }
    }
  }
  return object;
}

function mapUserKey(userKey, context) {
  if (identityUserMap && userKey === sourceGhostUserKey) return targetGhostUserKey;
  // A real source user may collide with the target ghost ID; leave it unmapped so it is reported.
  if (identityUserMap && !userMap[userKey] && userKey !== targetGhostUserKey) {
    userMap[userKey] = userKey;
    pace.total += 1;
  }
  const newUserKey = userMap[userKey] || targetGhostUserKey;
  if (!userMap[userKey] && userKey !== sourceGhostUserKey) ghostedUsers.push({userKey, context});
  return newUserKey;
}

function mapOrg(org) {
  if (!org) throw new Error('internal error: missing org argument');
  const mappedOrg = orgMap?.[_.toLower(org)];
  if (mappedOrg) return mappedOrg;
  if (orgMap) missingOrgs.add(_.toLower(org));
  return org;
}

function toKey(value) {
  return NodeFire.escape(value);
}

function log(...params) {
  if (args.logging) console.log('---', ...params);
}
