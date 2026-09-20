import { ForbiddenException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrderStatus, PaymentStatus } from '../../database/entities/order.entity';
import { PaymentTransactionStatus } from '../../database/entities/payment.entity';
import { OrderItemStatus } from '../../database/entities/order-item.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { OrderAuditAction } from '../../database/entities/order-audit-log.entity';

describe('OrdersService — Force* admin overrides', () => {
  let orderRepository: { findOne: jest.Mock; save: jest.Mock };
  let orderItemRepository: { save: jest.Mock };
  let productRepository: { findOne: jest.Mock };
  let organizationRepository: { findOne: jest.Mock };
  let userOrganizationRepository: { findOne: jest.Mock };
  let stockMovementRepository: { create: jest.Mock; save: jest.Mock };
  let eventRepository: { findOne: jest.Mock };
  let productionStationRepository: { find: jest.Mock };
  let paymentRepository: { find: jest.Mock; create: jest.Mock; save: jest.Mock };
  let orderPrintService: Record<string, jest.Mock>;
  let printJobsService: Record<string, jest.Mock>;
  let gatewayService: Record<string, jest.Mock>;
  let configService: { get: jest.Mock };
  let tseService: { recordTransaction: jest.Mock; reverseTransaction: jest.Mock };
  let orderAuditLogRepository: { create: jest.Mock; save: jest.Mock };
  let service: OrdersService;

  const ORG_ID = 'org-1';
  const user = { id: 'user-1', isSuperAdmin: false } as any;
  const reasonDto = { reason: 'Manuelle Korrektur durch Admin' };

  const baseOrder = () => ({
    id: 'order-1',
    organizationId: ORG_ID,
    orderNumber: 'A-1',
    status: OrderStatus.OPEN,
    paymentStatus: PaymentStatus.PAID,
    createdByDeviceId: 'device-1',
    items: [
      { id: 'item-1', orderId: 'order-1', productId: 'product-1', quantity: 1, unitPrice: 10, optionsPrice: 0, taxRate: 19, status: OrderItemStatus.PENDING },
    ],
  });

  beforeEach(() => {
    orderRepository = { findOne: jest.fn(), save: jest.fn(async (o) => o) };
    orderItemRepository = { save: jest.fn(async (i) => i) };
    productRepository = { findOne: jest.fn().mockResolvedValue(null) };
    organizationRepository = { findOne: jest.fn() };
    userOrganizationRepository = { findOne: jest.fn().mockResolvedValue({ id: 'membership-1', role: OrganizationRole.ADMIN }) };
    stockMovementRepository = { create: jest.fn(), save: jest.fn() };
    eventRepository = { findOne: jest.fn() };
    productionStationRepository = { find: jest.fn() };
    paymentRepository = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((dto) => ({ ...dto, id: 'reversal-1' })),
      save: jest.fn(async (p) => p),
    };
    orderPrintService = {};
    printJobsService = {};
    gatewayService = {};
    configService = { get: jest.fn() };
    tseService = { recordTransaction: jest.fn(), reverseTransaction: jest.fn() };
    orderAuditLogRepository = { create: jest.fn((d) => ({ ...d, id: 'audit-1' })), save: jest.fn(async (l) => l) };

    service = new OrdersService(
      orderRepository as any,
      orderItemRepository as any,
      productRepository as any,
      organizationRepository as any,
      userOrganizationRepository as any,
      stockMovementRepository as any,
      eventRepository as any,
      productionStationRepository as any,
      paymentRepository as any,
      orderPrintService as any,
      printJobsService as any,
      gatewayService as any,
      configService as any,
      tseService as any,
      orderAuditLogRepository as any,
    );

    // findOne() (used both to load the order and to return the fresh row at
    // the end of each Force* method) queries orderRepository directly. Share
    // one mutable object across calls so the second findOne() sees mutations
    // the method made via save() on the first one — a fresh object per call
    // would silently discard them, same as a real repository would not.
    let order = baseOrder();
    orderRepository.findOne.mockImplementation(async () => order);
    (orderRepository as any).__setOrder = (next: ReturnType<typeof baseOrder>) => {
      order = next;
    };
  });

  describe('forceCancelOrder', () => {
    it('refuses a non-admin member', async () => {
      userOrganizationRepository.findOne.mockResolvedValue({ id: 'membership-1', role: OrganizationRole.MEMBER });

      await expect(service.forceCancelOrder(ORG_ID, 'order-1', reasonDto, user)).rejects.toBeInstanceOf(ForbiddenException);
      expect(orderRepository.save).not.toHaveBeenCalled();
    });

    it('rejects an order already cancelled', async () => {
      (orderRepository as any).__setOrder({ ...baseOrder(), status: OrderStatus.CANCELLED });

      await expect(service.forceCancelOrder(ORG_ID, 'order-1', reasonDto, user)).rejects.toThrow();
      expect(orderRepository.save).not.toHaveBeenCalled();
    });

    it('cancels, restores stock, and writes a success audit entry when there are no captured payments to reverse', async () => {
      paymentRepository.find.mockResolvedValue([]);

      const result = await service.forceCancelOrder(ORG_ID, 'order-1', reasonDto, user);

      expect(result.status).toBe(OrderStatus.CANCELLED);
      expect(orderRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: OrderStatus.CANCELLED, cancellationReason: reasonDto.reason }),
      );
      expect(orderItemRepository.save).toHaveBeenCalledWith(expect.objectContaining({ status: OrderItemStatus.CANCELLED }));
      expect(orderAuditLogRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_ID,
          orderId: 'order-1',
          actorUserId: user.id,
          action: OrderAuditAction.FORCE_CANCEL,
          reason: reasonDto.reason,
          details: expect.objectContaining({ after: expect.objectContaining({ status: OrderStatus.CANCELLED }) }),
        }),
      );
    });

    it('requires the TSE reversal to succeed: aborts the cancel and writes a failure audit entry when it fails', async () => {
      paymentRepository.find.mockResolvedValue([
        { id: 'payment-1', orderId: 'order-1', amount: 10, paymentMethod: 'cash', paymentProvider: 'CASH', status: PaymentTransactionStatus.CAPTURED, tseData: null },
      ]);
      tseService.reverseTransaction.mockResolvedValue({
        failed: true,
        errorCode: 'TSS_NOT_INITIALIZED',
        httpStatus: 400,
        failureReason: 'TSS not initialized',
      });

      await expect(service.forceCancelOrder(ORG_ID, 'order-1', reasonDto, user)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'TSE_REVERSAL_REQUIRED' }),
      });

      // Never flips the order to CANCELLED when the reversal was rejected.
      expect(orderRepository.save).not.toHaveBeenCalled();
      expect(orderAuditLogRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: OrderAuditAction.FORCE_CANCEL,
          details: expect.objectContaining({
            failure: expect.objectContaining({ errorCode: 'TSS_NOT_INITIALIZED', httpStatus: 400 }),
          }),
        }),
      );
    });

    it('proceeds and cancels when the TSE reversal succeeds', async () => {
      paymentRepository.find.mockResolvedValue([
        { id: 'payment-1', orderId: 'order-1', amount: 10, paymentMethod: 'cash', paymentProvider: 'CASH', status: PaymentTransactionStatus.CAPTURED, tseData: null },
      ]);
      tseService.reverseTransaction.mockResolvedValue({ failed: false, signatureValue: 'sig' });

      const result = await service.forceCancelOrder(ORG_ID, 'order-1', reasonDto, user);

      expect(result.status).toBe(OrderStatus.CANCELLED);
      expect(paymentRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ reversesPaymentId: 'payment-1', amount: -10 }),
      );
    });
  });

  describe('forceUpdateStatus', () => {
    it('refuses a non-admin member', async () => {
      userOrganizationRepository.findOne.mockResolvedValue({ id: 'membership-1', role: OrganizationRole.MEMBER });

      await expect(
        service.forceUpdateStatus(ORG_ID, 'order-1', { status: OrderStatus.READY, reason: 'x' } as any, user),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses CANCELLED as a target status', async () => {
      await expect(
        service.forceUpdateStatus(ORG_ID, 'order-1', { status: OrderStatus.CANCELLED, reason: 'x' } as any, user),
      ).rejects.toThrow();
      expect(orderRepository.save).not.toHaveBeenCalled();
    });

    it('refuses to reactivate an already-cancelled order', async () => {
      (orderRepository as any).__setOrder({ ...baseOrder(), status: OrderStatus.CANCELLED });

      await expect(
        service.forceUpdateStatus(ORG_ID, 'order-1', { status: OrderStatus.OPEN, reason: 'x' } as any, user),
      ).rejects.toThrow();
    });

    it('flips the status and writes an audit entry with before/after', async () => {
      const result = await service.forceUpdateStatus(
        ORG_ID,
        'order-1',
        { status: OrderStatus.READY, reason: reasonDto.reason } as any,
        user,
      );

      expect(result.status).toBe(OrderStatus.READY);
      expect(orderAuditLogRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: OrderAuditAction.FORCE_UPDATE_STATUS,
          reason: reasonDto.reason,
          details: { before: { status: OrderStatus.OPEN }, after: { status: OrderStatus.READY } },
        }),
      );
    });
  });
});
