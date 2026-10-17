import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getOrder } from '@/features/orders/service';
import { handleClientReturn, processWebhook } from '@/features/payments/service';
import { simulatedProvider } from '@/features/payments/providers';
import { HttpError } from '@/lib/security/errors';
import { assertRegistrationAccess } from '@/lib/security/registration-access';
import { getLatestPayment } from '@/features/orders/service';

/**
 * Simulated checkout.
 *
 * Available **only** when `PAYMENT_PROVIDER=simulated`, which `env.ts` refuses to
 * allow in production. It exists so the complete pipeline can be demonstrated
 * without gateway credentials.
 *
 * It deliberately does not take a shortcut: it mints the identifier and signature
 * a real gateway would produce, then runs them through the ordinary verification
 * path, and finally delivers a signed webhook. That means the demo exercises the
 * same code that handles real money — including the duplicate-webhook case.
 */
export const POST: APIRoute = async (ctx) => {
  const provider = simulatedProvider();

  if (!provider) {
    return json({ error: 'Simulated checkout is not enabled on this deployment' }, 404);
  }

  let body: unknown;
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: 'Expected a JSON body' }, 400);
  }

  const parsed = z
    .object({
      orderId: z.uuid(),
      outcome: z.enum(['success', 'failure']).default('success'),
    })
    .safeParse(body);

  if (!parsed.success) return json({ error: 'Invalid request' }, 400);

  try {
    const order = await getOrder(parsed.data.orderId);
    if (!order) return json({ error: 'Order not found' }, 404);

    assertRegistrationAccess({
      cookies: ctx.cookies,
      order,
      viewerUserId: ctx.locals.user?.id ?? null,
      orderUserId: order.userId,
    });

    const payment = await getLatestPayment(order.id);
    if (!payment) return json({ error: 'Start the payment before simulating it' }, 409);

    const { providerPaymentId, signature } = provider.createSimulatedPayment({
      providerOrderId: payment.providerOrderId,
      outcome: parsed.data.outcome,
      method: 'simulated',
    });

    // 1. The browser-return path, exactly as a real gateway would trigger it.
    const outcome = await handleClientReturn({
      orderId: order.id,
      providerPaymentId,
      signature,
    });

    /**
     * 2. The webhook path. Delivering the same event twice, then a third time,
     *    proves the de-duplication that protects against duplicate tickets.
     */
    const webhook = provider.buildWebhook({
      eventType: parsed.data.outcome === 'success' ? 'payment.captured' : 'payment.failed',
      data: {
        providerOrderId: payment.providerOrderId,
        providerPaymentId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        method: 'simulated',
      },
    });

    const first = await processWebhook({
      rawBody: new TextEncoder().encode(webhook.body),
      signature: webhook.signature,
      eventIdHeader: webhook.eventId,
    });

    const duplicate = await processWebhook({
      rawBody: new TextEncoder().encode(webhook.body),
      signature: webhook.signature,
      eventIdHeader: webhook.eventId,
    });

    return json({
      confirmed: outcome.confirmed,
      needsReconciliation: outcome.needsReconciliation,
      message: outcome.message,
      webhook: { first: first.status, duplicate: duplicate.status },
    });
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);

    console.error('Simulated payment failed', error);
    return json({ error: 'The simulated payment could not be completed.' }, 500);
  }
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
