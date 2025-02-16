import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import camelCase from 'lodash/camelCase';
import { ConfigLoader, Routine, Predicates } from '@boost/core';
import Beemo from '../Beemo';
import Driver from '../Driver';
import ConfigContext from '../contexts/ConfigContext';
import { STRATEGY_COPY, STRATEGY_REFERENCE, STRATEGY_CREATE, STRATEGY_NATIVE } from '../constants';

export interface ConfigObject {
  [key: string]: unknown;
}

export interface CreateConfigOptions {
  driver: Driver;
}

export default class CreateConfigRoutine<Ctx extends ConfigContext> extends Routine<
  Ctx,
  Beemo,
  CreateConfigOptions
> {
  blueprint({ instance }: Predicates) /* infer */ {
    return {
      driver: instance(Driver as $FixMe, true)
        .required()
        .notNullable(),
    } as $FixMe;
  }

  bootstrap() {
    const { tool } = this;
    const { metadata, options } = this.options.driver;
    const name = metadata.title;
    const strategy =
      options.strategy === STRATEGY_NATIVE ? metadata.configStrategy : options.strategy;

    this.task(tool.msg('app:configSetEnvVars', { name }), this.setEnvVars);

    switch (strategy) {
      case STRATEGY_REFERENCE:
        this.task(tool.msg('app:configReference', { name }), this.referenceConfigFile);
        break;

      case STRATEGY_COPY:
        this.task(tool.msg('app:configCopy', { name }), this.copyConfigFile);
        break;

      case STRATEGY_CREATE:
        this.task(tool.msg('app:configCreateLoadFile', { name }), this.loadConfigFromSources);
        this.task(tool.msg('app:configCreateLoadPackage', { name }), this.extractConfigFromPackage);
        this.task(tool.msg('app:configCreateMerge', { name }), this.mergeConfigs);
        this.task(tool.msg('app:configCreate', { name }), this.createConfigFile);
        break;

      default:
        this.skip(true);
        break;
    }
  }

  execute(): Promise<string> {
    return this.serializeTasks([]);
  }

  /**
   * Copy configuration file from module.
   */
  async copyConfigFile(context: Ctx): Promise<string> {
    const { driver } = this.options;
    const { metadata, name } = driver;
    const configLoader = new ConfigLoader(this.tool);
    const sourcePath = this.getConfigPath(configLoader);
    const configPath = path.join(context.cwd, metadata.configName);

    if (!sourcePath) {
      throw new Error(this.tool.msg('errors:configCopySourceMissing'));
    }

    const config = this.loadConfig(configLoader, sourcePath);

    this.debug('Copying config file to %s', chalk.cyan(configPath));

    driver.config = config;
    driver.onCopyConfigFile.emit([context, configPath, config]);

    context.addConfigPath(name, configPath);

    return fs
      .copy(sourcePath, configPath, {
        overwrite: true,
      })
      .then(() => configPath);
  }

  /**
   * Create a temporary configuration file or pass as an option.
   */
  async createConfigFile(context: Ctx, config: object): Promise<string> {
    const { driver } = this.options;
    const { metadata, name } = driver;
    const configPath = path.join(context.cwd, metadata.configName);

    this.debug('Creating config file %s', chalk.cyan(configPath));

    driver.config = config as $FixMe;
    driver.onCreateConfigFile.emit([context, configPath, config]);

    context.addConfigPath(name, configPath);

    return fs
      .writeFile(configPath, this.options.driver.formatConfig(config))
      .then(() => configPath);
  }

  /**
   * Extract configuration from "beemo.<driver>" within the local project's package.json.
   */
  extractConfigFromPackage(context: Ctx, prevConfigs: ConfigObject[]): Promise<ConfigObject[]> {
    const { driver } = this.options;
    const { name } = driver;
    const { config } = this.tool;
    const configs = [...prevConfigs];
    const configName = this.getConfigName(name);

    this.debug.invariant(
      !!config[configName],
      `Extracting ${chalk.green(name)} config from package.json`,
      'Exists, extracting',
      'Does not exist, skipping',
    );

    if (config[configName]) {
      const pkgConfig = config[configName] as $FixMe;

      configs.push(pkgConfig);
      driver.onLoadPackageConfig.emit([context, pkgConfig]);
    }

    return Promise.resolve(configs);
  }

  /**
   * Return file name camel cased.
   */
  getConfigName(name: string): string {
    return camelCase(name);
  }

  /**
   * Return absolute file path for config file within configuration module,
   * or an empty string if it does not exist.
   */
  getConfigPath(configLoader: ConfigLoader, forceLocal: boolean = false): string {
    const { cwd, workspaceRoot } = this.context;
    const moduleName = this.tool.config.module;
    const { name } = this.options.driver;
    const configName = this.getConfigName(name);
    const isLocal = moduleName === '@local' || forceLocal;

    // Allow for local development
    const filePath = isLocal
      ? path.join(workspaceRoot || cwd, `configs/${configName}.js`)
      : configLoader.resolveModuleConfigPath(configName, moduleName);
    const fileExists = fs.existsSync(filePath);

    this.debug.invariant(
      fileExists,
      isLocal
        ? `Loading ${chalk.green(name)} config from local consumer`
        : `Loading ${chalk.green(name)} config from configuration module ${chalk.yellow(
            moduleName,
          )}`,
      'Exists, loading',
      'Does not exist, skipping',
    );

    return fileExists ? filePath : '';
  }

  /**
   * Merge multiple configuration sources using the current driver.
   */
  mergeConfigs(context: Ctx, configs: ConfigObject[]): Promise<ConfigObject> {
    const { driver } = this.options;
    const { name } = driver;

    this.debug('Merging %s config from %d sources', chalk.green(name), configs.length);

    const config = configs.reduce(
      (masterConfig, cfg) => this.options.driver.mergeConfig(masterConfig, cfg),
      {},
    );

    driver.onMergeConfig.emit([context, config]);

    return Promise.resolve(config);
  }

  /**
   * Load a config file with passing the args and tool to the file.
   */
  loadConfig(configLoader: ConfigLoader, filePath: string): ConfigObject {
    const config: ConfigObject = configLoader.parseFile(filePath, [], { errorOnFunction: true });

    this.options.driver.onLoadModuleConfig.emit([this.context, filePath, config]);

    return config;
  }

  /**
   * Load config from the provider configuration module
   * and from the local configs/ folder in the consumer.
   */
  loadConfigFromSources(context: Ctx, prevConfigs: ConfigObject[]): Promise<ConfigObject[]> {
    const configLoader = new ConfigLoader(this.tool);
    const modulePath = this.getConfigPath(configLoader);
    const localPath = this.getConfigPath(configLoader, true);
    const configs = [...prevConfigs];

    if (modulePath) {
      configs.push(this.loadConfig(configLoader, modulePath));
    }

    // Local files should override anything defined in the configuration module above
    // Also don't double load files, so check against @local to avoid
    if (localPath && localPath !== modulePath) {
      configs.push(this.loadConfig(configLoader, localPath));
    }

    return Promise.resolve(configs);
  }

  /**
   * Reference configuration file from module using a require statement.
   */
  referenceConfigFile(context: Ctx): Promise<string> {
    const { driver } = this.options;
    const { metadata, name } = driver;
    const configLoader = new ConfigLoader(this.tool);
    const sourcePath = this.getConfigPath(configLoader);
    const configPath = path.join(context.cwd, metadata.configName);

    if (!sourcePath) {
      throw new Error(this.tool.msg('errors:configReferenceSourceMissing'));
    }

    const config = this.loadConfig(configLoader, sourcePath);

    this.debug('Referencing config file to %s', chalk.cyan(configPath));

    driver.config = config;
    driver.onReferenceConfigFile.emit([context, configPath, config]);

    context.addConfigPath(name, configPath);

    return fs
      .writeFile(
        configPath,
        `module.exports = require('./${path.relative(context.cwd, sourcePath)}');`,
      )
      .then(() => configPath);
  }

  /**
   * Set environment variables defined by the driver.
   */
  setEnvVars(context: Ctx, configs: ConfigObject[]): Promise<unknown> {
    const { env } = this.options.driver.options;

    // TODO: This may cause collisions, isolate in a child process?
    Object.keys(env).forEach(key => {
      process.env[key] = env[key];
    });

    return Promise.resolve(configs);
  }
}
