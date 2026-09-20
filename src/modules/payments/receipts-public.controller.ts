import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { PaymentsService } from './payments.service';

/**
 * Customer-facing counterpart to PaymentsController's receipt endpoints --
 * no JWT user, no device token, nothing: the signed token in the URL (see
 * PaymentsService.getReceiptLink) is the entire authorization. Reached by
 * scanning the QR code the POS shows right after a payment completes.
 */
@ApiTags('Receipts')
@Controller('public/receipts')
@Public()
export class ReceiptsPublicController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get(':token')
  @ApiOperation({ summary: 'Fetch a receipt PDF via its signed, time-limited public link' })
  async getReceipt(@Param('token') token: string, @Res() res: unknown) {
    const { data, filename } = await this.paymentsService.getReceiptPdfByToken(token);
    const response = res as Response;
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    response.send(data);
  }
}
