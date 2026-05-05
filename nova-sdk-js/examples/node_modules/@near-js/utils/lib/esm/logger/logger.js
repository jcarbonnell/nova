// src/logger/console.logger.ts
var ConsoleLogger = class {
  constructor(logLevels) {
    this.logLevels = logLevels;
  }
  isLevelEnabled = (level) => {
    return this.logLevels.includes(level);
  };
  print(level, message, ...optionalParams) {
    switch (level) {
      case "error":
      case "fatal":
        return console.error(message, ...optionalParams);
      case "warn":
        return console.warn(message, ...optionalParams);
      case "log":
        return console.log(message, ...optionalParams);
      case "debug":
      case "verbose":
        return console.debug(message, ...optionalParams);
    }
  }
  verbose(message, ...optionalParams) {
    if (!this.isLevelEnabled("verbose")) return;
    this.print("verbose", message, ...optionalParams);
  }
  debug(message, ...optionalParams) {
    if (!this.isLevelEnabled("debug")) return;
    this.print("debug", message, ...optionalParams);
  }
  log(message, ...optionalParams) {
    if (!this.isLevelEnabled("log")) return;
    this.print("log", message, ...optionalParams);
  }
  warn(message, ...optionalParams) {
    if (!this.isLevelEnabled("warn")) return;
    this.print("warn", message, ...optionalParams);
  }
  error(message, ...optionalParams) {
    if (!this.isLevelEnabled("error")) return;
    this.print("error", message, ...optionalParams);
  }
  fatal(message, ...optionalParams) {
    if (!this.isLevelEnabled("fatal")) return;
    this.print("fatal", message, ...optionalParams);
  }
};

// src/logger/logger.ts
var DEFAULT_LOG_LEVELS = [
  "verbose",
  "debug",
  "log",
  "warn",
  "error",
  "fatal"
];
var DEFAULT_LOGGER = new ConsoleLogger(DEFAULT_LOG_LEVELS);
var Logger = class {
  static instanceRef = DEFAULT_LOGGER;
  /** @deprecated Will be removed in the next major release */
  static overrideLogger = (logger) => {
    this.instanceRef = logger;
  };
  static error(message, ...optionalParams) {
    this.instanceRef?.error(message, ...optionalParams);
  }
  /**
   * Write a 'log' level log.
   */
  static log(message, ...optionalParams) {
    this.instanceRef?.log(message, ...optionalParams);
  }
  /**
   * Write a 'warn' level log.
   */
  static warn(message, ...optionalParams) {
    this.instanceRef?.warn(message, ...optionalParams);
  }
  /**
   * Write a 'debug' level log.
   */
  static debug(message, ...optionalParams) {
    this.instanceRef?.debug?.(message, ...optionalParams);
  }
  /**
   * Write a 'verbose' level log.
   */
  static verbose(message, ...optionalParams) {
    this.instanceRef?.verbose?.(message, ...optionalParams);
  }
  static fatal(message, ...optionalParams) {
    this.instanceRef?.fatal?.(message, ...optionalParams);
  }
};
export {
  Logger
};
