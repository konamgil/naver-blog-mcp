import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/client.js';
import { encrypt } from '../lib/crypto.js';
import { automatedLogin, interactiveLogin } from '../naver/login.js';
import { publishPost } from '../naver/publish.js';
import { hasSession } from '../naver/session.js';
import { deletePostById } from '../services/deleter.js';
import { publishById } from '../services/publisher.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function fail(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: `Error: ${msg}` }],
    isError: true,
  };
}

/**
 * naverId에 대응하는 account를 upsert. 비밀번호 옵션, hasSession=true.
 */
async function upsertAccountWithSession(args: {
  naverId: string;
  label?: string;
  blogId?: string;
  password?: string;
}): Promise<{ id: number; isNew: boolean }> {
  const existing = await db.query.accounts.findFirst({
    where: eq(schema.accounts.naverId, args.naverId),
  });
  if (existing) {
    await db
      .update(schema.accounts)
      .set({
        label: args.label ?? existing.label,
        blogId: args.blogId ?? existing.blogId,
        encryptedPassword: args.password
          ? encrypt(args.password)
          : existing.encryptedPassword,
        hasSession: true,
      })
      .where(eq(schema.accounts.id, existing.id));
    return { id: existing.id, isNew: false };
  }
  const [row] = await db
    .insert(schema.accounts)
    .values({
      label: args.label ?? args.naverId,
      naverId: args.naverId,
      blogId: args.blogId ?? null,
      encryptedPassword: args.password ? encrypt(args.password) : null,
      hasSession: true,
    })
    .returning();
  if (!row?.id) throw new Error('failed to insert account');
  return { id: row.id, isNew: true };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'naver-blog-mcp',
    version: '0.1.2',
  });

  server.registerTool(
    'naver_register_account',
    {
      title: '네이버 계정 등록',
      description:
        '발행에 사용할 네이버 계정 등록. 비밀번호는 옵션(세션 만료 시 자동 재로그인 폴백용). ' +
        'blogId 미지정 시 첫 발행 때 자동 추출.',
      inputSchema: {
        label: z.string().describe('내부 식별용 라벨 (예: "내 블로그")'),
        naverId: z.string().describe('네이버 로그인 ID'),
        blogId: z.string().optional().describe('블로그 URL ID (naverId와 다를 수 있음)'),
        password: z.string().optional().describe('비밀번호 (옵션, AES-GCM 암호화 저장)'),
      },
    },
    async ({ label, naverId, blogId, password }) => {
      try {
        const [row] = await db
          .insert(schema.accounts)
          .values({
            label,
            naverId,
            blogId: blogId ?? null,
            encryptedPassword: password ? encrypt(password) : null,
            hasSession: hasSession(naverId),
          })
          .returning();
        return ok({
          id: row?.id,
          label,
          naverId,
          blogId: blogId ?? null,
          hasSession: hasSession(naverId),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'naver_list_accounts',
    {
      title: '계정 목록',
      description: '등록된 모든 네이버 계정 조회',
      inputSchema: {},
    },
    async () => {
      try {
        const rows = await db.query.accounts.findMany();
        return ok(
          rows.map((a) => ({
            id: a.id,
            label: a.label,
            naverId: a.naverId,
            blogId: a.blogId,
            hasPassword: Boolean(a.encryptedPassword),
            hasSession: hasSession(a.naverId),
            createdAt: a.createdAt,
          })),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'naver_delete_account',
    {
      title: '계정 삭제',
      description: 'DB에서 계정 제거 (세션 파일은 보존)',
      inputSchema: {
        id: z.number().int().positive(),
      },
    },
    async ({ id }) => {
      try {
        await db.delete(schema.accounts).where(eq(schema.accounts.id, id));
        return ok({ id, deleted: true });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'naver_login_with_credentials',
    {
      title: '네이버 ID/PW로 자동 로그인 + 계정 등록',
      description:
        'ID/PW로 자동 로그인 시도 → 성공 시 세션 저장 + 계정 자동 upsert. ' +
        '⚠️ 네이버는 자동 로그인을 강하게 차단해서 캡차/2FA 발동 시 실패함. ' +
        '그 경우 naver_login_interactive 사용. 비밀번호는 AES-GCM으로 암호화 저장.',
      inputSchema: {
        naverId: z.string(),
        password: z.string(),
        label: z.string().optional(),
        blogId: z.string().optional(),
      },
    },
    async ({ naverId, password, label, blogId }) => {
      try {
        await automatedLogin(naverId, password);
        const acct = await upsertAccountWithSession({ naverId, password, label, blogId });
        return ok({
          accountId: acct.id,
          isNew: acct.isNew,
          naverId,
          hasSession: true,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'naver_login_interactive',
    {
      title: '브라우저 띄워서 사용자 직접 로그인',
      description:
        '서버 PC에 브라우저 창이 떠서 사용자가 직접 로그인 (캡차/2FA 가능). ' +
        '로그인 완료 후 세션 저장 + 계정 자동 upsert. 같은 PC 앞에 사용자가 있어야 함.',
      inputSchema: {
        naverId: z.string(),
        label: z.string().optional(),
        blogId: z.string().optional(),
      },
    },
    async ({ naverId, label, blogId }) => {
      try {
        await interactiveLogin(naverId);
        const acct = await upsertAccountWithSession({ naverId, label, blogId });
        return ok({
          accountId: acct.id,
          isNew: acct.isNew,
          naverId,
          hasSession: true,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'naver_login_status',
    {
      title: '세션 상태 확인',
      description: '저장된 Playwright 세션이 있는지 확인 (실제 유효성은 발행 시 검증)',
      inputSchema: {
        naverId: z.string(),
      },
    },
    async ({ naverId }) => ok({ naverId, hasSession: hasSession(naverId) }),
  );

  server.registerTool(
    'naver_create_post',
    {
      title: '글 등록 (draft/scheduled)',
      description:
        'DB에 글 등록. scheduledAt 지정 시 스케줄러가 도래 시점에 자동 발행. ' +
        '즉시 발행은 naver_publish_post 또는 naver_publish_now 사용.',
      inputSchema: {
        accountId: z.number().int().positive(),
        title: z.string().min(1),
        content: z.string().min(1),
        tags: z.array(z.string()).optional(),
        category: z.string().optional(),
        scheduledAt: z
          .string()
          .datetime()
          .optional()
          .describe('ISO8601 UTC. 미지정 시 draft'),
      },
    },
    async ({ accountId, title, content, tags, category, scheduledAt }) => {
      try {
        const status = scheduledAt ? 'scheduled' : 'draft';
        const [row] = await db
          .insert(schema.posts)
          .values({
            accountId,
            title,
            content,
            tags: tags?.join(','),
            category,
            status,
            scheduledAt,
          })
          .returning();
        return ok({ id: row?.id, status });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'naver_publish_post',
    {
      title: '등록된 글 즉시 발행',
      description:
        '이미 DB에 있는 글을 네이버에 발행. 발행 완료까지 동기 대기 (수십 초 ~ 2분).',
      inputSchema: { postId: z.number().int().positive() },
    },
    async ({ postId }) => {
      try {
        await publishById(postId);
        const post = await db.query.posts.findFirst({
          where: eq(schema.posts.id, postId),
        });
        return ok({
          postId,
          status: post?.status,
          naverUrl: post?.naverUrl,
          publishedAt: post?.publishedAt,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'naver_publish_now',
    {
      title: '등록 + 발행 한 번에',
      description: '글 DB 등록과 즉시 발행을 한 번에. 발행 완료까지 동기 대기.',
      inputSchema: {
        accountId: z.number().int().positive(),
        title: z.string().min(1),
        content: z.string().min(1),
        tags: z.array(z.string()).optional(),
        category: z.string().optional(),
      },
    },
    async ({ accountId, title, content, tags, category }) => {
      try {
        const [row] = await db
          .insert(schema.posts)
          .values({
            accountId,
            title,
            content,
            tags: tags?.join(','),
            category,
            status: 'draft',
          })
          .returning();
        if (!row?.id) throw new Error('failed to create post');
        await publishById(row.id);
        const post = await db.query.posts.findFirst({
          where: eq(schema.posts.id, row.id),
        });
        return ok({
          postId: row.id,
          status: post?.status,
          naverUrl: post?.naverUrl,
          publishedAt: post?.publishedAt,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'naver_list_posts',
    {
      title: '글 목록',
      description: '글 목록 조회 (status로 필터 가능)',
      inputSchema: {
        status: z
          .enum(['draft', 'scheduled', 'publishing', 'published', 'failed'])
          .optional(),
        limit: z.number().int().min(1).max(500).default(50),
      },
    },
    async ({ status, limit }) => {
      try {
        const rows = await db.query.posts.findMany({
          where: status ? eq(schema.posts.status, status) : undefined,
          orderBy: [desc(schema.posts.createdAt)],
          limit,
        });
        return ok(rows);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'naver_delete_post',
    {
      title: '글 삭제',
      description:
        'DB에서 글 제거 + (published 상태면) 네이버에서도 삭제. ' +
        'deleteOnNaver=false 시 DB에서만.',
      inputSchema: {
        postId: z.number().int().positive(),
        deleteOnNaver: z.boolean().default(true),
      },
    },
    async ({ postId, deleteOnNaver }) => {
      try {
        const res = await deletePostById(postId, { deleteOnNaver });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 직접 발행 (DB 거치지 않는 ad-hoc 도구) — 디버깅/스크립트용
  server.registerTool(
    'naver_publish_adhoc',
    {
      title: '계정 단건 발행 (DB 우회)',
      description:
        '저장된 세션으로 즉시 발행. DB에 기록 없이 호출. 결과 URL만 반환.',
      inputSchema: {
        naverId: z.string(),
        blogId: z.string().optional(),
        title: z.string().min(1),
        content: z.string().min(1),
        tags: z.array(z.string()).optional(),
        category: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const res = await publishPost(args);
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
