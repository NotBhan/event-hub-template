import { site } from '@/config/site';
import type { NotificationType } from './types';

/**
 * Email templates.
 *
 * Rendering is a pure function of the payload so the same message can be rendered
 * by the worker, by tests, or by a preview page. All interpolated values are
 * escaped — attendee-supplied names must never become markup.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface TemplateContext {
  /** Absolute origin used for links, e.g. https://events.example.com */
  siteUrl: string;
  brandName: string;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(context: TemplateContext, heading: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;">
      <tr>
        <td style="padding:28px;">
          <p style="margin:0 0 20px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;">${escapeHtml(context.brandName)}</p>
          <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;">${escapeHtml(heading)}</h1>
          ${bodyHtml}
          <hr style="margin:28px 0 16px;border:none;border-top:1px solid #e2e8f0;" />
          <p style="margin:0;font-size:12px;color:#64748b;">
            This message was sent by ${escapeHtml(context.brandName)}.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function button(siteUrl: string, path: string, label: string): string {
  return `<p style="margin:24px 0;"><a href="${escapeHtml(siteUrl + path)}" style="display:inline-block;padding:12px 20px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">${escapeHtml(label)}</a></p>`;
}

function paragraph(value: string): string {
  return `<p style="margin:0 0 14px;line-height:1.6;">${escapeHtml(value)}</p>`;
}

interface TicketLine {
  attendeeName: string;
  ticketName: string;
  publicReference: string;
}

function ticketList(tickets: TicketLine[]): string {
  if (tickets.length === 0) return '';
  const rows = tickets
    .map(
      (ticket) =>
        `<li style="margin:0 0 8px;line-height:1.6;"><strong>${escapeHtml(ticket.attendeeName)}</strong> — ${escapeHtml(ticket.ticketName)} <span style="color:#64748b;">(${escapeHtml(ticket.publicReference)})</span></li>`,
    )
    .join('');
  return `<ul style="margin:0 0 14px;padding-left:20px;">${rows}</ul>`;
}

export function renderEmail(
  type: NotificationType,
  payload: Record<string, unknown>,
  context: TemplateContext,
): RenderedEmail {
  const brand = context.brandName;
  const eventTitle = String(payload.eventTitle ?? 'your event');
  const eventDate = String(payload.eventDate ?? '');
  const orderReference = String(payload.orderReference ?? '');
  const tickets = Array.isArray(payload.tickets) ? (payload.tickets as TicketLine[]) : [];

  switch (type) {
    case 'registration_confirmation':
      return {
        subject: `Registration confirmed — ${eventTitle}`,
        html: layout(
          context,
          'Your registration is confirmed',
          `${paragraph(`Hello ${String(payload.attendeeName ?? 'there')}, your place at ${eventTitle} is confirmed.`)}
           ${eventDate ? paragraph(`When: ${eventDate}`) : ''}
           ${orderReference ? paragraph(`Registration reference: ${orderReference}`) : ''}
           ${button(context.siteUrl, `/registrations/${encodeURIComponent(orderReference)}`, 'View your registration')}`,
        ),
        text: `Your registration for ${eventTitle} is confirmed.\n${eventDate ? `When: ${eventDate}\n` : ''}Reference: ${orderReference}\n${context.siteUrl}/registrations/${orderReference}`,
      };

    case 'order_confirmation':
      return {
        subject: `Order confirmed — ${eventTitle}`,
        html: layout(
          context,
          'Your order is confirmed',
          `${paragraph(`Thank you, ${String(payload.buyerName ?? 'there')}. We have received your payment for ${eventTitle}.`)}
           ${orderReference ? paragraph(`Order reference: ${orderReference}`) : ''}
           ${paragraph('Your tickets are attached to this order and can be viewed online.')}
           ${button(context.siteUrl, `/registrations/${encodeURIComponent(orderReference)}`, 'View your tickets')}`,
        ),
        text: `Your order for ${eventTitle} is confirmed.\nOrder reference: ${orderReference}\n${context.siteUrl}/registrations/${orderReference}`,
      };

    case 'tickets_issued':
      return {
        subject: `Your tickets for ${eventTitle}`,
        html: layout(
          context,
          'Your tickets are ready',
          `${paragraph('Present the QR code for each ticket at the entrance.')}
           ${ticketList(tickets)}
           ${orderReference ? button(context.siteUrl, `/registrations/${encodeURIComponent(orderReference)}`, 'Open your tickets') : ''}`,
        ),
        text: `Your tickets for ${eventTitle} are ready.\n${tickets.map((t) => `${t.attendeeName} — ${t.ticketName} (${t.publicReference})`).join('\n')}`,
      };

    case 'event_reminder':
      return {
        subject: `Reminder — ${eventTitle} is coming up`,
        html: layout(
          context,
          'Your event is coming up',
          `${paragraph(`${eventTitle} starts soon.`)}
           ${eventDate ? paragraph(`When: ${eventDate}`) : ''}
           ${paragraph('Have your ticket QR code ready for a faster entry.')}
           ${orderReference ? button(context.siteUrl, `/registrations/${encodeURIComponent(orderReference)}`, 'View your tickets') : ''}`,
        ),
        text: `Reminder: ${eventTitle} starts soon. ${eventDate}`,
      };

    case 'refund_processed':
      return {
        subject: `Refund processed — ${eventTitle}`,
        html: layout(
          context,
          'Your refund has been processed',
          `${paragraph(`We have processed a refund of ${String(payload.amount ?? '')} for ${eventTitle}.`)}
           ${paragraph('Depending on your bank, the amount may take a few business days to appear.')}
           ${paragraph(`Reference: ${String(payload.refundId ?? '')}`)}`,
        ),
        text: `A refund of ${String(payload.amount ?? '')} for ${eventTitle} has been processed.`,
      };

    case 'event_cancelled':
      return {
        subject: `Cancelled — ${eventTitle}`,
        html: layout(
          context,
          'This event has been cancelled',
          `${paragraph(`${eventTitle} has been cancelled.`)}
           ${payload.reason ? paragraph(`Reason: ${String(payload.reason)}`) : ''}
           ${paragraph('If you paid for a ticket, the organizer will process a refund. No action is needed from you.')}`,
        ),
        text: `${eventTitle} has been cancelled.${payload.reason ? ` Reason: ${String(payload.reason)}` : ''}`,
      };

    case 'staff_invitation':
      return {
        subject: `You have been invited to help organize ${brand}`,
        html: layout(
          context,
          'You have been invited',
          `${paragraph(`You have been invited to join ${brand} as ${String(payload.role ?? 'staff')}.`)}
           ${paragraph('Accept the invitation to access the organizer dashboard.')}
           ${button(context.siteUrl, String(payload.invitationPath ?? '/login'), 'Accept invitation')}`,
        ),
        text: `You have been invited to join ${brand} as ${String(payload.role ?? 'staff')}.\n${context.siteUrl}${String(payload.invitationPath ?? '/login')}`,
      };

    default: {
      const exhaustive: never = type;
      throw new Error(`No email template for notification type: ${String(exhaustive)}`);
    }
  }
}

export function defaultTemplateContext(): TemplateContext {
  return {
    siteUrl: process.env.PUBLIC_SITE_URL ?? 'http://localhost:4321',
    brandName: site.name,
  };
}
