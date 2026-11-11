// Plain English for every term a user meets on the Bots and Board screens.
// One source for the hover tips, the Board's verdicts and the Help screen, so
// a term means the same thing everywhere. Label wording follows the API guide
// (/v1/skill); everything else describes what src/main/rules/gates.ts does.

export interface Term { term: string; text: string }
export interface Section { title: string; intro?: string; terms: Term[] }

const t = (term: string, text: string): Term => ({ term, text })

export const GLOSSARY: Section[] = [
  {
    title: 'How a bot works',
    intro: 'A bot is a list of settings. Every cycle the engine reads the Lazy Edge board, rereads the live price for each play the bot covers, and runs it through the checks below in order. The first check that fails stops the trade and is written down with its reason. A play that passes every check is placed. Nothing else decides.',
    terms: [
      t('Paper', 'Trades a local practice ledger against the real order books. No money moves. Paper results show what your settings would have done at prices that really existed.'),
      t('Live', 'Sends real orders to the venues you picked. Still obeys the account\'s dry run switch and the kill switch.'),
      t('Dry run', 'An account wide switch. Live bots go through every step and record the exact order they would send, but send nothing. It is on until you turn it off on the Account screen.'),
      t('Kill switch', 'Stops every live order at once and cancels any order still waiting to fill. Paper bots keep running.'),
      t('Rules engine', 'The bot trades on the numbers alone. If a play passes every setting, it is placed.'),
      t('Agent', 'Your AI model sees only plays that already passed every setting and can decline any of them. It can never add a trade or change a setting.'),
      t('Poll every', 'How often the bot checks for new plays, in seconds. The engine runs at the pace of the fastest bot that is switched on, never faster than every ten seconds.'),
      t('Hold to settlement', 'Every position is held until the market settles. There is no selling early in this version.')
    ]
  },
  {
    title: 'Market: what a bot looks at',
    terms: [
      t('Sports', 'Which leagues this bot reads. WC (World Cup) is not wired yet.'),
      t('Lanes', 'The kinds of bet this bot may take. Hover each one for what it means.'),
      t('MONEYLINE', 'Which team wins the game.'),
      t('SPREAD', 'Whether a team wins by more than a number of points, for example "Kansas City wins by over 3.5".'),
      t('TOTAL', 'Whether both teams together score over or under a number of points.'),
      t('TEAM_TOTAL', 'Whether one team scores over or under a number. Not yet graded by Lazy Edge, so it is off by default.'),
      t('PROP', 'A player stat such as passing yards. Live prop plays are not yet graded by Lazy Edge.'),
      t('Phase', 'Pregame trades before kickoff or tip. Live trades during the game, which includes NFL hot plays and NBA live edges. Both does both.'),
      t('Hot play', 'A live NFL edge that met Lazy Edge\'s hot plays rule during a game. Bots set to Live or Both phase can trade them.'),
      t('Labels', 'Every board row is labelled by how its edge was found. A bot only trades labels you switch on.'),
      t('PRICE_GAP', 'Our probability clears the venue\'s ask by 3 or more points on a tight quote.'),
      t('RATING_Q', 'Our number and the consensus of eleven sportsbooks disagree by 5 or more total points or 4 or more spread points. A disagreement with the books, not a price gap.'),
      t('LEAN', 'A smaller gap.'),
      t('TAIL_RUNG', 'A line away from the venue\'s main line. Ranked, but never the headline play.'),
      t('ROLE_Q', 'Lazy Edge and the venue disagree on a player\'s role, a depth chart question.'),
      t('MEASURED', 'An edge Lazy Edge has measured in real results, such as the market under reacting after a turnover.'),
      t('ILLIQUID, ROLE_PRICED, UNPRICED', 'Shown by the API but never ranked. No bot can trade them.'),
      t('Venues', 'Where the bot may trade. When more than one has the contract, the best price after fees wins. A live bot skips a venue that has no usable balance.')
    ]
  },
  {
    title: 'Entry: when a play is good enough',
    terms: [
      t('Edge (pp)', 'Probability points: our chance that the contract pays minus the market\'s. 62% against 55% is a 7pp edge.'),
      t('Minimum edge', 'Plays with a smaller edge than this are skipped.'),
      t('EV after fees', 'Expected profit per contract in cents, after the venue\'s fee and the edge haircut, at the price you would actually pay. A play must clear this to trade.'),
      t('Edge haircut', 'Shrinks our claimed edge before the EV check, because measured results showed models are overconfident. 0.5 counts half the edge; 1.0 trusts it fully.'),
      t('Maximum price age', 'A price older than this many seconds is treated as stale and never traded on.'),
      t('Price band', 'Only buy contracts priced between these two numbers, in cents. Very cheap and very expensive contracts are where small model errors cost the most.'),
      t('Require a game event trigger', 'Only take hot plays that Lazy Edge tied to a game event in its reasons. Pregame rows never carry one, so this limits the bot to live plays.'),
      t('Measured edges only', 'Only take plays marked measured, the kinds of edge Lazy Edge has checked against real results.')
    ]
  },
  {
    title: 'Size: how much to put on',
    terms: [
      t('Kelly', 'A standard formula for bet size from your edge and the price. Full Kelly is aggressive, so bots use a fraction of it.'),
      t('Kelly multiplier', 'The fraction of full Kelly to bet. 0.25 is quarter Kelly.'),
      t('Bankroll', 'The money Kelly sizes against. 0 uses the venue\'s live balance, so bets shrink after losses and grow after wins.'),
      t('Maximum per trade', 'No single trade costs more than this.'),
      t('Minimum per trade', 'A trade smaller than this is rounded up to it, because a tiny trade cannot pay its own fee.'),
      t('Maximum contracts per trade', 'A cap on contracts inside one trade, whatever the dollar size. It is not a count of trades; that is Maximum trades per day. At a few dollars a trade it rarely matters.'),
      t('Maximum share of equity per game', 'The most of your balance this bot can have at risk on one game across all its positions. 0.35 is 35%.')
    ]
  },
  {
    title: 'Guards: hard stops',
    terms: [
      t('No entry in the final', 'No new live trades with this many seconds or fewer left in the game.'),
      t('Cancel unfilled after', 'An order that has not filled after this many seconds is cancelled.'),
      t('Daily drawdown stop', 'The bot stops for the day once it is down this much, counting both settled losses and the drop in your balance since the day began at 4 AM your time.'),
      t('Maximum trades per day', 'The bot stops opening trades after this many in a day. The day runs from 4 AM to 4 AM your time, so a late game counts with the night it started. It does not limit how much money is in play; on a live bot that is Maximum open exposure on the Account screen.'),
      t('No entries in overtime', 'No new trades once a game goes to overtime.'),
      t('One position per market', 'The bot holds at most one position in any one market.')
    ]
  }
]

