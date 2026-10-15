import type { Locale } from './locales';

/**
 * Strings for the owner-only admin page. A catalog of its own, typed the same
 * way as messages.ts (English defines the shape, zh-Hans must match it), but
 * imported only by the lazily loaded admin page, so none of it ships in the
 * main bundle everyone downloads.
 */
const en = {
  title: 'the *back office*',
  totalUsers: 'people',
  signupsTitle: 'sign-ups, last 30 days',
  signupsChart: (total: number) => `Sign-ups per day for the last 30 days, ${total} in all`,
  signupsDay: (day: string, n: number) => `${day}: ${n}`,
  dayCol: 'day',
  countCol: 'sign-ups',
  usersTitle: 'everyone',
  name: 'name',
  joined: 'joined',
  lastSeen: 'last seen',
  spots: 'spots',
  friends: 'friends',
  loading: 'counting…',
  /** Someone who hasn't chosen a name yet. */
  unnamed: '(no name yet)',
};

export type AdminMessages = typeof en;

const zh: AdminMessages = {
  title: '*后台*',
  totalUsers: '用户',
  signupsTitle: '最近 30 天注册',
  signupsChart: (total) => `最近 30 天每天的注册人数，共 ${total} 人`,
  signupsDay: (day, n) => `${day}：${n}`,
  dayCol: '日期',
  countCol: '注册',
  usersTitle: '所有人',
  name: '名字',
  joined: '注册于',
  lastSeen: '最近活跃',
  spots: '店',
  friends: '好友',
  loading: '数一数…',
  unnamed: '（还没起名字）',
};

export const ADMIN_MESSAGES: Record<Locale, AdminMessages> = { en, 'zh-Hans': zh };
