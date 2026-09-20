import { IsOptional, IsString, MinLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class DeleteAccountDto {
  @ApiPropertyOptional({ description: 'Required for password accounts; skipped for SSO-only accounts' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  password?: string;
}
