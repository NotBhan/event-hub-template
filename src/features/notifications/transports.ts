import nodemailer, { type Transporter } from 'nodemailer';
import { serverEnv } from '@/lib/security/env';
import type { EmailMessage, EmailTransport } from './types';

/**
 * Email transports.
 *
 * `console` writes the rendered message to the server log so a local demo can be
 * followed end to end without configuring a provider. It is development-only.
 * `smtp` delivers through any standard transactional provider.
 */

class ConsoleTransport implements EmailTransport {
  readonly name = 'console';

  async send(message: EmailMessage): Promise<void> {
    console.info(
      [
        '',
        '─────────────────────────── EMAIL (console transport) ───────────────────────────',
        `To:      ${message.to}`,
        `From:    ${message.from}`,
        `Subject: ${message.subject}`,
        '',
        message.text,
        '─────────────────────────────────────────────────────────────────────────────────',
        '',
      ].join('\n'),
    );
  }
}

class SmtpTransport implements EmailTransport {
  readonly name = 'smtp';
  private transporter: Transporter | undefined;

  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;
    const env = serverEnv();
    this.transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
      // Refuse to fall back to unencrypted delivery.
      requireTLS: env.SMTP_PORT !== 465,
    });
    return this.transporter;
  }

  async send(message: EmailMessage): Promise<void> {
    await this.getTransporter().sendMail({
      to: message.to,
      from: message.from,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  }
}

let cached: EmailTransport | undefined;

export function emailTransport(): EmailTransport {
  if (cached) return cached;
  cached = serverEnv().EMAIL_PROVIDER === 'smtp' ? new SmtpTransport() : new ConsoleTransport();
  return cached;
}
