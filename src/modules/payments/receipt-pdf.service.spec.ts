import { ReceiptPdfService } from './receipt-pdf.service';
import {
  Order,
  OrderItem,
  Organization,
  Payment,
  PaymentMethod,
  PaymentTransactionStatus,
} from '../../database/entities';

describe('ReceiptPdfService', () => {
  const service = new ReceiptPdfService();

  const organization = {
    id: 'org-1',
    name: 'Verein e.V.',
    settings: {
      address: {
        street: 'Hauptstr. 1',
        city: 'Berlin',
        zip: '10115',
        country: 'DE',
      },
      taxId: 'DE123456789',
    },
  } as unknown as Organization;

  const items = [
    {
      id: 'item-1',
      productName: 'Bier',
      quantity: 2,
      unitPrice: 3,
      optionsPrice: 0,
      totalPrice: 6,
      taxRate: 19,
      depositAmount: 2,
      notes: null,
      options: { selected: [] },
    } as unknown as OrderItem,
    {
      id: 'item-2',
      productName: 'Apfelsaft',
      quantity: 1,
      unitPrice: 2.5,
      optionsPrice: 0,
      totalPrice: 2.5,
      taxRate: 7,
      depositAmount: 0,
      notes: null,
      options: { selected: [] },
    } as unknown as OrderItem,
  ];

  const order = {
    id: 'order-1',
    orderNumber: 'A-1',
    subtotal: 8.5,
    discountAmount: 0,
    pfandTotal: 4,
    taxTotal: 1.14,
    total: 12.5,
    tableNumber: '5',
    createdAt: new Date('2026-09-19T10:00:00Z'),
    items,
    event: { name: 'Sommerfest' },
    createdByUser: { firstName: 'Anna', lastName: 'Muster' },
  } as unknown as Order;

  const payment = {
    id: 'payment-1',
    amount: 12.5,
    paymentMethod: PaymentMethod.CASH,
    status: PaymentTransactionStatus.CAPTURED,
    reversesPaymentId: null,
    tseData: null,
  } as unknown as Payment;

  it('generates a non-empty PDF for a plain sale', async () => {
    const pdf = await service.generateReceiptPdf(payment, order, organization);
    expect(pdf.length).toBeGreaterThan(0);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('generates a PDF for a reversal payment without throwing', async () => {
    const reversal = {
      ...payment,
      id: 'payment-2',
      amount: -12.5,
      reversesPaymentId: 'payment-1',
    } as unknown as Payment;
    const pdf = await service.generateReceiptPdf(reversal, order, organization);
    expect(pdf.length).toBeGreaterThan(0);
  });

  it('handles a null organization gracefully', async () => {
    const pdf = await service.generateReceiptPdf(payment, order, null);
    expect(pdf.length).toBeGreaterThan(0);
  });

  it('handles TSE data, including a failed signature, without throwing', async () => {
    const withTse = {
      ...payment,
      tseData: {
        provider: 'fiskaly',
        clientId: 'device-1',
        transactionNumber: 1,
        serialNumber: 'SN',
        signatureCounter: 1,
        signatureValue: 'sig',
        signatureAlgorithm: 'algo',
        startTime: '2026-09-19T10:00:00Z',
        endTime: '2026-09-19T10:00:01Z',
        processType: 'Kassenbeleg-V1',
        processData: '',
        qrCodeData: 'qr-payload',
        failed: false,
      },
    } as unknown as Payment;
    const pdf = await service.generateReceiptPdf(withTse, order, organization);
    expect(pdf.length).toBeGreaterThan(0);

    const failedTse = {
      ...withTse,
      tseData: { ...withTse.tseData, failed: true },
    } as unknown as Payment;
    const pdfFailed = await service.generateReceiptPdf(
      failedTse,
      order,
      organization,
    );
    expect(pdfFailed.length).toBeGreaterThan(0);
  });
});

describe('ReceiptPdfService.generateBewirtungsbelegPdf', () => {
  const service = new ReceiptPdfService();

  const organization = {
    id: 'org-1',
    name: 'Verein e.V.',
    settings: {
      address: {
        street: 'Hauptstr. 1',
        city: 'Berlin',
        zip: '10115',
        country: 'DE',
      },
      taxId: 'DE123456789',
    },
  } as unknown as Organization;

  const order = {
    id: 'order-1',
    orderNumber: 'A-1',
    subtotal: 8.5,
    discountAmount: 0,
    pfandTotal: 0,
    taxTotal: 1.14,
    total: 8.5,
    tipAmount: 0,
    createdAt: new Date('2026-09-19T10:00:00Z'),
    items: [
      {
        id: 'item-1',
        productName: 'Bier',
        quantity: 2,
        unitPrice: 4.25,
        optionsPrice: 0,
        totalPrice: 8.5,
        taxRate: 19,
        depositAmount: 0,
        notes: null,
        options: { selected: [] },
      } as unknown as OrderItem,
    ],
  } as unknown as Order;

  const payment = {
    id: 'payment-1',
    amount: 8.5,
    paymentMethod: PaymentMethod.CASH,
    status: PaymentTransactionStatus.CAPTURED,
    reversesPaymentId: null,
    tseData: null,
  } as unknown as Payment;

  it('generates a valid, non-empty PDF', async () => {
    const pdf = await service.generateBewirtungsbelegPdf(
      payment,
      order,
      organization,
    );
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(0);
  });

  it('does not throw when the order has a tip', async () => {
    const withTip = { ...order, tipAmount: 2 } as unknown as Order;
    const pdf = await service.generateBewirtungsbelegPdf(
      payment,
      withTip,
      organization,
    );
    expect(pdf.length).toBeGreaterThan(0);
  });

  it('handles a null organization gracefully', async () => {
    const pdf = await service.generateBewirtungsbelegPdf(payment, order, null);
    expect(pdf.length).toBeGreaterThan(0);
  });
});
