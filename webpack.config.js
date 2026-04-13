const path = require('path')
const { ModuleFederationPlugin } = require('webpack').container
const { WatchIgnorePlugin } = require('webpack')
// Registers shared webpack dependencies (React singleton, etc.) for Module Federation.
// Required for its side effects even though the return value is unused.
require('@signalk/server-admin-ui-dependencies')
const packageJson = require('./package.json')

module.exports = {
  entry: './src/components/AppPanel',
  mode: 'production',
  output: {
    path: path.resolve(__dirname, 'public'),
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js', '.jsx'],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: 'ts-loader',
        exclude: /node_modules/,
        options: {
          configFile: 'tsconfig.webpack.json',
        },
      },
    ],
  },
  plugins: [
    new ModuleFederationPlugin({
      name: packageJson.name.replace(/[-@/]/g, '_'),
      library: { type: 'var', name: packageJson.name.replace(/[-@/]/g, '_') },
      filename: 'remoteEntry.js',
      exposes: {
        './AppPanel': './src/components/AppPanel',
      },
      shared: [{ react: { singleton: true } }],
    }),
    new WatchIgnorePlugin({
      paths: [path.resolve(__dirname, 'public/')],
    }),
  ],
}
