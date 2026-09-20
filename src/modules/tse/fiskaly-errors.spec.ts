import { describe, it, expect } from '@jest/globals';
import { parseFiskalyFailure, mapTseErrorCode } from './fiskaly-errors';

describe('fiskaly-errors', () => {
  describe('parseFiskalyFailure', () => {
    it('extracts httpStatus and fiskaly code from a request() error message', () => {
      const parsed = parseFiskalyFailure(
        new Error('fiskaly PUT /tss/x/client/y failed: 400 {"code":"E_TSS_CREATED","message":"TSS must be in state UNINITIALIZED or INITIALIZED"}'),
      );
      expect(parsed.httpStatus).toBe(400);
      expect(parsed.fiskalyCode).toBe('E_TSS_CREATED');
      expect(parsed.failureReason).toContain('E_TSS_CREATED');
    });

    it('extracts only httpStatus when the body has no code', () => {
      const parsed = parseFiskalyFailure(new Error('fiskaly GET /tss/x failed: 404 {}'));
      expect(parsed.httpStatus).toBe(404);
      expect(parsed.fiskalyCode).toBeUndefined();
    });

    it('detects a network failure (no status) as NETWORK', () => {
      const parsed = parseFiskalyFailure(new TypeError('fetch failed'));
      expect(parsed.httpStatus).toBeUndefined();
      expect(parsed.fiskalyCode).toBeUndefined();
      expect(parsed.failureReason).toContain('fetch failed');
    });

    it('falls back to the message for anything without a status', () => {
      const parsed = parseFiskalyFailure(new Error('unrelated failure'));
      expect(parsed.httpStatus).toBeUndefined();
      expect(parsed.fiskalyCode).toBeUndefined();
      expect(parsed.failureReason).toBe('unrelated failure');
    });
  });

  describe('mapTseErrorCode', () => {
    it('maps E_TSS_CREATED to TSS_NOT_INITIALIZED', () => {
      expect(mapTseErrorCode('E_TSS_CREATED', 400)).toBe('TSS_NOT_INITIALIZED');
    });
    it('maps E_ADMIN_NOT_AUTHENTICATED to TSE_ADMIN_AUTH', () => {
      expect(mapTseErrorCode('E_ADMIN_NOT_AUTHENTICATED', 401)).toBe('TSE_ADMIN_AUTH');
    });
    it('passes through raw fiskaly codes', () => {
      expect(mapTseErrorCode('E_OTHER', 400)).toBe('E_OTHER');
    });
    it('builds HTTP_<status> when only a status exists', () => {
      expect(mapTseErrorCode(undefined, 404)).toBe('HTTP_404');
    });
    it('uses NETWORK when there is no status', () => {
      expect(mapTseErrorCode(undefined, undefined)).toBe('NETWORK');
    });
  });
});