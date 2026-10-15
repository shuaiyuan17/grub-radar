/**
 * The consent page at /authorize ("let Claude Code use your grub radar?")
 * and its error page, server-rendered in the app's hand-drawn style, English
 * or Chinese. Everything that came from the client (name, domain, redirect
 * host) is data an attacker may choose: always escaped, never trusted as
 * markup. One hashed inline <style>, no script; forms post only to us and to
 * the client's own redirect origin (where the answer goes).
 */
import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { PRIVACY_PATH, TERMS_PATH } from '../../src/contracts/legal';
import type { PageLocale } from '../auth/signingInPage';

export type ConsentScope = 'spots:read' | 'spots:write';

const COPY = {
  en: {
    lang: 'en',
    title: (n: string) => `connect ${n}? · grub radar`,
    heading: (n: string) => `let <b>${n}</b> use your grub radar?`,
    publishedBy: (d: string) => `published by <b>${d}</b>`,
    selfNamed: "it named itself: grub can't check that name.",
    sendsTo: (h: string) => `access goes to <b>${h}</b>`,
    loopback: 'that is an app on this computer. allow only if you just started connecting from it.',
    signedInAs: (n: string) => `signed in as ${n}`,
    canLabel: 'it will be able to',
    read: 'see your spots and notes',
    readFixed: 'always',
    write: 'add spots, mark them been and add notes',
    friendsSoon: "see your friends' spots (not available yet)",
    stays: "stay connected until you disconnect it in settings · it can't see where home is",
    allow: 'allow',
    deny: 'not now',
    errorTitle: "that didn't work · grub radar",
    errorHeading: "that didn't work",
    errorBack: 'go back to your agent and connect again.',
    privacy: 'privacy policy',
    terms: 'terms of service',
  },
  'zh-Hans': {
    lang: 'zh-Hans',
    title: (n: string) => `连接 ${n}？· grub radar`,
    heading: (n: string) => `让 <b>${n}</b> 使用你的 grub radar？`,
    publishedBy: (d: string) => `发布者 <b>${d}</b>`,
    selfNamed: '名字是它自己报的，grub 没法核实。',
    sendsTo: (h: string) => `授权会发往 <b>${h}</b>`,
    loopback: '这是你这台电脑上的程序。只有你刚刚从它那里发起连接时才允许。',
    signedInAs: (n: string) => `当前登录：${n}`,
    canLabel: '它将可以',
    read: '查看你的店和笔记',
    readFixed: '必选',
    write: '加店、标记去过、写笔记',
    friendsSoon: '查看好友的店（暂未开放）',
    stays: '保持连接，直到你在设置里断开 · 它看不到家在哪',
    allow: '允许',
    deny: '暂不',
    errorTitle: '没成功 · grub radar',
    errorHeading: '没成功',
    errorBack: '回到你的 agent 重新连接。',
    privacy: '隐私政策',
    terms: '服务条款',
  },
} as const;

/** The only CSS on these pages; its hash goes in the CSP. */
export const CONSENT_STYLE = `
@font-face{font-family:"Shantell Sans";font-weight:400;font-display:swap;src:url(/fonts/shantell-sans-latin-400-normal.woff2) format("woff2")}
@font-face{font-family:"Shantell Sans";font-weight:700;font-display:swap;src:url(/fonts/shantell-sans-latin-700-normal.woff2) format("woff2")}
@font-face{font-family:Caveat;font-weight:700;font-display:swap;src:url(/fonts/caveat-latin-700-normal.woff2) format("woff2")}
:root{color-scheme:light;--paper:#f7f3ea;--card:#fffdf8;--ink:#1e1b18;--pencil:#5a534b;--hl:#ffd84a;--tomato:#e0583a}
html,body{margin:0;min-height:100%;background:var(--paper) radial-gradient(#ddd5c4 1px,transparent 1.2px) 0 0/22px 22px;color:var(--ink)}
body{display:grid;grid-template-rows:1fr auto;place-items:center;min-height:100vh;font:17px/1.4 "Shantell Sans","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Chalkboard SE","Comic Sans MS",cursive}
main{box-sizing:border-box;width:min(30rem,calc(100% - 32px));margin:24px 0;padding:26px 24px 22px;background:var(--card);border:2.4px solid var(--ink);border-radius:22px 28px 20px 26px/26px 20px 28px 22px;box-shadow:4px 5px 0 var(--ink)}
.brand{font:700 26px Caveat,cursive;margin:0 0 4px;transform:rotate(-2deg);display:inline-block}
.brand span{background:linear-gradient(transparent 55%,var(--hl) 55%)}
h1{font-size:23px;line-height:1.25;margin:4px 0 12px;overflow-wrap:anywhere}
p{margin:0 0 8px;color:var(--pencil);overflow-wrap:anywhere}
b{color:var(--ink)}
.warn{color:#a8361c;border-left:3px solid var(--tomato);padding-left:10px}
fieldset{border:0;padding:0;margin:16px 0 8px}
legend{font-weight:700;padding:0;margin-bottom:6px}
label,.row{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;margin:6px 0;border:1.8px dashed #cfc6b3;border-radius:14px 18px 12px 16px/16px 12px 18px 14px}
input[type=checkbox]{width:20px;height:20px;margin:2px 0 0;accent-color:var(--ink);flex:none}
.tick{flex:none;width:20px;text-align:center;font-weight:700}
.off{opacity:.55}
small{display:block;font-size:13px;color:var(--pencil)}
.who{font-size:14px;margin-top:14px}
.buttons{display:flex;gap:12px;flex-wrap:wrap;margin-top:18px}
button{font:inherit;font-weight:700;font-size:18px;cursor:pointer;padding:10px 22px;color:var(--ink);background:var(--card);border:2.4px solid var(--ink);border-radius:14px 18px 12px 20px/18px 12px 20px 14px}
button.go{background:var(--hl);box-shadow:3px 3px 0 var(--ink)}
button:focus-visible,input:focus-visible{outline:3px solid var(--tomato);outline-offset:3px}
footer{font-size:13px;color:var(--pencil);text-align:center;margin:0 0 24px}
footer a{color:var(--pencil);margin:0 6px}
@media (prefers-reduced-motion:no-preference){button{transition:transform .12s}button:active{transform:translate(2px,2px)}}
`;

