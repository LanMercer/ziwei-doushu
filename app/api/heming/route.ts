/**
 * app/api/heming —— 合盘 AI 分析接口（自建，非官方开源部分）
 *
 * 前端 app/heming/page.tsx 的契约：
 *   POST { chartA: ZiweiChart, chartB: ZiweiChart, question?: string }
 *   ← text/event-stream，每帧 `data: {"delta":{"text":"…"}}`，结尾 `data: [DONE]`
 *
 * 复用 lib/ai/gateway：同一套 Key、同一套脱敏口径（限流计数各自独立）。
 * 专业知识全部来自开源的 lib/ziwei/heming-knowledge.ts（方法论、夫妻宫断语、四化、评分）。
 */

import type { NextRequest } from 'next/server';
import type { ZiweiChart, Palace } from '@/lib/ziwei/types';
import {
  HEMING_METHODOLOGY,
  HEMING_SCORE_CRITERIA,
  SIHUA_IN_FUQI_GU,
  STAR_IN_FUQI_GU,
} from '@/lib/ziwei/heming-knowledge';
import {
  accessCodeOk,
  accessCodeRejected,
  buildChartDigest,
  clientIp,
  failWith,
  hitRate,
  missingKeyResponse,
  proxyChat,
  resolveConfig,
} from '@/lib/ai/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ────────────────── 从命盘里取合盘要用的局部信息 ──────────────────

function palaceOf(chart: ZiweiChart, name: string): Palace | undefined {
  return chart.palaces.find(p => p.name === name);
}

/** 夫妻宫的主星（空宫则取借到的对宫主星） */
function spouseStars(chart: ZiweiChart): string[] {
  const spouse = palaceOf(chart, '夫妻宫');
  if (!spouse) return [];
  const majors = spouse.stars.filter(s => s.type === 'major').map(s => s.name);
  if (majors.length > 0) return majors;
  return spouse.borrowedStars ?? [];
}

