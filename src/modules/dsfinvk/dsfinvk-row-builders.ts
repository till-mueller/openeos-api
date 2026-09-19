import { OrganizationSettings } from '../../database/entities/organization.entity';
import { DeviceSettings } from '../../database/entities/device.entity';
import { TseTransactionData } from '../../database/entities/payment.entity';
import {
  TAX_RATES_BY_COUNTRY,
  TAX_RATE_EXEMPT,
} from '../../common/constants/tax-rates';
import {
  UstSchluessel,
  ustSchluesselFor,
} from '../../common/constants/dsfinvk-ust-schluessel';
import { DsfinvkRow } from './dsfinvk-csv-writer';

/**
 * Every DSFinV-K table is keyed to one Kassenabschluss (cash-closing period)
 * via Z_KASSE_ID/Z_ERSTELLUNG/Z_NR. openEOS has no "Kassenabschluss" concept
 * yet -- what one export period actually corresponds to (per Event? per
 * day? per explicit export request?) is a design decision for whoever wires
 * these builders into a real export flow, not something to guess here. The
 * caller supplies it explicitly so these row builders stay correct
 * regardless of how that's eventually decided.
 */
export interface ClosingContext {
  kasseId: string;
  erstellung: string;
  zNr: number;
}

function closingKey(
  ctx: ClosingContext,
): Pick<DsfinvkRow, 'Z_KASSE_ID' | 'Z_ERSTELLUNG' | 'Z_NR'> {
  return {
    Z_KASSE_ID: ctx.kasseId,
    Z_ERSTELLUNG: ctx.erstellung,
    Z_NR: ctx.zNr,
  };
}

/**
 * LOC_LAND requires ISO 3166 ALPHA-3 (e.g. "DEU"), but openEOS stores
 * country as a free-form alpha-2-ish string (see tax-rates.ts's country
 * keys). openEOS only supports Germany today, so DE is the only case that
 * matters -- anything else is passed through unconverted rather than
 * guessed, so a wrong code is visibly wrong instead of silently plausible.
 */
const ALPHA2_TO_ALPHA3: Record<string, string> = { DE: 'DEU' };

function toAlpha3CountryCode(country: string): string {
  return ALPHA2_TO_ALPHA3[country.toUpperCase()] ?? country;
}

/** location.csv: openEOS models one location per organization -- confirm this holds before a v1 export. */
export function buildLocationRow(
  ctx: ClosingContext,
  org: { name: string; settings: OrganizationSettings },
): DsfinvkRow {
  const address = org.settings.address;
  return {
    ...closingKey(ctx),
    LOC_NAME: org.name,
    LOC_STRASSE: address?.street ?? '',
    LOC_PLZ: address?.zip ?? '',
    LOC_ORT: address?.city ?? '',
    LOC_LAND: address?.country ? toAlpha3CountryCode(address.country) : 'DEU',
    LOC_USTID: org.settings.taxId ?? '',
  };
}

/**
 * cashregister.csv: openEOS is EUR-only, so KASSE_BASISWAEH_CODE is always
 * 'EUR'. KEINE_UST_ZUORDNUNG flags a till whose VAT can only be determined
 * once a later payment arrives (invoicing/Anzahlung) -- openEOS has no such
 * feature (see plan's out-of-scope list), so it's always '0'.
 */
export function buildCashregisterRow(
  ctx: ClosingContext,
  device: { settings: DeviceSettings },
): DsfinvkRow {
  return {
    ...closingKey(ctx),
    KASSE_BRAND: device.settings.kasseBrand ?? '',
    KASSE_MODELL: device.settings.kasseModell ?? '',
    KASSE_SERIENNR: device.settings.kasseSeriennr ?? '',
    KASSE_SW_BRAND: device.settings.kasseSwBrand ?? '',
    KASSE_SW_VERSION: device.settings.kasseSwVersion ?? '',
    KASSE_BASISWAEH_CODE: 'EUR',
    KEINE_UST_ZUORDNUNG: '0',
  };
}

/**
 * vat.csv: one row per tax rate the organization can charge. Lists every
 * configured rate, not only ones used in the period -- DSFinV-K doesn't
 * distinguish "declared" from "used" for this table, and openEOS's rate set
 * per org is small and fixed (see tax-rates.ts).
 */
export function buildVatRows(
  ctx: ClosingContext,
  org: { settings: OrganizationSettings },
  country: string,
): DsfinvkRow[] {
  const rates = org.settings.vatExempt
    ? TAX_RATE_EXEMPT
    : (TAX_RATES_BY_COUNTRY[country.toUpperCase()] ?? TAX_RATE_EXEMPT);
  return rates.map((rate) => {
    const schluessel = ustSchluesselFor(rate.rate, org.settings.vatExempt);
    const beschr =
      schluessel === UstSchluessel.ALLGEMEIN
        ? 'Regelsteuersatz'
        : schluessel === UstSchluessel.ERMAESSIGT
          ? 'Ermaessigter Steuersatz'
          : schluessel === UstSchluessel.UMSATZSTEUERFREI
            ? 'Umsatzsteuerfrei'
            : 'Nicht steuerbar';
    return {
      ...closingKey(ctx),
      UST_SCHLUESSEL: schluessel,
      UST_SATZ: rate.rate,
      UST_BESCHR: beschr,
    };
  });
}

/**
 * transactions_tse.csv: near-direct mapping from Payment.tseData -- the
 * lowest-risk file in the export, the data already exists in exactly the
 * shape this table wants. TSE_ID is hardcoded to 1: openEOS registers one
 * TSE per organization (see plan's slaves.csv note), so there is only ever
 * one to number.
 */
export function buildTransactionsTseRow(
  ctx: ClosingContext,
  bonId: string,
  tseData: TseTransactionData,
): DsfinvkRow {
  return {
    ...closingKey(ctx),
    BON_ID: bonId,
    TSE_ID: 1,
    TSE_TANR: tseData.transactionNumber,
    TSE_TA_START: tseData.startTime,
    TSE_TA_ENDE: tseData.endTime,
    TSE_TA_VORGANGSART: tseData.processType,
    TSE_TA_SIGZ: tseData.signatureCounter,
    TSE_TA_SIG: tseData.signatureValue,
    TSE_TA_FEHLER: tseData.failureReason ?? '',
    TSE_VORGANGSDATEN: tseData.processData,
  };
}
