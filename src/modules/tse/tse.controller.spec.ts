import { BadRequestException } from '@nestjs/common';
import { TseController } from './tse.controller';
import { TseService } from './tse.service';

describe('TseController', () => {
  let tseService: jest.Mocked<Pick<TseService, 'testConnection' | 'listClientIds' | 'exportData' | 'isResellerModeAvailable' | 'activatePlatformTse'>>;
  let controller: TseController;

  const user = { id: 'user-1' } as any;
  const ORG_ID = 'org-1';

  beforeEach(() => {
    tseService = {
      testConnection: jest.fn(),
      listClientIds: jest.fn(),
      exportData: jest.fn(),
      isResellerModeAvailable: jest.fn(),
      activatePlatformTse: jest.fn(),
    };
    controller = new TseController(tseService as unknown as TseService);
  });

  it('resellerAvailable wraps the service result in { data }', async () => {
    tseService.isResellerModeAvailable.mockResolvedValue(true);

    const result = await controller.resellerAvailable();

    expect(result).toEqual({ data: { available: true } });
  });

  it('activate delegates the acknowledgment flag and caller identity to the service', () => {
    controller.activate(ORG_ID, { acknowledgedBetreiber: true }, user);
    expect(tseService.activatePlatformTse).toHaveBeenCalledWith(ORG_ID, 'user-1', true);
  });

  it('testConnection delegates to the service with the caller identity', () => {
    controller.testConnection(ORG_ID, user);
    expect(tseService.testConnection).toHaveBeenCalledWith(ORG_ID, 'user-1');
  });

  it('listClients wraps the service result in { data }', async () => {
    tseService.listClientIds.mockResolvedValue(['org-1', 'device-1']);

    const result = await controller.listClients(ORG_ID, user);

    expect(tseService.listClientIds).toHaveBeenCalledWith(ORG_ID, 'user-1');
    expect(result).toEqual({ data: ['org-1', 'device-1'] });
  });

  describe('exportData', () => {
    const res = { setHeader: jest.fn(), send: jest.fn() };

    beforeEach(() => {
      res.setHeader.mockClear();
      res.send.mockClear();
    });

    it('rejects invalid date query params before calling the service', async () => {
      await expect(
        controller.exportData(ORG_ID, 'not-a-date', '2026-08-23', undefined, user, res),
      ).rejects.toThrow(BadRequestException);
      expect(tseService.exportData).not.toHaveBeenCalled();
    });

    it('streams the export with the right headers on success', async () => {
      tseService.exportData.mockResolvedValue({ data: Buffer.from('x'), filename: 'export.tar' });

      await controller.exportData(ORG_ID, '2026-08-21', '2026-08-23', 'client-1', user, res);

      expect(tseService.exportData).toHaveBeenCalledWith(
        ORG_ID,
        'user-1',
        new Date('2026-08-21'),
        new Date('2026-08-23'),
        'client-1',
      );
      expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('export.tar'));
      expect(res.send).toHaveBeenCalledWith(Buffer.from('x'));
    });
  });
});
