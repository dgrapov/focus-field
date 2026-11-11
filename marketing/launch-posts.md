# Focus Field: launch copy

Ready-to-post text for sharing Focus Field. Every version keeps the same honest framing: it's a tool for testing an unproven idea, not a claim that the idea is true.

- **Site:** https://dgrapov.github.io/focus-field/
- **About:** https://dgrapov.github.io/focus-field/about.html
- **Repo:** https://github.com/dgrapov/focus-field
- **Social image:** `assets/social-card.png` (1200 × 630, picked up automatically from the page's preview tags)

## One-liners

- Can attention lean on chance? A live random stream you can try to nudge, with honest statistics.
- 500 random draws a second, split between 2 and 8 poles. Pick one and see whether the stream leans your way.
- A browser instrument for an old question: can a focused mind shift a random process?

## Show HN

**Title:** Show HN: Focus Field – try to nudge a live random stream with your attention

**Text:**
I built a small browser tool that runs a live random stream (500 draws a second from `crypto.getRandomValues`) split between 2 and 8 poles. You pick a pole to focus on, and it measures how far the stream drifts toward it against what chance predicts: z-scores, 95% chance bands, a chi-square check on the no-focus baseline, and a "block votes" view where each short block of draws is one vote for the pole that won it.

It's built to test the old REG / "mind over machine" claim from the Princeton PEAR lab honestly. The About page covers the failed 2000 replication and the 2006 meta-analysis that found publication bias could explain the effect, plus a protocol that guards against optional stopping. At the effect size PEAR reported you'd need roughly 30 hours of recording to see anything, so single sessions should look like noise, and the tool says so.

Two static HTML files, no build, no server, data stays in your browser. Feedback on the statistics very welcome.

## X / Bluesky (thread)

1/ Can attention lean on chance? I built Focus Field: a live random stream you try to nudge by focusing on one outcome. It shows exactly how far it drifts from what chance predicts.
dgrapov.github.io/focus-field

2/ 500 draws a second, 2 to 8 poles. Every block of draws is a "vote" for the pole that won it, and winning blocks become bubbles sized by their margin. You're watching the actual randomness, not decoration.

3/ The idea comes from decades of random-generator experiments. The original lab reported a tiny effect; replications mostly didn't confirm it. The About page lays out both sides and a protocol so you don't fool yourself.

4/ Everything runs in your browser. No accounts, no server, nothing uploaded. Open source, MIT.
github.com/dgrapov/focus-field

## LinkedIn

I've long been drawn to complex systems where small influences add up, so I built a small instrument for an old question: can the attention of a conscious observer nudge a random process?

**Focus Field** runs a live random stream in your browser and measures, with proper statistics, how far it leans toward the outcome you focus on. That means z-scores, chance bands, a no-focus baseline, and a view where each short block of draws is one vote for the pole that won it.

It takes no position on the answer. The original lab results were small and replications mostly failed, and the About page explains why a careful test needs many hours and a plan written down in advance. It's a nice exercise in experimental design, statistics and honest feedback, and a calm one to sit with.

Try it: https://dgrapov.github.io/focus-field/
Source (MIT): https://github.com/dgrapov/focus-field

## Reddit

**Subreddits to consider:** r/InternetIsBeautiful, r/dataisbeautiful (post a chart with the data source), r/Parapsychology, r/statistics (ask for feedback on the method).

**Title:** I made a browser tool where you try to nudge a live random stream with your focus, and it tells you honestly whether you did

**Body:**
Focus Field streams 500 random draws a second between 2–8 "poles". Pick one, focus, and it compares the drift with what chance predicts: live z-scores, 95% bands, block votes, and a session report with a no-focus baseline.

It's based on the PEAR lab random-generator experiments, but the About page is upfront that replications mostly failed and that publication bias may explain the original effect. Runs entirely in your browser, nothing is uploaded. I'd love feedback, especially on the stats.

## Image alt text

- **Social card:** Focus Field logo, a circle half coral and half cyan with a wavy waterline, next to the title "Focus Field 1·0" and the line "Can attention lean on chance?"
- **Screenshot:** The Focus Field dashboard. The live field circle is on the left; on the right are jitter, block votes, per-second and over-time charts.
