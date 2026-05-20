import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { decrypt } from '../lib/crypto.js';
import { automatedLogin } from '../naver/login.js';
import { publishPost } from '../naver/publish.js';
import { hasSession } from '../naver/session.js';

const inFlight = new Set<number>();

/**
 * 단일 post id를 발행한다. 동시 발행 락 + 상태 머신 + 세션 폴백 포함.
 */
export async function publishById(postId: number): Promise<void> {
  if (inFlight.has(postId)) return;
  inFlight.add(postId);

  try {
    const post = await db.query.posts.findFirst({
      where: eq(schema.posts.id, postId),
    });
    if (!post) throw new Error(`post ${postId} not found`);
    if (post.status === 'publishing' || post.status === 'published') return;

    const account = await db.query.accounts.findFirst({
      where: eq(schema.accounts.id, post.accountId),
    });
    if (!account) throw new Error(`account ${post.accountId} not found`);

    await db
      .update(schema.posts)
      .set({ status: 'publishing', errorMessage: null, updatedAt: nowIso() })
      .where(eq(schema.posts.id, postId));

    // 세션 없으면 자동 로그인 시도
    if (!hasSession(account.naverId)) {
      if (!account.encryptedPassword) {
        throw new Error('NO_SESSION_NO_PASSWORD: 먼저 `pnpm naver:login` 실행 필요');
      }
      const password = decrypt(account.encryptedPassword);
      await automatedLogin(account.naverId, password);
    }

    const publishArgs = {
      naverId: account.naverId,
      blogId: account.blogId ?? undefined,
      title: post.title,
      content: post.content,
      tags: post.tags?.split(',').map((t) => t.trim()).filter(Boolean),
      category: post.category ?? undefined,
    };

    let result;
    try {
      result = await publishPost(publishArgs);
    } catch (err) {
      // 세션이 만료된 경우 (네이버가 세션 invalidate) 저장된 비밀번호로 자동 재로그인 후 1회 retry.
      // 이렇게 하면 ID/PW가 저장돼 있는 한 사용자 개입 없이 발행을 이어갈 수 있다.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('SESSION_EXPIRED') && account.encryptedPassword) {
        const password = decrypt(account.encryptedPassword);
        await automatedLogin(account.naverId, password);
        result = await publishPost(publishArgs);
      } else {
        throw err;
      }
    }

    // 처음 발행 시 자동 추출된 blogId를 account에 저장 (다음번부터 재사용)
    if (!account.blogId && result.blogId) {
      await db
        .update(schema.accounts)
        .set({ blogId: result.blogId })
        .where(eq(schema.accounts.id, account.id));
    }

    await db
      .update(schema.posts)
      .set({
        status: 'published',
        publishedAt: nowIso(),
        naverUrl: result.naverUrl,
        updatedAt: nowIso(),
      })
      .where(eq(schema.posts.id, postId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.posts)
      .set({ status: 'failed', errorMessage: message, updatedAt: nowIso() })
      .where(eq(schema.posts.id, postId));
    throw err;
  } finally {
    inFlight.delete(postId);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
