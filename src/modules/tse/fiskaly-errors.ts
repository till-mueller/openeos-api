/**
 * Interpret the error shape thrown by the fiskaly provider's request()
 * helper -- messages of the form
 *   `fiskaly <METHOD> <path> failed: <status> <body>`
 * (see FiskalyTseProvider.request). Network-level failures surface as
 * TypeError / fetch errors with no status at all. This turns either into
 * the structured fields stored on the payment's tseData failure marker
 * (`errorCode`, `httpStatus`, `failedAt`) and used in log lines, so a
 * signing failure can be diagnosed from logs or the DB alone.
 */

export interface FiskalyFailure {
  httpStatus?: number;
  fiskalyCode?: string;
  /** Human-readable reason -- the raw error message, never a guess. */
  failureReason: string;
}

/** fiskaly body codes whose meaning is actionable enough to remap. */
const CODE_REMAPS: Record<string, string> = {
  E_TSS_CREATED: 'TSS_NOT_INITIALIZED',
  E_ADMIN_NOT_AUTHENTICATED: 'TSE_ADMIN_AUTH',
};

export function parseFiskalyFailure(error: unknown): FiskalyFailure {
  const message = error instanceof Error ? error.message : String(error);

  // Shape: "fiskaly PUT /tss/x/client/y failed: 400 {...}"
  const match = / failed: (\d{3}) (.*)$/s.exec(message);
  if (!match) {
    // No HTTP status: a transport-level failure (or a non-provider error).
    return { failureReason: message };
  }

  const httpStatus = Number(match[1]);
  const body = match[2];

  let fiskalyCode: string | undefined;
  try {
    const parsed = JSON.parse(body) as { code?: string };
    if (parsed.code) fiskalyCode = parsed.code;
  } catch {
    // Body isn't JSON -- keep the raw body as the reason instead.
  }

  return { httpStatus, fiskalyCode, failureReason: message };
}

export function mapTseErrorCode(
  fiskalyCode: string | undefined,
  httpStatus: number | undefined,
): string {
  if (fiskalyCode && CODE_REMAPS[fiskalyCode]) return CODE_REMAPS[fiskalyCode];
  if (fiskalyCode) return fiskalyCode;
  if (httpStatus !== undefined) return `HTTP_${httpStatus}`;
  return 'NETWORK';
}