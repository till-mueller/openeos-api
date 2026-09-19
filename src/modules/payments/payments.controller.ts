import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Res,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import { PaymentsService } from './payments.service';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';
import { CreatePaymentDto, SplitPaymentDto, QueryPaymentsDto } from './dto';

@ApiTags('Payments')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() createDto: CreatePaymentDto,
    @CurrentUser() user: User,
  ) {
    return this.paymentsService.create(organizationId, createDto, user);
  }

  @Post('split')
  createSplitPayment(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() splitDto: SplitPaymentDto,
    @CurrentUser() user: User,
  ) {
    return this.paymentsService.createSplitPayment(organizationId, splitDto, user);
  }

  @Get()
  findAll(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: QueryPaymentsDto,
    @CurrentUser() user: User,
  ) {
    return this.paymentsService.findAll(organizationId, user, query);
  }

  @Get(':paymentId')
  findOne(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @CurrentUser() user: User,
  ) {
    return this.paymentsService.findOne(organizationId, paymentId, user);
  }

  @Get('order/:orderId')
  getPaymentsByOrder(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @CurrentUser() user: User,
  ) {
    return this.paymentsService.getPaymentsByOrder(organizationId, orderId, user);
  }

  @Post(':paymentId/refund')
  @HttpCode(HttpStatus.OK)
  refund(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @CurrentUser() user: User,
  ) {
    return this.paymentsService.refund(organizationId, paymentId, user);
  }

  /**
   * Renders and returns the receipt as a PDF, independent of the org's
   * receipt-printing setting or whether any printer is configured -- an
   * admin can always view what a customer was (or wasn't) handed.
   */
  @Get(':paymentId/receipt')
  async getReceipt(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @CurrentUser() user: User,
    @Res() res: unknown,
  ) {
    const { data, filename } = await this.paymentsService.getReceiptPdf(organizationId, paymentId, user);
    const response = res as Response;
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    response.send(data);
  }

  /** Ad-hoc email -- no stored customer address, the caller types one in at send time. */
  @Post(':paymentId/receipt/email')
  @HttpCode(HttpStatus.OK)
  emailReceipt(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() body: { email: string },
    @CurrentUser() user: User,
  ) {
    if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Gültige E-Mail-Adresse erforderlich',
      });
    }
    return this.paymentsService.emailReceipt(organizationId, paymentId, body.email, user);
  }

  /**
   * Same receipt, plus an appended blank-lines Bewirtungsbeleg section
   * (§ 4 Abs. 5 Nr. 2 EStG) to fill in and sign by hand. Available for any
   * order regardless of whether the checkout toggle was used.
   */
  @Get(':paymentId/bewirtungsbeleg')
  async getBewirtungsbeleg(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @CurrentUser() user: User,
    @Res() res: unknown,
  ) {
    const { data, filename } = await this.paymentsService.getBewirtungsbelegPdf(organizationId, paymentId, user);
    const response = res as Response;
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    response.send(data);
  }

  @Post(':paymentId/bewirtungsbeleg/email')
  @HttpCode(HttpStatus.OK)
  emailBewirtungsbeleg(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() body: { email: string },
    @CurrentUser() user: User,
  ) {
    if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Gültige E-Mail-Adresse erforderlich',
      });
    }
    return this.paymentsService.emailBewirtungsbeleg(organizationId, paymentId, body.email, user);
  }
}
