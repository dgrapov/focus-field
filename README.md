<p align="center">
  <a href="https://dgrapov.github.io/focus-field/"><img src="assets/banner.png" alt="Focus Field: can attention lean on chance?" width="100%"></a>
</p>

<p align="center">
  <a href="https://dgrapov.github.io/focus-field/"><b>Open the tool</b></a>
  &nbsp;·&nbsp;
  <a href="https://dgrapov.github.io/focus-field/about.html"><b>The idea &amp; how to test it</b></a>
  &nbsp;·&nbsp;
  <a href="https://dgrapov.github.io/focus-field/results.html"><b>Results &amp; leaderboard</b></a>
</p>

<p align="center">
  <a href="https://dgrapov.github.io/focus-field/"><img alt="Live on GitHub Pages" src="https://img.shields.io/badge/live-GitHub%20Pages-19E6FF?style=flat-square&labelColor=0F1220"></a>
  <img alt="Runs in your browser" src="https://img.shields.io/badge/runs-in%20your%20browser-FFC23A?style=flat-square&labelColor=0F1220">
  <img alt="Local or shared data" src="https://img.shields.io/badge/data-local%20or%20shared-B6FF3B?style=flat-square&labelColor=0F1220">
  <img alt="No build step" src="https://img.shields.io/badge/build-none-8A90AE?style=flat-square&labelColor=0F1220">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-FF5A2E?style=flat-square&labelColor=0F1220"></a>
</p>

---

**Focus Field** runs a live random stream, 500 draws a second, split between 2 and 8 poles. Pick a pole, hold it in mind, and watch whether the stream leans your way, measured against exactly what chance predicts.

It tests an old, unproven idea: that the attention of a conscious observer can nudge randomness. Nothing in the tool assumes the effect is real. It is built so that a real effect could show up, and so that chance looks like chance.

<p align="center">
  <img src="assets/screenshot.png" alt="Focus Field recording a 2-pole session: the live field on the left, jitter, block votes, per-second ribbon and deflection charts on the right" width="100%">
</p>

## What you see

<table>
  <tr>
    <td width="56" valign="top"><img src="assets/icons/field.svg" width="44" alt=""></td>
    <td><b>The field.</b> A circle at 2 poles fills toward cyan or coral with the last few seconds' z-score. At 3–8 poles it becomes a radar with an orb pulled toward whichever poles the stream favours.</td>
  </tr>
  <tr>
    <td valign="top"><img src="assets/icons/votes.svg" width="44" alt=""></td>
    <td><b>Block votes.</b> Every block of draws (10 to 500, your choice) is one vote for the pole that won it. Winning blocks become real bubbles sized by their margin, and a grid shows recent votes with a white dot wherever your goal won.</td>
  </tr>
  <tr>
    <td valign="top"><img src="assets/icons/jitter.svg" width="44" alt=""></td>
    <td><b>Jitter.</b> The lean of each pole drawn continuously over the last 10–60 seconds, with adjustable smoothing and height.</td>
  </tr>
  <tr>
    <td valign="top"><img src="assets/icons/overtime.svg" width="44" alt=""></td>
    <td><b>Over time.</b> Every second counts toward the goal you held at that moment, plotted against a 95% chance band, so switching goals mid-session is fine.</td>
  </tr>
  <tr>
    <td valign="top"><img src="assets/icons/trials.svg" width="44" alt=""></td>
    <td><b>Trials.</b> Timed runs with a target chosen at random, fixed, or a no-focus control, with live or hidden feedback.</td>
  </tr>
  <tr>
    <td valign="top"><img src="assets/icons/seed.svg" width="44" alt=""></td>
    <td><b>Analysis and seeds.</b> Finishing a session reports goal z and p, a chi-square check of the no-focus seconds, leader changes and streaks against chance, and block votes for your goal. It also hashes the session into a SHA-256 seed you can reuse elsewhere.</td>
  </tr>
  <tr>
    <td valign="top"><img src="assets/icons/private.svg" width="44" alt=""></td>
    <td><b>Local or shared.</b> Everything runs in your browser, and your sessions, history and settings live in its local storage. Turn on <b>Share my sessions</b> to add finished sessions to the global experiment; with it off, nothing leaves your browser.</td>
  </tr>
