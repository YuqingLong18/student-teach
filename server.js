const http = require("node:http");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

loadEnvFile(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 4173);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "classrooms.json");
const DATA_DIR = path.dirname(DATA_FILE);
const PUBLIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/app.js", "app.js"],
]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
const OPENROUTER_JUDGE_MODEL = process.env.OPENROUTER_JUDGE_MODEL || OPENROUTER_MODEL;
const OPENROUTER_API_URL = process.env.OPENROUTER_API_URL || "https://openrouter.ai/api/v1/chat/completions";
const STUDENT_TEACH_BASE_URL = process.env.STUDENT_TEACH_BASE_URL || process.env.PUBLIC_BASE_URL || "https://student-teach.thisnexus.cn";
const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "thisnexus_session";
const AUTH_FLOW_COOKIE_NAME = process.env.AUTH_FLOW_COOKIE_NAME || "thisnexus_auth_flow";
const AUTH_BASE_URL = process.env.AUTH_BASE_URL || process.env.NEXT_PUBLIC_AUTH_BASE_URL || "";
const AUTH_SERVICE_BASE_URL = process.env.AUTH_SERVICE_BASE_URL || AUTH_BASE_URL;
const AUTH_SESSION_SECRET =
  process.env.AUTH_SESSION_SECRET || (process.env.NODE_ENV === "production" ? "" : "local-dev-secret-change-me");
const AUTH_COOKIE_DOMAIN = process.env.AUTH_COOKIE_DOMAIN || (AUTH_BASE_URL.includes("thisnexus.cn") ? ".thisnexus.cn" : undefined);
const AUTH_COOKIE_SECURE =
  (process.env.AUTH_COOKIE_SECURE || "").toLowerCase() === "true" || AUTH_BASE_URL.startsWith("https://");
const PEER_CHALLENGE_LEVELS = new Set(["gentle", "balanced", "rigorous"]);
const GUEST_INVITE_CODE = process.env.GUEST_INVITE_CODE || "AIED2026";

let store = { teachers: {}, classrooms: {} };
let lastTimestamp = 0;
let saveQueue = Promise.resolve();
const activeArenaAttempts = new Set();

function loadEnvFile(filePath) {
  if (!fsSync.existsSync(filePath)) return;

  const lines = fsSync.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    process.env[key] = rawValue.replace(/^(['"])(.*)\1$/, "$2");
  }
}

async function loadData() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    store = normalizeStore(JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    store = { teachers: {}, classrooms: {} };
  }

  if (ensureSessionTokens()) {
    await saveData();
  }
}

async function saveData() {
  const write = saveQueue.catch(() => {}).then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2));
  });
  saveQueue = write;
  return write;
}

function normalizeStore(data) {
  if (data?.classrooms && data?.teachers) return data;
  return {
    teachers: {},
    classrooms: data && typeof data === "object" ? data : {},
  };
}

function jsonResponse(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function textResponse(response, status, message) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}

function redirectResponse(response, location) {
  response.writeHead(302, { Location: location });
  response.end();
}

async function parseJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`${field} is required.`);
    error.statusCode = 400;
    throw error;
  }
  return value.trim();
}

