"use client";

import { LANG_LABEL, LANGS, WORDS, type Lang } from "./i18n";

// EN · DE · JA over the report. The language also goes into the address (?lang=), so a shared link opens in it.
// The history entry is replaced with `null` state: Next.js then keeps its own state and tells useSearchParams, so
// the page's header follows the language too. Passing Next's own state object back would bypass that.

export function writeLangToUrl(lang: Lang) {
  const url = new URL(window.location.href);
  if (lang === "en") url.searchParams.delete("lang");
  else url.searchParams.set("lang", lang);
  window.history.replaceState(null, "", url);
}

export function LangSwitch({ lang, onChange }: { lang: Lang; onChange: (lang: Lang) => void }) {
  return (
    <div className="lg-lang" role="group" aria-label={WORDS[lang].language}>
      {LANGS.map((l, i) => (
        <span key={l}>
          {i > 0 && <span aria-hidden="true"> · </span>}
          <button type="button" lang={l} aria-pressed={l === lang} onClick={() => onChange(l)}>
            {LANG_LABEL[l]}
          </button>
        </span>
      ))}
    </div>
  );
}
