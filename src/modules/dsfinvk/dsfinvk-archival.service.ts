import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Device } from '../../database/entities/device.entity';
import { Order } from '../../database/entities/order.entity';
import { DsfinvkClosing } from '../../database/entities/dsfinvk-closing.entity';
import { DsfinvkArchive } from '../../database/entities/dsfinvk-archive.entity';
import { DsfinvkExportService } from './dsfinvk-export.service';

/** Comfortably inside fiskaly's 3-month (~90 day) retention window. */
const ARCHIVE_MAX_AGE_DAYS = 60;

/**
 * Recurring backstop for the Aufbewahrungspflicht: fiskaly only retains
 * signed transaction data for 3 months, so retention cannot depend on an
 * admin remembering to click "export" regularly. This runs daily, and for
 * any till that hasn't been archived recently enough, pulls a real
 * DSFinV-K export (allocating a real, permanent Z_NR -- this performs an
 * actual Kassenabschluss, not a passive copy) and writes it to a durable,
 * never-pruned volume.
 */
@Injectable()
export class DsfinvkArchivalService {
  private readonly logger = new Logger(DsfinvkArchivalService.name);

  constructor(
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(DsfinvkClosing)
    private readonly closingRepository: Repository<DsfinvkClosing>,
    @InjectRepository(DsfinvkArchive)
    private readonly archiveRepository: Repository<DsfinvkArchive>,
    private readonly exportService: DsfinvkExportService,
    private readonly configService: ConfigService,
  ) {}

  private get archiveDir(): string {
    return this.configService.get<string>('dsfinvk.archiveDir', './dsfinvk-archives');
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleArchival(): Promise<void> {
    this.logger.log('Starting DSFinV-K archival job...');

    let checked = 0;
    let archived = 0;
    let failed = 0;

    const devices = await this.deviceRepository
      .createQueryBuilder('device')
      .where('device.organizationId IS NOT NULL')
      .andWhere("device.settings ->> 'tseClientId' IS NOT NULL")
      .getMany();

    const threshold = new Date();
    threshold.setDate(threshold.getDate() - ARCHIVE_MAX_AGE_DAYS);

    for (const device of devices) {
      checked++;
      try {
        const lastArchive = await this.archiveRepository.findOne({
          where: { deviceId: device.id },
          order: { createdAt: 'DESC' },
        });
        if (lastArchive && lastArchive.createdAt > threshold) {
          continue; // archived recently enough, nothing to do
        }

        archived += await this.archiveDevice(device);
      } catch (error) {
        failed++;
        this.logger.error(
          `DSFinV-K archival failed for device ${device.id}: ${(error as Error).message}`,
        );
      }
    }

    this.logger.log(
      `DSFinV-K archival job completed: ${checked} tills checked, ${archived} archives written, ${failed} failed`,
    );
  }

  /**
   * A till can have unclosed orders across more than one event (a
   * physical device is now reusable across re-registrations and, over
   * its life, multiple events) -- archive each event separately, since
   * generateExportInternal is itself scoped to one event.
   */
  private async archiveDevice(device: Device): Promise<number> {
    const lastClosing = await this.closingRepository.findOne({
      where: { deviceId: device.id },
      order: { zNr: 'DESC' },
    });
    const since = lastClosing?.periodEnd ?? new Date(0);

    const eventRows = await this.orderRepository
      .createQueryBuilder('order')
      .select('DISTINCT order.eventId', 'eventId')
      .where('order.createdByDeviceId = :deviceId', { deviceId: device.id })
      .andWhere('order.createdAt > :since', { since })
      .andWhere('order.eventId IS NOT NULL')
      .getRawMany<{ eventId: string }>();

    let written = 0;
    for (const { eventId } of eventRows) {
      try {
        const result = await this.exportService.generateExportInternal(
          device.organizationId as string,
          eventId,
          device.id,
        );
        await this.persistArchive(device, eventId, result.data, result.filename);
        written++;
      } catch (error) {
        // Nothing new for this event on this device -- not a failure, just
        // means the last closing already covered it.
        if (error instanceof BadRequestException) continue;
        throw error;
      }
    }
    return written;
  }

  private async persistArchive(
    device: Device,
    eventId: string,
    data: Buffer,
    filename: string,
  ): Promise<void> {
    // The closing this export just allocated has the real bracket
    // (periodStart/periodEnd/zNr) -- read it back rather than
    // approximating with two separately-taken `new Date()` calls.
    const closing = await this.closingRepository.findOne({
      where: { deviceId: device.id },
      order: { zNr: 'DESC' },
    });
    if (!closing) {
      throw new Error(`generateExportInternal succeeded but no closing was found for device ${device.id}`);
    }

    const dir = path.join(this.archiveDir, device.organizationId as string);
    await fs.mkdir(dir, { recursive: true });
    const archivePath = path.join(dir, `${closing.id}-${filename}`);
    await fs.writeFile(archivePath, data);
    const checksumSha256 = crypto.createHash('sha256').update(data).digest('hex');

    await this.archiveRepository.save(
      this.archiveRepository.create({
        organizationId: device.organizationId as string,
        eventId,
        deviceId: device.id,
        periodStart: closing.periodStart,
        periodEnd: closing.periodEnd,
        archivePath,
        sizeBytes: data.length,
        checksumSha256,
      }),
    );

    this.logger.log(`Archived DSFinV-K export for device ${device.id} (event ${eventId}) -> ${archivePath}`);
  }
}
