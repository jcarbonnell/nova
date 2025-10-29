module.exports = {
  presets: [
    ['@babel/preset-env', { targets: { node: 'current' } }],  // Node-compatible
    '@babel/preset-typescript'  // TS support
  ],
  plugins: [
    '@babel/plugin-transform-modules-commonjs'  // ESM → CJS (fixes @noble export)
  ],
  ignore: ['/node_modules/(?!(@noble)/)']  // Transpile @noble (like transformIgnorePatterns)
};