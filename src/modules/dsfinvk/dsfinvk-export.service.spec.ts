import { DsfinvkExportService } from './dsfinvk-export.service';
import {
  PaymentMethod,
  PaymentTransactionStatus,
} from '../../database/entities/payment.entity';
import { OrderItemStatus } from '../../database/entities/order-item.entity';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

describe('DsfinvkExportService', () => {
  let organizationRepository: { findOne: jest.Mock };
  let eventRepository: { findOne: jest.Mock };
  let deviceRepository: { findOne: jest.Mock };
  let orderRepository: { find: jest.Mock };
  let paymentRepository: { find: jest.Mock };
  let userOrganizationRepository: { findOne: jest.Mock };
  let closingRepository: { findOne: jest.Mock };
  let dataSource: { query: jest.Mock };
  let service: DsfinvkExportService;

  const ORG_ID = 'org-1';
  const EVENT_ID = 'event-1';
  const DEVICE_ID = 'device-1';
  const USER_ID = 'user-1';

  const order = () => ({
    id: 'order-1',
    organizationId: ORG_ID,
    eventId: EVENT_ID,
    createdByDeviceId: DEVICE_ID,
    createdByUserId: 'user-2',
    createdByUser: { firstName: 'Anna', lastName: 'Muster' },
    createdAt: new Date('2026-09-19T10:00:00Z'),
    completedAt: new Date('2026-09-19T10:01:00Z'),
    cancelledAt: null,
    cancellationReason: null,
    notes: null,
    items: [
      {
        id: 'item-1',
        productId: 'prod-1',
        categoryId: 'cat-1',
        productName: 'Bier',
        categoryName: 'Getraenke',
        quantity: 2,
        unitPrice: 3,
        optionsPrice: 0,
        taxRate: 19,
        depositAmount: 0,
        isRefill: false,
        status: OrderItemStatus.DELIVERED,
      },
    ],
    payments: [
      {
        id: 'payment-1',
        status: PaymentTransactionStatus.CAPTURED,
        reversesPaymentId: null,
        paymentMethod: PaymentMethod.CASH,
        amount: 6,
      },
    ],
  });

  beforeEach(() => {
    organizationRepository = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: ORG_ID, name: 'Verein e.V.', settings: {} }),
    };
    eventRepository = {
      findOne: jest
        .fn()
        .mockResolvedValue({
          id: EVENT_ID,
          name: 'Sommerfest',
          startDate: new Date('2026-09-19T08:00:00Z'),
        }),
    };
    deviceRepository = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: DEVICE_ID, name: 'Kasse 1', settings: {} }),
    };
    orderRepository = { find: jest.fn().mockResolvedValue([order()]) };
    paymentRepository = { find: jest.fn().mockResolvedValue([]) };
    userOrganizationRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 'membership-1' }),
    };
    closingRepository = { findOne: jest.fn().mockResolvedValue(null) };
    dataSource = {
      query: jest.fn().mockResolvedValue([
        {
          id: 'closing-1',
          zNr: 1,
          erstellung: '2026-09-19T11:00:00.000Z',
          startBonId: 'order-1',
          endBonId: 'order-1',
        },
      ]),
    };

    service = new DsfinvkExportService(
      organizationRepository as any,
      eventRepository as any,
      deviceRepository as any,
      orderRepository as any,
      paymentRepository as any,
      userOrganizationRepository as any,
      closingRepository as any,
      dataSource as any,
    );
  });

  it('rejects a caller who is not a member of the organization', async () => {
    userOrganizationRepository.findOne.mockResolvedValue(null);
    await expect(
      service.generateExport(ORG_ID, EVENT_ID, DEVICE_ID, USER_ID),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses to export a period with nothing to report', async () => {
    orderRepository.find.mockResolvedValue([]);
    paymentRepository.find.mockResolvedValue([]);
    await expect(
      service.generateExport(ORG_ID, EVENT_ID, DEVICE_ID, USER_ID),
    ).rejects.toThrow(BadRequestException);
  });

  it('allocates a Z_NR via the atomic insert, not computed in application code', async () => {
    await service.generateExport(ORG_ID, EVENT_ID, DEVICE_ID, USER_ID);
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('COALESCE(MAX(z_nr), 0) + 1'),
      expect.arrayContaining([ORG_ID, EVENT_ID, DEVICE_ID]),
    );
  });

  it('produces a real ZIP archive covering a plain qualifying order', async () => {
    const result = await service.generateExport(
      ORG_ID,
      EVENT_ID,
      DEVICE_ID,
      USER_ID,
    );
    expect(result.filename).toMatch(/^dsfinvk-.*\.zip$/);
    expect(result.data.subarray(0, 2).toString('hex')).toBe('504b');
  });

  it('skips an order that was never actually paid (no captured payment)', async () => {
    orderRepository.find.mockResolvedValue([{ ...order(), payments: [] }]);
    await expect(
      service.generateExport(ORG_ID, EVENT_ID, DEVICE_ID, USER_ID),
    ).rejects.toThrow(BadRequestException);
  });

  it('includes a Phase 0 reversal as its own Vorgang, scoped to this device and event', async () => {
    orderRepository.find.mockResolvedValue([]);
    paymentRepository.find.mockResolvedValue([
      {
        id: 'reversal-1',
        orderId: 'order-1',
        amount: -6,
        paymentMethod: PaymentMethod.CASH,
        reversesPaymentId: 'payment-1',
        createdAt: new Date('2026-09-19T10:05:00Z'),
        order: { eventId: EVENT_ID, createdByDeviceId: DEVICE_ID },
      },
    ]);
    const result = await service.generateExport(
      ORG_ID,
      EVENT_ID,
      DEVICE_ID,
      USER_ID,
    );
    expect(result.data.length).toBeGreaterThan(0);
  });

  it('excludes a reversal that belongs to a different device', async () => {
    orderRepository.find.mockResolvedValue([]);
    paymentRepository.find.mockResolvedValue([
      {
        id: 'reversal-1',
        orderId: 'order-1',
        amount: -6,
        paymentMethod: PaymentMethod.CASH,
        reversesPaymentId: 'payment-1',
        createdAt: new Date('2026-09-19T10:05:00Z'),
        order: { eventId: EVENT_ID, createdByDeviceId: 'device-2' },
      },
    ]);
    await expect(
      service.generateExport(ORG_ID, EVENT_ID, DEVICE_ID, USER_ID),
    ).rejects.toThrow(BadRequestException);
  });
});
