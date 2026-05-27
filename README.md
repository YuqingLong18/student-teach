# TeachLab Classroom Prototype

This is a browser prototype plus a small dependency-free Node backend for the classroom AI dialogue platform. The backend owns classroom codes, teacher configuration, student sessions, chat state, arena submissions, and teacher monitoring summaries.

## Current Flow

- Teacher logs in by name and can reopen classrooms owned by that teacher.
- Teacher opens a classroom instance and receives a classroom code.
- The teacher browser receives a private session token for monitoring and configuration.
- Teacher configures the class title, peer AI behavior, challenge level, teaching objectives, and arena problems.
- Teacher can lock or unlock new student joins for an active classroom.
- Teacher can close or resume student activity while keeping monitoring available.
- Arena problem lines support `problem | keywords | answer key | rubric`; the answer key and rubric are optional and are hidden from students.
- Student joins with the classroom code.
- The student browser receives a private session token for its own chat and arena workspace.
- Student teaches a peer LLM through one chat thread.
- The peer asks follow-up questions against uncovered objectives.
- Peer challenge can be set to gentle scaffolding, balanced questions, or rigorous challenge.
- Student can run a readiness check where the peer summarizes what it thinks it understands before the arena.
- Student submits the peer LLM to the arena, where it uses the chat thread as context and attempts the problems from what the student taught it.
- Arena scoring highlights missing concepts so the student can keep coaching and resubmit.
- Failed arena submissions move the student workspace into a coaching phase with missing concepts and correction-turn tracking.
- Teacher dashboard monitors class-level analytics, readiness-check summaries, active students, teaching turns, objective-by-objective coverage, coaching activity, readiness-check history, full transcripts, arena history, latest arena score, and a live top-5 leaderboard.
- Teacher can filter the monitor by all students, readiness gaps, coaching needs, or ranked students.
- Classroom data is persisted to `data/classrooms.json` by the local server.
- Student API responses include teaching objectives, arena problem prompts, leaderboard entries, and that student's own record, not teacher prompts, answer keys, rubrics, or the full monitoring roster.
- Teacher and student browser sessions are saved locally so a refresh can resume the active classroom.
- Teacher can sign out and students can leave the local session without deleting classroom data.

## Run

Run the local server:

```bash
npm start
```

Then visit `http://localhost:4173`.

You can change the port with:

```bash
PORT=4174 npm start
```

## OpenRouter Provider

By default the app uses a local simulator so the full classroom flow works without external credentials.

To use a real OpenRouter peer model:

```bash
OPENROUTER_API_KEY=your_key_here npm start
```

Optional model override:

```bash
OPENROUTER_API_KEY=your_key_here OPENROUTER_MODEL=openai/gpt-4o-mini OPENROUTER_JUDGE_MODEL=openai/gpt-4o-mini npm start
```

You can also put those values in a local `.env` file:

```bash
OPENROUTER_API_KEY=your_key_here
OPENROUTER_MODEL=openai/gpt-4o-mini
OPENROUTER_JUDGE_MODEL=openai/gpt-4o-mini
```

When `OPENROUTER_API_KEY` is present, peer chat replies, readiness checks, arena answers, and arena answer judging are generated through OpenRouter's chat completions API. The judge model must answer each arena grading request with only `correct` or `incorrect`; if `OPENROUTER_JUDGE_MODEL` is not set, the app uses `OPENROUTER_MODEL` for judging too. Without `OPENROUTER_API_KEY`, the server falls back to deterministic local peer behavior.

## Important Next Steps

- Replace prototype name-based teacher login with password or SSO authentication.
- Replace browser-stored prototype session tokens with a proper login system.
- Replace the JSON file with a production database and durable classroom/session records.
- Add streaming responses, retries, rate limits, and per-classroom model settings for the LLM provider.
- Add classroom roster management and per-student privacy controls.
