import './polyfills';
import { render } from 'preact';
import { App } from './ui/app';
import { loadFonts } from './ui/fonts';
import { LANG } from './core/i18n';
import './ui/styles.css';

document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
document.title = 'Ilimchi';
loadFonts();
render(<App />, document.getElementById('app')!);