const sha256B64 = (text: string) =>
  crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(text))
    .then((d) => btoa(String.fromCharCode(...new Uint8Array(d))));

let styleHash: Promise<string> | undefined;

/**
 * CSP for these pages. `formTargets` are the extra origins a form may lead
 * to: the client's redirect origin (Chrome applies form-action to the
 * redirect that follows the POST).
 */
export async function consentCsp(formTargets: readonly string[] = []): Promise<string> {
  styleHash ??= sha256B64(CONSENT_STYLE);
  return [
    "default-src 'none'",
    `style-src 'sha256-${await styleHash}'`,
    "font-src 'self'",
    "img-src 'self'",
    "base-uri 'none'",
    `form-action 'self'${formTargets.map((o) => ` ${o}`).join('')}`,
    "frame-ancestors 'none'",
  ].join('; ');
}

export const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );

function shell(locale: PageLocale, title: string, body: string): string {
  return `<!doctype html>
<html lang="${COPY[locale].lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f7f3ea">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${CONSENT_STYLE}</style>
</head>
<body>
<main>
<p class="brand"><span>grub radar</span></p>
${body}
</main>
<footer><a href="${PRIVACY_PATH}">${COPY[locale].privacy}</a> · <a href="${TERMS_PATH}">${COPY[locale].terms}</a></footer>
</body>
</html>
`;
}

export interface ConsentView {
  details: ConsentDescription;
  handle: string;
  /** "🍜 Tess": who is about to say yes. */
  signedInAs: string;
  /** Scopes the client asked for (everything else in the request is shown, not granted). */
  requested: readonly string[];
}

export function consentPage(locale: PageLocale, v: ConsentView): string {
  const t = COPY[locale];
  const name = esc(v.details.clientName);
  const wantsWrite = v.requested.includes('spots:write');
  const origin = v.details.clientDomain
    ? `<p>${t.publishedBy(esc(v.details.clientDomain))}</p>`
    : `<p>${t.selfNamed}</p>`;
  const loopback = v.details.redirectIsLoopback ? `<p class="warn">${t.loopback}</p>` : '';
  const friends = v.requested.includes('friends:read')
    ? `<div class="row off"><span class="tick" aria-hidden="true">–</span><span>${t.friendsSoon}</span></div>`
    : '';
  return shell(
    locale,
    t.title(v.details.clientName),
    `<h1>${t.heading(name)}</h1>
${origin}
<p>${t.sendsTo(esc(v.details.redirectHost))}</p>
${loopback}
<form method="POST" action="/authorize">
<input type="hidden" name="handle" value="${esc(v.handle)}">
<fieldset>
<legend>${t.canLabel}</legend>
<div class="row"><span class="tick" aria-hidden="true">✓</span><span>${t.read}<small>${t.readFixed}</small></span></div>
<label><input type="checkbox" name="scope" value="spots:write"${wantsWrite ? ' checked' : ''}><span>${t.write}</span></label>
${friends}
</fieldset>
<p><small>${t.stays}</small></p>
<p class="who">${esc(t.signedInAs(v.signedInAs))}</p>
<div class="buttons">
<button class="go" type="submit" name="decision" value="approve">${t.allow}</button>
<button type="submit" name="decision" value="deny">${t.deny}</button>
</div>
</form>`,
  );
}

/** For anything that went wrong before we could safely send the person back to the client. */
export function consentErrorPage(locale: PageLocale, message: string): string {
  const t = COPY[locale];
  return shell(
    locale,
    t.errorTitle,
    `<h1>${t.errorHeading}</h1>
<p>${esc(message)}</p>
<p>${t.errorBack}</p>`,
  );
}
