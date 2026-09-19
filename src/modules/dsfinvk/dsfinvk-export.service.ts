import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, IsNull, Not, Repository } from 'typeorm';
import { Organization } from '../../database/entities/organization.entity';
import { Event } from '../../database/entities/event.entity';
import { Device } from '../../database/entities/device.entity';
import { Order } from '../../database/entities/order.entity';
import { OrderItemStatus } from '../../database/entities/order-item.entity';
import {
  Payment,
  PaymentTransactionStatus,
} from '../../database/entities/payment.entity';
import { UserOrganization } from '../../database/entities/user-organization.entity';
import { DsfinvkClosing } from '../../database/entities/dsfinvk-closing.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import {
  ustSchluesselFor,
  UstSchluessel,
} from '../../common/constants/dsfinvk-ust-schluessel';
import { dsfinvkTable } from './dsfinvk-schema';
import { DsfinvkRow, writeDsfinvkCsv } from './dsfinvk-csv-writer';
import {
  DsfinvkExportArchive,
  buildDsfinvkZip,
  buildDsfinvkEventZip,
} from './dsfinvk-zip-builder';
import {
  BusinessCaseLine,
  buildBusinessCaseRows,
  buildCashPerCurrencyRow,
  buildCashpointclosingRow,
  buildCashregisterRow,
  buildLocationRow,
  buildPaymentRows,
  buildVatRows,
  zahlartFor,
} from './dsfinvk-row-builders';
import {
  buildDatapaymentRow,
  buildLinesRows,
  buildLinesVatRow,
  buildReferenceRow,
  buildTransactionsRow,
  buildTransactionsVatRows,
  VatSplitLine,
} from './dsfinvk-transaction-builders';

/**
 * Assembles one real DSFinV-K export for one till (Device) within one
 * Event, covering everything since that till's last closing (or the
 * event's start, if this is its first). This is the orchestration layer on
 * top of the pure row builders in dsfinvk-row-builders.ts and
 * dsfinvk-transaction-builders.ts -- see those files for the per-table
 * mapping decisions and their caveats.
 *
 * Two deliberate v1 simplifications, not yet resolved (flag before relying
 * on this for a real audit):
 * 1. A Phase 0 reversal is represented as ONE synthetic "Storno" line at
 *    the organization's standard VAT rate, not an itemized inversion of
 *    the original order's lines. The reversed TOTAL is always correct
 *    (it's what actually nets out cashpointclosing.csv/businesscases.csv),
 *    but a reversal of a mixed-VAT-rate order will misstate the VAT split
 *    between rates, even though the grand total stays right.
 * 2. references.csv always points a reversal at the CURRENT closing's own
 *    Z_KASSE_ID/Z_NR/erstellung, even when the original order actually
 *    belongs to an earlier closing. There's no persisted mapping yet from
 *    an order's BON_ID to which closing it was exported in.
 */
