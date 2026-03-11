/**
 * BorealisMark — Marketplace Orders Router
 *
 * Handles cart management, checkout (escrow-based), order lifecycle,
 * shipping, delivery confirmation, settlement, and ratings.
 *
 * Escrow Model:
 *   1. Buyer deposits full item price in USDC
 *   2. Seller deposits 25% trust bond in USDC
 *   3. Both deposits verified via Hedera Mirror Node
 *   4. Seller ships item with tracking
 *   5. Buyer confirms delivery → settlement triggered
 *   6. Settlement: buyer deposit → seller (minus 2.5% fee), seller bond → returned
 *   7. Immutable proof anchored on HCS
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { requireAuth, type AuthRequest } from './auth';
import {
  getDb,
  addToCart,
  getCartItems,
  removeFromCart,
  clearCart,
  createOrder,
  getOrderById,
  getOrdersByUser,
  updateOrderStatus,
  createEscrowDeposit,
  getEscrowDeposits,
  confirmEscrowDeposit,
  settleEscrowDeposits,
  getUserById,
  computeAndStoreTrustScore,
  getTrustScore,
} from '../db/database';
import { convertCadToUsdc, getConversionRate, roundUsdc } from '../services/exchangeRates';
import { TREASURY_ACCOUNT_ID, USDC_TOKEN_ID } from '../hedera/usdc';
import { logger } from '../middleware/logger';
import {
  sendSellerDepositRequestEmail,
  sendShippedEmail,
  sendSettlementCompleteEmail,
} from '../services/email';

const router = Router();

// ─── Constants ─────────────────────────────────────────────────────────────────

// Tier-based transaction fees (advertised in Agent Plans)
const PLATFORM_FEE_BY_TIER: Record<string, number> = {
  standard: 2.5,
  pro: 2.5,
  elite: 1.5,
  enterprise: 1.0,
};
const DEFAULT_FEE_PERCENT = 2.5;
const SELLER_BOND_PERCENT = 25;
const ESCROW_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes to complete each deposit

// ─── Helpers ───────────────────────────────────────────────────────────────────

function generateMemo(orderId: string, party: 'buyer' | 'seller'): string {
  const ts = Math.floor(Date.now() / 1000);
  return `BM-MKT:${orderId.slice(0, 8)}:${party}:${ts}`;
}

// ─── Exchange Rate (public) ────────────────────────────────────────────────────

/**
 * GET /exchange-rate
 * Returns current CAD→USDC conversion rate for frontend display.
 */
