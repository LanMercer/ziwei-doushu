/**
 * lib/ai/gateway —— 本地 AI 通道共享层
 *
 * 从 /api/interpret 里抽出来的那套东西：SSE 封装、访问口令、限流、通道配置、
 * 命盘脱敏摘要、上游错误翻译、流式转发。新的 /api/heming 直接复用，
 * 保证两个接口共用同一份配额、同一套 key、同一种脱敏口径。
 */

import type { NextRequest } from 'next/server';
import type { ZiweiChart, Palace } from '@/lib/ziwei/types';
import { BRANCHES, STEMS } from '@/lib/ziwei/constants';

const encoder = new TextEncoder();

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
};

export const DONE_CHUNK = encoder.encode('data: [DONE]\n\n');

export function sseChunk(text: string): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({ delta: { text } })}\n\n`);
}

/** 把若干帧包成 SSE 响应（错误提示也走这条路，前端才能把话显示出来） */
export function respondWith(parts: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

export function failWith(message: string): Response {
  return respondWith([sseChunk(message), DONE_CHUNK]);
}

// ────────────────── 上线防护：限流 + 访问口令 ──────────────────

const RATE = {
  perMinutePerIp: Number(process.env.RATE_PER_MINUTE ?? 3),
  perDayPerIp: Number(process.env.RATE_PER_DAY_IP ?? 30),
  perDayGlobal: Number(process.env.RATE_PER_DAY_GLOBAL ?? 400),
};

interface RateBucket {
  minuteStart: number;
  minuteCount: number;
  dayStart: number;
  dayCount: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ipBuckets = new Map<string, RateBucket>();
let globalBucket = { dayStart: 0, dayCount: 0 };

export function clientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0];
    if (first && first.trim()) return first.trim();
  }
  return req.headers.get('x-real-ip') ?? 'unknown';
}

/** 返回 null 表示放行，返回字符串表示要被拦下的原因 */
export function hitRate(ip: string): string | null {
  const now = Date.now();
  const trackPerIp = ip !== 'unknown';
  let b = ipBuckets.get(ip);
  if (!b) {
    b = { minuteStart: now, minuteCount: 0, dayStart: now, dayCount: 0 };
    ipBuckets.set(ip, b);
  }
  if (now - b.minuteStart > 60_000) { b.minuteStart = now; b.minuteCount = 0; }
  if (now - b.dayStart > DAY_MS) { b.dayStart = now; b.dayCount = 0; }
  if (now - globalBucket.dayStart > DAY_MS) { globalBucket = { dayStart: now, dayCount: 0 }; }

  if (trackPerIp && b.minuteCount >= RATE.perMinutePerIp) {
    return `问得有点快，每分钟最多 ${RATE.perMinutePerIp} 次，缓一下再继续。`;
  }
  if (trackPerIp && b.dayCount >= RATE.perDayPerIp) {
    return `今天这台设备的 ${RATE.perDayPerIp} 次额度已用完，明天再来。`;
  }
  if (globalBucket.dayCount >= RATE.perDayGlobal) {
    return '今天的全站额度已经用完，明天再来。';
  }

  if (trackPerIp) {
    b.minuteCount += 1;
    b.dayCount += 1;
  }
  globalBucket.dayCount += 1;

  if (ipBuckets.size > 2000) {
    for (const [key, bucket] of ipBuckets) {
      if (now - bucket.dayStart > DAY_MS) ipBuckets.delete(key);
    }
  }
  return null;
}

/** 没配 ACCESS_CODE 就等同于不启用口令 */
export function accessCodeOk(req: NextRequest): boolean {
  const expected = process.env.ACCESS_CODE?.trim();
  if (!expected) return true;
  return req.headers.get('x-access-code')?.trim() === expected;
}

/** 前端收到 401 会提示输入口令 */
export function accessCodeRejected(): Response {
  return new Response(JSON.stringify({ error: 'access-code-required' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// ────────────────── 通道配置 ──────────────────

export interface ProviderConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function resolveConfig(): ProviderConfig {
  const provider = (process.env.AI_PROVIDER || 'deepseek').toLowerCase();

  const fallback: Record<string, { key: string; base: string; model: string }> = {
    deepseek: {
      key: process.env.DEEPSEEK_API_KEY || '',
      base: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    },
    mimo: {
      key: process.env.MIMO_API_KEY || '',
      base: process.env.MIMO_BASE_URL || 'https://api.deepseek.com/v1',
      model: process.env.MIMO_MODEL || 'deepseek-chat',
    },
    ollama: {
      key: '',
      base: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:7b',
    },
  };

  const preset = fallback[provider] ?? fallback.deepseek;

  return {
    provider,
    apiKey: process.env.AI_API_KEY || preset.key,
    baseUrl: (process.env.AI_BASE_URL || preset.base).replace(/\/+$/, ''),
    model: process.env.AI_MODEL || preset.model,
  };
}

// ────────────────── 命盘 → 文本（脱敏） ──────────────────

function palaceLine(palace: Palace): string {
  const stars = palace.stars.length
    ? palace.stars
        .map(s => `${s.name}${s.siHua ? `化${s.siHua}` : ''}${s.brightnessRaw ? `·${s.brightnessRaw}` : ''}`)
        .join('、')
    : palace.borrowedStars?.length
      ? `空宫（借对宫${palace.borrowedFromName ?? ''}：${palace.borrowedStars.join('、')}）`
      : '空宫';

  const tags: string[] = [];
  if (palace.isMingGong) tags.push('命宫');
  if (palace.isShenGong) tags.push('身宫');
  if (palace.daXianAge) tags.push(`本宫大限${palace.daXianAge[0]}–${palace.daXianAge[1]}岁`);
  if (palace.isCurrentDaXian) tags.push('★当前大限');
  if (palace.selfSihua?.length) {
    tags.push(`自化 ${palace.selfSihua.map(s => `${s.starName}化${s.siHua}`).join('、')}`);
  }

  const suffix = tags.length ? `（${tags.join('；')}）` : '';
  return `${BRANCHES[palace.branch]}宫 ${palace.name}·${STEMS[palace.stem]}干：${stars}${suffix}`;
}

/** 只输出排盘结果：不含姓名、出生地、经纬度、生日、四柱（PRIVACY_INCLUDE_BIRTH=1 时才追加生辰） */
export function buildChartDigest(chart: ZiweiChart): string {
  const lines: string[] = [];

  lines.push(`性别：${chart.birthInfo.gender === 'female' ? '女' : '男'}`);
  if (chart.yinYangGender) lines.push(`阴阳属性：${chart.yinYangGender}`);
  lines.push(`五行局：${chart.wuxingJuName}`);
  lines.push(`命宫在${BRANCHES[chart.mingGongBranch]}，身宫在${BRANCHES[chart.shenGongBranch]}`);
  if (chart.mingZhu) lines.push(`命主：${chart.mingZhu}；身主：${chart.shenZhu ?? '—'}`);
  lines.push(`当前虚岁：${chart.currentAge}（当前年份：${new Date().getFullYear()}）`);

  lines.push('', '【十二宫】');
  const palaces = [...chart.palaces].sort((a, b) => a.branch - b.branch);
  for (const palace of palaces) lines.push(palaceLine(palace));

  lines.push('', '【大限】');
  for (const dx of chart.daXians) {
    const sihua = dx.siHua
      ? `｜${dx.stemName ?? ''}干四化：禄${dx.siHua.lu} 权${dx.siHua.quan} 科${dx.siHua.ke} 忌${dx.siHua.ji}`
      : '';
    const current = chart.daXians[chart.currentDaXianIndex] === dx ? ' ★当前' : '';
    lines.push(`${dx.startAge}–${dx.endAge}岁 ${dx.palaceName}${sihua}${current}`);
  }

  if (process.env.PRIVACY_INCLUDE_BIRTH === '1') {
    const b = chart.birthInfo;
    const l = chart.lunarInfo;
    lines.push('', '【生辰（用户已授权发送）】');
    lines.push(`公历：${b.year}-${b.month}-${b.day}，时辰支序号 ${b.hour}`);
    lines.push(`农历：${l.lunarYear}年${l.isLeapMonth ? '闰' : ''}${Math.abs(l.lunarMonth)}月${l.lunarDay}日`);
    if (l.fourPillars) lines.push(`四柱：${l.fourPillars.join(' ')}`);
  }

  return lines.join('\n');
}

// ────────────────── 上游错误 → 人话 ──────────────────

export function explainUpstream(status: number, bodyText: string): string {
  const detail = bodyText.slice(0, 300).replace(/\s+/g, ' ').trim();
  const hint =
    status === 401
      ? 'API Key 无效或已失效，请检查 .env.local 里的 DEEPSEEK_API_KEY。'
      : status === 402
        ? '账户余额不足，请到 platform.deepseek.com 充值。'
        : status === 429
          ? '请求太频繁或额度用尽，等一会儿再试。'
          : status >= 500
            ? '模型服务端故障，稍后重试。'
            : '请求被拒绝。';
  return `分析失败：${hint}\n\n（HTTP ${status}${detail ? `｜${detail}` : ''}）`;
}

/** 没有配置 Key 时的统一提示（两个接口共用） */
export function missingKeyResponse(): Response {
  return respondWith([
    sseChunk(
      [
        '还没有配置 API Key，所以解读跑不起来。',
        '',
        '请打开项目根目录下的 .env.local，把这一行填上：',
        'DEEPSEEK_API_KEY=sk-你的Key',
        '',
        '保存后**重启** npm run dev（Next 只在启动时读 env），再刷新本页即可。',
        '',
        'Key 在 https://platform.deepseek.com/api_keys 创建。排盘本身不需要 Key。',
      ].join('\n'),
    ),
    DONE_CHUNK,
  ]);
}

// ────────────────── 上游 SSE → 前端 SSE ──────────────────

/**
 * 请求 OpenAI 兼容上游并把增量转发成前端认的 `data: {"delta":{"text":…}}` 流。
 * 任何错误都以 200 + 流式文案返回，前端才能把原因显示出来。
 */
export async function proxyChat(
  cfg: ProviderConfig,
  payload: unknown,
  signal: AbortSignal,
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return failWith(
      aborted
        ? '（已取消）'
        : `连不上 ${cfg.baseUrl}。\n\n请检查：1) 网络能否访问该地址；2) .env.local 里 AI_BASE_URL 是否写错。`,
    );
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    return failWith(explainUpstream(upstream.status, text));
  }

  const upstreamBody = upstream.body;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstreamBody.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let closed = false;

      const push = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };

      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.enqueue(DONE_CHUNK);
          controller.close();
        } catch {
          /* 客户端已断开 */
        }
      };

      try {
        for (;;) {
          const result = await reader.read();
          if (result.done || !result.value) break;

          buffer += decoder.decode(result.value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? ''; // 留住可能被切断的半行

          for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith('data:')) continue;

            const data = line.slice(5).trim();
            if (!data) continue;
            if (data === '[DONE]') {
              finish();
              return;
            }

            try {
              const json = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
              const text = json.choices?.[0]?.delta?.content;
              if (text) push(sseChunk(text));
            } catch {
              /* 心跳 / 非 JSON 行 */
            }
          }
        }
        finish();
      } catch {
        push(sseChunk('\n\n（连接中断，请重试）'));
        finish();
      } finally {
        reader.releaseLock?.();
      }
    },
    cancel() {
      void upstreamBody.cancel().catch(() => {});
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
