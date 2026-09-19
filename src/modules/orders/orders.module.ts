import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import {
  Order,
  OrderItem,
  Product,
  UserOrganization,
  StockMovement,
  Event,
  ProductionStation,
  Organization,
  Payment,
} from '../../database/entities';
import { PrintJobsModule } from '../print-jobs/print-jobs.module';
import { GatewayModule } from '../gateway/gateway.module';
import { TseModule } from '../tse/tse.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order,
      OrderItem,
      Product,
      UserOrganization,
      StockMovement,
      Event,
      ProductionStation,
      Organization,
      Payment,
    ]),
    PrintJobsModule,
    forwardRef(() => GatewayModule),
    TseModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
