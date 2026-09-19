import { PaymentsService } from './payments.service';
import { PaymentMethod, PaymentTransactionStatus } from '../../database/entities/payment.entity';
import { PaymentStatus } from '../../database/entities/order.entity';

describe('PaymentsService — TSE hook in create()', () => {
  let paymentRepository: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock };
  let orderRepository: { findOne: jest.Mock; save: jest.Mock };
  let orderItemRepository: { save: jest.Mock };
  let orderItemPaymentRepository: {};
  let userOrganizationRepository: { findOne: jest.Mock };
  let organizationRepository: { findOne: jest.Mock };
  let orderPrintService: { handlePaymentReceived: jest.Mock };
  let tseService: { recordTransaction: jest.Mock; reverseTransaction: jest.Mock };
  let receiptPdfService: { generateReceiptPdf: jest.Mock; generateBewirtungsbelegPdf: jest.Mock };
  let emailService: { sendReceiptEmail: jest.Mock };
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
    orderItemPaymentRepository = {};
    userOrganizationRepository = { findOne: jest.fn().mockResolvedValue({ id: 'membership-1' }) };
    organizationRepository = { findOne: jest.fn().mockResolvedValue({ id: ORG_ID, name: 'Org', settings: {} }) };
    orderPrintService = { handlePaymentReceived: jest.fn().mockResolvedValue(undefined) };
    tseService = { recordTransaction: jest.fn(), reverseTransaction: jest.fn() };
    receiptPdfService = { generateReceiptPdf: jest.fn(), generateBewirtungsbelegPdf: jest.fn() };
    emailService = { sendReceiptEmail: jest.fn() };

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

    it('never lets a TSE outage on the reversal block the refund from completing', async () => {
      tseService.reverseTransaction.mockRejectedValue(new Error('TSE server unreachable'));

      const result = await service.refund(ORG_ID, 'payment-1', user);

      expect(result).toBeDefined();
    });
  });
});
