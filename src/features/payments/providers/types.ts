/**
 * Payment provider contract.
 *
 * Razorpay-specific details must not leak into the events, orders or refunds
 * modules. Everything the platform needs from a gateway is expressed here, so a
 * later client can switch gateway without touching the order model.
 */

export interface CreatePaymentOrderInput {
  /** Server-computed amount in minor units. Never supplied by a browser. */
  amountMinor: number;
  currency: string;
  /** Our order reference, echoed back by the provider for reconciliation. */
  receipt: string;
  notes?: Record<string, string>;
}

export interface ProviderOrder {
  providerOrderId: string;
  amountMinor: number;
  currency: string;
  status: string;
  /** Values the browser checkout widget needs. Never includes the secret key. */
  checkoutPayload: Record<string, unknown>;
}

export interface VerifyPaymentInput {
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
}

export interface VerifiedPayment {
  providerOrderId: string;
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
  status: 'authorized' | 'captured' | 'failed';
  method?: string;
}

/** A webhook payload that has been authenticated and normalised. */
export interface VerifiedWebhook {
  /** Provider-side unique event id, used to de-duplicate deliveries. */
  eventId: string;
  eventType: string;
  /** Normalised intent, so the payment service never parses provider payloads. */
  intent:
    | {
        kind: 'payment_captured';
        providerOrderId: string;
        providerPaymentId: string;
        amountMinor: number;
        currency: string;
        method?: string;
      }
    | {
        kind: 'payment_failed';
        providerOrderId: string;
        providerPaymentId?: string;
        reason?: string;
      }
    | {
        kind: 'refund_processed';
        providerRefundId: string;
        providerPaymentId: string;
        amountMinor: number;
        currency: string;
        status: 'succeeded' | 'failed';
        reason?: string;
      }
    | { kind: 'ignored'; reason: string };
  /**
   * Redacted, non-sensitive summary kept for audit. Never the full provider body.
   */
  payloadSummary: Record<string, unknown>;
}

export interface CreateRefundInput {
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
  reason?: string;
  notes?: Record<string, string>;
}

export interface ProviderRefund {
  providerRefundId: string;
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed';
  failureReason?: string;
}

export interface ProviderPayment {
  providerPaymentId: string;
  providerOrderId: string;
  amountMinor: number;
  currency: string;
  status: 'authorized' | 'captured' | 'failed' | 'refunded' | 'partially_refunded';
  method?: string;
  amountRefundedMinor: number;
  failureReason?: string;
}

export interface PaymentProvider {
  /** Identifier persisted on payment rows, e.g. 'razorpay'. */
  readonly name: string;

  /** True when the provider is a local stand-in rather than a real gateway. */
  readonly simulated: boolean;

  createOrder(input: CreatePaymentOrderInput): Promise<ProviderOrder>;

  verifyPayment(input: VerifyPaymentInput): Promise<VerifiedPayment>;

  /**
   * Authenticates a webhook from its raw body.
   *
   * The signature covers the bytes exactly as received, so callers must pass the
   * untouched request body rather than a re-serialised object. `eventIdHeader`
   * carries the provider's delivery identifier where it is supplied in a header
   * rather than the body, which is what makes de-duplication reliable.
   */
  verifyWebhook(input: {
    rawBody: Uint8Array;
    signature: string | null;
    eventIdHeader?: string | null;
  }): Promise<VerifiedWebhook>;

  refund(input: CreateRefundInput): Promise<ProviderRefund>;

  getPayment(providerPaymentId: string): Promise<ProviderPayment>;

  getRefund(providerRefundId: string): Promise<ProviderRefund>;
}

/** Thrown when a delivered webhook fails signature verification. */
export class WebhookVerificationError extends Error {
  constructor(message = 'Webhook signature verification failed') {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

/** Thrown when the provider rejects a request or is unreachable. */
export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}
