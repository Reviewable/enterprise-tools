'use strict';

const _ = require('lodash');
const fs = require('fs');
const bytes = require('bytes');
const admin = require('firebase-admin');
const NodeFire = require('nodefire').default;

const FIRECRYPT_CACHE_SIZE = bytes.parse('50mb');
NodeFire.setCacheSize(0);

if (!process.env.REVIEWABLE_FIREBASE) {
  console.log('Missing required environment variable: REVIEWABLE_FIREBASE');
  process.exit(1);
}

if (process.env.REVIEWABLE_ENCRYPTION_AES_KEY) {
  // Importing FireCrypt has the side-effect of patching admin.initializeApp() to return FireCrypt
  // objects instead of standard Firebase Database objects.
  require('firecrypt').patchFirebase();
}

const firebaseConfig = {
  databaseURL: `https://${process.env.REVIEWABLE_FIREBASE}.firebaseio.com`,
  databaseAuthVariableOverride: {uid: 'server'},
};

if (process.env.REVIEWABLE_FIREBASE_CREDENTIALS_FILE) {
  let fileIssue;
  if (!fs.existsSync(process.env.REVIEWABLE_FIREBASE_CREDENTIALS_FILE)) {
    fileIssue = 'does not exist';
  } else if (fs.lstatSync(process.env.REVIEWABLE_FIREBASE_CREDENTIALS_FILE).isDirectory()) {
    fileIssue = 'is a directory, not a file';
  }

  if (!_.isUndefined(fileIssue)) {
    throw new Error(
      `Unable to authenticate the Firebase Admin SDK. The path to a Firebase service account key \
JSON file specified via the REVIEWABLE_FIREBASE_CREDENTIALS_FILE environment variable \
(${process.env.REVIEWABLE_FIREBASE_CREDENTIALS_FILE}) ${fileIssue}. Navigate to \
https://console.firebase.google.com/u/0/project/_/settings/serviceaccounts/adminsdk to generate \
that file and make sure the specified path is correct.`
    );
  }

  const serviceAccount =
    JSON.parse(fs.readFileSync(process.env.REVIEWABLE_FIREBASE_CREDENTIALS_FILE));

  firebaseConfig.credential = admin.credential.cert(serviceAccount);
} else if (
  process.env.REVIEWABLE_FIREBASE_PROJECT_ID &&
  process.env.REVIEWABLE_FIREBASE_CLIENT_EMAIL &&
  process.env.REVIEWABLE_FIREBASE_PRIVATE_KEY
) {
  firebaseConfig.credential = admin.credential.cert({
    projectId: process.env.REVIEWABLE_FIREBASE_PROJECT_ID,
    clientEmail: process.env.REVIEWABLE_FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.REVIEWABLE_FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });
} else {
  throw new Error(
    `Unable to authenticate the Firebase Admin SDK. Either the path to a Firebase service account \
key JSON file must be specified via the REVIEWABLE_FIREBASE_CREDENTIALS_FILE environment variable \
or the REVIEWABLE_FIREBASE_PROJECT_ID, REVIEWABLE_FIREBASE_CLIENT_EMAIL, and \
REVIEWABLE_FIREBASE_PRIVATE_KEY environment variables must all be set. Navigate to \
https://console.firebase.google.com/u/0/project/_/settings/serviceaccounts/adminsdk to generate \
a key JSON file with the required values.`
  );
}

admin.initializeApp(firebaseConfig);

if (process.env.REVIEWABLE_ENCRYPTION_AES_KEY) {
  const options = {
    algorithm: 'aes-siv', key: process.env.REVIEWABLE_ENCRYPTION_AES_KEY,
    cacheSize: FIRECRYPT_CACHE_SIZE
  };
  const specification = JSON.parse(fs.readFileSync('rules_firecrypt.json', 'utf8'));
  admin.database().configureEncryption(options, specification);
}

global.db = new NodeFire(admin.database().ref());

module.exports = admin;
