import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Organization, OrganizationSettings } from '../../database/entities/organization.entity';
import { Device } from '../../database/entities/device.entity';
import { UserOrganization } from '../../database/entities/user-organization.entity';
import { TseTransactionData } from '../../database/entities/payment.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { parseFiskalyFailure, mapTseErrorCode } from './fiskaly-errors';
import { FiskalyTseProvider } from './providers/fiskaly-tse.provider';
import { LocalTseProvider } from './providers/local-tse.provider';
import { TseExportResult, TseFiskalyConfig, TseLocalConfig, TseProvider, TseVatSplit } from './tse.interface';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';

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
    private readonly configService: ConfigService,
    private readonly platformSettingsService: PlatformSettingsService,
  ) {}

  /**
   * The platform's fiskaly reseller credential -- superadmin-settable via
   * the admin UI (PlatformSettingsService, encrypted at rest) takes
   * priority; falls back to FISKALY_PLATFORM_API_KEY/SECRET so a
   * deployment can still configure this via docker-compose without ever
   * touching the admin UI, e.g. for infra-as-code setups.
   */
  private async getPlatformFiskalyCredential(): Promise<{ apiKey: string; apiSecret: string } | null> {
    const stored = await this.platformSettingsService.getFiskalyPlatformCredential();
    if (stored) return stored;

    const apiKey = this.configService.get<string>('fiskaly.platformApiKey', '');
    const apiSecret = this.configService.get<string>('fiskaly.platformApiSecret', '');
    return apiKey && apiSecret ? { apiKey, apiSecret } : null;
  }

  /**
   * Resolve the provider + its config for one org's TSE setting. Returns
   * null when TSE is off or the selected provider's credentials aren't set
   * yet (e.g. provider picked but fiskaly/local block not filled in).
   *
   * Reseller orgs (activatePlatformTse) never have the platform's real
   * apiKey/apiSecret persisted on their own settings row at all -- see
   * provisionTss's own comment -- so for those, substitute the platform
   * credential back in here at call time instead of trusting the
   * (deliberately blank) persisted fields.
   */
  private async resolveProvider(
    tseConfig: TseConfig | undefined,
    organizationId: string,
  ): Promise<{ provider: TseProvider<TseFiskalyConfig | TseLocalConfig>; config: TseFiskalyConfig | TseLocalConfig } | null> {
    if (!tseConfig?.enabled) return null;
    if (tseConfig.provider === 'fiskaly' && tseConfig.fiskaly) {
      if (tseConfig.reseller) {
        const platformCredential = await this.getPlatformFiskalyCredential();
        if (!platformCredential) return null;
        return {
          provider: this.fiskalyProvider,
          config: { ...tseConfig.fiskaly, ...platformCredential },
        };
      }
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
    input: { amount: number; paymentMethod: string; vatSplits: TseVatSplit[] },
  ): Promise<TseTransactionData | null> {
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: ['id', 'settings'],
    });
    const resolved = await this.resolveProvider(organization?.settings?.tse, organizationId);
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
        vatSplits: input.vatSplits,
      });
      return { ...result, vatSplits: input.vatSplits, failed: false };
    } catch (error) {
      const parsed = parseFiskalyFailure(error);
      const errorCode = mapTseErrorCode(parsed.fiskalyCode, parsed.httpStatus);
      const now = new Date().toISOString();
      this.logger.error(
        `TSE transaction failed for org ${organizationId} (client ${clientId}, tssId ${(config as { tssId?: string }).tssId ?? 'n/a'}, errorCode ${errorCode}, httpStatus ${parsed.httpStatus ?? 'n/a'}): ${parsed.failureReason}`,
        (error as Error).stack,
      );
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
        failureReason: parsed.failureReason,
        errorCode,
        httpStatus: parsed.httpStatus,
        failedAt: now,
        vatSplits: input.vatSplits,
      };
    }
  }

  /**
   * Signs a reversal for a captured payment being refunded/cancelled --
   * never a status flip on the original. Once a TSE is in use, a receipt it
   * already signed can't be "unsigned"; the only compliant path is a second,
   * separately-signed transaction with inverted amounts, referencing the
   * original (DSFinV-K's `references.csv`; Anhang B on `AVBelegstorno`
   * explains why the naive in-place approach stops being valid the moment a
   * TSE is protecting the till). Confirmed empirically against a live
   * fiskaly TSS: a negative amount on the standard receipt type signs
   * cleanly (HTTP 200, `process_data` decodes to the expected
   * `Beleg^-10.00_..._0.00^-10.00:...` shape) -- no separate "reversal"
   * receipt type exists or is needed at the TSE layer; the sign flip alone
   * carries the meaning.
   */
  async reverseTransaction(
    organizationId: string,
    deviceId: string | null,
    input: { amount: number; paymentMethod: string; vatSplits: TseVatSplit[] },
  ): Promise<TseTransactionData | null> {
    return this.recordTransaction(organizationId, deviceId, {
      ...input,
      amount: -Math.abs(input.amount),
    });
  }

  async testConnection(organizationId: string, userId: string): Promise<{ ok: boolean; message?: string }> {
    await this.checkMembership(organizationId, userId);
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: ['id', 'settings'],
    });
    const resolved = await this.resolveProvider(organization?.settings?.tse, organizationId);
    if (!resolved) {
      return { ok: false, message: 'TSE ist für diese Organisation nicht konfiguriert' };
    }
    return resolved.provider.testConnection(resolved.config);
  }

  /**
   * Eagerly register the org's default TSE client (see resolveClientId's
   * organizationId fallback for deviceId === null) right when settings are
   * saved, instead of waiting for the first real payment.
   *
   * Why this exists: fiskaly only allows registering a new client while a
   * TSS is `UNINITIALIZED`/`INITIALIZED` -- a sandbox TSS observed
   * transitioning to `CREATED` (locked, no new clients ever) within minutes
   * of creation, well before any sale happened. The old lazy-only path
   * (ensureClient inside recordTransaction, on the first payment) lost that
   * race every time in practice.
   *
   * This does NOT replace that lazy call -- per-device clients (a specific
   * till's own clientId, not the org-wide fallback) still only get
   * registered on their own first transaction, and always will: a save
   * here can't pre-register a till that doesn't exist yet. Treat this as
   * closing the most common race (initial setup, before any device has
   * signed anything), not a guarantee every future client registers cleanly.
   *
   * Deliberately not folded into testConnection: that one is a read-only
   * health check (GET only) and callers reasonably expect "test" to be
   * side-effect-free. Registration is a real mutation (fiskaly's client
   * resource), so it belongs behind an explicit, separately-named action --
   * callers triggered by a "Save" click already expect persistence-adjacent
   * side effects; "Test connection" should not silently register anything.
   */
  async registerClient(organizationId: string, userId: string): Promise<{ ok: boolean; message?: string }> {
    await this.checkMembership(organizationId, userId);
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: ['id', 'settings'],
    });
    const resolved = await this.resolveProvider(organization?.settings?.tse, organizationId);
    if (!resolved) {
      return { ok: false, message: 'TSE ist für diese Organisation nicht konfiguriert' };
    }
    try {
      await resolved.provider.ensureClient(resolved.config, organizationId);
      return { ok: true };
    } catch (error) {
      this.logger.warn(`fiskaly client registration failed for org ${organizationId}: ${(error as Error).message}`);
      return { ok: false, message: (error as Error).message };
    }
  }

  /**
   * Provisions a brand-new fiskaly TSS end-to-end from just an API
   * key/secret and persists the result (tssId + adminPin) onto the org's
   * TSE settings, overwriting whatever fiskaly config was there before.
   *
   * Why this exists at all: a TSS pasted in from anywhere else (fiskaly's
   * own dashboard, a manual API call) starts in state CREATED and cannot
   * sign or register clients until it's walked through UNINITIALIZED to
   * INITIALIZED -- a multi-step, ~35s+ admin-authenticated sequence with no
   * UI in fiskaly's dashboard for it (confirmed against their docs and
   * live sandbox testing). Every TSS this app knows about now goes through
   * this method, so that gap can't recur -- there's no "just paste a
   * tssId" path anymore.
   *
   * This call blocks for the ~35s fiskaly requires between the
   * UNINITIALIZED transition and the admin/PIN steps -- expected to run
   * from a "Create TSS" admin action, not a hot path.
   */
  async createTss(
    organizationId: string,
    userId: string,
    input: { apiKey: string; apiSecret: string },
  ): Promise<{ ok: boolean; tssId?: string; message?: string }> {
    await this.checkMembership(organizationId, userId);
    return this.provisionTss(organizationId, input.apiKey, input.apiSecret, {});
  }

  /**
   * Self-service activation for the reseller/Endkunden model: provisions a
   * dedicated TSS under the PLATFORM's own fiskaly account (see fiskaly's
   * SIGN DE service description on sublicensing to Endkunden), not the
   * org's own credentials -- an org never needs a fiskaly account of its
   * own. Gapless per-org isolation is preserved: each org still gets its
   * own TSS, just provisioned under one shared platform KUNDE credential
   * instead of one credential per org.
   *
   * `acknowledgedBetreiber` is mandatory, not decorative: per that same
   * service description, the ENDKUNDE (this org) -- not the platform --
   * bears full statutory responsibility for KassenSichV compliance. An
   * admin clicking "activate" is the only place that gets communicated;
   * refusing to proceed without it is deliberate, not a formality.
   */
  async activatePlatformTse(
    organizationId: string,
    userId: string,
    acknowledgedBetreiber: boolean,
  ): Promise<{ ok: boolean; tssId?: string; message?: string }> {
    await this.checkMembership(organizationId, userId);

    if (!acknowledgedBetreiber) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Bestätigung der Betreiberverantwortung (KassenSichV) erforderlich',
      });
    }

