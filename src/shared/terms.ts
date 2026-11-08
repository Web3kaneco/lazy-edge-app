// The terms of use and risk acknowledgement shown on first launch. DRAFT for
// legal review: the wording is a plain language starting point, not reviewed
// legal text. Bump TERMS_VERSION whenever the text changes; every user then
// accepts the new version before the engine will start again.

export const TERMS_VERSION = '2026-11-07-beta'

export interface TermsSection {
  title: string
  body: string[]
}

export const TERMS: TermsSection[] = [
  {
    title: 'This is beta software',
    body: [
      'Lazy Edge Desktop is in beta. It is unfinished, it is still being tested, and it is shared with a small group of testers to find its faults. It may contain errors that place orders you did not intend, miss orders you did intend, size or price orders wrongly, show wrong balances or results, or stop working without warning.',
      'Use it only with money you can afford to lose entirely. Lazy Edge is not responsible for any lost funds, losing trades, missed trades or other loss of any kind that comes from using the beta, including losses caused by a fault in the software. Features, settings and these terms can change between beta versions, and each new version of the terms must be accepted again.',
      'Please report anything that looks wrong, with the version number shown at the top of the app, so it can be fixed.'
    ]
  },
  {
    title: 'What this software is',
    body: [
      'Lazy Edge Desktop is software that runs rules you write, on exchange accounts you own, on your own computer. Lazy Edge publishes data: model probabilities, market prices and the measured record of each kind of number.',
      'Lazy Edge does not give financial, investment or trading advice, does not recommend any trade, and does not manage money for anyone. A difference between a model probability and a market price is a disagreement, not a prediction, and the market is often right.'
    ]
  },
  {
    title: 'Your accounts and your decisions',
    body: [
      'Every order this software places is placed on your account, under settings you chose, and is your decision and your responsibility. You can review, change or switch off any bot at any time, and the kill switch stops new live orders and cancels resting ones.',
      'Lazy Edge never holds your funds and never receives your exchange keys or your AI keys. They are encrypted by Windows on this computer and used only to talk to the venue or provider they belong to.'
    ]
  },
  {
    title: 'The risks',
    body: [
      'Trading event contracts can lose all of the money you commit. A measured record describes the past and does not predict the future. Models are estimates with measured error.',
      'Software can have faults. Data can arrive late or be wrong. Orders can be rejected, fill at a different price, fill only in part, or not fill at all. Venues can change their rules, fees or availability without notice.',
      'Live bots start in dry run, which logs the orders they would place without sending them. Prove a bot in paper and dry run before letting it send real orders, and start with amounts you can afford to lose entirely.'
    ]
  },
  {
    title: 'Where you may use it',
    body: [
      'Use this software only where you are legally allowed to trade on the venue you connect, and only within that venue\'s own terms, including its rules on location, age and identity checks.',
      'This software does not help anyone get around a venue\'s location restrictions, and you must not use it that way, including through a VPN, a proxy, or an account that is not your own. If a venue refuses you access, stop using that venue in this software.'
    ]
  },
  {
    title: 'AI providers',
    body: [
      'Connecting an AI provider is optional. Its use is governed by that provider\'s terms and billed to your key. AI output can be wrong. In this software an AI can draft settings for you to review and can decline trades your settings already approved; it can never add a trade or change a setting on its own.'
    ]
  },
  {
    title: 'No warranty',
    body: [
      'The software, including every beta version, is provided as is, without warranty of any kind. To the fullest extent the law allows, Lazy Edge is not liable for lost funds, trading losses, missed trades, software faults, venue or provider outages, or any decision made with the software. Taxes on your trading are your responsibility.'
    ]
  }
]

export const ACKNOWLEDGEMENTS = [
  'I understand this is beta software that may have faults, that I use it at my own risk, and that Lazy Edge is not responsible for any funds I lose.',
  'I am of legal age where I live and I am allowed to trade on the venues I connect.',
  'I understand I can lose all of the money I commit, and that past records do not predict results.',
  'I understand Lazy Edge provides data, not advice, and that every order is my own decision under my own settings.',
  'I will not use this software to get around any venue\'s location or identity rules.'
] as const
