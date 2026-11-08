'use client';
import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { ZiweiChart, Palace } from '@/lib/ziwei/types';
import type { TimeView } from './TimeNav';

type Version = 'pro' | 'simple';

interface Message {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  hidden?: boolean;   // don't show user bubble for auto/topic messages
  simple?: string;    // 通俗版正文（点「简单版」后按需生成，成功后缓存在这里）
  simpleError?: string;
}

interface SelectedSiHua {
  starName: string;
  siHua: string;
  view: TimeView;
}

interface InsightPanelProps {
  chart: ZiweiChart;
  selectedPalace?: Palace | null;
  selectedSiHua?: SelectedSiHua | null;
}

const TOPICS = [
  { key: 'overview',     label: '命格' },
  { key: 'love',        label: '感情' },
  { key: 'career',      label: '事业' },
  { key: 'wealth',      label: '财运' },
  { key: 'health',      label: '健康' },
  { key: 'personality', label: '性格' },
] as const;

const TOPIC_PROMPTS: Record<string, string> = {
  overview: `请生成命格总览，按以下结构输出：

**【命格定性】**
用一句话概括这个命盘的核心格局与命主气质。

**【主星解读】**
命宫主星的核心特质，引用倪海厦原话或观点。

**【三方四正】**
财、官、迁三宫的联动分析及整体格局。

**【当前大限】**
当下大限运势方向与最值得关注的事项。

**【优势与注意】**
命盘天赋优势，以及需要注意的风险或功课。`,

  love: `请深度分析感情婚姻运，按以下结构输出：

**【感情格局】**
一句话定性感情命格。

**【夫妻宫分析】**
夫妻宫主星、四化，以及倪海厦体系的具体解读。

**【三方联动】**
相关宫位对感情的影响。

**【当前大限感情运】**
当下10年感情走向与关键节点。

**【实际建议】**
具体可行的感情建议。`,

  career: `请深度分析事业运，按以下结构输出：

**【事业格局】**
一句话定性事业命格，宜任职或宜创业。

**【官禄宫分析】**
官禄宫主星、四化，以及倪师对这种配置的判断。

**【财帛宫联动】**
财运与事业的关系，财路来源分析。

**【当前大限事业运】**
当下10年事业走向。

**【实际建议】**
适合的方向、行业与策略。`,

  wealth: `请深度分析财运，按以下结构输出：

**【财运格局】**
一句话定性财运模式，是主动财还是被动财。

**【财帛宫分析】**
财帛宫主星、四化，财富来源与流动模式。

**【田宅宫（财库）】**
积蓄能力与不动产运势分析。

**【当前大限财运】**
当下财运走向与注意事项。

**【理财建议】**
具体的财务建议。`,

  health: `请分析健康运势，按以下结构输出：

**【疾厄宫主星】**
疾厄宫星曜与健康含义。

**【主要风险】**
结合倪海厦子午流注理论，分析主要健康隐患与需关注的部位。

**【大限健康走势】**
当下健康趋势与关键时间段。

**【预防建议】**
具体注意事项与养生方向。`,

  personality: `请深度解析性格特质，按以下结构输出：

**【命宫主星性格】**
命宫主星的核心性格特质，引用倪师原话。

**【三方性格综合】**
财、官、迁三宫对性格的影响，全貌描绘。

**【人际关系模式】**
与他人互动方式、待人处世风格。

**【优势与人生课题】**
天赋优势，以及需要面对的人生功课。`,
};

const PALACE_ROLES: Record<string, string> = {
  '命宫':   '自我、性格、先天格局',
  '兄弟宫': '兄弟关系、合伙人',
  '夫妻宫': '感情关系、婚姻状态',
  '子女宫': '子女缘分、下属关系',
  '财帛宫': '财运来源、收入方式',
  '疾厄宫': '身体健康、意外',
  '迁移宫': '外出机遇、人际格局',
  '交友宫': '朋友圈、贵人、小人',
  '官禄宫': '事业成就、社会地位',
  '田宅宫': '不动产、家庭环境',
  '福德宫': '精神享受、内心福分',
  '父母宫': '父母关系、文书契约',
};

