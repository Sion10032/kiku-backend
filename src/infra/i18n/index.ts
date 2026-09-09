import { createInstance } from 'i18next';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';
import { FALLBACK_LOCALE, type Locale } from './negotiate.js';

export {
  FALLBACK_LOCALE,
  type Locale,
  negotiate,
  SUPPORTED_LOCALES,
} from './negotiate.js';

export type TranslateParams = Record<string, string | number>;

/** 独立实例（不动全局单例）；扁平 dotted key 关闭路径拆分；插值/复数与前端同规则。 */
const i18n = createInstance();
await i18n.init({
  resources: {
    'zh-CN': { translation: zhCN },
    en: { translation: en },
  },
  lng: FALLBACK_LOCALE,
  fallbackLng: FALLBACK_LOCALE,
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
});

/** 取翻译；缺失回退 zh-CN、再回显 key。插值 {{name}}；params 含 count 时触发复数后缀。 */
export function translate(
  locale: Locale,
  key: string,
  params?: TranslateParams,
): string {
  return i18n.t(key, { lng: locale, ...params });
}
