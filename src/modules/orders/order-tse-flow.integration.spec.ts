/**
 * Integration test across OrdersService + PaymentsService + the REAL
 * TseService/FiskalyTseProvider -- every other spec in this codebase mocks
 * `tseService: { recordTransaction: jest.fn(), ... }` outright, which proves
 * the *callers* do the right thing but never proves the TSE signing path
 * itself (auth, transaction start/finish, vat-rate mapping, signature
 * extraction) actually works end-to-end. Here only the network boundary
 * (global.fetch) is mocked; everything from "create an order" through
 * "capture a payment" to "the fiskaly request that gets sent" is real code.
 *
 * Repositories are backed by small in-memory Maps (not jest.fn() stubs
 * returning fixed values) so state genuinely flows between the two
 * services, the same way it would via a real database: the order
 * OrdersService.create() persists is the exact row PaymentsService.create()
 * loads, mutates, and re-persists.
 */
import { OrdersService } from './orders.service';
import { PaymentsService } from '../payments/payments.service';
import { TseService } from '../tse/tse.service';
import { FiskalyTseProvider } from '../tse/providers/fiskaly-tse.provider';
import { OrderStatus, PaymentStatus as OrderPaymentStatus, OrderSource, OrderFulfillmentType } from '../../database/entities/order.entity';
import { PaymentMethod, PaymentTransactionStatus } from '../../database/entities/payment.entity';
import { EventStatus } from '../../database/entities/event.entity';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/** Routes every fiskaly call by method+path instead of a brittle exact-order
 *  mockResolvedValueOnce chain -- ensureClient + recordTransaction together
 *  issue a variable number of calls (auth is cached after the first). */
