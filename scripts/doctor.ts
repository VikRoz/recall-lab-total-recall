import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export function diagnose(env: Record<string, string | undefined> = process.env) {
  const require = createRequire(import.meta.url);
  const packages = ['@mysten-incubation/memwal', '@mysten/sui/grpc', '@mysten/seal', '@protobuf-ts/grpc-transport', '@grpc/grpc-js'];
  const checks = packages.map(name => {
    try { require.resolve(name); return { name, status: 'PRESENT_UNVERIFIED' }; }
    catch { return { name, status: 'MISSING_DEPENDENCY' }; }
  });
  const keys = ['TATUM_API_KEY', 'MEMWAL_KEY', 'MEMWAL_ACCOUNT_ID', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'];
  for (const name of keys) checks.push({ name, status: env[name] ? 'PRESENT_UNVERIFIED' : 'MISSING_CREDENTIAL' });
  for (const name of ['RECALL_FREE_TIER_CONFIRMED', 'RECALL_WALRUS_SPONSOR_CONFIRMED'])
    checks.push({ name, status: env[name] === 'true' ? 'OPERATOR_CONFIRMED' : 'NOT_CONFIRMED' });
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  const sdkRuntime = major > 22 || (major === 22 && (minor > 23 || (minor === 23 && patch >= 4)));
  checks.push({ name: 'Walrus documented Node prerequisite', status: sdkRuntime ? 'PRESENT_UNVERIFIED' : 'RUNTIME_UPGRADE_REQUIRED' });
  const blocked = checks.some(x => ['MISSING_DEPENDENCY', 'MISSING_CREDENTIAL', 'NOT_CONFIRMED', 'RUNTIME_UPGRADE_REQUIRED'].includes(x.status));
  return { stage: 0, status: blocked ? 'BLOCKED' : 'SETUP_READY_LIVE_UNVERIFIED', runtime: process.version, additionalSpendLimitUSD: 0, networkCalls: 0,
    checks, liveGates: { tatumRead: 'NOT_RUN', modelInference: 'NOT_RUN', mainnetWrite: 'NOT_RUN', cleanClientRecall: 'NOT_RUN', workerCPU: 'NOT_RUN', d1: 'NOT_RUN' } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(diagnose(), null, 2)); process.exitCode = 2;
}
