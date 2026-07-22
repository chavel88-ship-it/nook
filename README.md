# Nook

**AI Builders Challenge — July 2026: Reimagine Creative Industries with AI**
Built with IBM Bob

## The problem I'm solving

If you run a small business or freelance, you usually know *what* you want to say, but turning that into an actual post or piece of content is where things get stuck. Most AI writing tools don't really help here — you type one prompt, get one result, and if it's not quite right you're back to square one. There's no back-and-forth, nothing that remembers your brand voice, and no way to see a few different directions before picking one.

## What I built

Nook is a chatbot that gives you a quiet, guided space to actually think through your content instead of just spitting out one answer:

1. **It asks you a few questions first** — what's your business, who's the audience, what's the goal, what tone do you want, which platform is this for. No need to write the "perfect prompt" yourself.
2. **It gives you options, not just one answer** — based on what you told it, it comes back with 3-5 different content directions so you can actually compare and choose.
3. **You can refine it** — pick a direction and tell it what to change ("make it punchier," "shorter," "add a call to action"), and it adjusts.
4. **It remembers your brand voice** — once you've set the tone in the intake, it keeps using that for the rest of the session so you're not repeating yourself.
5. **You get a finished package** — post copy, hashtag ideas, and a short description of what the visual should look like, all formatted for the platform you picked.

I built it this way on purpose. The challenge brief is clear it's not looking for basic prompt-in-text-out tools or static generators with no personalization — so the whole point of this project is the workflow and the back-and-forth, not just "AI writes a caption."

## Why "Nook"

A nook is a small, quiet corner — somewhere you go to actually think something through. That's the idea: not another AI tool shouting content at you, but a small space where you work out what you actually want to say.

## How it fits the challenge

- **Theme:** Reimagine Creative Industries with AI
- **Solution areas it touches:** AI Creative Partners, Storytelling & Content Creation, Interactive & Personalized Experiences
- **Why it fits:** it's built to work *with* the user as a creative partner — helping them explore and refine ideas rather than just handing over one generated result and calling it done.

## How it works under the hood

```
User
  │
  ▼
Intake — collects business type, audience, goal, tone, platform
  │
  ▼
Session memory — stores brand voice & preferences for later steps
  │
  ▼
Ideation — LLM generates 3-5 different content directions
  │
  ▼
Refinement loop — user picks/edits, LLM adjusts using what it remembers
  │
  ▼
Final output — post copy + hashtags + visual concept description
```

**Tech choices, and why:**

- **watsonx / Granite** for the actual generation (ideation + refinement) — wanted to make sure IBM's AI tech is doing real work here, not just along for the ride
- **Python** for the backend logic — handling intake, session state, and the prompts. Skipped LangChain/LangFlow on purpose; the workflow isn't complex enough to need a framework, and keeping it simple meant more time to actually build and polish rather than fight tooling
- **Plain HTML/JS** for the frontend — kept it simple so I could focus on the actual functionality instead of frontend polish
- **In-memory session state** — no database needed for a prototype like this; it just needs to hold onto brand voice/preferences for the length of a session

## IBM Bob's role in building this

Used IBM Bob as my main dev tool throughout:
- **Plan mode** to turn my spec into an actual implementation plan
- **Code mode** to scaffold the intake flow, ideation logic, and refinement loop
- **Advanced mode** for [fill in once built — e.g. debugging the prompt chain]

## Running it locally

```bash
git clone <repo-url>
cd nook

pip install -r requirements.txt

export WATSONX_API_KEY=your_key_here
export WATSONX_PROJECT_ID=your_project_id_here

python app.py
```

## Demo video

[link — max 3 minutes]

## Who built this

William [Surname] — IT Support Engineer, solo build

## IBM SkillsBuild certificate

[attach/link here]