function normalizeLines(value, field) {
  const lines = Array.isArray(value)
    ? value.map((line) => String(line).trim()).filter(Boolean)
    : String(value || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

  if (!lines.length) {
    const error = new Error(`${field} must include at least one item.`);
    error.statusCode = 400;
    throw error;
  }
  return lines;
}

function normalizeQuestions(value) {
  const questions = Array.isArray(value)
    ? value
    : String(value || "")
        .split("\n")
        .map((line, index) => {
          const [prompt, keywords = "", expectedAnswer = "", rubric = ""] = line.split("|").map((part) => part.trim());
          return {
            id: `q-${index + 1}`,
            prompt,
            expectedAnswer,
            rubric,
            keywords: keywords
              .split(",")
              .map((keyword) => keyword.trim().toLowerCase())
              .filter(Boolean),
          };
        });

  const normalized = questions
    .map((question, index) => ({
      id: question.id || `q-${index + 1}`,
      prompt: String(question.prompt || "").trim(),
      expectedAnswer: String(question.expectedAnswer || "").trim(),
      rubric: String(question.rubric || "").trim(),
      keywords: Array.isArray(question.keywords)
        ? question.keywords.map((keyword) => String(keyword).trim().toLowerCase()).filter(Boolean)
        : String(question.keywords || "")
            .split(",")
            .map((keyword) => keyword.trim().toLowerCase())
            .filter(Boolean),
    }))
    .filter((question) => question.prompt);

  if (!normalized.length) {
    const error = new Error("testQuestions must include at least one question.");
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function normalizeAnswerKeys(value, questionCount) {
  if (value === undefined || value === null || value === "") return null;

  const keys = Array.isArray(value)
    ? value.map((line) => String(line).trim())
    : String(value)
        .split("\n")
        .map((line) => line.trim());

  if (keys.length !== questionCount || keys.some((key) => !key)) {
    const error = new Error(`answerKeys must include exactly ${questionCount} non-empty item${questionCount === 1 ? "" : "s"}.`);
    error.statusCode = 400;
    throw error;
  }

  return keys;
}

function applyAnswerKeys(questions, answerKeys) {
  const keys = normalizeAnswerKeys(answerKeys, questions.length);
  if (!keys) return questions;
  return questions.map((question, index) => ({
    ...question,
    expectedAnswer: keys[index],
  }));
}

function normalizePeerChallenge(value) {
  const level = String(value || "balanced")
    .trim()
    .toLowerCase();
  if (PEER_CHALLENGE_LEVELS.has(level)) return level;

  const error = new Error("peerChallenge must be gentle, balanced, or rigorous.");
  error.statusCode = 400;
  throw error;
}

function authEnabled() {
  return Boolean(AUTH_BASE_URL || AUTH_SERVICE_BASE_URL || process.env.AUTH_COOKIE_NAME);
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  const padded = padding ? normalized + "=".repeat(4 - padding) : normalized;
  return Buffer.from(padded, "base64").toString("utf8");
}

function signValue(value) {
  if (!AUTH_SESSION_SECRET) {
    throw new Error("AUTH_SESSION_SECRET is required");
  }
  return base64UrlEncode(crypto.createHmac("sha256", AUTH_SESSION_SECRET).update(value).digest());
}

function verifySignedCookie(value) {
  if (!value || !value.includes(".")) return null;
  const [body, signature] = value.split(".");
  const expected = signValue(body);
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(body));
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function normalizeRedirectPath(value) {
  if (!value || typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function parseCookies(request) {
  const cookies = {};
  const header = request.headers.cookie || "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (!name || !rest.length) continue;
    cookies[name] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

function cookieHeader(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.secure !== false) parts.push("Secure");
  return parts.join("; ");
}

function clearCookieHeader(name) {
  return cookieHeader(name, "", {
    maxAge: 0,
    domain: AUTH_COOKIE_DOMAIN,
    secure: AUTH_COOKIE_SECURE,
  });
}

function buildReturnToUrl(path = "/") {
  return new URL(normalizeRedirectPath(path), STUDENT_TEACH_BASE_URL).toString();
}

function buildMicrosoftLoginUrl(path = "/") {
  const url = new URL("/api/auth/microsoft", AUTH_SERVICE_BASE_URL || AUTH_BASE_URL);
  url.searchParams.set("returnTo", buildReturnToUrl(path));
  return url.toString();
}

function roleForEmail(email) {
  return /\d/.test(email) ? "student" : "teacher";
}

function resolveAuthSession(rawSession) {
  if (!rawSession) return null;
  const email = String(rawSession.email || rawSession.preferred_username || rawSession.username || "").toLowerCase().trim();
  if (!email) return null;
  return {
    email,
    name: String(rawSession.name || rawSession.username || email).trim() || email,
    role: rawSession.role || roleForEmail(email),
    authMethod: rawSession.authMethod || "microsoft",
  };
}

function authSessionFromRequest(request) {
  return resolveAuthSession(verifySignedCookie(parseCookies(request)[AUTH_COOKIE_NAME]));
}

function getOrCreateTeacherFromAuth(user) {
  const id = teacherIdForName(user.email);
  const existing = store.teachers[id];
  if (!existing) {
    store.teachers[id] = {
      id,
      name: user.name || user.email,
      email: user.email,
      sessionToken: crypto.randomUUID(),
      createdAt: now(),
      updatedAt: now(),
    };
  } else {
    existing.name = user.name || existing.name || user.email;
    existing.email = user.email;
    existing.updatedAt = now();
  }
  return store.teachers[id];
}

function publicAuthUser(session) {
  if (!session) return null;
  const user = {
    email: session.email,
    name: session.name,
    role: session.role,
  };
  if (session.role === "teacher" && session.teacherId && store.teachers[session.teacherId]) {
    user.teacher = publicTeacher(store.teachers[session.teacherId]);
  }
  return user;
}

function generateCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (store.classrooms[code]);
  return code;
}

function now() {
  const time = Date.now();
  const nextTime = time <= lastTimestamp ? lastTimestamp + 1 : time;
  lastTimestamp = nextTime;
  return new Date(nextTime).toISOString();
}

function ensureSessionTokens() {
  let changed = false;
  for (const room of Object.values(store.classrooms)) {
    if (!PEER_CHALLENGE_LEVELS.has(room.peerChallenge)) {
      room.peerChallenge = "balanced";
      changed = true;
    }

    if (typeof room.joinLocked !== "boolean") {
      room.joinLocked = false;
      changed = true;
    }

    if (typeof room.activityClosed !== "boolean") {
      room.activityClosed = false;
      changed = true;
    }

    if (!room.teacherToken) {
      room.teacherToken = crypto.randomUUID();
      changed = true;
    }

    for (const student of Object.values(room.students || {})) {
      if (!Array.isArray(student.readinessChecks)) {
        student.readinessChecks = [];
        changed = true;
      }

      if (!student.studentToken) {
        student.studentToken = crypto.randomUUID();
        changed = true;
      }
    }
  }
  return changed;
}

function teacherIdForName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "teacher";
}

function getOrCreateTeacher(name) {
  const normalizedName = requireString(name, "teacherName");
  const idBase = teacherIdForName(normalizedName);
  let id = idBase;
  let suffix = 2;

  while (store.teachers[id] && store.teachers[id].name.toLowerCase() !== normalizedName.toLowerCase()) {
    id = `${idBase}-${suffix}`;
    suffix += 1;
  }

  if (!store.teachers[id]) {
    store.teachers[id] = {
      id,
      name: normalizedName,
      sessionToken: crypto.randomUUID(),
      createdAt: now(),
      updatedAt: now(),
    };
  } else {
    store.teachers[id].name = normalizedName;
    store.teachers[id].sessionToken = crypto.randomUUID();
    store.teachers[id].updatedAt = now();
  }

  return store.teachers[id];
}

function publicTeacher(teacher) {
  return {
    id: teacher.id,
    name: teacher.name,
    createdAt: teacher.createdAt,
    updatedAt: teacher.updatedAt,
  };
}

function requireTeacherSession(request) {
  if (authEnabled()) {
    const session = authSessionFromRequest(request);
    if (session?.role === "teacher") {
      return session.teacherId && store.teachers[session.teacherId] ? store.teachers[session.teacherId] : getOrCreateTeacherFromAuth(session);
    }

    const error = new Error("Teacher Microsoft sign-in is required.");
    error.statusCode = 401;
    throw error;
  }

  const teacherId = request.headers["x-teacher-id"];
  const token = request.headers["x-teacher-session"];
  const teacher = teacherId ? store.teachers[teacherId] : null;
  if (!teacher || teacher.sessionToken !== token) {
    const error = new Error("Teacher login is required.");
    error.statusCode = 401;
    throw error;
  }
  return teacher;
}

function buildVocabulary(messages) {
  return messages
    .filter((message) => message.sender === "student")
    .map((message) => message.text.toLowerCase())
    .join(" ");
}

function peerProviderStatus() {
  return {
    mode: OPENROUTER_API_KEY ? "openrouter" : "simulator",
    model: OPENROUTER_API_KEY ? OPENROUTER_MODEL : "local-simulator",
  };
}

function conversationTranscript(student) {
  return student.messages
    .filter((message) => message.sender === "student" || message.sender === "peer" || message.sender === "system")
    .slice(-12)
    .map((message) => {
      if (message.sender === "student") return `Student teacher: ${message.text}`;
      if (message.sender === "peer") return `Peer LLM: ${message.text}`;
      return `Arena feedback: ${message.text}`;
    })
    .join("\n");
}

function teachingTranscript(student) {
  return student.messages
    .filter((message) => message.sender === "student")
    .map((message) => `Student teacher: ${message.text}`)
    .join("\n");
}

function objectiveCoverage(room, student) {
  const progress = objectiveProgress(room, student);
  if (!progress.length) return 0;
  const covered = progress.filter((objective) => objective.covered).length;
  return Math.round((covered / progress.length) * 100);
}

function objectiveTerms(objective) {
  return objective
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 4)
    .filter((term, index, terms) => terms.indexOf(term) === index);
}

function objectiveProgress(room, student) {
  const taughtText = buildVocabulary(student.messages);
  return room.objectives.map((objective, index) => {
    const terms = objectiveTerms(objective);
    const matchedTerms = terms.filter((term) => taughtText.includes(term));
    return {
      id: `objective-${index + 1}`,
      text: objective,
      covered: terms.length ? matchedTerms.length > 0 : taughtText.includes(objective.toLowerCase()),
      matchedTerms,
      missingTerms: terms.filter((term) => !matchedTerms.includes(term)),
    };
  });
}

function latestAttempt(student) {
  return student.testAttempts.at(-1) || null;
}

function latestMissingConcepts(student) {
  const attempt = latestAttempt(student);
  if (!attempt) return [];

  return attempt.results
    .flatMap((result) => result.missingWords || [])
    .filter((word, index, words) => words.indexOf(word) === index);
}

function latestAttemptNeedsCorrection(student) {
  const attempt = latestAttempt(student);
  return Boolean(attempt?.results.some((result) => !result.correct));
}

function correctionTurnsAfterLatestAttempt(student) {
  const attempt = latestAttempt(student);
  if (!attempt) return 0;
  const attemptTime = new Date(attempt.createdAt).getTime();
  return student.messages.filter((message) => {
    return message.sender === "student" && new Date(message.createdAt).getTime() > attemptTime;
  }).length;
}

function choosePeerQuestion(room, student) {
  const challenge = room.peerChallenge || "balanced";
  const missingConcepts = latestMissingConcepts(student);
  if (missingConcepts.length && latestAttemptNeedsCorrection(student)) {
    if (challenge === "gentle") {
      return `I see I missed ${missingConcepts.join(", ")} in the arena. Can you walk me through that idea again with one simple example?`;
    }
    if (challenge === "rigorous") {
      return `I missed ${missingConcepts.join(", ")} in the arena. Can you identify exactly where my reasoning broke, correct it, and then make me explain the idea back without hints?`;
    }
    return `I see I missed ${missingConcepts.join(", ")} in the arena. Can you correct my misunderstanding and then ask me to explain that part back in my own words?`;
  }

  const taughtText = buildVocabulary(student.messages);
  const objective = room.objectives.find((item) => {
    const terms = item
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 4);
    return !terms.some((term) => taughtText.includes(term));
  });

  if (objective) {
    if (challenge === "gentle") {
      return `I am still unsure about "${objective}". Can you explain it again with a small everyday example?`;
    }
    if (challenge === "rigorous") {
      return `I am not convinced I understand "${objective}" yet. Can you prove it with an example, name a common misconception, and ask me a check question?`;
    }
    return `I can follow part of that, but I am still shaky on "${objective}". Can you teach it again using a concrete example and then ask me to explain it back?`;
  }

  const promptsByChallenge = {
    gentle: [
      "Can you give me one more example before I try to explain it back?",
      "Can you ask me a short checking question so I can see what I remember?",
      "Can you show how this connects to one other idea from class?",
    ],
    balanced: [
      "Can you ask me a checking question so you can see whether I really understand?",
      "What is a common mistake someone might make here, and how would you correct me if I made it?",
      "Can you connect this to another objective so I understand how the ideas fit together?",
    ],
    rigorous: [
      "Can you give me a tricky checking question that would reveal whether I only memorized the words?",
      "What counterexample or edge case would check whether I really understand this?",
      "Can you make me compare two objectives and explain the causal link between them?",
    ],
  };
  const prompts = promptsByChallenge[challenge] || promptsByChallenge.balanced;
  return prompts[student.messages.length % prompts.length];
}

function peerChallengeInstruction(level) {
  const instructions = {
    gentle: "Challenge level: gentle. Ask supportive, scaffolded questions and request one concrete example at a time.",
    balanced:
      "Challenge level: balanced. Ask detailed follow-up questions that reveal gaps without overwhelming the student teacher.",
    rigorous:
      "Challenge level: rigorous. Be skeptical, ask for evidence, misconceptions, edge cases, and explanation-back checks.",
  };
  return instructions[level] || instructions.balanced;
}

function mathFormattingInstruction() {
  return "When writing math, use LaTeX delimiters for display: inline math as \\( ... \\) and larger formulas as \\[ ... \\]. Avoid plain-text caret notation when LaTeX is clearer.";
}

function extractChatText(payload) {
  const text = String(payload.choices?.[0]?.message?.content || "").trim();
  if (!text) {
    throw new Error("The LLM provider returned no text.");
  }
  return text;
}

async function callOpenRouter({ system, user, maxOutputTokens = 180, model = OPENROUTER_MODEL, temperature }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: maxOutputTokens,
  };

  if (temperature !== undefined) {
    body.temperature = temperature;
  }

  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error?.message || `OpenRouter request failed with ${response.status}.`);
    }
    return extractChatText(payload);
  } finally {
    clearTimeout(timeout);
  }
}

