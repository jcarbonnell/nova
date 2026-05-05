import { FinalExecutionOutcome } from '@near-js/types';

/** @hidden */
declare function getTransactionLastResult(txResult: FinalExecutionOutcome): Exclude<object | string | number | null, Function>;

export { getTransactionLastResult };
