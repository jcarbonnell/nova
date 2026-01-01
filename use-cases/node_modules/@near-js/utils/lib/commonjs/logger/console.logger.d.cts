import { LoggerService, LogLevel } from './interface.cjs';

/**
 * @deprecated Will be removed in the next major release
 */
declare class ConsoleLogger implements LoggerService {
    protected readonly logLevels: LogLevel[];
    constructor(logLevels: LogLevel[]);
    isLevelEnabled: (level: LogLevel) => boolean;
    private print;
    verbose(message: any, ...optionalParams: any[]): void;
    debug(message: any, ...optionalParams: any[]): void;
    log(message: any, ...optionalParams: any[]): void;
    warn(message: any, ...optionalParams: any[]): void;
    error(message: any, ...optionalParams: any[]): void;
    fatal(message: any, ...optionalParams: any[]): void;
}

export { ConsoleLogger };
