# Focus Field

A live random stream split between 2 and 8 poles. Pick a pole, focus on it, and see whether the stream leans your way, measured against what chance alone predicts.

**Try it:** https://dgrapov.github.io/focus-field/
**The idea, the evidence so far, and a protocol to test it:** https://dgrapov.github.io/focus-field/about.html

## What it does

- **Focus sessions.** Record a stream at 500 draws a second while marking which pole you are focusing on. Switch goals any time; every second is scored toward the goal it had.
- **Trials.** Timed runs with a target picked for you (or fixed, or a no-focus control), with live or hidden feedback.
- **Feedback at several time scales.** A live field (a circle at 2 poles, a radar at 3 or more), a jitter trace, block votes (every block of draws is one vote for the pole that won it), a per-second ribbon, and deflection charts with 95% chance bands.
- **Analysis.** Finishing a session reports goal z and p, a chi-square check of the no-focus seconds, leader changes and streaks against chance, and block votes for the goal. It also produces a SHA-256 seed of the session.

## How the randomness works

Every draw comes from the browser's cryptographic generator, `crypto.getRandomValues`, seeded from your computer's hardware entropy. Bytes are fetched 16 at a time as they are needed, so outcomes are made a few hundredths of a second before they are shown, never stored up in advance. With more than 2 poles, bytes outside the largest multiple of the pole count are rejected so every pole is exactly equally likely.

This is a fair, unpredictable stream, but not a physical noise source like the hardware generators used in the original laboratory studies.

## Privacy

Everything runs in your browser. Nothing is sent to a server. Sessions, history and settings are kept in this browser's local storage.

## Run it locally

It is two static HTML files with no build step. Open `index.html` in a browser, or serve the folder with any static server.

## License

MIT. See [LICENSE](LICENSE).
