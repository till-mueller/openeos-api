import { ForbiddenException, Logger } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentMethod, PaymentTransactionStatus } from '../../database/entities/payment.entity';
import { PaymentStatus } from '../../database/entities/order.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { OrderAuditAction } from '../../database/entities/order-audit-log.entity';

describe('PaymentsService — TSE hook in create()', () => {
  let paymentRepository: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock };
  let orderRepository: { findOne: jest.Mock; save: jest.Mock };
  let orderItemRepository: { save: jest.Mock };
  let orderItemPaymentRepository: { create: jest.Mock; save: jest.Mock };
  let userOrganizationRepository: { findOne: jest.Mock };
  let organizationRepository: { findOne: jest.Mock };
  let orderPrintService: { handlePaymentReceived: jest.Mock };
  let tseService: { recordTransaction: jest.Mock; reverseTransaction: jest.Mock };
  let receiptPdfService: { generateReceiptPdf: jest.Mock; generateBewirtungsbelegPdf: jest.Mock };
  let emailService: { sendReceiptEmail: jest.Mock };
  let orderAuditLogRepository: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock };
  let jwtService: { signAsync: jest.Mock; verifyAsync: jest.Mock };
  let configService: { get: jest.Mock };
  let service: PaymentsService;

  const ORG_ID = 'org-1';
  const user = { id: 'user-1' } as any;

  const baseOrder = () => ({
    id: 'order-1',
    organizationId: ORG_ID,
    orderNumber: 'A-1',
    total: 100,
    paidAmount: 0,
    paymentStatus: PaymentStatus.UNPAID,
    createdByDeviceId: 'device-1',
    items: [],
  });

  const createDto = { orderId: 'order-1', amount: 20, paymentMethod: PaymentMethod.CASH } as any;

  beforeEach(() => {
    paymentRepository = {
      create: jest.fn((dto) => ({ ...dto, id: 'payment-1' })),
      save: jest.fn(async (p) => p),
      // create() ends by calling this.findOne(...) to return the fresh row —
      // stub it so the happy path resolves; overridden by individual tests as needed.
      findOne: jest.fn().mockImplementation(async () => ({
        id: 'payment-1',
        order: { organizationId: ORG_ID },
      })),
    };
    orderRepository = { findOne: jest.fn(), save: jest.fn(async (o) => o) };
    orderItemRepository = { save: jest.fn() };
    orderItemPaymentRepository = {
      create: jest.fn((dto) => dto),
      save: jest.fn(async (p) => p),
    };
    userOrganizationRepository = { findOne: jest.fn().mockResolvedValue({ id: 'membership-1' }) };
    organizationRepository = { findOne: jest.fn().mockResolvedValue({ id: ORG_ID, name: 'Org', settings: {} }) };
    orderPrintService = { handlePaymentReceived: jest.fn().mockResolvedValue(undefined) };
    tseService = { recordTransaction: jest.fn(), reverseTransaction: jest.fn() };
    receiptPdfService = { generateReceiptPdf: jest.fn(), generateBewirtungsbelegPdf: jest.fn() };
    emailService = { sendReceiptEmail: jest.fn() };
    orderAuditLogRepository = { create: jest.fn((d) => ({ ...d, id: 'audit-1' })), save: jest.fn(async (l) => l), findOne: jest.fn() };
    jwtService = { signAsync: jest.fn().mockResolvedValue('signed-token'), verifyAsync: jest.fn() };
    configService = { get: jest.fn() };

    service = new PaymentsService(
      paymentRepository as any,
      orderRepository as any,
      orderItemRepository as any,
      orderItemPaymentRepository as any,
      userOrganizationRepository as any,
      organizationRepository as any,
      orderPrintService as any,
      tseService as any,
      receiptPdfService as any,
      emailService as any,
      orderAuditLogRepository as any,
      jwtService as any,
      configService as any,
    );
  });

  it('signs the payment through TSE, persists tseData, and includes it in the print payload', async () => {
    orderRepository.findOne.mockResolvedValue(baseOrder());
    tseService.recordTransaction.mockResolvedValue({
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
      failed: false,
    });

    await service.create(ORG_ID, createDto, user);

    expect(tseService.recordTransaction).toHaveBeenCalledWith(
      ORG_ID,
      'device-1',
      expect.objectContaining({ amount: 20, paymentMethod: PaymentMethod.CASH }),
    );
    // Saved once on creation, again once the TSE signature is attached.
    expect(paymentRepository.save).toHaveBeenCalledTimes(2);
    const savedWithTse = paymentRepository.save.mock.calls[1][0];
    expect(savedWithTse.tseData).toEqual(expect.objectContaining({ signatureValue: 'sig' }));

    expect(orderPrintService.handlePaymentReceived).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({ tseData: expect.objectContaining({ signatureValue: 'sig' }) }),
    );
  });

  it('is a no-op when TSE is not configured for the org', async () => {
    orderRepository.findOne.mockResolvedValue(baseOrder());
    tseService.recordTransaction.mockResolvedValue(null);

    await service.create(ORG_ID, createDto, user);

    // Only the initial create-time save — no second save for tseData.
    expect(paymentRepository.save).toHaveBeenCalledTimes(1);
    expect(orderPrintService.handlePaymentReceived).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({ tseData: undefined }),
    );
  });

  it('never lets a TSE outage block payment creation', async () => {
    orderRepository.findOne.mockResolvedValue(baseOrder());
    tseService.recordTransaction.mockRejectedValue(new Error('TSE server unreachable'));

    const result = await service.create(ORG_ID, createDto, user);

    expect(result).toBeDefined();
    expect(orderPrintService.handlePaymentReceived).toHaveBeenCalled();
    // No second save attempted — recordTransaction rejected before any tseData existed.
    expect(paymentRepository.save).toHaveBeenCalledTimes(1);
  });

  it('signs using the org-wide client (null device) when the order has no creating device', async () => {
    orderRepository.findOne.mockResolvedValue({ ...baseOrder(), createdByDeviceId: null });
    tseService.recordTransaction.mockResolvedValue(null);

    await service.create(ORG_ID, createDto, user);

    expect(tseService.recordTransaction).toHaveBeenCalledWith(ORG_ID, null, expect.anything());
  });

  describe('VAT splits', () => {
    // 2x item@10.00 (19%) + 1x item@5.00 (7%) — total 25.00.
    const ratedOrder = () => ({
      ...baseOrder(),
      total: 25,
      items: [
        { id: 'item-1', quantity: 2, unitPrice: 10, optionsPrice: 0, taxRate: 19, paidQuantity: 0 },
        { id: 'item-2', quantity: 1, unitPrice: 5, optionsPrice: 0, taxRate: 7, paidQuantity: 0 },
      ],
    });

    it('signs cash payments with per-rate VAT splits', async () => {
      orderRepository.findOne.mockResolvedValue(ratedOrder());
      tseService.recordTransaction.mockResolvedValue(null);

      await service.create(
        ORG_ID,
        { orderId: 'order-1', amount: 25, paymentMethod: PaymentMethod.CASH } as any,
        user,
      );

      expect(tseService.recordTransaction).toHaveBeenCalledWith(
        ORG_ID,
        'device-1',
        expect.objectContaining({
          amount: 25,
          paymentMethod: PaymentMethod.CASH,
          vatSplits: [
            { rate: 19, grossAmount: 20 },
            { rate: 7, grossAmount: 5 },
          ],
        }),
      );
    });

    it('allocates partial payments proportionally', async () => {
      orderRepository.findOne.mockResolvedValue(ratedOrder());
      tseService.recordTransaction.mockResolvedValue(null);

      await service.create(
        ORG_ID,
        { orderId: 'order-1', amount: 12.5, paymentMethod: PaymentMethod.CASH } as any,
        user,
      );

      const input = tseService.recordTransaction.mock.calls[0][2];
      expect(input.amount).toBe(12.5);
      // Splits scale so their sum matches the 12.50 payment exactly.
      expect(input.vatSplits).toEqual([
        { rate: 19, grossAmount: 10 },
        { rate: 7, grossAmount: 2.5 },
      ]);
    });

    it('signs split payments with item-exact splits for the rows just paid', async () => {
      orderRepository.findOne.mockResolvedValue(ratedOrder());
      tseService.recordTransaction.mockResolvedValue(null);

      // Paying only 1x item-1 (@10, 19%): item-exact is [{19, 10}] — the
      // whole-order-proportional fallback would wrongly add a 7% line.
      await service.createSplitPayment(
        ORG_ID,
        {
          orderId: 'order-1',
          amount: 10,
          paymentMethod: PaymentMethod.CASH,
          items: [{ orderItemId: 'item-1', quantity: 1 }],
        } as any,
        user,
      );

      expect(tseService.recordTransaction).toHaveBeenCalledWith(
        ORG_ID,
        'device-1',
        expect.objectContaining({
          amount: 10,
          vatSplits: [{ rate: 19, grossAmount: 10 }],
        }),
      );
    });
  });

  describe('bewirtungsbelegRequested', () => {
    it('sets the flag on the order when the checkout toggle is passed', async () => {
      orderRepository.findOne.mockResolvedValue(baseOrder());
      tseService.recordTransaction.mockResolvedValue(null);

      await service.create(ORG_ID, { ...createDto, bewirtungsbelegRequested: true }, user);

      const savedOrder = orderRepository.save.mock.calls[0][0];
      expect(savedOrder.bewirtungsbelegRequested).toBe(true);
    });

    it('leaves the flag untouched (does not reset to false) when a later payment omits it', async () => {
      orderRepository.findOne.mockResolvedValue({ ...baseOrder(), bewirtungsbelegRequested: true });
      tseService.recordTransaction.mockResolvedValue(null);

      await service.create(ORG_ID, createDto, user);

      const savedOrder = orderRepository.save.mock.calls[0][0];
      expect(savedOrder.bewirtungsbelegRequested).toBe(true);
    });

    it('leaves the flag false when never requested', async () => {
      orderRepository.findOne.mockResolvedValue(baseOrder());
      tseService.recordTransaction.mockResolvedValue(null);

      await service.create(ORG_ID, createDto, user);

      const savedOrder = orderRepository.save.mock.calls[0][0];
      expect(savedOrder.bewirtungsbelegRequested).toBeFalsy();
    });
  });

  describe('refund', () => {
    const capturedPayment = () => ({
      id: 'payment-1',
      orderId: 'order-1',
      amount: 20,
      paymentMethod: PaymentMethod.CASH,
      paymentProvider: 'CASH',
      status: PaymentTransactionStatus.CAPTURED,
      itemPayments: [],
      order: { organizationId: ORG_ID },
    });

    beforeEach(() => {
      // refund() calls this.findOne() internally, both to fetch the payment
      // to refund and again at the end to return the fresh row -- same stub
      // serves both.
      paymentRepository.findOne.mockImplementation(async () => capturedPayment());
      orderRepository.findOne.mockResolvedValue(baseOrder());
    });

    it('never mutates the original payment\'s amount/status beyond REFUNDED -- creates a separate reversal row instead', async () => {
      tseService.reverseTransaction.mockResolvedValue({
        provider: 'fiskaly',
        clientId: 'device-1',
        transactionNumber: 2,
        serialNumber: 'SN',
        signatureCounter: 2,
        signatureValue: 'sig-reversal',
        signatureAlgorithm: 'algo',
        startTime: 't0',
        endTime: 't1',
        processType: 'Kassenbeleg-V1',
        processData: '',
        qrCodeData: 'qr',
        failed: false,
      });

      await service.refund(ORG_ID, 'payment-1', user);

      // First save: the original payment, flipped to REFUNDED, same amount.
      const originalSave = paymentRepository.save.mock.calls[0][0];
      expect(originalSave.status).toBe(PaymentTransactionStatus.REFUNDED);
      expect(originalSave.amount).toBe(20);

      // A genuinely new row was created for the reversal, not a mutation.
      expect(paymentRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: 'order-1',
          amount: -20,
          reversesPaymentId: 'payment-1',
          status: PaymentTransactionStatus.CAPTURED,
        }),
      );
    });

    it('signs the reversal through the TSE with the amount negated', async () => {
      tseService.reverseTransaction.mockResolvedValue(null);

      await service.refund(ORG_ID, 'payment-1', user);

      expect(tseService.reverseTransaction).toHaveBeenCalledWith(
        ORG_ID,
        'device-1',
        expect.objectContaining({ amount: 20, paymentMethod: PaymentMethod.CASH }),
      );
    });

    it('reversal negates the original stored splits', async () => {
      paymentRepository.findOne.mockImplementation(async () => ({
        ...capturedPayment(),
        amount: 25,
        tseData: {
          vatSplits: [
            { rate: 19, grossAmount: 20 },
            { rate: 7, grossAmount: 5 },
          ],
        },
      }));
      tseService.reverseTransaction.mockResolvedValue(null);

      await service.refund(ORG_ID, 'payment-1', user);

      expect(tseService.reverseTransaction).toHaveBeenCalledWith(
        ORG_ID,
        'device-1',
        expect.objectContaining({
          amount: 25,
          vatSplits: [
            { rate: 19, grossAmount: -20 },
            { rate: 7, grossAmount: -5 },
          ],
        }),
      );
    });

    it('reversal falls back to a proportional recompute with negative amount when nothing was stored', async () => {
      // Same 2x10@19% + 1x5@7% order; original payment (20) has no tseData.
      orderRepository.findOne.mockResolvedValue({
        ...baseOrder(),
        total: 25,
        items: [
          { id: 'item-1', quantity: 2, unitPrice: 10, optionsPrice: 0, taxRate: 19, paidQuantity: 0 },
          { id: 'item-2', quantity: 1, unitPrice: 5, optionsPrice: 0, taxRate: 7, paidQuantity: 0 },
        ],
      });
      tseService.reverseTransaction.mockResolvedValue(null);

      await service.refund(ORG_ID, 'payment-1', user);

      expect(tseService.reverseTransaction).toHaveBeenCalledWith(
        ORG_ID,
        'device-1',
        expect.objectContaining({
          amount: 20,
          vatSplits: [
            { rate: 19, grossAmount: -16 },
            { rate: 7, grossAmount: -4 },
          ],
        }),
      );
    });

    it('never lets a TSE outage on the reversal block the refund from completing', async () => {
      tseService.reverseTransaction.mockRejectedValue(new Error('TSE server unreachable'));

      const result = await service.refund(ORG_ID, 'payment-1', user);

      expect(result).toBeDefined();
    });
  });

  describe('forceRefund', () => {
    const capturedPayment = () => ({
      id: 'payment-1',
      orderId: 'order-1',
      amount: 20,
      paymentMethod: PaymentMethod.CASH,
      paymentProvider: 'CASH',
      status: PaymentTransactionStatus.CAPTURED,
      itemPayments: [],
      order: { organizationId: ORG_ID },
    });
    const reasonDto = { reason: 'Kundenreklamation, manuelle Korrektur' };

    beforeEach(() => {
      paymentRepository.findOne.mockImplementation(async () => capturedPayment());
      orderRepository.findOne.mockResolvedValue(baseOrder());
      userOrganizationRepository.findOne.mockResolvedValue({ id: 'membership-1', role: OrganizationRole.ADMIN });
    });

    it('refuses a non-admin member', async () => {
      userOrganizationRepository.findOne.mockResolvedValue({ id: 'membership-1', role: OrganizationRole.MEMBER });

      await expect(service.forceRefund(ORG_ID, 'payment-1', reasonDto, user)).rejects.toBeInstanceOf(ForbiddenException);
      expect(paymentRepository.save).not.toHaveBeenCalled();
    });

    it('signs the reversal, flips the payment to REFUNDED, and writes a success audit entry', async () => {
      tseService.reverseTransaction.mockResolvedValue({
        provider: 'fiskaly',
        clientId: 'device-1',
        transactionNumber: 2,
        serialNumber: 'SN',
        signatureCounter: 2,
        signatureValue: 'sig-reversal',
        signatureAlgorithm: 'algo',
        startTime: 't0',
        endTime: 't1',
        processType: 'Kassenbeleg-V1',
        processData: '',
        qrCodeData: 'qr',
        failed: false,
      });

      await service.forceRefund(ORG_ID, 'payment-1', reasonDto, user);

      expect(paymentRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: 'order-1', amount: -20, reversesPaymentId: 'payment-1' }),
      );
      const flippedSave = paymentRepository.save.mock.calls.find((c) => c[0].status === PaymentTransactionStatus.REFUNDED);
      expect(flippedSave).toBeDefined();

      expect(orderAuditLogRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_ID,
          orderId: 'order-1',
          actorUserId: user.id,
          action: OrderAuditAction.FORCE_REFUND,
          reason: reasonDto.reason,
          details: expect.objectContaining({ after: expect.objectContaining({ status: PaymentTransactionStatus.REFUNDED }) }),
        }),
      );
    });

    it('aborts and writes a failure audit entry instead of refunding when the TSE reversal fails', async () => {
      tseService.reverseTransaction.mockResolvedValue({
        provider: 'fiskaly',
        clientId: 'device-1',
        transactionNumber: 0,
        serialNumber: '',
        signatureCounter: 0,
        signatureValue: '',
        signatureAlgorithm: '',
        startTime: 't0',
        endTime: 't1',
        processType: 'Kassenbeleg-V1',
        processData: '',
        qrCodeData: '',
        failed: true,
        failureReason: 'TSS not initialized',
        errorCode: 'TSS_NOT_INITIALIZED',
        httpStatus: 400,
        failedAt: 't0',
      });

      await expect(service.forceRefund(ORG_ID, 'payment-1', reasonDto, user)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'TSE_REVERSAL_REQUIRED' }),
      });

      // Never flips the payment to REFUNDED when the reversal was rejected.
      expect(paymentRepository.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: PaymentTransactionStatus.REFUNDED }),
      );
      expect(orderAuditLogRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: OrderAuditAction.FORCE_REFUND,
          details: expect.objectContaining({
            failure: expect.objectContaining({ errorCode: 'TSS_NOT_INITIALIZED', httpStatus: 400 }),
          }),
        }),
      );
    });
  });

  describe('signPaymentWithTse structured failure logging', () => {
    it('logs a structured context line when the TSE signing failed', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        orderRepository.findOne.mockResolvedValue(baseOrder());
        tseService.recordTransaction.mockResolvedValue({
          provider: 'fiskaly',
          clientId: 'device-1',
          transactionNumber: 0,
          serialNumber: '',
          signatureCounter: 0,
          signatureValue: '',
          signatureAlgorithm: '',
          startTime: 't0',
          endTime: 't1',
          processType: 'Kassenbeleg-V1',
          processData: '',
          qrCodeData: '',
          failed: true,
          failureReason: 'fiskaly PUT /tss/x/tx/y failed: 400 {"code":"E_TSS_CREATED"}',
          errorCode: 'TSS_NOT_INITIALIZED',
          httpStatus: 400,
          failedAt: '2026-09-20T10:00:00.000Z',
          vatSplits: [],
        });

        await service.create(ORG_ID, createDto, user);

        const calls = logSpy.mock.calls.map((c) => String(c[0]));
        const failureLine = calls.find((c) => c.includes('TSE signing failed'));
        expect(failureLine).toContain('errorCode TSS_NOT_INITIALIZED');
        expect(failureLine).toContain('httpStatus 400');
        expect(failureLine).toContain('order-1');
        expect(failureLine).toContain('payment-1');
      } finally {
        logSpy.mockRestore();
      }
    });
  });
});