type FontSize = 'sm' | 'md' | 'lg';

/** 正文字号（px）：小 / 常规 / 大 */
const FONT_PX: Record<FontSize, number> = { sm: 11, md: 13, lg: 15.5 };

/** Render AI markdown: **【Title】** → gold header, **bold** → strong */
function AiContent({ text, streaming, size }: { text: string; streaming?: boolean; size: number }) {
  const lines = text.split('\n');
  return (
    <div className="space-y-0.5">
      {lines.map((line, i) => {
        const sectionMatch = line.match(/^\*\*【(.+?)】\*\*$/);
        if (sectionMatch) {
          return (
            <div key={i} className="pt-3 pb-0.5 first:pt-0">
              <span
                className="font-semibold tracking-wide"
                style={{ color: 'var(--t-gold)', fontSize: size }}
              >
                【{sectionMatch[1]}】
              </span>
            </div>
          );
        }
        if (line.trim() === '') return <div key={i} className="h-1" />;
        const parts = line.split(/\*\*(.+?)\*\*/);
        return (
          <div key={i} className="leading-relaxed" style={{ color: 'var(--t-text2)', fontSize: size }}>
            {parts.map((part, j) =>
              j % 2 === 0
                ? part
                : <strong key={j} className="font-medium" style={{ color: 'var(--t-text)' }}>{part}</strong>
            )}
          </div>
        );
      })}
      {streaming && (
        <span
          className="inline-block w-1.5 h-3 ml-0.5 animate-pulse rounded-sm align-middle"
          style={{ background: 'var(--t-gold)', opacity: 0.6 }}
        />
      )}
    </div>
  );
}

function VersionPill({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="py-1 text-[10px] font-medium rounded-lg transition-all duration-150 disabled:opacity-40"
      style={{
        background: active ? 'rgba(212,168,67,0.16)' : 'transparent',
        border: `1px solid ${active ? 'rgba(212,168,67,0.35)' : 'var(--t-border)'}`,
        color: active ? 'var(--t-gold)' : 'var(--t-faint)',
      }}
    >
      {label}
    </button>
  );
}

function FontPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-7 py-1 text-[10px] font-medium rounded-md transition-all duration-150"
      style={{
        background: active ? 'rgba(212,168,67,0.16)' : 'transparent',
        border: `1px solid ${active ? 'rgba(212,168,67,0.35)' : 'var(--t-border)'}`,
        color: active ? 'var(--t-gold)' : 'var(--t-faint)',
      }}
    >
      {label}
    </button>
  );
}

type StreamTarget = { kind: 'new'; id: number } | { kind: 'simple'; id: number };

