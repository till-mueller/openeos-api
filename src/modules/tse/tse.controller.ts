import {
  Controller,
  Post,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import { TseService } from './tse.service';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';

@ApiTags('TSE')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/tse')
export class TseController {
  constructor(private readonly tseService: TseService) {}

  @Post('test-connection')
  @HttpCode(HttpStatus.OK)
  testConnection(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
  ) {
    return this.tseService.testConnection(organizationId, user.id);
  }

  /** All TSE client ids this org has signed under — for picking which one to export. */
  @Get('clients')
  listClients(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
  ) {
    return this.tseService
      .listClientIds(organizationId, user.id)
      .then((clientIds) => ({ data: clientIds }));
  }

  /**
   * Handover export for the rental-tenant separation model — download the
   * signed transaction log for one client + date range as a file, so a
   * renter keeps their own copy once the shared TSE hardware moves on to
   * the next weekend's tenant.
   */
  @Get('export')
  async exportData(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query('periodStart') periodStart: string,
    @Query('periodEnd') periodEnd: string,
    @Query('clientId') clientId: string | undefined,
    @CurrentUser() user: User,
    @Res() res: unknown,
  ) {
    const start = new Date(periodStart);
    const end = new Date(periodEnd);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'periodStart/periodEnd müssen gültige ISO-Daten sein',
      });
    }

    const result = await this.tseService.exportData(organizationId, user.id, start, end, clientId);
    const response = res as Response;
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    response.send(result.data);
  }
}
