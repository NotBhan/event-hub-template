import type { APIRoute } from 'astro';
import { processWebhook } from '@/features/payments/service';

/**
 * Payment webhook receiver.
 *
 * This is the authoritative signal that money moved: it arrives whether or not
 * the buyer ever returns to the site.
 *
 * Three details matter and are all handled by the payment service:
 *
 *  - The **raw body** is read as bytes. Razorpay's signature covers the exact
 *    bytes sent, so parsing and re-serialising the JSON would break verification.
 *  - The signature is verified before anything is interpreted.
 *  - The provider's event id makes processing idempotent, because deliveries can
 *    repeat and can arrive out of order.
 *
 * A 2xx tells the provider to stop retrying. A 5xx asks it to retry, which is the
 * correct answer for a transient failure on our side.
 */
export const POST: APIRoute = async (ctx) => {
  const rawBody = new Uint8Array(await ctx.request.arrayBuffer());

  // Razorpay signs with `x-razorpay-signature`; the generic header is accepted so
  // a different gateway can be dropped in without changing this route.
  const signature =
    ctx.request.headers.get('x-razorpay-signature') ??
    ctx.request.headers.get('x-webhook-signature');

  const eventIdHeader = ctx.request.headers.get('x-razorpay-event-id');

  try {
    const result = await processWebhook({ rawBody, signature, eventIdHeader });

    // A rejected signature is an authentication failure, not a server fault.
    if (result.status === 'rejected') {
      return json({ status: result.status, message: result.message }, 401);
    }

    return json({ status: result.status, message: result.message }, 200);
  } catch (error) {
    console.error('Webhook processing error', error);

    // Ask the provider to retry: the failure is on our side.
    return json({ status: 'failed', message: 'Temporary failure, please retry' }, 500);
  }
};

/** Webhooks are POST-only; anything else is a mistake worth reporting clearly. */
export const GET: APIRoute = async () => json({ error: 'Use POST for webhook deliveries' }, 405);

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
