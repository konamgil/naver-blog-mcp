import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from 'playwright';
import { launchContext, saveSession } from './browser.js';
import { hasSession } from './session.js';

export interface PublishInput {
  naverId: string;
  /** 블로그 ID. 네이버 ID와 다를 수 있음. 생략 시 naverId로 시도 */
  blogId?: string;
  title: string;
  content: string;
  tags?: string[];
  category?: string;
}

export interface PublishResult {
  naverUrl?: string;
  blogId?: string;
}

/**
 * 네이버 블로그 글 발행.
 *
 * 구조: SmartEditor ONE은 iframe이 아니라 page 자체에 렌더링됨.
 *  - 제목: .se-section-documentTitle
 *  - 본문: .se-section-text (첫 번째)
 *  - 발행 버튼: button.publish_btn__... (해시 변동) — text "발행" 으로 매칭
 */
export async function publishPost(input: PublishInput): Promise<PublishResult> {
  if (!hasSession(input.naverId)) {
    throw new Error(`NO_SESSION: '${input.naverId}' 세션이 없습니다. 먼저 로그인하세요.`);
  }

  const { browser, context } = await launchContext({ naverId: input.naverId });
  const page = await context.newPage();

  try {
    const blogId = await resolveBlogId(page, input.naverId, input.blogId);

    await page.goto(`https://blog.naver.com/${blogId}/postwrite`, {
      waitUntil: 'domcontentloaded',
    });

    if (page.url().includes('nid.naver.com')) {
      throw new Error('SESSION_EXPIRED');
    }

    await waitForEditorReady(page);
    await dismissPopups(page);
    await fillTitle(page, input.title);
    await fillContent(page, input.content);

    await clickInitialPublish(page);
    await fillPublishOptions(page, input);
    await confirmPublish(page);

    const naverUrl = await waitForPostUrl(page);
    await saveSession(context, input.naverId).catch(() => undefined);

    return { naverUrl, blogId };
  } finally {
    await context.close();
    await browser.close();
  }
}

/**
 * blogId가 주어지면 그대로 사용. 아니면 blog.naver.com 으로 가서
 * 본인 블로그 ID를 URL에서 추출 시도.
 */
async function resolveBlogId(
  page: Page,
  naverId: string,
  hint?: string,
): Promise<string> {
  if (hint) return hint;

  await page.goto('https://blog.naver.com/', { waitUntil: 'domcontentloaded' });
  const m = page.url().match(/blog\.naver\.com\/([a-zA-Z0-9_-]+)/);
  if (m && m[1] && m[1] !== 'PostList.naver') return m[1];

  // fallback: try naverId (often same as blogId)
  return naverId;
}

async function waitForEditorReady(page: Page): Promise<void> {
  await page.waitForSelector('.se-section-documentTitle', { timeout: 30_000 });
  // 에디터 placeholder가 뜰 때까지 대기
  await page.waitForSelector('.se-placeholder', { timeout: 30_000 });
  await page.waitForTimeout(800);
}

async function dismissPopups(page: Page): Promise<void> {
  // "작성 중인 글" 복원 다이얼로그. 취소(새로 작성) 선택.
  // ⚠️ 'button:has-text("취소")' 같은 부분 매칭은 toolbar의 "취소선(strikethrough)"
  //    버튼까지 잡아서 본문 입력 전에 strike가 켜져버리는 버그가 있었음.
  //    정확한 다이얼로그 selector만 사용.
  for (const sel of [
    'button.se-popup-button-cancel',
    '.se-popup-button-cancel',
  ]) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 2000 }).catch(() => undefined);
      await page.waitForTimeout(300);
    }
  }
  // 도움말/온보딩 닫기
  for (const sel of [
    'button.se-help-panel-close-button',
    '.se-help-panel-close-button',
    '.se-help-panel button[class*="close"]',
    'button[aria-label="닫기"]',
    '.se-popup-button-close',
  ]) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 2000 }).catch(() => undefined);
      await page.waitForTimeout(200);
    }
  }
  // 마지막 보루: 도움말 패널이 남아있으면 JS로 강제 숨김.
  // (자동화 시 도움말이 발행 버튼을 덮는 경우 빈번)
  await page
    .evaluate(() => {
      const g = globalThis as unknown as {
        document: {
          querySelectorAll: (s: string) => ArrayLike<{
            setAttribute: (k: string, v: string) => void;
          }>;
        };
      };
      const sel = '.se-help-panel, [class*="se-help-panel"], .se-help-title';
      const nodes = g.document.querySelectorAll(sel);
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (el) {
          el.setAttribute(
            'style',
            'display:none !important; pointer-events:none !important;',
          );
        }
      }
    })
    .catch(() => undefined);
}

async function fillTitle(page: Page, title: string): Promise<void> {
  const titleArea = page.locator('.se-section-documentTitle').first();
  await titleArea.click();
  await page.waitForTimeout(200);
  await page.keyboard.type(title, { delay: 5 });
}

async function fillContent(page: Page, content: string): Promise<void> {
  // 제목 영역이 아닌 본문 영역
  const body = page.locator('.se-section-text').first();
  await body.click();
  await page.waitForTimeout(200);

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.keyboard.press('Enter');
    const line = lines[i] ?? '';
    if (line) await page.keyboard.type(line, { delay: 5 });
  }
}

async function clickInitialPublish(page: Page): Promise<void> {
  // 발행 직전 도움말이 다시 떠 있을 수 있으니 한번 더 닫기
  await dismissPopups(page);
  const btn = page
    .locator(
      'button[data-click-area="tpb.publish"], button[class*="publish_btn"]',
    )
    .first();
  await btn.click({ timeout: 10_000 });
  await page.waitForTimeout(1200);
}

async function fillPublishOptions(page: Page, input: PublishInput): Promise<void> {
  if (input.category) {
    const catBtn = page.locator('button:has-text("카테고리")').first();
    if (await catBtn.isVisible().catch(() => false)) {
      await catBtn.click().catch(() => undefined);
      await page.locator(`label:has-text("${input.category}")`).first()
        .click({ timeout: 3000 }).catch(() => undefined);
    }
  }
  if (input.tags?.length) {
    const tagInput = page
      .locator('#tag-input, input[placeholder*="태그"], input[id^="tag"]')
      .first();
    if (await tagInput.isVisible().catch(() => false)) {
      for (const tag of input.tags) {
        await tagInput.fill(tag).catch(() => undefined);
        await tagInput.press('Enter').catch(() => undefined);
      }
    }
  }
}

async function confirmPublish(page: Page): Promise<void> {
  // 발행 패널 내부 최종 "발행" 버튼.
  // data-click-area="tpb*i.publish" 가 정확. confirm_btn 클래스는 해시가 붙음.
  const final = page
    .locator(
      'button[data-click-area="tpb*i.publish"], button[class*="confirm_btn"]',
    )
    .first();
  await final.click({ timeout: 15_000 });
}

async function waitForPostUrl(page: Page): Promise<string | undefined> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url.includes('PostView') || url.includes('/postView') || url.includes('postList')) {
      return url;
    }
    await sleep(500);
  }
  return undefined;
}