/** 只把两盘夫妻宫实际出现的星，对应的断语捞出来，别把整张表塞进去 */
function spouseReference(chartA: ZiweiChart, chartB: ZiweiChart): string {
  const stars = new Set([...spouseStars(chartA), ...spouseStars(chartB)]);
  const rows: string[] = [];
  for (const name of stars) {
    const entry = STAR_IN_FUQI_GU[name];
    if (entry) rows.push(`${name} → ${JSON.stringify(entry)}`);
  }

  const sihua = Object.entries(SIHUA_IN_FUQI_GU)
    .map(([k, v]) => `${k}入夫妻宫：${v}`)
    .join('\n');

  return [
    rows.length ? `【两盘夫妻宫出现的主星断语】\n${rows.join('\n')}` : '',
    `【四化入夫妻宫】\n${sihua}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function scoreReference(): string {
  return Object.entries(HEMING_SCORE_CRITERIA)
    .map(([k, v]) => `${k}：${v}`)
    .join('\n');
}

// ────────────────── 简单版（通俗转述）system prompt ──────────────────

const SIMPLE_HEMING_SYSTEM = [
  '你是「倪海厦《天纪》紫微斗数」的通俗转述者。用户会给你一段已经写好的合盘分析，请把它改写成「简单版」。',
  '',
  '改写要求：',
  '1. 读者完全不懂紫微斗数，用日常口语讲，像朋友聊天。',
  '2. 保留原文的 **【小节标题】** 与顺序，标题一字不改、单独成行（前端靠它渲染金色小标题）。',
  '3. 每节先用一句大白话说结论，再用两三句解释「为什么」，可以打比方、举生活场景。',
  '4. 专业术语第一次出现时用括号解释，例如：夫妻宫（代表你对婚姻的态度）。',
  '5. 不得改变原意，不得新增或删除判断，不得编造星曜、宫位、四化。',
  '6. 每段不超过三行，不用表格、不用代码块、不用罗列符号。',
  '7. 全文控制在 700 字以内。',
].join('\n');

function buildSystemPrompt(chartA: ZiweiChart, chartB: ZiweiChart, question?: string): string {
  const methodology = HEMING_METHODOLOGY.slice(0, 4500);

  return [
    '你是「倪海厦《天纪》紫微斗数」体系的合盘分析师，为两个人做双盘比对。',
    '',
    '硬性要求：',
    '1. 严格按下面给定的 **【小节标题】** 结构输出，标题单独成行、原样保留（前端靠它渲染金色小标题）。',
    '2. 只能引用两份命盘中真实存在的星曜、宫位、四化、大限；不要编造。',
    '3. 每个判断尽量落到「宫位＋星曜＋四化」，句末用括号注明依据，例如：（A 夫妻宫太阳，B 命宫太阴）。',
    '4. 用甲乙指代两人即可，不需要知道他们是谁；不要追问姓名、生日等隐私信息。',
    '5. 语气沉稳克制，不做绝对化预言；感情建议具体可执行；健康与财务只谈方向、不做诊断和收益承诺。',
    '6. 简体中文，每段不超过三行，不要表格、不要代码块。',
    '',
    '──── 输出结构（标题必须单独占一行，照抄，不要在同一行接正文）────',
    '**【合盘总览】**',
    '一句话定性这段关系的性质（天作之合 / 互补型 / 磨合成才 / 消耗型 等），并点出关键依据。',
    '',
    '**【匹配度】**',
    '用五星制（★★★☆☆ 这种写法）给出评分，再写一两行理由；标准见下方资料。',
    '',
    '**【双方性格与相处】**',
    '两人命宫与福德宫的互动方式、谁主谁从、日常相处的节奏与雷区。',
    '',
    '**【感情与婚姻】**',
    '双方夫妻宫 + 福德宫联参，说明感情走向与成立的前提条件。',
    '',
    '**【合伙与财运】**',
    '财帛宫、官禄宫的互补或冲突，适不适合共事、钱怎么分。',
    '',
    '**【潜在冲突】**',
    '最容易起摩擦的两三个点，以及各自的心理动因。',
    '',
    '**【相处建议】**',
    '三条具体可执行的建议，具体到"做什么"，不要空话。',
    question
      ? [
          '',
          '**【你问的问题】**',
          `正面回答用户的追问：「${question}」。不要泛泛而谈，要落回盘面依据。`,
        ].join('\n')
      : '',
    '',
    '──── 参考资料：合盘方法论（倪海厦体系）────',
    methodology,
    '',
    '──── 参考资料：匹配度评分标准 ────',
    scoreReference(),
    '',
    spouseReference(chartA, chartB),
    '',
    '──── 甲方（A）命盘 ────',
    buildChartDigest(chartA),
    '',
    '──── 乙方（B）命盘 ────',
    buildChartDigest(chartB),
  ]
    .filter(Boolean)
    .join('\n');
}

export async function POST(req: NextRequest): Promise<Response> {
  // 1. 解析请求
  let chartA: ZiweiChart | null = null;
  let chartB: ZiweiChart | null = null;
  let question = '';
  let isSimple = false;
  let sourceText = '';
  try {
    const body = (await req.json()) as {
      chartA?: ZiweiChart;
      chartB?: ZiweiChart;
      question?: string;
      mode?: string;
      source?: string;
    };
    chartA = body.chartA ?? null;
    chartB = body.chartB ?? null;
    question = typeof body.question === 'string' ? body.question.trim().slice(0, 300) : '';
    isSimple = body.mode === 'simple';
    sourceText = typeof body.source === 'string' ? body.source.trim() : '';
  } catch {
    return failWith('请求体解析失败，请刷新页面重试。');
  }

  const ok = (c: ZiweiChart | null): c is ZiweiChart =>
    !!c && Array.isArray(c.palaces) && c.palaces.length > 0;

  if (!ok(chartA) || !ok(chartB)) {
    return failWith('没有收到两个人的完整命盘，请先把双方出生信息填齐再分析。');
  }

  if (isSimple && !sourceText) {
    return failWith('没有拿到要改写的专业版内容，请等合盘分析出来再切「简单版」。');
  }

  // 2. 访问口令
  if (!accessCodeOk(req)) return accessCodeRejected();

  // 3. 限流（本接口独立计数）
  const limited = hitRate(clientIp(req));
  if (limited) return failWith(limited);

  // 4. 通道配置
  const cfg = resolveConfig();
  if (!cfg.apiKey && cfg.provider !== 'ollama') return missingKeyResponse();

  // 5. 请求上游并转发
  const payload = {
    model: cfg.model,
    stream: true,
    temperature: isSimple ? 0.6 : 0.75,
    max_tokens: isSimple ? 1600 : 2600,
    messages: [
      {
        role: 'system',
        content: isSimple ? SIMPLE_HEMING_SYSTEM : buildSystemPrompt(chartA, chartB, question),
      },
      {
        role: 'user',
        content: isSimple
          ? `请把下面这段合盘分析改写成「简单版」：\n\n${sourceText.slice(0, 6000)}`
          : question
            ? `请按结构输出合盘分析，并在【你问的问题】一节正面回答：${question}`
            : '请按结构输出这份合盘分析。',
      },
    ],
  };

  return proxyChat(cfg, payload, req.signal);
}

/** 便于排查：直接访问该地址能确认路由已生效 */
export async function GET(): Promise<Response> {
  return new Response(JSON.stringify({ ok: true, endpoint: '/api/heming', method: 'POST' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
