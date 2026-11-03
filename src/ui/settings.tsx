import { getLanguagePreference, setLanguagePreference, tr, type LanguagePreference } from '../core/i18n';
import { useState } from 'preact/hooks';
import type { Session } from '../core/auth';
import { backupFileName, exportBackup, importBackup } from '../core/backup';
import { idb, pdfCache } from '../core/services';
import {
  TARGET_LANGS, clearAiKey, getAiConfig, hasAiKey, isAiRevealed, notifyAiChanged, revealAi, saveAiKey, setAiConfig, type AiKeyMode,
} from '../core/ai';
import { useEffect } from 'preact/hooks';
import { ACCENTS, getPrefs, setPrefs, PAGE_TINTS, SYNC_INTERVALS, type AccentId, type DarkStyle, type SyncInterval, type Theme } from '../core/prefs';
import type { PaperStore } from '../core/store';
import { useStoreRerender, useSyncStatus } from './nav';
import { SyncBadge } from './shared';
import { askConfirm } from './confirm';

const THEMES: { id: Theme; label: string }[] = [
  { id: 'system', label: '自动' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
];

export function Settings({ store, session, onClose, onSignOut }: {
  store: PaperStore;
  session: Session;
  onClose: () => void;
  onSignOut: (clearLocal: boolean) => Promise<void>;
}) {
  useStoreRerender(store);
  const status = useSyncStatus(store);
  const [prefs, setLocal] = useState(getPrefs());
  const [proxy, setProxy] = useState(prefs.proxy);
  const [msg, setMsg] = useState<string | null>(null);
  // AI 区域默认隐藏：点击底部的入口后才展开
  const [aiOpen, setAiOpen] = useState(isAiRevealed());
  const [aiCfg, setAiCfg] = useState(getAiConfig());
  const [aiKey, setAiKey] = useState('');
  const [aiKeyMode, setAiKeyMode] = useState<AiKeyMode>('device');
  const [aiHasKey, setAiHasKey] = useState(false);
  useEffect(() => {
    if (aiOpen) void hasAiKey(idb).then(setAiHasKey);
  }, [aiOpen]);

  const saveAi = async () => {
    const base = aiCfg.baseUrl.trim();
    if (base && !/^https?:\/\//.test(base)) return setMsg(tr('服务地址必须以 http(s):// 开头'));
    try {
      setAiConfig({ baseUrl: base, model: aiCfg.model.trim(), targetLang: aiCfg.targetLang });
      if (aiKey.trim()) {
        await saveAiKey(idb, aiKey, aiKeyMode);
        setAiKey('');
        setAiHasKey(true);
      }
      notifyAiChanged();
      setMsg(tr('已保存'));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const removeAiKey = async () => {
    await clearAiKey(idb);
    setAiHasKey(false);
    notifyAiChanged();
    setMsg(tr('已清除 API Key'));
  };
  const update = (patch: Partial<ReturnType<typeof getPrefs>>) => {
    setPrefs(patch);
    setLocal(getPrefs());
  };

  const saveProxy = () => {
    const v = proxy.trim();
    if (v && !/^https:\/\//.test(v)) return setMsg(tr('代理地址必须以 https:// 开头'));
    if (v && !v.includes('{url}') && !v.endsWith('=')) return setMsg(tr('代理模板应包含 {url}'));
    update({ proxy: v });
    setMsg(tr('已保存'));
  };

  const doExport = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(exportBackup(store), null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = backupFileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div class="sheet-bg" onClick={onClose}>
      <div class="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={tr('设置')}>
        <header class="sheet-head">
          <h2>{tr('设置')}</h2>
          <div class="grow" />
          <button class="ghost small" onClick={onClose}>{tr('完成')}</button>
        </header>

        <section class="group">
          <h3 class="group-title">{tr('语言')}</h3>
          <div class="set">
            <label class="set-label" for="language-select">{tr('界面语言')}</label>
            <div class="set-control">
              <select
                id="language-select"
                class="set-select"
                value={getLanguagePreference()}
                onChange={(e) => setLanguagePreference((e.target as HTMLSelectElement).value as LanguagePreference)}
              >
                <option value="system">{tr('跟随系统')}</option>
                <option value="zh">{tr('简体中文')}</option>
                <option value="en">English</option>
              </select>
            </div>
          </div>
        </section>

        <section class="group">
          <h3 class="group-title">{tr('外观')}</h3>
          <div class="set">
            <span class="set-label">{tr('模式')}</span>
            <div class="set-control">
              <div class="segmented">
                {THEMES.map((t) => (
                  <button class={prefs.theme === t.id ? 'on' : ''} onClick={() => update({ theme: t.id })}>{tr(t.label)}</button>
                ))}
              </div>
            </div>
          </div>
          <div class="set">
            <span class="set-label">{tr('夜间阅读')}</span>
            <div class="set-control">
              <div class="segmented">
                <button class={prefs.darkStyle === 'soft' ? 'on' : ''} onClick={() => update({ darkStyle: 'soft' as DarkStyle })}>{tr('柔和')}</button>
                <button class={prefs.darkStyle === 'invert' ? 'on' : ''} onClick={() => update({ darkStyle: 'invert' as DarkStyle })}>{tr('反色')}</button>
                <button class={prefs.darkStyle === 'ink' ? 'on' : ''} onClick={() => update({ darkStyle: 'ink' as DarkStyle })}>{tr('墨色')}</button>
              </div>
            </div>
          </div>
          <p class="set-hint">{tr('柔和保留图片原色；反色让文字更锐利，但图片会变色；墨色为纯黑底白字，彩色图片保留颜色并压暗。')}</p>
          <div class="set">
            <span class="set-label">{tr('配色')}</span>
            <div class="set-control swatches">
              {ACCENTS.map((a) => (
                <button class={`page-swatch ${prefs.accent === a.id ? 'on' : ''}`} style={{ background: a.light }} title={tr(a.name)} aria-label={tr(a.name)} onClick={() => update({ accent: a.id as AccentId })} />
              ))}
            </div>
          </div>
          <div class="set">
            <span class="set-label">{tr('页面底色')}</span>
            <div class="set-control swatches">
              {PAGE_TINTS.map((t) => (
                <button class={`page-swatch ${prefs.pageTint === t.hex ? 'on' : ''}`} style={{ background: t.hex }} title={tr(t.name)} aria-label={tr(t.name)} onClick={() => update({ pageTint: t.hex })} />
              ))}
            </div>
          </div>
          <p class="set-hint">{tr('页面底色只在浅色模式下生效。')}</p>
        </section>

        <section class="group">
          <h3 class="group-title">{tr('同步')}</h3>
          <div class="set">
            <span class="set-label">{tr('仓库')}</span>
            <div class="set-control">
              <span class="set-value">{session.config.owner}/{session.config.repo}</span>
            </div>
          </div>
          <div class="set">
            <span class="set-label">{tr('状态')}</span>
            <div class="set-control">
              <SyncBadge status={status} onSync={() => void store.sync()} />
            </div>
          </div>
          <div class="set">
            <label class="set-label" for="sync-interval">{tr('提交频率')}</label>
            <div class="set-control">
              <select
                id="sync-interval"
                class="set-select"
                value={prefs.syncInterval}
                onChange={(e) => update({ syncInterval: (e.target as HTMLSelectElement).value as SyncInterval })}
              >
                {SYNC_INTERVALS.map((s) => <option value={s.id}>{tr(s.label)}</option>)}
              </select>
            </div>
          </div>
          <p class="set-hint">{tr('间隔内的多次修改合并为一次提交。切换标签页或关闭页面时会立即保存；“仅手动”模式下，离开页面时仍会保存一次。')}</p>
          {status.error && <p class="set-hint error">{status.error}</p>}
          <a class="set-link" href={`https://github.com/${session.config.owner}/${session.config.repo}/commits`} target="_blank" rel="noreferrer noopener">{tr('查看历史提交')}</a>
        </section>

        <section class="group">
          <h3 class="group-title">{tr('PDF 读取')}</h3>
          <div class="set">
            <label class="set-label" for="proxy-input">{tr('代理模板')}</label>
            <div class="set-control">
              <input id="proxy-input" value={proxy} placeholder="https://your-proxy.example/?url={url}" onInput={(e) => setProxy((e.target as HTMLInputElement).value)} />
            </div>
          </div>
          <div class="set">
            <span class="set-label" />
            <div class="set-control">
              <button class="small" onClick={saveProxy}>{tr('保存')}</button>
              <button class="ghost small" onClick={async () => setMsg(tr('缓存 {size} MB', { size: ((await pdfCache.totalSize()) / 1048576).toFixed(1) }))}>{tr('查看缓存')}</button>
              <button class="ghost small" onClick={async () => { await pdfCache.clear(); setMsg(tr('已清空 PDF 缓存')); }}>{tr('清空缓存')}</button>
            </div>
          </div>
          <p class="set-hint">{tr('默认直接从原站读取。若站点不允许跨域访问，可配置自己的代理。')}</p>
        </section>

        <section class="group">
          <h3 class="group-title">{tr('数据与账户')}</h3>
          <div class="set">
            <span class="set-label">{tr('备份')}</span>
            <div class="set-control">
              <button class="ghost small" onClick={doExport}>{tr('导出')}</button>
              <label class="ghost-link">
                {tr('导入')}
                <input type="file" accept="application/json,.json" hidden onChange={async (e) => {
                  const f = (e.target as HTMLInputElement).files?.[0];
                  if (!f) return;
                  try {
                    const n = await importBackup(store, await f.text());
                    setMsg(tr('已合并 {n} 篇论文', { n }));
                  } catch (err) {
                    setMsg(err instanceof Error ? err.message : String(err));
                  }
                  (e.target as HTMLInputElement).value = '';
                }} />
              </label>
            </div>
          </div>
          <div class="set">
            <span class="set-label">{tr('账户')}</span>
            <div class="set-control">
              <button class="ghost small" onClick={() => onSignOut(false)}>{tr('退出登录')}</button>
              <button class="ghost small danger" onClick={async () => (await askConfirm({ title: tr('清除本机数据？'), message: tr('会删除本机的缓存、令牌和 PDF 缓存。远端仓库中的笔记不会被删除。'), confirmLabel: tr('清除'), danger: true })) && (await onSignOut(true))}>{tr('清除本机数据')}</button>
            </div>
          </div>
        </section>

        {!aiOpen ? (
          <div class="set-reveal">
            <button class="ghost small" onClick={() => { revealAi(); setAiOpen(true); }}>{tr('高级')}</button>
          </div>
        ) : (
          <section class="group">
            <h3 class="group-title">{tr('AI 翻译')}</h3>
            <div class="set">
              <label class="set-label" for="ai-base">{tr('服务地址')}</label>
              <div class="set-control">
                <input id="ai-base" value={aiCfg.baseUrl} placeholder="https://api.openai.com/v1" autoComplete="off" spellcheck={false} onInput={(e) => setAiCfg({ ...aiCfg, baseUrl: (e.target as HTMLInputElement).value })} />
              </div>
            </div>
            <div class="set">
              <label class="set-label" for="ai-model">{tr('模型')}</label>
              <div class="set-control">
                <input id="ai-model" value={aiCfg.model} placeholder="gpt-4o-mini" autoComplete="off" spellcheck={false} onInput={(e) => setAiCfg({ ...aiCfg, model: (e.target as HTMLInputElement).value })} />
              </div>
            </div>
            <div class="set">
              <label class="set-label" for="ai-lang">{tr('目标语言')}</label>
              <div class="set-control">
                <select id="ai-lang" class="set-select" value={aiCfg.targetLang} onChange={(e) => setAiCfg({ ...aiCfg, targetLang: (e.target as HTMLSelectElement).value })}>
                  <option value="auto">{tr('跟随界面语言')}</option>
                  {TARGET_LANGS.map((l) => <option value={l.id}>{l.name}</option>)}
                </select>
              </div>
            </div>
            <div class="set">
              <label class="set-label" for="ai-key">API Key</label>
              <div class="set-control">
                <input id="ai-key" type="password" value={aiKey} autoComplete="new-password" spellcheck={false} placeholder={aiHasKey ? tr('已保存，输入新值可替换') : 'sk-…'} onInput={(e) => setAiKey((e.target as HTMLInputElement).value)} />
              </div>
            </div>
            <div class="set">
              <span class="set-label">{tr('保存方式')}</span>
              <div class="set-control">
                <label class="radio"><input type="radio" name="ai-mode" checked={aiKeyMode === 'device'} onChange={() => setAiKeyMode('device')} />{tr('记住在本设备（加密）')}</label>
                <label class="radio"><input type="radio" name="ai-mode" checked={aiKeyMode === 'session'} onChange={() => setAiKeyMode('session')} />{tr('仅本次会话')}</label>
              </div>
            </div>
            <div class="set">
              <span class="set-label" />
              <div class="set-control">
                <button class="small" onClick={saveAi}>{tr('保存')}</button>
                {aiHasKey && <button class="ghost small danger" onClick={removeAiKey}>{tr('清除 API Key')}</button>}
              </div>
            </div>
            <p class="set-hint">{tr('配置好后，阅读页面会出现“翻译”按钮。论文文本会发送到你配置的服务；API Key 只保存在本设备，不会写入 GitHub 仓库。')}</p>
          </section>
        )}

        {msg && <p class="set-hint set-msg">{msg}</p>}
      </div>
    </div>
  );
}
