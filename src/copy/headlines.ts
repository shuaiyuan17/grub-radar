import type { Locale } from '../i18n/locales';

/**
 * Headline copy, by time of day. Edit freely.
 *
 * Wrap the word or phrase that gets the yellow highlighter in *asterisks*
 * (exactly one per line). Keep it lowercase and casual.
 */
const EN = {
  /** ~5:00–10:59 */
  breakfast: [
    "what's for *breakfast*?",
    'rise and *eat*.',
    '*breakfast*, then everything else.',
    "morning. *what's good*?",
    'eggs, buns, *anything*?',
  ],
  /** ~11:00–13:59 */
  lunch: [
    "what's for *lunch*?",
    '*lunch* break. go.',
    'where are we *eating* today?',
    'something quick for *lunch*?',
    '*noodles* for lunch?',
  ],
  /** ~14:00–16:59 */
  afternoon: [
    "*snack* o'clock.",
    'a little something *this afternoon*?',
    'too early for dinner. *snack*?',
    'afternoon *pick-me-up*?',
  ],
  /** ~17:00–20:59 */
  dinner: [
    'what are we *eating* tonight?',
    "where's *dinner*?",
    '*dinner*. any ideas?',
    "what's the *move* tonight?",
    'hungry? *pick a spot*.',
  ],
  /** ~21:00–4:59 */
  lateNight: [
    '*late night* bite?',
    'still *hungry*?',
    "what's *open* this late?",
    'one more *snack*, then bed.',
  ],
  /** Saturday + Sunday, ~9:00–16:59 (wins over the slots above) */
  weekendDay: [
    "it's the weekend. *go further*.",
    '*road trip* for lunch?',
    'weekend plan: *eat well*.',
    'worth the *drive*?',
    'no plans? *perfect*.',
  ],
} as const;

export type Slot = keyof typeof EN;

/**
 * Chinese has its own lines, written for the moment rather than translated.
 * Same slots, same *highlight* marking.
 */
const ZH: Record<Slot, readonly string[]> = {
  breakfast: [
    '早饭吃*啥*？',
    '起床，先*吃饱*。',
    '早上好，*来点啥*？',
    '*包子*还是油条？',
    '一日之计在于*早饭*。',
  ],
  lunch: [
    '午饭吃*啥*？',
    '中午了，*干饭*！',
    '今天中午*去哪儿*吃？',
    '来碗*面*？',
    '午休，*速战速决*。',
  ],
  afternoon: ['来点*下午茶*？', '饿了？*垫一口*。', '离晚饭还早，*吃点零嘴*？', '下午*续命*一下？'],
  dinner: [
    '今晚吃点*啥*？',
    '晚饭*去哪儿*？',
    '下班了，*吃顿好的*。',
    '今晚的*饭局*？',
    '饿了吧？*挑一家*。',
  ],
  lateNight: ['*宵夜*走起？', '还*饿*着呢？', '这么晚还有啥*开着*？', '再吃*一口*就睡。'],
  weekendDay: [
    '周末*去哪儿*吃？',
    '周末了，*走远点*。',
    '开车去吃点*好的*？',
    '值得*跑一趟*？',
    '没安排？*正好*。',
  ],
};

export const HEADLINE_COPY: Record<Locale, Record<Slot, readonly string[]>> = {
  en: EN,
  'zh-Hans': ZH,
};