router.get('/exchange-rate', async (_req: Request, res: Response) => {
  try {
    const rate = await getConversionRate();
    res.json({
      success: true,
      data: {
        fromCurrency: 'CAD',
        toCurrency: 'USDC',
        rate: rate.rate,
        source: rate.source,
        timestamp: rate.timestamp,
        expiresIn: '5 minutes',
      },
    });
  } catch (err: any) {
    logger.error('Exchange rate fetch failed', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch exchange rate' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CART ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /cart/add
 * Add a listing to the user's cart.
 */
router.post('/cart/add', requireAuth, (req: Request, res: Response) => {
  const user = (req as AuthRequest).user!;
  const { listingId } = req.body;

  if (!listingId) {
    res.status(400).json({ success: false, error: 'listingId is required' });
    return;
  }

  // Validate listing exists and is published
  const listing = getDb()
    .prepare('SELECT id, user_id, status, price_cad, price_usdc FROM marketplace_listings WHERE id = ?')
    .get(listingId) as { id: string; user_id: string; status: string; price_cad: number; price_usdc: number } | undefined;

  if (!listing) {
    res.status(404).json({ success: false, error: 'Listing not found' });
    return;
  }
  if (listing.status !== 'published') {
    res.status(400).json({ success: false, error: 'Listing is not available for purchase' });
    return;
  }
  if (listing.user_id === user.sub) {
    res.status(400).json({ success: false, error: 'Cannot purchase your own listing' });
    return;
  }

  try {
    addToCart(user.sub, listingId);
    res.json({ success: true, message: 'Added to cart' });
  } catch (err: any) {
    logger.error('Add to cart failed', { error: err.message, userId: user.sub, listingId });
    res.status(500).json({ success: false, error: 'Failed to add to cart' });
  }
});

/**
 * GET /cart
 * Get all items in the user's cart with live CAD→USDC conversion.
 */
router.get('/cart', requireAuth, async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user!;

  try {
    const items = getCartItems(user.sub);
    const { rate, source, timestamp } = await getConversionRate();

    let subtotalCad = 0;
    let shippingTotalCad = 0;

    const cartItems = items.map(item => {
      const priceCad = (item.price_cad as number) || 0;
      const shippingCad = (item.shipping_cost_cad as number) || 0;
      const qty = (item.quantity as number) || 1;
      subtotalCad += priceCad * qty;
      shippingTotalCad += shippingCad * qty;

      return {
        id: item.id,
        listingId: item.listing_id,
        quantity: qty,
        title: item.title,
        priceCad: priceCad,
        shippingCostCad: shippingCad,
        images: JSON.parse((item.images as string) || '[]'),
        sellerName: item.seller_name,
        sellerId: item.seller_id,
        condition: item.condition,
        platform: item.platform,
      };
    });

    const totalCad = subtotalCad + shippingTotalCad;
    const totalUsdc = roundUsdc(totalCad * rate);

    res.json({
      success: true,
      data: {
        items: cartItems,
        summary: {
          itemCount: cartItems.length,
          subtotalCad: Math.round(subtotalCad * 100) / 100,
          shippingCad: Math.round(shippingTotalCad * 100) / 100,
          totalCad: Math.round(totalCad * 100) / 100,
          totalUsdc,
          exchangeRate: rate,
          rateSource: source,
          rateTimestamp: timestamp,
        },
      },
    });
  } catch (err: any) {
    logger.error('Get cart failed', { error: err.message, userId: user.sub });
    res.status(500).json({ success: false, error: 'Failed to fetch cart' });
  }
});

/**
 * DELETE /cart/:listingId
 * Remove a specific item from the cart.
 */
router.delete('/cart/:listingId', requireAuth, (req: Request, res: Response) => {
  const user = (req as AuthRequest).user!;
  const removed = removeFromCart(user.sub, req.params.listingId);
  res.json({ success: true, removed });
});

/**
 * DELETE /cart
 * Clear entire cart.
 */
router.delete('/cart', requireAuth, (req: Request, res: Response) => {
  const user = (req as AuthRequest).user!;
  const count = clearCart(user.sub);
  res.json({ success: true, clearedCount: count });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CHECKOUT
// ═══════════════════════════════════════════════════════════════════════════════

const ShippingAddressSchema = z.object({
  name: z.string().min(1).max(200),
  street: z.string().min(1).max(500),
  city: z.string().min(1).max(200),
  province: z.string().min(1).max(200),
  postalCode: z.string().min(1).max(20),
  country: z.string().min(1).max(100).default('Canada'),
});

/**
 * POST /checkout
 * Convert cart → order(s), lock in exchange rate, return USDC payment instructions.
 * Creates one order per seller (group items by seller).
 */
router.post('/checkout', requireAuth, async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user!;

  // Validate shipping address
  const addrResult = ShippingAddressSchema.safeParse(req.body.shippingAddress);
  if (!addrResult.success) {
    res.status(400).json({
      success: false,
      error: 'Valid shipping address required',
      details: addrResult.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    const items = getCartItems(user.sub);
    if (items.length === 0) {
      res.status(400).json({ success: false, error: 'Cart is empty' });
      return;
    }

    // Lock in exchange rate for all orders in this checkout
    const conversion = await getConversionRate();
    const rate = conversion.rate;
    const conversionTimestamp = Date.now();

    // Group items by seller
    const sellerGroups = new Map<string, typeof items>();
    for (const item of items) {
      const sellerId = item.seller_id as string;
      if (!sellerGroups.has(sellerId)) sellerGroups.set(sellerId, []);
      sellerGroups.get(sellerId)!.push(item);
    }

    const orders: Array<{
      orderId: string;
      sellerId: string;
      sellerName: string;
      items: Array<{ listingId: string; title: string; priceCad: number; shippingCostCad: number }>;
      totalCad: number;
      totalUsdc: number;
      buyerDepositUsdc: number;
      sellerBondUsdc: number;
      buyerMemo: string;
      treasuryAccountId: string;
      tokenId: string;
      expiresAt: number;
    }> = [];

    for (const [sellerId, sellerItems] of sellerGroups) {
      // For each seller, create one order per listing (escrow is per-listing)
      for (const item of sellerItems) {
        const orderId = uuid();
        const priceCad = (item.price_cad as number) || 0;
        const shippingCad = (item.shipping_cost_cad as number) || 0;
        const totalCad = priceCad + shippingCad;
        const totalUsdc = roundUsdc(totalCad * rate);
        const sellerBondUsdc = roundUsdc(totalUsdc * SELLER_BOND_PERCENT / 100);

        const buyerMemo = generateMemo(orderId, 'buyer');
        const sellerMemo = generateMemo(orderId, 'seller');

        // Create order in database
        createOrder({
          id: orderId,
          listingId: item.listing_id as string,
          buyerId: user.sub,
          sellerId: sellerId,
          itemPriceCad: priceCad,
          shippingCostCad: shippingCad,
          totalCad,
          exchangeRate: rate,
          totalUsdc,
          conversionTimestamp,
          buyerDepositMemo: buyerMemo,
          sellerDepositMemo: sellerMemo,
          shippingAddress: JSON.stringify(addrResult.data),
        });

        // Create escrow deposit records
        createEscrowDeposit(orderId, 'buyer', user.sub, totalUsdc, buyerMemo);
        createEscrowDeposit(orderId, 'seller', sellerId, sellerBondUsdc, sellerMemo);

        orders.push({
          orderId,
          sellerId,
          sellerName: (item.seller_name as string) || 'Unknown',
          items: [{
            listingId: item.listing_id as string,
            title: item.title as string,
            priceCad,
            shippingCostCad: shippingCad,
          }],
          totalCad,
          totalUsdc,
          buyerDepositUsdc: totalUsdc,
          sellerBondUsdc,
          buyerMemo,
          treasuryAccountId: TREASURY_ACCOUNT_ID,
          tokenId: USDC_TOKEN_ID,
          expiresAt: conversionTimestamp + ESCROW_EXPIRY_MS,
        });
      }
    }

    // Clear the cart after successful checkout
    clearCart(user.sub);

    logger.info('Checkout completed', {
      userId: user.sub,
      orderCount: orders.length,
      totalUsdc: orders.reduce((sum, o) => sum + o.totalUsdc, 0),
    });

    res.json({
      success: true,
      data: {
        orders,
        exchangeRate: rate,
        rateSource: conversion.source,
        instructions: {
          step1: 'Send the exact USDC amount to the treasury account with the provided memo',
          step2: 'Click "Verify Payment" after sending — we check Hedera Mirror Node',
          step3: 'Seller will be notified to deposit their 25% trust bond',
          step4: 'Once both deposits are confirmed, seller ships the item',
          expiresIn: '30 minutes',
        },
      },
    });
  } catch (err: any) {
    logger.error('Checkout failed', { error: err.message, userId: user.sub });
    res.status(500).json({ success: false, error: 'Checkout failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ESCROW PAYMENT VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /orders/:id/verify-buyer-payment
 * Buyer calls this after sending USDC. Verifies via Hedera Mirror Node.
 */
router.post('/orders/:id/verify-buyer-payment', requireAuth, async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user!;
  const orderId = req.params.id;

  const order = getOrderById(orderId);
  if (!order) {
    res.status(404).json({ success: false, error: 'Order not found' });
    return;
  }
  if (order.buyer_id !== user.sub) {
    res.status(403).json({ success: false, error: 'Not authorized' });
    return;
  }
  if (order.status !== 'pending_payment') {
    res.status(400).json({ success: false, error: `Order status is ${order.status}, expected pending_payment` });
    return;
  }

  try {
    // Find buyer's escrow deposit record
    const deposits = getEscrowDeposits(orderId);
    const buyerDeposit = deposits.find(d => d.party === 'buyer' && d.status === 'pending');
    if (!buyerDeposit) {
      res.status(400).json({ success: false, error: 'No pending buyer deposit found' });
      return;
    }

    // Verify on Hedera Mirror Node
    const verified = await verifyEscrowDeposit(
      buyerDeposit.memo as string,
      buyerDeposit.amount_usdc as number,
    );

    if (!verified) {
      res.json({
        success: true,
        data: { verified: false, message: 'Payment not yet detected. Please wait a few moments and try again.' },
      });
      return;
    }

    // Confirm the deposit
    confirmEscrowDeposit(buyerDeposit.id as string, verified.transactionId);
    updateOrderStatus(orderId, 'buyer_deposited', {
      buyer_deposit_confirmed_at: Date.now(),
    });

    logger.info('Buyer escrow deposit confirmed', {
      orderId,
      transactionId: verified.transactionId,
      amount: buyerDeposit.amount_usdc,
    });

    // v39: Send email to seller requesting their 25% bond deposit + buyer trust score
    try {
      const sellerUser = getUserById(order.seller_id as string);
      const buyerUser = getUserById(user.sub);
      if (sellerUser) {
        const listing = getDb().prepare('SELECT title, price_cad FROM marketplace_listings WHERE id = ?').get(order.listing_id) as any;
        const sellerDeposits = getEscrowDeposits(orderId);
        const sellerDep = sellerDeposits.find(d => d.party === 'seller');
        const bondUsdc = sellerDep ? (sellerDep.amount_usdc as number) : (buyerDeposit.amount_usdc as number) * 0.25;
        sendSellerDepositRequestEmail(
          sellerUser.email,
          {
            orderId,
            listingTitle: listing?.title ?? 'Marketplace Item',
            totalCad: listing?.price_cad ?? 0,
            totalUsdc: buyerDeposit.amount_usdc as number,
            buyerName: buyerUser?.name ?? 'Buyer',
            sellerName: sellerUser.name ?? sellerUser.email,
            bondUsdc,
            memo: (sellerDep?.memo as string) ?? `order-seller-${orderId}`,
            treasuryAccountId: TREASURY_ACCOUNT_ID,
          },
        ).catch(err => logger.error('Failed to send seller deposit email', { error: err.message }));
      }
    } catch (emailErr: any) {
      logger.error('Seller deposit email error', { error: emailErr.message });
    }

    res.json({
      success: true,
      data: {
        verified: true,
        transactionId: verified.transactionId,
        message: 'Payment confirmed! Seller has been notified to deposit their trust bond.',
        orderStatus: 'buyer_deposited',
      },
    });
  } catch (err: any) {
    logger.error('Buyer payment verification failed', { error: err.message, orderId });
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

/**
 * POST /orders/:id/seller-deposit-init
 * Seller calls this to get their bond payment instructions.
 */
router.post('/orders/:id/seller-deposit-init', requireAuth, (req: Request, res: Response) => {
  const user = (req as AuthRequest).user!;
  const orderId = req.params.id;

  const order = getOrderById(orderId);
  if (!order) {
    res.status(404).json({ success: false, error: 'Order not found' });
    return;
  }
  if (order.seller_id !== user.sub) {
    res.status(403).json({ success: false, error: 'Not authorized' });
    return;
  }
  if (order.status !== 'buyer_deposited') {
    res.status(400).json({ success: false, error: `Order status is ${order.status}, expected buyer_deposited` });
    return;
  }

  const deposits = getEscrowDeposits(orderId);
  const sellerDeposit = deposits.find(d => d.party === 'seller');

  if (!sellerDeposit) {
    res.status(500).json({ success: false, error: 'Seller deposit record not found' });
    return;
  }

  res.json({
    success: true,
    data: {
      orderId,
      bondAmount: sellerDeposit.amount_usdc,
      memo: sellerDeposit.memo,
      treasuryAccountId: TREASURY_ACCOUNT_ID,
      tokenId: USDC_TOKEN_ID,
      instructions: 'Send the exact USDC bond amount to the treasury account with the provided memo. This 25% trust bond will be returned to you after the buyer confirms delivery.',
    },
  });
});

/**
 * POST /orders/:id/verify-seller-deposit
 * Seller calls this after sending their trust bond USDC.
 */
router.post('/orders/:id/verify-seller-deposit', requireAuth, async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user!;
  const orderId = req.params.id;

  const order = getOrderById(orderId);
  if (!order) {
    res.status(404).json({ success: false, error: 'Order not found' });
    return;
  }
  if (order.seller_id !== user.sub) {
    res.status(403).json({ success: false, error: 'Not authorized' });
    return;
  }
  if (order.status !== 'buyer_deposited') {
    res.status(400).json({ success: false, error: `Order status is ${order.status}, expected buyer_deposited` });
    return;
  }

  try {
    const deposits = getEscrowDeposits(orderId);
    const sellerDeposit = deposits.find(d => d.party === 'seller' && d.status === 'pending');
    if (!sellerDeposit) {
      res.status(400).json({ success: false, error: 'No pending seller deposit found' });
      return;
    }

    const verified = await verifyEscrowDeposit(
      sellerDeposit.memo as string,
      sellerDeposit.amount_usdc as number,
    );

    if (!verified) {
      res.json({
        success: true,
        data: { verified: false, message: 'Deposit not yet detected. Please wait and try again.' },
      });
      return;
    }

    confirmEscrowDeposit(sellerDeposit.id as string, verified.transactionId);
    updateOrderStatus(orderId, 'escrow_active', {
      seller_deposit_confirmed_at: Date.now(),
    });

    logger.info('Seller trust bond confirmed — escrow active', {
      orderId,
      transactionId: verified.transactionId,
      amount: sellerDeposit.amount_usdc,
    });

    res.json({
      success: true,
      data: {
        verified: true,
        transactionId: verified.transactionId,
        message: 'Trust bond confirmed! Escrow is now active. Please ship the item and add tracking.',
        orderStatus: 'escrow_active',
      },
    });
  } catch (err: any) {
    logger.error('Seller deposit verification failed', { error: err.message, orderId });
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ORDER LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /orders/my
 * Get paginated order history (purchases + sales).
 */
router.get('/orders/my', requireAuth, (req: Request, res: Response) => {
  const user = (req as AuthRequest).user!;
  const role = (req.query.role as string) === 'seller' ? 'seller' : 'buyer';
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const offset = parseInt(req.query.offset as string) || 0;

  try {
    const result = getOrdersByUser(user.sub, role as 'buyer' | 'seller', limit, offset);
    res.json({
      success: true,
      data: {
        orders: result.orders.map(o => ({
          id: o.id,
          listingTitle: o.listing_title,
          listingImages: JSON.parse((o.listing_images as string) || '[]'),
          buyerName: o.buyer_name,
          sellerName: o.seller_name,
          totalCad: o.total_cad,
          totalUsdc: o.total_usdc,
          status: o.status,
          createdAt: o.created_at,
          shippedAt: o.shipped_at,
          completedAt: o.completed_at,
        })),
        total: result.total,
        limit,
        offset,
      },
    });
  } catch (err: any) {
    logger.error('Get orders failed', { error: err.message, userId: user.sub });
    res.status(500).json({ success: false, error: 'Failed to fetch orders' });
  }
});

/**
 * GET /orders/:id
 * Full order detail with escrow status.
 */
router.get('/orders/:id', requireAuth, (req: Request, res: Response) => {
  const user = (req as AuthRequest).user!;
  const orderId = req.params.id;

  const order = getOrderById(orderId);
  if (!order) {
    res.status(404).json({ success: false, error: 'Order not found' });
    return;
  }

  // Only buyer, seller, or admin can view
  if (order.buyer_id !== user.sub && order.seller_id !== user.sub && user.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Not authorized' });
    return;
  }

  const deposits = getEscrowDeposits(orderId);

  res.json({
    success: true,
    data: {
      id: order.id,
      listingId: order.listing_id,
      listingTitle: order.listing_title,
      listingImages: JSON.parse((order.listing_images as string) || '[]'),
      listingCategory: order.listing_category,
      listingCondition: order.listing_condition,
      buyerId: order.buyer_id,
      buyerName: order.buyer_name,
      sellerId: order.seller_id,
      sellerName: order.seller_name,
      sellerStoreName: order.seller_store_name,
      sellerStoreSlug: order.seller_store_slug,
      itemPriceCad: order.item_price_cad,
      shippingCostCad: order.shipping_cost_cad,
      totalCad: order.total_cad,
      exchangeRate: order.exchange_rate,
      totalUsdc: order.total_usdc,
      status: order.status,
      shippingAddress: order.shipping_address ? JSON.parse(order.shipping_address as string) : null,
      shippingCarrier: order.shipping_carrier,
      trackingNumber: order.tracking_number,
      shippedAt: order.shipped_at,
      deliveryConfirmedAt: order.delivery_confirmed_at,
      hederaTransactionId: order.hedera_transaction_id,
      hcsTopicId: order.hcs_topic_id,
      hcsSequenceNumber: order.hcs_sequence_number,
      rating: order.rating,
      ratingComment: order.rating_comment,
      completedAt: order.completed_at,
      settledAt: order.settled_at,
      createdAt: order.created_at,
      escrowDeposits: deposits.map(d => ({
        id: d.id,
        party: d.party,
        amountUsdc: d.amount_usdc,
        status: d.status,
        hederaTransactionId: d.hedera_transaction_id,
        confirmedAt: d.confirmed_at,
      })),
    },
  });
});

/**
 * POST /orders/:id/ship
 * Seller adds tracking info.
 */
router.post('/orders/:id/ship', requireAuth, (req: Request, res: Response) => {
  const user = (req as AuthRequest).user!;
  const orderId = req.params.id;
  const { carrier, trackingNumber } = req.body;

  if (!trackingNumber) {
    res.status(400).json({ success: false, error: 'trackingNumber is required' });
    return;
  }

  const order = getOrderById(orderId);
  if (!order) {
    res.status(404).json({ success: false, error: 'Order not found' });
    return;
  }
  if (order.seller_id !== user.sub) {
    res.status(403).json({ success: false, error: 'Not authorized' });
    return;
  }
  if (order.status !== 'escrow_active') {
    res.status(400).json({ success: false, error: `Order status is ${order.status}, expected escrow_active` });
    return;
  }

  updateOrderStatus(orderId, 'shipped', {
    shipping_carrier: carrier || 'Other',
    tracking_number: trackingNumber,
    shipped_at: Date.now(),
  });

  logger.info('Order shipped', { orderId, carrier, trackingNumber });

  // v39: Send email to buyer with tracking info
  try {
    const buyerUser = getUserById(order.buyer_id as string);
    const sellerUser = getUserById(order.seller_id as string);
    if (buyerUser) {
      const listing = getDb().prepare('SELECT title, price_cad FROM marketplace_listings WHERE id = ?').get(order.listing_id) as any;
      sendShippedEmail(
        buyerUser.email,
        {
          orderId,
          listingTitle: listing?.title ?? 'Marketplace Item',
          totalCad: listing?.price_cad ?? 0,
          totalUsdc: order.total_usdc as number,
          buyerName: buyerUser.name ?? buyerUser.email,
          sellerName: sellerUser?.name ?? 'Seller',
          carrier: carrier || 'Other',
          trackingNumber,
        },
      ).catch(err => logger.error('Failed to send shipped email', { error: err.message }));
    }
  } catch (emailErr: any) {
    logger.error('Shipped email error', { error: emailErr.message });
  }

  res.json({
    success: true,
    message: 'Shipping info recorded. Buyer has been notified.',
    orderStatus: 'shipped',
  });
});

/**
 * POST /orders/:id/confirm-delivery
 * Buyer confirms they received the item → triggers settlement.
 */
router.post('/orders/:id/confirm-delivery', requireAuth, async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user!;
  const orderId = req.params.id;

  const order = getOrderById(orderId);
  if (!order) {
    res.status(404).json({ success: false, error: 'Order not found' });
    return;
  }
  if (order.buyer_id !== user.sub) {
    res.status(403).json({ success: false, error: 'Not authorized' });
    return;
  }
  if (order.status !== 'shipped') {
    res.status(400).json({ success: false, error: `Order status is ${order.status}, expected shipped` });
    return;
  }

  try {
    // Mark delivery confirmed
    updateOrderStatus(orderId, 'delivered', {
      delivery_confirmed_at: Date.now(),
    });

    // Settle escrow
    const settlementResult = await settleOrder(orderId);

    res.json({
      success: true,
      message: 'Delivery confirmed and escrow settled!',
      data: settlementResult,
    });
  } catch (err: any) {
    logger.error('Delivery confirmation / settlement failed', { error: err.message, orderId });
    res.status(500).json({ success: false, error: 'Settlement processing failed' });
  }
});

/**
 * POST /orders/:id/dispute
 * Either party can raise a dispute.
 */
router.post('/orders/:id/dispute', requireAuth, (req: Request, res: Response) => {
  const user = (req as AuthRequest).user!;
  const orderId = req.params.id;
  const { reason } = req.body;

  if (!reason || reason.length < 10) {
    res.status(400).json({ success: false, error: 'Dispute reason must be at least 10 characters' });
    return;
  }

  const order = getOrderById(orderId);
  if (!order) {
    res.status(404).json({ success: false, error: 'Order not found' });
    return;
  }
  if (order.buyer_id !== user.sub && order.seller_id !== user.sub) {
    res.status(403).json({ success: false, error: 'Not authorized' });
    return;
  }

  const validDisputeStatuses = ['escrow_active', 'shipped', 'delivered'];
  if (!validDisputeStatuses.includes(order.status as string)) {
    res.status(400).json({ success: false, error: `Cannot dispute order with status: ${order.status}` });
    return;
  }

  updateOrderStatus(orderId, 'disputed', {
    dispute_reason: reason,
    dispute_raised_by: user.sub,
    dispute_raised_at: Date.now(),
  });

  logger.warn('Order disputed', { orderId, raisedBy: user.sub, reason });

  res.json({
    success: true,
    message: 'Dispute raised. Both escrow deposits are frozen pending resolution.',
    orderStatus: 'disputed',
  });
});

/**
 * POST /orders/:id/rate
 * Buyer rates the seller (1-5 stars + optional comment).
 */
router.post('/orders/:id/rate', requireAuth, (req: Request, res: Response) => {
  const user = (req as AuthRequest).user!;
  const orderId = req.params.id;
  const { rating, comment } = req.body;

  if (!rating || rating < 1 || rating > 5) {
    res.status(400).json({ success: false, error: 'Rating must be between 1 and 5' });
    return;
  }

  const order = getOrderById(orderId);
  if (!order) {
    res.status(404).json({ success: false, error: 'Order not found' });
    return;
  }
  if (order.buyer_id !== user.sub) {
    res.status(403).json({ success: false, error: 'Only the buyer can rate' });
    return;
  }
  if (order.status !== 'completed') {
    res.status(400).json({ success: false, error: 'Can only rate completed orders' });
    return;
  }
  if (order.rating) {
    res.status(400).json({ success: false, error: 'Order already rated' });
    return;
  }

  updateOrderStatus(orderId, 'completed', {
    rating: Math.round(rating),
    rating_comment: comment?.slice(0, 1000) || null,
    rated_at: Date.now(),
  });

  res.json({ success: true, message: 'Rating submitted. Thank you!' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Verify an escrow deposit on Hedera Mirror Node by matching memo + amount.
 */
async function verifyEscrowDeposit(
  memo: string,
  expectedUsdc: number,
): Promise<{ transactionId: string } | null> {
  if (!TREASURY_ACCOUNT_ID) {
    logger.warn('Treasury account not configured');
    return null;
  }

  const MIRROR_NODE_BASE = process.env.HEDERA_MIRROR_NODE_URL
    ?? (process.env.HEDERA_NETWORK === 'mainnet'
      ? 'https://mainnet.mirrornode.hedera.com'
      : 'https://testnet.mirrornode.hedera.com');

  // Look back up to 35 minutes for the transaction
  const sinceTimestamp = ((Date.now() - 35 * 60 * 1000) / 1000).toFixed(9);
  const url = `${MIRROR_NODE_BASE}/api/v1/transactions`
    + `?account.id=${TREASURY_ACCOUNT_ID}`
    + `&transactiontype=CRYPTOTRANSFER`
    + `&timestamp=gte:${sinceTimestamp}`
    + `&limit=50`
    + `&order=desc`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      logger.error('Mirror node query failed', { status: response.status });
      return null;
    }

    const data = await response.json() as {
      transactions: Array<{
        transaction_id: string;
        consensus_timestamp: string;
        memo_base64: string;
        result: string;
        token_transfers?: Array<{
          token_id: string;
          account: string;
          amount: number;
        }>;
      }>;
    };

    const expectedSmallestUnits = BigInt(Math.round(expectedUsdc * 1_000_000));

    for (const tx of data.transactions) {
      if (tx.result !== 'SUCCESS') continue;

      const decodedMemo = Buffer.from(tx.memo_base64 ?? '', 'base64').toString('utf-8');
      if (decodedMemo !== memo) continue;

      const tokenTransfers = tx.token_transfers ?? [];
      const matchingTransfer = tokenTransfers.find(
        t =>
          t.token_id === USDC_TOKEN_ID &&
          t.account === TREASURY_ACCOUNT_ID &&
          BigInt(t.amount) >= expectedSmallestUnits,
      );

      if (matchingTransfer) {
        return { transactionId: tx.transaction_id };
      }
    }

    return null;
  } catch (err: any) {
    logger.error('Mirror node verification error', { error: err.message });
    return null;
  }
}

/**
 * Settle an order: transfer funds from escrow, anchor proof on HCS.
 */
async function settleOrder(orderId: string): Promise<{
  orderStatus: string;
  sellerPayout: number;
  platformFee: number;
  sellerBondReturned: number;
  hcsProof?: { topicId: string; sequenceNumber: number };
}> {
  const order = getOrderById(orderId);
  if (!order) throw new Error('Order not found');

  // Look up seller's tier to determine transaction fee rate
  const seller = getUserById(order.seller_id as string);
  const feePercent = PLATFORM_FEE_BY_TIER[seller?.tier ?? 'standard'] ?? DEFAULT_FEE_PERCENT;

  const totalUsdc = order.total_usdc as number;
  const platformFee = roundUsdc(totalUsdc * feePercent / 100);
  const sellerPayout = roundUsdc(totalUsdc - platformFee);

  const deposits = getEscrowDeposits(orderId);
  const sellerDeposit = deposits.find(d => d.party === 'seller');
  const sellerBondReturned = (sellerDeposit?.amount_usdc as number) || 0;

  // Mark all escrow deposits as settled
  settleEscrowDeposits(orderId);

  // Anchor settlement proof on HCS
  let hcsProof: { topicId: string; sequenceNumber: number } | undefined;
  try {
    const { anchorPaymentReceiptOnHCS } = await import('../hedera/usdc');
    const confirmation = {
      invoiceId: orderId,
      transactionId: `settlement-${orderId}`,
      consensusTimestamp: new Date().toISOString(),
      fromAccount: TREASURY_ACCOUNT_ID,
      amount: totalUsdc.toFixed(6),
      status: 'confirmed' as const,
    };
    const result = await anchorPaymentReceiptOnHCS(confirmation, 'marketplace-settlement');
    if (result) {
      hcsProof = result;
    }
  } catch (err: any) {
    logger.warn('HCS anchoring failed (non-fatal)', { error: err.message, orderId });
  }

  // Update order to completed — explicitly set settlement_type so
  // dual-rail trust scoring picks it up (hedera vs stripe vs unknown)
  const resolvedSettlementType = hcsProof ? 'hedera' : 'stripe';
  updateOrderStatus(orderId, 'completed', {
    completed_at: Date.now(),
    settled_at: Date.now(),
    settlement_type: resolvedSettlementType,
    hedera_transaction_id: hcsProof ? `settlement-${orderId}` : null,
    hcs_topic_id: hcsProof?.topicId || null,
    hcs_sequence_number: hcsProof?.sequenceNumber || null,
  });

  logger.info('Order settled', {
    orderId,
    sellerPayout,
    platformFee,
    sellerBondReturned,
    hcsAnchored: !!hcsProof,
  });

  // v39: Award trust points to both buyer and seller (+2 each)
  try {
    const buyerTrust = computeAndStoreTrustScore(order.buyer_id as string);
    const sellerTrust = computeAndStoreTrustScore(order.seller_id as string);
    logger.info('Trust scores updated on settlement', {
      orderId,
      buyerScore: buyerTrust.totalScore,
      buyerLevel: buyerTrust.trustLevel,
      sellerScore: sellerTrust.totalScore,
      sellerLevel: sellerTrust.trustLevel,
    });
  } catch (trustErr: any) {
    logger.error('Trust score update failed on settlement', { error: trustErr.message, orderId });
  }

  // v39: Send settlement emails to both parties
  try {
    const buyer = getUserById(order.buyer_id as string);
    const listing = getDb().prepare('SELECT title, price_cad FROM marketplace_listings WHERE id = ?').get(order.listing_id) as any;
    const emailData = {
      orderId,
      listingTitle: listing?.title ?? 'Marketplace Item',
      totalCad: listing?.price_cad ?? 0,
      totalUsdc: totalUsdc,
      buyerName: buyer?.name ?? buyer?.email ?? 'Buyer',
      sellerName: seller?.name ?? seller?.email ?? 'Seller',
      hederaTransactionId: hcsProof ? `settlement-${orderId}` : undefined,
    };
    if (buyer) {
      sendSettlementCompleteEmail(buyer.email, {
        ...emailData,
        isSeller: false,
      }).catch(err => logger.error('Failed to send buyer settlement email', { error: err.message }));
    }
    if (seller) {
      sendSettlementCompleteEmail(seller.email, {
        ...emailData,
        isSeller: true,
        sellerPayout,
        sellerBondReturned,
        platformFee,
      }).catch(err => logger.error('Failed to send seller settlement email', { error: err.message }));
    }
  } catch (emailErr: any) {
    logger.error('Settlement email error', { error: emailErr.message });
  }

  return {
    orderStatus: 'completed',
    sellerPayout,
    platformFee,
    sellerBondReturned,
    hcsProof,
  };
}

export default router;
