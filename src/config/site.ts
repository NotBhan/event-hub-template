/**
 * Public, client-specific identity of this deployment.
 *
 * These are safe to ship to the browser and are the knobs a new client
 * installation changes first. Runtime values stored in `organization_settings`
 * override the brand colour and name once an administrator edits them in the
 * dashboard, so a client can rebrand without a rebuild.
 */
export const site = {
  name: 'Event Hub',
  tagline: 'Events that move people',
  description:
    'Discover, register and host events for communities, companies and creators — physical, online and hybrid.',

  /** Path under `public/`. Replaced per client. */
  logo: '/images/logo.svg',
  favicon: '/favicon.svg',

  /**
   * Brand palette.
   *
   * The public site is dark and editorial; the organizer surface resolves the
   * same tokens to a neutral light palette. `primary` is the one value a client
   * changes most often — it is applied at runtime from the database.
   */
  colors: {
    primary: '#6366f1',
    primaryForeground: '#ffffff',
    accent: '#0ea5e9',
    /** Selective highlight. Used sparingly for small accents and status dots. */
    highlight: '#a3e635',
    canvas: '#080b13',
    surface: '#0e1421',
    surfaceMuted: '#121a2b',
    border: 'rgba(255, 255, 255, 0.09)',
    text: '#f4f5f7',
    textMuted: '#98a2b3',
    danger: '#f87171',
    success: '#34d399',
    warning: '#fbbf24',
  },

  contact: {
    email: 'hello@example.com',
    phone: '',
    addressLines: [] as string[],
  },

  /** Defaults for new events and money formatting. */
  locale: 'en-IN',
  defaultCurrency: 'INR',
  defaultTimezone: 'Asia/Kolkata',

  social: {
    twitter: '',
    instagram: '',
    linkedin: '',
  },
} as const;

export type SiteConfig = typeof site;
