import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import Razorpay from 'razorpay';
import { serverEnv } from '@/lib/security/env';
import {
  PaymentProviderError,
  WebhookVerificationError,
  type CreatePaymentOrderInput,
  type CreateRefundInput,
  type PaymentProvider,
  type ProviderOrder,
  type ProviderPayment,
  type ProviderRefund,
  type VerifiedPayment,
  type VerifiedWebhook,
  type VerifyPaymentInput,
} from './types';

/**
 * Razorpay adapter.
 *
 * Two things matter most here, and both are easy to get wrong:
 *
 * 1. **Webhook signatures cover the raw body.** The bytes exactly as received are
 *    hashed, so the caller must never hand over a re-serialised object — JSON
 *    round-tripping changes whitespace and key order and would break verification.
 *
 * 2. **Card data never reaches this application.** Checkout happens on Razorpay's
 *    hosted page; we only ever see identifiers, amounts and statuses.
 */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay';
  readonly simulated = false;

  private client: Razorpay | undefined;

  private getClient(): Razorpay {
    if (this.client) return this.client;

    const env = serverEnv();
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      throw new PaymentProviderError('Razorpay credentials are not configured');
    }

    this.client = new Razorpay({
      key_id: env.RAZORPAY_KEY_ID,
      key_secret: env.RAZORPAY_KEY_SECRET,
    });
    return this.client;
  }

  async createOrder(input: CreatePaymentOrderInput): Promise<ProviderOrder> {
    try {
      const order = await this.getClient().orders.create({
        amount: input.amountMinor,
        currency: input.currency,
        receipt: input.receipt,
        notes: input.notes ?? {},
      });

      const env = serverEnv();

      return {
        providerOrderId: order.id,
        amountMinor: Number(order.amount),
        currency: order.currency,
        status: order.status,
        /**
         * Only the publishable key id and the order id are sent to the browser.
         * The key secret stays on the server, always.
         */
        checkoutPayload: {
          key: env.RAZORPAY_KEY_ID,
          order_id: order.id,
          amount: Number(order.amount),
          currency: order.currency,
          name: input.notes?.brandName ?? 'Event',
        },
      };
    } catch (error) {
      throw toProviderError(error, 'Failed to create the payment order');
    }
  }

  /**
   * Verifies the signature returned by the hosted checkout.
   *
   * This only proves the browser was handed a genuine pair of identifiers. The
   * caller must still fetch the payment and compare the captured amount before
   * treating anything as paid — a valid signature is not proof of capture.
   */
  async verifyPayment(input: VerifyPaymentInput): Promise<VerifiedPayment> {
    const env = serverEnv();
    if (!env.RAZORPAY_KEY_SECRET) {
      throw new PaymentProviderError('Razorpay credentials are not configured');
    }

    const expected = createHmac('sha256', env.RAZORPAY_KEY_SECRET)
      .update(`${input.providerOrderId}|${input.providerPaymentId}`)
      .digest('hex');

    if (!constantTimeEquals(expected, input.signature)) {
      throw new PaymentProviderError('Payment signature verification failed');
    }

    const payment = await this.getPayment(input.providerPaymentId);

    return {
      providerOrderId: payment.providerOrderId,
      providerPaymentId: payment.providerPaymentId,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      status: mapStatusToVerified(payment.status),
      method: payment.method,
    };
  }

  async verifyWebhook(input: {
    rawBody: Uint8Array;
    signature: string | null;
    eventIdHeader?: string | null;
  }): Promise<VerifiedWebhook> {
    const env = serverEnv();
    if (!env.RAZORPAY_WEBHOOK_SECRET) {
      throw new PaymentProviderError('RAZORPAY_WEBHOOK_SECRET is not configured');
    }
    if (!input.signature) {
      throw new WebhookVerificationError('Missing webhook signature header');
    }

    const body = Buffer.from(input.rawBody);
    const expected = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');

    if (!constantTimeEquals(expected, input.signature)) {
      throw new WebhookVerificationError();
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new WebhookVerificationError('Webhook body is not valid JSON');
    }

    const eventType = typeof payload.event === 'string' ? payload.event : 'unknown';

    /**
     * Razorpay sends `x-razorpay-event-id`; falling back to a hash of the body
     * keeps de-duplication working for deliveries that omit the header, since an
     * identical redelivery produces an identical digest.
     */
    const eventId = input.eventIdHeader ?? createHash('sha256').update(body).digest('hex');

    return {
      eventId,
      eventType,
      intent: normaliseIntent(eventType, payload),
      payloadSummary: summarise(eventType, payload),
    };
  }

  async refund(input: CreateRefundInput): Promise<ProviderRefund> {
    try {
      const refund = await this.getClient().payments.refund(input.providerPaymentId, {
        amount: input.amountMinor,
        notes: {
          ...(input.notes ?? {}),
          ...(input.reason ? { reason: input.reason } : {}),
        },
      });

      return {
        providerRefundId: refund.id,
        providerPaymentId: input.providerPaymentId,
        amountMinor: Number(refund.amount),
        currency: refund.currency,
        status: mapRefundStatus(refund.status),
      };
    } catch (error) {
      throw toProviderError(error, 'Failed to submit the refund');
    }
  }

  async getPayment(providerPaymentId: string): Promise<ProviderPayment> {
    try {
      const payment = await this.getClient().payments.fetch(providerPaymentId);

      return {
        providerPaymentId: payment.id,
        providerOrderId: String(payment.order_id ?? ''),
        amountMinor: Number(payment.amount),
        currency: payment.currency,
        status: mapPaymentStatus(payment.status),
        method: payment.method ?? undefined,
        amountRefundedMinor: Number(payment.amount_refunded ?? 0),
        failureReason: payment.error_description ?? undefined,
      };
    } catch (error) {
      throw toProviderError(error, 'Failed to fetch the payment');
    }
  }

  async getRefund(providerRefundId: string): Promise<ProviderRefund> {
    try {
      const refund = await this.getClient().refunds.fetch(providerRefundId);

      return {
        providerRefundId: refund.id,
        providerPaymentId: String(refund.payment_id ?? ''),
        amountMinor: Number(refund.amount),
        currency: refund.currency,
        status: mapRefundStatus(refund.status),
      };
    } catch (error) {
      throw toProviderError(error, 'Failed to fetch the refund');
    }
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'hex');
  const bufferB = Buffer.from(b, 'hex');
  if (bufferA.length !== bufferB.length || bufferA.length === 0) return false;
  return timingSafeEqual(bufferA, bufferB);
}

