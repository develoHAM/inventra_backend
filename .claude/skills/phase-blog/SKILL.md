---
name: phase-blog
description: Generate a bilingual (English + Korean) Medium-style retrospective blog post for a completed project phase, for the user's portfolio website. Use when the user finishes a phase of the Inventra project (or says "write the blog for this phase", "phase blog", "blog this phase"). Produces two files (EN + KR) with a catchy title and the date underscore-separated.
---

# Phase Blog Generator

Generate a polished, portfolio-quality Medium-style blog post documenting a completed project phase, in **two languages** (English + Korean).

## When to use
- The user has completed a project phase and wants to document it for their portfolio.
- The user invokes `/phase-blog` or asks to "blog this phase".
- Proactively: when a phase is verified complete, offer to run this.

## Inputs to gather (from the conversation, don't over-ask)
- Which phase (number + name).
- The architectural decisions made during the phase.
- The questions the user asked while implementing (these become the TIL section).
- The NestJS concepts and third-party libraries used.

Reconstruct these from the session history and the phase's spec/design doc. Only ask the user if genuinely missing.

## Output

Two files, same base name, in language folders:
- `blog/en/<Catchy-Title-Kebab>_<YYYY-MM-DD>.md`
- `blog/ko/<Catchy-Title-Kebab>_<YYYY-MM-DD>.md`

The filename uses an **underscore `_`** to separate the title from the date, as requested.

## Required structure (both languages)

1. **Catchy Medium-style H1 title** + a one-line hook subtitle + the date.
2. **Intro** — what the project is, what this phase set out to do (2–4 sentences).
3. **Architectural Decisions** — for EACH crucial decision, cover:
   - **The goal** — what were we trying to achieve?
   - **The options** — which alternatives did we have?
   - **The choice** — which did we pick?
   - **The reason** — why that one over the others?
   - **The result** — what did choosing it get us?
4. **TIL (Today I Learned)** — the real questions the user asked during the phase, each with a clear, concise answer. Written in an honest "here's something that confused me and what I learned" voice.
5. **NestJS Concepts & Libraries** — each concept/library used, with a one-line "why we used it".
6. **Wrap-up** — what the phase delivered + a teaser for the next phase.

## Style
- Medium/dev-blog voice: first person, confident but humble, concrete.
- Use code snippets and small tables where they clarify.
- Portfolio-quality: the reader should come away thinking the author understands *why*, not just *what*.
- Korean version: natural technical Korean (개발 블로그 톤), not a stiff machine translation. Keep code/library names in English; translate prose. Mirror the same structure and content as the English version.

## After writing
- Tell the user both file paths.
- Offer to commit them.
- Remind the user this can be re-run each phase via `/phase-blog`.
