import reviewableConfigBaseline from 'reviewable-configs/eslint-config/baseline.js';
import reviewableConfigLodash from 'reviewable-configs/eslint-config/lodash.js';
import globals from 'globals';

export default [
  ...reviewableConfigBaseline,
  ...reviewableConfigLodash,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        db: false
      }
    }
  }
];
