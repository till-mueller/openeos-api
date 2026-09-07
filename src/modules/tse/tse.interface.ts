import { TseTransactionData } from '../../database/entities/payment.entity';

export interface TseFiskalyConfig {
  apiKey: string;
  apiSecret: string;
  tssId: string;
}

/** Local/offline hardware TSE (e.g. Swissbit) reached via an on-prem printer-agent. */
export interface TseLocalConfig {
  /** The printer-agent Device that has the TSE stick attached. */
  agentDeviceId: string;
  /**
   * Populated by TseService at call time (not part of the persisted org
   * settings) — needed to address the agent's org-scoped gateway room.
   */
  organizationId: string;
}

export interface TseTransactionInput {
  /** Needed by the local provider to address the right org's gateway room; harmless for cloud providers. */
  organizationId: string;
  clientId: string;
  amount: number;
  currency: string;
  paymentMethod: string;
}

export interface TseExportInput {
  organizationId: string;
  clientId: string;
  periodStart: Date;
  periodEnd: Date;
}

export interface TseExportResult {
  /** Raw export archive bytes (TR-03153 TAR export, or provider-native format). */
  data: Buffer;
  filename: string;
}

/** Result of a signed transaction, before the `failed` outage flag is applied. */
export type TseTransactionResult = Omit<TseTransactionData, 'failed' | 'failureReason'>;

export interface TseProvider<TConfig = TseFiskalyConfig | TseLocalConfig> {
  readonly name: 'fiskaly' | 'local' | 'none';

  /** Idempotently register `clientId` as a till on the TSS. No-op for providers where registration happens inline with signing. */
  ensureClient(config: TConfig, clientId: string): Promise<void>;

  /**
   * Sign one completed sale as an immediate (start+finish) transaction. Split
   * payments and multi-step baskets each get their own signed transaction —
   * KassenSichV requires the TSE to cover the "Geschäftsvorfall" but does not
   * mandate a single transaction span multiple payments.
   */
  recordTransaction(config: TConfig, input: TseTransactionInput): Promise<TseTransactionResult>;

  testConnection(config: TConfig): Promise<{ ok: boolean; message?: string }>;

  /**
   * Export one client's signed transaction log for a date range — the
   * handover artifact a weekend renter keeps for their own 10-year
   * Aufbewahrungspflicht once the shared hardware moves to the next renter.
   * Optional: providers that don't support programmatic export (yet) omit it.
   */
  exportData?(config: TConfig, input: TseExportInput): Promise<TseExportResult>;
}
