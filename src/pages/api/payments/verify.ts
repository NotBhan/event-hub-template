import type { APIRoute } from 'astro';
import { z } from 'zod';
import { handleClientReturn } from '@/features/payments/service';
import { HttpError } from '@/lib/security/errors';
import { assertRegistrationAccess } from '@/lib/security/registration-access';
import { getOrder } from '@/features/orders/service';

/**
 * Browser returning from Razorpay's hosted checkout.
 *
 * This endpoint exists so the page can react immediately, but it is not trusted:
 * the signature is verified and the payment is re-fetched from the provider
 * before anything is confirmed. The webhook remains the authoritative signal.
 */
export const POST: APIRoute = async (ctx) => {
  let body: unknown;

  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: 'Expected a JSON body' }, 400);
  }

  const parsed = z
    .object({
      orderId: z.uuid(),
      providerPaymentId: z.string().min(1).max(200),
      signature: z.string().min(1).max(500),
    })
    .safeParse(body);

  if (!parsed.success) {
    return json({ error: 'Invalid payment response' }, 400);
  }

  try {
    const order = await getOrder(parsed.data.orderId);
    if (!order) return json({ error: 'Order not found' }, 404);

    /**
     * Only the buyer's own browser may report a payment for this order. Without
     * this check, anyone holding an order id could probe the verify path.
     */
    assertRegistrationAccess({
      cookies: ctx.cookies,
      order,
      viewerUserId: ctx.locals.user?.id ?? null,
      orderUserId: order.userId,
    });

    const outcome = await handleClientReturn({
      orderId: parsed.data.orderId,
      providerPaymentId: parsed.data.providerPaymentId,
      signature: parsed.data.signature,
    });

    return json({
      confirmed: outcome.confirmed,
      needsReconciliation: outcome.needsReconciliation,
      message: outcome.message,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status);
    }

    console.error('Payment verification failed', error);
    return json({ error: 'We could not verify that payment. Please contact support.' }, 500);
  }
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
