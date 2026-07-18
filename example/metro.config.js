const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

// The library lives one level up (this example is a subfolder of the repo and
// depends on it via `link:..`). Metro needs to watch the repo root so it can
// read the symlinked package's `dist/`, and it must resolve modules from both
// node_modules trees. React/React-Native are absent from the lib's
// node_modules, so there's no duplicate-React hazard.
const root = path.resolve(__dirname, '..');

/** @type {import('@react-native/metro-config').MetroConfig} */
const config = {
  watchFolders: [root],
  resolver: {
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(root, 'node_modules'),
    ],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
