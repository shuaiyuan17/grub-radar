/**
 * The "signing you in…" page POST /auth/callback answers with. Static markup
 * plus one inline <style> and one one-line inline <script>, both allowed by
 * hash (nothing else may run). The script submits a same-origin POST form to
 * /auth/finish carrying the hand-off value `t` in its body, so `t` never
 * appears in a URL (history, devtools, request logs). Without JavaScript, the
 * form's "continue" button does the same.
 */
export type PageLocale = 'en' | 'zh-Hans';

/** First language we support in Accept-Language wins (same rule as the SPA). */
export function localeFromAcceptLanguage(header: string | undefined): PageLocale {
  for (const part of (header ?? '').split(',')) {
    const lang = part.split(';')[0]?.trim().toLowerCase() ?? '';
    if (lang === 'zh' || lang.startsWith('zh-')) return 'zh-Hans';
    if (lang === 'en' || lang.startsWith('en-')) return 'en';
  }
  return 'en';
}

const COPY = {
  en: {
    title: 'signing you in… · grub radar',
    heading: 'signing you in…',
    sub: 'checking with Apple, one sec.',
    stuck: 'nothing happening? continue',
  },
  'zh-Hans': {
    title: '正在登录… · grub radar',
    heading: '正在登录…',
    sub: '正在和 Apple 确认，稍等一下。',
    stuck: '没反应？继续',
  },
} as const;

/**
 * The only CSS on the page; its hash goes in the CSP. The fallback link shows
 * only after 6 s: tapping it while the scripted submit is already on its way
 * would spend Apple's one-time code twice and lose the first answer. (A
 * browser without JavaScript waits those 6 s; there's no CSS-only way to
 * show it sooner just for them without a second hashed style.)
 */
export const SIGNING_IN_STYLE = `
:root{color-scheme:light}
html,body{margin:0;height:100%;background:#f7f3ea;color:#2b2622}
body{display:grid;place-items:center;font-family:"Shantell Sans","Chalkboard SE","Comic Sans MS","Bradley Hand",cursive,system-ui}
main{text-align:center;padding:24px;max-width:22rem}
svg{width:132px;height:132px;display:block;margin:0 auto 18px;overflow:visible}
.ink{fill:none;stroke:#2b2622;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}
.faint{stroke-opacity:.35;stroke-dasharray:3 7}
.sweep{transform-origin:66px 66px;animation:sweep 1.6s linear infinite}
.blip{fill:#e4572e;animation:blip 1.6s ease-in-out infinite}
h1{font-size:30px;font-weight:700;margin:0 0 6px;letter-spacing:.2px}
p{font-size:18px;margin:0 0 22px;opacity:.75}
button{font:inherit;font-size:15px;color:inherit;background:none;border:0;padding:4px;cursor:pointer;text-decoration:underline wavy;text-underline-offset:4px;opacity:.6;visibility:hidden;animation:late 0s 6s forwards}
form{margin:0}
@keyframes sweep{to{transform:rotate(360deg)}}
@keyframes late{to{visibility:visible}}
@keyframes blip{0%,100%{opacity:.2}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.sweep,.blip{animation:none}}
`;

/** The only script on the page: submit the hand-off form. Its hash goes in the CSP. */
export const SIGNING_IN_SCRIPT = "document.getElementById('go').submit();";

const sha256B64 = (text: string) =>
  crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(text))
    .then((d) => btoa(String.fromCharCode(...new Uint8Array(d))));

let csp: Promise<string> | undefined;
/** CSP for this page: its own style and script by hash, forms only to us. */
export function signingInCsp(): Promise<string> {
  csp ??= Promise.all([sha256B64(SIGNING_IN_STYLE), sha256B64(SIGNING_IN_SCRIPT)]).then(
    ([style, script]) =>
      [
        "default-src 'none'",
        `style-src 'sha256-${style}'`,
        `script-src 'sha256-${script}'`,
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
  );
  return csp;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );

/** `finish` is the hand-off value (random base64url; escaped anyway). */
export function signingInPage(locale: PageLocale, finish: string): string {
  const t = COPY[locale];
  // a wobbly hand-drawn radar: three uneven rings, a sweeping arm, one blip
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f7f3ea">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${esc(t.title)}</title>
<style>${SIGNING_IN_STYLE}</style>
</head>
<body>
<main aria-busy="true">
<svg viewBox="0 0 132 132" aria-hidden="true">
<path class="ink" d="M66 7c33 1 59 26 58 59-1 32-27 58-59 58C33 123 8 98 8 65 9 34 35 8 68 8"/>
<path class="ink faint" d="M66 28c21 0 38 17 38 38s-17 38-39 38c-20-1-37-18-37-39 1-21 18-37 39-37"/>
<path class="ink faint" d="M66 47c11 0 19 8 19 19 0 10-9 19-19 19-11 0-19-9-19-20 1-10 9-18 20-18"/>
<g class="sweep"><path class="ink" d="M66 66 L108 30"/></g>
<circle class="blip" cx="88" cy="84" r="5"/>
</svg>
<h1>${esc(t.heading)}</h1>
<p>${esc(t.sub)}</p>
<form id="go" method="POST" action="/auth/finish">
<input type="hidden" name="t" value="${esc(finish)}">
<button type="submit">${esc(t.stuck)}</button>
</form>
</main>
<script>${SIGNING_IN_SCRIPT}</script>
</body>
</html>
`;
}
