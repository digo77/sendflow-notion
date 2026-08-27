---
name: card-perks
description: Build a personalised credit-card perk plan — which card to use for every spend category, which benefits are going unclaimed, and whether each annual fee actually pays for itself. Use when the user mentions credit card points, rewards, perks, benefits, annual fees, lounge access, travel credits, Airpoints/Avios/Membership Rewards, "which card should I use for", "am I wasting my annual fee", or types /card-perks.
trigger: /card-perks
---

# /card-perks

Most people hold cards whose benefits they never claim and pay annual fees they never break even on. This skill fixes that: it learns which cards the user holds, how they actually spend, what they care about, researches each card's **current** published benefits, and returns a plan they can act on this week.

Works in any market. Ask the region first — earn rates, fees and perks differ completely between NZ, AU, US and UK.

---

## Rule 0 — the data rule (non-negotiable, applies before anything else)

State this in your first message, in plain language, before asking anything:

> Don't send me PDF or photo statements. They carry your full account number, address and every transaction. If you want me to read real numbers, export a CSV and delete the account-number column first — or just tell me your rough monthly spend and we'll work from that.

Hard rules:

- **Never ask for and never accept**: card numbers, CVV, expiry dates, account numbers, PINs, online-banking logins, or a photo/PDF/screenshot of a statement.
- If the user attaches a PDF or image statement anyway: **do not read it**. Say why, point them at the CSV route, and offer the typed-spend route as the faster alternative.
- If a CSV they send contains a column that looks like an account or card number (long digit strings, `4xxx xxxx`, `Account`, `Card No`), stop, tell them which column to delete, and ask for a clean re-upload. Do not summarise the file in the meantime.
- Last four digits are not needed for anything. Don't ask for them.
- Card names and rough category totals are all this skill requires.

Never lecture past one short paragraph. Say it once, clearly, then move on.

---

## Step 1 — Ask the framing questions

Use the **AskUserQuestion** tool. One call, four questions. Keep option labels short and give each a description that explains the trade-off.

1. **Region** — which country the cards were issued in (NZ / AU / US / UK / other). Everything downstream depends on this.
2. **What "perk" means to them** — multiSelect: airline points or miles · cashback · lounge access · travel insurance and purchase cover · hotel or airline status · simply not wasting the annual fee.
3. **Travel frequency** — never/rarely · 1–2 trips a year · 4+ trips · monthly. This decides whether lounge and travel credits are worth anything to them at all.
4. **How they want to supply spend** — tell you rough monthly figures · upload a cleaned CSV export · they genuinely don't know (you'll offer a typical profile to react to).

## Step 2 — Ask which cards they hold

Second **AskUserQuestion** call, options built from the region they picked. Make it multiSelect and always include an "other / not listed" path.

- **NZ** — Amex Platinum Card · Amex Airpoints Platinum · ANZ Visa Platinum · ANZ Airpoints Visa Platinum · ASB Visa Platinum Rewards · BNZ Advantage Visa Platinum · Westpac hotpoints World Mastercard · Kiwibank Air New Zealand Airpoints Platinum
- **AU** — Amex Platinum · Amex Explorer · Qantas Premier Platinum · ANZ Frequent Flyer Black · NAB Qantas Signature · CommBank Ultimate Awards
- **US** — Amex Platinum · Amex Gold · Chase Sapphire Reserve · Chase Sapphire Preferred · Capital One Venture X · Citi Strata Premier · a flat-rate cashback card
- **UK** — Amex Platinum · Amex BA Premium Plus · Barclaycard Avios Plus · HSBC Premier World Elite

In the same call, also ask: **annual fee tolerance** (happy to pay if it pays for itself / want it under a threshold / want zero fee), and whether there are **supplementary cardholders** on any account (partner cards often carry duplicate insurance and extra lounge entries people forget they have).

## Step 3 — Get the spend picture

If they chose to type it, ask for approximate **monthly** spend across these categories — present it as a list they can fill in loosely, not an interrogation:

groceries · dining and takeaway · fuel and transport · flights · hotels · utilities and rates · insurance premiums · online subscriptions · retail and everything else

If they chose CSV: read it, group merchants into those categories, show them the grouped totals and ask them to correct anything obviously miscategorised before you build on it.

If they said "I don't know": offer a typical profile for their region and income band, clearly labelled as an assumption, and ask them to adjust the two or three lines that feel wrong.

**Market realities to raise, not bury** — flag these when they apply:
- Amex acceptance is patchy outside major retailers in NZ/AU, and merchants often surcharge it. A great earn rate on a card the merchant refuses is worth zero.
- Utilities, rates, government payments and insurance frequently earn nothing or earn at a reduced rate. Check before crediting them in the plan.
- Some issuers cap points per statement period. A cap turns a headline rate into a much lower effective rate.

## Step 4 — Research the actual current benefits

Use **web search** for every card they named. Do not work from memory — annual fees, earn rates and credits change every year.

For each card, establish from the issuer's own page where possible:
- annual fee (and supplementary card fee)
- earn rate per dollar, by category, and any caps
- travel credits, dining credits, subscription rebates — with their reset date (calendar year? card anniversary? half-yearly?)
- lounge access: which lounges, how many visits, guests included or not
- insurance: travel medical, cancellation, rental car excess, purchase protection, extended warranty — and the activation condition (many require the trip to be paid on that card)
- transfer partners and transfer ratios, if points-based

**Cite what you find.** Every dollar figure in the final plan traces to a source or an openly stated assumption. If you cannot confirm something, write `—` and flag it as unverified. Never fill a gap with a plausible-sounding number.

State your points valuation explicitly before using it — e.g. "I'm valuing Airpoints Dollars at NZ$1 each, since they redeem 1:1 on Air NZ fares" — and show the plan's sensitivity if the valuation is contested.

## Step 5 — Build the plan

The plan has six parts. All six, every time:

1. **The headline** — one number: dollars per year currently left on the table, and the single change that recovers the most of it.
2. **The routing table** — every spend category → the card to use → why → estimated annual value. This is the part they'll screenshot.
3. **Unclaimed benefits** — perks they already pay for and aren't using, each with its reset date and what to do to claim it.
4. **Annual fee break-even** — per card: fee paid vs value realistically realised, and a verdict of keep / downgrade / cancel. Be willing to say a card isn't worth it.
5. **The switch list** — the three concrete changes, ranked by dollars gained, each phrased as an action they can take this week.
6. **The claim calendar** — what to claim in which month, so the credits with reset dates don't expire unused.

Then state assumptions in a short table: points valuations, spend figures used, anything unverified.

## Step 6 — Deliver it as an artifact

Load the **artifact-design** skill, then build a single self-contained HTML page and publish it with the **Artifact** tool.

The page must carry: the headline number large and immediately, the routing table, break-even bars per card, the switch list, the claim calendar, and the assumptions table. Theme-aware (light and dark), no external requests, tables scroll inside their own container on narrow screens. Give it a short noun-phrase title like "Card Perk Plan".

---

## Boundaries

- This optimises benefits on cards the user already holds. It is **not** financial advice, and it doesn't advise on borrowing, balance transfers, or carrying a balance.
- If they're carrying interest month to month, say plainly and once that interest will exceed any perk value, and that clearing it beats optimising it. Then continue with what they asked for.
- Suggest new card applications only if the user asks. If you do, flag the credit-check and eligibility angle and leave the decision with them.
- Never invent a benefit, a fee, or an earn rate. `—` and a flag beats a confident guess.
