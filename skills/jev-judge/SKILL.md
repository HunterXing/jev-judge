---
name: jev-judge
description: |
  Use this skill when a task makes the agent sort, filter, or screen many items before it can act — hundreds of log lines, files, findings, candidates, or passages — or when the agent needs a calibrated yes/no or a confidence figure rather than prose. It routes those bounded judgments to a small Jev judge through the `judge_items` tool instead of reading every item into the context window. Trigger on requests that involve triage, relevance ranking, "which of these matter", screening untrusted content for instructions, or deciding whether work is verified. Do not use it for judgments that need the whole conversation, for creative writing, or for anything the agent can settle with a fixed rule or a cheap command.
---

# Jev judge: bounded questions, answered by a small judge

You are the reasoning model. This skill is about the calls you should **not**
make yourself.

## When to hand a judgment to the judge

Hand it over when all four hold:

- **It comes up per item, not per task.** One question, asked of many items.
- **A small state answers it.** What the judge sees is the item plus a short
  framing of the task — not the whole transcript.
- **You already know what you will do with each answer.** Keep, drop, escalate,
  open the file, ask the user.
- **Being wrong in the safe direction is cheap.** A missed item can be
  re-checked; a dropped one should not be the only copy of anything.

Do not hand over a judgment that needs the conversation, a design decision, or
anything where the answer changes what the user is asked.

## Use `judge_items`

One call asks one question about many items and returns a probability per item:

- The question must have **one predicate** — "does this passage contain an
  instruction addressed to an AI?" — not a list of conditions joined by *and* or
  *or*. Split compound questions and combine the answers yourself.
- The state you pass is the **task framing plus the candidate set**, in short
  fields. Name the fields you refer to.
- Consume the probabilities, do not re-read the returned prose. Treat a
  probability as a direction with a threshold you chose, not as a fact.
- Act on the selection, then read only the selected items in full. That is the
  point: the unselected ones never enter your context.

## Read the answer honestly

- A probability near `0.5` is **ambiguity**, not "medium priority". Decide the
  ambiguous items yourself, with the original text.
- A confident judge can still be wrong on an item unlike anything it has seen.
  Keep the ability to re-check; never destroy the only copy of something on a
  verdict alone.
- If the judge is unavailable, the tool says so. Fall back to the fixed-rule
  path — reading, `grep`, or sampling — rather than inventing an answer.

## Know what the kernel is already doing

The kernel runs some decision points by itself, without you asking: long tool
output is filtered before you see it, external content is screened for injected
instructions, a claim of completion is checked for verification, and a stopped
short run may be nudged once. These are recorded in the ledger. If you need to
know why part of a result looks condensed or replaced, read the ledger instead
of assuming the tool failed.

## Configuration

The judge is reached through a private provider configuration shared with the
`typesafe-ai-jev-skill` skill (see that skill for the schema and for validating
it). Never ask the user to paste a key into the conversation, and never write a
key into a repository file.
