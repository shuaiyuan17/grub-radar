import { z } from 'zod/mini';

/**
 * GET /api/admin/stats, for the owner-only admin page. Admins are named by
 * Apple `sub` in the ADMIN_APPLE_SUBS secret; to everyone else the endpoint
 * (and the page) doesn't exist: the same 404 as any unknown path.
 *
 * Deliberately thin: no emails, no Apple subs, no user ids, no coordinates.
 */

/** Days of sign-ups shown, today included. */
export const SIGNUP_DAYS = 30;

export const AdminUserSchema = z.strictObject({
  displayName: z.string(),
  avatarEmoji: z.string(),
  createdAt: z.string(),
  /** The latest of any session's last activity and the last sign-in (ISO). */
  lastSeenAt: z.string(),
  spots: z.number(),
  friends: z.number(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const AdminStatsSchema = z.strictObject({
  totalUsers: z.number(),
  /** One entry per UTC day, oldest first, SIGNUP_DAYS long, zeros included. */
  signupsByDay: z.array(z.strictObject({ day: z.string(), count: z.number() })),
  /** Newest account first. */
  users: z.array(AdminUserSchema),
});
export type AdminStats = z.infer<typeof AdminStatsSchema>;
