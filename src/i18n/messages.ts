import type { SigninResult } from '../contracts/errors';
import type { Day, Hours, Kind } from '../domain/spot';
import { formatMiles, formatMinutes, type TravelMode } from '../domain/travel';
import type { Mode } from '../domain/modes';
import type { From } from '../lib/origin';
import type { Locale } from './locales';

/**
 * The UI message catalog. English defines the shape; every other language
 * must match it exactly (`Messages`), so a missing or misspelt key in zh is
 * a type error, not a blank button. Strings with *asterisks* mark the words
 * that get the yellow highlighter. Spot data (names, cuisines, notes) is
 * not translated.
 */
/** "22:00" -> "10pm", "22:30" -> "10:30pm", "00:00" -> "midnight", "12:00" -> "noon". */
function enClock(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  if (h === 0 && m === 0) return 'midnight';
  if (h === 12 && m === 0) return 'noon';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

const ZH_DAYS: Record<Day, string> = {
  mon: '周一',
  tue: '周二',
  wed: '周三',
  thu: '周四',
  fri: '周五',
  sat: '周六',
  sun: '周日',
};

const en = {
  langGroup: 'Language',
  skip: 'skip to content',
  loading: 'unfolding the map…',
  loadError: (message: string) => `couldn't load the spots: ${message}`,
  logoLabel: 'grub radar, home',

  fromGroup: 'Measure distances from',
  distancesFrom: 'distances from',
  fromShort: 'from',
  home: 'home',
  whereIAm: 'where i am',
  findingYou: 'finding you…',
  demoHomeNote: 'from a demo home in downtown seattle ·',
  setYourHome: 'set your home',
  setHome: 'set home',
  editHome: 'edit home',
  setHomeAria: 'Set your home location',
  editHomeAria: 'Change your home location',
  useMyLocation: 'Use my current location',

  modesGroup: 'What kind of idea',
  modes: { near: 'near me', weekend: 'weekend', coffee: 'coffee' } satisfies Record<Mode, string>,
  modeHeadlines: {
    near: 'what are we *eating* tonight?',
    weekend: "it's the weekend. *go further*.",
    coffee: 'first, *coffee*.',
  } satisfies Record<Mode, string>,
  cravingGroup: 'Craving',
  all: 'all',
  /** Craving tags are data; languages may give them a display name. */
  tags: {} as Readonly<Record<string, string>>,

  searchLabel: 'Search my spots',
  searchPlaceholder: 'search my spots, dishes, notes…',
  spotCount: (n: number) => `${n} ${n === 1 ? 'spot' : 'spots'} · closest first`,
  matchCount: (n: number) => `${n} ${n === 1 ? 'match' : 'matches'} · closest first`,
  noMatch: (q: string) => `nothing matches “${q}”.`,
  empty: {
    near: (minutes: number) => `nothing within ${minutes} min. try weekend, or search.`,
    weekend: () => 'no far-flung ideas yet.',
    coffee: (minutes: number) => `no coffee within ${minutes} min. that's a problem.`,
  } satisfies Record<Mode, (minutes: number) => string>,

  rollSmall: "can't decide? roll",
  rollTitle: "can't decide?",
  rollSub: "roll the dice on what's in range",
  diceSays: 'the dice says…',
  clearRoll: 'Clear the roll',

  viewNav: 'View',
  navList: 'list',
  navRadar: 'radar',
  dismiss: 'Dismiss',
  close: 'Close',
  notices: {
    denied: "location is blocked for this site, so we're measuring from home.",
    unavailable: "couldn't find you just now, so we're measuring from home.",
    homeDenied: "location is blocked, so we couldn't set home from it. try typing it in.",
    homeUnavailable: "couldn't find you just now. try again, or type it in.",
    homeSaved: 'home saved on this device.',
    homeVisitOnly: "this browser won't store it, so home is saved for this visit only.",
  },

  been: 'been',
  wantToTry: 'want to try',
  beenHere: 'been here',
  appleMaps: 'Apple Maps',
  /**
   * Labels that embed a spot name come as [before, after] around the name,
   * so the name can carry its own lang (see SpotLabel).
   */
  mapsLabel: (mode: TravelMode): readonly [string, string] => [
    'Take me to ',
    `: ${mode === 'walk' ? 'walking' : 'driving'} directions in Apple Maps`,
  ],
  travelMode: { walk: 'walk', drive: 'drive' } satisfies Record<TravelMode, string>,
  minutes: (m: number) => formatMinutes(m),
  distance: (_km: number, miles: number) => formatMiles(miles),
  kinds: { food: 'food', coffee: 'coffee', bakery: 'bakery' } satisfies Record<Kind, string>,

  placesLabel: 'Places',
  asideLabel: 'Radar and dice',
  around: { home: 'around home', here: 'around you' } satisfies Record<From, string>,
  ringsNote: 'rings = travel time',
  openRadar: 'open the full radar',

  radarHeadline: 'how far will you *go*?',
  upTo: 'up to',
  ringLabels: ['10 min', '30 min', '1 hr', 'road trip'] as readonly [
    string,
    string,
    string,
    string,
  ],
  kindsGroup: 'Show kinds',
  inReach: (n: number) => `${n} in reach`,
  radarHint: 'tap a dot to see the spot, or let the dice pick.',
  radarGroup: (from: From) => `Places around ${from === 'home' ? 'home' : 'you'} by travel time`,
  radarImg: (from: From) =>
    `Radar of saved places around ${from === 'home' ? 'home' : 'you'}, in 10 minute, 30 minute, 1 hour and road trip rings`,
  radarRingsSr: (from: From) =>
    `Rings around ${from === 'home' ? 'home' : 'you'}: 10 minutes, 30 minutes, 1 hour, and road trip.`,
  hub: { home: 'Home', here: 'You are here' } satisfies Record<From, string>,
  dotLabel: (
    kind: string,
    time: string,
    mode: string,
    inReach: boolean,
  ): readonly [string, string] => [
    '',
    `, ${kind}, ${time} ${mode}${inReach ? '' : ', beyond your reach'}`,
  ],
  backToListArrow: '← back to the list',

  backAria: 'Back to the list',
  back: 'back',
  backToList: 'back to the list',
  spotNotFound: "that spot's *not here*.",
  spotNotFoundBody: 'maybe it got renamed. maybe it closed. either way:',
  nearness: { home: 'near home', here: 'near you' } satisfies Record<From, string>,
  roadTrip: 'road trip',
  stats: { fromHome: 'from home', fromHere: 'from here', openTill: 'open till', kind: 'kind' },
  /** Closing time, e.g. "10pm", "midnight", "11pm (fri)", "sold out". */
  hours: (h: Hours) =>
    (h.closes === 'sold-out' ? 'sold out' : enClock(h.closes)) +
    (h.days ? ` (${h.days.join(', ')})` : ''),
  noPhoto: 'no photo yet',
  whyTitle: "why it's on the list",
  foundBy: (date: string) => `found by your agent · ${date}`,
  formatDate: (iso: string) =>
    new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    })
      .format(new Date(iso))
      .toLowerCase(),
  aboutSpot: 'About this spot',
  orderThis: 'order this',
  hadIt: ' (had it)',
  nextTime: 'next time',
  myNote: 'my note',
  noNoteYet: 'nothing yet. go, then scribble.',
  takeMeThere: 'take me there',

  pageNotFound: 'nothing on the *radar* here.',
  pageNotFoundBody: 'wrong turn. happens to the best of us.',

  homeTitle: "where's home?",
  homePrivacy:
    "saved on this device only. it never leaves your browser and isn't part of the site.",
  homeNow: (lat: string, lng: string) => ` now: ${lat}, ${lng}.`,
  useWhereIAmNow: 'use where i am now',
  typeLatLng: 'or type it as lat, lng',
  save: 'save',
  latLngError: "that doesn't look like lat, lng (e.g. 47.61, -122.33).",
  forgetHome: 'forget my home (back to the demo)',

  wallTagline: 'where should we *eat*?',
  /** Apple's own title for the button (HIG); keep it verbatim. */
  appleSignIn: 'Sign in with Apple',
  checkingWho: 'checking who you are…',
  accountLabel: (name: string) => `Signed in as ${name}`,
  signOut: 'sign out',
  signingOut: 'signing out…',
  signinResult: {
    cancelled: 'sign-in cancelled. no worries, try again whenever.',
    closed: 'grub radar is invite-only for now. that Apple ID doesn’t have an account.',
    failed: 'that didn’t work. try signing in again?',
  } satisfies Record<SigninResult, string>,
};

