import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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
 * Simulated payment provider.
 *
 * ## What this is, and what it is not
 *
 * This exists so the full checkout pipeline — order creation, reservation,
 * payment record, webhook handling, idempotent ticket issuance and refunds — can
 * be demonstrated on a machine with no gateway credentials. It is clearly
 * labelled in the UI, and `env.ts` refuses to start a production deployment with
 * it selected.
 *
 * It is **not** evidence of a working payment integration. Nothing is charged and
 * no card is touched. A client deployment must run with `PAYMENT_PROVIDER=razorpay`.
 *
 * ## Design
 *
 * The provider is stateless so a demo needs no extra tables: every identifier it
 * hands out carries a signed payload. Tampering with an amount or a status is
 * detected exactly as a forged gateway response would be, and the calling code
 * runs its ordinary verification path rather than a shortcut.
 */
export class SimulatedProvider implements PaymentProvider {
  readonly name = 'simulated';
  readonly simulated = true;

  private key(): string {
    const env = serverEnv();
    // Prefer the dedicated webhook secret when a client has supplied one, so the
    // demo and the real integration share a key-management story.
    return env.RAZORPAY_WEBHOOK_SECRET || `simulated:${env.BETTER_AUTH_SECRET}`;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.key()).update(payload).digest('base64url').slice(0, 43);
  }

  private seal(data: Record<string, unknown>): string {
    const encoded = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
    return `${encoded}.${this.sign(encoded)}`;
  }

  private open<T>(sealed: string, context: string): T {
    const separator = sealed.lastIndexOf('.');
    if (separator === -1) throw new PaymentProviderError(`Malformed ${context} identifier`);

    const encoded = sealed.slice(0, separator);
    const signature = sealed.slice(separator + 1);

    const expected = this.sign(encoded);
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new PaymentProviderError(`${context} signature verification failed`);
    }

    try {
      return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T;
    } catch {
      throw new PaymentProviderError(`${context} payload is not readable`);
    }
  }

  async createOrder(input: CreatePaymentOrderInput): Promise<ProviderOrder> {
    const providerOrderId = `simo_${this.seal({
      r: input.receipt,
      a: input.amountMinor,
      c: input.currency,
      n: randomBytes(6).toString('base64url'),
    })}`;

    return {
      providerOrderId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: 'created',
      checkoutPayload: {
        simulated: true,
        key: 'simulated',
        order_id: providerOrderId,
        amount: input.amountMinor,
        currency: input.currency,
      },
    };
  }

  /**
   * Mints the identifier and signature a real gateway would return to the browser.
   * Called by the simulated checkout page so the normal verification path runs.
   */
  createSimulatedPayment(input: {
    providerOrderId: string;
    outcome: 'success' | 'failure';
    method?: string;
  }): { providerPaymentId: string; signature: string } {
    const order = this.open<{ r: string; a: number; c: string }>(stripPrefix(input.providerOrderId, 'simo_'), 'Simulated order');

    const providerPaymentId = `simp_${this.seal({
      o: input.providerOrderId,
      a: order.a,
      c: order.c,
      m: input.method ?? 'simulated',
      s: input.outcome === 'success' ? 'captured' : 'failed',
    })}`;

    // Mirrors a gateway's client-return signature: HMAC over order|payment.
    const signature = createHmac('sha256', this.key())
      .update(`${input.providerOrderId}|${providerPaymentId}`)
      .digest('hex');

    return { providerPaymentId, signature };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifiedPayment> {
    const expected = createHmac('sha256', this.key())
      .update(`${input.providerOrderId}|${input.providerPaymentId}`)
      .digest('hex');

    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(input.signature, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new PaymentProviderError('Payment signature verification failed');
    }

    const payment = await this.getPayment(input.providerPaymentId);

    return {
      providerOrderId: payment.providerOrderId,
      providerPaymentId: payment.providerPaymentId,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      status: payment.status === 'captured' ? 'captured' : 'failed',
      method: payment.method,
    };
  }

  async verifyWebhook(input: {
    rawBody: Uint8Array;
    signature: string | null;
    eventIdHeader?: string | null;
  }): Promise<VerifiedWebhook> {
    if (!input.signature) throw new WebhookVerificationError('Missing webhook signature header');

    const body = Buffer.from(input.rawBody);
    const expected = createHmac('sha256', this.key()).update(body).digest('hex');

    const a = Buffer.from(expected);
    const b = Buffer.from(input.signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new WebhookVerificationError();

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new WebhookVerificationError('Webhook body is not valid JSON');
    }

    const eventType = String(payload.event ?? 'unknown');
    const data = (payload.data ?? {}) as Record<string, unknown>;

    const intent: VerifiedWebhook['intent'] =
      eventType === 'payment.captured'
        ? {
            kind: 'payment_captured',
            providerOrderId: String(data.providerOrderId ?? ''),
            providerPaymentId: String(data.providerPaymentId ?? ''),
            amountMinor: Number(data.amountMinor ?? 0),
            currency: String(data.currency ?? ''),
            method: typeof data.method === 'string' ? data.method : undefined,
          }
        : eventType === 'payment.failed'
          ? {
              kind: 'payment_failed',
              providerOrderId: String(data.providerOrderId ?? ''),
              providerPaymentId: typeof data.providerPaymentId === 'string' ? data.providerPaymentId : undefined,
              reason: typeof data.reason === 'string' ? data.reason : undefined,
            }
          : eventType === 'refund.processed' || eventType === 'refund.failed'
            ? {
                kind: 'refund_processed',
                providerRefundId: String(data.providerRefundId ?? ''),
                providerPaymentId: String(data.providerPaymentId ?? ''),
                amountMinor: Number(data.amountMinor ?? 0),
                currency: String(data.currency ?? ''),
                status: eventType === 'refund.processed' ? 'succeeded' : 'failed',
              }
            : { kind: 'ignored', reason: `Unhandled event type: ${eventType}` };

    return {
      eventId: input.eventIdHeader ?? this.sign(body.toString('utf8')),
      eventType,
      intent,
      payloadSummary: { eventType, id: data.providerPaymentId ?? data.providerRefundId ?? null },
    };
  }

  /** Builds a signed webhook body, so the demo can exercise the real endpoint. */
  buildWebhook(input: { eventType: string; data: Record<string, unknown> }): {
    body: string;
    signature: string;
    eventId: string;
  } {
    const body = JSON.stringify({
      event: input.eventType,
      created_at: Math.floor(Date.now() / 1000),
      data: input.data,
    });
    const signature = createHmac('sha256', this.key()).update(body).digest('hex');

    return { body, signature, eventId: this.sign(body) };
  }

  async refund(input: CreateRefundInput): Promise<ProviderRefund> {
    const providerRefundId = `simr_${this.seal({
      p: input.providerPaymentId,
      a: input.amountMinor,
      c: input.currency,
    })}`;

    return {
      providerRefundId,
      providerPaymentId: input.providerPaymentId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: 'succeeded',
    };
  }

  async getPayment(providerPaymentId: string): Promise<ProviderPayment> {
    const data = this.open<{ o: string; a: number; c: string; m: string; s: string }>(
      stripPrefix(providerPaymentId, 'simp_'),
      'Simulated payment',
    );

    return {
      providerPaymentId,
      providerOrderId: data.o,
      amountMinor: data.a,
      currency: data.c,
      status: data.s === 'captured' ? 'captured' : 'failed',
      method: data.m,
      amountRefundedMinor: 0,
    };
  }

  async getRefund(providerRefundId: string): Promise<ProviderRefund> {
    const data = this.open<{ p: string; a: number; c: string }>(
      stripPrefix(providerRefundId, 'simr_'),
      'Simulated refund',
    );

    return {
      providerRefundId,
      providerPaymentId: data.p,
      amountMinor: data.a,
      currency: data.c,
      status: 'succeeded',
    };
  }
}

function stripPrefix(value: string, prefix: string): string {
  if (!value.startsWith(prefix)) {
    throw new PaymentProviderError(`Unexpected ${prefix} identifier`);
  }
  return value.slice(prefix.length);
}
