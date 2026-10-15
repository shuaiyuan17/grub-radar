/**
 * The Privacy Policy (/privacy) and Terms of Service (/terms): plain,
 * server-rendered HTML in the app's paper style, readable without a session
 * and without JavaScript (reviewers, crawlers, anyone before they sign in).
 * English only. No script; one hashed inline <style>, as on the consent page.
 *
 * Every claim in the privacy policy is meant to match the code. Change the
 * code and the text together, and bump LEGAL_UPDATED (src/contracts/legal.ts).
 */
import {
  CONTACT_EMAIL,
  LEGAL_UPDATED,
  OPERATOR,
  PRIVACY_PATH,
  TERMS_PATH,
} from '../../src/contracts/legal';
import { INVITE_TTL_DAYS } from '../../src/contracts/friends';
import { PHOTOS_PER_SPOT } from '../../src/contracts/photos';
import {
  ACCESS_TOKEN_TTL_S,
  CLIENT_REGISTRATION_TTL_S,
  REFRESH_TOKEN_TTL_S,
} from '../agents/oauth';
import { SESSION_MAX_AGE_MS, SESSION_TTL_MS } from '../auth/session';
import { DAY, SECOND } from '../lib/time';

/** The only CSS on these pages; its hash goes in the CSP. */
export const LEGAL_STYLE = `
@font-face{font-family:"Shantell Sans";font-weight:400;font-display:swap;src:url(/fonts/shantell-sans-latin-400-normal.woff2) format("woff2")}
@font-face{font-family:"Shantell Sans";font-weight:700;font-display:swap;src:url(/fonts/shantell-sans-latin-700-normal.woff2) format("woff2")}
@font-face{font-family:Caveat;font-weight:700;font-display:swap;src:url(/fonts/caveat-latin-700-normal.woff2) format("woff2")}
:root{color-scheme:light;--paper:#f7f3ea;--card:#fffdf8;--ink:#1e1b18;--pencil:#5a534b;--hl:#ffd84a;--tomato:#e0583a;--rule:#cfc6b3}
html,body{margin:0;background:var(--paper) radial-gradient(#ddd5c4 1px,transparent 1.2px) 0 0/22px 22px;color:var(--ink)}
body{font:16px/1.6 "Shantell Sans",-apple-system,"Helvetica Neue",Arial,sans-serif;-webkit-text-size-adjust:100%}
main{box-sizing:border-box;width:min(44rem,calc(100% - 24px));margin:20px auto 28px;padding:24px 22px 18px;background:var(--card);border:2.4px solid var(--ink);border-radius:22px 28px 20px 26px/26px 20px 28px 22px;box-shadow:4px 5px 0 var(--ink)}
.brand{font:700 28px Caveat,cursive;margin:0;display:inline-block;transform:rotate(-2deg);color:var(--ink);text-decoration:none}
.brand span{background:linear-gradient(transparent 55%,var(--hl) 55%)}
h1{font-size:30px;line-height:1.2;margin:10px 0 2px;letter-spacing:-.01em}
.updated{color:var(--pencil);font-size:14px;margin:0 0 14px}
h2{font-size:20px;line-height:1.3;margin:26px 0 6px;padding-top:14px;border-top:1.8px dashed var(--rule)}
h3{font-size:16px;margin:16px 0 4px}
p,li{color:#2c2824;overflow-wrap:break-word}
p{margin:0 0 10px}
ul{margin:0 0 10px;padding-left:22px}
li{margin:4px 0}
b,strong{color:var(--ink)}
a{color:var(--ink);text-decoration-color:var(--tomato);text-decoration-thickness:2px;text-underline-offset:3px}
a:focus-visible{outline:3px solid var(--tomato);outline-offset:2px}
.lede{font-size:17px}
nav.toc{font-size:14px;margin:12px 0 0;padding:8px 12px;border:1.8px dashed var(--rule);border-radius:14px 18px 12px 16px/16px 12px 18px 14px}
nav.toc ol{margin:4px 0;padding-left:20px}
footer{width:min(44rem,calc(100% - 24px));margin:0 auto 32px;font-size:14px;color:var(--pencil);text-align:center}
footer a{margin:0 6px}
@media (min-width:720px){main{padding:34px 40px 26px}h1{font-size:36px}}
@media print{html,body{background:#fff}main{border:0;box-shadow:none}}
`;

