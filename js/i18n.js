// Interface text. Override or add languages with "strings" in config.json:
//   "strings": { "en": { "scanning": "Find the frame by the window" } }

export const STRINGS = {
  en: {
    dir: 'ltr',
    languageName: 'English',
    intro: 'Point your phone at the empty frame and the artworks will appear inside it.',
    start: 'Start AR',
    preview: 'Preview without camera',
    loading: 'Loading…',
    scanning: 'Point your camera at the frame',
    cameraError: 'The camera could not be started. Please allow camera access for this page and try again.',
    httpsError: 'The camera only works on a secure (https://) address. Please open the https:// link.',
    loadError: 'The exhibition could not be loaded.',
    retry: 'Try again',
    previous: 'Previous',
    next: 'Next',
    pause: 'Pause',
    play: 'Play',
    effect: 'Transition',
    previewBadge: 'Preview — no camera',
  },
  fa: {
    dir: 'rtl',
    languageName: 'فارسی',
    intro: 'گوشی خود را به سمت قاب خالی بگیرید تا آثار هنری درون آن ظاهر شوند.',
    start: 'شروع',
    preview: 'پیش‌نمایش بدون دوربین',
    loading: 'در حال بارگذاری…',
    scanning: 'دوربین را به سمت قاب بگیرید',
    cameraError: 'دوربین روشن نشد. لطفاً اجازهٔ دسترسی به دوربین را برای این صفحه بدهید و دوباره تلاش کنید.',
    httpsError: 'دوربین فقط روی نشانی امن (https://) کار می‌کند. لطفاً پیوند https:// را باز کنید.',
    loadError: 'بارگذاری نمایشگاه ممکن نشد.',
    retry: 'تلاش دوباره',
    previous: 'قبلی',
    next: 'بعدی',
    pause: 'توقف',
    play: 'پخش',
    effect: 'جلوهٔ گذار',
    previewBadge: 'پیش‌نمایش — بدون دوربین',
  },
};

export function getStrings(lang, overrides = {}) {
  // English is the fallback for any missing text in other languages.
  return Object.assign({}, STRINGS.en, overrides.en, STRINGS[lang], overrides[lang]);
}

/** Fill every [data-i18n] element, and set lang/dir on <html>. */
export function applyStrings(strings, lang) {
  document.documentElement.lang = lang;
  document.documentElement.dir = strings.dir || 'ltr';
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = strings[el.dataset.i18n] ?? el.textContent;
  }
  for (const el of document.querySelectorAll('[data-i18n-label]')) {
    const text = strings[el.dataset.i18nLabel];
    if (text) {
      el.setAttribute('aria-label', text);
      el.title = text;
    }
  }
}