const platformCredential = await this.getPlatformFiskalyCredential();
    if (!platformCredential) {
      return { ok: false, message: 'TSE-Reseller-Modus ist auf dieser Instanz nicht konfiguriert' };
    }

    return this.provisionTss(organizationId, platformCredential.apiKey, platformCredential.apiSecret, {
      reseller: true,
      activatedAt: new Date().toISOString(),
    });
  }

  /**
   * Shared TSS-provisioning core for both createTss (bring-your-own
   * fiskaly account) and activatePlatformTse (platform reseller account)
   * -- same fiskaly bootstrap sequence either way, only the credential
   * source and the persisted settings extras differ.
   */
  private async provisionTss(
    organizationId: string,
    apiKey: string,
    apiSecret: string,
    settingsExtras: Partial<Pick<NonNullable<TseConfig>, 'reseller' | 'activatedAt'>>,
  ): Promise<{ ok: boolean; tssId?: string; message?: string }> {
    let tssId: string;
    let adminPin: string;
    try {
      ({ tssId, adminPin } = await this.fiskalyProvider.createTss(apiKey, apiSecret));
    } catch (error) {
      this.logger.error(`TSS creation failed for org ${organizationId}: ${(error as Error).message}`);
      return { ok: false, message: (error as Error).message };
    }

    const organization = await this.organizationRepository.findOne({ where: { id: organizationId } });
    if (!organization) {
      return { ok: false, message: 'Organisation nicht gefunden' };
    }
    // Reseller activations must NEVER persist the platform's real
    // apiKey/apiSecret on the org's own settings row -- that row is
    // returned verbatim to the org's own frontend (organizations.service.ts
    // has no masking for tse.fiskaly, unlike sumup), so storing the
    // platform's master credential there would hand every reseller-activated
    // org the ability to act as the platform's fiskaly account entirely.
    // resolveProvider() substitutes the real platform credential back in
    // at call time instead. Bring-your-own orgs are unaffected: it's their
    // own credential, already visible to their own admin either way.
    const persistedApiKey = settingsExtras.reseller ? '' : apiKey;
    const persistedApiSecret = settingsExtras.reseller ? '' : apiSecret;
    organization.settings = {
      ...organization.settings,
      tse: {
        enabled: true,
        provider: 'fiskaly',
        fiskaly: { apiKey: persistedApiKey, apiSecret: persistedApiSecret, tssId, adminPin },
        ...settingsExtras,
      },
    };
    await this.organizationRepository.save(organization);

    try {
      await this.fiskalyProvider.ensureClient({ apiKey, apiSecret, tssId, adminPin }, organizationId);
    } catch (error) {
      // The TSS itself is fully provisioned and saved at this point -- only
      // the org-wide default client's eager registration failed. Same
      // fallback as everywhere else: the lazy per-payment ensureClient call
      // still covers it, so this isn't fatal to the overall operation.
      this.logger.warn(`Default client registration failed for org ${organizationId}: ${(error as Error).message}`);
      return { ok: true, tssId, message: `TSS erstellt, aber Client-Registrierung fehlgeschlagen: ${(error as Error).message}` };
    }

    this.logger.log(`TSS created and initialized for org ${organizationId}: ${tssId}`);
    return { ok: true, tssId };
  }

  /** Whether this deployment offers self-service platform-reseller TSE activation. */
  async isResellerModeAvailable(): Promise<boolean> {
    return !!(await this.getPlatformFiskalyCredential());
  }

  /**
   * Export signed transaction log for a date range — the handover artifact
   * for the weekend-rental tenant separation model. Throws when TSE isn't
   * configured or the provider can't export (surfaced to the caller as a
   * 4xx/5xx).
   *
   * Per-client scoping only actually holds for the local provider (its own
   * agent genuinely filters by clientId/date range). fiskaly's real export
   * API has no per-client or date-range filter at all -- it always returns
   * the whole TSS's log (see FiskalyTseProvider.exportData's own doc
   * comment for how this was confirmed). `clientId` is still validated
   * against this org's known client ids below (a real access-control
   * check), but on fiskaly it does not narrow what comes back.
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
    const resolved = await this.resolveProvider(organization?.settings?.tse, organizationId);
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
    return this.getClientIds(organizationId);
  }

  private async getClientIds(organizationId: string): Promise<string[]> {
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
   * Platform-wide reconciliation view: every org with TSE enabled, its
   * provider/activation source, and live client count -- the numbers to
   * check against the platform's own fiskaly invoice. Caller (AdminController)
   * is already SuperAdminGuard-gated, so no per-org membership check here.
   */
  async listActiveClientsForAdmin(): Promise<
    {
      organizationId: string;
      organizationName: string;
      provider: 'fiskaly' | 'local' | 'none';
      reseller: boolean;
      activatedAt: string | null;
      clientCount: number;
    }[]
  > {
    const organizations = await this.organizationRepository.find({
      select: ['id', 'name', 'settings'],
    });
    const enabled = organizations.filter((org) => org.settings?.tse?.enabled);
    return Promise.all(
      enabled.map(async (org) => {
        const clientIds = await this.getClientIds(org.id);
        return {
          organizationId: org.id,
          organizationName: org.name,
          provider: org.settings.tse!.provider,
          reseller: !!org.settings.tse!.reseller,
          activatedAt: org.settings.tse!.activatedAt ?? null,
          clientCount: clientIds.length,
        };
      }),
    );
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
