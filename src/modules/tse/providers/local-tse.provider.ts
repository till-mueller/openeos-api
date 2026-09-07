import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { GatewayService } from '../../gateway/gateway.service';
import { GatewayEvents } from '../../gateway/dto';
import type {
  TseSignTransactionEvent,
  TseSignTransactionResponse,
  TseTestConnectionEvent,
  TseTestConnectionResponse,
  TseExportDataEvent,
  TseExportDataResponse,
} from '../../gateway/dto';
import {
  TseLocalConfig,
  TseProvider,
  TseTransactionInput,
  TseTransactionResult,
  TseExportInput,
  TseExportResult,
} from '../tse.interface';

/**
 * Local/offline hardware TSE (e.g. Swissbit USB/SD), reached through an
 * on-prem printer-agent over the gateway WebSocket instead of a cloud API —
 * see the local-agent architecture sketch. Works fully airgapped as long as
 * the agent and the till sending the payment share a LAN; only the API
 * server itself needs no live connection to the TSE, since signing happens
 * on the agent's side.
 *
 * `ensureClient` is a no-op: registering the client on the physical stick
 * happens inline as part of the sign-transaction job on the agent, to avoid
 * a second network round trip for every payment.
 */
@Injectable()
export class LocalTseProvider implements TseProvider<TseLocalConfig> {
  readonly name = 'local' as const;
  private readonly logger = new Logger(LocalTseProvider.name);

  constructor(private readonly gatewayService: GatewayService) {}

  async ensureClient(): Promise<void> {}

  async recordTransaction(
    config: TseLocalConfig,
    input: TseTransactionInput,
  ): Promise<TseTransactionResult> {
    const event: TseSignTransactionEvent = {
      requestId: randomUUID(),
      clientId: input.clientId,
      amount: input.amount,
      currency: input.currency,
      paymentMethod: input.paymentMethod,
    };

    const response = await this.gatewayService.sendTseJobToAgent<TseSignTransactionResponse>(
      input.organizationId,
      config.agentDeviceId,
      GatewayEvents.TSE_SIGN_TRANSACTION,
      event,
      15000,
    );

    if (!response || !response.ok) {
      const message = response?.error ?? `TSE agent ${config.agentDeviceId} offline or did not respond in time`;
      this.logger.warn(`recordTransaction failed for client ${input.clientId}: ${message}`);
      throw new Error(message);
    }

    return {
      provider: 'local',
      clientId: input.clientId,
      transactionNumber: response.transactionNumber ?? 0,
      serialNumber: response.serialNumber ?? '',
      signatureCounter: response.signatureCounter ?? 0,
      signatureValue: response.signatureValue ?? '',
      signatureAlgorithm: response.signatureAlgorithm ?? '',
      startTime: response.startTime ?? new Date().toISOString(),
      endTime: response.endTime ?? new Date().toISOString(),
      processType: 'Kassenbeleg-V1',
      processData: JSON.stringify({ amount: input.amount, currency: input.currency }),
      qrCodeData: response.qrCodeData ?? '',
    };
  }

  async testConnection(config: TseLocalConfig): Promise<{ ok: boolean; message?: string }> {
    const event: TseTestConnectionEvent = { requestId: randomUUID() };
    const response = await this.gatewayService.sendTseJobToAgent<TseTestConnectionResponse>(
      config.organizationId,
      config.agentDeviceId,
      GatewayEvents.TSE_TEST_CONNECTION,
      event,
      10000,
    );
    if (!response) {
      return { ok: false, message: 'TSE-Agent nicht erreichbar (offline oder keine Antwort)' };
    }
    return { ok: response.ok, message: response.message ?? response.serialNumber };
  }

  async exportData(config: TseLocalConfig, input: TseExportInput): Promise<TseExportResult> {
    const event: TseExportDataEvent = {
      requestId: randomUUID(),
      clientId: input.clientId,
      periodStart: input.periodStart.toISOString(),
      periodEnd: input.periodEnd.toISOString(),
    };

    const response = await this.gatewayService.sendTseJobToAgent<TseExportDataResponse>(
      input.organizationId,
      config.agentDeviceId,
      GatewayEvents.TSE_EXPORT_DATA,
      event,
      120000, // exports can take a while for a full weekend's transactions
    );

    if (!response?.ok || !response.dataBase64) {
      throw new Error(response?.message ?? `TSE export failed — agent ${config.agentDeviceId} offline or errored`);
    }

    return {
      data: Buffer.from(response.dataBase64, 'base64'),
      filename: response.filename ?? `tse-export-${input.clientId}.tar`,
    };
  }
}
