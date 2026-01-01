import * as LRU from "lru_map";
class Storage {
  cache;
  static MAX_ELEMENTS = 100;
  // map block hash to block height
  blockHeights;
  constructor(options = { max: Storage.MAX_ELEMENTS }) {
    this.cache = new LRU.LRUMap(options.max);
    this.blockHeights = /* @__PURE__ */ new Map();
  }
  load(blockRef) {
    const noBlockId = !("blockId" in blockRef);
    if (noBlockId) return void 0;
    let blockId = blockRef.blockId;
    if (blockId.toString().length == 44) {
      blockId = this.blockHeights.get(blockId.toString());
    }
    return this.cache.get(blockId);
  }
  save(blockHash, { blockHeight, blockTimestamp, contractCode, contractState }) {
    this.blockHeights.set(blockHash, blockHeight);
    this.cache.set(blockHeight, { blockHeight, blockTimestamp, contractCode, contractState });
  }
}
export {
  Storage
};
