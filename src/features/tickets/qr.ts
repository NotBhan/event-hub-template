import QRCode from 'qrcode';
import { tokenForTicket } from './service';

/**
 * QR rendering.
 *
 * The QR code is generated as an inline SVG on the server. That keeps it inside
 * the page's own origin (no third-party image service ever sees a ticket
 * credential) and needs no binary asset storage.
 *
 * The encoded payload is the derived admission credential — never a name, an
 * email address or any other personal data, so a photograph of someone's ticket
 * discloses nothing about them.
 */

const QR_OPTIONS = {
  errorCorrectionLevel: 'M' as const,
  type: 'svg' as const,
  margin: 2,
  // Wide enough to scan reliably from a phone screen at arm's length.
  width: 512,
  color: {
    dark: '#0f172a',
    light: '#ffffff',
  },
} satisfies QRCode.QRCodeToStringOptions;

/** SVG markup for a ticket's admission credential. */
export async function ticketQrSvg(
  ticketId: string,
  options: { width?: number } = {},
): Promise<string> {
  const token = tokenForTicket(ticketId);

  return QRCode.toString(token, {
    ...QR_OPTIONS,
    ...(options.width ? { width: options.width } : {}),
  });
}

/** The credential encoded in the QR code, for a manual-entry fallback. */
export function ticketQrPayload(ticketId: string): string {
  return tokenForTicket(ticketId);
}
