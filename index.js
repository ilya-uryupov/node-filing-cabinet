'use strict';

const fs = require('fs');
const path = require('path');
const process = require('process');
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
  {name: 'TS', keys: ['.js', '.jsx', '.ts', '.tsx'], resolver: tsLookup},
  {name: 'JS', keys: ['.js', '.jsx'], resolver: jsLookup},
  // Less and Sass imports are very similar
  {name: 'SASS', keys: ['.scss', '.sass', '.less'], resolver: sassLookup},
  {name: 'Stylus', keys: ['.styl'], resolver: stylusLookup}
];

/**
 * @param {Object} options
 * @param {String} options.partial The dependency being looked up
 * @param {String} options.filename The file that contains the dependency being looked up
 * @param {String|Object} [options.config] Path to a requirejs config
 * @param {String} [options.configPath] For AMD resolution, if the config is an object, this represents the location of
 *   the config file.
 * @param {Object} [options.nodeModulesConfig] Config for overriding the entry point defined in a package json file
 * @param {String} [options.nodeModulesConfig.entry] The new value for "main" in package json
 * @param {String} [options.webpackConfig] Path to the webpack config
 * @param {Object} [options.ast] A preparsed AST for the file identified by filename.
 * @param {Object} [options.tsConfig] Path to a typescript config file
 * @param {boolean} [options.noTypeDefinitions] Whether to return '.d.ts' files or '.js' files for a dependency
 */
module.exports = function cabinet(options) {
  debug('options', options);

  const {
    partial,
    filename,
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
      options.dependency = partial;
      result = resolver(options);

      if (result) {
        debug(`resolved path for ${partial} by ${name} resolver:`, result);
        break;
      } else {
        debug(`empty resolved path for ${partial} by ${name} resolver:`, result);
      }
    } catch (e) {
      debug(`failed to resolve path for ${partial} by ${name} resolver`, e);
    }
  }

  debug(`final resolved path for ${partial} :`, result);
  return result || '';
};

module.exports.supportedFileExtensions = [...(
  defaultLookups.map(lookup => lookup.keys)
                .reduce((result, keys) => {
                  keys.forEach(k => result.add(k));
                  return result;
                }, new Set())
)];

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

module.exports.setDefaultResolver = function(name) {
  const resolverIndex = defaultLookups.findIndex(lookup => lookup.name === name);

  if (resolverIndex < 0) {
    throw new Error(`Failed to find resolver by name "${name}"`);
  }

  if (resolverIndex === 0) {
    return;
  }

  [defaultLookups[0], defaultLookups[resolverIndex]] = [defaultLookups[resolverIndex], defaultLookups[0]];
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
 * @param {Object} options
 * @param  {String} options.dependency
 * @param  {String} options.filename
 * @param  {String} options.directory
 * @param  {String} [options.config]
 * @param  {String} [options.webpackConfig]
 * @param  {String} [options.configPath]
 * @param  {Object} [options.nodeModulesConfig]
 * @param  {Object} [options.ast]
 * @return {String}
 */
function jsLookup({dependency, filename, directory, config, webpackConfig, configPath, nodeModulesConfig, ast}) {
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
        partial: dependency,
        directory: directory,
        filename: filename
      });

    case 'commonjs':
      debug('using commonjs resolver');
      return commonJSLookup({dependency, filename, directory, nodeModulesConfig});

    case 'webpack':
      debug('using webpack resolver for es6');
      return resolveWebpackPath({dependency, filename, directory, webpackConfig});

    case 'es6':
    default:
      debug('using commonjs resolver for es6');
      return commonJSLookup({dependency, filename, directory, nodeModulesConfig});
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

let tsOptionsCache = new Map();

