import { BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import { DsfinvkArchivalService } from './dsfinvk-archival.service';

jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

describe('DsfinvkArchivalService', () => {
  const ORG_ID = 'org-1';
  const DEVICE_ID = 'device-1';

  let deviceRepository: { createQueryBuilder: jest.Mock };
  let orderRepository: { createQueryBuilder: jest.Mock };
  let closingRepository: { findOne: jest.Mock };
  let archiveRepository: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let exportService: { generateExportInternal: jest.Mock };
  let configService: { get: jest.Mock };
  let service: DsfinvkArchivalService;

  const device = { id: DEVICE_ID, organizationId: ORG_ID, settings: { tseClientId: DEVICE_ID } };
  const closing = {
    id: 'closing-1',
    deviceId: DEVICE_ID,
    zNr: 3,
    periodStart: new Date('2026-09-01T00:00:00Z'),
    periodEnd: new Date('2026-09-19T00:00:00Z'),
  };

  beforeEach(() => {
    jest.clearAllMocks();

    deviceRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([device]),
      }),
    };
    orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([{ eventId: 'event-1' }]),
      }),
    };
    closingRepository = { findOne: jest.fn().mockResolvedValue(closing) };
    archiveRepository = {
      findOne: jest.fn().mockResolvedValue(null), // no prior archive -> due
      create: jest.fn((x) => x),
      save: jest.fn().mockResolvedValue(undefined),
    };
    exportService = {
      generateExportInternal: jest.fn().mockResolvedValue({ data: Buffer.from('zip-bytes'), filename: 'dsfinvk-test-z3.zip' }),
    };
    configService = { get: jest.fn().mockReturnValue('./dsfinvk-archives') };

    service = new DsfinvkArchivalService(
      deviceRepository as any,
      orderRepository as any,
      closingRepository as any,
      archiveRepository as any,
      exportService as any,
      configService as any,
    );
  });

  it('skips a device archived more recently than the retention threshold', async () => {
    archiveRepository.findOne.mockResolvedValue({ deviceId: DEVICE_ID, createdAt: new Date() });

    await service.handleArchival();

    expect(exportService.generateExportInternal).not.toHaveBeenCalled();
  });

  it('archives a due device: exports, writes the file, and records the real closing bracket', async () => {
    await service.handleArchival();

    expect(exportService.generateExportInternal).toHaveBeenCalledWith(ORG_ID, 'event-1', DEVICE_ID);
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('closing-1-dsfinvk-test-z3.zip'),
      Buffer.from('zip-bytes'),
    );
    expect(archiveRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        eventId: 'event-1',
        deviceId: DEVICE_ID,
        periodStart: closing.periodStart,
        periodEnd: closing.periodEnd,
        sizeBytes: Buffer.from('zip-bytes').length,
        checksumSha256: crypto.createHash('sha256').update(Buffer.from('zip-bytes')).digest('hex'),
      }),
    );
  });

  it('treats "nothing to export" for one event as a skip, not a failure', async () => {
    exportService.generateExportInternal.mockRejectedValue(new BadRequestException('Nichts zu exportieren'));

    await service.handleArchival();

    expect(archiveRepository.save).not.toHaveBeenCalled();
  });

  it('isolates a failing device so other devices still get archived', async () => {
    const device2 = { id: 'device-2', organizationId: ORG_ID, settings: { tseClientId: 'device-2' } };
    deviceRepository.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([device, device2]),
    });
    exportService.generateExportInternal
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ data: Buffer.from('ok'), filename: 'dsfinvk-test-z1.zip' });

    await service.handleArchival();

    expect(exportService.generateExportInternal).toHaveBeenCalledTimes(2);
    expect(archiveRepository.save).toHaveBeenCalledTimes(1);
  });
});
