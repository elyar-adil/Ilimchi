// 单元测试默认以中文系统语言运行（界面语言跟随系统）。
// 英文相关用例见 i18n.test.ts，会自行切换。
Object.defineProperty(globalThis.navigator, 'languages', { value: ['zh-CN', 'zh'], configurable: true });
Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true });
