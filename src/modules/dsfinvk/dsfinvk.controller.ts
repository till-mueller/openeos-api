import { Controller, Get, Param, ParseUUIDPipe, Res } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import { DsfinvkExportService } from './dsfinvk-export.service';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';

@ApiTags('DSFinV-K')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/dsfinvk')
export class DsfinvkController {
  constructor(private readonly dsfinvkExportService: DsfinvkExportService) {}

  /**
   * Generates and downloads a DSFinV-K export covering everything on this
   * till since its last closing (or the event's start, for a first
   * export). Safe to call again mid-event -- each call allocates a fresh,
   * never-reused Z_NR for this device (see DsfinvkClosing).
   */
  @Get('events/:eventId/devices/:deviceId/export')
  async exportData(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @CurrentUser() user: User,
    @Res() res: unknown,
  ) {
    const result = await this.dsfinvkExportService.generateExport(
      organizationId,
      eventId,
      deviceId,
      user.id,
    );
    const response = res as Response;
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.filename}"`,
    );
    response.send(result.data);
  }

  /**
   * One click for every till used in this event: loops the per-device
   * export above over each one and packages the results into one outer
   * ZIP. Each till still gets its own independent Z_NR allocation --
   * this is a convenience wrapper around exportData, not a different
   * export.
   */
  @Get('events/:eventId/export')
  async exportEventData(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
    @Res() res: unknown,
  ) {
    const result = await this.dsfinvkExportService.generateEventExport(
      organizationId,
      eventId,
      user.id,
    );
    const response = res as Response;
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.filename}"`,
    );
    response.send(result.data);
  }
}
