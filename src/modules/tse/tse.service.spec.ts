import { ForbiddenException } from '@nestjs/common';
import { TseService } from './tse.service';
import { FiskalyTseProvider } from './providers/fiskaly-tse.provider';
import { LocalTseProvider } from './providers/local-tse.provider';

describe('TseService', () => {
  let organizationRepository: { findOne: jest.Mock; save: jest.Mock; find: jest.Mock };
  let deviceRepository: { findOne: jest.Mock; find: jest.Mock; save: jest.Mock };
  let userOrganizationRepository: { findOne: jest.Mock };
  let fiskalyProvider: jest.Mocked<Pick<FiskalyTseProvider, 'ensureClient' | 'recordTransaction' | 'testConnection' | 'exportData' | 'createTss'>>;
  let localProvider: jest.Mocked<Pick<LocalTseProvider, 'ensureClient' | 'recordTransaction' | 'testConnection' | 'exportData'>>;
  let configService: { get: jest.Mock };
  let platformSettingsService: { getFiskalyPlatformCredential: jest.Mock };
  let service: TseService;

  beforeEach(() => {
    organizationRepository = { findOne: jest.fn(), save: jest.fn(), find: jest.fn() };
    deviceRepository = { findOne: jest.fn(), find: jest.fn(), save: jest.fn() };
    userOrganizationRepository = { findOne: jest.fn() };
    configService = { get: jest.fn().mockReturnValue('') };
    // Default: no DB-stored platform credential, so getPlatformFiskalyCredential
    // falls through to configService (env var) -- matches every existing
    // test's expectations without further changes.
    platformSettingsService = { getFiskalyPlatformCredential: jest.fn().mockResolvedValue(null) };
    fiskalyProvider = {
      ensureClient: jest.fn(),
      recordTransaction: jest.fn(),
      testConnection: jest.fn(),
      exportData: jest.fn(),
      createTss: jest.fn(),
    };
    localProvider = {
      ensureClient: jest.fn(),
      recordTransaction: jest.fn(),
      testConnection: jest.fn(),
      exportData: jest.fn(),
    };

    // Attach `name` in place (rather than spreading into a new object) so
    // later mutations to fiskalyProvider/localProvider in a test — e.g.
    // deleting `exportData` to simulate an unsupported provider — are
    // visible through the same reference the service was constructed with.
    (fiskalyProvider as any).name = 'fiskaly';
    (localProvider as any).name = 'local';

    service = new TseService(
      organizationRepository as any,
      deviceRepository as any,
      userOrganizationRepository as any,
      fiskalyProvider as any,
      localProvider as any,
      configService as any,
      platformSettingsService as any,
    );
  });

  const ORG_ID = 'org-1';
  const USER_ID = 'user-1';

  describe('recordTransaction', () => {
    it('returns null when TSE is not enabled', async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: { tse: { enabled: false, provider: 'fiskaly' } },
      });

      const result = await service.recordTransaction(ORG_ID, null, { amount: 10, paymentMethod: 'cash' });

      expect(result).toBeNull();
      expect(fiskalyProvider.recordTransaction).not.toHaveBeenCalled();
    });

    it('returns null when provider is fiskaly but credentials are missing', async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: { tse: { enabled: true, provider: 'fiskaly' } }, // no `fiskaly` block
      });

      const result = await service.recordTransaction(ORG_ID, null, { amount: 10, paymentMethod: 'cash' });

      expect(result).toBeNull();
    });

    it('signs through the fiskaly provider and returns failed: false on success', async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: {
          currency: 'EUR',
          tse: { enabled: true, provider: 'fiskaly', fiskaly: { apiKey: 'k', apiSecret: 's', tssId: 't' } },
        },
      });
      fiskalyProvider.recordTransaction.mockResolvedValue({
        provider: 'fiskaly',
        clientId: ORG_ID,
        transactionNumber: 5,
        serialNumber: 'SN',
        signatureCounter: 1,
        signatureValue: 'sig',
        signatureAlgorithm: 'algo',
        startTime: 't0',
        endTime: 't1',
        processType: 'Kassenbeleg-V1',
        processData: '',
        qrCodeData: 'qr',
      });

      const result = await service.recordTransaction(ORG_ID, null, { amount: 10, paymentMethod: 'cash' });

      expect(fiskalyProvider.ensureClient).toHaveBeenCalledWith(
        { apiKey: 'k', apiSecret: 's', tssId: 't' },
        ORG_ID, // no device -> org-wide client id
      );
      expect(result).toEqual(expect.objectContaining({ failed: false, transactionNumber: 5, signatureValue: 'sig' }));
    });

    it('never throws on a provider failure — returns a failed:true outage marker instead', async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: {
          tse: { enabled: true, provider: 'fiskaly', fiskaly: { apiKey: 'k', apiSecret: 's', tssId: 't' } },
        },
      });
      fiskalyProvider.recordTransaction.mockRejectedValue(new Error('network down'));

      const result = await service.recordTransaction(ORG_ID, null, { amount: 10, paymentMethod: 'cash' });

      expect(result).toEqual(
        expect.objectContaining({ failed: true, failureReason: 'network down', provider: 'fiskaly' }),
      );
    });

    it('uses the local provider when configured, passing organizationId through config', async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: { tse: { enabled: true, provider: 'local', local: { agentDeviceId: 'agent-1' } } },
      });
      localProvider.recordTransaction.mockResolvedValue({
        provider: 'local',
        clientId: ORG_ID,
        transactionNumber: 1,
        serialNumber: 'SN',
        signatureCounter: 1,
        signatureValue: 'sig',
        signatureAlgorithm: 'algo',
        startTime: 't0',
        endTime: 't1',
        processType: 'Kassenbeleg-V1',
        processData: '',
        qrCodeData: 'qr',
      });

      await service.recordTransaction(ORG_ID, null, { amount: 10, paymentMethod: 'cash' });

      expect(localProvider.recordTransaction).toHaveBeenCalledWith(
        { agentDeviceId: 'agent-1', organizationId: ORG_ID },
        expect.objectContaining({ organizationId: ORG_ID, clientId: ORG_ID }),
      );
    });
  });

  describe('reverseTransaction', () => {
    beforeEach(() => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: {
          currency: 'EUR',
          tse: { enabled: true, provider: 'fiskaly', fiskaly: { apiKey: 'k', apiSecret: 's', tssId: 't' } },
        },
      });
      fiskalyProvider.recordTransaction.mockResolvedValue({
        provider: 'fiskaly',
        clientId: ORG_ID,
        transactionNumber: 6,
        serialNumber: 'SN',
        signatureCounter: 2,
        signatureValue: 'sig',
        signatureAlgorithm: 'algo',
        startTime: 't0',
        endTime: 't1',
        processType: 'Kassenbeleg-V1',
        processData: '',
        qrCodeData: 'qr',
      });
    });

    it('negates a positive amount before signing', async () => {
      await service.reverseTransaction(ORG_ID, null, { amount: 10, paymentMethod: 'cash' });

      expect(fiskalyProvider.recordTransaction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ amount: -10 }),
      );
    });

    it('always signs a negative amount even if the caller already negated it', async () => {
      // Math.abs before negating -- a caller passing an already-negative
      // amount must not accidentally end up positive (double-negation bug).
      await service.reverseTransaction(ORG_ID, null, { amount: -10, paymentMethod: 'cash' });

      expect(fiskalyProvider.recordTransaction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ amount: -10 }),
      );
    });
  });

  describe('resolveClientId (via recordTransaction)', () => {
    it("assigns and persists a till's own client id (its device id) on first use", async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: {
          tse: { enabled: true, provider: 'fiskaly', fiskaly: { apiKey: 'k', apiSecret: 's', tssId: 't' } },
        },
      });
      deviceRepository.findOne.mockResolvedValue({ id: 'device-1', settings: {} });
      fiskalyProvider.recordTransaction.mockResolvedValue({
        provider: 'fiskaly',
        clientId: 'device-1',
        transactionNumber: 1,
        serialNumber: 'SN',
        signatureCounter: 1,
        signatureValue: 'sig',
        signatureAlgorithm: 'algo',
        startTime: 't0',
        endTime: 't1',
        processType: 'Kassenbeleg-V1',
        processData: '',
        qrCodeData: 'qr',
      });

      await service.recordTransaction(ORG_ID, 'device-1', { amount: 10, paymentMethod: 'cash' });

      expect(deviceRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'device-1', settings: expect.objectContaining({ tseClientId: 'device-1' }) }),
      );
      expect(fiskalyProvider.recordTransaction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ clientId: 'device-1' }),
      );
    });

    it('reuses an already-assigned client id without writing again', async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: {
          tse: { enabled: true, provider: 'fiskaly', fiskaly: { apiKey: 'k', apiSecret: 's', tssId: 't' } },
        },
      });
      deviceRepository.findOne.mockResolvedValue({ id: 'device-1', settings: { tseClientId: 'existing-client' } });
      fiskalyProvider.recordTransaction.mockResolvedValue({
        provider: 'fiskaly',
        clientId: 'existing-client',
        transactionNumber: 1,
        serialNumber: 'SN',
        signatureCounter: 1,
        signatureValue: 'sig',
        signatureAlgorithm: 'algo',
        startTime: 't0',
        endTime: 't1',
        processType: 'Kassenbeleg-V1',
        processData: '',
        qrCodeData: 'qr',
      });

      await service.recordTransaction(ORG_ID, 'device-1', { amount: 10, paymentMethod: 'cash' });

      expect(deviceRepository.save).not.toHaveBeenCalled();
      expect(fiskalyProvider.recordTransaction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ clientId: 'existing-client' }),
      );
    });
  });

  describe('testConnection', () => {
    it('throws ForbiddenException when the user is not a member of the org', async () => {
      userOrganizationRepository.findOne.mockResolvedValue(null);

      await expect(service.testConnection(ORG_ID, USER_ID)).rejects.toThrow(ForbiddenException);
    });

    it('reports not-configured when TSE is off', async () => {
      userOrganizationRepository.findOne.mockResolvedValue({ id: 'membership-1' });
      organizationRepository.findOne.mockResolvedValue({ id: ORG_ID, settings: {} });

      const result = await service.testConnection(ORG_ID, USER_ID);

      expect(result.ok).toBe(false);
    });

    it('delegates to the resolved provider', async () => {
      userOrganizationRepository.findOne.mockResolvedValue({ id: 'membership-1' });
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: {
          tse: { enabled: true, provider: 'fiskaly', fiskaly: { apiKey: 'k', apiSecret: 's', tssId: 't' } },
        },
      });
      fiskalyProvider.testConnection.mockResolvedValue({ ok: true });

      const result = await service.testConnection(ORG_ID, USER_ID);

      expect(result).toEqual({ ok: true });
      expect(fiskalyProvider.testConnection).toHaveBeenCalledWith({ apiKey: 'k', apiSecret: 's', tssId: 't' });
    });
  });

  describe('listClientIds', () => {
    it('throws ForbiddenException for a non-member', async () => {
      userOrganizationRepository.findOne.mockResolvedValue(null);

      await expect(service.listClientIds(ORG_ID, USER_ID)).rejects.toThrow(ForbiddenException);
    });

    it('returns the org-wide id plus each distinct device client id', async () => {
      userOrganizationRepository.findOne.mockResolvedValue({ id: 'membership-1' });
      deviceRepository.find.mockResolvedValue([
        { id: 'd1', settings: { tseClientId: 'client-a' } },
        { id: 'd2', settings: { tseClientId: 'client-b' } },
        { id: 'd3', settings: {} }, // never signed -> no client id yet
        { id: 'd4', settings: { tseClientId: 'client-a' } }, // duplicate
      ]);

      const result = await service.listClientIds(ORG_ID, USER_ID);

      expect(result).toEqual([ORG_ID, 'client-a', 'client-b']);
    });
  });

  describe('exportData', () => {
    beforeEach(() => {
      userOrganizationRepository.findOne.mockResolvedValue({ id: 'membership-1' });
    });

    it('throws when the provider does not support export', async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: { tse: { enabled: true, provider: 'fiskaly', fiskaly: { apiKey: 'k', apiSecret: 's', tssId: 't' } } },
      });
      (fiskalyProvider as any).exportData = undefined;

      await expect(
        service.exportData(ORG_ID, USER_ID, new Date('2026-08-21'), new Date('2026-08-23')),
      ).rejects.toThrow('TSE-Export ist für diese Organisation nicht verfügbar');
    });

    it('rejects a clientId that does not belong to this org', async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: { tse: { enabled: true, provider: 'fiskaly', fiskaly: { apiKey: 'k', apiSecret: 's', tssId: 't' } } },
      });
      deviceRepository.find.mockResolvedValue([{ id: 'd1', settings: { tseClientId: 'client-a' } }]);

      await expect(
        service.exportData(ORG_ID, USER_ID, new Date('2026-08-21'), new Date('2026-08-23'), 'not-my-client'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('defaults to the org-wide client id and returns the provider export', async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: { tse: { enabled: true, provider: 'fiskaly', fiskaly: { apiKey: 'k', apiSecret: 's', tssId: 't' } } },
      });
      fiskalyProvider.exportData.mockResolvedValue({ data: Buffer.from('x'), filename: 'export.tar' });

      const result = await service.exportData(ORG_ID, USER_ID, new Date('2026-08-21'), new Date('2026-08-23'));

      expect(result.filename).toBe('export.tar');
      expect(fiskalyProvider.exportData).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ clientId: ORG_ID }),
      );
    });
  });

  describe('createTss', () => {
    it('provisions under the org-supplied credentials and persists them, unmarked as reseller', async () => {
      userOrganizationRepository.findOne.mockResolvedValue({ id: 'membership-1' });
      fiskalyProvider.createTss.mockResolvedValue({ tssId: 'tss-1', adminPin: '1234' });
      organizationRepository.findOne.mockResolvedValue({ id: ORG_ID, settings: {} });

      const result = await service.createTss(ORG_ID, USER_ID, { apiKey: 'own-key', apiSecret: 'own-secret' });

      expect(result).toEqual({ ok: true, tssId: 'tss-1' });
      expect(fiskalyProvider.createTss).toHaveBeenCalledWith('own-key', 'own-secret');
      expect(organizationRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            tse: expect.objectContaining({ fiskaly: expect.objectContaining({ apiKey: 'own-key', tssId: 'tss-1' }) }),
          }),
        }),
      );
      const savedSettings = organizationRepository.save.mock.calls[0][0].settings;
      expect(savedSettings.tse.reseller).toBeUndefined();
    });
  });

  describe('activatePlatformTse', () => {
    it('rejects without an explicit Betreiber acknowledgment', async () => {
      userOrganizationRepository.findOne.mockResolvedValue({ id: 'membership-1' });
      await expect(service.activatePlatformTse(ORG_ID, USER_ID, false)).rejects.toThrow(/Betreiberverantwortung/);
      expect(fiskalyProvider.createTss).not.toHaveBeenCalled();
    });

    it('refuses when the platform has no reseller credential configured', async () => {
      userOrganizationRepository.findOne.mockResolvedValue({ id: 'membership-1' });
      configService.get.mockReturnValue('');

      const result = await service.activatePlatformTse(ORG_ID, USER_ID, true);

      expect(result).toEqual({ ok: false, message: expect.stringContaining('nicht konfiguriert') });
      expect(fiskalyProvider.createTss).not.toHaveBeenCalled();
    });

    it('provisions under the platform credential and marks the org as reseller-activated', async () => {
      userOrganizationRepository.findOne.mockResolvedValue({ id: 'membership-1' });
      configService.get.mockImplementation((key: string) =>
        key === 'fiskaly.platformApiKey' ? 'platform-key' : key === 'fiskaly.platformApiSecret' ? 'platform-secret' : '',
      );
      fiskalyProvider.createTss.mockResolvedValue({ tssId: 'tss-2', adminPin: '5678' });
      organizationRepository.findOne.mockResolvedValue({ id: ORG_ID, settings: {} });

      const result = await service.activatePlatformTse(ORG_ID, USER_ID, true);

      expect(result).toEqual({ ok: true, tssId: 'tss-2' });
      expect(fiskalyProvider.createTss).toHaveBeenCalledWith('platform-key', 'platform-secret');
      expect(organizationRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            tse: expect.objectContaining({ reseller: true, activatedAt: expect.any(String) }),
          }),
        }),
      );
    });

    it('never persists the real platform credential onto the org row -- that row is returned unmasked to the org itself', async () => {
      userOrganizationRepository.findOne.mockResolvedValue({ id: 'membership-1' });
      configService.get.mockImplementation((key: string) =>
        key === 'fiskaly.platformApiKey' ? 'platform-key' : key === 'fiskaly.platformApiSecret' ? 'platform-secret' : '',
      );
      fiskalyProvider.createTss.mockResolvedValue({ tssId: 'tss-2', adminPin: '5678' });
      organizationRepository.findOne.mockResolvedValue({ id: ORG_ID, settings: {} });

      await service.activatePlatformTse(ORG_ID, USER_ID, true);

      const savedSettings = organizationRepository.save.mock.calls[0][0].settings;
      expect(savedSettings.tse.fiskaly.apiKey).toBe('');
      expect(savedSettings.tse.fiskaly.apiSecret).toBe('');
      expect(savedSettings.tse.fiskaly.tssId).toBe('tss-2'); // tssId/adminPin are fine to keep -- not the secret
    });
  });

  describe('resolveProvider via recordTransaction (reseller substitution)', () => {
    it('signs using the platform credential, not the (blank) persisted one, for a reseller-activated org', async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: {
          tse: {
            enabled: true,
            provider: 'fiskaly',
            reseller: true,
            fiskaly: { apiKey: '', apiSecret: '', tssId: 'tss-2', adminPin: '5678' },
          },
        },
      });
      configService.get.mockImplementation((key: string) =>
        key === 'fiskaly.platformApiKey' ? 'platform-key' : key === 'fiskaly.platformApiSecret' ? 'platform-secret' : '',
      );
      fiskalyProvider.recordTransaction.mockResolvedValue({
        provider: 'fiskaly',
        clientId: ORG_ID,
        transactionNumber: 1,
        serialNumber: 'SN',
        signatureCounter: 1,
        signatureValue: 'sig',
        signatureAlgorithm: 'algo',
        startTime: 't0',
        endTime: 't1',
        processType: 'Kassenbeleg-V1',
        processData: '',
        qrCodeData: 'qr',
      });

      await service.recordTransaction(ORG_ID, null, { amount: 10, paymentMethod: 'cash' });

      expect(fiskalyProvider.ensureClient).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'platform-key', apiSecret: 'platform-secret', tssId: 'tss-2' }),
        ORG_ID,
      );
    });

    it('refuses to sign a reseller org if the platform credential is no longer configured', async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: {
          tse: {
            enabled: true,
            provider: 'fiskaly',
            reseller: true,
            fiskaly: { apiKey: '', apiSecret: '', tssId: 'tss-2' },
          },
        },
      });
      configService.get.mockReturnValue('');

      const result = await service.recordTransaction(ORG_ID, null, { amount: 10, paymentMethod: 'cash' });

      expect(result).toBeNull();
      expect(fiskalyProvider.recordTransaction).not.toHaveBeenCalled();
    });
  });

  describe('listActiveClientsForAdmin', () => {
    it('skips orgs with TSE disabled and reports client counts for the rest', async () => {
      organizationRepository.find.mockResolvedValue([
        { id: 'org-a', name: 'Verein A', settings: { tse: { enabled: false } } },
        {
          id: 'org-b',
          name: 'Verein B',
          settings: { tse: { enabled: true, provider: 'fiskaly', reseller: true, activatedAt: '2026-09-01T00:00:00.000Z' } },
        },
      ]);
      deviceRepository.find.mockResolvedValue([
        { id: 'd1', settings: { tseClientId: 'client-1' } },
        { id: 'd2', settings: { tseClientId: 'client-2' } },
      ]);

      const result = await service.listActiveClientsForAdmin();

      expect(result).toEqual([
        {
          organizationId: 'org-b',
          organizationName: 'Verein B',
          provider: 'fiskaly',
          reseller: true,
          activatedAt: '2026-09-01T00:00:00.000Z',
          clientCount: 3, // org-wide client + 2 device clients
        },
      ]);
    });
  });

  describe('isResellerModeAvailable', () => {
    it('is false when there is no DB-stored credential and either env-var half is missing', async () => {
      configService.get.mockImplementation((key: string) => (key === 'fiskaly.platformApiKey' ? 'key-only' : ''));
      await expect(service.isResellerModeAvailable()).resolves.toBe(false);
    });

    it('is true via the env-var fallback when both halves are set and nothing is stored in the DB', async () => {
      configService.get.mockReturnValue('set');
      await expect(service.isResellerModeAvailable()).resolves.toBe(true);
    });

    it('prefers the DB-stored credential (admin UI) over the env var', async () => {
      platformSettingsService.getFiskalyPlatformCredential.mockResolvedValue({ apiKey: 'db-key', apiSecret: 'db-secret' });
      configService.get.mockReturnValue(''); // env var unset entirely
      await expect(service.isResellerModeAvailable()).resolves.toBe(true);
    });
  });
});
