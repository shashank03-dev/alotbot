# Grok Call: Shashank's demo video

**What this is:** my face-cam demo of Grok Call, shot with a real live call. Nothing is mocked: real Grok bots, a real cloud computer, my real Mac and my real apps.
**Length:** about 3 minutes. The 90 s cut for X is at the end.
**Goal:** whoever watches it, the people at xAI especially, should come away thinking "this guy runs a whole team of agents from one voice call."

**How to use this file:**
- Read the whole thing once.
- Do the prep the day before.
- On the day, keep only the **cue card** (last section) open on a second screen or a phone next to the camera.
- Don't read the lines word for word. Know the point of each line and say it your way. The bots won't stick to a script either, so react to what they actually say. That's what makes it look real.

Line types:
- **Me → camera:** face on screen, talking to whoever's watching.
- **Me → bots:** said in the call. The bots hear it.
- **Voiceover:** recorded after, over the screen part. Saying it live works too.
- **Do:** clicks.

---

## The crew

They're already on my Grok account, and each has its own voice, color and shape, so they look and sound different on screen.

| Bot | Looks | Job in the video | Why the name |
|---|---|---|---|
| **Satya** | cyan square | Lead: splits the work, checks GitHub, reads my screen | Microsoft owns GitHub |
| **Jensen** | green hex | Research on its own cloud Linux computer | Got the compute |
| **Tim** | gray tablet | Runs my tests on my Mac | It's a Mac |
| **Dario** | orange sparkle | Drafts the launch email, waits for my OK | The careful one |
| **Elon** | black star | Pulled in at the end, writes the X post | It's X |

The names are the joke, nothing more. The bots use Grok voices and never act like the real people. The first time the names show up, put a small caption on screen: `Bot names are a joke. Not affiliated with anyone.`

---

## Prep (the day before, about 30 min)

1. **App:** open Grok Call from `~/Applications`. The menu bar list should show Satya, Jensen, Tim, Dario and Elon. If it doesn't, quit and reopen.
2. **Apps:** **Settings → Connections**. Check that GitHub and Gmail are connected.
3. **Screen:** **Settings → This Mac → Let bots see your open windows** must be on.
4. **Mac jobs:** Grok Bot must be running on the Mac. Do one test call with Tim: "Tim, run the test suite in the Grok Call folder." Approve anything it asks, so it won't ask on camera.
5. **Test call:** with Satya, ask "What was my last commit on grok-call?" That confirms it can reach GitHub. Then hang up.
6. **Jensen's computer, about 10 minutes before recording:** click Jensen's avatar → **Open workspace → Computer → Wake up**, and wait until the desktop shows.
7. **Browser:** open Zen on a public page with a clear headline, such as Hacker News. Then switch to another app, so Zen is behind.
8. **Desk:**
   - Headphones on.
   - Turn on Do Not Disturb.
   - Plain wallpaper, Dock hidden (⌥⌘D), everything else closed.
9. **Recording:**
   - OBS with Display Capture, **macOS Audio Capture**, and the webcam as a corner bubble. ⇧⌘5 drops the bot voices.
   - Record at 1440p or 4K so you can zoom in when editing.
   - Do a 10 s test and play it back: your voice and the bots' must both be in it.
10. **Practice:** do one full practice run with the recorder off.

---

## The video

### 1 · Hook · 0:00–0:15 · me → camera

> "So basically I built a group call with my Grok bots. Not one bot, like a whole crew of them. Each one has its own computer, they all work at the same time, and I run all of it from one call, just by talking."
>
> "And yeah, I named them after the CEOs, so obviously Jensen got the computer. Let me show you."

**Edit:** on "each one has its own computer", flash 2 s of the hero shot from section 4.

### 2 · Why I built it · 0:15–0:35 · me → camera

