import './polyfills';
import { render } from 'preact';
import { App } from './ui/app';
import { loadFonts } from './ui/fonts';
import { LANG, tr } from './core/i18n';
import './ui/styles.css';

document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
document.title = tr('页边');
loadFonts();
render(<App />, document.getElementById('app')!);