const sha256B64 = (text: string) =>
  crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(text))
    .then((d) => btoa(String.fromCharCode(...new Uint8Array(d))));

let styleHash: Promise<string> | undefined;

/** CSP for these pages: no script at all, no forms, only our fonts and the hashed style. */
export async function legalCsp(): Promise<string> {
  styleHash ??= sha256B64(LEGAL_STYLE);
  return [
    "default-src 'none'",
    `style-src 'sha256-${await styleHash}'`,
    "font-src 'self'",
    "img-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );

const mail = `<a href="mailto:${esc(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a>`;
const days = (ms: number) => String(Math.round(ms / DAY));

interface Section {
  id: string;
  title: string;
  body: string;
}

function page(o: {
  origin: string;
  path: string;
  title: string;
  description: string;
  lede: string;
  sections: Section[];
}): string {
  const toc = o.sections.map((s) => `<li><a href="#${s.id}">${s.title}</a></li>`).join('');
  const body = o.sections
    .map((s) => `<section id="${s.id}">\n<h2>${s.title}</h2>\n${s.body.trim()}\n</section>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f7f3ea">
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${esc(o.origin + o.path)}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>${esc(o.title)} · grub radar</title>
<style>${LEGAL_STYLE}</style>
</head>
<body>
<main>
<a class="brand" href="/"><span>grub radar</span></a>
<h1>${esc(o.title)}</h1>
<p class="updated">Last updated: ${LEGAL_UPDATED}</p>
<p class="lede">${o.lede}</p>
<nav class="toc" aria-label="On this page"><ol>${toc}</ol></nav>
${body}
</main>
<footer>
<a href="/">grub radar</a> · <a href="${PRIVACY_PATH}">Privacy Policy</a> · <a href="${TERMS_PATH}">Terms of Service</a> · ${mail}
</footer>
</body>
</html>
`;
}

export function privacyPage(origin: string): string {
  return page({
    origin,
    path: PRIVACY_PATH,
    title: 'Privacy Policy',
    description: 'What grub radar collects, why, who it is shared with, and how to delete it.',
    lede: `grub radar is a free, independent, personal project, run by ${esc(OPERATOR)} (“we”). It keeps your list of places to eat. This page says what we collect, why, who else handles it, how long we keep it and how to get rid of it. Questions: ${mail}.`,
    sections: [
      {
        id: 'collect',
        title: 'What we collect, and why',
        body: `
<h3>Your Apple sign-in</h3>
<p>You sign in with Apple. We don’t get or store a password. From Apple we receive and store:</p>
<ul>
<li><b>Your Apple user id</b> (Apple’s “sub”): a stable id for this app, used to recognise you when you sign in again.</li>
<li><b>The email address Apple shares</b>, which may be a private relay address (…@privaterelay.appleid.com) if you chose “Hide My Email”. We store it with your Apple identity and use it only to answer your support or account deletion requests. It isn’t your sign-in identifier (that’s the Apple user id), we don’t send you other email, and nobody else sees it.</li>
<li><b>Your name</b>, if Apple shares it on your first sign-in. It becomes your display name; you can change it.</li>
<li><b>A refresh token Apple issues</b> to the app, stored so that we can revoke the app’s access to your Apple ID with Apple when your account is deleted.</li>
</ul>
<h3>Your profile</h3>
<ul>
<li>Your <b>display name</b> and <b>emoji</b>, which you choose and your friends see.</li>
<li>When your account was created and when you last signed in.</li>
</ul>
<h3>Your list</h3>
<ul>
<li><b>Spots</b>: the place (its name, address and location, from Apple Maps or typed by you), and what you add: kind, cuisine, price, opening hours, “been” or “want to try”, your <b>verdict</b> (good / meh / bad), a one-line note, your longer <b>notes</b>, <b>tags</b>, <b>dishes</b> to order, why you saved it, and whether it’s visible to friends or just you.</li>
<li><b>Visits</b>: each time a spot is marked been, the date and the verdict and note you gave.</li>
<li>Which agent added a spot (“found by”), if one did.</li>
</ul>
<h3>Photos</h3>
<p>Up to ${String(PHOTOS_PER_SPOT)} photos per spot, with an optional caption. Before upload, your browser redraws each photo and re-encodes it, which drops camera and location metadata: the GPS position, date and device details. Our server checks every upload again and <b>rejects any file that still carries camera or location metadata</b> (EXIF, including GPS, XMP, IPTC and embedded comments). An embedded colour profile may remain. Photos are stored privately: there is no public link to them.</p>
<h3>Home and location</h3>
<ul>
<li><b>Home</b>: if you set one, its coordinates are stored on your account, apart from your profile. Home is <b>never shown to friends or to agents</b>. For a connected agent, “home” is only ever the centre of the ~1 km grid square your home is in, so it can sort by distance without learning where you live. You can clear home at any time.</li>
<li><b>Where you are now</b>: if you allow location access, your browser uses it on your device to sort spots. When you search Apple Maps near you, the point is rounded to about 1 km before it leaves your device. We don’t store your current location (unless you choose to save it as home).</li>
</ul>
<h3>Friends and invites</h3>
<ul>
<li>Who your friends are, and since when.</li>
<li><b>Invite links</b> you create: we store only a hash of the link’s secret, never the link itself, plus when it was made, when it expires (${String(INVITE_TTL_DAYS)} days), and who accepted it.</li>
</ul>
<h3>Sessions</h3>
<p>When you sign in, your browser gets a session cookie. We store only a hash of it, with when the session started, when it was last used and a coarse device label such as “Safari on iPhone” (not your full browser string). Other cookies we set are short-lived and only used to complete sign-in. We use no advertising or analytics cookies, and the app loads no third-party scripts. The app keeps a few things in your browser’s own storage, such as your language choice.</p>
<h3>Connected agents and personal tokens</h3>
<ul>
<li>When an AI agent registers with grub (OAuth dynamic client registration, which any app can do before anyone approves it), we store the client metadata it sends, including its name, its website and logo URLs, contact addresses if it gives any, the redirect URIs where it receives access, and other technical registration settings. A registration that is never used expires after ${days(CLIENT_REGISTRATION_TTL_S * SECOND)} days (up to 90 days for registrations created on or before 15 October 2026); one that keeps being used is renewed and stays.</li>
<li>When you connect an agent, we store what you allowed it to do and when it last used grub. Its access and refresh tokens reach the agent over HTTPS and are <b>not stored in plain text</b>: the OAuth library we use keeps only hashed or encrypted forms.</li>
<li><b>Personal API tokens</b> you create in settings: we store only a hash of the token, its name, what it may do and when it was last used. The token itself is shown once.</li>
</ul>
<h3>Security and operational logs</h3>
<p>To run and protect the service we keep some records:</p>
<ul>
<li>Our own log lines record, per request to the API and sign-in: the method, the path (without the query string), the response status, timings and database statistics, and short outcome codes for sign-in (for example “cancelled” or “state already used”). Errors are logged by their name and message. <b>Our log lines never contain tokens, cookies, passwords, request bodies, your email or your home.</b></li>
<li>Cloudflare, which runs the service, also records each request it hands to our code: the method and the full URL (which can include a query string, such as a search term or coordinates an agent sent), along with request headers and connection metadata that Cloudflare attaches.</li>
<li>To cap how many new agent apps can register, we count registrations per day, per IP address. Those counters (the IP address, the day and a number) are deleted automatically after a day or two.</li>
<li>Rate limits count requests per account, per credential or per IP address over a short window; those counts are not stored by us.</li>
</ul>`,
      },
      {
        id: 'processors',
        title: 'Who handles your data for us',
        body: `
<ul>
<li><b>Cloudflare</b> hosts grub radar: the app and server run on Cloudflare Workers, your data is in Cloudflare D1 (database), photos are in Cloudflare R2 (storage), agent connections are in Cloudflare Workers KV, and logs are in Cloudflare Workers Logs.</li>
<li><b>Apple</b> provides Sign in with Apple, and Apple Maps for finding places. When you (or an agent acting for you) search for a place, we send Apple’s Maps Server API <b>the search text and an approximate location</b> (rounded to about 1 km), or the Apple place id of a place being looked up. Search results are cached in Cloudflare’s cache for 15 minutes, keyed by the search text, that rounded location and the language. Place details are cached for a day, keyed by the Apple place id and the language. Neither cache records who asked.</li>
</ul>
<p>Each processes data under its own terms and privacy policy. We don’t use any other service providers.</p>`,
      },
      {
        id: 'sharing',
        title: 'Who sees what',
        body: `
<ul>
<li><b>Nothing is public.</b> Without signing in, nobody sees anything of your list.</li>
<li><b>Your friends</b> (only people who accepted your invite link, or whose link you accepted). <b>New spots are visible to your friends by default</b>; you can mark any spot “just me” to keep it to yourself. Friends see your display name and emoji, and your spots that are visible to friends: the place, kind, cuisine, price, been or want to try, your verdict, your one-line note and your photos of it. They <b>never</b> see your home, your private spots, your longer notes, tags, dishes or why you saved it. This is enforced in the database queries themselves. Someone who opens your invite link sees your name and emoji. Either of you can unfriend at any time.</li>
<li><b>Agents you connect</b> see and do only what you authorized, by scope: <i>spots:read</i> (your spots and notes) and, if you ticked it, <i>spots:write</i> (add spots, mark them been, add notes, edit spot details). Agents can’t see your home (only the ~1 km grid point above), your photos, your friends or your account settings, and can’t delete spots.</li>
<li><b>Data accessed through a connected agent</b>, including an agent on a third-party AI platform: we use it only to carry out that agent’s requests. What the agent’s provider does with what it reads is governed by that provider’s own terms and privacy policy.</li>
<li>We <b>don’t sell</b> your data, show <b>no advertising</b>, do <b>no profiling</b>, and <b>don’t use your data to train AI models</b>.</li>
<li><b>We</b>, as operator, can access the database to run and fix the service. The admin page shows only totals and, per account, the display name, emoji, sign-up date, last activity and how many spots and friends it has.</li>
<li>We may disclose data if the law requires it, and we’ll tell you if we’re allowed to.</li>
</ul>`,
      },
      {
        id: 'retention',
        title: 'How long we keep it, and how to delete it',
        body: `
<h3>How long</h3>
<ul>
<li><b>Your account and list</b>: until you delete them, or ask us to.</li>
<li><b>Sessions</b> expire after ${days(SESSION_TTL_MS)} days without use, and after ${days(SESSION_MAX_AGE_MS)} days at most, however active; expired session records are deleted within the hour. Signing out ends the session at once.</li>
<li><b>Agent access</b>: an access token lasts ${String(ACCESS_TOKEN_TTL_S / 3600)} hours; a refresh token expires after ${String(Math.round(REFRESH_TOKEN_TTL_S / 86400))} days unused. Personal tokens last until you revoke them.</li>
<li><b>Photos</b>: when you delete a photo or a spot, its file is queued for deletion and normally removed from storage right away; if storage doesn’t respond, an hourly clean-up retries.</li>
<li><b>Sign-in state</b> (single-use records that protect sign-in) is valid for about 10 minutes and deleted within the hour after.</li>
<li><b>Logs</b> in Cloudflare Workers Logs may include request URLs and headers. We use them only for security and debugging, and they expire after the retention period, at most 7 days.</li>
<li><b>Invite links</b> that were used, revoked or expired are deleted within the hour once they’re more than a day old. <b>Per-day counters</b> (including the per-IP registration counters above) are deleted after a day or two.</li>
<li><b>Agent registrations</b> nobody uses expire after ${days(CLIENT_REGISTRATION_TTL_S * SECOND)} days (up to 90 days for registrations created on or before 15 October 2026).</li>
<li>Places are shared across accounts (a restaurant has one record, whoever saves it), so a place’s name, address and location can remain after you remove it from your list. A place you typed in by hand is deleted with your spot if nobody else has it.</li>
</ul>
<h3>Deleting things yourself</h3>
<ul>
<li>Delete any <b>spot</b> (with its visits and photos) or any single <b>photo</b> in the app.</li>
<li>Clear your <b>home</b>, unfriend people and revoke unused invite links in the app.</li>
<li><b>Disconnect agents</b> and <b>revoke personal tokens</b> in settings. They stop working immediately.</li>
</ul>
<h3>Deleting your account</h3>
<p>The app doesn’t have a delete-account button yet. Email ${mail} (ideally from the email address Apple shared with us, so we can match your account), and we will delete your account and the data associated with it, including photos and agent connections, within 30 days of your request. We’ll also revoke the app’s access to your Apple ID with Apple. Logs, which may include request URLs and headers, and caches expire on their own after the periods described above. You can also stop the app’s access to your Apple ID in your Apple ID settings under “Sign in with Apple”.</p>`,
      },
      {
        id: 'security',
        title: 'Security',
        body: `
<ul>
<li>Session cookies, invite links, personal API tokens and agent tokens are stored only as hashes (or encrypted), so a copy of the database can’t be turned back into working grub credentials. The Apple refresh token is stored as issued, so that we can revoke the app’s access with Apple.</li>
<li>Everything is served over HTTPS (encrypted in transit), with strict security headers.</li>
<li>Who can see what is enforced in the database queries: every read is scoped to your account, and friends’ reads go through the friendship and the friends-visible flag.</li>
<li>Rate limits on sign-in, writes, searches, uploads and agent requests.</li>
</ul>
<p>No system is perfectly secure. If you find a problem, please tell us at ${mail}.</p>`,
      },
      {
        id: 'children',
        title: 'Children',
        body: `<p>grub radar is not directed at children under 13, and we don’t knowingly collect data from them. If you think a child has an account, contact us and we’ll delete it.</p>`,
      },
      {
        id: 'rights',
        title: 'Your choices',
        body: `<p>You can see and edit almost everything we hold about you in the app. To get a copy of your data, correct something you can’t edit, or have it deleted, email ${mail}. We’ll answer within 30 days.</p>`,
      },
      {
        id: 'changes',
        title: 'Changes and contact',
        body: `<p>If we change this policy, we’ll update it here and change the “Last updated” date. Contact: ${mail}.</p>
<p>See also the <a href="${TERMS_PATH}">Terms of Service</a>.</p>`,
      },
    ],
  });
}

export function termsPage(origin: string): string {
  return page({
    origin,
    path: TERMS_PATH,
    title: 'Terms of Service',
    description: 'The short, plain-language terms for using grub radar.',
    lede: `grub radar is a free, independent, personal project, run by ${esc(OPERATOR)} (“we”). These terms are short on purpose. Questions: ${mail}.`,
    sections: [
      {
        id: 'acceptance',
        title: 'Agreeing to these terms',
        body: `<p>By signing in to or using grub radar (the website, its API and its MCP server), you agree to these terms and to our <a href="${PRIVACY_PATH}">Privacy Policy</a>. If you don’t agree, please don’t use it.</p>`,
      },
      {
        id: 'service',
        title: 'The service',
        body: `<p>grub radar is provided free of charge, <b>as is</b> and <b>as available</b>. It’s a personal project: features may change, it may be down sometimes, and it may stop altogether. If we plan to shut it down, we’ll try to give notice so you can save what you want.</p>`,
      },
      {
        id: 'account',
        title: 'Your account',
        body: `<p>You sign in with Apple, and you need an Apple ID to use grub radar. Keep your Apple ID and your devices secure. You’re responsible for activity on your account that you authorize, or that you could reasonably have prevented. One person, one account.</p>`,
      },
      {
        id: 'content',
        title: 'Your content',
        body: `<p>You keep whatever rights you have in your spots, notes, verdicts, photos and everything else you add. You give us a licence only to host that content and display it to you, to your friends (for what you share with them) and to the agents you authorize, as needed to run the service. That licence ends when you delete the content or your account, apart from copies in logs or caches that expire on their own. Place information that comes from Apple Maps remains Apple’s.</p>
<p>Only upload what you have the right to share. Don’t upload other people’s private information or photos of people who haven’t agreed to it.</p>`,
      },
      {
        id: 'use',
        title: 'Acceptable use',
        body: `<p>Don’t:</p>
<ul>
<li>abuse, harass or spam other people;</li>
<li>scrape or bulk-download the service, or use it to collect data about others;</li>
<li>try to break in, get around rate limits or access controls, or attack or overload the service;</li>
<li>upload anything illegal, infringing, or someone else’s private content;</li>
<li>use grub radar for anything unlawful.</li>
</ul>`,
      },
      {
        id: 'agents',
        title: 'Agents and the API',
        body: `<ul>
<li>You can connect AI agents and other software over OAuth or with a personal token. <b>You’re responsible for the agents you connect</b> and for what they do with the access you grant.</li>
<li>We enforce rate limits and may refuse or throttle requests that exceed them.</li>
<li>You can disconnect agents and revoke tokens in settings at any time; we may also revoke them if they’re misused.</li>
</ul>`,
      },
      {
        id: 'third-parties',
        title: 'Third-party services',
        body: `<p>grub radar relies on Apple (Sign in with Apple, Apple Maps) and Cloudflare (hosting). Your use of those is also subject to their terms. Place information comes from Apple Maps or from users, and we can’t promise it’s accurate or current: check opening hours before you go.</p>`,
      },
      {
        id: 'termination',
        title: 'Ending things',
        body: `<p>You can stop using grub radar at any time and ask us to delete your account (see the <a href="${PRIVACY_PATH}#retention">Privacy Policy</a>). We may suspend or close accounts that break these terms or put the service or other people at risk.</p>`,
      },
      {
        id: 'liability',
        title: 'Disclaimers and limitation of liability',
        body: `<p>To the extent the law allows, grub radar is provided without warranties of any kind, express or implied, including fitness for a particular purpose and non-infringement. We aren’t liable for indirect, incidental or consequential damages, or for lost data, and because the service is free, our total liability for any claim relating to it is limited to the amount you paid us, which is zero. Some places don’t allow these limits, so they may not all apply to you.</p>`,
      },
      {
        id: 'law',
        title: 'Governing law',
        body: `<p>These terms are governed by the laws of the State of Washington, USA, without regard to its conflict-of-law rules.</p>`,
      },
      {
        id: 'changes',
        title: 'Changes and contact',
        body: `<p>We may update these terms. We’ll post the new version here and change the “Last updated” date, and for material changes we’ll give reasonable notice in the app before they take effect. If you keep using grub radar after a change takes effect, you accept the new terms. Contact: ${mail}.</p>`,
      },
    ],
  });
}
