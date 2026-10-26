// tests/wallet-signer.test.ts
// Deliverable 2 (A): self-custodial wallet-signer mode. Unit tests with a mocked
// signer, mocked MCP (axios) and mocked contract views (provider.query).
// Every test records one ordered event log: `view:<method>`, `wallet:<method>`,
// `mcp:<tool>`, so ordering guarantees are asserted directly.
import { NovaSdk, NovaError, NovaWalletSigner, WalletFunctionCall } from '../src/index';
import axios from 'axios';
import crypto from 'crypto';

jest.mock('axios');
const mockAxiosPost = axios.post as jest.MockedFunction<typeof axios.post>;
const mockAxiosIsAxiosError = axios.isAxiosError as jest.MockedFunction<typeof axios.isAxiosError>;

const ACCOUNT = 'alice.near';
const MCP = 'https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network';
const KEY_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const LOCATION = 'nova-sdk.near/fastfs.near/test-group/abc123';
const FEES: Record<string, bigint> = {
  register_group: 640_000_000_000_000_000_000_000n,
  add_group_member: 12_900_000_000_000_000_000n,
  revoke_group_member: 1_000_000_000_000_000_000n,
  record_transaction: 25_600_000_000_000_000_000n,
  join_group: 1_000_000_000_000_000_000n,
};

