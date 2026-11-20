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
      t('Kill switch', 'Stops every live order at once and cancels any order still waiting to fill, exit sells included. Paper bots keep running.'),
      t('Day profit lock', 'Cash out all, done for you. Set on the Account screen: once the day is up your target percent, the app cashes out on its own, at once or after the day gives back a set number of points from its best. It watches live money or paper and sells only what it watches: a paper lock never touches a live position. It measures the day against the account value at its first reading, and fires at most once a day while the engine runs.'),
      t('Cash out all','Locks in where you are, across every bot at once. Every bot is switched off, the kill switch goes on, and every open position, live and paper, is sold now at the best bid, as far as the bid goes. You can choose to sell only positions in profit. Whatever cannot be sold is held to settlement, and the app lists each one and why.'),
      t('Rules engine', 'The bot trades on the numbers alone. If a play passes every setting, it is placed.'),
      t('Agent', 'Your AI model sees only plays that already passed every setting and can decline any of them. It can never add a trade or change a setting.'),
      t('Poll every', 'How often the bot checks for new plays, in seconds. Each bot keeps its own pace; none checks faster than every ten seconds.'),
      t('Hold to settlement', 'The position is kept until the market settles. This is every bot\'s exit unless you choose another.')
    ]
  },
  {
    title: 'Exit: how a bot gets out',
    intro: 'Each bot picks one. Whatever an exit has not sold when the market settles is settled like any other position. Exits work on paper and on Kalshi; anything bought elsewhere is held to settlement.',
    terms: [
      t('Exit', 'How the bot closes a position: hold it to settlement, rest a sell at a set price the moment it fills, sell at the market once the price reaches that mark, or sell at the market a set time after the entry, whatever the price.'),
      t('Sell after', 'With the time exit: minutes after the entry to sell at the bid, whatever the price, and never sooner because the gap closed. On c2 games the market moved toward our number over minutes, not seconds: in the 4th quarter about 3c after 5 minutes and 8c after 15, before costs. A sell that finds no bid tries again each cycle, and what never sells is held to settlement.'),
      t('Or at the end of the quarter', 'With the time exit: also sell when the quarter the entry was made in ends, if that comes before the minutes are up. With no readable clock only the minutes count.'),
      t('Widest book', 'The most cents the ask may sit above the bid on the side bought. A wide book costs the spread on the way in and again on the way out, which is what sank 60 second scalps. Leave it empty for no limit. With a limit set, a book whose bid cannot be read is refused. Kalshi books only.'),
      t('One entry a game', 'Once the bot has bought on a game, it never buys on that game again that day, even after it has sold out. Without it, a bot with an exit may enter the same game again once it has sold.'),
      t('Limit exit', 'The moment the entry fills, the bot rests a sell on the book at the entry price plus your target, for example bought at 55c, sell at 65c. It sells only if a buyer pays that price. On paper it fills once the real bid reaches the price, as a maker.'),
      t('Cash out at the mark', 'The bot watches the book every cycle and sells at the bid the moment the bid reaches the entry price plus your target. It sells only what the bid offers, never more than it holds, and pays the taker fee.'),
      t('Exit target', 'Cents above the entry price to sell at. 10 means bought at 55c, sold at 65c or better, before fees.'),
      t('Trading both sides', 'Once everything a bot held in a market has sold, it holds nothing there, so it may enter that game again, on either side. Never bet against itself still blocks the other side while a position is open.')
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
      t('PROP', 'A player stat. NBA props are points, rebounds and assists over or under a line, before the tip and in game; NFL props such as passing yards come with the live plays. Not yet graded by Lazy Edge.'),
      t('COMBO', 'Ties plays the bot would take on its own into one Kalshi combo, one leg per game, and buys it when our chance that every leg hits beats the price. Our chance is the legs\' chances multiplied, which is fair across different games; same game combos wait for Lazy Edge\'s parlay pricing. Combos have no order book, so each is priced by asking Kalshi\'s market makers for a quote. A quote that does not add up against what the legs cost one by one is refused.'),
      t('Combos only', 'The bot uses the plays it approves only as combo legs and never buys them alone.'),
      t('Quarters','In game plays trade only in the quarters you tick, so you choose the quarter a bot starts in. Untick Q1 to start in the second quarter. Pregame plays are not affected, and overtime follows No entries in overtime.'),
      t('Phase','Pregame trades only before kickoff or tip: once a game starts, or its start cannot be read, its plays count as live. Live trades during the game, which includes NFL hot plays and NBA live edges. Both does both.'),
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
      t('Buy on', 'What a trade is chosen on. The edge buys where our chance beats the price by the minimum edge and expected value. Our pick buys only the side our number has winning, at the minimum chance and inside the price band, even when the price is above our chance, and the edge and EV minimums are not used. Graded NBA games showed our picks winning more often than we said, so the edge pointed at the other team; on 169 games it is promising and not yet proven, so prove it on paper first. NBA moneylines carry a pick on every game; other plays are bought only when the feed already backs our pick.'),
      t('Our chance above the price', 'Bots that buy our pick only. The fewest probability points our chance must sit above the price you pay: at 74% and 3 points, the bot pays 71c at most. Leave it empty to buy our pick even when the price is above our chance. The graded NFL season made its money on our pick at 70% or more priced under our number.'),
      t('Edge (pp)', 'Probability points: our chance that the contract pays minus the market\'s. 62% against 55% is a 7pp edge.'),
      t('Minimum edge', 'Plays with a smaller edge than this are skipped.'),
      t('EV after fees', 'Expected profit per contract in cents, after the venue\'s fee and the edge haircut, at the price you would actually pay. A play must clear this to trade.'),
      t('Edge haircut', 'Shrinks our claimed edge before the EV check, because measured results showed models are overconfident. 0.5 counts half the edge; 1.0 trusts it fully.'),
      t('Maximum price age', 'A price older than this many seconds is treated as stale and never traded on.'),
      t('Price band', 'Only buy contracts priced between these two numbers, in cents. Very cheap and very expensive contracts are where small model errors cost the most.'),
      t('Require a game event trigger', 'Only take hot plays that Lazy Edge tied to a game event in its reasons. Pregame rows never carry one, so this limits the bot to live plays.'),
      t('Measured edges only', 'Only take plays marked measured, the kinds of edge Lazy Edge has checked against real results.'),
      t('Minimum chance to hit', 'The lowest chance, by Lazy Edge\'s number, that the contract bought pays out, set before the game and for each quarter. A player prop at 74% passes a 72% minimum in the second quarter and is skipped at an 80% minimum in the fourth. 0 means no minimum. Overtime uses the fourth quarter\'s.'),
      t('Most points behind', 'For moneyline and spread plays during a game: the most points the team the bot would back may be behind, set for each quarter. 10 in the fourth means a team down 11 with six minutes left is skipped, however good its price looks. A spread play on the NO side backs the other team. Empty means no limit, and 0 means never a team that is behind. It reads the live score, which only NBA plays carry for now, so other sports are not limited by it; with a limit set, an NBA play whose score cannot be read is skipped.'),
      t('Favorites only', 'For moneyline and spread plays: only back the team the market prices at 50% or more to win the game. A trailing or long shot team can carry a real edge and still lose most nights; this keeps the bot on the side more likely to win.')
    ]
  },
  {
    title: 'Size: how much to put on',
    terms: [
      t('Sizing', 'Kelly sizes each trade by its edge, so a trade with no edge is sized at nothing. Flat makes every trade the maximum per trade, whatever the edge, still held to your balance, the contract limit and the game cap. A bot that buys our pick needs Flat.'),
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
      t('Daily drawdown stop', 'The bot stops opening trades for the day once its settled trades are down this much after fees. The day runs from 4 AM to 4 AM your time. Open trades count once they settle, and deposits or withdrawals never count.'),
      t('Maximum trades per day', 'The bot stops opening trades after this many in a day. The day runs from 4 AM to 4 AM your time, so a late game counts with the night it started. It does not limit how much money is in play; on a live bot that is Maximum open exposure on the Account screen.'),
      t('No entries in overtime', 'No new trades once a game goes to overtime.'),
      t('One position per market', 'The bot holds at most one position in any one contract, on either side, however old the position is.'),
      t('Never bet against itself', 'The bot never takes a trade that bets against one it already holds on the same game: the other team to win, the other side of the same line, or a line that contradicts it. Bets that agree, such as a team to win and to cover, are still allowed.')
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
  quarter_not_enabled: 'Quarter is off for this bot',
  quarter_unknown: 'Quarter unreadable',
  min_chance: 'Chance to hit is under your minimum',
  not_favorite: 'Backs the team the market expects to lose',
  not_our_pick: 'Not our pick: our number has this side losing',
  pick_only: 'Our pick, for bots that buy on our pick',
  favorite_unknown: 'Could not read which team is favored',
  trailing: 'Backs a team further behind than you allow',
  score_unknown: 'Score unreadable',
  position_open: 'Already holds this market',
  game_entered: 'Already entered this game today',
  opposes_position: 'Would bet against a position it holds',
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
