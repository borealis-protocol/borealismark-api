/**
 * Exchange Rate Service — CAD → USDC live conversion
 *
 * Uses CoinGecko free API (no auth) with a 5-minute cache.
 * Fallback rate is applied if the API is unreachable.
 * All USDC amounts use 6 decimal precision (USDC standard).
 */

import { getCachedExchangeRate, setCachedExchangeRate } from '../db/database';
import { logger } from '../middleware/logger';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FALLBACK_CAD_TO_USD = 0.73;    // 1 CAD ≈ 0.73 USD (USDC pegged to USD)
const USDC_DECIMALS = 6;

interface ConversionRate {
  rate: number;       // CAD → USDC (e.g. 0.73 means 1 CAD = 0.73 USDC)
  source: string;     // 'coingecko' | 'fallback'
  timestamp: number;  // when the rate was fetched
}

interface ConversionResult {
  cadAmount: number;
  usdcAmount: number;
  rate: number;
  source: string;
  timestamp: number;
}

/**
 * Fetch current CAD → USD rate from CoinGecko.
 * CoinGecko returns how many CAD per 1 USD; we invert it.
 */
async function fetchRateFromCoinGecko(): Promise<{ rate: number; source: string } | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=cad',
      {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      },
    );
    clearTimeout(timeoutId);

    if (!response.ok) {
      logger.warn(`CoinGecko API returned ${response.status}`);
      return null;
    }

    const data = await response.json() as { 'usd-coin'?: { cad?: number } };
    const cadPerUsdc = data['usd-coin']?.cad;

    if (!cadPerUsdc || cadPerUsdc <= 0) {
      logger.warn('CoinGecko returned invalid USDC/CAD rate');
      return null;
    }

    // cadPerUsdc = how many CAD per 1 USDC (e.g. 1.37)
    // We need CAD → USDC, so: 1 CAD = 1 / cadPerUsdc USDC
    const cadToUsdc = 1 / cadPerUsdc;

    return { rate: cadToUsdc, source: 'coingecko' };
  } catch (err) {
    logger.warn(`CoinGecko fetch failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Get the current CAD → USDC conversion rate.
 * Uses cached value if within TTL, otherwise fetches from CoinGecko.
 * Falls back to a hardcoded rate if the API is unreachable.
 */
export async function getConversionRate(): Promise<ConversionRate> {
  // Check cache first
  const cached = getCachedExchangeRate('CAD', 'USDC');
  if (cached) {
    return {
      rate: cached.rate,
      source: cached.source,
      timestamp: cached.fetchedAt,
    };
  }

  // Fetch fresh rate from CoinGecko
  const fresh = await fetchRateFromCoinGecko();
  if (fresh) {
    setCachedExchangeRate('CAD', 'USDC', fresh.rate, fresh.source, CACHE_TTL_MS);
    return {
      rate: fresh.rate,
      source: fresh.source,
      timestamp: Date.now(),
    };
  }

  // Fallback
  logger.warn('Using fallback CAD→USDC rate');
  return {
    rate: FALLBACK_CAD_TO_USD,
    source: 'fallback',
    timestamp: Date.now(),
  };
}

/**
 * Convert a CAD amount to USDC with 6-decimal precision.
 */
export async function convertCadToUsdc(cadAmount: number): Promise<ConversionResult> {
  const { rate, source, timestamp } = await getConversionRate();
  const rawUsdc = cadAmount * rate;
  const usdcAmount = Math.round(rawUsdc * 10 ** USDC_DECIMALS) / 10 ** USDC_DECIMALS;

  return {
    cadAmount,
    usdcAmount,
    rate,
    source,
    timestamp,
  };
}

/**
 * Round a USDC amount to 6 decimal places (USDC standard).
 */
export function roundUsdc(amount: number): number {
  return Math.round(amount * 10 ** USDC_DECIMALS) / 10 ** USDC_DECIMALS;
}
