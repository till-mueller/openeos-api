import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DsfinvkController } from './dsfinvk.controller';
import { DsfinvkExportService } from './dsfinvk-export.service';
import {
  Organization,
  Event,
  Device,
  Order,
  Payment,
  UserOrganization,
  DsfinvkClosing,
} from '../../database/entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Organization,
      Event,
      Device,
      Order,
      Payment,
      UserOrganization,
      DsfinvkClosing,
    ]),
  ],
  controllers: [DsfinvkController],
  providers: [DsfinvkExportService],
  exports: [DsfinvkExportService],
})
export class DsfinvkModule {}
