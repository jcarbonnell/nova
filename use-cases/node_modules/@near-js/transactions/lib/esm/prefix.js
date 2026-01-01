const ACTIONABLE_MESSAGE_BASE = Math.pow(2, 30);
const NEP = {
  MetaTransactions: 366
};
class NEPPrefix {
  prefix;
  constructor({ prefix }) {
    this.prefix = prefix;
  }
}
class ActionableMessagePrefix extends NEPPrefix {
  /** Given the NEP number, set the prefix using 2^30 as the offset **/
  constructor(prefix) {
    super({ prefix: ACTIONABLE_MESSAGE_BASE + prefix });
  }
}
class DelegateActionPrefix extends ActionableMessagePrefix {
  constructor() {
    super(NEP.MetaTransactions);
  }
}
export {
  DelegateActionPrefix
};
