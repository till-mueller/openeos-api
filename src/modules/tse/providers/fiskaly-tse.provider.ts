import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  TseFiskalyConfig,
  TseProvider,
  TseTransactionInput,
  TseTransactionResult,
  TseExportInput,
  TseExportResult,
} from '../tse.interface';

interface FiskalyAuthResponse {
  access_token: string;
}

interface FiskalySignature {
  value: string;
  algorithm: string;
  public_key: string;
  counter: number;
  time: number;
}

interface FiskalyTx {
  number: number;
  time_start: string;
  time_end?: string;
  state: 'ACTIVE' | 'FINISHED' | 'CANCELLED';
  qr_code_data?: string;
  signature?: FiskalySignature;
}

interface FiskalyTss {
  serial_number: string;
  state?: string;
  admin_puk?: string;
}

/**
 * fiskaly Cloud TSE (SIGN DE) — a cloud-hosted TSE certified under
 * KassenSichV. This talks to the real REST API, but the request/response
 * shapes here follow fiskaly's v2 docs as of this writing; verify against a
 * provisioned TSS before relying on it in production, since fiskaly does
 * version their schema (`schema/version`) and this integrates against
 * "Kassenbeleg-V1" only.
 *
 * The API base defaults to the fiskaly TEST environment so test credentials
 * work out of the box; point `FISKALY_API_BASE` at the LIVE base URL to
 * sign real receipts.
 */
