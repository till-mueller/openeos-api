import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformSetting } from '../../database/entities';
import { PlatformSettingsService } from './platform-settings.service';
import { EncryptionService } from '../../common/services/encryption.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([PlatformSetting])],
  providers: [PlatformSettingsService, EncryptionService],
  exports: [PlatformSettingsService],
})
export class PlatformSettingsModule {}
