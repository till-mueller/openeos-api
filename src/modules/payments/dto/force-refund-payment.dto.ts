import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ForceRefundPaymentDto {
  @ApiProperty({
    example: 'Kundenreklamation, manuelle Korrektur durch Admin',
    description: 'Grund für die erzwungene Erstattung (Pflichtfeld für den Audit-Trail)',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  reason: string;
}