function getCompilerOptionsFromTsConfig(tsConfig) {
  if (tsOptionsCache.has(tsConfig)) {
    debug('typescript options cache hit: ', tsConfig);
    return tsOptionsCache.get(tsConfig);
  }

  debug('given typescript config: ', tsConfig);

  let tsOptionsJson = {};

  let tsBasePath = process.cwd();

  if (tsConfig) {
    if (typeof tsConfig === 'string') {
      debug('string tsconfig given, reading file');

      try {
        const configText = fs.readFileSync(tsConfig, 'utf8');
        tsOptionsJson = ts.parseConfigFileTextToJson(tsConfig, configText).config;
        tsBasePath = path.dirname(tsConfig);

        debug('successfully parsed tsconfig');
      } catch (e) {
        debug('could not parse tsconfig', e);
        throw new Error('could not read tsconfig');
      }
    } else if (typeof tsConfig === 'object') {
      tsOptionsJson = tsConfig;
    } else {
      throw new Error(`Unexpected type of tsconfig: ${typeof tsConfig}`);
    }
  } else {
    debug('no tsconfig given, defaulting');
  }

  debug('processed typescript options: ', tsOptionsJson);
  debug('processed typescript options type: ', typeof tsOptionsJson);

  const {options} = ts.convertCompilerOptionsFromJson(tsOptionsJson.compilerOptions, tsBasePath);

  // Preserve for backcompat. Consider removing this as a breaking change.
  if (!options.module) {
    options.module = ts.ModuleKind.AMD;
  }

  tsOptionsCache.set(tsConfig, options);

  return options;
}

function tsLookup({dependency, filename, directory, tsConfig, noTypeDefinitions}) {
  debug('performing a typescript lookup');

  if (!ts) {
    ts = require('typescript');
  }

  const options = getCompilerOptionsFromTsConfig(tsConfig);

  debug('with options: ', options);

  const host = getTsHost(directory);
  const namedModule = ts.resolveModuleName(dependency, filename, options, host, tsCache);
  let result = '';

  if (namedModule.resolvedModule) {
    result = namedModule.resolvedModule.resolvedFileName;
    if (namedModule.resolvedModule.extension === '.d.ts' && noTypeDefinitions) {
      result = ts.resolveJSModule(dependency, path.dirname(filename), host) || result;
    }
  } else {
    const suffix = '.d.ts';
    const lookUpLocations = namedModule.failedLookupLocations
                                       .filter((string) => string.endsWith(suffix))
                                       .map((string) => string.substr(0, string.length - suffix.length));

    result = lookUpLocations.find(ts.sys.fileExists) || '';
  }

  debug('result: ' + result);
  return result ? path.resolve(result) : '';
}

function commonJSLookup({dependency, filename, directory, nodeModulesConfig}) {
  if (!resolve) {
    resolve = require('resolve');
  }

  if (!dependency) {
    debug('blank dependency given. Returning early.');
    return '';
  }

  // Need to resolve partials within the directory of the module, not filing-cabinet
  const moduleLookupDir = path.join(directory, 'node_modules');

  debug('adding ' + moduleLookupDir + ' to the require resolution paths');

  appModulePath.addPath(moduleLookupDir);

  // Make sure the partial is being resolved to the filename's context
  // 3rd party modules will not be relative
  if (dependency[0] === '.') {
    dependency = path.resolve(path.dirname(filename), dependency);
  }

  let result = '';

  // Allows us to configure what is used as the "main" entry point
  function packageFilter(packageJson) {
    packageJson.main = packageJson[nodeModulesConfig.entry] ? packageJson[nodeModulesConfig.entry] : packageJson.main;
    return packageJson;
  }

  try {
    result = resolve.sync(dependency, {
      extensions: ['.js', '.jsx'],
      basedir: directory,
      packageFilter: nodeModulesConfig && nodeModulesConfig.entry ? packageFilter : undefined,
      // Add fileDir to resolve index.js files in that dir
      moduleDirectory: ['node_modules', directory]
    });
    debug('resolved path: ' + result);
  } catch (e) {
    debug('could not resolve ' + dependency);
  }

  return result;
}

function resolveWebpackPath({dependency, filename, directory, webpackConfig}) {
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

    // We don't care about what the loader resolves the dependency to
    // we only wnat the path of the resolved file
    dependency = stripLoader(dependency);

    const lookupPath = isRelative(dependency) ? path.dirname(filename) : directory;

    return resolver(lookupPath, dependency);
  } catch (e) {
    debug('error when resolving ' + dependency);
    debug(e.message);
    debug(e.stack);
    return '';
  }
}

function stripLoader(dependency) {
  const exclamationLocation = dependency.indexOf('!');

  if (exclamationLocation === -1) { return dependency; }

  return dependency.slice(exclamationLocation + 1);
}
