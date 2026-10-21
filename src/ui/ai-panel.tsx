import { useEffect, useState } from 'preact/hooks';
import { getAiOptions, requestAi } from '../core/ai';
import { tr } from '../core/i18n';
import { Icon } from './icons';

type Mode = 'explain' | 'translate' | 'background' | 'critique';

interface Seed {
  id: number;
  text: string;
  page: number;
  mode: Mode;
}

interface Props {
  title: string;
  seed: Seed | null;
  getPaperText: () => Promise<string>;
  onJumpToPage: (page: number) => void;
  onClose: () => void;
}

const MODE_LABELS: Record<Mode, string> = {
  explain: '解释',
  translate: '翻译',
  background: '背景知识',
  critique: '分析局限',
};

export function AiPanel(props: Props) {
  const [selectedText, setSelectedText] = useState('');
  const [selectedPage, setSelectedPage] = useState<number | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function runSelection(mode: Mode, quote = selectedText, page = selectedPage) {
    if (!quote.trim()) {
      setError('请先在 PDF 中选中一段文字');
      return;
    }
    setBusy(true);
    setError('');
    setAnswer('');
    const prompts: Record<Mode, string> = {
      explain: 'Explain the selected passage clearly and rigorously. Define technical terms and walk through the reasoning. Keep the original technical meaning.',
      translate: 'Translate the selected passage into natural Chinese. Preserve equations, symbols, citations, and important English technical terms where useful.',
      background: 'Explain the prerequisite concepts and background needed to understand this passage. Separate established background knowledge from claims made by the authors.',
      critique: 'Analyze the passage critically: identify assumptions, missing reasoning, possible limitations, and what evidence would be needed. Do not claim the whole paper is flawed based on this excerpt alone.',
    };
    const system = 'You are a careful academic paper reading assistant. Be precise and useful. Do not invent claims about the paper or fabricate citations. Make clear when a point is general explanation rather than something explicitly stated in the source. Answer in Chinese unless the user explicitly requests another language.';
    const user = 'Paper: ' + props.title + '\nSource page: ' + (page ?? 'unknown') +
      '\nSelected passage:\n' + quote + '\n\nTask: ' + prompts[mode] +
      '\nDo not imply that the selected passage proves anything beyond what it actually says.';
    try {
      setAnswer(await requestAi(system, user));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function askPaper() {
    const q = question.trim();
    if (!q) return;
    setBusy(true);
    setError('');
    setAnswer('');
    try {
      const paperText = await props.getPaperText();
      if (!paperText.trim()) throw new Error('这份 PDF 没有可提取的文字层，可能是扫描版文件');
      const system = 'You are a careful academic research assistant. Answer the question using the supplied paper text as the primary evidence. Cite claims about the paper with the exact page markers provided, formatted as [p. N]. Never invent page numbers or claim the paper says something that is absent from the supplied text. If evidence is insufficient, say so explicitly. Separate the authors’ claims from your own interpretation. Answer in Chinese unless the user requests another language.';
      const user = 'Paper title: ' + props.title + '\nQuestion: ' + q +
        '\n\nPaper text (each section starts with a source page marker):\n' + paperText;
      setAnswer(await requestAi(system, user));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!props.seed) return;
    setSelectedText(props.seed.text);
    setSelectedPage(props.seed.page);
    setQuestion('');
    void runSelection(props.seed.mode, props.seed.text, props.seed.page);
  }, [props.seed?.id]);

  const options = getAiOptions();

  return (
    <aside class="side ai-side" aria-label={tr('AI 阅读助手')}>
      <header class="ai-panel-head">
        <div>
          <strong>{tr('AI 阅读助手')}</strong>
          <p>{options.model}</p>
        </div>
        <button class="icon-btn" onClick={props.onClose} title={tr('关闭 AI 面板')} aria-label={tr('关闭 AI 面板')}>
          <Icon name="close" />
        </button>
      </header>
      <div class="ai-panel-body">
        <p class="set-hint">{tr('仅在你主动提问时发送内容。AI 回答可能有误，请结合原文核对。')}</p>
        {selectedText && (
          <div class="ai-source">
            <div class="ai-source-head">
              <span>{tr('选中的原文')}{selectedPage ? ' · p. ' + selectedPage : ''}</span>
              {selectedPage && <button class="ghost small" onClick={() => props.onJumpToPage(selectedPage)}>{tr('回到原文')}</button>}
            </div>
            <blockquote>{selectedText}</blockquote>
          </div>
        )}
        <div class="ai-modes">
          {(Object.keys(MODE_LABELS) as Mode[]).map((mode) => (
            <button class="ghost small" disabled={busy || !selectedText} onClick={() => void runSelection(mode)}>{tr(MODE_LABELS[mode])}</button>
          ))}
        </div>
        <div class="ai-privacy">{tr('论文问答会把可提取的 PDF 文本发送到你配置的 AI 服务商。')}</div>
        <label class="ai-question-label" for="ai-paper-question">{tr('询问整篇论文')}</label>
        <textarea
          id="ai-paper-question"
          class="ai-question"
          rows={4}
          value={question}
          placeholder={tr('例如：这篇论文的核心创新是什么？')}
          onInput={(e) => setQuestion((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void askPaper();
          }}
        />
        <button class="ai-ask" disabled={busy || !question.trim()} onClick={() => void askPaper()}>
          {busy ? tr('思考中…') : tr('询问论文')}
        </button>
        {busy && <p class="ai-status">{tr('正在请求 AI…')}</p>}
        {error && <p class="ai-error">{error}</p>}
        {answer && (
          <div class="ai-answer" aria-live="polite">
            {answer.split(/(\[p\.\s*\d+\])/gi).map((part, index) => {
              const citation = /^\[p\.\s*(\d+)\]$/i.exec(part);
              return citation
                ? <button key={index} class="ai-citation" onClick={() => props.onJumpToPage(Number(citation[1]))}>{'p. ' + citation[1]}</button>
                : part;
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
