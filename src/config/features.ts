/**
 * Feature configuration for this deployment.
 *
 * Disable a feature when a client deployment does not need it. Pages and
 * endpoints check these flags instead of assuming every module is present.
 */
export const features = {
  /** Paid tickets, checkout and payments. Free-only installs can disable this. */
  paidTicketing: true,

  /** Organizer-initiated refunds. Requires paidTicketing. */
  refunds: true,

  /** QR tickets and the browser-based admission scanner. */
  qrCheckIn: true,

  /** Public waitlists once a ticket type is sold out. Reserved for a later phase. */
  waitlists: false,

  /** Allow buyers without an account. */
  guestCheckout: true,

  /** Let attendees create accounts that keep their registrations together. */
  attendeeAccounts: true,

  /** Public multi-organization creation. Client installs provision exactly one. */
  allowAdditionalOrganizations: false,
} as const;

export type FeatureFlags = typeof features;

export function isFeatureEnabled(flag: keyof FeatureFlags): boolean {
  return features[flag];
}
