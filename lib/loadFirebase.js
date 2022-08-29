import _ from 'lodash';
import * as fs from 'fs';
import * as bytes from 'bytes';
import * as path from 'path';
import {fileURLToPath} from 'url';
import admin from 'firebase-admin';
import nodefireModule from 'nodefire';
import {wrapDatabaseWithEncryption} from 'firecrypt';

const NodeFire = nodefireModule.default;

const FIRECRYPT_CACHE_SIZE = bytes.parse('50mb');
NodeFire.setCacheSize(0);

if (!process.env.REVIEWABLE_FIREBASE_URL && process.env.REVIEWABLE_FIREBASE) {
  process.env.REVIEWABLE_FIREBASE_URL = `https://${process.env.REVIEWABLE_FIREBASE}.firebaseio.com`;
}

if (!process.env.REVIEWABLE_FIREBASE_URL) {
  console.log('Missing required environment variable: REVIEWABLE_FIREBASE_URL');
  process.exit(1);
}

const firebaseConfig = {
  databaseURL: process.env.REVIEWABLE_FIREBASE_URL,
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

let database = admin.database();
if (process.env.REVIEWABLE_ENCRYPTION_AES_KEY) {
  const firecrypt = database = wrapDatabaseWithEncryption(database);
  const options = {
    algorithm: 'aes-siv', key: process.env.REVIEWABLE_ENCRYPTION_AES_KEY,
    cacheSize: FIRECRYPT_CACHE_SIZE
  };
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const specification = JSON.parse(fs.readFileSync(
    path.join(dirname, '..', 'rules_firecrypt.json'), 'utf8'));
  firecrypt.configureEncryption(options, specification);
}

global.db = new NodeFire(database.ref());

export default admin;
