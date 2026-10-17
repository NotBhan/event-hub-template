import { createAccessControl } from 'better-auth/plugins/access';

/**
 * Application authorization model.
 *
 * Better Auth proves *who* the user is; this module defines *what* they may do.
 * Permissions are attached to organization membership, and every protected
 * server operation checks them independently — the browser never decides its own
 * role, and no endpoint trusts a client-supplied organization or role.
 *
 * Roles follow the architecture spec:
 *   owner         full control: staff, events, finance, settings
 *   admin         events, staff and registrations; no ownership or billing rights
 *   event_manager assigned events, ticket types, attendee lists and reports
 *   finance       financial records, permitted refunds and exports
 *   checkin_staff ticket scanning and minimal admission information
 *   attendee      their own registrations and tickets
 */
export const statement = {
  /**
   * Organization resources. Declared explicitly rather than inherited from the
   * plugin defaults: this application needs staff to be able to *read* the
   * member list, which the default statement set does not grant.
   */
  organization: ['update', 'delete'],
  member: ['create', 'read', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  team: ['create', 'update', 'delete'],
  ac: ['create', 'read', 'update', 'delete'],

  event: ['create', 'read', 'update', 'delete', 'publish', 'cancel'],
  ticket_type: ['create', 'read', 'update', 'delete'],

  order: ['create', 'read', 'cancel', 'export'],
  attendee: ['read', 'update', 'export'],

  payment: ['read', 'export'],
  refund: ['read', 'create'],
  /** Distinct from refunds: settlement and payout records. */
  payout: ['read', 'manage'],

  ticket: ['read', 'void'],
  check_in: ['read', 'perform', 'override'],

  settings: ['read', 'update'],
  report: ['read', 'export'],
  audit: ['read'],
} as const;

export const ac = createAccessControl(statement);

/** Full control, including ownership transfer and settlement visibility. */
export const owner = ac.newRole({
  organization: ['update', 'delete'],
  member: ['create', 'read', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  team: ['create', 'update', 'delete'],
  ac: ['create', 'read', 'update', 'delete'],
  event: ['create', 'read', 'update', 'delete', 'publish', 'cancel'],
  ticket_type: ['create', 'read', 'update', 'delete'],
  order: ['create', 'read', 'cancel', 'export'],
  attendee: ['read', 'update', 'export'],
  payment: ['read', 'export'],
  refund: ['read', 'create'],
  payout: ['read', 'manage'],
  ticket: ['read', 'void'],
  check_in: ['read', 'perform', 'override'],
  settings: ['read', 'update'],
  report: ['read', 'export'],
  audit: ['read'],
});

/** Everything an owner can do except destroying the organization or moving money. */
const admin = ac.newRole({
  organization: [],
  member: ['create', 'read', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  team: ['create', 'update', 'delete'],
  ac: ['read'],
  event: ['create', 'read', 'update', 'delete', 'publish', 'cancel'],
  ticket_type: ['create', 'read', 'update', 'delete'],
  order: ['create', 'read', 'cancel', 'export'],
  attendee: ['read', 'update', 'export'],
  payment: ['read', 'export'],
  refund: ['read', 'create'],
  payout: [],
  ticket: ['read', 'void'],
  check_in: ['read', 'perform', 'override'],
  settings: ['read', 'update'],
  report: ['read', 'export'],
  audit: ['read'],
});

/** Runs events day to day. No access to money or organization settings. */
const eventManager = ac.newRole({
  member: ['read'],
  event: ['create', 'read', 'update', 'publish', 'cancel'],
  ticket_type: ['create', 'read', 'update', 'delete'],
  order: ['read', 'export'],
  attendee: ['read', 'update', 'export'],
  ticket: ['read', 'void'],
  check_in: ['read', 'perform'],
  report: ['read', 'export'],
});

/** Sees and moves money, but does not edit events. */
const finance = ac.newRole({
  member: ['read'],
  event: ['read'],
  order: ['read', 'export'],
  attendee: ['read', 'export'],
  payment: ['read', 'export'],
  refund: ['read', 'create'],
  payout: ['read'],
  report: ['read', 'export'],
  audit: ['read'],
});

/** Doors only: scan tickets for assigned events and see minimal attendee data. */
const checkinStaff = ac.newRole({
  member: ['read'],
  event: ['read'],
  ticket: ['read'],
  check_in: ['read', 'perform'],
  attendee: ['read'],
});

/** A signed-in attendee acting inside their own registrations. */
const attendee = ac.newRole({
  event: ['read'],
  order: ['create', 'read'],
  ticket: ['read'],
});

export const roles = {
  owner,
  admin,
  event_manager: eventManager,
  finance,
  checkin_staff: checkinStaff,
  attendee,
} as const;

export type OrganizationRole = keyof typeof roles;

/** Application roles, in descending order of authority. */
export const ORGANIZATION_ROLES: OrganizationRole[] = [
  'owner',
  'admin',
  'event_manager',
  'finance',
  'checkin_staff',
  'attendee',
];

/** Roles allowed to reach the organizer dashboard at all. */
export const ORGANIZER_ROLES: OrganizationRole[] = [
  'owner',
  'admin',
  'event_manager',
  'finance',
  'checkin_staff',
];

export function isOrganizationRole(value: string): value is OrganizationRole {
  return Object.hasOwn(roles, value);
}

export function isOrganizerRole(value: string): value is OrganizationRole {
  return isOrganizationRole(value) && ORGANIZER_ROLES.includes(value);
}

export const roleLabels: Record<OrganizationRole, string> = {
  owner: 'Owner',
  admin: 'Administrator',
  event_manager: 'Event manager',
  finance: 'Finance',
  checkin_staff: 'Check-in staff',
  attendee: 'Attendee',
};

export type PermissionResource = keyof typeof statement;
