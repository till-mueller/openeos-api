import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventsShopPublicController } from './events-shop-public.controller';
import { Event, EventStatus } from '../../database/entities/event.entity';
import { Organization } from '../../database/entities/organization.entity';
import { Category } from '../../database/entities/category.entity';
import { Product } from '../../database/entities/product.entity';

function makeLiveEvent(): Event {
  return {
    id: 'event-1',
    name: 'Sommerfest',
    description: 'Ein Fest',
    status: EventStatus.ACTIVE,
    startDate: new Date('2026-09-01T12:00:00.000Z'),
    endDate: new Date('2026-09-03T12:00:00.000Z'),
    organizationId: 'org-1',
    settings: {
      shop: {
        enabled: true,
        hoursMode: 'event',
      },
    },
  } as unknown as Event;
}

describe('EventsShopPublicController (legal texts)', () => {
  let controller: EventsShopPublicController;

  const eventRepository = { findOne: jest.fn() };
  const organizationRepository = { findOne: jest.fn() };
  const categoryRepository = { find: jest.fn() };
  const productRepository = { find: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    eventRepository.findOne.mockResolvedValue(makeLiveEvent());
    categoryRepository.find.mockResolvedValue([]);
    productRepository.find.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EventsShopPublicController],
      providers: [
        { provide: getRepositoryToken(Event), useValue: eventRepository },
        { provide: getRepositoryToken(Organization), useValue: organizationRepository },
        { provide: getRepositoryToken(Category), useValue: categoryRepository },
        { provide: getRepositoryToken(Product), useValue: productRepository },
      ],
    }).compile();

    controller = module.get(EventsShopPublicController);
  });

  it('exposes only the four legal strings from org settings', async () => {
    organizationRepository.findOne.mockResolvedValue({
      id: 'org-1',
      name: 'Musterverein e.V.',
      settings: {
        currency: 'EUR',
        timezone: 'Europe/Berlin',
        legal: {
          imprint: 'Impressum <b>Text</b>',
          privacy: 'Datenschutzerklaerung',
          terms: undefined,
          cancellation: undefined,
        },
        sumup: { apiKey: 'SECRET', affiliateKey: 'SECRET_AFFILIATE' },
      },
    });

    const result = await controller.getShop('event-1');

    expect(result.data.legal).toEqual({
      imprint: 'Impressum <b>Text</b>',
      privacy: 'Datenschutzerklaerung',
      terms: null,
      cancellation: null,
    });
    expect(JSON.stringify(result.data)).not.toContain('SECRET');
  });

  it('normalizes missing legal fields to null', async () => {
    organizationRepository.findOne.mockResolvedValue({
      id: 'org-1',
      settings: { currency: 'EUR' },
    });

    const result = await controller.getShop('event-1');

    expect(result.data.legal).toEqual({
      imprint: null,
      privacy: null,
      terms: null,
      cancellation: null,
    });
  });

  it('exposes vatExempt for the price note', async () => {
    organizationRepository.findOne.mockResolvedValue({
      id: 'org-1',
      settings: { currency: 'EUR', vatExempt: true },
    });

    const result = await controller.getShop('event-1');

    expect(result.data.vatExempt).toBe(true);
    expect(result.data.legal).toEqual({
      imprint: null,
      privacy: null,
      terms: null,
      cancellation: null,
    });
  });

  it('keeps existing public payload fields (event, currency, shop)', async () => {
    organizationRepository.findOne.mockResolvedValue({
      id: 'org-1',
      settings: { currency: 'EUR', timezone: 'Europe/Berlin' },
    });

    const result = await controller.getShop('event-1');

    expect(result.data.event.id).toBe('event-1');
    expect(result.data.currency).toBe('EUR');
    expect(result.data.shop.hoursMode).toBe('event');
  });
});
