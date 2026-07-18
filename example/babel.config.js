/**
 * The two react-native-mcp-kit babel plugins:
 *   • dev   -> test-id-plugin: stamps data-mcp-id on JSX + emits __mcp_hooks
 *              metadata so fiber_tree can recover component & hook names.
 *   • prod  -> strip-plugin: removes every trace of the kit from the bundle.
 * NODE_ENV is 'development' for `run-ios`/`run-android` and 'production' for
 * release bundles, so the right plugin is picked automatically.
 */
module.exports = function (api) {
  api.cache.using(() => process.env.NODE_ENV);
  const isProd = process.env.NODE_ENV === 'production';
  return {
    presets: ['module:@react-native/babel-preset'],
    plugins: [
      isProd
        ? 'react-native-mcp-kit/babel/strip-plugin'
        : 'react-native-mcp-kit/babel/test-id-plugin',
    ],
  };
};
