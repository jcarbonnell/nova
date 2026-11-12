/** Replace anything credential-shaped in a string. */
export declare function redact(text: string): string;
/** What an HTTP failure becomes: status and the server's own error text, nothing else. */
export interface HttpCause extends Error {
    name: 'HttpError';
    status?: number;
    error?: string;
}
export declare class NovaError extends Error {
    cause?: Error;
    constructor(message: string, cause?: unknown);
}
//# sourceMappingURL=errors.d.ts.map