import { site } from './site';

/**
 * Policy content.
 *
 * These pages are required before a live deployment (see the operational
 * readiness section of the architecture notes) and every client must review them.
 * They are plain content, not legal advice: the organizer is responsible for
 * their own cancellation, refund, privacy and contact terms.
 */

export interface PolicySection {
  heading: string;
  body: string[];
}

export interface PolicyPage {
  slug: string;
  title: string;
  intro: string;
  sections: PolicySection[];
  /** Set when the page still needs the client's own wording before going live. */
  needsReview: boolean;
}

const organizer = site.name;

export const policies: PolicyPage[] = [
  {
    slug: 'terms',
    title: 'Terms of service',
    intro: `These terms cover your use of the ${organizer} event platform and the events listed on it.`,
    needsReview: true,
    sections: [
      {
        heading: 'Using the platform',
        body: [
          'You agree to provide accurate registration details. Tickets are issued to the named attendee and may be checked at the entrance.',
          'You must not attempt to copy, resell or alter a ticket, or interfere with the operation of this site.',
        ],
      },
      {
        heading: 'Registrations and tickets',
        body: [
          'A registration is confirmed once any required payment has been received. Until then, tickets are held only for a limited period and are released automatically if checkout is not completed.',
          'Each ticket admits one person once. Duplicate, void or altered tickets are refused at the entrance.',
        ],
      },
      {
        heading: 'Event changes',
        body: [
          'Organizers may change event details, or cancel an event. Where an event is cancelled, paid registrations are refunded in line with the refund policy shown on the event page.',
        ],
      },
      {
        heading: 'Liability',
        body: [
          'The platform provides registration and ticketing technology. The organizer of an event is responsible for running the event itself.',
        ],
      },
    ],
  },
  {
    slug: 'privacy',
    title: 'Privacy policy',
    intro: 'What we collect, why, and how long we keep it.',
    needsReview: true,
    sections: [
      {
        heading: 'What we collect',
        body: [
          'Registration details: the name, email address and optional phone number of the buyer and of each attendee, plus any answers to questions the organizer asks.',
          'Transaction records: orders, payments and refunds, so the organizer can account for money received and resolve disputes.',
          'Technical records: sign-in sessions and an audit trail of administrative actions, for security and accountability.',
        ],
      },
      {
        heading: 'Payment details',
        body: [
          'Card numbers and security codes are never entered on this site and are never stored by it. Payment is completed on the payment provider\u2019s own hosted page, and this platform receives only an identifier, an amount and a status.',
        ],
      },
      {
        heading: 'Who can see it',
        body: [
          'The organizer of an event can see the registrations for their events. Attendees see only their own records.',
          'We do not sell attendee information to third parties.',
        ],
      },
      {
        heading: 'Retention',
        body: [
          'Registration and transaction records are retained for as long as needed to operate the platform, meet accounting obligations and resolve disputes. Ask the organizer to delete your details when they are no longer required.',
        ],
      },
      {
        heading: 'Your choices',
        body: [
          'You can request a copy of your details, ask for corrections, or ask for them to be deleted by contacting the organizer at the address on the contact page.',
        ],
      },
    ],
  },
  {
    slug: 'refunds',
    title: 'Refund and cancellation policy',
    intro:
      'Each event sets its own refund policy, shown on the event page before you pay. This page explains how it works.',
    needsReview: true,
    sections: [
      {
        heading: 'What the event page tells you',
        body: [
          'Every event states its refund policy and, where relevant, the date after which refunds are no longer available. That policy is what applies to your order.',
        ],
      },
      {
        heading: 'How to request a refund',
        body: [
          `Contact the organizer with your registration reference. A refund can only be issued against a captured payment, and only within that event\u2019s policy.`,
          'The refund is submitted to the payment provider and is shown as pending until the provider confirms it. Bank posting usually takes a few business days after that.',
        ],
      },
      {
        heading: 'Per-ticket refunds',
        body: [
          'Where an order contains several tickets, the organizer may refund some of them. Tickets covered by a confirmed refund are voided and will not be admitted.',
        ],
      },
      {
        heading: 'Event cancellation',
        body: [
          'If an organizer cancels an event, paid registrations are refunded. Registration is reopened or closed according to the organizer\u2019s decision.',
        ],
      },
    ],
  },
  {
    slug: 'contact',
    title: 'Contact',
    intro: `How to reach the organizers of ${organizer}.`,
    needsReview: true,
    sections: [
      {
        heading: 'Registration questions',
        body: [
          'Quote your registration reference — it is shown on your confirmation page and in your confirmation email.',
        ],
      },
      {
        heading: 'Refunds and cancellations',
        body: [
          'Refund requests must come from the email address used to register, so we can verify the request.',
        ],
      },
    ],
  },
];

export function getPolicy(slug: string): PolicyPage | undefined {
  return policies.find((page) => page.slug === slug);
}
