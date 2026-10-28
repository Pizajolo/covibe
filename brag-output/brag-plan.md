# covibe — brag plan

**What it is:** a multi-agent coding studio on the Claude Agent SDK. You define a team (manager, frontend, backend, QA, tester) in one YAML file; covibe runs it with role-scoped write permissions, hard gates and a bounded fix loop. Mac app + CLI.
**For:** developers who want a whole Claude team on a goal, not one chat.
**Sets it apart:** the engine, not a model, decides control flow — gates really fail and send work back. And the run is shown as a pixel office.
**Most impressive / funniest:** the Office view — members sleep when idle, type when working, raise a hand when they ask.
**Visual hook:** the real pixel office (drawn by `ui/src/components/office-art.ts`, imported as-is), asleep.
**Real UI shown:** office canvas + name plates (app CSS), the New goal composer, the whiteboard steps, the Ship dialog choices.
**Tone:** default — punchy, playful, clean. Chiptune to match the pixels.
**Share caption:** "5 Claudes, 1 pixel office, 0 standups."

**Angle:** the office wakes up, does the job, a gate fails, they fix it, they ship.

**Identity:** app accent `#0a6cff`, member colors `--series-1..5`, plate ink `#1d2233`, Pixelify Sans (the app's office font) + Inter, logo gradient `#5b8cff → #7a4dff`.

**Data:** fictional example run (`shop-app`, goal "Show recently viewed products on the home page", members manager/frontend/backend/qa/tester) — same sample data as the README screenshots. No real users, hosts or keys. Repo is private, so the outro shows the install command, not a URL.

## Music
120 BPM chiptune in C (C–Am–F–G), beat = 0.5s, bar = 2s. Soft pad + arpeggio while asleep, drums enter at 6.0s when the office wakes, minor sting at 11.0 (gate fails), lift at 14.0 (all gates pass), final chord at 17.0 ringing out. Typing ticks on 32nd notes; clicks and dings on beats, in key.

## Storyboard (20s, 1920×1080, 30fps)
| # | Time | Scene | Text |
|---|---|---|---|
| 1 Hook | 0.0–3.0 | Office asleep, Zz, slow push-in | "5 Claudes." / "1 office." / "0 standups." (on beats 0.25, 0.75, 1.25) |
| 2 Goal | 3.0–6.0 | Office dims, New goal composer slides up, goal typed, Start clicked at 5.0 | "Give it one goal." |
| 3 Build | 6.0–10.0 | Office wakes: manager plans (6.0), done at 7.0; frontend + backend build | "They split the work." / sub "each member can only touch its own paths" |
| 4 Gates | 10.0–14.0 | QA reviews; review FAILS at 11.0 → loop 1/3, frontend fixes; review passes 12.5; tester runs 12.5–13.5 | "Gates actually fail." / sub "review failed → fix loop 1/3" |
| 5 Ship | 14.0–17.0 | Everyone happy, whiteboard "all gates passed"; Ship dialog, click "Open pull request" at 16.0 | "All gates passed. Ship it." |
| 6 Outro | 17.0–20.0 | Dip to ink background; logo, name, line, install command | "covibe" / "Your Claude dev team, in one YAML file." / `npm install && npm run desktop` |
