import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TseController } from './tse.controller';
import { TseService } from './tse.service';
import { FiskalyTseProvider } from './providers/fiskaly-tse.provider';
import { LocalTseProvider } from './providers/local-tse.provider';
import { Organization, Device, UserOrganization } from '../../database/entities';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Organization, Device, UserOrganization]),
    forwardRef(() => GatewayModule),
  ],
  controllers: [TseController],
  providers: [TseService, FiskalyTseProvider, LocalTseProvider],
  exports: [TseService],
})
export class TseModule {}
