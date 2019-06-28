'use strict';

const path = require('path');
const debug = require('debug')('cabinet');

/*
 * most js resolver are lazy-loaded (only required when needed)
 * e.g. dont load requirejs when we only have commonjs modules to resolve
 * this makes testing your code using this lib much easier
 */

let getModuleType;
let resolve;

let amdLookup;
const stylusLookup = require('stylus-lookup');
const sassLookup = require('sass-lookup');
let ts;

let resolveDependencyPath;
const appModulePath = require('app-module-path');
let webpackResolve;
const isRelative = require('is-relative-path');

// For testing only
let noTsCache = false;

const defaultLookups = [
  {name: 'TS', keys: ['.ts', '.tsx', '.js', '.jsx'], resolver: tsLookup},
  {name: 'JS', keys: ['.js', '.jsx'], resolver: jsLookup},
  // Less and Sass imports are very similar
  {name: 'SASS', keys: ['.scss', '.sass', '.less'], resolver: sassLookup},
  {name: 'Stylus', keys: ['.styl'], resolver: stylusLookup}
];

module.exports = function cabinet(options) {
  debug('options', options);

  const {
    partial,
    filename,
    directory,
    config,
    nodeModulesConfig,
    webpackConfig,
    configPath,
    ast
  } = options;

  // TODO: Add tests for this option
  const fileExtension = path.extname(filename);
  const extensions = options.extensions ? [...new Set([...options.extensions, fileExtension])]
                                        : [fileExtension];

  let resolvers = defaultLookups.filter(({keys}) => keys.some(k => extensions.includes(k)));

  if (resolvers.length === 0) {
    debug('using generic resolver');
    if (!resolveDependencyPath) {
      resolveDependencyPath = require('resolve-dependency-path');
    }

    resolvers = [{name: 'generic', keys: extensions, resolver: resolveDependencyPath}];
  }

  debug(`found ${resolvers.length} resolvers for `, extensions);

  // TODO: Change all resolvers to accept an options argument
  let result;

  for (let resolverObj of resolvers) {
    const {name, resolver} = resolverObj;

    try {
      result = resolver(partial, filename, directory, config, webpackConfig, configPath, nodeModulesConfig, ast);

      if (result) {
        debug(`resolved path for ${partial} by ${name} resolver:`, result);
        break;
      } else {
        debug(`empty resolved path for ${partial} by ${name} resolver:`, result);
      }
    } catch (e) {
      debug(`failed to resolve path for ${partial} by ${name} resolver`);
    }
  }

  debug(`final resolved path for ${partial} :`, result);
  return result || '';
};

module.exports.supportedFileExtensions = defaultLookups.map(lookup => lookup.keys)
                                                       .reduce((result, current) => [...result, ...current], []);

/**
 * Register a custom lookup resolver for a file extension
 *
 * @param  {String} extension - The file extension that should use the resolver
 * @param  {Function} lookupStrategy - A resolver of partial paths
 */
module.exports.register = function(extension, lookupStrategy) {
  defaultLookups.unshift({name: 'custom', keys: [extension], resolver: lookupStrategy});

  if (!this.supportedFileExtensions.includes(extension)) {
    this.supportedFileExtensions.push(extension);
  }
};

/**
 * Exposed for testing
 *
 * @param  {Object} options
 * @param  {String} options.config
 * @param  {String} options.webpackConfig
 * @param  {String} options.filename
 * @param  {Object} options.ast
 * @return {String}
 */
module.exports._getJSType = function(options = {}) {
  if (!getModuleType) {
    getModuleType = require('module-definition');
  }

  if (options.config) {
    return 'amd';
  }

  if (options.webpackConfig) {
    return 'webpack';
  }

  if (options.ast) {
    debug('reusing the given ast');
    return getModuleType.fromSource(options.ast);
  }

  debug('using the filename to find the module type');
  return getModuleType.sync(options.filename);
};

/**
 * @private
 * @param  {String} partial
 * @param  {String} filename
 * @param  {String} directory
 * @param  {String} [config]
 * @param  {String} [webpackConfig]
 * @param  {String} [configPath]
 * @param  {Object} [nodeModulesConfig]
 * @param  {Object} [ast]
 * @return {String}
 */
