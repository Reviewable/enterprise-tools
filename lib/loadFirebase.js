import nodefireModule from 'nodefire';
import app, {database} from './initializeFirebase.js';

const NodeFire = nodefireModule.default;

NodeFire.setCacheSize(0);
global.db = new NodeFire(database.ref());

export default app;