function installFiskalyFetchMock() {
  let txNumber = 0;
  const calls: { method: string; url: string }[] = [];
  const fetchMock = jest.fn(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    if (url.endsWith('/auth')) return jsonResponse({ access_token: 'jwt-token' });
    if (method === 'PUT' && url.includes('/client/')) return jsonResponse({});
    if (method === 'PUT' && url.includes('tx_revision=1')) {
      return jsonResponse({ number: txNumber, time_start: 't0', state: 'ACTIVE' });
    }
    if (method === 'PUT' && url.includes('tx_revision=2')) {
      txNumber += 1;
      return jsonResponse({
        number: txNumber,
        time_start: 't0',
        time_end: 't1',
        state: 'FINISHED',
        signature: { value: `sig-${txNumber}`, algorithm: 'ecdsa', public_key: 'pk', counter: txNumber, time: 1 },
      });
    }
    if (method === 'GET' && /\/tss\/[^/]+$/.test(url)) {
      return jsonResponse({ serial_number: 'SN-TEST-1' });
    }
    throw new Error(`unexpected fiskaly fetch: ${method} ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return calls;
}

describe('Order → payment → TSE integration (real Orders/Payments/Tse services, fiskaly configured)', () => {
  const ORG_ID = 'org-1';
  const EVENT_ID = 'event-1';
  const PRODUCT_ID = 'product-1';
  const user = { id: 'user-1' } as any;

  let ordersById: Map<string, any>;
  let itemsByOrderId: Map<string, any[]>;
  let paymentsById: Map<string, any>;
  let itemCounter: number;
  let paymentCounter: number;

  let orderRepository: any;
  let orderItemRepository: any;
  let paymentRepository: any;
  let orderItemPaymentRepository: any;

  let ordersService: OrdersService;
  let paymentsService: PaymentsService;
  let tseService: TseService;
  let fetchCalls: { method: string; url: string }[];

  const fiskalyOrg = {
    id: ORG_ID,
    name: 'Test Org',
    settings: {
      currency: 'EUR',
      tse: {
        enabled: true,
        provider: 'fiskaly' as const,
        fiskaly: { apiKey: 'key', apiSecret: 'secret', tssId: 'tss-1' },
      },
    },
  };

  beforeEach(() => {
    fetchCalls = installFiskalyFetchMock();

    ordersById = new Map();
    itemsByOrderId = new Map();
    paymentsById = new Map();
    itemCounter = 0;
    paymentCounter = 0;

    orderRepository = {
      create: jest.fn((dto: any) => ({
        id: 'order-1',
        subtotal: 0,
        taxTotal: 0,
        total: 0,
        paidAmount: 0,
        tipAmount: 0,
        pfandTotal: 0,
        ...dto,
      })),
      save: jest.fn(async (o: any) => {
        ordersById.set(o.id, o);
        return o;
      }),
      findOne: jest.fn(async ({ where }: any) => {
        const stored = ordersById.get(where.id);
        if (!stored) return null;
        if (where.organizationId && stored.organizationId !== where.organizationId) return null;
        return { ...stored, items: itemsByOrderId.get(where.id) ?? [] };
      }),
      count: jest.fn().mockResolvedValue(0),
    };

    orderItemRepository = {
      create: jest.fn((dto: any) => ({ id: `item-${++itemCounter}`, paidQuantity: 0, ...dto })),
      save: jest.fn(async (item: any) => {
        const arr = itemsByOrderId.get(item.orderId) ?? [];
        const idx = arr.findIndex((i) => i.id === item.id);
        if (idx >= 0) arr[idx] = item;
        else arr.push(item);
        itemsByOrderId.set(item.orderId, arr);
        return item;
      }),
      count: jest.fn().mockResolvedValue(0),
    };

    paymentRepository = {
      create: jest.fn((dto: any) => ({ id: `payment-${++paymentCounter}`, ...dto })),
      save: jest.fn(async (p: any) => {
        paymentsById.set(p.id, p);
        return p;
      }),
      findOne: jest.fn(async ({ where }: any) => {
        const stored = paymentsById.get(where.id);
        if (!stored) return null;
        const order = ordersById.get(stored.orderId);
        return { ...stored, order, itemPayments: [] };
      }),
      find: jest.fn(async ({ where }: any) =>
        [...paymentsById.values()].filter(
          (p) => p.orderId === where.orderId && (!where.status || p.status === where.status),
        ),
      ),
    };
    orderItemPaymentRepository = { create: jest.fn((dto: any) => dto), save: jest.fn(async (p: any) => p) };

    const productFixture = {
      id: PRODUCT_ID,
      name: 'Bier 0,5l',
      categoryId: 'cat-1',
      price: 10,
      isActive: true,
      isAvailable: true,
      trackInventory: false,
      stockQuantity: 0,
      productionStationId: null,
      pfandTypeId: null,
      pfandType: null,
    };
    const productRepository = { findOne: jest.fn().mockResolvedValue(productFixture), save: jest.fn() };
    const eventFixture = { id: EVENT_ID, organizationId: ORG_ID, status: EventStatus.ACTIVE };
    const eventRepository = { findOne: jest.fn().mockResolvedValue(eventFixture) };
    const ordersOrgRepository = { findOne: jest.fn().mockResolvedValue({ id: ORG_ID, settings: {} }) };
    const userOrganizationRepository = { findOne: jest.fn().mockResolvedValue({ id: 'membership-1' }) };
    const stockMovementRepository = { create: jest.fn(), save: jest.fn() };
    const productionStationRepository = { find: jest.fn(), findOne: jest.fn() };
    const orderAuditLogRepository = { create: jest.fn((d: any) => d), save: jest.fn(async (l: any) => l) };
    const orderPrintService = {
      handleOrderCreated: jest.fn().mockResolvedValue(undefined),
      handlePaymentReceived: jest.fn().mockResolvedValue(undefined),
    };

    // Real TseService, wired to a real FiskalyTseProvider with only
    // global.fetch mocked -- ensureClient/getAccessToken/vat-rate mapping/
    // signature extraction all run for real.
    const tseOrgRepository = { findOne: jest.fn().mockResolvedValue(fiskalyOrg) };
    const deviceRepository = { findOne: jest.fn() };
    const tseUserOrganizationRepository = { findOne: jest.fn() };
    const fiskalyProvider = new FiskalyTseProvider({ get: (_k: string, fallback?: string) => fallback } as any);
    const localProvider = {} as any;
    const platformSettingsService = { getFiskalyPlatformCredential: jest.fn() } as any;
    tseService = new TseService(
      tseOrgRepository as any,
      deviceRepository as any,
      tseUserOrganizationRepository as any,
      fiskalyProvider,
      localProvider,
      { get: jest.fn() } as any,
      platformSettingsService,
    );

    ordersService = new OrdersService(
      orderRepository,
      orderItemRepository,
      productRepository as any,
      ordersOrgRepository as any,
      userOrganizationRepository as any,
      stockMovementRepository as any,
      eventRepository as any,
      productionStationRepository as any,
      paymentRepository,
      orderPrintService as any,
      {} as any,
      {} as any,
      { get: jest.fn() } as any,
      tseService,
      orderAuditLogRepository as any,
    );

    paymentsService = new PaymentsService(
      paymentRepository,
      orderRepository,
      orderItemRepository,
      orderItemPaymentRepository,
      userOrganizationRepository as any,
      { findOne: jest.fn() } as any,
      orderPrintService as any,
      tseService,
      {} as any,
      {} as any,
      orderAuditLogRepository as any,
    );
  });

  it('creates an order, captures a payment, and gets a real fiskaly-signed TSE receipt back', async () => {
    const order = await ordersService.create(
      ORG_ID,
      {
        eventId: EVENT_ID,
        source: OrderSource.POS,
        fulfillmentType: OrderFulfillmentType.COUNTER_PICKUP,
        items: [{ productId: PRODUCT_ID, quantity: 2 }],
      } as any,
      user,
    );

    // Order math: 2x €10 @ 19% VAT, gross totalPrice already includes tax.
    expect(order.status).toBe(OrderStatus.OPEN);
    expect(order.paymentStatus).toBe(OrderPaymentStatus.UNPAID);
    expect(order.subtotal).toBe(20);
    expect(order.total).toBe(20);
    expect(order.taxTotal).toBeCloseTo(3.8, 2); // totalPrice (gross) * taxRate/100

    const payment = await paymentsService.create(
      ORG_ID,
      { orderId: order.id, amount: 20, paymentMethod: PaymentMethod.CASH } as any,
      user,
    );

    // The payment itself.
    expect(payment.status).toBe(PaymentTransactionStatus.CAPTURED);

    // The TSE actually signed it -- not mocked out, a real (fake-networked)
    // fiskaly round trip produced this.
    expect(payment.tseData).toBeDefined();
    expect(payment.tseData?.failed).toBe(false);
    expect(payment.tseData?.provider).toBe('fiskaly');
    expect(payment.tseData?.signatureValue).toBe('sig-1');
    expect(payment.tseData?.vatSplits).toEqual([{ rate: 19, grossAmount: 20 }]);

    // fetch actually went through auth -> ensureClient -> start -> finish -> GET tss.
    expect(fetchCalls.some((c) => c.url.endsWith('/auth'))).toBe(true);
    expect(fetchCalls.some((c) => c.method === 'PUT' && c.url.includes('/client/'))).toBe(true);
    expect(fetchCalls.some((c) => c.method === 'GET' && /\/tss\/[^/]+$/.test(c.url))).toBe(true);

    // Order flips to fully paid, items marked paid.
    const finalOrder = await orderRepository.findOne({ where: { id: order.id } });
    expect(finalOrder.paymentStatus).toBe(OrderPaymentStatus.PAID);
    expect(finalOrder.paidAmount).toBe(20);
    expect(finalOrder.items[0].paidQuantity).toBe(2);
  });

  it('cancelling a paid order reverses the payment through a second, separately-signed TSE transaction', async () => {
    const order = await ordersService.create(
      ORG_ID,
      {
        eventId: EVENT_ID,
        source: OrderSource.POS,
        fulfillmentType: OrderFulfillmentType.COUNTER_PICKUP,
        items: [{ productId: PRODUCT_ID, quantity: 1 }],
      } as any,
      user,
    );
    await paymentsService.create(ORG_ID, { orderId: order.id, amount: 10, paymentMethod: PaymentMethod.CASH } as any, user);

    const cancelled = await ordersService.cancelOrder(ORG_ID, order.id, { reason: 'Kunde storniert' } as any, user);

    expect(cancelled.status).toBe(OrderStatus.CANCELLED);

    const payments = await paymentRepository.find({ where: { orderId: order.id } });
    const reversal = payments.find((p: any) => p.reversesPaymentId);
    expect(reversal).toBeDefined();
    expect(reversal.amount).toBe(-10);
    expect(reversal.tseData?.failed).toBe(false);
    expect(reversal.tseData?.vatSplits).toEqual([{ rate: 19, grossAmount: -10 }]);
    // A genuinely separate, second signature -- never a mutation of the original.
    expect(reversal.tseData?.signatureValue).toBe('sig-2');
  });

  it('when fiskaly rejects the sale, the order still completes (fail-open) but tseData.failed is set with structured detail', async () => {
    global.fetch = jest.fn(async (url: string) => {
      if (url.endsWith('/auth')) return jsonResponse({ access_token: 'jwt-token' });
      return jsonResponse({ code: 'E_TSS_NOT_FOUND', message: 'tss not found' }, false, 404);
    }) as unknown as typeof fetch;

    const order = await ordersService.create(
      ORG_ID,
      {
        eventId: EVENT_ID,
        source: OrderSource.POS,
        fulfillmentType: OrderFulfillmentType.COUNTER_PICKUP,
        items: [{ productId: PRODUCT_ID, quantity: 1 }],
      } as any,
      user,
    );

    const payment = await paymentsService.create(
      ORG_ID,
      { orderId: order.id, amount: 10, paymentMethod: PaymentMethod.CASH } as any,
      user,
    );

    // Ausfall-Regelung: the sale/payment still completed...
    expect(payment.status).toBe(PaymentTransactionStatus.CAPTURED);
    const finalOrder = await orderRepository.findOne({ where: { id: order.id } });
    expect(finalOrder.paymentStatus).toBe(OrderPaymentStatus.PAID);

    // ...but the gap is provably recorded, not silently swallowed.
    expect(payment.tseData?.failed).toBe(true);
    expect(payment.tseData?.httpStatus).toBe(404);
    expect(payment.tseData?.errorCode).toBeTruthy();
    expect(payment.tseData?.failureReason).toContain('404');
  });
});
