// Pure gates. No SDK import, network call or secret persistence.
import { assert, exactKeys, object } from './domain.ts';
import { COVERAGE_PLAN_HASH, hash, LIMITS } from './coverage-spec.ts';
import { NAMESPACE, RELAYER } from './providers/walrus.ts';
import { ENDPOINTS } from './providers/tatum.ts';
export type RunPermit = { schema: 1; status: 'PREPARED_NOT_AUTHORIZED'; planHash: string; network: 'mainnet';
  namespace: string; relayer: string; tatumEndpoint: string; accountIdHash: string; sourceBundleHash: string;
  runtimeImageId: string; launcherSha256: string; limits: typeof LIMITS; readerTimeoutMs: 60000; additionalSpendLimitUSD: 0 };
export function validateRunPermit(raw: unknown): RunPermit {
  const p = object(raw);
  exactKeys(p, ['schema', 'status', 'planHash', 'network', 'namespace', 'relayer', 'tatumEndpoint', 'accountIdHash',
    'sourceBundleHash', 'runtimeImageId', 'launcherSha256', 'limits', 'readerTimeoutMs', 'additionalSpendLimitUSD']);
  assert(p.schema === 1 && p.status === 'PREPARED_NOT_AUTHORIZED' && p.planHash === COVERAGE_PLAN_HASH
    && p.network === 'mainnet' && p.namespace === NAMESPACE && p.relayer === RELAYER && p.tatumEndpoint === ENDPOINTS.mainnet
    && /^[a-f0-9]{64}$/.test(p.accountIdHash) && /^[a-f0-9]{64}$/.test(p.sourceBundleHash)
    && /^sha256:[a-f0-9]{64}$/.test(p.runtimeImageId) && /^[a-f0-9]{64}$/.test(p.launcherSha256) && hash(p.limits) === hash(LIMITS)
    && p.readerTimeoutMs === 60000 && p.additionalSpendLimitUSD === 0, 'COVERAGE_RUN_PERMIT_INVALID');
  return structuredClone(p) as RunPermit;
}
export function authorizeRun(raw: unknown, env: Record<string, string | undefined>, role: 'writer' | 'reader') {
  const permit = validateRunPermit(raw), permitHash = hash(permit);
  assert(env.RECALL_COVERAGE_MAINNET_APPROVED_HASH === permitHash
    && env.RECALL_COVERAGE_ZERO_SPEND_CONFIRMED_HASH === permitHash, 'COVERAGE_NEW_APPROVAL_REQUIRED');
  assert(env.RECALL_FREE_TIER_CONFIRMED === 'true' && env.RECALL_WALRUS_SPONSOR_CONFIRMED === 'true', 'COVERAGE_FREE_SPONSOR_REQUIRED');
  assert(env.RECALL_RUNTIME_IMAGE_ID === permit.runtimeImageId, 'COVERAGE_RUNTIME_CHANGED');
  assert(typeof env.MEMWAL_ACCOUNT_ID === 'string' && /^0x[a-fA-F0-9]{64}$/.test(env.MEMWAL_ACCOUNT_ID)
    && hash(env.MEMWAL_ACCOUNT_ID) === permit.accountIdHash, 'COVERAGE_ACCOUNT_CHANGED');
  assert(env.MEMWAL_KEY && (role === 'reader' || env.TATUM_API_KEY), 'COVERAGE_CREDENTIALS_MISSING');
  if (role === 'reader') assert(!env.TATUM_API_KEY && !env.CLOUDFLARE_API_TOKEN, 'COVERAGE_READER_EXCESS_CREDENTIALS');
  return { permit, permitHash };
}
export function readerEnvironment(env: Record<string, string | undefined>) {
  const allowed = ['MEMWAL_KEY', 'MEMWAL_ACCOUNT_ID', 'RECALL_COVERAGE_MAINNET_APPROVED_HASH',
    'RECALL_COVERAGE_ZERO_SPEND_CONFIRMED_HASH', 'RECALL_FREE_TIER_CONFIRMED', 'RECALL_WALRUS_SPONSOR_CONFIRMED', 'RECALL_RUNTIME_IMAGE_ID'];
  return Object.fromEntries(allowed.filter(k => env[k] !== undefined).map(k => [k, env[k]!])) as Record<string, string>;
}
