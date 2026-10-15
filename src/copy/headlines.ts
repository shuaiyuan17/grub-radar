/**
 * Headline copy, by time of day. Edit freely.
 *
 * Wrap the word or phrase that gets the yellow highlighter in *asterisks*
 * (exactly one per line). Keep it lowercase and casual.
 */
export const HEADLINE_COPY = {
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