export default function InsightPanel({ chart, selectedPalace, selectedSiHua }: InsightPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [activeTopic, setActiveTopic] = useState<string>('overview');
  // 专业版为默认；简单版按需生成并缓存在每条消息上
  const [version, setVersion] = useState<Version>('pro');
  const [simpleBusy, setSimpleBusy] = useState(false);
  const [simpleStreamingId, setSimpleStreamingId] = useState<number | null>(null);
  // 正文字号，随时切换、全局生效
  const [fontSize, setFontSize] = useState<FontSize>('sm');
  // 站点配了 ACCESS_CODE 时才用得到
  const [needCode, setNeedCode] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [codeSaved, setCodeSaved] = useState(false);
  const px = FONT_PX[fontSize];

  const messagesRef = useRef<Message[]>([]); // always-current copy for closures
  const loadingRef = useRef(false);
  const versionRef = useRef<Version>('pro');
  const simpleBusyRef = useRef(false);
  const idRef = useRef(0);
  const autoLoaded = useRef(false);
  const lastPalaceBranch = useRef<number | undefined>(undefined);
  const lastSiHuaKey = useRef<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);

  const nextId = () => { idRef.current += 1; return idRef.current; };

  // Keep refs in sync
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { loadingRef.current = loading; }, [loading]);
  useEffect(() => { versionRef.current = version; }, [version]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, version]);

  /** 统一的一次 SSE 请求：kind='new' 追加一条专业版回答；kind='simple' 把通俗版写回指定消息 */
  const runStream = async (
    payload: unknown,
    target: StreamTarget,
  ): Promise<{ ok: boolean; text: string; error?: string }> => {
    const isSimple = target.kind === 'simple';

    // 先把占位消息放进去，流式过程才有落脚点
    if (isSimple) {
      setMessages(prev => prev.map(m => (m.id === target.id ? { ...m, simple: '', simpleError: undefined } : m)));
    } else {
      setMessages(prev => [...prev, { id: target.id, role: 'assistant', content: '' }]);
    }

    try {
      const code =
        typeof window !== 'undefined' ? window.localStorage.getItem('ziwei-access-code') : null;
      const res = await fetch('/api/interpret', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(code ? { 'x-access-code': code } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) {
        setNeedCode(true);
        return { ok: false, text: '', error: 'need-code' };
      }
      if (res.status === 404) throw new Error('api-missing');
      if (!res.ok) throw new Error('http-' + res.status);
      if (!res.body) throw new Error('no-body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = '';
      let buffer = '';
      let finished = false;

      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // 半行留到下一次，避免被切断的 JSON 丢掉

        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          if (data === '[DONE]') { finished = true; break; }

          let delta = '';
          try {
            delta = JSON.parse(data).delta?.text ?? '';
          } catch {
            continue; // 非 JSON 心跳行
          }
          if (!delta) continue;

          acc += delta;
          if (isSimple) {
            setMessages(prev => prev.map(m => (m.id === target.id ? { ...m, simple: acc } : m)));
          } else {
            setMessages(prev => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last && last.role === 'assistant') updated[updated.length - 1] = { ...last, content: acc };
              return updated;
            });
          }
        }
      }

      return { ok: true, text: acc };
    } catch (e) {
      return { ok: false, text: '', error: e instanceof Error ? e.message : 'error' };
    }
  };

  /** 为某条专业版回答生成通俗版 */
  const requestSimple = async (id: number, source: string) => {
    setSimpleStreamingId(id);
    try {
      const res = await runStream(
        { chart, messages: [], mode: 'simple', source },
        { kind: 'simple', id },
      );
      if (!res.ok) {
        if (res.error === 'need-code') return; // 由口令栏统一提示，不在这里留错
        setMessages(prev =>
          prev.map(m =>
            m.id === id ? { ...m, simple: undefined, simpleError: '通俗版生成失败，点「简单版」重试' } : m,
          ),
        );
      }
    } finally {
      setSimpleStreamingId(cur => (cur === id ? null : cur));
    }
  };

  /** 补齐所有还没有通俗版的历史回答 */
  const generateMissingSimple = async (forceRetry = false) => {
    if (simpleBusyRef.current || loadingRef.current) return;
    simpleBusyRef.current = true;
    setSimpleBusy(true);
    try {
      const pending = messagesRef.current.filter(
        m => m.role === 'assistant' && m.content && m.simple === undefined && (forceRetry || !m.simpleError),
      );
      for (const m of pending) {
        const live = messagesRef.current.find(x => x.id === m.id);
        if (!live || live.simple !== undefined) continue;
        await requestSimple(m.id, m.content);
      }
    } finally {
      simpleBusyRef.current = false;
      setSimpleBusy(false);
    }
  };

  const handleVersionChange = (next: Version) => {
    if (next === version) {
      if (next === 'simple') void generateMissingSimple(true); // 二次点击 = 重试失败的
      return;
    }
    setVersion(next);
    if (next === 'simple') void generateMissingSimple(false);
  };

  /** 发一条消息：永远先出专业版；若当前处于「简单版」视图，再自动补一份通俗版 */
  const sendMessage = async (text: string, hidden = false) => {
    if (!text.trim() || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    const userMsg: Message = { id: nextId(), role: 'user', content: text, hidden };
    // Capture current messages synchronously via ref (avoids stale closure)
    const apiMessages = [...messagesRef.current, userMsg].map(m => ({
      role: m.role,
      content: m.content,
    }));

    setMessages(prev => [...prev, userMsg]);
    setInput('');

    const assistantId = nextId();
    const res = await runStream({ chart, messages: apiMessages }, { kind: 'new', id: assistantId });

    if (!res.ok) {
      if (res.error === 'need-code') {
        // 需要口令：撤掉占位气泡，等用户填完再重新提问
        setMessages(prev => prev.filter(m => m.id !== assistantId));
        setLoading(false);
        loadingRef.current = false;
        return;
      }
      const missing = res.error === 'api-missing';
      const text2 = missing
        ? '开源版不含 AI 解读接口（/api/interpret），需要你自己实现后才能用，详见 README「快速开始」。排盘本身不需要任何 API Key。'
        : '解读失败，请稍后重试。';
      setMessages(prev => {
        const exists = prev.some(m => m.id === assistantId);
        if (exists) return prev.map(m => (m.id === assistantId ? { ...m, content: text2 } : m));
        return [...prev, { id: assistantId, role: 'assistant', content: text2 }];
      });
    }

    setLoading(false);
    loadingRef.current = false;

    // 简单版视图下：新回答（以及此前还没生成的）自动补通俗版
    if (versionRef.current === 'simple' && res.ok && res.text) {
      void generateMissingSimple(false);
    }
  };

  // Auto-generate 命格总览 on mount
  useEffect(() => {
    if (autoLoaded.current) return;
    autoLoaded.current = true;
    void sendMessage(TOPIC_PROMPTS.overview, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Inject palace analysis when palace selected
  useEffect(() => {
    if (!selectedPalace || selectedPalace.branch === lastPalaceBranch.current) return;
    lastPalaceBranch.current = selectedPalace.branch;

    const majorStars = selectedPalace.stars.filter(s => s.type === 'major');
    const starDesc = majorStars.length > 0
      ? majorStars.map(s => `${s.name}${s.siHua ? '化' + s.siHua : ''}`).join('、')
      : '空宫（借对宫）';
    const role = PALACE_ROLES[selectedPalace.name] ?? '';

    const prompt = `请重点分析【${selectedPalace.name}】（主管：${role}），该宫主星为${starDesc}，按以下结构输出：

**【宫位定性】**
${selectedPalace.name}在命盘中的意义，以及这种星曜配置的整体判断。

**【主星解读】**
主星在此宫的倪海厦体系解读，引用具体观点。

**【三方四正联动】**
三方四正宫位对此宫的影响。

**【实际建议】**
基于此宫的具体建议。`;

    void sendMessage(prompt, true);
  }, [selectedPalace]); // eslint-disable-line react-hooks/exhaustive-deps

  // 注入四化飞化分析
  useEffect(() => {
    if (!selectedSiHua) return;
    const key = `${selectedSiHua.starName}-${selectedSiHua.siHua}-${selectedSiHua.view}`;
    if (key === lastSiHuaKey.current) return;
    lastSiHuaKey.current = key;

    // 找出该星所在宫位
    const palaceOfStar = chart.palaces.find(p =>
      p.stars.some(s => s.name === selectedSiHua.starName)
    );
    const palaceName = palaceOfStar?.name ?? '未知宫位';
    const viewLabel = selectedSiHua.view === 'daxian' ? '大限' : '流年';

    const prompt = `请分析【${viewLabel}${selectedSiHua.starName}化${selectedSiHua.siHua}】的飞化影响，按以下结构输出：

**【化${selectedSiHua.siHua}基本含义】**
化${selectedSiHua.siHua}在倪海厦体系中的核心含义，以及${selectedSiHua.starName}化${selectedSiHua.siHua}的特殊含义。

**【落宫影响】**
${selectedSiHua.starName}化${selectedSiHua.siHua}落在【${palaceName}】，该宫主管的领域受到何种影响，倪师如何解读。

**【三方四正飞化路径】**
化${selectedSiHua.siHua}入${palaceName}后，对其三方四正（对宫、两个三合宫）的联动影响。

**【当前运势影响】**
在${viewLabel}时间维度下，此化${selectedSiHua.siHua}对命主近期运势的具体影响。

**【实际建议】**
基于此四化的具体可操作建议。`;

    void sendMessage(prompt, true);
  }, [selectedSiHua]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleTopicClick = (topicKey: string) => {
    if (loadingRef.current) return;
    setActiveTopic(topicKey);
    void sendMessage(TOPIC_PROMPTS[topicKey], true);
  };

  const handleSend = () => {
    void sendMessage(input);
  };

  /** 保存访问口令到 localStorage，后续请求自动带上 */
  const saveCode = () => {
    const v = codeInput.trim();
    if (!v) return;
    try { window.localStorage.setItem('ziwei-access-code', v); } catch { /* 隐私模式下可能失败 */ }
    setCodeInput('');
    setNeedCode(false);
    setCodeSaved(true);
  };

  return (
    <div
      className="flex flex-col rounded-xl overflow-hidden card-glass"
      style={{ height: 'calc(100vh - 190px)', minHeight: 500, maxHeight: 880 }}
    >

      {/* ── Topic buttons ── */}
      <div className="flex-shrink-0 px-2 pt-2.5 pb-2" style={{ borderBottom: '1px solid var(--t-border)' }}>
        <div className="grid grid-cols-6 gap-1">
          {TOPICS.map(t => {
            const isActive = activeTopic === t.key;
            return (
              <button
                key={t.key}
                onClick={() => handleTopicClick(t.key)}
                disabled={loading}
                className="py-1.5 text-[10px] font-medium rounded-lg transition-all duration-150 disabled:opacity-40"
                style={{
                  background: isActive ? 'rgba(212,168,67,0.12)' : 'transparent',
                  border: `1px solid ${isActive ? 'rgba(212,168,67,0.3)' : 'var(--t-border)'}`,
                  color: isActive ? 'var(--t-gold)' : 'var(--t-faint)',
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {/* ── 版本与字号 ── */}
        <div className="mt-2 flex items-center gap-1.5">
          <span className="text-[9px] tracking-widest shrink-0" style={{ color: 'var(--t-faint)' }}>
            版本
          </span>
          <div className="grid grid-cols-2 gap-1 flex-1">
            <VersionPill
              label="专业版"
              active={version === 'pro'}
              onClick={() => handleVersionChange('pro')}
            />
            <VersionPill
              label={simpleBusy ? '简单版 …' : '简单版'}
              active={version === 'simple'}
              disabled={loading}
              onClick={() => handleVersionChange('simple')}
            />
          </div>

          <span className="text-[9px] tracking-widest shrink-0 ml-1" style={{ color: 'var(--t-faint)' }}>
            字号
          </span>
          <div className="flex items-center gap-1 shrink-0">
            <FontPill label="小" active={fontSize === 'sm'} onClick={() => setFontSize('sm')} />
            <FontPill label="中" active={fontSize === 'md'} onClick={() => setFontSize('md')} />
            <FontPill label="大" active={fontSize === 'lg'} onClick={() => setFontSize('lg')} />
          </div>
        </div>
      </div>

      {/* ── Messages ── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">

        {codeSaved && messages.length === 0 && (
          <div className="text-[10px] text-center" style={{ color: 'var(--t-gold)' }}>
            口令已保存，请点上方的主题按钮开始解读。
          </div>
        )}

        {/* Loading state before first message */}
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-4xl mb-3" style={{ color: 'var(--t-gold)', opacity: 0.1 }}>✦</div>
            <p className="text-[10px] animate-pulse" style={{ color: 'var(--t-faint)' }}>命格解读生成中…</p>
          </div>
        )}

        <AnimatePresence initial={false}>
          {messages.map((msg, i) => {
            if (msg.role === 'user' && msg.hidden) return null;

            if (msg.role === 'user') {
              return (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex justify-end"
                >
                  <div
                    className="max-w-[85%] rounded-xl px-3 py-2"
                    style={{
                      background: 'rgba(212,168,67,0.08)',
                      border: '1px solid rgba(212,168,67,0.18)',
                      color: 'var(--t-gold)',
                      fontSize: px,
                    }}
                  >
                    {msg.content}
                  </div>
                </motion.div>
              );
            }

            // Assistant message
            const isLastMsg = i === messages.length - 1;
            const showSimple = version === 'simple';
            const simpleReady = typeof msg.simple === 'string' && msg.simple.length > 0;

            return (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <div
                  className="text-[9px] tracking-widest mb-2 flex items-center justify-between gap-1.5"
                  style={{ color: 'var(--t-faint)' }}
                >
                  <span className="flex items-center gap-1.5">
                    <span style={{ color: 'var(--t-gold)', opacity: 0.4 }}>✦</span>
                    {showSimple ? '通俗解读' : '命理解读'}
                  </span>
                  {showSimple && !simpleReady && !msg.simpleError && (
                    <span className="animate-pulse">通俗版生成中…</span>
                  )}
                </div>

                {showSimple && simpleReady ? (
                  <AiContent text={msg.simple as string} streaming={simpleStreamingId === msg.id} size={px} />
                ) : (
                  <>
                    <AiContent text={msg.content} streaming={loading && isLastMsg} size={px} />
                    {showSimple && msg.simpleError && (
                      <div className="mt-2 text-[9px]" style={{ color: '#f87171' }}>
                        {msg.simpleError}
                      </div>
                    )}
                  </>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {/* ── 访问口令（服务端配了 ACCESS_CODE 时才出现）── */}
      {needCode && (
        <div
          className="flex-shrink-0 px-3 py-2"
          style={{ borderTop: '1px solid var(--t-border)', background: 'rgba(212,168,67,0.06)' }}
        >
          <div className="flex items-center gap-2">
            <span className="text-[10px] shrink-0" style={{ color: 'var(--t-gold)' }}>访问口令</span>
            <input
              type="password"
              value={codeInput}
              onChange={e => { setCodeInput(e.target.value); setCodeSaved(false); }}
              onKeyDown={e => e.key === 'Enter' && saveCode()}
              placeholder="请输入站长给的口令"
              className="flex-1 rounded-lg px-3 py-1.5 text-[11px] focus:outline-none"
              style={{
                background: 'var(--t-card)',
                border: '1px solid var(--t-border)',
                color: 'var(--t-text)',
              }}
            />
            <button
              onClick={saveCode}
              disabled={!codeInput.trim()}
              className="px-3 py-1.5 rounded-lg text-[11px] font-medium disabled:opacity-30"
              style={{
                background: 'rgba(212,168,67,0.15)',
                border: '1px solid rgba(212,168,67,0.25)',
                color: 'var(--t-gold)',
              }}
            >
              确定
            </button>
          </div>
          <div className="mt-1 text-[9px]" style={{ color: 'var(--t-faint)' }}>
            {codeSaved ? '已保存，重新点一次上方主题即可解读。' : '本站需要口令才能调用解读。'}
          </div>
        </div>
      )}

      {/* ── Input ── */}
      <div className="flex-shrink-0 px-3 pb-3 pt-2" style={{ borderTop: '1px solid var(--t-border)' }}>
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
            placeholder="继续追问，如：今年适合换工作吗？"
            disabled={loading}
            className="flex-1 rounded-lg px-3 py-2 text-[11px] focus:outline-none transition-colors"
            style={{
              background: 'var(--t-card)',
              border: '1px solid var(--t-border)',
              color: 'var(--t-text)',
            }}
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="px-3 py-2 rounded-lg text-[11px] font-medium transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            style={{
              background: 'rgba(212,168,67,0.15)',
              border: '1px solid rgba(212,168,67,0.25)',
              color: 'var(--t-gold)',
            }}
          >
            {loading ? '…' : '追问'}
          </button>
        </div>
        <div className="mt-1.5 text-[9px] text-center" style={{ color: 'var(--t-faint)' }}>
          命盘仅用于本次生成，服务器不保存；解读由 AI 生成，仅供参考。
        </div>
      </div>

    </div>
  );
}
