import { KeyPairSigner } from "@near-js/signers";
import {
  JsonRpcProvider,
  FailoverRpcProvider
} from "@near-js/providers";
import depd from "depd";
function getProvider(config) {
  switch (config.type) {
    case void 0:
      return config;
    case "JsonRpcProvider":
      return new JsonRpcProvider({ ...config.args });
    case "FailoverRpcProvider": {
      const providers = (config?.args || []).map(
        (arg) => new JsonRpcProvider(arg)
      );
      return new FailoverRpcProvider(providers);
    }
    default:
      throw new Error(`Unknown provider type ${config.type}`);
  }
}
function getSigner(config) {
  switch (config.type) {
    case void 0:
      return config;
    case "KeyPairSigner": {
      return new KeyPairSigner(config.keyPair);
    }
    default:
      throw new Error(`Unknown signer type ${config.type}`);
  }
}
class Connection {
  networkId;
  provider;
  signer;
  constructor(networkId, provider, signer) {
    const deprecate = depd("new Connection(networkId, provider, signer)");
    deprecate("`Connection` is no longer used anywhere, please switch to constructing `Account` without it - use `new Account(accountId, provider, signer)`");
    this.networkId = networkId;
    this.provider = provider;
    this.signer = signer;
  }
  getConnection() {
    return this;
  }
  /**
   * @param config Contains connection info details
   */
  static fromConfig(config) {
    const provider = getProvider(config.provider);
    const signer = getSigner(config.signer);
    return new Connection(
      config.networkId,
      provider,
      signer
    );
  }
}
export {
  Connection
};