> "So when I started, the problem was, I put two bots in a call and they'd get stuck in a loop sort of thing. They'd keep talking to each other, and I couldn't stop them or correct them in between. So I fixed that layer properly. Now when I talk, everyone stops and listens."
>
> "And then I gave them the same tools they have in the Grok app. So they're not just talking, they're actually doing the work."

### 3 · Start the call · 0:35–0:50

**Do:** menu bar → tick **Satya, Jensen, Tim, Dario** → **Start call** → **Full view**.

**Voiceover:**
> "Four bots, all real Grok bots from my account."

**Me → bots:**
> "Hey crew. Okay so we're shipping Grok Call today. Satya, you're the lead. Split the work between everyone and let's go."

**What happens:** Satya hands out jobs by name, and the others answer. The avatars turn to whoever's talking.

**Voiceover:**
> "See, they're planning it between themselves. And they actually look at whoever's talking."

### 4 · Everyone works at once · 0:50–1:25 · the hero shot

**Me → bots** (back to back; don't wait for answers):
> "Jensen, on your computer, open Hacker News and find what people are saying about voice agents."
>
> "Tim, run the test suite in the Grok Call folder on my Mac."
>
> "Dario, draft the launch email to me in Gmail. Don't send it, just draft it."
>
> "Satya, check GitHub. What was my last commit on grok-call?"

**Do:**
- Jensen's avatar → **Open workspace → Computer**.
- Dario's avatar → **Open workspace → Activity**.
- Put the two windows side by side, with the call on top.

**Voiceover:**
> "So right now, Jensen is browsing on its own Linux computer. That's live, that's its actual screen. Tim is running my tests on my Mac. Dario is writing the email. And Satya is checking GitHub. All at the same time, and I'm just talking."

**What happens:** Satya reads out the commit while Jensen's screen is still moving.

**Edit:** hold this shot. It's the one people remember. If Jensen is slow, speed up only its screen.

### 5 · Everyone stops · 1:25–1:35

**What happens:** results come in, and two bots start talking at once.

**Me → bots** (talk right over them):
> "Hold on, hold on, everyone stop."

Every bot goes quiet. Then:
> "One at a time. Jensen, you first."

**Voiceover:**
> "That's the thing I fixed. Before, they just wouldn't stop. Now I talk and everyone stops."

**If they keep going:** press **⌥Esc**.

### 6 · I take over its computer · 1:35–1:50

**What happens:** Jensen tells you what it found.

**Do:** in Jensen's **Computer** tab, click **Take control**, scroll for 2 s, then click **Stop controlling**.

**Voiceover:**
> "And if I want, I can just take control of its computer, do my thing, and give it back."

### 7 · It reads my screen · 1:50–2:05

**Me → bots:**
> "Satya, can you look at my Zen window? What's the top story there?"

**What happens:** Satya reads the Zen window that's behind and says the headline. Nothing on screen switches.

**Voiceover:**
> "That window isn't even in front. It still read it, and it didn't switch anything on my screen."

**If it can't read the page:** click that tab in Zen and say "Okay, it's ready." Cut that bit out later.

### 8 · Tim reports from my Mac · 2:05–2:15

**What happens:** Tim comes back with the test result.

**Voiceover:**
> "And Tim's back with the tests. That was running on my Mac the whole time we were talking."

**If Grok Bot asks for approval:** approve it on camera and say:
> "And nothing runs without my OK."

### 9 · Nothing goes out without me · 2:15–2:30

**Do:** Dario's **Activity** → **Review draft…** → change one word in the subject → **Discard draft**.

**Voiceover:**
> "Dario wrote the email, but it doesn't send anything on its own. I review it, change what I want, and then I decide."

**Edit:** blur your email address.

### 10 · A bot calls in a bot · 2:30–2:45

**Me → bots:**
> "Satya, pull Elon into the call and let it write the X post."

**What happens:** a fifth avatar joins. It already knows what was said, and it reads out a post.

**Voiceover:**
> "I didn't add that one. Satya pulled it in by itself. And who else is gonna write the X post, right? It already knows everything we talked about."

**If Satya doesn't do it:** **Add a bot (+) → Elon**. Leave this version out of the short cut.

### 11 · Hang up · 2:45–2:55

**Me → bots:**
> "Okay that's it, good work everyone."

**Do:** click the red **Leave call**, then menu bar → **Settings → Past calls**.

**Voiceover:**
> "And when I hang up, it writes the notes, who did what, so the next call starts from there."

### 12 · Close · 2:55–3:10 · me → camera

> "So yeah, that's Grok Call. One call, a full crew of bots, each with its own computer, and I'm managing all of it from one place, just by talking. Native Mac app, built it end to end. Code's on my GitHub. If you're building with Grok, I'd love to talk."

**End card (3 s):** `Grok Call · built by Shashank · shashankdev03.me · github.com/shashank03-dev/grok-call`

---

## 90 s cut for X

1. Hook: the first sentence, plus the 2 s hero flash
2. Why: "the bots got stuck in a loop and wouldn't listen. So I fixed that, and gave them real tools."
3. Start call (no voiceover)
4. The four orders plus the hero shot
5. "Hold on, everyone stop"
6. Take control
7. Satya pulls in Elon
8. Close: the first sentence, then the end card

Cut every wait, retry and Settings screen.

## On-screen captions

Burn in subtitles for you and the bots; most people watch muted. Labels:

- `Bot names are a joke. Not affiliated with anyone.` (first time the names appear)
- `4 bots. 3 computers. 1 call.`
- `I talk, they all stop.`
- `Its real Linux computer, live`
- `Nothing goes out without my OK`
- `Bots can pull in other bots`

## Before posting

- [ ] Everything said on camera really happened in this take. If a part didn't work, cut it and its line.
- [ ] Nothing private on screen: email addresses (blurred), notifications, tokens, other repos.
- [ ] The bot voices are in the export, not just mine.
- [ ] The commit and test results read out are the real ones.

## If something goes wrong mid-take

| Problem | What to do |
|---|---|
| Jensen's computer is asleep | Wake it before you record; cut any wait |
| Bots loop or talk over each other | "Hold on, everyone stop", or **⌥Esc**. It's a good moment anyway |
| Tim waits for approval | Approve on camera: "nothing runs without my OK" |
| Satya can't read Zen | Click that tab, then say "Okay, it's ready" |
| A bot does the wrong thing | Correct it by voice: "No Jensen, I said Hacker News." Correcting them live is part of the demo |
| Something just fails | Skip it. Don't fake it |

---

## Cue card (keep this next to the camera)

```
1  CAMERA   Group call with my Grok bots. Whole crew. Own computers.
            All at once. Just talking. Named after CEOs, Jensen got the computer.
2  CAMERA   Started: bots stuck in a loop, wouldn't listen. Fixed that layer.
            Gave them the Grok app's tools. They do the work.
3  CLICK    Satya Jensen Tim Dario → Start call → Full view
   BOTS     "Hey crew, shipping Grok Call today. Satya, lead. Split it and go."
4  BOTS     Jensen: Hacker News, voice agents, on your computer
            Tim: test suite, Grok Call folder, my Mac
            Dario: launch email draft in Gmail, don't send
            Satya: GitHub, last commit on grok-call
   CLICK    Jensen → Open workspace → Computer | Dario → Activity | side by side
5  BOTS     "Hold on, hold on, everyone stop." → "One at a time. Jensen first."
6  CLICK    Take control → scroll → Stop controlling
7  BOTS     "Satya, look at my Zen window. Top story?"
8  WAIT     Tim's test result
9  CLICK    Dario → Review draft… → edit subject → Discard draft
10 BOTS     "Satya, pull Elon in, let it write the X post."
11 BOTS     "Okay that's it, good work everyone." → Leave call → Past calls
12 CAMERA   One call, full crew, own computers, one place, just talking.
            Native Mac app, end to end. Code's on my GitHub. Let's talk.
```
