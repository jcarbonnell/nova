import { FungibleToken } from './ft/index.js';

declare const wNEAR: FungibleToken;
declare const USDC: FungibleToken;
declare const USDT: FungibleToken;

declare const index_USDC: typeof USDC;
declare const index_USDT: typeof USDT;
declare const index_wNEAR: typeof wNEAR;
declare namespace index {
  export { index_USDC as USDC, index_USDT as USDT, index_wNEAR as wNEAR };
}

export { USDC as U, USDT as a, index as i, wNEAR as w };
