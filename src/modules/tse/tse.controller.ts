import {
  Controller,
  Post,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Body,
  Res,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import { TseService } from './tse.service';
import { CurrentUser } from '../../common/decorators';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { OrganizationGuard } from '../../common/guards/organization.guard';
import { Role } from '../../common/constants/roles.enum';
import { User } from '../../database/entities';

@ApiTags('TSE')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/tse')
@UseGuards(OrganizationGuard, RolesGuard)
export class TseController {
  constructor(private readonly tseService: TseService) {}

  @Post('test-connection')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN)
  testConnection(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
  ) {
    return this.tseService.testConnection(organizationId, user.id);
  }

  /**
   * Registers the org's default TSE client. Unlike test-connection (a pure
   * read-only health check), this is a real mutation against the provider
   * -- deliberately its own endpoint so "test" never has side effects.
   */
  @Post('register-client')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN)
  registerClient(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
  ) {
    return this.tseService.registerClient(organizationId, user.id);
  }

  /**
   * Creates and fully initializes a brand-new fiskaly TSS from just an API
   * key/secret, and saves the result as this org's TSE config. This is the
   * only supported way to get a fiskaly TSS into this app -- there's no
   * "paste in a tssId you made elsewhere" path, since a TSS from anywhere
   * else starts in state CREATED and can't sign or register clients until
   * walked through the same lifecycle this does automatically. Blocks for
   * ~35s (fiskaly's required settle time) -- an admin action, not a hot path.
   */
  @Post('fiskaly/create')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN)
  createFiskalyTss(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: { apiKey: string; apiSecret: string },
    @CurrentUser() user: User,
  ) {
    return this.tseService.createTss(organizationId, user.id, body);
  }

  /** Whether this deployment offers self-service platform-reseller TSE activation. */
  @Get('reseller-available')
  @Roles(Role.ADMIN)
  async resellerAvailable() {
    return { data: { available: await this.tseService.isResellerModeAvailable() } };
  }

  /**
   * Self-service activation under the platform's own fiskaly reseller
   * account (see fiskaly's SIGN DE service description on sublicensing to
   * Endkunden) -- no fiskaly account of the org's own required.
   * `acknowledgedBetreiber` must be explicitly true: the org, not the
   * platform, carries full KassenSichV statutory responsibility.
   */
  @Post('activate')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN)
  activate(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: { acknowledgedBetreiber: boolean },
    @CurrentUser() user: User,
  ) {
    return this.tseService.activatePlatformTse(organizationId, user.id, body.acknowledgedBetreiber);
  }

  /** All TSE client ids this org has signed under — for picking which one to export. */
  @Get('clients')
  @Roles(Role.ADMIN)
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
  @Roles(Role.ADMIN)
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