function jsLookup(partial, filename, directory, config, webpackConfig, configPath, nodeModulesConfig, ast) {
  const type = module.exports._getJSType({
    config: config,
    webpackConfig: webpackConfig,
    filename: filename,
    ast: ast
  });

  switch (type) {
    case 'amd':
      debug('using amd resolver');
      if (!amdLookup) {
        amdLookup = require('module-lookup-amd');
      }

      return amdLookup({
        config: config,
        // Optional in case a pre-parsed config is being passed in
        configPath: configPath,
        partial: partial,
        directory: directory,
        filename: filename
      });

    case 'commonjs':
      debug('using commonjs resolver');
      return commonJSLookup(partial, filename, directory, nodeModulesConfig);

    case 'webpack':
      debug('using webpack resolver for es6');
      return resolveWebpackPath(partial, filename, directory, webpackConfig);

    case 'es6':
    default:
      debug('using commonjs resolver for es6');
      return commonJSLookup(partial, filename, directory, nodeModulesConfig);
  }
}

let tsHost;
let tsCacheDirectory;
let tsCache;

function getTsHost(directory) {
  if (noTsCache || !tsHost || directory !== tsCacheDirectory) {
    tsHost = ts.createCompilerHost({});
    tsCache = ts.createModuleResolutionCache(directory, x => tsHost.getCanonicalFileName(x));
    tsCacheDirectory = directory;

    debug('TS host and cache created for directory ', directory);
  }

  return tsHost;
}

function tsLookup(partial, filename, directory) {
  debug('performing a typescript lookup');

  if (!ts) {
    ts = require('typescript');
  }

  const options = {
    module: ts.ModuleKind.AMD
  };

  const host = getTsHost(directory);
  debug('with options: ', options);
  const resolvedModule = ts.resolveModuleName(partial, filename, options, host, tsCache).resolvedModule;
  debug('ts resolved module: ', resolvedModule);
  const result = resolvedModule ? resolvedModule.resolvedFileName : '';

  debug('result: ' + result);
  return result ? path.resolve(result) : '';
}

/**
 * @private
 * @param  {String} partial
 * @param  {String} filename
 * @param  {String} directory
 * @return {String}
 */
function commonJSLookup(partial, filename, directory, nodeModulesConfig) {
  if (!resolve) {
    resolve = require('resolve');
  }
  // Need to resolve partials within the directory of the module, not filing-cabinet
  const moduleLookupDir = path.join(directory, 'node_modules');

  debug('adding ' + moduleLookupDir + ' to the require resolution paths');

  appModulePath.addPath(moduleLookupDir);

  // Make sure the partial is being resolved to the filename's context
  // 3rd party modules will not be relative
  if (partial[0] === '.') {
    partial = path.resolve(path.dirname(filename), partial);
  }

  let result = '';

  // Allows us to configure what is used as the "main" entry point
  function packageFilter(packageJson) {
    packageJson.main = packageJson[nodeModulesConfig.entry] ? packageJson[nodeModulesConfig.entry] : packageJson.main;
    return packageJson;
  }

  try {
    result = resolve.sync(partial, {
      extensions: ['.js', '.jsx'],
      basedir: directory,
      packageFilter: nodeModulesConfig && nodeModulesConfig.entry ? packageFilter : undefined,
      // Add fileDir to resolve index.js files in that dir
      moduleDirectory: ['node_modules', directory]
    });
    debug('resolved path: ' + result);
  } catch (e) {
    debug('could not resolve ' + partial);
  }

  return result;
}

function resolveWebpackPath(partial, filename, directory, webpackConfig) {
  if (!webpackResolve) {
    webpackResolve = require('enhanced-resolve');
  }
  webpackConfig = path.resolve(webpackConfig);
  let loadedConfig;

  try {
    loadedConfig = require(webpackConfig);

    if (typeof loadedConfig === 'function') {
      loadedConfig = loadedConfig();
    }
  } catch (e) {
    debug('error loading the webpack config at ' + webpackConfig);
    debug(e.message);
    debug(e.stack);
    return '';
  }

  const resolveConfig = Object.assign({}, loadedConfig.resolve);

  if (!resolveConfig.modules && (resolveConfig.root || resolveConfig.modulesDirectories)) {
    resolveConfig.modules = [];

    if (resolveConfig.root) {
      resolveConfig.modules = resolveConfig.modules.concat(resolveConfig.root);
    }

    if (resolveConfig.modulesDirectories) {
      resolveConfig.modules = resolveConfig.modules.concat(resolveConfig.modulesDirectories);
    }
  }

  try {
    const resolver = webpackResolve.create.sync(resolveConfig);

    // We don't care about what the loader resolves the partial to
    // we only wnat the path of the resolved file
    partial = stripLoader(partial);

    const lookupPath = isRelative(partial) ? path.dirname(filename) : directory;

    return resolver(lookupPath, partial);
  } catch (e) {
    debug('error when resolving ' + partial);
    debug(e.message);
    debug(e.stack);
    return '';
  }
}

function stripLoader(partial) {
  const exclamationLocation = partial.indexOf('!');

  if (exclamationLocation === -1) { return partial; }

  return partial.slice(exclamationLocation + 1);
}
