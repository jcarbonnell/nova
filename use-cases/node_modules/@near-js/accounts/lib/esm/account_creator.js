import depd from "depd";
class AccountCreator {
  constructor() {
    const deprecate = depd("AccountCreator");
    deprecate(`${this.constructor.name} is deprecated and will be removed in the next major release`);
  }
}
class LocalAccountCreator extends AccountCreator {
  masterAccount;
  initialBalance;
  constructor(masterAccount, initialBalance) {
    super();
    this.masterAccount = masterAccount;
    this.initialBalance = initialBalance;
  }
  /**
   * Creates an account using a masterAccount, meaning the new account is created from an existing account
   * @param newAccountId The name of the NEAR account to be created
   * @param publicKey The public key from the masterAccount used to create this account
   * @returns {Promise<void>}
   */
  async createAccount(newAccountId, publicKey) {
    await this.masterAccount.createAccount(newAccountId, publicKey, this.initialBalance);
  }
}
class UrlAccountCreator extends AccountCreator {
  connection;
  helperUrl;
  constructor(connection, helperUrl) {
    super();
    this.connection = connection;
    this.helperUrl = helperUrl;
  }
  /**
   * Creates an account using a helperUrl
   * This is [hosted here](https://helper.nearprotocol.com) or set up locally with the [near-contract-helper](https://github.com/nearprotocol/near-contract-helper) repository
   * @param newAccountId The name of the NEAR account to be created
   * @param publicKey The public key from the masterAccount used to create this account
   * @returns {Promise<void>}
   */
  async createAccount(newAccountId, publicKey) {
    await fetch(`${this.helperUrl}/account`, {
      body: JSON.stringify({ newAccountId, newAccountPublicKey: publicKey.toString() }),
      method: "POST"
    });
  }
}
export {
  AccountCreator,
  LocalAccountCreator,
  UrlAccountCreator
};
