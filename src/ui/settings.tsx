import { tr } from '../core/i18n';
import { useEffect, useState } from 'preact/hooks';
import type { Session } from '../core/auth';
import { backupFileName, exportBackup, importBackup } from '../core/backup';
import { pdfCache } from '../core/services';
import { ACCENTS, getPrefs, setPrefs, PAGE_TINTS, SYNC_INTERVALS, type AccentId, type DarkStyle, type SyncInterval, type Theme } from '../core/prefs';
import type { PaperStore } from '../core/store';
import { useStoreRerender, useSyncStatus } from './nav';
import { SyncBadge } from './shared';
import { askConfirm } from './confirm';
import { clearAiConfig, getAiOptions, hasAiKey, requestAi, saveAiConfig } from '../core/ai';

const THEMES: { id: Theme; label: string }[] = [
  { id: 'system', label: tr('自动') },
  { id: 'light', label: tr('浅色') },
  { id: 'dark', label: tr('深色') },
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
  const [aiOptions, setAiOptions] = useState(getAiOptions());
  const [aiKey, setAiKey] = useState('');
  const [aiConfigured, setAiConfigured] = useState(false);
  useEffect(() => {
    let alive = true;
    void hasAiKey().then((value) => { if (alive) setAiConfigured(value); }).catch(() => { if (alive) setAiConfigured(false); });
    return () => { alive = false; };
  }, []);
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

  const saveAi = async () => {
    try {
      await saveAiConfig({ baseUrl: aiOptions.baseUrl, model: aiOptions.model }, aiKey);
      const enabled = await hasAiKey();
      setAiConfigured(enabled);
      setAiOptions(getAiOptions());
      setAiKey('');
      setMsg(enabled ? tr('AI 设置已保存，阅读器中的 AI 功能已启用') : tr('设置已保存；填写 API Key 后才会启用 AI 功能'));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const testAi = async () => {
    setMsg(tr('正在测试 AI 连接…'));
    try {
      const response = await requestAi(
        'You are testing an API connection. Reply with exactly OK.',
        'Reply with exactly OK.',
        { baseUrl: aiOptions.baseUrl, model: aiOptions.model },
        aiKey.trim() || undefined,
      );
      setMsg(tr('AI 连接成功：{response}', { response: response.slice(0, 80) }));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const removeAi = async () => {
    try {
      await clearAiConfig();
      setAiOptions(getAiOptions());
      setAiKey('');
      setAiConfigured(false);
      setMsg(tr('AI Key 已清除，阅读器已恢复普通模式'));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
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
          <h3 class="group-title">{tr('外观')}</h3>
          <div class="set">
            <span class="set-label">{tr('模式')}</span>
            <div class="set-control">
              <div class="segmented">
                {THEMES.map((t) => (
                  <button class={prefs.theme === t.id ? 'on' : ''} onClick={() => update({ theme: t.id })}>{t.label}</button>
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
                <button class={`page-swatch ${prefs.accent === a.id ? 'on' : ''}`} style={{ background: a.light }} title={a.name} aria-label={a.name} onClick={() => update({ accent: a.id as AccentId })} />
              ))}
            </div>
          </div>
          <div class="set">
            <span class="set-label">{tr('页面底色')}</span>
            <div class="set-control swatches">
              {PAGE_TINTS.map((t) => (
                <button class={`page-swatch ${prefs.pageTint === t.hex ? 'on' : ''}`} style={{ background: t.hex }} title={t.name} aria-label={t.name} onClick={() => update({ pageTint: t.hex })} />
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
                {SYNC_INTERVALS.map((s) => <option value={s.id}>{s.label}</option>)}
              </select>
            </div>
          </div>
          <p class="set-hint">{tr('间隔内的多次修改合并为一次提交。切换标签页或关闭页面时会立即保存；“仅手动”模式下，离开页面时仍会保存一次。')}</p>
          {status.error && <p class="set-hint error">{status.error}</p>}
          <a class="set-link" href={`https://github.com/${session.config.owner}/${session.config.repo}/commits`} target="_blank" rel="noreferrer noopener">{tr('查看历史提交')}</a>
        </section>

        <section class="group">
          <h3 class="group-title">{tr('AI 阅读助手')}</h3>
          <div class="set">
            <label class="set-label" for="ai-api-url">{tr('API 地址')}</label>
            <div class="set-control">
              <input id="ai-api-url" value={aiOptions.baseUrl} placeholder="https://api.openai.com/v1" onInput={(e) => setAiOptions((v) => ({ ...v, baseUrl: (e.target as HTMLInputElement).value }))} />
            </div>
          </div>
          <div class="set">
            <label class="set-label" for="ai-model">{tr('模型名称')}</label>
            <div class="set-control">
              <input id="ai-model" value={aiOptions.model} placeholder="gpt-4o-mini" onInput={(e) => setAiOptions((v) => ({ ...v, model: (e.target as HTMLInputElement).value }))} />
            </div>
          </div>
          <div class="set">
            <label class="set-label" for="ai-api-key">{tr('API Key')}</label>
            <div class="set-control">
              <input id="ai-api-key" type="password" autocomplete="new-password" value={aiKey} placeholder={aiConfigured ? tr('已配置；留空表示不更改') : tr('粘贴你的 API Key')} onInput={(e) => setAiKey((e.target as HTMLInputElement).value)} />
            </div>
          </div>
          <div class="set">
            <span class="set-label" />
            <div class="set-control">
              <button class="small" onClick={() => void saveAi()}>{tr('保存')}</button>
              <button class="ghost small" onClick={() => void testAi()}>{tr('测试连接')}</button>
              {aiConfigured && <button class="ghost small danger" onClick={() => void removeAi()}>{tr('清除 Key')}</button>}
            </div>
          </div>
          <p class="set-hint">{aiConfigured ? tr('AI 已启用。') : tr('未配置 Key 时，Ilimchi 保持普通 PDF 阅读器模式。')}</p>
          <p class="set-hint">{tr('Key 只加密保存在本机，不会同步到 GitHub。使用 AI 时，选中的文字或论文文本会发送给你配置的服务商。支持 OpenAI 兼容的 Chat Completions 接口。')}</p>
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
              <button class="ghost small danger" onClick={async () => (await askConfirm({ title: tr('清除本机数据？'), message: tr('会删除本机的缓存、令牌、AI Key 和 PDF 缓存。远端仓库中的笔记不会被删除。'), confirmLabel: tr('清除'), danger: true })) && (await onSignOut(true))}>{tr('清除本机数据')}</button>
            </div>
          </div>
        </section>

        {msg && <p class="set-hint set-msg">{msg}</p>}
      </div>
    </div>
  );
}
