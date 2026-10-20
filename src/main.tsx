import './polyfills';
import { render } from 'preact';
import { App } from './ui/app';
import { loadFonts } from './ui/fonts';
import './ui/styles.css';

loadFonts();
render(<App />, document.getElementById('app')!);
