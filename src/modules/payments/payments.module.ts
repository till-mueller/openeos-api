import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PayPalService } from './providers/paypal.service';
import { ReceiptPdfService } from './receipt-pdf.service';
import {
  Payment,
  Order,
  OrderItem,
  OrderItemPayment,
  UserOrganization,
  Organization,
} from '../../database/entities';
import { PrintJobsModule } from '../print-jobs/print-jobs.module';
import { TseModule } from '../tse/tse.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Payment,
      Order,
      OrderItem,
      OrderItemPayment,
      UserOrganization,
      Organization,
    ]),
    PrintJobsModule,
    TseModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService, PayPalService, ReceiptPdfService],
  exports: [PaymentsService, PayPalService],
})
export class PaymentsModule {}