export type Messages = typeof en;
export type NoticeKey = keyof Messages['notices'];

const zhMinutes = (m: number) => {
  const total = Math.max(1, Math.round(m));
  if (total < 60) return `${total} 分钟`;
  const h = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${h} 小时` : `${h} 小时 ${rest} 分`;
};

const zh: Messages = {
  langGroup: '语言',
  skip: '跳到正文',
  loading: '正在展开地图…',
  loadError: (message) => `加载失败：${message}`,
  logoLabel: 'grub radar，首页',

  fromGroup: '距离从哪儿算',
  distancesFrom: '距离从',
  fromShort: '从',
  home: '家',
  whereIAm: '我在哪',
  findingYou: '定位中…',
  demoHomeNote: '现在用的是西雅图市中心的示例“家” ·',
  setYourHome: '设置你的家',
  setHome: '设置家',
  editHome: '修改家',
  setHomeAria: '设置家的位置',
  editHomeAria: '修改家的位置',
  useMyLocation: '用我现在的位置',

  modesGroup: '想吃哪种',
  modes: { near: '附近', weekend: '周末', coffee: '咖啡' },
  modeHeadlines: {
    near: '今晚吃点*啥*？',
    weekend: '周末了，*走远点*。',
    coffee: '先来杯*咖啡*。',
  },
  cravingGroup: '想吃',
  all: '全部',
  tags: {
    noodles: '面',
    dumplings: '饺子',
    soup: '汤',
    tacos: '塔可',
    sandwiches: '三明治',
    spicy: '辣',
    cheap: '便宜',
    espresso: '意式浓缩',
    pastry: '糕点',
    'laptop ok': '能办公',
    'pour-over': '手冲',
    'street food': '街头小吃',
    bakery: '面包店',
    bbq: '烧烤',
    seafood: '海鲜',
    'day trip': '一日游',
  },

  searchLabel: '搜索我的店',
  searchPlaceholder: '搜店名、菜、笔记…',
  spotCount: (n) => `${n} 家 · 由近到远`,
  matchCount: (n) => `找到 ${n} 家 · 由近到远`,
  noMatch: (q) => `没找到“${q}”。`,
  empty: {
    near: (minutes) => `${minutes} 分钟内没有。试试周末，或者搜一下。`,
    weekend: () => '还没有远一点的点子。',
    coffee: (minutes) => `${minutes} 分钟内没咖啡，这可不行。`,
  },

  rollSmall: '选不出来？摇一个',
  rollTitle: '选不出来？',
  rollSub: '在范围内摇个骰子',
  diceSays: '骰子说…',
  clearRoll: '清除结果',

  viewNav: '视图',
  navList: '列表',
  navRadar: '雷达',
  dismiss: '知道了',
  close: '关闭',
  notices: {
    denied: '这个网站的定位被禁用了，先按家来算距离。',
    unavailable: '暂时定位不到你，先按家来算距离。',
    homeDenied: '定位被禁用了，没法用它设置家。手动输入试试？',
    homeUnavailable: '暂时定位不到你。再试一次，或者手动输入。',
    homeSaved: '家已保存在这台设备上。',
    homeVisitOnly: '这个浏览器存不了，家只在这次访问里有效。',
  },

  been: '去过',
  wantToTry: '想去',
  beenHere: '去过',
  appleMaps: 'Apple 地图',
  mapsLabel: (mode) => ['带我去 ', `：在 Apple 地图中查看${mode === 'walk' ? '步行' : '驾车'}路线`],
  travelMode: { walk: '步行', drive: '开车' },
  minutes: zhMinutes,
  distance: (km) => (km < 10 ? `${km.toFixed(1)} 公里` : `${Math.round(km)} 公里`),
  kinds: { food: '吃的', coffee: '咖啡', bakery: '烘焙' },

  placesLabel: '店铺',
  asideLabel: '雷达和骰子',
  around: { home: '家附近', here: '你附近' },
  ringsNote: '圈 = 路上要多久',
  openRadar: '打开完整雷达',

  radarHeadline: '这次跑*多远*？',
  upTo: '最远',
  ringLabels: ['10 分钟', '30 分钟', '1 小时', '自驾游'],
  kindsGroup: '显示种类',
  inReach: (n) => `范围内 ${n} 家`,
  radarHint: '点一个点看看，或者让骰子帮你选。',
  radarGroup: (from) => `${from === 'home' ? '家' : '你'}附近的店，按路程时间排列`,
  radarImg: (from) =>
    `${from === 'home' ? '家' : '你'}附近收藏的店的雷达图，分为 10 分钟、30 分钟、1 小时和自驾游几圈`,
  radarRingsSr: (from) =>
    `以${from === 'home' ? '家' : '你'}为中心的圈：10 分钟、30 分钟、1 小时、自驾游。`,
  hub: { home: '家', here: '你在这里' },
  dotLabel: (kind, time, mode, inReach) => [
    '',
    `，${kind}，${mode} ${time}${inReach ? '' : '，超出范围'}`,
  ],
  backToListArrow: '← 回到列表',

  backAria: '回到列表',
  back: '返回',
  backToList: '回到列表',
  spotNotFound: '这家店*不见了*。',
  spotNotFoundBody: '可能改名了，也可能关门了。总之：',
  nearness: { home: '离家近', here: '离你近' },
  roadTrip: '自驾游',
  stats: { fromHome: '离家', fromHere: '离你', openTill: '营业到', kind: '种类' },
  hours: (h) =>
    (h.closes === 'sold-out' ? '卖完为止' : h.closes === '00:00' ? '午夜' : h.closes) +
    (h.days ? `（${h.days.map((d) => ZH_DAYS[d]).join('、')}）` : ''),
  noPhoto: '还没有照片',
  whyTitle: '为什么在清单上',
  foundBy: (date) => `由你的 agent 发现 · ${date}`,
  formatDate: (iso) =>
    new Intl.DateTimeFormat('zh-Hans', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(iso)),
  aboutSpot: '关于这家店',
  orderThis: '点这些',
  hadIt: '（吃过）',
  nextTime: '下次',
  myNote: '我的笔记',
  noNoteYet: '还没写。去吃完再说。',
  takeMeThere: '带我去',

  pageNotFound: '*雷达*上没有这一页。',
  pageNotFoundBody: '走错路了，谁都会的。',

  homeTitle: '家在哪儿？',
  homePrivacy: '只保存在这台设备上，不会离开你的浏览器，也不会成为网站的一部分。',
  homeNow: (lat, lng) => ` 现在：${lat}, ${lng}。`,
  useWhereIAmNow: '用我现在的位置',
  typeLatLng: '或者输入纬度, 经度',
  save: '保存',
  latLngError: '格式不对，应该是“纬度, 经度”（比如 47.61, -122.33）。',
  forgetHome: '忘掉我的家（回到示例）',

  wallTagline: '今天去哪儿*吃*？',
  /** Apple's localized button title (HIG). */
  appleSignIn: '通过 Apple 登录',
  checkingWho: '确认一下你是谁…',
  accountLabel: (name) => `已登录：${name}`,
  signOut: '退出登录',
  signingOut: '正在退出…',
  signinResult: {
    cancelled: '登录已取消。随时可以再来。',
    closed: 'grub radar 目前仅限邀请，这个 Apple ID 还没有账号。',
    failed: '没成功，再登录一次试试？',
  },
};

export const MESSAGES: Record<Locale, Messages> = { en, 'zh-Hans': zh };
