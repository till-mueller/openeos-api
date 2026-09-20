import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Payment,
  Order,
  OrderItem,
  OrderItemPayment,
  OrderAuditLog,
  User,
  UserOrganization,
  Organization,
} from '../../database/entities';
import {
  PaymentMethod,
  PaymentProvider,
  PaymentTransactionStatus,
} from '../../database/entities/payment.entity';
import { PaymentStatus } from '../../database/entities/order.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { OrderAuditAction } from '../../database/entities/order-audit-log.entity';
import { ErrorCodes, ErrorMessages } from '../../common/constants/error-codes';
import {
  PaginatedResult,
  createPaginatedResult,
} from '../../common/dto/pagination.dto';
import { CreatePaymentDto, SplitPaymentDto, QueryPaymentsDto, ForceRefundPaymentDto } from './dto';
import { OrderPrintService } from '../print-jobs/order-print.service';
import { TseService } from '../tse/tse.service';
import { ReceiptPdfService } from './receipt-pdf.service';
import { EmailService } from '../email/email.service';
import {
  splitsFromItems,
  allocateToAmount,
  negateSplits,
} from './vat-split';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepository: Repository<OrderItem>,
    @InjectRepository(OrderItemPayment)
    private readonly orderItemPaymentRepository: Repository<OrderItemPayment>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    private readonly orderPrintService: OrderPrintService,
    private readonly tseService: TseService,
    private readonly receiptPdfService: ReceiptPdfService,
    private readonly emailService: EmailService,
    @InjectRepository(OrderAuditLog)
    private readonly orderAuditLogRepository: Repository<OrderAuditLog>,
  ) {}

  /**
   * Loads a payment (with its order + items) for receipt rendering. Works
   * regardless of the org's receipt-printing setting or whether any printer
   * is configured at all -- printing and viewing/emailing a receipt are
   * deliberately independent from here on. An admin can always see what a
   * customer was (or wasn't) handed.
   */
  private async getPaymentForReceipt(
    organizationId: string,
    paymentId: string,
    user: User,
  ): Promise<{
    payment: Payment;
    order: Order;
    organization: Organization | null;
  }> {
    await this.checkMembership(organizationId, user.id);

    const payment = await this.paymentRepository.findOne({
      where: { id: paymentId },
      relations: ['order', 'order.items', 'order.event', 'order.createdByUser'],
    });
    if (!payment || payment.order.organizationId !== organizationId) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Zahlung nicht gefunden',
      });
    }

    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });

    return { payment, order: payment.order, organization };
  }

  async getReceiptPdf(
    organizationId: string,
    paymentId: string,
    user: User,
  ): Promise<{ data: Buffer; filename: string }> {
    const { payment, order, organization } = await this.getPaymentForReceipt(
      organizationId,
      paymentId,
      user,
    );
    const data = await this.receiptPdfService.generateReceiptPdf(
      payment,
      order,
      organization,
    );
    return { data, filename: `beleg-${order.orderNumber}.pdf` };
  }

  /**
   * Ad-hoc email, not tied to any stored customer address -- Order has no
   * customerEmail field, and this deliberately doesn't add one. Whoever is
   * sending it (staff/admin) types the address at send time.
   */
  async emailReceipt(
    organizationId: string,
    paymentId: string,
    email: string,
    user: User,
  ): Promise<{ ok: boolean; message?: string }> {
    const { payment, order, organization } = await this.getPaymentForReceipt(
      organizationId,
      paymentId,
      user,
    );
    const pdf = await this.receiptPdfService.generateReceiptPdf(
      payment,
      order,
      organization,
    );
    const sent = await this.emailService.sendReceiptEmail({
      to: email,
      organizationName: organization?.name || 'OpenEOS',
      orderNumber: order.orderNumber,
      pdf,
      filename: `beleg-${order.orderNumber}.pdf`,
    });
    if (!sent) {
      return { ok: false, message: 'E-Mail-Versand fehlgeschlagen' };
    }
    this.logger.log(
      `Receipt for order ${order.orderNumber} emailed to ${email} by user ${user.id}`,
    );
    return { ok: true };
  }

  async getBewirtungsbelegPdf(
    organizationId: string,
    paymentId: string,
    user: User,
  ): Promise<{ data: Buffer; filename: string }> {
    const { payment, order, organization } = await this.getPaymentForReceipt(organizationId, paymentId, user);
    const data = await this.receiptPdfService.generateBewirtungsbelegPdf(payment, order, organization);
    return { data, filename: `bewirtungsbeleg-${order.orderNumber}.pdf` };
  }

  async emailBewirtungsbeleg(
    organizationId: string,
    paymentId: string,
    email: string,
    user: User,
  ): Promise<{ ok: boolean; message?: string }> {
    const { payment, order, organization } = await this.getPaymentForReceipt(organizationId, paymentId, user);
    const pdf = await this.receiptPdfService.generateBewirtungsbelegPdf(payment, order, organization);
    const sent = await this.emailService.sendReceiptEmail({
      to: email,
      organizationName: organization?.name || 'OpenEOS',
      orderNumber: order.orderNumber,
      pdf,
      filename: `bewirtungsbeleg-${order.orderNumber}.pdf`,
    });
    if (!sent) {
      return { ok: false, message: 'E-Mail-Versand fehlgeschlagen' };
    }
    this.logger.log(
      `Bewirtungsbeleg for order ${order.orderNumber} emailed to ${email} by user ${user.id}`,
    );
    return { ok: true };
  }

  /**
   * Sign the captured payment through the org's TSE and persist the result.
   * Best-effort: never throws — a TSE outage must not block the sale (see
   * TseService.recordTransaction). No-op when TSE isn't configured.
   *
   * VAT splits: item-exact rows for split payments, whole-order composition
   * otherwise; always allocateToAmount(payment.amount) so the signed split
   * sum matches the payment to the cent (discounts/service fees included).
   */
  private async signPaymentWithTse(
    order: Order,
    payment: Payment,
    splitItems?: { item: OrderItem; quantityToPayNow: number }[],
  ): Promise<void> {
    try {
      const baseSplits = splitItems?.length
        ? splitsFromItems(
            splitItems.map(({ item, quantityToPayNow }) => ({
              quantity: quantityToPayNow,
              unitPrice: Number(item.unitPrice),
              optionsPrice: Number(item.optionsPrice),
              taxRate: Number(item.taxRate),
            })),
          )
        : splitsFromItems(
            order.items.map((i) => ({
              quantity: i.quantity,
              unitPrice: Number(i.unitPrice),
              optionsPrice: Number(i.optionsPrice),
              taxRate: Number(i.taxRate),
            })),
          );
      const vatSplits = allocateToAmount(baseSplits, Number(payment.amount));

      const tseData = await this.tseService.recordTransaction(
        order.organizationId,
        order.createdByDeviceId ?? null,
        {
          amount: Number(payment.amount),
          paymentMethod: payment.paymentMethod,
          vatSplits,
        },
      );
      if (tseData) {
        payment.tseData = tseData;
        await this.paymentRepository.save(payment);
      }
      if (tseData?.failed) {
        this.logger.error(
          `TSE signing failed: org ${order.organizationId}, order ${order.orderNumber} (${order.id}), payment ${payment.id}, device ${order.createdByDeviceId ?? 'none'}, errorCode ${tseData.errorCode ?? 'n/a'}, httpStatus ${tseData.httpStatus ?? 'n/a'}: ${tseData.failureReason ?? 'unknown'}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `TSE signing failed for payment ${payment.id}: ${(error as Error).message}`,
      );
    }
  }

  async create(
    organizationId: string,
    createDto: CreatePaymentDto,
    user: User,
  ): Promise<Payment> {
    await this.checkMembership(organizationId, user.id);

    const order = await this.orderRepository.findOne({
      where: { id: createDto.orderId, organizationId },
      relations: ['items'],
    });

    if (!order) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Bestellung nicht gefunden',
      });
    }

    if (order.paymentStatus === PaymentStatus.PAID) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Bestellung ist bereits vollständig bezahlt',
      });
    }

    const remainingAmount = Number(order.total) - Number(order.paidAmount);
    if (createDto.amount > remainingAmount) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Zahlungsbetrag (${createDto.amount}) übersteigt den ausstehenden Betrag (${remainingAmount})`,
      });
    }

    const provider = this.getProviderForMethod(createDto.paymentMethod);

    const payment = this.paymentRepository.create({
      orderId: createDto.orderId,
      amount: createDto.amount,
      paymentMethod: createDto.paymentMethod,
      paymentProvider: provider,
      providerTransactionId: createDto.providerTransactionId || null,
      status: PaymentTransactionStatus.CAPTURED,
      metadata: createDto.metadata || {},
      processedByUserId: user.id,
    });

    await this.paymentRepository.save(payment);

    // Update order paid amount
    order.paidAmount = Number(order.paidAmount) + createDto.amount;
    // Sticky: once requested, stays requested even if a later split payment
    // on the same order omits the flag -- never silently undoes a "yes".
    if (createDto.bewirtungsbelegRequested) {
      order.bewirtungsbelegRequested = true;
    }
    await this.updateOrderPaymentStatus(order);

    // For full payment, mark all items as paid
    const isFullyPaid = Number(order.paidAmount) >= Number(order.total);
    if (isFullyPaid) {
      for (const item of order.items) {
        item.paidQuantity = item.quantity;
        await this.orderItemRepository.save(item);
      }
    }

    this.logger.log(
      `Payment created: ${payment.id} for order ${order.orderNumber}`,
    );

    // Sign through the TSE before printing, so the receipt can carry the
    // signature/QR code (see OrderPrintService.handlePaymentReceived).
    await this.signPaymentWithTse(order, payment);

    // Trigger auto-printing for payment
    this.orderPrintService
      .handlePaymentReceived(organizationId, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        paymentId: payment.id,
        amount: Number(payment.amount),
        paymentMethod: payment.paymentMethod,
        isFullyPaid: isFullyPaid,
        order,
        tseData: payment.tseData,
      })
      .catch((err) => {
        this.logger.error(`Failed to trigger payment printing: ${err.message}`);
      });

    return this.findOne(organizationId, payment.id, user);
  }

  async createSplitPayment(
    organizationId: string,
    splitDto: SplitPaymentDto,
    user: User,
  ): Promise<Payment> {
    await this.checkMembership(organizationId, user.id);

    const order = await this.orderRepository.findOne({
      where: { id: splitDto.orderId, organizationId },
      relations: ['items'],
    });

    if (!order) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Bestellung nicht gefunden',
      });
    }

    // Validate items and calculate total
    let calculatedTotal = 0;
    const itemsToUpdate: { item: OrderItem; quantityToPayNow: number }[] = [];

    for (const splitItem of splitDto.items) {
      const orderItem = order.items.find((i) => i.id === splitItem.orderItemId);

      if (!orderItem) {
        throw new NotFoundException({
          code: ErrorCodes.NOT_FOUND,
          message: `Bestellposition ${splitItem.orderItemId} nicht gefunden`,
        });
      }

      const unpaidQuantity = orderItem.quantity - orderItem.paidQuantity;
      if (splitItem.quantity > unpaidQuantity) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: `Nicht genügend unbezahlte Menge für ${orderItem.productName} (${unpaidQuantity} verfügbar)`,
        });
      }

      const pricePerUnit =
        Number(orderItem.unitPrice) + Number(orderItem.optionsPrice);
      calculatedTotal += pricePerUnit * splitItem.quantity;

      itemsToUpdate.push({
        item: orderItem,
        quantityToPayNow: splitItem.quantity,
      });
    }

    // Allow some tolerance for rounding
    const tolerance = 0.02;
    if (Math.abs(calculatedTotal - splitDto.amount) > tolerance) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Berechneter Betrag (${calculatedTotal.toFixed(2)}) stimmt nicht mit dem Zahlungsbetrag (${splitDto.amount}) überein`,
      });
    }

    const provider = this.getProviderForMethod(splitDto.paymentMethod);

    const payment = this.paymentRepository.create({
      orderId: splitDto.orderId,
      amount: splitDto.amount,
      paymentMethod: splitDto.paymentMethod,
      paymentProvider: provider,
      providerTransactionId: splitDto.providerTransactionId || null,
      status: PaymentTransactionStatus.CAPTURED,
      metadata: splitDto.metadata || {},
      processedByUserId: user.id,
    });

    await this.paymentRepository.save(payment);

    // Create order item payments and update paid quantities
    for (const { item, quantityToPayNow } of itemsToUpdate) {
      const pricePerUnit = Number(item.unitPrice) + Number(item.optionsPrice);

      const itemPayment = this.orderItemPaymentRepository.create({
        paymentId: payment.id,
        orderItemId: item.id,
        quantity: quantityToPayNow,
        amount: pricePerUnit * quantityToPayNow,
      });

      await this.orderItemPaymentRepository.save(itemPayment);

      item.paidQuantity += quantityToPayNow;
      await this.orderItemRepository.save(item);
    }

    // Update order paid amount
    order.paidAmount = Number(order.paidAmount) + splitDto.amount;
    await this.updateOrderPaymentStatus(order);

    this.logger.log(
      `Split payment created: ${payment.id} for order ${order.orderNumber}`,
    );

    // Sign through the TSE before printing (see create() above). Item-exact
    // splits from the rows this split just paid.
    await this.signPaymentWithTse(order, payment, itemsToUpdate);

    // Trigger auto-printing for payment
    const isFullyPaid = Number(order.paidAmount) >= Number(order.total);
    this.orderPrintService
      .handlePaymentReceived(organizationId, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        paymentId: payment.id,
        amount: Number(payment.amount),
        paymentMethod: payment.paymentMethod,
        isFullyPaid,
        order,
        tseData: payment.tseData,
      })
      .catch((err) => {
        this.logger.error(`Failed to trigger payment printing: ${err.message}`);
      });

    return this.findOne(organizationId, payment.id, user);
  }

  async findAll(
    organizationId: string,
    user: User,
    query: QueryPaymentsDto,
  ): Promise<PaginatedResult<Payment>> {
    await this.checkMembership(organizationId, user.id);

    const { page = 1, limit = 50 } = query;
    const skip = (page - 1) * limit;

    const queryBuilder = this.paymentRepository
      .createQueryBuilder('payment')
      .innerJoin('payment.order', 'order')
      .where('order.organizationId = :organizationId', { organizationId });

    if (query.orderId) {
      queryBuilder.andWhere('payment.orderId = :orderId', {
        orderId: query.orderId,
      });
    }

    if (query.paymentMethod) {
      queryBuilder.andWhere('payment.paymentMethod = :paymentMethod', {
        paymentMethod: query.paymentMethod,
      });
    }

    if (query.status) {
      queryBuilder.andWhere('payment.status = :status', {
        status: query.status,
      });
    }

    if (query.dateFrom) {
      queryBuilder.andWhere('payment.createdAt >= :dateFrom', {
        dateFrom: query.dateFrom,
      });
    }

    if (query.dateTo) {
      queryBuilder.andWhere('payment.createdAt <= :dateTo', {
        dateTo: query.dateTo,
      });
    }

    queryBuilder.orderBy('payment.createdAt', 'DESC').skip(skip).take(limit);

    const [items, total] = await queryBuilder.getManyAndCount();

    return createPaginatedResult(items, total, page, limit);
  }

  async findOne(
    organizationId: string,
    paymentId: string,
    user: User,
  ): Promise<Payment> {
    await this.checkMembership(organizationId, user.id);

    const payment = await this.paymentRepository.findOne({
      where: { id: paymentId },
      relations: [
        'order',
        'itemPayments',
        'itemPayments.orderItem',
        'processedByUser',
      ],
    });

    if (!payment || payment.order.organizationId !== organizationId) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Zahlung nicht gefunden',
      });
    }

    return payment;
  }

  async refund(
    organizationId: string,
    paymentId: string,
    user: User,
  ): Promise<Payment> {
    await this.checkMembership(organizationId, user.id);

    const payment = await this.findOne(organizationId, paymentId, user);

    if (payment.status === PaymentTransactionStatus.REFUNDED) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Zahlung wurde bereits erstattet',
      });
    }

    if (payment.status !== PaymentTransactionStatus.CAPTURED) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Nur abgeschlossene Zahlungen können erstattet werden',
      });
    }

    // Update payment status
    payment.status = PaymentTransactionStatus.REFUNDED;
    await this.paymentRepository.save(payment);

    // Update order paid amount
    const order = await this.orderRepository.findOne({
      where: { id: payment.orderId },
      relations: ['items'],
    });

    if (order) {
      order.paidAmount = Number(order.paidAmount) - Number(payment.amount);
      if (order.paidAmount < 0) order.paidAmount = 0;

      // Revert paid quantities for split payments
      if (payment.itemPayments && payment.itemPayments.length > 0) {
        for (const itemPayment of payment.itemPayments) {
          const orderItem = order.items.find(
            (i) => i.id === itemPayment.orderItemId,
          );
          if (orderItem) {
            orderItem.paidQuantity -= itemPayment.quantity;
            if (orderItem.paidQuantity < 0) orderItem.paidQuantity = 0;
            await this.orderItemRepository.save(orderItem);
          }
        }
      }

      await this.updateOrderPaymentStatus(order);
    }

    // Sign the reversal through the TSE -- the original payment above is
    // never "unsigned"; this is a genuinely new, separately-signed
    // transaction with inverted amounts (see TseService.reverseTransaction).
    // Best-effort like the original capture's signing: never blocks the
    // refund from completing.
    await this.signReversalWithTse(organizationId, order, payment);

    this.logger.log(`Payment refunded: ${payment.id}`);

    return this.findOne(organizationId, paymentId, user);
  }

  /**
   * Org-admin override with the same required-TSE-reversal trade-off as
   * OrdersService.forceCancelOrder: `refund` above is best-effort on TSE
   * signing (BMF Ausfall-Regelung — a normal refund must not be blocked by
   * a TSE outage), but a deliberate admin-forced refund inverts that: the
   * reversal must actually sign, or the whole action aborts and the
   * rejected attempt is written to OrderAuditLog for visibility.
   */
  async forceRefund(
    organizationId: string,
    paymentId: string,
    dto: ForceRefundPaymentDto,
    user: User,
  ): Promise<Payment> {
    await this.checkOrgAdmin(organizationId, user);

    const payment = await this.findOne(organizationId, paymentId, user);

    if (payment.status === PaymentTransactionStatus.REFUNDED) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Zahlung wurde bereits erstattet',
      });
    }

    if (payment.status !== PaymentTransactionStatus.CAPTURED) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Nur abgeschlossene Zahlungen können erstattet werden',
      });
    }

    const order = await this.orderRepository.findOne({
      where: { id: payment.orderId },
      relations: ['items'],
    });

    const storedSplits = payment.tseData?.vatSplits;
    const vatSplits = order
      ? storedSplits?.length
        ? negateSplits(storedSplits)
        : allocateToAmount(
            splitsFromItems(
              order.items.map((i) => ({
                quantity: i.quantity,
                unitPrice: Number(i.unitPrice),
                optionsPrice: Number(i.optionsPrice),
                taxRate: Number(i.taxRate),
              })),
            ),
            -Number(payment.amount),
          )
      : [];
    const tseData = await this.tseService.reverseTransaction(
      organizationId,
      order?.createdByDeviceId ?? null,
      { amount: Number(payment.amount), paymentMethod: payment.paymentMethod, vatSplits },
    );

    if (tseData?.failed) {
      await this.orderAuditLogRepository.save(
        this.orderAuditLogRepository.create({
          organizationId,
          orderId: payment.orderId,
          actorUserId: user.id,
          action: OrderAuditAction.FORCE_REFUND,
          reason: dto.reason,
          details: {
            before: { paymentId: payment.id, status: payment.status },
            failure: {
              errorCode: tseData.errorCode,
              httpStatus: tseData.httpStatus,
              failureReason: tseData.failureReason,
            },
          },
        }),
      );
      this.logger.error(
        `Force-refund aborted: TSE reversal failed for payment ${payment.id} (errorCode ${tseData.errorCode ?? 'n/a'})`,
      );
      throw new BadRequestException({
        code: ErrorCodes.TSE_REVERSAL_REQUIRED,
        message: ErrorMessages[ErrorCodes.TSE_REVERSAL_REQUIRED],
      });
    }

    const reversal = this.paymentRepository.create({
      orderId: payment.orderId,
      amount: -Number(payment.amount),
      paymentMethod: payment.paymentMethod,
      paymentProvider: payment.paymentProvider,
      status: PaymentTransactionStatus.CAPTURED,
      reversesPaymentId: payment.id,
      tseData: tseData ?? null,
    });
    await this.paymentRepository.save(reversal);

    payment.status = PaymentTransactionStatus.REFUNDED;
    await this.paymentRepository.save(payment);

    if (order) {
      order.paidAmount = Number(order.paidAmount) - Number(payment.amount);
      if (order.paidAmount < 0) order.paidAmount = 0;

      if (payment.itemPayments && payment.itemPayments.length > 0) {
        for (const itemPayment of payment.itemPayments) {
          const orderItem = order.items.find((i) => i.id === itemPayment.orderItemId);
          if (orderItem) {
            orderItem.paidQuantity -= itemPayment.quantity;
            if (orderItem.paidQuantity < 0) orderItem.paidQuantity = 0;
            await this.orderItemRepository.save(orderItem);
          }
        }
      }

      await this.updateOrderPaymentStatus(order);
    }

    await this.orderAuditLogRepository.save(
      this.orderAuditLogRepository.create({
        organizationId,
        orderId: payment.orderId,
        actorUserId: user.id,
        action: OrderAuditAction.FORCE_REFUND,
        reason: dto.reason,
        details: {
          before: { paymentId: payment.id, status: PaymentTransactionStatus.CAPTURED },
          after: { paymentId: payment.id, status: PaymentTransactionStatus.REFUNDED },
        },
      }),
    );

    this.logger.log(`Payment force-refunded by ${user.id}: ${payment.id}`);

    return this.findOne(organizationId, paymentId, user);
  }

  /**
   * Creates the reversal Payment row and signs it through the TSE. Shared
   * shape with signPaymentWithTse (the original-capture path) -- mirrors it
   * deliberately rather than diverging, so the two are easy to compare.
   */
  private async signReversalWithTse(
    organizationId: string,
    order: Order | null,
    originalPayment: Payment,
  ): Promise<void> {
    if (!order) return;
    try {
      const storedSplits = originalPayment.tseData?.vatSplits;
      const vatSplits = storedSplits?.length
        ? negateSplits(storedSplits)
        : allocateToAmount(
            splitsFromItems(
              order.items.map((i) => ({
                quantity: i.quantity,
                unitPrice: Number(i.unitPrice),
                optionsPrice: Number(i.optionsPrice),
                taxRate: Number(i.taxRate),
              })),
            ),
            -Number(originalPayment.amount),
          );
      const tseData = await this.tseService.reverseTransaction(
        organizationId,
        order.createdByDeviceId ?? null,
        {
          amount: Number(originalPayment.amount),
          paymentMethod: originalPayment.paymentMethod,
          vatSplits,
        },
      );
      const reversal = this.paymentRepository.create({
        orderId: originalPayment.orderId,
        amount: -Number(originalPayment.amount),
        paymentMethod: originalPayment.paymentMethod,
        paymentProvider: originalPayment.paymentProvider,
        status: PaymentTransactionStatus.CAPTURED,
        reversesPaymentId: originalPayment.id,
        tseData: tseData ?? null,
      });
      await this.paymentRepository.save(reversal);
      if (tseData?.failed) {
        this.logger.error(
          `TSE reversal signing failed: org ${organizationId}, order ${order?.orderNumber ?? order?.id ?? 'n/a'}, payment ${originalPayment.id}, device ${order?.createdByDeviceId ?? 'none'}, errorCode ${tseData.errorCode ?? 'n/a'}, httpStatus ${tseData.httpStatus ?? 'n/a'}: ${tseData.failureReason ?? 'unknown'}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `TSE reversal signing failed for payment ${originalPayment.id}: ${(error as Error).message}`,
      );
    }
  }

  async getPaymentsByOrder(
    organizationId: string,
    orderId: string,
    user: User,
  ): Promise<Payment[]> {
    await this.checkMembership(organizationId, user.id);

    // Verify order belongs to organization
    const order = await this.orderRepository.findOne({
      where: { id: orderId, organizationId },
    });

    if (!order) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Bestellung nicht gefunden',
      });
    }

    return this.paymentRepository.find({
      where: { orderId },
      relations: ['itemPayments', 'itemPayments.orderItem', 'processedByUser'],
      order: { createdAt: 'DESC' },
    });
  }

  // Private helper methods

  private getProviderForMethod(method: PaymentMethod): PaymentProvider {
    switch (method) {
      case PaymentMethod.CASH:
        return PaymentProvider.CASH;
      case PaymentMethod.CARD:
        return PaymentProvider.CARD;
      case PaymentMethod.SUMUP_TERMINAL:
      case PaymentMethod.SUMUP_ONLINE:
        return PaymentProvider.SUMUP;
      default:
        return PaymentProvider.CASH;
    }
  }

  private async updateOrderPaymentStatus(order: Order): Promise<void> {
    const total = Number(order.total);
    const paidAmount = Number(order.paidAmount);

    if (paidAmount >= total) {
      order.paymentStatus = PaymentStatus.PAID;
    } else if (paidAmount > 0) {
      order.paymentStatus = PaymentStatus.PARTLY_PAID;
    } else {
      order.paymentStatus = PaymentStatus.UNPAID;
    }

    await this.orderRepository.save(order);
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

  /** Gate for Force* overrides (org-ADMIN only) — mirrors OrdersService.checkOrgAdmin. */
  private async checkOrgAdmin(organizationId: string, user: User): Promise<void> {
    if (user.isSuperAdmin) return;

    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId: user.id },
    });

    if (!membership || membership.role !== OrganizationRole.ADMIN) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Nur Organisations-Admins können diese Aktion erzwingen',
      });
    }
  }
}