@Injectable()
export class DsfinvkExportService {
  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(DsfinvkClosing)
    private readonly closingRepository: Repository<DsfinvkClosing>,
    private readonly dataSource: DataSource,
  ) {}

  async generateExport(
    organizationId: string,
    eventId: string,
    deviceId: string,
    userId: string,
  ): Promise<DsfinvkExportArchive> {
    await this.checkMembership(organizationId, userId);

    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });
    if (!organization)
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });

    const event = await this.eventRepository.findOne({
      where: { id: eventId, organizationId },
    });
    if (!event)
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Event nicht gefunden',
      });

    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, organizationId },
    });
    if (!device)
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Geraet nicht gefunden',
      });

    const lastClosing = await this.closingRepository.findOne({
      where: { deviceId },
      order: { zNr: 'DESC' },
    });
    const periodStart =
      lastClosing?.periodEnd ?? event.startDate ?? new Date(0);
    const periodEnd = new Date();

    const orders = await this.orderRepository.find({
      where: {
        organizationId,
        eventId,
        createdByDeviceId: deviceId,
        createdAt: Between(periodStart, periodEnd),
      },
      relations: ['items', 'payments', 'createdByUser'],
      order: { createdAt: 'ASC' },
    });

    const allReversals = await this.paymentRepository.find({
      where: {
        reversesPaymentId: Not(IsNull()),
        createdAt: Between(periodStart, periodEnd),
      },
      relations: ['order'],
      order: { createdAt: 'ASC' },
    });
    const reversals = allReversals.filter(
      (p) =>
        p.order?.eventId === eventId && p.order?.createdByDeviceId === deviceId,
    );

    const qualifyingOrders = orders.filter((o) =>
      o.payments.some(
        (p) =>
          p.status === PaymentTransactionStatus.CAPTURED &&
          !p.reversesPaymentId,
      ),
    );

    if (qualifyingOrders.length === 0 && reversals.length === 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Nichts zu exportieren fuer diesen Zeitraum',
      });
    }

    const erstellung = periodEnd.toISOString();
    const closing = await this.allocateClosing(
      organizationId,
      eventId,
      deviceId,
      erstellung,
      qualifyingOrders,
      reversals,
      periodStart,
      periodEnd,
    );
    const ctx = { kasseId: deviceId, erstellung, zNr: closing.zNr };
    const country = 'DE';
    const vatExempt = organization.settings.vatExempt;

    const transactionsRows: DsfinvkRow[] = [];
    const transactionsVatRows: DsfinvkRow[] = [];
    const linesRows: DsfinvkRow[] = [];
    const linesVatRows: DsfinvkRow[] = [];
    const datapaymentRows: DsfinvkRow[] = [];
    const referenceRows: DsfinvkRow[] = [];
    const businessCaseLines: BusinessCaseLine[] = [];
    const allPayments: {
      paymentMethod: Payment['paymentMethod'];
      amount: number;
    }[] = [];

    let bonNr = 0;
    for (const order of qualifyingOrders) {
      bonNr += 1;
      const capturedPayments = order.payments.filter(
        (p) =>
          p.status === PaymentTransactionStatus.CAPTURED &&
          !p.reversesPaymentId,
      );
      const umsBrutto = capturedPayments.reduce(
        (sum, p) => sum + Number(p.amount),
        0,
      );

      transactionsRows.push(
        buildTransactionsRow(ctx, {
          bonId: order.id,
          bonNr,
          isStorno: false,
          terminalId: order.createdByDeviceId,
          bonStart: order.createdAt.toISOString(),
          bonEnde: (
            order.completedAt ??
            order.cancelledAt ??
            order.createdAt
          ).toISOString(),
          bedienerId: order.createdByUserId,
          bedienerName: order.createdByUser
            ? `${order.createdByUser.firstName} ${order.createdByUser.lastName}`
            : '',
          umsBrutto,
          notiz: order.notes ?? order.cancellationReason ?? undefined,
        }),
      );

      const orderVatLines: VatSplitLine[] = [];
      for (const item of order.items) {
        const ustSchluessel = ustSchluesselFor(Number(item.taxRate), vatExempt);
        const unitGrossPrice =
          Number(item.unitPrice) + Number(item.optionsPrice);
        const isStorno = item.status === OrderItemStatus.CANCELLED;
        const rows = buildLinesRows(ctx, order.id, {
          posZeile: item.id,
          productName: item.productName,
          productId: item.productId,
          categoryId: item.categoryId,
          categoryName: item.categoryName,
          quantity: item.quantity,
          unitGrossPrice,
          taxRate: Number(item.taxRate),
          ustSchluessel,
          depositAmount: Number(item.depositAmount),
          isRefill: item.isRefill,
          isStorno,
        });
        linesRows.push(...rows);

        const productBrutto = unitGrossPrice * item.quantity;
        linesVatRows.push(
          buildLinesVatRow(
            ctx,
            order.id,
            item.id,
            ustSchluessel,
            productBrutto,
            Number(item.taxRate),
          ),
        );
        orderVatLines.push({
          ustSchluessel,
          ustSatz: Number(item.taxRate),
          brutto: productBrutto,
        });
        businessCaseLines.push({
          gvTyp: rows[0].GV_TYP as string,
          ustSchluessel,
          ustSatz: Number(item.taxRate),
          brutto: productBrutto,
        });

        if (Number(item.depositAmount) > 0 && !item.isRefill) {
          // German practice: Pfand is taxed at the standard rate regardless of the
          // deposited product's own rate. NOT independently verified against a
          // Steuerberater -- flag alongside the other UST_SCHLUESSEL notes.
          const pfandSatz = vatExempt ? 0 : 19;
          const pfandSchluessel = ustSchluesselFor(pfandSatz, vatExempt);
          const pfandBrutto = Number(item.depositAmount) * item.quantity;
          linesVatRows.push(
            buildLinesVatRow(
              ctx,
              order.id,
              `${item.id}-pfand`,
              pfandSchluessel,
              pfandBrutto,
              pfandSatz,
            ),
          );
          orderVatLines.push({
            ustSchluessel: pfandSchluessel,
            ustSatz: pfandSatz,
            brutto: pfandBrutto,
          });
          businessCaseLines.push({
            gvTyp: rows[1].GV_TYP as string,
            ustSchluessel: pfandSchluessel,
            ustSatz: pfandSatz,
            brutto: pfandBrutto,
          });
        }
      }
      transactionsVatRows.push(
        ...buildTransactionsVatRows(ctx, order.id, orderVatLines),
      );

      for (const payment of capturedPayments) {
        const { typ, name } = zahlartFor(payment.paymentMethod);
        datapaymentRows.push(
          buildDatapaymentRow(
            ctx,
            order.id,
            {
              paymentMethod: payment.paymentMethod,
              amount: Number(payment.amount),
            },
            typ,
            name,
          ),
        );
        allPayments.push({
          paymentMethod: payment.paymentMethod,
          amount: Number(payment.amount),
        });
      }
    }

    for (const reversal of reversals) {
      bonNr += 1;
      const amount = Number(reversal.amount);
      transactionsRows.push(
        buildTransactionsRow(ctx, {
          bonId: reversal.id,
          bonNr,
          isStorno: true,
          terminalId: reversal.order?.createdByDeviceId ?? deviceId,
          bonStart: reversal.createdAt.toISOString(),
          bonEnde: reversal.createdAt.toISOString(),
          bedienerId: null,
          bedienerName: '',
          umsBrutto: amount,
          notiz: 'Storno',
        }),
      );

      const ustSatz = vatExempt ? 0 : 19;
      const ustSchluessel = ustSchluesselFor(ustSatz, vatExempt);
      linesRows.push(
        ...buildLinesRows(ctx, reversal.id, {
          posZeile: '1',
          productName: 'Storno',
          productId: '',
          categoryId: '',
          categoryName: '',
          quantity: 1,
          unitGrossPrice: amount,
          taxRate: ustSatz,
          ustSchluessel,
          depositAmount: 0,
          isRefill: false,
          isStorno: true,
        }),
      );
      linesVatRows.push(
        buildLinesVatRow(ctx, reversal.id, '1', ustSchluessel, amount, ustSatz),
      );
      transactionsVatRows.push(
        ...buildTransactionsVatRows(ctx, reversal.id, [
          { ustSchluessel, ustSatz, brutto: amount },
        ]),
      );
      businessCaseLines.push({
        gvTyp: 'Umsatz',
        ustSchluessel,
        ustSatz,
        brutto: amount,
      });

      const { typ, name } = zahlartFor(reversal.paymentMethod);
      datapaymentRows.push(
        buildDatapaymentRow(
          ctx,
          reversal.id,
          { paymentMethod: reversal.paymentMethod, amount },
          typ,
          name,
        ),
      );
      allPayments.push({ paymentMethod: reversal.paymentMethod, amount });

      referenceRows.push(
        buildReferenceRow(ctx, reversal.id, {
          bonId: reversal.orderId,
          kasseId: ctx.kasseId,
          zNr: ctx.zNr,
          erstellung: ctx.erstellung,
        }),
      );
    }

    const closingRow = buildCashpointclosingRow(ctx, organization, {
      startBonId: closing.startBonId,
      endBonId: closing.endBonId,
      bookingDay: periodEnd.toISOString().slice(0, 10),
      payments: allPayments,
    });

    const csvFiles: Record<string, string> = {
      'cashpointclosing.csv': writeDsfinvkCsv(
        dsfinvkTable('cashpointclosing.csv'),
        [closingRow],
      ),
      'location.csv': writeDsfinvkCsv(dsfinvkTable('location.csv'), [
        buildLocationRow(ctx, organization),
      ]),
      'cashregister.csv': writeDsfinvkCsv(dsfinvkTable('cashregister.csv'), [
        buildCashregisterRow(ctx, device),
      ]),
      'vat.csv': writeDsfinvkCsv(
        dsfinvkTable('vat.csv'),
        buildVatRows(ctx, organization, country),
      ),
      'businesscases.csv': writeDsfinvkCsv(
        dsfinvkTable('businesscases.csv'),
        buildBusinessCaseRows(ctx, businessCaseLines),
      ),
      'payment.csv': writeDsfinvkCsv(
        dsfinvkTable('payment.csv'),
        buildPaymentRows(ctx, allPayments),
      ),
      'cash_per_currency.csv': writeDsfinvkCsv(
        dsfinvkTable('cash_per_currency.csv'),
        [buildCashPerCurrencyRow(ctx, allPayments)],
      ),
      'transactions.csv': writeDsfinvkCsv(
        dsfinvkTable('transactions.csv'),
        transactionsRows,
      ),
      'transactions_vat.csv': writeDsfinvkCsv(
        dsfinvkTable('transactions_vat.csv'),
        transactionsVatRows,
      ),
      'datapayment.csv': writeDsfinvkCsv(
        dsfinvkTable('datapayment.csv'),
        datapaymentRows,
      ),
      'lines.csv': writeDsfinvkCsv(dsfinvkTable('lines.csv'), linesRows),
      'lines_vat.csv': writeDsfinvkCsv(
        dsfinvkTable('lines_vat.csv'),
        linesVatRows,
      ),
      'references.csv': writeDsfinvkCsv(
        dsfinvkTable('references.csv'),
        referenceRows,
      ),
    };

    const filename = `dsfinvk-${event.name.replace(/[^a-z0-9]+/gi, '-')}-${device.name.replace(/[^a-z0-9]+/gi, '-')}-z${closing.zNr}.zip`;
    return buildDsfinvkZip(csvFiles, filename);
  }

  /**
   * One click for every till: loops generateExport() over every device
   * that has orders in this event, and packages the resulting per-till
   * ZIPs into one outer ZIP. Each inner export still gets its own atomic
   * Z_NR allocation exactly as if it were called individually -- this is
   * a convenience wrapper, not a different code path, so a partial
   * failure on one till doesn't cost the others their allocation.
   */
  async generateEventExport(
    organizationId: string,
    eventId: string,
    userId: string,
  ): Promise<DsfinvkExportArchive> {
    await this.checkMembership(organizationId, userId);

    const event = await this.eventRepository.findOne({
      where: { id: eventId, organizationId },
    });
    if (!event)
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Event nicht gefunden',
      });

    const deviceRows = await this.orderRepository
      .createQueryBuilder('order')
      .select('DISTINCT order.createdByDeviceId', 'deviceId')
      .where('order.organizationId = :organizationId', { organizationId })
      .andWhere('order.eventId = :eventId', { eventId })
      .andWhere('order.createdByDeviceId IS NOT NULL')
      .getRawMany<{ deviceId: string }>();

    if (deviceRows.length === 0)
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Fuer dieses Event liegen keine Bestellungen mit Kassen-Zuordnung vor',
      });

    const archives: DsfinvkExportArchive[] = [];
    for (const { deviceId } of deviceRows) {
      try {
        archives.push(
          await this.generateExport(organizationId, eventId, deviceId, userId),
        );
      } catch (error) {
        // "Nothing to export" for this one till (e.g. no captured payments
        // since its last closing) shouldn't sink the other tills' exports.
        // Any other failure (device gone, DB error) should still surface.
        if (error instanceof BadRequestException) continue;
        throw error;
      }
    }

    if (archives.length === 0)
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Nichts zu exportieren fuer dieses Event',
      });

    const filename = `dsfinvk-${event.name.replace(/[^a-z0-9]+/gi, '-')}-alle-kassen.zip`;
    return buildDsfinvkEventZip(archives, filename);
  }

  private async allocateClosing(
    organizationId: string,
    eventId: string,
    deviceId: string,
    erstellung: string,
    qualifyingOrders: Order[],
    reversals: Payment[],
    periodStart: Date,
    periodEnd: Date,
  ): Promise<DsfinvkClosing> {
    const bonIds = [
      ...qualifyingOrders.map((o) => o.id),
      ...reversals.map((r) => r.id),
    ];
    const startBonId = bonIds[0];
    const endBonId = bonIds[bonIds.length - 1];

    // Atomic: the next Z_NR is computed and inserted in one statement, so a
    // concurrent export for the same device either gets a genuinely
    // different number or fails the UNIQUE(device_id, z_nr) constraint --
    // it can never silently duplicate one.
    //
    // dataSource.query() is a raw driver call, not a Repository/QueryBuilder
    // read -- it does NOT go through TypeORM's entity metadata, so the
    // returned row has the table's actual (snake_case) column names, not
    // the entity's camelCase property names. Mapping explicitly here so
    // every caller of this method can trust it really returns a
    // DsfinvkClosing, not a same-shaped-looking row with undefined zNr.
    interface DsfinvkClosingRow {
      id: string;
      organization_id: string;
      event_id: string;
      device_id: string;
      z_nr: number;
      erstellung: string;
      start_bon_id: string;
      end_bon_id: string;
      period_start: Date;
      period_end: Date;
      created_at: Date;
      updated_at: Date;
    }
    const rows: DsfinvkClosingRow[] = await this.dataSource.query(
      `INSERT INTO dsfinvk_closings
         (organization_id, event_id, device_id, z_nr, erstellung, start_bon_id, end_bon_id, period_start, period_end)
       VALUES ($1, $2, $3, (SELECT COALESCE(MAX(z_nr), 0) + 1 FROM dsfinvk_closings WHERE device_id = $3), $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        organizationId,
        eventId,
        deviceId,
        erstellung,
        startBonId,
        endBonId,
        periodStart,
        periodEnd,
      ],
    );
    const row = rows[0];
    return {
      id: row.id,
      organizationId: row.organization_id,
      eventId: row.event_id,
      deviceId: row.device_id,
      zNr: row.z_nr,
      erstellung: row.erstellung,
      startBonId: row.start_bon_id,
      endBonId: row.end_bon_id,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } as DsfinvkClosing;
  }

  private async checkMembership(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId },
    });
    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Kein Zugriff auf diese Organisation',
      });
    }
  }
}
