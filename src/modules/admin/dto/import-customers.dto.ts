import {
  IsString,
  IsEmail,
  IsOptional,
  IsObject,
  MinLength,
  MaxLength,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export class ImportCustomerAdminDto {
  @ApiProperty({
    example: 'admin@acme.example',
    description: 'E-Mail des Admin-Benutzers',
  })
  @IsEmail()
  email: string;

  @ApiProperty({
    example: 'TemporaryPass123!',
    description: 'Initialpasswort des Admin-Benutzers',
  })
  @IsString()
  @MinLength(8, { message: 'Passwort muss mindestens 8 Zeichen lang sein' })
  @MaxLength(128)
  password: string;

  @ApiProperty({ example: 'Max' })
  @IsString()
  @MaxLength(100)
  firstName: string;

  @ApiProperty({ example: 'Mustermann' })
  @IsString()
  @MaxLength(100)
  lastName: string;
}

export class ImportCustomerBillingAddressDto {
  @ApiPropertyOptional({ example: 'Acme GmbH' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  company?: string;

  @ApiPropertyOptional({ example: 'Max Mustermann' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiProperty({ example: 'Musterstraße 1' })
  @IsString()
  @MaxLength(255)
  street: string;

  @ApiProperty({ example: 'Berlin' })
  @IsString()
  @MaxLength(100)
  city: string;

  @ApiProperty({ example: '10115' })
  @IsString()
  @MaxLength(20)
  zip: string;

  @ApiProperty({ example: 'DE' })
  @IsString()
  @MaxLength(2)
  country: string;
}

/**
 * One customer/organization as described in an uploaded YAML file. Matches
 * the shape parsed by js-yaml before validation — see
 * AdminService.importCustomers.
 */
export class ImportCustomerYamlDto {
  @ApiProperty({ example: 'Acme GmbH', description: 'Name der Organisation' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional({
    example: 'acme-gmbh',
    description:
      'Slug der Organisation. Wird aus dem Namen generiert, falls nicht angegeben.',
  })
  @IsOptional()
  @IsString()
  @Matches(SLUG_PATTERN, {
    message:
      'Slug darf nur Kleinbuchstaben, Ziffern und Bindestriche enthalten',
  })
  @MaxLength(100)
  slug?: string;

  @ApiProperty({
    description: 'Admin-Benutzer, der beim erstmaligen Import angelegt wird',
  })
  @ValidateNested()
  @Type(() => ImportCustomerAdminDto)
  admin: ImportCustomerAdminDto;

  @ApiPropertyOptional({
    example: { currency: 'EUR', timezone: 'Europe/Berlin', locale: 'de' },
  })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;

  @ApiPropertyOptional({ example: 'billing@acme.example' })
  @IsOptional()
  @IsEmail()
  billingEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => ImportCustomerBillingAddressDto)
  billingAddress?: ImportCustomerBillingAddressDto;
}

export type ImportCustomerAction = 'created' | 'updated' | 'error';

export interface ImportCustomerResult {
  filename: string;
  action: ImportCustomerAction;
  organizationId?: string;
  organizationSlug?: string;
  error?: string;
}
