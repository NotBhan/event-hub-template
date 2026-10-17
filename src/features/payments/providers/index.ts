import { serverEnv } from '@/lib/security/env';
import { RazorpayProvider } from './razorpay';
import { SimulatedProvider } from './simulated';
import type { PaymentProvider } from './types';

/**
 * Provider selection.
 *
 * The active gateway is a deployment concern, resolved from configuration. No
 * other module in the codebase may branch on the provider name — everything goes
 * through the `PaymentProvider` interface.
 */

let cached: PaymentProvider | undefined;

export function paymentProvider(): PaymentProvider {
  if (cached) return cached;

  cached =
    serverEnv().PAYMENT_PROVIDER === 'razorpay' ? new RazorpayProvider() : new SimulatedProvider();

  return cached;
}

/** The simulated provider, or null when a real gateway is configured. */
export function simulatedProvider(): SimulatedProvider | null {
  const provider = paymentProvider();
  return provider instanceof SimulatedProvider ? provider : null;
}

export * from './types';