</table>

The layout is yours to arrange: controls fold away, plots can be minimized to a dock, swapped by dragging, or expanded full screen.

<p align="center">
  <img src="assets/screenshot-5-poles.png" alt="A 5-pole session: the radar view with block-vote bubbles drifting toward the winning poles" width="100%">
</p>

## The idea, briefly

From 1979 to 2007 the Princeton Engineering Anomalies Research lab reported that people could shift electronic random generators by a few parts in 10,000. A three-lab replication in 2000 did not confirm it, and a 2006 meta-analysis of 380 studies found a tiny effect that publication bias could explain. The question has never been settled to everyone's satisfaction.

At the size PEAR reported, an effect would need around 30 hours of recording to stand out, so single sessions will almost always look like noise. The [About page](https://dgrapov.github.io/focus-field/about.html) covers the history, what "observer" does and doesn't mean in physics, and a seven-step protocol for testing it without fooling yourself.

## Local or shared: join the global experiment

Every session is analysed in your browser either way. What changes is whether it counts toward the pooled result.

- **Local:** with **Share my sessions** off, nothing is sent anywhere. Your sessions stay in your browser's storage.
- **Shared:** with it on, each finished session goes to the Focus Field API once. A shared session carries the per-second counts, your focus marks, the label you chose (Human, Both or Control), the app version and a random id made by your browser. It carries no name, email or account.
- **The server recomputes your result.** It checks that the session is plausible and recomputes z and p from the raw counts. Your browser only sends counts, never its own statistics.
- **Combined results:** the **Everyone** plot shows the combined z for each label against the ±1.96 chance lines, refreshed every minute.
- **[Results & leaderboard](https://dgrapov.github.io/focus-field/results.html):** a page with the pooled analysis. It shows:
  - the combined z for each label;
  - the running z over time;
  - a funnel plot of every random id;
  - two top-10 boards, best overall and best single run, scored so that one lucky run and many steady hours compete fairly.

  A Control board beside them shows what pure luck looks like.
- **Bot check:** sharing uses Cloudflare Turnstile to keep bots out. The API stores no IP addresses or user agents.

The details are in [Data and privacy](https://dgrapov.github.io/focus-field/about.html#data). The API is a small Cloudflare Worker with a D1 database, in [`worker/`](worker/).

Pooling matters because a real effect at the size PEAR reported would need tens of hours of data. One person rarely records that much, but many people together can. **Turn on sharing and your sessions count.**

## How the randomness works

- Every draw comes from `crypto.getRandomValues`, the browser's cryptographic generator, seeded from your computer's hardware entropy.
- Bytes are fetched 16 at a time as they are needed, so each outcome is made a few hundredths of a second before it is shown, never stored up in advance.
- With more than 2 poles, bytes above the largest multiple of the pole count are rejected, so every pole is exactly equally likely.
- This is a fair, unpredictable stream, but not a physical noise source like the diode-based generators used in the original studies. Support for a USB hardware generator is planned.

## Run it yourself

There is no build step. The site is two static HTML files; the optional sharing API lives in [`worker/`](worker/) and has its own README.

```bash
git clone https://github.com/dgrapov/focus-field.git
cd focus-field
python3 -m http.server 8000   # then open http://localhost:8000
```

Opening `index.html` directly in a browser also works.

## Roadmap

- **AI participants through an MCP server.** The server draws the random numbers only after an agent has placed its attention on the outcome and logged how it did so. Each attention method is then scored against its own rest blocks.

- Hardware random source through Web Serial (TrueRNG, OneRNG), with each session recording which source it used
- Download and load session reports and history as files
- Screen wake lock while recording

## License

[MIT](LICENSE) © Dmitry Grapov
