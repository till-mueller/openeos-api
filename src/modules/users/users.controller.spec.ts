import { HttpStatus } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UploadsService } from '../uploads/uploads.service';

describe('DELETE /users/me', () => {
  let usersService: {
    deleteAccount: jest.Mock;
    getDataExport: jest.Mock;
  };
  let controller: UsersController;

  const user = { id: 'user-1' } as any;

  beforeEach(() => {
    usersService = { deleteAccount: jest.fn(), getDataExport: jest.fn() };
    controller = new UsersController(
      usersService as any,
      { deleteImage: jest.fn(), uploadImage: jest.fn() } as any as UploadsService,
    );
  });

  it('delegates the caller id and password to the service', async () => {
    await controller.deleteMyAccount(user, { password: 'secret' });

    expect(usersService.deleteAccount).toHaveBeenCalledWith('user-1', 'secret');
  });

  it('answers 200 with { data: { deleted: true } }', async () => {
    usersService.deleteAccount.mockResolvedValue(undefined);

    const result = await controller.deleteMyAccount(user, {});

    expect(Reflect.getMetadata('__httpCode__', controller.deleteMyAccount)).toBe(HttpStatus.OK);
    expect(result).toEqual({ data: { deleted: true } });
  });
});

describe('GET /users/me/data-export', () => {
  let usersService: {
    deleteAccount: jest.Mock;
    getDataExport: jest.Mock;
  };
  let controller: UsersController;

  const user = { id: 'user-1' } as any;
  const res = { setHeader: jest.fn() };

  beforeEach(() => {
    usersService = { deleteAccount: jest.fn(), getDataExport: jest.fn() };
    controller = new UsersController(
      usersService as any,
      { deleteImage: jest.fn(), uploadImage: jest.fn() } as any as UploadsService,
    );
    res.setHeader.mockClear();
  });

  it('returns the export as a JSON attachment with a data-export Content-Disposition', async () => {
    const data = {
      exportedAt: '2026-01-01T00:00:00.000Z',
      profile: { id: 'user-1', email: 'a@b.de' },
      memberships: [],
      activeSessions: [],
    };
    usersService.getDataExport.mockResolvedValue(data);

    const result = await controller.exportMyData(user, res as any);

    expect(usersService.getDataExport).toHaveBeenCalledWith('user-1');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="openeos-data-export-user-1.json"',
    );
    expect(result).toEqual(data);
  });
});
