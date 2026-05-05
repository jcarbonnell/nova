/**
 * NEAR RPC API request types and responses
 * @module
 */
interface CurrentEpochValidatorInfo {
    account_id: string;
    public_key: string;
    is_slashed: boolean;
    stake: string;
    shards: number[];
    num_produced_blocks: number;
    num_expected_blocks: number;
}
interface NextEpochValidatorInfo {
    account_id: string;
    public_key: string;
    stake: string;
    shards: number[];
}
interface ValidatorStakeView {
    account_id: string;
    public_key: string;
    stake: string;
    validator_stake_struct_version: string;
}
interface EpochValidatorInfo {
    next_validators: NextEpochValidatorInfo[];
    current_validators: CurrentEpochValidatorInfo[];
    next_fisherman: ValidatorStakeView[];
    current_fisherman: ValidatorStakeView[];
    current_proposals: ValidatorStakeView[];
    prev_epoch_kickout: ValidatorStakeView[];
    epoch_start_height: number;
}
interface StakedAccount {
    account_id: string;
    unstaked_balance: string;
    staked_balance: string;
    can_withdraw: boolean;
}

export type { CurrentEpochValidatorInfo, EpochValidatorInfo, NextEpochValidatorInfo, StakedAccount, ValidatorStakeView };
