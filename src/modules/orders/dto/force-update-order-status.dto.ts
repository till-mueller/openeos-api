import { IsEnum, IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus } from '../../../database/entities/order.entity';

export class ForceUpdateOrderStatusDto {
  @ApiProperty({
    enum: OrderStatus,
    example: OrderStatus.READY,
    description: 'Zielstatus. CANCELLED ist hier ausgeschlossen — dafür force-cancel verwenden (erfordert TSE-Storno).',
  })
  @IsEnum(OrderStatus)
  status: Exclude<OrderStatus, OrderStatus.CANCELLED>;

  @ApiProperty({
    example: 'Status manuell korrigiert nach Druckerfehler',
    description: 'Grund für die erzwungene Statusänderung (Pflichtfeld für den Audit-Trail)',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  reason: string;
}
