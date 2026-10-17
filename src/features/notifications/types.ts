/** Notification types supported by the outbox and template renderer. */
export type NotificationType =
  | 'registration_confirmation'
  | 'order_confirmation'
  | 'tickets_issued'
  | 'event_reminder'
  | 'refund_processed'
  | 'event_cancelled'
  | 'staff_invitation';

/** Transport used to deliver a rendered message. */
export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}
