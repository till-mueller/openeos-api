import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { PlatformSetting } from '../../database/entities';
import { EncryptionService } from '../../common/services/encryption.service';

const ADMIN_NOTIFICATIONS_KEY = 'adminNotifications';
const FISKALY_PLATFORM_CREDENTIAL_KEY = 'fiskalyPlatformCredential';

export interface AdminNotifyOnSettings {
  userRegistered: boolean;
  organizationCreated: boolean;
  eventOrdered: boolean;
  supportMessage: boolean;
  contactRequest: boolean;
}

export interface AdminNotificationSettings {
  email: string | null;
  notifyOn: AdminNotifyOnSettings;
}

const DEFAULT_NOTIFICATION_SETTINGS: AdminNotificationSettings = {
  email: null,
  notifyOn: {
    userRegistered: true,
    organizationCreated: true,
    eventOrdered: true,
    supportMessage: true,
    contactRequest: true,
  },
};

/**
 * Generic key/value store for platform-wide (super-admin) settings.
 * Currently backs the configurable admin-notification preferences.
 */
@Injectable()
export class PlatformSettingsService {
  private readonly logger = new Logger(PlatformSettingsService.name);

  constructor(
    @InjectRepository(PlatformSetting)
    private readonly platformSettingRepository: Repository<PlatformSetting>,
    private readonly configService: ConfigService,
    private readonly encryptionService: EncryptionService,
  ) {}

  async getNotificationSettings(): Promise<AdminNotificationSettings> {
    const row = await this.platformSettingRepository.findOne({
      where: { key: ADMIN_NOTIFICATIONS_KEY },
    });
    const value = (row?.value ?? {}) as Partial<AdminNotificationSettings>;

    return {
      email: value.email ?? DEFAULT_NOTIFICATION_SETTINGS.email,
      notifyOn: { ...DEFAULT_NOTIFICATION_SETTINGS.notifyOn, ...value.notifyOn },
    };
  }

  async updateNotificationSettings(partial: {
    email?: string | null;
    notifyOn?: Partial<AdminNotifyOnSettings>;
  }): Promise<AdminNotificationSettings> {
    const current = await this.getNotificationSettings();

    const next: AdminNotificationSettings = {
      email: partial.email !== undefined ? partial.email : current.email,
      notifyOn: { ...current.notifyOn, ...partial.notifyOn },
    };

    const row = this.platformSettingRepository.create({
      key: ADMIN_NOTIFICATIONS_KEY,
      value: next as unknown as Record<string, unknown>,
    });
    await this.platformSettingRepository.save(row);

    this.logger.log('Admin notification settings updated');

    return next;
  }

  /**
   * Resolves the effective notification address for a given event type and
   * checks its toggle. Returns `null` if the send should be skipped (toggle
   * off, or no address configured anywhere).
   *
   * Resolution order: configured settings email → ADMIN_NOTIFY_EMAIL →
   * ADMIN_EMAIL (both already folded into `email.adminNotifyEmail`).
   */
  async resolveNotificationTarget(type: keyof AdminNotifyOnSettings): Promise<string | null> {
    const settings = await this.getNotificationSettings();
    if (!settings.notifyOn[type]) {
      return null;
    }

    const fallbackEmail = this.configService.get<string>('email.adminNotifyEmail');
    const email = settings.email || fallbackEmail || null;

    return email || null;
  }

  /**
   * The platform's fiskaly reseller credential (TSE-as-a-service, see
   * fiskaly's SIGN DE service description on sublicensing to Endkunden).
   * Encrypted at rest with EncryptionService -- everything else in this
   * KV store is plaintext jsonb, which is fine for notification prefs but
   * not for a credential that can create/sign under the platform's own
   * fiskaly account. Superadmin-settable via the admin UI, alternative to
   * (and takes priority over) the FISKALY_PLATFORM_API_KEY/SECRET env vars,
   * so a deployment never has to touch docker-compose to turn this on.
   */
  async setFiskalyPlatformCredential(apiKey: string, apiSecret: string): Promise<void> {
    const row = this.platformSettingRepository.create({
      key: FISKALY_PLATFORM_CREDENTIAL_KEY,
      value: {
        apiKeyEncrypted: this.encryptionService.encrypt(apiKey),
        apiSecretEncrypted: this.encryptionService.encrypt(apiSecret),
        apiKeyLast4: apiKey.slice(-4),
      },
    });
    await this.platformSettingRepository.save(row);
    this.logger.log('Platform fiskaly reseller credential updated');
  }

  async clearFiskalyPlatformCredential(): Promise<void> {
    await this.platformSettingRepository.delete({ key: FISKALY_PLATFORM_CREDENTIAL_KEY });
    this.logger.log('Platform fiskaly reseller credential cleared');
  }

  /** Decrypted credential for actual use (TseService) -- never returned over HTTP. */
  async getFiskalyPlatformCredential(): Promise<{ apiKey: string; apiSecret: string } | null> {
    const row = await this.platformSettingRepository.findOne({ where: { key: FISKALY_PLATFORM_CREDENTIAL_KEY } });
    const value = row?.value as { apiKeyEncrypted?: string; apiSecretEncrypted?: string } | undefined;
    if (!value?.apiKeyEncrypted || !value?.apiSecretEncrypted) {
      return null;
    }
    return {
      apiKey: this.encryptionService.decrypt(value.apiKeyEncrypted),
      apiSecret: this.encryptionService.decrypt(value.apiSecretEncrypted),
    };
  }

  /** Status for the admin UI -- configured flag + a masked hint, never the real value. */
  async getFiskalyPlatformCredentialStatus(): Promise<{ configured: boolean; apiKeyLast4: string | null }> {
    const row = await this.platformSettingRepository.findOne({ where: { key: FISKALY_PLATFORM_CREDENTIAL_KEY } });
    const value = row?.value as { apiKeyEncrypted?: string; apiKeyLast4?: string } | undefined;
    return {
      configured: !!value?.apiKeyEncrypted,
      apiKeyLast4: value?.apiKeyLast4 ?? null,
    };
  }

  /**
   * Generic accessors for simple, single-value settings (e.g. a persisted
   * polling cursor) that don't warrant their own typed getter/setter pair.
   */
  async getValue<T>(key: string): Promise<T | null> {
    const row = await this.platformSettingRepository.findOne({ where: { key } });
    if (!row) {
      return null;
    }
    return (row.value as { value: T }).value ?? null;
  }

  async setValue<T>(key: string, value: T): Promise<void> {
    const row = this.platformSettingRepository.create({
      key,
      value: { value } as unknown as Record<string, unknown>,
    });
    await this.platformSettingRepository.save(row);
  }
}
