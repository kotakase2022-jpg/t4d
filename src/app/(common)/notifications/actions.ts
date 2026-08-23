'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth/session';
import { NotFoundError } from '@/lib/authorization/can';
import { getDb } from '@/lib/repositories';

/**
 * 通知を既読にする。
 *
 * 既読にする手段が無いと、ヘッダーの未読バッジが永久に消えず、
 * 新しい通知が来たことに気づけなくなる。
 * 自分宛の通知だけを対象にする（notifications の RLS も user_id = auth.uid()）。
 */
export async function markNotificationReadAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const ctx = session.context;
  const db = await getDb();

  const notificationId = String(formData.get('notificationId') ?? '');
  if (!notificationId) throw new NotFoundError('通知が見つかりません。');

  const notification = await db.findById('notifications', notificationId);
  // 他人宛の通知を既読にできないよう、必ず本人確認する
  if (!notification || notification.userId !== ctx.userId) {
    throw new NotFoundError('通知が見つかりません。');
  }
  if (notification.readAt) return;

  await db.update('notifications', notificationId, { readAt: new Date().toISOString() });
  revalidatePath('/notifications');
}

/** 未読の通知をまとめて既読にする */
export async function markAllNotificationsReadAction(): Promise<void> {
  const session = await requireSession();
  const ctx = session.context;
  const db = await getDb();

  const unread = await db.select('notifications', {
    where: { userId: ctx.userId, readAt: { isNull: true } },
  });
  const now = new Date().toISOString();
  for (const notification of unread) {
    await db.update('notifications', notification.id, { readAt: now });
  }
  revalidatePath('/notifications');
}
