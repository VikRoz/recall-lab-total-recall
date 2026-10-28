import { assert, Fault } from '../domain.ts';
import type { Network, Snapshot } from '../domain.ts';

export const ENDPOINTS = {
  mainnet: 'https://sui-mainnet-grpc.gateway.tatum.io',
  testnet: 'https://sui-testnet-grpc.gateway.tatum.io',
} as const;
export class TatumData {
  client: any; network: Network; dispose: () => void; closed = false;
  constructor(client: any, network: Network, dispose: () => void = () => {}) {
    this.client = client; this.network = network; this.dispose = dispose;
  }
  close() { if (!this.closed) { this.closed = true; this.dispose(); } }
  async checkpoint(sequenceNumber?: string): Promise<Snapshot> {
    assert(sequenceNumber === undefined || /^(0|[1-9][0-9]*)$/.test(sequenceNumber), 'INVALID_CHECKPOINT');
    const call = await this.client.ledgerService.getCheckpoint({
      // The raw protobuf client requires an explicit unset oneof for latest.
      checkpointId: sequenceNumber === undefined
        ? { oneofKind: undefined }
        : { oneofKind: 'sequenceNumber', sequenceNumber },
      readMask: { paths: ['sequence_number', 'digest', 'summary.timestamp'] },
    }, { abort: AbortSignal.timeout(10000), timeout: 10000 });
    const c = call.response?.checkpoint;
    // The generated SDK decodes uint64 as bigint; keep the app contract as an exact decimal string.
    const sequence = typeof c?.sequenceNumber === 'bigint' ? c.sequenceNumber.toString() : c?.sequenceNumber;
    assert(c && typeof sequence === 'string' && /^(0|[1-9][0-9]*)$/.test(sequence)
      && typeof c.digest === 'string' && c.summary?.timestamp, 'TATUM_RESPONSE_INVALID');
    assert(sequenceNumber === undefined || sequence === sequenceNumber, 'TATUM_CHECKPOINT_MISMATCH');
    const seconds = Number(c.summary.timestamp.seconds), nanos = c.summary.timestamp.nanos ?? 0;
    assert(Number.isSafeInteger(seconds) && Number.isInteger(nanos) && nanos >= 0 && nanos < 1000000000, 'TATUM_TIMESTAMP_INVALID');
    return { network: this.network, target: 'checkpoint:' + sequence, version: sequence,
      asOf: new Date(seconds * 1000 + Math.floor(nanos / 1000000)).toISOString(),
      fields: { digest: c.digest, sequenceNumber: sequence }, source: 'tatum' };
  }
}
export async function connectTatum(env: Record<string, string | undefined>, network: Network = 'mainnet') {
  assert(env.TATUM_API_KEY, 'TATUM_CREDENTIALS_MISSING');
  const packageName = '@mysten/sui/grpc';
  let sdk: any;
  try { sdk = await import(packageName); } catch { throw new Fault('SUI_SDK_NOT_INSTALLED'); }
  const transportPackage = '@protobuf-ts/grpc-transport', grpcPackage = '@grpc/grpc-js';
  let transports: any, grpc: any;
  try { [transports, grpc] = await Promise.all([import(transportPackage), import(grpcPackage)]); }
  catch { throw new Fault('SUI_NATIVE_TRANSPORT_NOT_INSTALLED'); }
  const host = new URL(ENDPOINTS[network]).hostname + ':443';
  const channelCredentials = grpc.ChannelCredentials.createSsl();
  // Own the channel explicitly so every caller can release its HTTP/2 resources.
  const owner = new grpc.Client(host, channelCredentials, {
    'grpc.enable_retries': 0,
    'grpc.max_send_message_length': 65536,
    'grpc.max_receive_message_length': 1048576,
  });
  try {
    const transport = new transports.GrpcTransport({
      host, channelCredentials, clientOptions: { channelOverride: owner.getChannel() },
      meta: { 'x-api-key': env.TATUM_API_KEY }, timeout: 10000,
    });
    const client = new sdk.SuiGrpcClient({ network, transport });
    return new TatumData(client, network, () => owner.close());
  } catch (error) { owner.close(); throw error; }
}
