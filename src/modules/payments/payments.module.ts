import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PaymentsController } from './payments.controller';
import { ReceiptsPublicController } from './receipts-public.controller';
import { PaymentsService } from './payments.service';
import { PayPalService } from './providers/paypal.service';
import { ReceiptPdfService } from './receipt-pdf.service';
import {
  Payment,
  Order,
  OrderItem,
  OrderItemPayment,
  OrderAuditLog,
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
      OrderAuditLog,
      UserOrganization,
      Organization,
    ]),
    PrintJobsModule,
    TseModule,
    // Own registration (not importing AuthModule) -- receipt link tokens are
    // a different purpose/audience than user auth tokens, just sharing the
    // same signing secret is enough; no need to pull in AuthModule's much
    // larger provider set for this.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('jwt.secret'),
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [PaymentsController, ReceiptsPublicController],
  providers: [PaymentsService, PayPalService, ReceiptPdfService],
  exports: [PaymentsService, PayPalService],
})
export class PaymentsModule {}
