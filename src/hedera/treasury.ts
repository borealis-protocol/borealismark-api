/**
 * Hedera Treasury Management — 3-Account Structure
 *
 * CORE PRINCIPLE: BorealisMark is the data layer, not the risk layer.
 *
 * Account 1: OPERATIONS_TREASURY — Receive-only address for platform revenue (fees, subscriptions)
 *            Secured by Tangem hardware wallet. No private key needed by the API.
 * Account 2: TRUST_ESCROW — Receive-only address for agent trust deposits (segregated from operations)
 *            Secured by Tangem hardware wallet. No private key needed by the API.
 * Account 3: GAS_WALLET — Software wallet for HBAR HCS transaction fee signing
 *            This is the ONLY account the API signs transactions with.
 *
 * This segregation is required for:
 * - CRA compliance (customer funds vs operating revenue)
 * - Audit trail (which funds belong to whom)
 * - Security (compromise of gas wallet doesn't expose treasury or escrow)
 *
 * Env vars:
 *   HEDERA_OPS_ACCOUNT_ID                                (receive-only, no key needed)
 *   HEDERA_ESCROW_ACCOUNT_ID                             (receive-only, no key needed)
 *   HEDERA_GAS_ACCOUNT_ID, HEDERA_GAS_PRIVATE_KEY        (signing wallet, key REQUIRED)
 *   HEDERA_ACCOUNT_ID, HEDERA_PRIVATE_KEY                (legacy fallbacks for gas wallet)
 */

import { logger } from '../middleware/logger';

export interface TreasuryConfig {
  operations: { accountId: string; configured: boolean };
  escrow: { accountId: string; configured: boolean };
  gas: { accountId: string; configured: boolean };
}

export function getTreasuryConfig(): TreasuryConfig {
  return {
    operations: {
      accountId: process.env.HEDERA_OPS_ACCOUNT_ID || 'NOT_CONFIGURED',
      // Ops is receive-only (Tangem hardware wallet) — only needs account ID
      configured: !!process.env.HEDERA_OPS_ACCOUNT_ID,
    },
    escrow: {
      accountId: process.env.HEDERA_ESCROW_ACCOUNT_ID || 'NOT_CONFIGURED',
      // Escrow is receive-only (Tangem hardware wallet) — only needs account ID
      configured: !!process.env.HEDERA_ESCROW_ACCOUNT_ID,
    },
    gas: {
      accountId: process.env.HEDERA_GAS_ACCOUNT_ID || process.env.HEDERA_ACCOUNT_ID || 'NOT_CONFIGURED',
      // Gas wallet requires BOTH account ID and private key (it signs HCS transactions)
      configured: !!(
        (process.env.HEDERA_GAS_ACCOUNT_ID || process.env.HEDERA_ACCOUNT_ID) &&
        (process.env.HEDERA_GAS_PRIVATE_KEY || process.env.HEDERA_PRIVATE_KEY)
      ),
    },
  };
}

/**
 * Validate that treasury accounts are configured.
 *
 * Gas wallet: ALWAYS required (signs HCS transactions) — needs account ID + private key.
 * Operations: Required in production — receive-only address (no private key needed).
 * Escrow: Required in production — receive-only address (no private key needed).
 *
 * Ops and Escrow are secured by Tangem hardware wallet — the API never signs from them.
 */
export function validateTreasuryAccounts(): { valid: boolean; errors: string[]; warnings: string[] } {
  const config = getTreasuryConfig();
  const errors: string[] = [];
  const warnings: string[] = [];
  const isProd = process.env.NODE_ENV === 'production';

  // Gas wallet is critical — it's the only account the API signs with
  if (!config.gas.configured) {
    errors.push('Gas wallet not configured (HEDERA_GAS_ACCOUNT_ID + HEDERA_GAS_PRIVATE_KEY required for HCS signing)');
  }

  if (isProd) {
    // Ops and Escrow only need account IDs (receive-only addresses)
    if (!config.operations.configured) {
      errors.push('Operations treasury address not configured (HEDERA_OPS_ACCOUNT_ID required in production)');
    }
    if (!config.escrow.configured) {
      errors.push('Trust escrow address not configured (HEDERA_ESCROW_ACCOUNT_ID required in production)');
    }
  } else {
    if (!config.operations.configured) {
      warnings.push('Operations treasury not configured — using gas wallet as fallback (dev only)');
    }
    if (!config.escrow.configured) {
      warnings.push('Trust escrow not configured — trust deposits will not be segregated (dev only)');
    }
  }

  // Security check: ensure accounts are different in production
  if (isProd && config.operations.accountId === config.escrow.accountId) {
    errors.push('CRITICAL: Operations and Escrow accounts must be different in production (fund segregation requirement)');
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Get the appropriate account for a given operation type.
 */
export function getAccountForOperation(operation: 'platform_fee' | 'trust_deposit' | 'trust_penalty' | 'hcs_anchor' | 'certificate_fee'): { accountId: string; privateKey: string } | null {
  switch (operation) {
    case 'platform_fee':
    case 'certificate_fee':
    case 'trust_penalty':
      // Revenue goes to operations treasury
      return {
        accountId: process.env.HEDERA_OPS_ACCOUNT_ID || process.env.HEDERA_ACCOUNT_ID || '',
        privateKey: process.env.HEDERA_OPS_PRIVATE_KEY || process.env.HEDERA_PRIVATE_KEY || '',
      };

    case 'trust_deposit':
      // Deposits go to escrow (segregated)
      return {
        accountId: process.env.HEDERA_ESCROW_ACCOUNT_ID || process.env.HEDERA_ACCOUNT_ID || '',
        privateKey: process.env.HEDERA_ESCROW_PRIVATE_KEY || process.env.HEDERA_PRIVATE_KEY || '',
      };

    case 'hcs_anchor':
      // HCS operations use gas wallet
      return {
        accountId: process.env.HEDERA_GAS_ACCOUNT_ID || process.env.HEDERA_ACCOUNT_ID || '',
        privateKey: process.env.HEDERA_GAS_PRIVATE_KEY || process.env.HEDERA_PRIVATE_KEY || '',
      };

    default:
      return null;
  }
}
