import { InvoicesService } from './invoices.service';

describe('InvoicesService', () => {
  const ORG_ID = 'org-1';

  let invoiceRepository: {
    create: jest.Mock;
    save: jest.Mock;
    query: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let organizationRepository: { findOne: jest.Mock };
  let service: InvoicesService;

  /**
   * nextValue per yearMonth — emulates the sequence maintained by the atomic
   * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING next_value - 1` statement.
   * The increment is fully synchronous so concurrent queries can never
   * interleave inside a single allocation, mirroring the DB row lock.
   */
  const counters = new Map<string, number>();

  /**
   * Replicates the production statement's observable behaviour:
   * for a fresh month the first allocation is 1; every later allocation
   * hands out the previously stored next_value and bumps it by 1.
   */
  const emulateAtomicUpsert = (sql: string, params: unknown[]) => {
    if (!String(sql).includes('ON CONFLICT')) {
      throw new Error(`unexpected query: ${sql}`);
    }
    const yearMonth = params[0] as string;
    const previous = counters.get(yearMonth) ?? 1;
    counters.set(yearMonth, previous + 1);
    return Promise.resolve([{ value: previous }]);
  };

  beforeEach(() => {
    counters.clear();
    invoiceRepository = {
      create: jest.fn((data) => ({ ...data })),
      save: jest.fn(async (invoice) => invoice),
      query: jest.fn(emulateAtomicUpsert),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      })),
    };
    organizationRepository = {
      findOne: jest.fn().mockResolvedValue({ id: ORG_ID }),
    };
    service = new InvoicesService(
      invoiceRepository as any,
      organizationRepository as any,
    );
  });

  const orderLineItem = {
    description: 'Punkt',
    quantity: 1,
    unitPrice: 10,
  };

  it('generates sequential numbers without COUNT races', async () => {
    const first = await service.createInvoice(ORG_ID, { lineItems: [orderLineItem] });
    const second = await service.createInvoice(ORG_ID, { lineItems: [orderLineItem] });

    expect(first.invoiceNumber).toMatch(/^INV-\d{6}-0001$/);
    expect(second.invoiceNumber).toMatch(/^INV-\d{6}-0002$/);

    // The allocation must go through the single atomic upsert statement,
    // never the old COUNT-behind-a-LIKE path.
    expect(invoiceRepository.query).toHaveBeenCalled();
    expect(invoiceRepository.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT'),
      [expect.stringMatching(/^\d{6}$/)],
    );
    expect(invoiceRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('never issues the same number twice under concurrency', async () => {
    const invoices = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.createInvoice(ORG_ID, { lineItems: [orderLineItem] }),
      ),
    );

    const suffixes = invoices
      .map((invoice) => Number(invoice.invoiceNumber.slice(-4)))
      .sort((a, b) => a - b);

    expect(new Set(suffixes).size).toBe(20);
    expect(suffixes).toHaveLength(20);
    // 20 distinct, contiguous numbers (0001..0020) from a single month.
    suffixes.forEach((suffix, index) => {
      expect(suffix).toBe(index + 1);
    });

    expect(invoiceRepository.createQueryBuilder).not.toHaveBeenCalled();
  });
});

export {};