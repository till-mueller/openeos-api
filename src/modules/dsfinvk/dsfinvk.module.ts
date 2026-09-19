import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DsfinvkController } from './dsfinvk.controller';
import { DsfinvkExportService } from './dsfinvk-export.service';
import { DsfinvkArchivalService } from './dsfinvk-archival.service';
import {
  Organization,
  Event,
  Device,
  Order,
  Payment,
  UserOrganization,
  DsfinvkClosing,
  DsfinvkArchive,
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
      DsfinvkArchive,
    ]),
  ],
  controllers: [DsfinvkController],
  providers: [DsfinvkExportService, DsfinvkArchivalService],
  exports: [DsfinvkExportService],
})
export class DsfinvkModule {}
