import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Organization, OrganizationSettings } from '../../database/entities/organization.entity';
import { Device } from '../../database/entities/device.entity';
import { UserOrganization } from '../../database/entities/user-organization.entity';
import { TseTransactionData } from '../../database/entities/payment.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { FiskalyTseProvider } from './providers/fiskaly-tse.provider';
import { LocalTseProvider } from './providers/local-tse.provider';
import { TseExportResult, TseFiskalyConfig, TseLocalConfig, TseProvider } from './tse.interface';

type TseConfig = NonNullable<OrganizationSettings['tse']>;

@Injectable()
export class TseService {
  private readonly logger = new Logger(TseService.name);

  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    private readonly fiskalyProvider: FiskalyTseProvider,
    private readonly localProvider: LocalTseProvider,
  ) {}

  /**
   * Resolve the provider + its config for one org's TSE setting. Returns
   * null when TSE is off or the selected provider's credentials aren't set
   * yet (e.g. provider picked but fiskaly/local block not filled in).
   */
  private resolveProvider(
    tseConfig: TseConfig | undefined,
    organizationId: string,
  ): { provider: TseProvider<TseFiskalyConfig | TseLocalConfig>; config: TseFiskalyConfig | TseLocalConfig } | null {
    if (!tseConfig?.enabled) return null;
    if (tseConfig.provider === 'fiskaly' && tseConfig.fiskaly) {
      return { provider: this.fiskalyProvider, config: tseConfig.fiskaly };
    }
    if (tseConfig.provider === 'local' && tseConfig.local) {
      return { provider: this.localProvider, config: { ...tseConfig.local, organizationId } };
    }
    return null;
  }

  /**
   * Sign one captured payment through the organization's TSE, if configured.
   * Returns null when TSE is disabled/unconfigured (nothing to store). Never
   * throws — a TSE outage must not block the sale (BMF's Ausfall-Regelung);
   * failures come back as `tseData.failed: true` so the receipt/report can
   * show the gap.
   */
  async recordTransaction(
    organizationId: string,
    deviceId: string | null,
    input: { amount: number; paymentMethod: string },
  ): Promise<TseTransactionData | null> {
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: ['id', 'settings'],
    });
    const resolved = this.resolveProvider(organization?.settings?.tse, organizationId);
    if (!resolved) return null;
    const { provider, config } = resolved;

    const clientId = await this.resolveClientId(organizationId, deviceId);

    try {
      await provider.ensureClient(config, clientId);
      const result = await provider.recordTransaction(config, {
        organizationId,
        clientId,
        amount: input.amount,
        currency: organization?.settings?.currency ?? 'EUR',
        paymentMethod: input.paymentMethod,
      });
      return { ...result, failed: false };
    } catch (error) {
      this.logger.error(
        `TSE transaction failed for org ${organizationId} (client ${clientId}): ${(error as Error).message}`,
      );
      const now = new Date().toISOString();
      return {
        provider: provider.name,
        clientId,
        transactionNumber: 0,
        serialNumber: '',
        signatureCounter: 0,
        signatureValue: '',
        signatureAlgorithm: '',
        startTime: now,
        endTime: now,
        processType: 'Kassenbeleg-V1',
        processData: '',
        qrCodeData: '',
        failed: true,
        failureReason: (error as Error).message,
      };
    }
  }

  async testConnection(organizationId: string, userId: string): Promise<{ ok: boolean; message?: string }> {
    await this.checkMembership(organizationId, userId);
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: ['id', 'settings'],
    });
    const resolved = this.resolveProvider(organization?.settings?.tse, organizationId);
    if (!resolved) {
      return { ok: false, message: 'TSE ist für diese Organisation nicht konfiguriert' };
    }
    return resolved.provider.testConnection(resolved.config);
  }

  /**
   * Export one client's signed transaction log for a date range — the
   * handover artifact for the weekend-rental tenant separation model (see
   * the local-agent architecture sketch). Throws when TSE isn't configured
   * or the provider can't export (surfaced to the caller as a 4xx/5xx).
   *
   * `clientId` defaults to the org-wide client (online-shop orders); pass a
   * specific till's client id (see `listClientIds`) to export that till's
   * own transactions instead. Each org has as many clients on the shared
   * stick as it has tills that signed at least one transaction — a full
   * handover export means calling this once per id from `listClientIds`.
   */
  async exportData(
    organizationId: string,
    userId: string,
    periodStart: Date,
    periodEnd: Date,
    clientId?: string,
  ): Promise<TseExportResult> {
    await this.checkMembership(organizationId, userId);
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: ['id', 'settings'],
    });
    const resolved = this.resolveProvider(organization?.settings?.tse, organizationId);
    if (!resolved || !resolved.provider.exportData) {
      throw new Error('TSE-Export ist für diese Organisation nicht verfügbar');
    }
    if (clientId) {
      const knownIds = await this.listClientIds(organizationId, userId);
      if (!knownIds.includes(clientId)) {
        throw new ForbiddenException({
          code: ErrorCodes.FORBIDDEN,
          message: 'Client-ID gehört nicht zu dieser Organisation',
        });
      }
    }
    return resolved.provider.exportData(resolved.config, {
      organizationId,
      clientId: clientId ?? organizationId,
      periodStart,
      periodEnd,
    });
  }

  /**
   * Every TSE client id this org has signed under: the org-wide client
   * (online orders) plus one per till that has processed a payment. Lets an
   * admin pull a complete handover export across every client, not just the
   * org-wide one.
   */
  async listClientIds(organizationId: string, userId: string): Promise<string[]> {
    await this.checkMembership(organizationId, userId);
    const devices = await this.deviceRepository.find({
      where: { organizationId },
      select: ['id', 'settings'],
    });
    const clientIds = devices
      .map((d) => d.settings?.tseClientId)
      .filter((id): id is string => !!id);
    return [organizationId, ...new Set(clientIds)];
  }

  /**
   * Each till is its own TSE client. Online-shop orders have no device, so
   * they share a single per-organization client instead. fiskaly client IDs
   * must be UUIDs, so both branches reuse an existing UUID rather than
   * building a prefixed string.
   */
  private async resolveClientId(organizationId: string, deviceId: string | null): Promise<string> {
    if (!deviceId) {
      return organizationId;
    }

    const device = await this.deviceRepository.findOne({
      where: { id: deviceId },
      select: ['id', 'settings'],
    });
    if (device?.settings?.tseClientId) {
      return device.settings.tseClientId;
    }

    const clientId = deviceId;
    if (device) {
      device.settings = { ...device.settings, tseClientId: clientId };
      await this.deviceRepository.save(device);
    }
    return clientId;
  }

  private async checkMembership(organizationId: string, userId: string): Promise<void> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Kein Zugriff auf diese Organisation',
      });
    }
  }
}