// The Board's verdicts: why a bot would not take a play, by the gate's name.
export const GATES: Record<string, string> = {
  kill_switch: 'The kill switch is on',
  sport_not_enabled: 'Sport is off for this bot',
  lane_not_enabled: 'Lane is off for this bot',
  phase_not_enabled: 'Phase is off for this bot',
  label_never_traded: 'This label is never traded',
  label_not_enabled: 'Label is off for this bot',
  not_measured: 'Not a measured edge',
  no_trigger: 'No game event trigger',
  side_unresolved: 'Could not tell which side to buy, so refused',
  no_reading: 'No price yet',
  min_edge: 'Edge is under your minimum',
  clock_unknown: 'Game clock unreadable',
  overtime: 'Overtime',
  final_seconds: 'Too close to the end',
  position_open: 'Already holds this market',
  max_trades_today: 'Daily trade limit reached',
  bot_drawdown: 'Bot hit its daily drawdown stop',
  account_drawdown: 'Account hit its daily drawdown stop',
  no_venue: 'No venue passes',
  no_bankroll: 'No bankroll to size against',
  kelly_zero: 'No edge left after the haircut',
  size_too_small: 'Trade too small to place',
  game_cap: 'Would exceed the per game limit',
  account_exposure: 'Would exceed the account exposure limit',
  agent_declined: 'The agent declined'
}

const INDEX = new Map(GLOSSARY.flatMap((s) => s.terms.map((x) => [x.term.toLowerCase(), x.text] as const)))

// The tip for a term, by its name as shown, or '' when the glossary has none.
// tests/glossary.test.ts checks every term the screens use exists.
export function tip(term: string): string {
  return INDEX.get(term.toLowerCase()) ?? ''
}
