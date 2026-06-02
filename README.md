# TeachLab Classroom Prototype

This is a browser prototype plus a small dependency-free Node backend for the classroom AI dialogue platform. The backend owns classroom codes, teacher configuration, student sessions, chat state, arena submissions, and teacher monitoring summaries.

## Current Flow

- Teacher logs in by name and can reopen classrooms owned by that teacher.
- Teacher opens a classroom instance and receives a classroom code.
- The teacher browser receives a private session token for monitoring and configuration.
- Teacher configures the class title, peer AI behavior, challenge level, teaching objectives, arena problems, and a matching line-by-line Keys field.
- Teacher can lock or unlock new student joins for an active classroom.
- Teacher can close or resume student activity while keeping monitoring available.
- Arena problem lines support `problem | keywords | rubric`; hidden answer keys are entered separately in `Keys`, one key per problem.
- Student joins with the classroom code.
- Guest joins with a display name, the classroom code, and invitation code `AIED2026`.
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
- Teacher, student, and guest browser sessions are saved locally so a refresh can resume the active classroom.
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

## Microsoft SSO

For deployment, student-teach uses the shared THIS Nexus Microsoft sign-in, matching the Incident app. The main site owns the Microsoft client and callback. Configure student-teach with the shared auth service values:

```bash
NEXT_PUBLIC_AUTH_BASE_URL=https://thisnexus.cn
AUTH_BASE_URL=https://thisnexus.cn
AUTH_SERVICE_BASE_URL=https://thisnexus.cn
AUTH_COOKIE_NAME=thisnexus_session
AUTH_COOKIE_DOMAIN=.thisnexus.cn
```

Sign-in redirects to `https://thisnexus.cn/api/auth/microsoft?returnTo=https://student-teach.thisnexus.cn/...`, then the app reads the shared `thisnexus_session` cookie. The app classifies Microsoft accounts with any digit in the email address as students; email addresses without digits are teachers. Auth cookies are scoped to `.thisnexus.cn` so sign-on can be shared across `thisnexus.cn` subdomains.

When Microsoft SSO variables are not set, the app keeps the local prototype login behavior for development and tests.

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

## Polynomial Simulation

With the server running and `OPENROUTER_API_KEY` configured, run the real-LLM polynomial classroom simulation:

```bash
npm run simulate:polynomials
```

The script creates a classroom, joins 10 simulated students concurrently, coaches the peer LLM with varied instruction quality, submits arena attempts, and writes markdown/JSON reports under `reports/`. It fails if the server is using the local simulator unless `SIM_ALLOW_SIMULATOR=true` is set.

## Important Next Steps

- Replace prototype name-based teacher login with password or SSO authentication.
- Replace browser-stored prototype session tokens with a proper login system.
- Replace the JSON file with a production database and durable classroom/session records.
- Add streaming responses, retries, rate limits, and per-classroom model settings for the LLM provider.
- Add classroom roster management and per-student privacy controls.
