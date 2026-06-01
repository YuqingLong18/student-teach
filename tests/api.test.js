const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

async function startServer(t, envOverrides = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "teachlab-api-"));
  const dataFile = path.join(tempDir, "classrooms.json");
  const port = 45000 + Math.floor(Math.random() * 10000);
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      DATA_FILE: dataFile,
      PORT: String(port),
      OPENROUTER_API_KEY: "",
      ...envOverrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  server.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  t.after(async () => {
    server.kill();
    await new Promise((resolve) => server.once("close", resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await waitForServer(`http://localhost:${port}`, () => {
    if (server.exitCode !== null) {
      throw new Error(`Server exited early.\n${output}`);
    }
  });

  return {
    baseUrl: `http://localhost:${port}`,
  };
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function signedSessionCookie(payload, secret) {
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = base64UrlEncode(crypto.createHmac("sha256", secret).update(body).digest());
  return `${body}.${signature}`;
}

async function waitForServer(baseUrl, checkProcess) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    checkProcess();
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.ok) return;
    } catch {
      // Retry while the child process starts listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for test server.");
}

async function request(baseUrl, method, pathname, body, headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  return { response, payload };
}

async function loginTeacher(baseUrl, teacherName) {
  const { response, payload } = await request(baseUrl, "POST", "/api/teachers/login", { teacherName });
  assert.equal(response.status, 200);
  return payload;
}

function teacherHeaders(login) {
  return {
    "X-Teacher-Id": login.teacher.id,
    "X-Teacher-Session": login.teacherSession,
  };
}

function studentHeaders(studentToken) {
  return {
    "X-Student-Token": studentToken,
  };
}

async function createClassroom(baseUrl, login, overrides = {}) {
  const body = {
    title: "Physics studio",
    systemPrompt: "Act as a curious peer student who needs careful teaching.",
    peerChallenge: "rigorous",
    objectives: [
      "Explain kinetic energy using mass and velocity",
      "Describe momentum transfer using impulse",
    ],
    testQuestions:
      "How does speed change kinetic energy? | kinetic, velocity | Mention the square relationship to speed.\nHow does impulse affect momentum transfer? | impulse, momentum | Mention force over time and momentum change.",
    answerKeys:
      "Kinetic energy changes with the square of speed.\nImpulse changes momentum during a transfer.",
    ...overrides,
  };
  const { response, payload } = await request(baseUrl, "POST", "/api/classrooms", body, teacherHeaders(login));
  assert.equal(response.status, 201);
  return payload;
}

test("teacher login, room ownership, student teaching, testing, correction, and analytics", async (t) => {
  const { baseUrl } = await startServer(t);
  const teacher = await loginTeacher(baseUrl, "Ada Lovelace");

  const unauthenticatedCreate = await request(baseUrl, "POST", "/api/classrooms", {
    title: "Blocked room",
    systemPrompt: "No session.",
    objectives: ["One objective"],
    testQuestions: ["One question | keyword"],
  });
  assert.equal(unauthenticatedCreate.response.status, 401);

  const created = await createClassroom(baseUrl, teacher);
  const roomCode = created.room.code;
  assert.match(roomCode, /^[A-Z2-9]{6}$/);
  assert.equal(created.room.teacherId, teacher.teacher.id);
  assert.equal(created.room.peerChallenge, "rigorous");
  assert.ok(created.teacherToken);

  const list = await request(baseUrl, "GET", "/api/teachers/me/classrooms", null, teacherHeaders(teacher));
  assert.equal(list.response.status, 200);
  assert.deepEqual(
    list.payload.classrooms.map((room) => room.code),
    [roomCode],
  );

  const reopened = await request(baseUrl, "GET", `/api/classrooms/${roomCode}`, null, teacherHeaders(teacher));
  assert.equal(reopened.response.status, 200);
  assert.equal(reopened.payload.room.title, "Physics studio");
  assert.equal(reopened.payload.room.peerChallenge, "rigorous");
  assert.equal(reopened.payload.room.joinLocked, false);
  assert.equal(reopened.payload.room.activityClosed, false);

  const impostor = await loginTeacher(baseUrl, "Grace Hopper");
  const rejectedOwnerRead = await request(baseUrl, "GET", `/api/classrooms/${roomCode}`, null, teacherHeaders(impostor));
  assert.equal(rejectedOwnerRead.response.status, 401);
  const rejectedAccessChange = await request(
    baseUrl,
    "PATCH",
    `/api/classrooms/${roomCode}/access`,
    { joinLocked: true },
    teacherHeaders(impostor),
  );
  assert.equal(rejectedAccessChange.response.status, 401);

  const locked = await request(
    baseUrl,
    "PATCH",
    `/api/classrooms/${roomCode}/access`,
    { joinLocked: true },
    teacherHeaders(teacher),
  );
  assert.equal(locked.response.status, 200);
  assert.equal(locked.payload.room.joinLocked, true);

  const blockedJoin = await request(baseUrl, "POST", `/api/classrooms/${roomCode}/students`, { name: "Early" });
  assert.equal(blockedJoin.response.status, 403);

  const unlocked = await request(
    baseUrl,
    "PATCH",
    `/api/classrooms/${roomCode}/access`,
    { joinLocked: false },
    teacherHeaders(teacher),
  );
  assert.equal(unlocked.response.status, 200);
  assert.equal(unlocked.payload.room.joinLocked, false);

  const closedBeforeJoin = await request(
    baseUrl,
    "PATCH",
    `/api/classrooms/${roomCode}/access`,
    { activityClosed: true },
    teacherHeaders(teacher),
  );
  assert.equal(closedBeforeJoin.response.status, 200);
  assert.equal(closedBeforeJoin.payload.room.activityClosed, true);

  const blockedJoinClosed = await request(baseUrl, "POST", `/api/classrooms/${roomCode}/students`, { name: "Late" });
  assert.equal(blockedJoinClosed.response.status, 403);

  const reopenedActivity = await request(
    baseUrl,
    "PATCH",
    `/api/classrooms/${roomCode}/access`,
    { activityClosed: false },
    teacherHeaders(teacher),
  );
  assert.equal(reopenedActivity.response.status, 200);
  assert.equal(reopenedActivity.payload.room.activityClosed, false);

  const updated = await request(
    baseUrl,
    "PATCH",
    `/api/classrooms/${roomCode}/config`,
    {
      title: "Updated physics studio",
      systemPrompt: "Keep asking for concrete examples.",
      peerChallenge: "gentle",
      objectives: "Explain kinetic energy using mass and velocity\nDescribe momentum transfer using impulse",
      testQuestions:
        "How does speed change kinetic energy? | kinetic, velocity | Mention the square relationship to speed.\nHow does impulse affect momentum transfer? | impulse, momentum | Mention force over time and momentum change.",
      answerKeys:
        "Kinetic energy changes with the square of speed.\nImpulse changes momentum during a transfer.",
    },
    teacherHeaders(teacher),
  );
  assert.equal(updated.response.status, 200);
  assert.equal(updated.payload.room.title, "Updated physics studio");
  assert.equal(updated.payload.room.systemPrompt, "Keep asking for concrete examples.");
  assert.equal(updated.payload.room.peerChallenge, "gentle");

  const join = await request(baseUrl, "POST", `/api/classrooms/${roomCode}/students`, { name: "Mina" });
  assert.equal(join.response.status, 201);
  assert.ok(join.payload.studentToken);
  assert.equal(join.payload.student.studentToken, undefined);
  assert.equal(join.payload.student.name, "Mina");
  assert.equal(join.payload.room.students, undefined);
  assert.equal(join.payload.room.systemPrompt, undefined);
  assert.equal(join.payload.room.testQuestions[0].keywords, undefined);
  assert.equal(join.payload.room.testQuestions[1].expectedAnswer, undefined);
  assert.equal(join.payload.room.testQuestions[1].rubric, undefined);

  const studentId = join.payload.student.id;
  const token = join.payload.studentToken;
  const rejectedStudentRead = await request(baseUrl, "GET", `/api/classrooms/${roomCode}/students/${studentId}`);
  assert.equal(rejectedStudentRead.response.status, 401);

  const acceptedStudentRead = await request(
    baseUrl,
    "GET",
    `/api/classrooms/${roomCode}/students/${studentId}`,
    null,
    studentHeaders(token),
  );
  assert.equal(acceptedStudentRead.response.status, 200);
  assert.equal(acceptedStudentRead.payload.student.status, "Teaching");

  const closedAfterJoin = await request(
    baseUrl,
    "PATCH",
    `/api/classrooms/${roomCode}/access`,
    { activityClosed: true },
    teacherHeaders(teacher),
  );
  assert.equal(closedAfterJoin.response.status, 200);

  const readWhileClosed = await request(
    baseUrl,
    "GET",
    `/api/classrooms/${roomCode}/students/${studentId}`,
    null,
    studentHeaders(token),
  );
  assert.equal(readWhileClosed.response.status, 200);
  assert.equal(readWhileClosed.payload.room.activityClosed, true);

  const blockedMessageClosed = await request(
    baseUrl,
    "POST",
    `/api/classrooms/${roomCode}/students/${studentId}/messages`,
    { text: "Can I keep teaching?" },
    studentHeaders(token),
  );
  assert.equal(blockedMessageClosed.response.status, 403);

  const reopenedAfterJoin = await request(
    baseUrl,
    "PATCH",
    `/api/classrooms/${roomCode}/access`,
    { activityClosed: false },
    teacherHeaders(teacher),
  );
  assert.equal(reopenedAfterJoin.response.status, 200);

  const taughtOneObjective = await request(
    baseUrl,
    "POST",
    `/api/classrooms/${roomCode}/students/${studentId}/messages`,
    { text: "Kinetic energy depends on mass and velocity. If velocity rises, kinetic energy changes a lot." },
    studentHeaders(token),
  );
  assert.equal(taughtOneObjective.response.status, 201);
  assert.equal(taughtOneObjective.payload.student.objectiveProgress[0].covered, true);
  assert.equal(taughtOneObjective.payload.student.objectiveProgress[1].covered, false);
  assert.match(taughtOneObjective.payload.student.messages.at(-1).text, /small everyday example/);

  const readiness = await request(
    baseUrl,
    "POST",
    `/api/classrooms/${roomCode}/students/${studentId}/readiness-checks`,
    {},
    studentHeaders(token),
  );
  assert.equal(readiness.response.status, 201);
  assert.equal(readiness.payload.student.readinessChecks.length, 1);
  assert.equal(readiness.payload.student.readinessChecks[0].coveredObjectives.length, 1);
  assert.equal(readiness.payload.student.readinessChecks[0].missingObjectives.length, 1);
  assert.match(readiness.payload.student.messages.at(-1).text, /^Readiness check:/);

  const firstAttempt = await request(
    baseUrl,
    "POST",
    `/api/classrooms/${roomCode}/students/${studentId}/test-attempts`,
    {},
    studentHeaders(token),
  );
  assert.equal(firstAttempt.response.status, 201);
  assert.equal(firstAttempt.payload.student.status, "Needs correction");
  assert.equal(firstAttempt.payload.student.testAttempts[0].results[0].correct, true);
  assert.equal(firstAttempt.payload.student.testAttempts[0].results[1].correct, false);
  assert.ok(firstAttempt.payload.student.testAttempts[0].results[1].answer.length > 20);
  assert.equal(firstAttempt.payload.student.testAttempts[0].results[1].expectedAnswer, undefined);
  assert.equal(firstAttempt.payload.student.testAttempts[0].results[1].rubric, undefined);
  assert.match(firstAttempt.payload.student.messages.at(-1).text, /Arena submission scored 1\/2/);
  assert.match(firstAttempt.payload.student.messages.at(-1).text, /Problem 2 \(needs coaching\)/);
  assert.match(firstAttempt.payload.student.messages.at(-1).text, /Peer solution:/);
  assert.doesNotMatch(firstAttempt.payload.student.messages.at(-1).text, /Answer key:/);

  const correction = await request(
    baseUrl,
    "POST",
    `/api/classrooms/${roomCode}/students/${studentId}/messages`,
    { text: "Correction: impulse is force over time, and it changes momentum during a transfer." },
    studentHeaders(token),
  );
  assert.equal(correction.response.status, 201);
  assert.equal(correction.payload.student.status, "Correcting");
  assert.equal(correction.payload.student.correctionTurns, 1);

  const finalAttempt = await request(
    baseUrl,
    "POST",
    `/api/classrooms/${roomCode}/students/${studentId}/test-attempts`,
    {},
    studentHeaders(token),
  );
  assert.equal(finalAttempt.response.status, 201);
  assert.equal(finalAttempt.payload.student.status, "Arena ranked");
  assert.equal(finalAttempt.payload.student.testAttempts.at(-1).results.every((result) => result.correct), true);
  assert.equal(finalAttempt.payload.room.arenaLeaderboard[0].name, "Mina");
  assert.equal(finalAttempt.payload.room.arenaLeaderboard[0].percent, 100);

  const teacherMonitor = await request(baseUrl, "GET", `/api/classrooms/${roomCode}`, null, teacherHeaders(teacher));
  assert.equal(teacherMonitor.response.status, 200);
  assert.equal(teacherMonitor.payload.room.analytics.totalStudents, 1);
  assert.equal(teacherMonitor.payload.room.analytics.testReady, 1);
  assert.equal(teacherMonitor.payload.room.analytics.averageCoverage, 100);
  assert.equal(teacherMonitor.payload.room.analytics.averageScore, 100);
  assert.equal(teacherMonitor.payload.room.analytics.readinessChecked, 1);
  assert.equal(teacherMonitor.payload.room.analytics.readinessReady, 0);
  assert.equal(teacherMonitor.payload.room.analytics.readinessOpen, 1);
  assert.equal(teacherMonitor.payload.room.analytics.leaderboard[0].name, "Mina");
  assert.equal(teacherMonitor.payload.room.arenaLeaderboard[0].percent, 100);
  assert.equal(teacherMonitor.payload.room.students[0].latestScore.percent, 100);
  assert.equal(teacherMonitor.payload.room.students[0].studentToken, undefined);
  assert.equal(teacherMonitor.payload.room.students[0].messageHistory.length, finalAttempt.payload.student.messages.length);
  assert.equal(teacherMonitor.payload.room.students[0].readinessChecks, 1);
  assert.equal(teacherMonitor.payload.room.students[0].readinessHistory.length, 1);
  assert.equal(teacherMonitor.payload.room.students[0].latestReadiness.missingObjectives.length, 1);
  assert.equal(teacherMonitor.payload.room.students[0].attemptHistory.length, 2);
  assert.equal(teacherMonitor.payload.room.students[0].attemptHistory[0].results[1].correct, false);
  assert.equal(teacherMonitor.payload.room.students[0].attemptHistory[1].results[1].correct, true);
  assert.equal(teacherMonitor.payload.room.testQuestions[0].expectedAnswer, "Kinetic energy changes with the square of speed.");
  assert.equal(teacherMonitor.payload.room.testQuestions[1].expectedAnswer, "Impulse changes momentum during a transfer.");
});

test("microsoft teacher session can create and list classrooms", async (t) => {
  const authSecret = "test-auth-secret";
  const cookieName = "thisnexus_session";
  const { baseUrl } = await startServer(t, {
    AUTH_BASE_URL: "https://thisnexus.cn",
    AUTH_SERVICE_BASE_URL: "https://thisnexus.cn",
    AUTH_COOKIE_NAME: cookieName,
    AUTH_SESSION_SECRET: authSecret,
  });
  const cookie = signedSessionCookie(
    {
      email: "teacher@example.edu",
      name: "Teacher Example",
      role: "teacher",
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    authSecret,
  );
  const headers = {
    Cookie: `${cookieName}=${encodeURIComponent(cookie)}`,
  };

  const me = await request(baseUrl, "GET", "/api/auth/me", null, headers);
  assert.equal(me.response.status, 200);
  assert.equal(me.payload.authenticated, true);
  assert.equal(me.payload.user.teacher.name, "Teacher Example");

  const created = await request(
    baseUrl,
    "POST",
    "/api/classrooms",
    {
      title: "SSO classroom",
      systemPrompt: "Act as a peer learner.",
      peerChallenge: "balanced",
      objectives: ["Explain the Remainder Theorem"],
      testQuestions: "What is the remainder if f(2)=5 and the divisor is x-2? | f(2), x-2 | Use Remainder Theorem.",
      answerKeys: ["5"],
    },
    headers,
  );
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.room.teacherName, "Teacher Example");

  const list = await request(baseUrl, "GET", "/api/teachers/me/classrooms", null, headers);
  assert.equal(list.response.status, 200);
  assert.deepEqual(
    list.payload.classrooms.map((room) => room.code),
    [created.payload.room.code],
  );
});
