"use strict";
// nova-sdk-js/src/errors.ts
//
// Extracted from index.ts so format.ts can throw NovaError without a circular
// import (index.ts → format.ts → errors.ts, acyclic). Re-exported from index.ts,
// so `import { NovaError } from 'nova-sdk-js'` keeps working unchanged.
Object.defineProperty(exports, "__esModule", { value: true });
exports.NovaError = void 0;
class NovaError extends Error {
    cause;
    constructor(message, cause) {
        super(message);
        this.cause = cause;
        this.name = 'NovaError';
    }
}
exports.NovaError = NovaError;
