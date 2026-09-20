import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganizationsController, InvitationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import {
  Organization,
  User,
  UserOrganization,
  Invitation,
  AdminAuditLog,
} from '../../database/entities';
import { GatewayModule } from '../gateway/gateway.module';
import { DevicesModule } from '../devices/devices.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Organization, User, UserOrganization, Invitation, AdminAuditLog]),
    GatewayModule,
    DevicesModule,
    UsersModule,
  ],
  controllers: [OrganizationsController, InvitationsController],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