function mapPaymentStatus(status: string): ProviderPayment['status'] {
  switch (status) {
    case 'captured':
      return 'captured';
    case 'authorized':
      return 'authorized';
    case 'refunded':
      return 'refunded';
    case 'partially_refunded':
      return 'partially_refunded';
    default:
      return 'failed';
  }
}

function mapStatusToVerified(status: ProviderPayment['status']): VerifiedPayment['status'] {
  if (status === 'captured') return 'captured';
  if (status === 'authorized') return 'authorized';
  return 'failed';
}

function mapRefundStatus(status: string): ProviderRefund['status'] {
  if (status === 'processed') return 'succeeded';
  if (status === 'failed') return 'failed';
  return 'pending';
}

/** Translates a provider event into an intent the payment service understands. */
function normaliseIntent(
  eventType: string,
  payload: Record<string, unknown>,
): VerifiedWebhook['intent'] {
  const container = payload.payload as
    Record<string, { entity?: Record<string, unknown> }> | undefined;

  switch (eventType) {
    case 'payment.captured':
    case 'order.paid': {
      const payment = container?.payment?.entity;
      if (!payment) return { kind: 'ignored', reason: 'No payment entity in payload' };

      return {
        kind: 'payment_captured',
        providerOrderId: String(payment.order_id ?? ''),
        providerPaymentId: String(payment.id ?? ''),
        amountMinor: Number(payment.amount ?? 0),
        currency: String(payment.currency ?? ''),
        method: typeof payment.method === 'string' ? payment.method : undefined,
      };
    }

    case 'payment.failed': {
      const payment = container?.payment?.entity;
      if (!payment) return { kind: 'ignored', reason: 'No payment entity in payload' };

      return {
        kind: 'payment_failed',
        providerOrderId: String(payment.order_id ?? ''),
        providerPaymentId: typeof payment.id === 'string' ? payment.id : undefined,
        reason:
          typeof payment.error_description === 'string'
            ? payment.error_description
            : 'Payment failed at the provider',
      };
    }

    case 'refund.processed':
    case 'refund.failed': {
      const refund = container?.refund?.entity;
      if (!refund) return { kind: 'ignored', reason: 'No refund entity in payload' };

      return {
        kind: 'refund_processed',
        providerRefundId: String(refund.id ?? ''),
        providerPaymentId: String(refund.payment_id ?? ''),
        amountMinor: Number(refund.amount ?? 0),
        currency: String(refund.currency ?? ''),
        status: eventType === 'refund.processed' ? 'succeeded' : 'failed',
      };
    }

    default:
      return { kind: 'ignored', reason: `Unhandled event type: ${eventType}` };
  }
}

/**
 * Keeps a small, non-sensitive subset of the payload for audit.
 *
 * Deliberately excludes anything that could carry instrument details: only
 * identifiers, amounts and statuses are retained.
 */
function summarise(eventType: string, payload: Record<string, unknown>): Record<string, unknown> {
  const container = payload.payload as
    Record<string, { entity?: Record<string, unknown> }> | undefined;
  const entity = container?.payment?.entity ?? container?.refund?.entity;

  if (!entity) return { eventType };

  return {
    eventType,
    id: entity.id,
    orderId: entity.order_id,
    paymentId: entity.payment_id,
    amount: entity.amount,
    currency: entity.currency,
    status: entity.status,
  };
}

interface ProviderErrorShape {
  statusCode?: number;
  error?: { description?: string; code?: string };
  message?: string;
}

/** Maps SDK failures onto a retryability decision the worker can act on. */
function toProviderError(error: unknown, fallbackMessage: string): PaymentProviderError {
  const shape = error as ProviderErrorShape;
  const description = shape?.error?.description ?? shape?.message ?? fallbackMessage;
  const statusCode = shape?.statusCode;

  // 5xx and network faults are worth retrying; 4xx rejections are not.
  const retryable = statusCode === undefined || statusCode >= 500;

  return new PaymentProviderError(description, retryable, error);
}
