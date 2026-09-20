import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ForceCancelOrderDto {
  @ApiProperty({
    example: 'Kundenreklamation nach Ladenschluss, TSE-Ausfall bekannt',
    description: 'Grund für die erzwungene Stornierung (Pflichtfeld für den Audit-Trail)',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  reason: string;
}
