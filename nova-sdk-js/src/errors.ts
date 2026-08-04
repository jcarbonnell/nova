// nova-sdk-js/src/errors.ts
//
// Extracted from index.ts so format.ts can throw NovaError without a circular
// import (index.ts → format.ts → errors.ts, acyclic). Re-exported from index.ts,
// so `import { NovaError } from 'nova-sdk-js'` keeps working unchanged.

export class NovaError extends Error {
  constructor(message: string, public cause?: Error) {
    super(message);
    this.name = 'NovaError';
  }
}