@Injectable()
export class FiskalyTseProvider implements TseProvider<TseFiskalyConfig> {
  readonly name = 'fiskaly' as const;
  private readonly logger = new Logger(FiskalyTseProvider.name);
  private tokenCache = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly configService: ConfigService) {}

  private get apiBase(): string {
    return this.configService.get<string>('fiskaly.baseUrl', 'https://kassensichv-middleware.fiskaly.com/api/v2');
  }

  private async getAccessToken(config: TseFiskalyConfig): Promise<string> {
    const cached = this.tokenCache.get(config.apiKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }

    const res = await fetch(`${this.apiBase}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: config.apiKey, api_secret: config.apiSecret }),
    });
    if (!res.ok) {
      throw new Error(`fiskaly auth failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as FiskalyAuthResponse;
    // JWTs in the TEST environment expire after ~600s, in production after
    // ~24h. Refresh well before that in either case.
    this.tokenCache.set(config.apiKey, { token: data.access_token, expiresAt: Date.now() + 45 * 60 * 1000 });
    return data.access_token;
  }

  private async request<T>(
    config: TseFiskalyConfig,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.getAccessToken(config);
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`fiskaly ${method} ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  /**
   * Creates and fully initializes a new TSS from scratch: fiskaly always
   * starts a TSS in state CREATED (whatever `state` you pass at creation is
   * ignored -- confirmed live), and CREATED cannot sign transactions or
   * register clients. The real transition path, confirmed against
   * fiskaly's own docs and live sandbox testing, is:
   *
   *   CREATED --PATCH state=UNINITIALIZED--> UNINITIALIZED
   *     (fiskaly requires a short settle time here; empirically ~30s+)
   *   --PATCH /admin {admin_puk, new_admin_pin}--> (admin PIN set)
   *   --POST /admin/auth {admin_pin}--> (admin session established)
   *   --PATCH state=INITIALIZED--> INITIALIZED (can now sign / register clients)
   *
   * admin_puk is a one-time-reveal value only present in the response right
   * after creation -- fiskaly stops returning it once the TSS leaves
   * CREATED, so it's used here and only here, never persisted.
   */
  async createTss(apiKey: string, apiSecret: string): Promise<{ tssId: string; adminPin: string }> {
    const tssId = randomUUID();
    const bootstrapConfig: TseFiskalyConfig = { apiKey, apiSecret, tssId };

    const created = await this.request<FiskalyTss>(bootstrapConfig, 'PUT', `/tss/${tssId}`, {});
    const adminPuk = created.admin_puk;
    if (!adminPuk) {
      throw new Error('fiskaly createTss response did not include admin_puk');
    }

    await this.request(bootstrapConfig, 'PATCH', `/tss/${tssId}`, { state: 'UNINITIALIZED' });

    // fiskaly rejects admin/PIN operations issued too soon after the
    // UNINITIALIZED transition -- confirmed empirically against the TEST
    // environment, not just documentation. 35s is a small margin over the
    // documented 30s minimum.
    await sleep(35_000);

    const adminPin = randomAdminPin();
    await this.request(bootstrapConfig, 'PATCH', `/tss/${tssId}/admin`, {
      admin_puk: adminPuk,
      new_admin_pin: adminPin,
    });
    await this.request(bootstrapConfig, 'POST', `/tss/${tssId}/admin/auth`, { admin_pin: adminPin });
    await this.request(bootstrapConfig, 'PATCH', `/tss/${tssId}`, {
      state: 'INITIALIZED',
      description: 'openEOS main register',
    });

    return { tssId, adminPin };
  }

  async ensureClient(config: TseFiskalyConfig, clientId: string): Promise<void> {
    // PUT is idempotent on fiskaly's client resource — safe to call every time.
    try {
      await this.request(config, 'PUT', `/tss/${config.tssId}/client/${clientId}`, {
        serial_number: clientId,
      });
    } catch (error) {
      // fiskaly's createClient requires an admin-authenticated session.
      // That session appears to persist well beyond the single request that
      // established it (confirmed empirically: a client registered in a
      // completely separate later call, with a fresh access token, still
      // succeeded) -- so the common path above needs no admin/auth at all,
      // and this is a fallback for whenever that assumption doesn't hold
      // (e.g. a new till registering long after the org-wide client did).
      // Never a substitute for createTss's own bootstrap: without a stored
      // adminPin (only set by createTss), there's nothing to retry with.
      if (!config.adminPin) throw error;
      this.logger.warn(
        `fiskaly client registration failed, retrying once with admin re-auth: ${(error as Error).message}`,
      );
      await this.request(config, 'POST', `/tss/${config.tssId}/admin/auth`, { admin_pin: config.adminPin });
      await this.request(config, 'PUT', `/tss/${config.tssId}/client/${clientId}`, {
        serial_number: clientId,
      });
    }
  }

  async recordTransaction(
    config: TseFiskalyConfig,
    input: TseTransactionInput,
  ): Promise<TseTransactionResult> {
    const txId = randomUUID();

    await this.request<FiskalyTx>(config, 'PUT', `/tss/${config.tssId}/tx/${txId}?tx_revision=1`, {
      state: 'ACTIVE',
      client_id: input.clientId,
    });

    const finished = await this.request<FiskalyTx>(
      config,
      'PUT',
      `/tss/${config.tssId}/tx/${txId}?tx_revision=2&last_revision=1`,
      {
        state: 'FINISHED',
        client_id: input.clientId,
        schema: {
          standard_v1: {
            receipt: {
              receipt_type: 'RECEIPT',
              amounts_per_vat_rate: [{ vat_rate: 'NORMAL', amount: input.amount.toFixed(2) }],
              amounts_per_payment_type: [
                { payment_type: mapPaymentType(input.paymentMethod), amount: input.amount.toFixed(2) },
              ],
            },
          },
        },
      },
    );

    const tss = await this.request<FiskalyTss>(config, 'GET', `/tss/${config.tssId}`);

    const signature = finished.signature;
    if (!signature) {
      throw new Error('fiskaly response missing signature — transaction did not finish cleanly');
    }

    return {
      provider: 'fiskaly',
      clientId: input.clientId,
      transactionNumber: finished.number,
      serialNumber: tss.serial_number,
      signatureCounter: signature.counter,
      signatureValue: signature.value,
      signatureAlgorithm: signature.algorithm,
      startTime: finished.time_start,
      endTime: finished.time_end ?? new Date().toISOString(),
      processType: 'Kassenbeleg-V1',
      processData: JSON.stringify({ amount: input.amount, currency: input.currency }),
      qrCodeData:
        finished.qr_code_data ??
        buildQrCodePayload({
          clientId: input.clientId,
          transactionNumber: finished.number,
          startTime: finished.time_start,
          endTime: finished.time_end ?? new Date().toISOString(),
          serialNumber: tss.serial_number,
          signature,
        }),
    };
  }

  async testConnection(config: TseFiskalyConfig): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.request(config, 'GET', `/tss/${config.tssId}`);
      return { ok: true };
    } catch (error) {
      this.logger.warn(`fiskaly test-connection failed: ${(error as Error).message}`);
      return { ok: false, message: (error as Error).message };
    }
  }

  /**
   * TR-03153 TAR export of the TSS's entire signed log.
   *
   * The create/poll shape (PUT .../export/{export_id}, states PENDING/
   * WORKING/COMPLETED/CANCELLED) was corrected in an earlier pass -- the
   * download path was NOT, and stayed wrong through that entire pass too:
   * fiskaly's own published docs (checked twice, independently) say the
   * download operation is GET .../export/{export_id}/tar, but that 404s
   * even against a genuinely COMPLETED export on a live TSS -- confirmed by
   * direct testing, not by re-reading the docs a third time. The endpoint
   * that actually works, found by testing plausible alternatives against
   * the same live export, is GET .../export/{export_id}/file. Content-
   * negotiating via an Accept header on the status URL instead (also
   * tested) returns 200 but with the JSON status body, not the archive --
   * a false positive if only the status code were checked.
   *
   * Important: fiskaly's export is scoped to the whole TSS, not to a single
   * client/till and not to a date range -- it can only be narrowed by
   * signature-counter range, which this doesn't attempt to map dates to.
   * `input.clientId`/`periodStart`/`periodEnd` are used only for the
   * downloaded filename (see TseService.exportData), not as an actual
   * filter -- every export contains every client's transactions on this
   * TSS. There's no fiskaly-side way to hand a specific weekend renter only
   * their own slice of the log.
   */
  async exportData(config: TseFiskalyConfig, input: TseExportInput): Promise<TseExportResult> {
    const exportId = randomUUID();
    await this.request(config, 'PUT', `/tss/${config.tssId}/export/${exportId}`, {});

    const deadline = Date.now() + 2 * 60 * 1000; // exports can take a while on large logs
    let state = 'PENDING';
    while (state !== 'COMPLETED' && Date.now() < deadline) {
      const status = await this.request<{ state: string }>(
        config,
        'GET',
        `/tss/${config.tssId}/export/${exportId}`,
      );
      state = status.state;
      if (state === 'CANCELLED') {
        throw new Error(`fiskaly export ${exportId} was cancelled`);
      }
      if (state !== 'COMPLETED') {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    if (state !== 'COMPLETED') {
      throw new Error(`fiskaly export ${exportId} timed out (state: ${state})`);
    }

    const token = await this.getAccessToken(config);
    const res = await fetch(`${this.apiBase}/tss/${config.tssId}/export/${exportId}/file`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`fiskaly export download failed: ${res.status} ${await res.text()}`);
    }
    const data = Buffer.from(await res.arrayBuffer());

    return {
      data,
      // Not "tse-export-{clientId}-..." -- the file contains every client's
      // transactions on this TSS, not just input.clientId's (see this
      // method's doc comment). Naming it as if it were scoped would mislead
      // whoever receives it into thinking it's their own slice of the log.
      filename: `tse-export-full-${input.periodStart.toISOString().slice(0, 10)}.tar`,
    };
  }
}

function mapPaymentType(method: string): 'CASH' | 'NON_CASH' {
  return method === 'cash' ? 'CASH' : 'NON_CASH';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** fiskaly admin PINs: 6 chars, uppercase letters + digits (matches their own examples, e.g. "AB1234"). */
function randomAdminPin(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  let pin = '';
  for (let i = 0; i < 6; i++) {
    pin += chars[Math.floor(Math.random() * chars.length)];
  }
  return pin;
}

/**
 * DSFinV-K TSE-QR-code payload (fallback if the provider doesn't hand back a
 * pre-built one): V0;client;tx-number;start;end;serial;sig-value;sig-counter;
 * sig-algorithm;process-type — semicolon-delimited per the technical guideline.
 */
function buildQrCodePayload(data: {
  clientId: string;
  transactionNumber: number;
  startTime: string;
  endTime: string;
  serialNumber: string;
  signature: FiskalySignature;
}): string {
  return [
    'V0',
    data.clientId,
    data.transactionNumber,
    data.startTime,
    data.endTime,
    data.serialNumber,
    data.signature.value,
    data.signature.counter,
    data.signature.algorithm,
    'Kassenbeleg-V1',
  ].join(';');
}
