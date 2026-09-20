import { TseTransactionData } from '../../database/entities/payment.entity';

export interface TseFiskalyConfig {
  apiKey: string;
  apiSecret: string;
  tssId: string;
  /**
   * Set once by createTss's own bootstrap and persisted alongside tssId.
   * fiskaly's createClient requires an admin-authenticated session; this
   * lets ensureClient re-authenticate and retry if a later client
   * registration (e.g. a new till's first sale) needs it and the session
   * has lapsed. The one-time admin_puk fiskaly returns at TSS creation is
   * deliberately NOT persisted here or anywhere else -- fiskaly itself
   * stops returning it once the TSS leaves state CREATED, and it's only
   * needed once, to set this PIN in the first place.
   */
  adminPin?: string;
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

/** Gross amount for one USt rate inside a signed transaction. */
export interface TseVatSplit {
  /** 19 | 7 | 0 — the only rates openEOS can produce (tax-rates.ts). */
  rate: number;
  grossAmount: number;
}

export interface TseTransactionInput {
  /** Needed by the local provider to address the right org's gateway room; harmless for cloud providers. */
  organizationId: string;
  clientId: string;
  amount: number;
  currency: string;
  paymentMethod: string;
  /**
   * Per-rate gross splits; sum must equal `amount` exactly (callers use
   * allocateToAmount). KassenSichV/DSFinV-K require the true rate split —
   * sending the full amount at NORMAL was the pre-compliance behavior.
   */
  vatSplits: TseVatSplit[];
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

  /**
   * Provisions a brand-new TSS end-to-end: create it, and walk its
   * lifecycle from CREATED through UNINITIALIZED to INITIALIZED (fiskaly
   * always starts a new TSS in CREATED regardless of what's requested).
   * Does not register a client itself -- the caller (TseService) does that
   * afterward with the returned tssId, via the regular ensureClient path,
   * so there's exactly one place that registers clients. There's no "adopt
   * an existing TSS" path here, only "create one openEOS controls
   * end-to-end". Optional: only cloud providers with a comparable resource
   * have this.
   */
  createTss?(apiKey: string, apiSecret: string): Promise<{ tssId: string; adminPin: string }>;

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
