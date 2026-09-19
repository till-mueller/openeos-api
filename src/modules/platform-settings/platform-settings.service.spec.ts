import { PlatformSettingsService } from './platform-settings.service';
import { EncryptionService } from '../../common/services/encryption.service';

describe('PlatformSettingsService (fiskaly platform credential)', () => {
  let rows: Record<string, { key: string; value: Record<string, unknown> }>;
  let platformSettingRepository: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock; delete: jest.Mock };
  let configService: { get: jest.Mock };
  let encryptionService: EncryptionService;
  let service: PlatformSettingsService;

  beforeEach(() => {
    rows = {};
    platformSettingRepository = {
      findOne: jest.fn(({ where: { key } }) => Promise.resolve(rows[key] ?? null)),
      create: jest.fn((x) => x),
      save: jest.fn((row) => {
        rows[row.key] = row;
        return Promise.resolve(row);
      }),
      delete: jest.fn(({ key }) => {
        delete rows[key];
        return Promise.resolve({ affected: 1 });
      }),
    };
    // Real EncryptionService, not mocked -- the point of these tests is the
    // actual encrypt/decrypt roundtrip and that plaintext never lands in
    // the stored row, not just that some function got called.
    configService = { get: jest.fn().mockReturnValue('test-encryption-key-not-used-in-prod') };
    encryptionService = new EncryptionService(configService as any);

    service = new PlatformSettingsService(platformSettingRepository as any, configService as any, encryptionService);
  });

  it('returns null when nothing has been configured', async () => {
    await expect(service.getFiskalyPlatformCredential()).resolves.toBeNull();
    await expect(service.getFiskalyPlatformCredentialStatus()).resolves.toEqual({ configured: false, apiKeyLast4: null });
  });

  it('round-trips a stored credential through encryption', async () => {
    await service.setFiskalyPlatformCredential('sup_sk_platformkey12345', 'platform-secret-value');

    const credential = await service.getFiskalyPlatformCredential();
    expect(credential).toEqual({ apiKey: 'sup_sk_platformkey12345', apiSecret: 'platform-secret-value' });
  });

  it('never stores the plaintext apiKey/apiSecret in the persisted row', async () => {
    await service.setFiskalyPlatformCredential('sup_sk_platformkey12345', 'platform-secret-value');

    const stored = rows['fiskalyPlatformCredential'].value as Record<string, unknown>;
    expect(JSON.stringify(stored)).not.toContain('sup_sk_platformkey12345');
    expect(JSON.stringify(stored)).not.toContain('platform-secret-value');
    expect(stored.apiKeyEncrypted).toEqual(expect.any(String));
    expect(stored.apiSecretEncrypted).toEqual(expect.any(String));
  });

  it('the status check reports configured + a masked hint, never the real value', async () => {
    await service.setFiskalyPlatformCredential('sup_sk_platformkey12345', 'platform-secret-value');

    const status = await service.getFiskalyPlatformCredentialStatus();
    expect(status).toEqual({ configured: true, apiKeyLast4: '2345' });
  });

  it('clearing removes the stored credential entirely', async () => {
    await service.setFiskalyPlatformCredential('sup_sk_platformkey12345', 'platform-secret-value');
    await service.clearFiskalyPlatformCredential();

    await expect(service.getFiskalyPlatformCredential()).resolves.toBeNull();
    expect(platformSettingRepository.delete).toHaveBeenCalledWith({ key: 'fiskalyPlatformCredential' });
  });
});
