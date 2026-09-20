import { IsEmail, IsEnum, IsOptional, IsObject, IsNumber, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrganizationRole } from '../../../database/entities/user-organization.entity';
import type { OrganizationPermissions } from '../../../database/entities/user-organization.entity';

export class AddMemberDto {
  @ApiProperty({ example: 'max.mustermann@example.com', description: 'E-Mail-Adresse des neuen Mitglieds' })
  @IsEmail({}, { message: 'Ungültige E-Mail-Adresse' })
  email: string;

  @ApiProperty({ example: 'member', description: 'Rolle des Mitglieds in der Organisation', enum: OrganizationRole })
  @IsEnum(OrganizationRole, { message: 'Ungültige Rolle' })
  role: OrganizationRole;

  @ApiPropertyOptional({ example: { products: true, events: false }, description: 'Modulberechtigungen (bei role=member)' })
  @IsOptional()
  @IsObject()
  permissions?: OrganizationPermissions;

  @ApiPropertyOptional({ example: 10, description: 'Provision in Prozent auf den von dieser Person verkauften Umsatz' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  commissionPercent?: number;
}

export class UpdateMemberDto {
  @ApiPropertyOptional({ example: 'admin', description: 'Rolle des Mitglieds in der Organisation', enum: OrganizationRole })
  @IsOptional()
  @IsEnum(OrganizationRole, { message: 'Ungültige Rolle' })
  role?: OrganizationRole;

  @ApiPropertyOptional({ example: { products: true, events: true }, description: 'Modulberechtigungen (bei role=member)' })
  @IsOptional()
  @IsObject()
  permissions?: OrganizationPermissions;

  @ApiPropertyOptional({ example: 10, description: 'Provision in Prozent auf den von dieser Person verkauften Umsatz' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  commissionPercent?: number;
}