function parseJudgeDecision(text) {
  const normalized = text.toLowerCase().trim();
  const compact = normalized.replace(/[^a-z]/g, "");

  if (compact === "correct") return true;
  if (compact === "incorrect") return false;
  if (/\bincorrect\b/.test(normalized)) return false;
  if (/\bcorrect\b/.test(normalized)) return true;
  return false;
}

function extractFinalAnswer(answer) {
  const match = String(answer || "").match(/(?:^|\n)\s*final answer\s*:\s*(.+?)\s*$/i);
  if (!match) return "";
  return match[1].trim();
}

function isNotSureFinalAnswer(finalAnswer) {
  return /^not sure what to do\.?$/i.test(finalAnswer.trim());
}

async function judgeArenaAnswer(question, answer) {
  const finalAnswer = extractFinalAnswer(answer);
  if (!finalAnswer || isNotSureFinalAnswer(finalAnswer)) return false;

  const decision = await callOpenRouter({
    model: OPENROUTER_JUDGE_MODEL,
    temperature: 0,
    maxOutputTokens: 4,
    system: [
      "You are a strict classroom answer judge.",
      "Grade only whether the peer response leads to the teacher answer key.",
      "Mark correct if the peer's final answer is equivalent to the key, allowing harmless wording or notation differences.",
      "Mark incorrect if the final answer is wrong, incomplete, not supported by the peer's reasoning, or not actually an answer to the problem.",
      "Reply with exactly one lowercase word: correct or incorrect.",
    ].join("\n"),
    user: [
      `Arena problem:\n${question.prompt}`,
      question.expectedAnswer ? `Teacher answer key:\n${question.expectedAnswer}` : "Teacher answer key:\nNo key was provided. Use the required concepts as the scoring target.",
      question.rubric ? `Teacher rubric:\n${question.rubric}` : "",
      question.keywords.length ? `Required concepts or answer markers:\n${question.keywords.join(", ")}` : "",
      `Peer response:\n${answer}`,
      `Peer final answer:\n${finalAnswer}`,
      "Decision:",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });

  return parseJudgeDecision(decision);
}

function missingConceptHints(question, answer, correct) {
  if (correct) return [];

  const answerText = answer.toLowerCase();
  const missingKeywords = question.keywords.filter((keyword) => !answerText.includes(keyword));
  return missingKeywords.length ? missingKeywords : ["complete answer"];
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

async function generatePeerReply(room, student) {
  if (!OPENROUTER_API_KEY) {
    return choosePeerQuestion(room, student);
  }

  return callOpenRouter({
    system: [
      room.systemPrompt,
      peerChallengeInstruction(room.peerChallenge),
      mathFormattingInstruction(),
      "You are a peer student being taught by the student teacher.",
      "Ask exactly one detailed follow-up question that exposes confusion, tests reasoning, or asks the student to connect concepts.",
      "Do not give the full answer yourself. Keep the response under 90 words.",
      `Teaching objectives:\n${room.objectives.map((objective) => `- ${objective}`).join("\n")}`,
    ].join("\n\n"),
    user: `Conversation so far:\n${conversationTranscript(student)}\n\nRespond as the peer student.`,
  });
}

function createPeerAnswer(question, vocabulary) {
  const knownWords = question.keywords.filter((keyword) => vocabulary.includes(keyword));
  const missingWords = question.keywords.filter((keyword) => !vocabulary.includes(keyword));

  if (!knownWords.length) {
    return {
      answer:
        "I am not confident yet. I remember the conversation, but I cannot answer this with the right concepts.\n\nfinal answer: not sure what to do",
      missingWords,
      expectedAnswer: question.expectedAnswer,
      rubric: question.rubric,
      correct: false,
    };
  }

  if (missingWords.length) {
    return {
      answer: `I would use ${knownWords.join(", ")} in my answer, but I still need help connecting ${missingWords.join(
        ", ",
      )}.\n\nfinal answer: not sure what to do`,
      missingWords,
      expectedAnswer: question.expectedAnswer,
      rubric: question.rubric,
      correct: false,
    };
  }

  return {
    answer:
      question.expectedAnswer
        ? `${question.expectedAnswer}\n\nfinal answer: ${question.expectedAnswer}`
        : `I can answer this now. The key ideas are ${question.keywords.join(
            ", ",
          )}, and I can connect them in a complete explanation.\n\nfinal answer: ${question.keywords.join(", ")}`,
    missingWords: [],
    expectedAnswer: question.expectedAnswer,
    rubric: question.rubric,
    correct: true,
  };
}

async function createTestAnswer(room, student, question, transcript) {
  if (!OPENROUTER_API_KEY) {
    return createPeerAnswer(question, buildVocabulary(student.messages));
  }

  try {
    const answer = await callOpenRouter({
      system: [
        room.systemPrompt,
        mathFormattingInstruction(),
        "You are now entering the classroom arena as the student's trained peer LLM.",
        "Use only the methods, concepts, and explanations the student teacher taught you.",
        "Respond with one short paragraph of reasoning followed by exactly one final answer line.",
        "The reasoning paragraph must be under 90 words and must not use bullet points.",
        "End every arena response with exactly one final line in this format: final answer: <your answer>.",
        "If you cannot solve it from what the student taught you, the final line must be exactly: final answer: not sure what to do.",
      ].join("\n\n"),
      user: [
        `Student teaching and coaching transcript:\n${transcript || "The student has not taught anything yet."}`,
        `Arena problem: ${question.prompt}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      maxOutputTokens: 220,
    });
    const correct = await judgeArenaAnswer(question, answer);

    return {
      answer,
      missingWords: missingConceptHints(question, answer, correct),
      expectedAnswer: question.expectedAnswer,
      rubric: question.rubric,
      correct,
    };
  } catch (error) {
    console.error(`Arena answer failed for ${room.code} ${question.id || question.prompt}: ${error.message}`);
    return {
      answer: "The peer could not produce an arena answer for this problem.",
      missingWords: ["complete answer"],
      expectedAnswer: question.expectedAnswer,
      rubric: question.rubric,
      correct: false,
      error: error.message,
    };
  }
}

async function createReadinessCheck(room, student) {
  const progress = objectiveProgress(room, student);
  const covered = progress.filter((objective) => objective.covered);
  const open = progress.filter((objective) => !objective.covered);

  if (!OPENROUTER_API_KEY) {
    const summary = open.length
      ? `I think I can explain ${covered.length}/${progress.length} objectives. I still need teaching on ${open
          .map((objective) => objective.text)
          .join("; ")} before I enter the arena.`
      : `I think I can explain all ${progress.length} objectives. Please ask me one final check question or send me to the arena.`;

    return {
      id: crypto.randomUUID(),
      createdAt: now(),
      provider: peerProviderStatus(),
      coveredObjectives: covered.map((objective) => objective.id),
      missingObjectives: open.map((objective) => objective.id),
      summary,
    };
  }

  const summary = await callOpenRouter({
    system: [
      room.systemPrompt,
      peerChallengeInstruction(room.peerChallenge),
      mathFormattingInstruction(),
      "You are a peer student checking whether you are ready for the classroom arena.",
      "Summarize what you believe you understand from the student teacher, name any remaining confusion, and ask for one targeted correction if needed.",
      "Do not use outside knowledge beyond the transcript. Keep the response under 120 words.",
    ].join("\n\n"),
    user: [
      `Teaching objectives:\n${room.objectives.map((objective) => `- ${objective}`).join("\n")}`,
      `Conversation transcript:\n${conversationTranscript(student)}`,
    ].join("\n\n"),
    maxOutputTokens: 220,
  });

  return {
    id: crypto.randomUUID(),
    createdAt: now(),
    provider: peerProviderStatus(),
    coveredObjectives: covered.map((objective) => objective.id),
    missingObjectives: open.map((objective) => objective.id),
    summary,
  };
}

function scoreLatestTest(room, student) {
  const attempt = latestAttempt(student);
  if (!attempt) return null;
  const correct = attempt.results.filter((result) => result.correct).length;
  return {
    correct,
    total: room.testQuestions.length,
    percent: room.testQuestions.length ? Math.round((correct / room.testQuestions.length) * 100) : 0,
  };
}

function resultReviewState(result) {
  const verdict = result.selfAssessment?.verdict || null;
  if (!verdict) {
    return {
      verdict: null,
      aligned: null,
      hint: null,
      reveal: false,
    };
  }

  const aligned = verdict === (result.correct ? "correct" : "wrong");
  return {
    verdict,
    aligned,
    hint: aligned ? null : "A little fairy thinks differently. Please check carefully.",
    reveal: aligned,
  };
}

function publicLatestMissingConcepts(student) {
  const attempt = latestAttempt(student);
  if (!attempt) return [];

  return attempt.results
    .filter((result) => {
      const review = resultReviewState(result);
      return review.reveal && !result.correct;
    })
    .flatMap((result) => result.missingWords || [])
    .filter((word, index, words) => words.indexOf(word) === index);
}

function publicStudentStatus(student) {
  const attempt = latestAttempt(student);
  if (!attempt) return student.status;
  const openReview = attempt.results.some((result) => !resultReviewState(result).reveal);
  return openReview ? "Self-review" : student.status;
}

function arenaLeaderboardFromStudents(students) {
  return students
    .map((student) => {
      const best = student.testAttempts
        .map((attempt, index) => {
          const correct = attempt.results.filter((result) => result.correct).length;
          const total = attempt.results.length;
          return {
            attemptNumber: index + 1,
            createdAt: attempt.createdAt,
            correct,
            total,
            percent: total ? Math.round((correct / total) * 100) : 0,
          };
        })
        .sort((left, right) => right.percent - left.percent || right.correct - left.correct || left.attemptNumber - right.attemptNumber)[0];

      if (!best) return null;
      return {
        studentId: student.id,
        name: student.name,
        attempts: student.testAttempts.length,
        ...best,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.percent - left.percent || right.correct - left.correct || left.name.localeCompare(right.name))
    .slice(0, 5)
    .map((entry, index) => ({ rank: index + 1, ...entry }));
}

function arenaLeaderboard(room) {
  return arenaLeaderboardFromStudents(Object.values(room.students || {}));
}

function publicArenaLeaderboard(room) {
  const reviewedStudents = Object.values(room.students || {}).map((student) => ({
    ...student,
    testAttempts: student.testAttempts.filter((attempt) => attempt.results.every((result) => resultReviewState(result).reveal)),
  }));
  return arenaLeaderboardFromStudents(reviewedStudents);
}

function summarizeRoom(room) {
  const students = Object.values(room.students).map((student) => ({
    id: student.id,
    name: student.name,
    status: student.status,
    joinedAt: student.joinedAt,
    updatedAt: student.updatedAt,
    teachingTurns: student.messages.filter((message) => message.sender === "student").length,
    peerTurns: student.messages.filter((message) => message.sender === "peer").length,
    correctionTurns: correctionTurnsAfterLatestAttempt(student),
    objectiveProgress: objectiveProgress(room, student),
    objectiveCoverage: objectiveCoverage(room, student),
    latestScore: scoreLatestTest(room, student),
    recentMessages: student.messages.slice(-4),
    messageHistory: student.messages,
    latestAttempt: latestAttempt(student),
    attemptHistory: student.testAttempts,
    latestReadiness: student.readinessChecks.at(-1) || null,
    readinessHistory: student.readinessChecks,
    missingConcepts: latestMissingConcepts(student),
    readinessChecks: student.readinessChecks.length,
    testAttempts: student.testAttempts.length,
  }));

  return {
    code: room.code,
    title: room.title,
    teacherId: room.teacherId || null,
    teacherName: room.teacherName,
    systemPrompt: room.systemPrompt,
    peerChallenge: room.peerChallenge,
    objectives: room.objectives,
    testQuestions: room.testQuestions,
    joinLocked: room.joinLocked,
    activityClosed: room.activityClosed,
    peerProvider: peerProviderStatus(),
    analytics: roomAnalytics(students),
    arenaLeaderboard: arenaLeaderboard(room),
    students,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

function roomAnalytics(students) {
  const totalStudents = students.length;
  const testReady = students.filter((student) => student.status === "Arena ranked" || student.status === "Test ready").length;
  const needsCorrection = students.filter((student) => {
    return student.status === "Needs correction" || student.status === "Correcting";
  }).length;
  const teaching = students.filter((student) => student.status === "Teaching").length;
  const tested = students.filter((student) => student.latestScore).length;
  const readinessChecked = students.filter((student) => student.latestReadiness).length;
  const readinessReady = students.filter((student) => {
    return student.latestReadiness && student.latestReadiness.missingObjectives.length === 0;
  }).length;
  const readinessOpen = students.filter((student) => {
    return student.latestReadiness && student.latestReadiness.missingObjectives.length > 0;
  }).length;
  const averageCoverage = totalStudents
    ? Math.round(students.reduce((sum, student) => sum + student.objectiveCoverage, 0) / totalStudents)
    : 0;
  const averageScore = tested
    ? Math.round(students.reduce((sum, student) => sum + (student.latestScore?.percent || 0), 0) / tested)
    : 0;

  return {
    totalStudents,
    teaching,
    needsCorrection,
    testReady,
    tested,
    readinessChecked,
    readinessReady,
    readinessOpen,
    averageCoverage,
    averageScore,
    leaderboard: arenaLeaderboardFromStudents(
      students.map((student) => ({
        id: student.id,
        name: student.name,
        testAttempts: student.attemptHistory || [],
      })),
    ),
  };
}

function publicArenaProblems(room) {
  return room.testQuestions.map((question, index) => ({
    id: question.id || `q-${index + 1}`,
    prompt: question.prompt,
  }));
}

function publicArenaAttempts(student) {
  return student.testAttempts.map((attempt) => ({
    id: attempt.id,
    createdAt: attempt.createdAt,
    provider: attempt.provider,
    results: attempt.results.map((result) => {
      const review = resultReviewState(result);
      return {
        answer: result.answer,
        missingWords: review.reveal && !result.correct ? result.missingWords || [] : [],
        correct: review.reveal ? result.correct : undefined,
        review,
      };
    }),
  }));
}

function arenaFeedbackMessage(room) {
  return [
    `Arena submission is ready for self-review.`,
    `Read each peer response, decide whether it is correct or wrong, then check your judgment.`,
    `There are ${room.testQuestions.length} arena problems to review.`,
  ].join("\n\n");
}

function ownedRoomSummary(room) {
  return {
    code: room.code,
    title: room.title,
    teacherName: room.teacherName,
    peerProvider: peerProviderStatus(),
    peerChallenge: room.peerChallenge,
    studentCount: Object.keys(room.students || {}).length,
    joinLocked: room.joinLocked,
    activityClosed: room.activityClosed,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

function publicRoom(room) {
  return {
    code: room.code,
    title: room.title,
    teacherName: room.teacherName,
    peerChallenge: room.peerChallenge,
    objectives: room.objectives,
    testQuestions: publicArenaProblems(room),
    arenaLeaderboard: publicArenaLeaderboard(room),
    joinLocked: room.joinLocked,
    activityClosed: room.activityClosed,
    peerProvider: peerProviderStatus(),
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

function publicStudent(student, room) {
  return {
    id: student.id,
    name: student.name,
    status: publicStudentStatus(student),
    messages: student.messages,
    readinessChecks: student.readinessChecks,
    testAttempts: publicArenaAttempts(student),
    correctionTurns: correctionTurnsAfterLatestAttempt(student),
    objectiveProgress: objectiveProgress(room, student),
    missingConcepts: publicLatestMissingConcepts(student),
    joinedAt: student.joinedAt,
    updatedAt: student.updatedAt,
  };
}

function requireTeacherToken(request, room) {
  const token = request.headers["x-teacher-token"];
  if (!room.teacherToken || token !== room.teacherToken) {
    const error = new Error("Teacher session is required for this classroom.");
    error.statusCode = 401;
    throw error;
  }
}

function isRoomOwner(teacher, room) {
  return Boolean(teacher && (room.teacherId === teacher.id || (!room.teacherId && room.teacherName === teacher.name)));
}

function requireTeacherAccess(request, room) {
  const roomToken = request.headers["x-teacher-token"];
  if (room.teacherToken && roomToken === room.teacherToken) return;

  try {
    const teacher = requireTeacherSession(request);
    if (isRoomOwner(teacher, room)) return;
  } catch {
    // Fall through to the classroom-specific access error below.
  }

  const error = new Error("Teacher access is required for this classroom.");
  error.statusCode = 401;
  throw error;
}

function requireStudentToken(request, student) {
  if (authEnabled() && !student.guest) {
    const session = authSessionFromRequest(request);
    if (session?.role !== "student" || student.email !== session.email) {
      const error = new Error("Student Microsoft sign-in is required for this workspace.");
      error.statusCode = 401;
      throw error;
    }
  }

  const token = request.headers["x-student-token"];
  if (!student.studentToken || token !== student.studentToken) {
    const error = new Error("Student session is required for this workspace.");
    error.statusCode = 401;
    throw error;
  }
}

function requireOpenActivity(room) {
  if (room.activityClosed) {
    const error = new Error("This classroom activity is closed.");
    error.statusCode = 403;
    throw error;
  }
}

function requireRoom(code) {
  const room = store.classrooms[code];
  if (!room) {
    const error = new Error("Classroom not found.");
    error.statusCode = 404;
    throw error;
  }
  return room;
}

function requireStudent(room, studentId) {
  const student = room.students[studentId];
  if (!student) {
    const error = new Error("Student not found.");
    error.statusCode = 404;
    throw error;
  }
  return student;
}

function arenaAttemptKey(room, student) {
  return `${room.code}:${student.id}`;
}

async function handleAuth(request, response, url) {
  if (!authEnabled()) return textResponse(response, 503, "Shared THIS Nexus auth is not configured.");

  if (request.method === "GET" && url.pathname === "/auth/microsoft/start") {
    const returnTo = url.searchParams.get("returnTo") || "/";
    return redirectResponse(response, buildMicrosoftLoginUrl(returnTo));
  }

  if (request.method === "GET" && url.pathname === "/auth/microsoft/callback") {
    return redirectResponse(response, "/?authError=callback-is-handled-by-thisnexus-auth");
  }

  if (request.method === "GET" && url.pathname === "/auth/logout") {
    response.writeHead(302, {
      Location: "/",
      "Set-Cookie": [clearCookieHeader(AUTH_COOKIE_NAME), clearCookieHeader(AUTH_FLOW_COOKIE_NAME)],
    });
    response.end();
    return;
  }

  return textResponse(response, 404, "Auth route not found");
}

async function handleApi(request, response, url) {
  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/api/auth/me") {
    const session = authEnabled() ? authSessionFromRequest(request) : null;
    if (session?.role === "teacher") {
      const teacher = getOrCreateTeacherFromAuth(session);
      session.teacherId = teacher.id;
      await saveData();
    }
    return jsonResponse(response, 200, {
      authEnabled: authEnabled(),
      authenticated: Boolean(session),
      user: publicAuthUser(session),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": [clearCookieHeader(AUTH_COOKIE_NAME), clearCookieHeader(AUTH_FLOW_COOKIE_NAME)],
    });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/teachers/login") {
    if (authEnabled()) {
      const error = new Error("Use Microsoft sign-in for teacher login.");
      error.statusCode = 400;
      throw error;
    }

    const body = await parseJsonBody(request);
    const teacher = getOrCreateTeacher(body.teacherName);
    await saveData();
    return jsonResponse(response, 200, {
      teacher: publicTeacher(teacher),
      teacherSession: teacher.sessionToken,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/teachers/me/classrooms") {
    const teacher = requireTeacherSession(request);
    const rooms = Object.values(store.classrooms)
      .filter((room) => room.teacherId === teacher.id || (!room.teacherId && room.teacherName === teacher.name))
      .map((room) => ownedRoomSummary(room));
    return jsonResponse(response, 200, { teacher: publicTeacher(teacher), classrooms: rooms });
  }

  if (request.method === "POST" && url.pathname === "/api/classrooms") {
    const teacher = requireTeacherSession(request);
    const body = await parseJsonBody(request);
    const testQuestions = applyAnswerKeys(normalizeQuestions(body.testQuestions), body.answerKeys);
    const code = generateCode();
    const room = {
      code,
      title: requireString(body.title, "title"),
      teacherId: teacher.id,
      teacherName: teacher.name,
      systemPrompt: requireString(body.systemPrompt, "systemPrompt"),
      peerChallenge: normalizePeerChallenge(body.peerChallenge),
      objectives: normalizeLines(body.objectives, "objectives"),
      testQuestions,
      joinLocked: false,
      activityClosed: false,
      students: {},
      teacherToken: crypto.randomUUID(),
      createdAt: now(),
      updatedAt: now(),
    };
    store.classrooms[code] = room;
    await saveData();
    return jsonResponse(response, 201, { room: summarizeRoom(room), teacherToken: room.teacherToken });
  }

  if (parts[0] !== "api" || parts[1] !== "classrooms" || !parts[2]) {
    return jsonResponse(response, 404, { error: "API route not found." });
  }

  const code = parts[2].toUpperCase();
  const room = requireRoom(code);

  if (request.method === "GET" && parts.length === 3) {
    requireTeacherAccess(request, room);
    return jsonResponse(response, 200, { room: summarizeRoom(room) });
  }

  if (request.method === "PATCH" && parts.length === 4 && parts[3] === "config") {
    requireTeacherAccess(request, room);
    const body = await parseJsonBody(request);
    room.title = requireString(body.title, "title");
    room.systemPrompt = requireString(body.systemPrompt, "systemPrompt");
    room.peerChallenge = normalizePeerChallenge(body.peerChallenge || room.peerChallenge);
    room.objectives = normalizeLines(body.objectives, "objectives");
    room.testQuestions = applyAnswerKeys(normalizeQuestions(body.testQuestions), body.answerKeys);
    room.updatedAt = now();
    await saveData();
    return jsonResponse(response, 200, { room: summarizeRoom(room) });
  }

  if (request.method === "PATCH" && parts.length === 4 && parts[3] === "access") {
    requireTeacherAccess(request, room);
    const body = await parseJsonBody(request);
    if (body.joinLocked !== undefined && typeof body.joinLocked !== "boolean") {
      const error = new Error("joinLocked must be true or false.");
      error.statusCode = 400;
      throw error;
    }
    if (body.activityClosed !== undefined && typeof body.activityClosed !== "boolean") {
      const error = new Error("activityClosed must be true or false.");
      error.statusCode = 400;
      throw error;
    }
    if (body.joinLocked === undefined && body.activityClosed === undefined) {
      const error = new Error("At least one access setting is required.");
      error.statusCode = 400;
      throw error;
    }
    if (body.joinLocked !== undefined) room.joinLocked = body.joinLocked;
    if (body.activityClosed !== undefined) room.activityClosed = body.activityClosed;
    room.updatedAt = now();
    await saveData();
    return jsonResponse(response, 200, { room: summarizeRoom(room) });
  }

  if (request.method === "POST" && parts.length === 4 && parts[3] === "students") {
    if (room.joinLocked || room.activityClosed) {
      const error = new Error("This classroom is not accepting new students right now.");
      error.statusCode = 403;
      throw error;
    }

    const body = await parseJsonBody(request);
    const authSession = authEnabled() ? authSessionFromRequest(request) : null;
    const guestJoin = Boolean(body.guest);
    if (guestJoin && String(body.invitationCode || "").trim() !== GUEST_INVITE_CODE) {
      const error = new Error("A valid guest invitation code is required.");
      error.statusCode = 401;
      throw error;
    }
    if (authEnabled() && !guestJoin && authSession?.role !== "student") {
      const error = new Error("Student Microsoft sign-in is required.");
      error.statusCode = 401;
      throw error;
    }
    const name = guestJoin ? requireString(body.name, "name") : authSession ? authSession.name || authSession.email : requireString(body.name, "name");
    const studentId = crypto.randomUUID();
    room.students[studentId] = {
      id: studentId,
      name,
      email: guestJoin ? undefined : authSession?.email,
      guest: guestJoin,
      status: "Teaching",
      messages: [
        {
          id: crypto.randomUUID(),
          sender: "system",
          text: "Your peer is ready. Teach it the objectives, then enter it into the arena when you are confident.",
          createdAt: now(),
        },
        {
          id: crypto.randomUUID(),
          sender: "peer",
          text: `Hi ${name}. I am your peer student. I will ask questions until I am ready for the arena. What should I understand first?`,
          createdAt: now(),
        },
      ],
      readinessChecks: [],
      testAttempts: [],
      studentToken: crypto.randomUUID(),
      joinedAt: now(),
      updatedAt: now(),
    };
    room.updatedAt = now();
    await saveData();
    return jsonResponse(response, 201, {
      room: publicRoom(room),
      student: publicStudent(room.students[studentId], room),
      studentToken: room.students[studentId].studentToken,
    });
  }

  if (parts.length < 5 || parts[3] !== "students") {
    return jsonResponse(response, 404, { error: "API route not found." });
  }

  const student = requireStudent(room, parts[4]);

  if (request.method === "GET" && parts.length === 5) {
    requireStudentToken(request, student);
    return jsonResponse(response, 200, { room: publicRoom(room), student: publicStudent(student, room) });
  }

  if (request.method === "POST" && parts.length === 6 && parts[5] === "messages") {
    requireStudentToken(request, student);
    requireOpenActivity(room);
    const body = await parseJsonBody(request);
    const text = requireString(body.text, "text");
    const isCorrection = latestAttemptNeedsCorrection(student);
    student.messages.push({ id: crypto.randomUUID(), sender: "student", text, createdAt: now() });
    student.messages.push({
      id: crypto.randomUUID(),
      sender: "peer",
      text: await generatePeerReply(room, student),
      provider: peerProviderStatus(),
      createdAt: now(),
    });
    student.status = isCorrection ? "Correcting" : "Teaching";
    student.updatedAt = now();
    room.updatedAt = now();
    await saveData();
    return jsonResponse(response, 201, { room: publicRoom(room), student: publicStudent(student, room) });
  }

  if (request.method === "POST" && parts.length === 6 && parts[5] === "readiness-checks") {
    requireStudentToken(request, student);
    requireOpenActivity(room);
    const check = await createReadinessCheck(room, student);
    student.readinessChecks.push(check);
    student.messages.push({
      id: crypto.randomUUID(),
      sender: "peer",
      text: `Readiness check: ${check.summary}`,
      provider: check.provider,
      createdAt: check.createdAt,
    });
    student.updatedAt = now();
    room.updatedAt = now();
    await saveData();
    return jsonResponse(response, 201, { room: publicRoom(room), student: publicStudent(student, room) });
  }

  if (request.method === "POST" && parts.length === 6 && parts[5] === "test-attempts") {
    requireStudentToken(request, student);
    requireOpenActivity(room);
    const attemptKey = arenaAttemptKey(room, student);
    if (activeArenaAttempts.has(attemptKey)) {
      const error = new Error("An arena submission is already running for this student.");
      error.statusCode = 409;
      throw error;
    }

    activeArenaAttempts.add(attemptKey);
    try {
      const transcript = teachingTranscript(student);
      const results = await mapWithConcurrency(room.testQuestions, 3, (question) => createTestAnswer(room, student, question, transcript));
      const correct = results.filter((result) => result.correct).length;
      student.testAttempts.push({
        id: crypto.randomUUID(),
        createdAt: now(),
        provider: peerProviderStatus(),
        results,
      });
      student.status = correct === room.testQuestions.length ? "Arena ranked" : "Needs correction";
      student.messages.push({
        id: crypto.randomUUID(),
        sender: "system",
        text: arenaFeedbackMessage(room),
        createdAt: now(),
      });
      student.updatedAt = now();
      room.updatedAt = now();
      await saveData();
      return jsonResponse(response, 201, { room: publicRoom(room), student: publicStudent(student, room) });
    } finally {
      activeArenaAttempts.delete(attemptKey);
    }
  }

  if (
    request.method === "POST" &&
    parts.length === 10 &&
    parts[5] === "test-attempts" &&
    parts[7] === "results" &&
    parts[9] === "assessment"
  ) {
    requireStudentToken(request, student);
    requireOpenActivity(room);
    const attempt = student.testAttempts.find((item) => item.id === parts[6]);
    if (!attempt) {
      const error = new Error("Arena attempt not found.");
      error.statusCode = 404;
      throw error;
    }

    const resultIndex = Number(parts[8]);
    const result = Number.isInteger(resultIndex) ? attempt.results[resultIndex] : null;
    if (!result) {
      const error = new Error("Arena result not found.");
      error.statusCode = 404;
      throw error;
    }

    const body = await parseJsonBody(request);
    const verdict = String(body.verdict || "").trim().toLowerCase();
    if (verdict !== "correct" && verdict !== "wrong") {
      const error = new Error("verdict must be correct or wrong.");
      error.statusCode = 400;
      throw error;
    }

    result.selfAssessment = {
      verdict,
      aligned: verdict === (result.correct ? "correct" : "wrong"),
      createdAt: now(),
    };
    student.updatedAt = now();
    room.updatedAt = now();
    await saveData();
    return jsonResponse(response, 200, { room: publicRoom(room), student: publicStudent(student, room) });
  }

  return jsonResponse(response, 404, { error: "API route not found." });
}

async function handleStatic(response, url) {
  const fileName = PUBLIC_FILES.get(url.pathname);
  if (!fileName) return textResponse(response, 404, "Not found");

  const filePath = path.join(__dirname, fileName);
  const content = await fs.readFile(filePath);
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  response.end(content);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith("/auth/")) {
      await handleAuth(request, response, url);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    await handleStatic(response, url);
  } catch (error) {
    jsonResponse(response, error.statusCode || 500, { error: error.message || "Server error." });
  }
});

loadData()
  .then(() => {
    server.listen(PORT, () => {
      const provider = peerProviderStatus();
      console.log(`TeachLab server listening on http://localhost:${PORT}`);
      console.log(`Peer provider: ${provider.mode} (${provider.model})`);
      if (OPENROUTER_API_KEY) console.log(`Arena judge: openrouter (${OPENROUTER_JUDGE_MODEL})`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