// Injected nova_session with an exp one hour ahead (no mint call in wallet mode).
function sessionToken(): string {
  const b64u = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ account_id: ACCOUNT, exp })}.sig`;
}

let events: string[];
let walletCalls: WalletFunctionCall[];
let mcpBodies: Record<string, Record<string, unknown>>;
let mcpResponses: Record<string, unknown>;
let authorized: boolean;
let walletBehaviour: 'ok' | 'reject';

function makeSigner(accountId = ACCOUNT): NovaWalletSigner {
  return {
    accountId,
    signAndSendFunctionCall: jest.fn(async (call: WalletFunctionCall) => {
      events.push(`wallet:${call.methodName}`);
      walletCalls.push(call);
      if (walletBehaviour === 'reject') throw new Error('User rejected the request');
      return { txHash: `TX_${call.methodName}` };
    }),
  };
}

function makeSdk(opts: { wallet?: boolean } = { wallet: true }): NovaSdk {
  const sdk = new NovaSdk(ACCOUNT, {
    sessionToken: sessionToken(),
    ...(opts.wallet ? { walletSigner: makeSigner() } : {}),
  });
  // Contract views by method name.
  jest.spyOn((sdk as any).provider, 'query').mockImplementation(async (req: any) => {
    events.push(`view:${req.method_name}`);
    const args = JSON.parse(Buffer.from(req.args_base64, 'base64').toString());
    if (req.method_name === 'estimate_fee') {
      return { result: Buffer.from(String(FEES[args.action] ?? 0n)) };
    }
    if (req.method_name === 'is_authorized') {
      return { result: Buffer.from(String(authorized)) };
    }
    throw new Error(`unexpected view ${req.method_name}`);
  });
  return sdk;
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockAxiosIsAxiosError.mockImplementation(
    (e: unknown) => e !== null && typeof e === 'object' && 'isAxiosError' in (e as object),
  );

  events = [];
  walletCalls = [];
  mcpBodies = {};
  authorized = false;
  walletBehaviour = 'ok';
  mcpResponses = {
    register_group: { message: "Group 'test-group' registered successfully" },
    add_group_member: { result: "Added bob.near to group 'test-group'" },
    revoke_group_member: { message: "Revoked bob.near from group 'test-group'" },
    set_group_retention: { message: "Set retention for group 'test-group' to 30 days" },
    join_group: { result: "Joined group 'open-group'" },
    prepare_upload: {
      upload_id: 'up-1', key: KEY_B64, group_id: 'test-group', filename: 'hello.txt', location: LOCATION,
    },
    finalize_upload: { location: LOCATION, cid: LOCATION, trans_id: 'trans-1', file_hash: 'f'.repeat(64) },
  };

  mockAxiosPost.mockImplementation((async (url: string, body: Record<string, unknown>) => {
    const tool = String(url).split('/tools/')[1];
    if (!tool) throw new Error(`unexpected POST ${url}`); // no session-token mint in these tests
    events.push(`mcp:${tool}`);
    mcpBodies[tool] = body;
    if (!(tool in mcpResponses)) throw new Error(`unexpected tool ${tool}`);
    return { status: 200, data: mcpResponses[tool] };
  }) as any);
});

afterEach(() => jest.restoreAllMocks());

describe('wallet signer — construction', () => {
  test('rejects a signer for a different account', () => {
    expect(() => new NovaSdk(ACCOUNT, {
      sessionToken: sessionToken(),
      walletSigner: makeSigner('mallory.near'),
    })).toThrow(/does not match SDK account/);
  });

  test('signerMode reports the mode', () => {
    expect(makeSdk({ wallet: true }).signerMode).toBe('wallet');
    expect(makeSdk({ wallet: false }).signerMode).toBe('nova');
  });
});

describe('wallet signer — owner operations', () => {
  test('registerGroup: live fee → wallet → MCP, deposit equals estimate_fee', async () => {
    const sdk = makeSdk();
    await sdk.registerGroup('test-group');
    expect(events).toEqual(['view:estimate_fee', 'wallet:register_group', 'mcp:register_group']);
    expect(walletCalls[0]).toMatchObject({
      receiverId: 'nova-sdk.near',
      methodName: 'register_group',
      args: { group_id: 'test-group' },
      deposit: FEES.register_group,
    });
    expect(walletCalls[0].gas).toBeGreaterThan(0n);
    expect(mcpBodies.register_group).toEqual({ group_id: 'test-group' });
  });

  test('registerGroup: declined wallet ⇒ NovaError, MCP never called', async () => {
    walletBehaviour = 'reject';
    const sdk = makeSdk();
    await expect(sdk.registerGroup('test-group')).rejects.toThrow(NovaError);
    await expect(sdk.registerGroup('test-group')).rejects.toThrow(/register_group' failed or was rejected/);
    expect(events.filter(e => e.startsWith('mcp:'))).toEqual([]);
  });

  test('addGroupMember: wallet (user_id) → MCP (member_id)', async () => {
    const sdk = makeSdk();
    await sdk.addGroupMember('test-group', 'bob.near');
    expect(events).toEqual(['view:estimate_fee', 'wallet:add_group_member', 'mcp:add_group_member']);
    expect(walletCalls[0].args).toEqual({ group_id: 'test-group', user_id: 'bob.near' });
    expect(walletCalls[0].deposit).toBe(FEES.add_group_member);
    expect(mcpBodies.add_group_member).toEqual({ group_id: 'test-group', member_id: 'bob.near' });
  });

  test('addGroupMember with accessMinutes is refused before ANY call', async () => {
    const sdk = makeSdk();
    await expect(
      sdk.addGroupMember('test-group', 'bob.near', { accessMinutes: 60 }),
    ).rejects.toThrow(/not available for wallet-owned groups/);
    expect(events).toEqual([]);
  });

  test('revokeGroupMember: wallet → MCP (key rotation after on-chain revoke)', async () => {
    const sdk = makeSdk();
    await sdk.revokeGroupMember('test-group', 'bob.near');
    expect(events).toEqual(['view:estimate_fee', 'wallet:revoke_group_member', 'mcp:revoke_group_member']);
    expect(walletCalls[0].args).toEqual({ group_id: 'test-group', user_id: 'bob.near' });
    expect(walletCalls[0].deposit).toBe(FEES.revoke_group_member);
  });

  test('revokeGroupMember: declined wallet ⇒ MCP never called (no rotation)', async () => {
    walletBehaviour = 'reject';
    const sdk = makeSdk();
    await expect(sdk.revokeGroupMember('test-group', 'bob.near')).rejects.toThrow(NovaError);
    expect(events.filter(e => e.startsWith('mcp:'))).toEqual([]);
  });

  test.each([30, null])('setGroupRetention(%p): MCP registry FIRST, then zero-fee wallet call', async (days) => {
    const sdk = makeSdk();
    await sdk.setGroupRetention('test-group', days);
    expect(events).toEqual(['mcp:set_group_retention', 'wallet:set_group_retention']); // no fee view
    expect(walletCalls[0].deposit).toBe(0n);
    expect(walletCalls[0].args).toEqual({ group_id: 'test-group', retention_days: days });
  });
});

describe('wallet signer — member operations', () => {
  test('joinGroup: not a member ⇒ wallet join_group, no MCP call', async () => {
    authorized = false;
    const sdk = makeSdk();
    await sdk.joinGroup('open-group');
    expect(events).toEqual(['view:is_authorized', 'view:estimate_fee', 'wallet:join_group']);
    expect(walletCalls[0].deposit).toBe(FEES.join_group);
  });

  test('joinGroup: already a member ⇒ no wallet prompt', async () => {
    authorized = true;
    const sdk = makeSdk();
    expect(await sdk.joinGroup('open-group')).toContain('Already a member');
    expect(events).toEqual(['view:is_authorized']);
  });
});

describe('wallet signer — upload (record-first)', () => {
  const data = Buffer.from('Hello NOVA!');
  const plainHash = crypto.createHash('sha256').update(data).digest('hex');

  test('order: prepare → fee → wallet record_transaction → finalize(tx_hash)', async () => {
    const sdk = makeSdk();
    const res = await sdk.upload('test-group', data, 'hello.txt');
    expect(events).toEqual([
      'mcp:prepare_upload', 'view:estimate_fee', 'wallet:record_transaction', 'mcp:finalize_upload',
    ]);
    expect(walletCalls[0].args).toEqual({
      group_id: 'test-group',
      user_id: ACCOUNT,
      file_hash: plainHash,
      ipfs_hash: LOCATION,
      backend: 'FastFS',
    });
    expect(walletCalls[0].deposit).toBe(FEES.record_transaction);
    expect(mcpBodies.finalize_upload).toMatchObject({
      upload_id: 'up-1', file_hash: plainHash, tx_hash: 'TX_record_transaction',
    });
    expect(res).toEqual({ cid: LOCATION, trans_id: 'trans-1', file_hash: 'f'.repeat(64) });
  });

  test('declined wallet ⇒ finalize never called (no bytes stored)', async () => {
    walletBehaviour = 'reject';
    const sdk = makeSdk();
    await expect(sdk.upload('test-group', data, 'hello.txt')).rejects.toThrow(/record_transaction' failed or was rejected/);
    expect(events).not.toContain('mcp:finalize_upload');
  });

  test('MCP without location ⇒ refused before the wallet prompt', async () => {
    const { location, ...noLocation } = mcpResponses.prepare_upload as Record<string, unknown>;
    void location;
    mcpResponses.prepare_upload = noLocation;
    const sdk = makeSdk();
    await expect(sdk.upload('test-group', data, 'hello.txt')).rejects.toThrow(/no upload location/);
    expect(events).toEqual(['mcp:prepare_upload']);
  });
});

describe('regression — NOVA-signed mode is unchanged', () => {
  test('upload: no fee view, no tx_hash, exactly prepare → finalize', async () => {
    const sdk = makeSdk({ wallet: false });
    await sdk.upload('test-group', Buffer.from('x'), 'x.txt');
    expect(events).toEqual(['mcp:prepare_upload', 'mcp:finalize_upload']);
    expect(mcpBodies.finalize_upload).not.toHaveProperty('tx_hash');
  });

  test('owner + member ops go straight to MCP', async () => {
    const sdk = makeSdk({ wallet: false });
    await sdk.registerGroup('test-group');
    await sdk.addGroupMember('test-group', 'bob.near');
    await sdk.revokeGroupMember('test-group', 'bob.near');
    await sdk.setGroupRetention('test-group', 30);
    authorized = false;
    await sdk.joinGroup('open-group');
    expect(events).toEqual([
      'mcp:register_group', 'mcp:add_group_member', 'mcp:revoke_group_member',
      'mcp:set_group_retention', 'view:is_authorized', 'mcp:join_group',
    ]);
  });

  test('accessMinutes still allowed in NOVA-signed mode', async () => {
    const sdk = makeSdk({ wallet: false });
    await sdk.addGroupMember('test-group', 'bob.near', { accessMinutes: 60 });
    expect(mcpBodies.add_group_member).toEqual({ group_id: 'test-group', member_id: 'bob.near', access_minutes: 60 });
  });
});