const SESSION_KEY = "teachlab.session.v1";

const state = {
  role: "teacher",
  authEnabled: false,
  authUser: null,
  teacher: null,
  teacherSession: null,
  roomCode: null,
  teacherToken: null,
  studentId: null,
  studentToken: null,
  room: null,
  student: null,
  pollTimer: null,
  monitorFilter: "all",
  openStudentCards: new Set(),
  chatScrollTouchedAt: 0,
  isRestoringChatScroll: false,
};

const elements = {
  teacherTab: document.querySelector("#teacherTab"),
  studentTab: document.querySelector("#studentTab"),
  teacherForm: document.querySelector("#teacherForm"),
  teacherLoginButton: document.querySelector("#teacherLoginButton"),
  teacherIdentity: document.querySelector("#teacherIdentity"),
  classroomPicker: document.querySelector("#classroomPicker"),
  classroomList: document.querySelector("#classroomList"),
  studentForm: document.querySelector("#studentForm"),
  studentLoginButton: document.querySelector("#studentLoginButton"),
  teacherError: document.querySelector("#teacherError"),
  joinError: document.querySelector("#joinError"),
  emptyState: document.querySelector("#emptyState"),
  teacherView: document.querySelector("#teacherView"),
  studentView: document.querySelector("#studentView"),
  roomCode: document.querySelector("#roomCode"),
  teacherProvider: document.querySelector("#teacherProvider"),
  joinLockButton: document.querySelector("#joinLockButton"),
  activityToggleButton: document.querySelector("#activityToggleButton"),
  teacherSignOutButton: document.querySelector("#teacherSignOutButton"),
  teacherRoomTitle: document.querySelector("#teacherRoomTitle"),
  liveClassTitle: document.querySelector("#liveClassTitle"),
  liveSystemPrompt: document.querySelector("#liveSystemPrompt"),
  livePeerChallenge: document.querySelector("#livePeerChallenge"),
  liveObjectives: document.querySelector("#liveObjectives"),
  liveTestQuestions: document.querySelector("#liveTestQuestions"),
  liveAnswerKeys: document.querySelector("#liveAnswerKeys"),
  saveConfigButton: document.querySelector("#saveConfigButton"),
  studentCount: document.querySelector("#studentCount"),
  monitorFilters: document.querySelector("#monitorFilters"),
  classSummary: document.querySelector("#classSummary"),
  teacherLeaderboard: document.querySelector("#teacherLeaderboard"),
  studentList: document.querySelector("#studentList"),
  studentRoomCode: document.querySelector("#studentRoomCode"),
  studentRoomTitle: document.querySelector("#studentRoomTitle"),
  studentProvider: document.querySelector("#studentProvider"),
  studentScore: document.querySelector("#studentScore"),
  objectiveList: document.querySelector("#objectiveList"),
  chatLog: document.querySelector("#chatLog"),
  chatForm: document.querySelector("#chatForm"),
  chatInput: document.querySelector("#chatInput"),
  chatSubmitButton: document.querySelector("#chatSubmitButton"),
  readinessCheckButton: document.querySelector("#readinessCheckButton"),
  startTestButton: document.querySelector("#startTestButton"),
  studentLeaveButton: document.querySelector("#studentLeaveButton"),
  testState: document.querySelector("#testState"),
  studentLeaderboard: document.querySelector("#studentLeaderboard"),
  testResults: document.querySelector("#testResults"),
};

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }
  return payload;
}

async function loadAuthState() {
  const payload = await apiRequest("/api/auth/me");
  state.authEnabled = Boolean(payload.authEnabled);
  state.authUser = payload.authenticated ? payload.user : null;

  if (state.authUser?.role === "teacher" && state.authUser.teacher) {
    state.teacher = state.authUser.teacher;
    state.teacherSession = "microsoft-sso";
  }

  renderAuthAccess();
}

function beginMicrosoftSignIn(role) {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.href = `/auth/microsoft/start?role=${encodeURIComponent(role)}&returnTo=${encodeURIComponent(returnTo)}`;
}

function renderAuthAccess() {
  if (!state.authEnabled) {
    elements.teacherLoginButton.textContent = "Teacher login";
    elements.studentLoginButton.textContent = "Student login";
    return;
  }

  const user = state.authUser;
  elements.teacherLoginButton.classList.toggle("is-hidden", user?.role === "teacher");
  elements.studentLoginButton.classList.toggle("is-hidden", user?.role === "student");

  if (!user) {
    elements.teacherIdentity.textContent = "Signed out";
    elements.teacherError.textContent ||= "Sign in with your school Microsoft account.";
    elements.joinError.textContent ||= "Sign in with your school Microsoft account.";
    return;
  }

  if (user.role === "teacher") {
    elements.teacherIdentity.textContent = `${user.name || user.email} · teacher`;
    elements.teacherError.textContent = "";
    if (state.role === "student") elements.joinError.textContent = "This Microsoft account is classified as a teacher account.";
  } else {
    elements.joinError.textContent = "";
    if (state.role === "teacher") elements.teacherError.textContent = "This Microsoft account is classified as a student account.";
  }
}

function teacherHeaders() {
  return {
    ...(state.teacherToken ? { "X-Teacher-Token": state.teacherToken } : {}),
    ...(state.teacher?.id && state.teacherSession
      ? { "X-Teacher-Id": state.teacher.id, "X-Teacher-Session": state.teacherSession }
      : {}),
  };
}

function studentHeaders() {
  return state.studentToken ? { "X-Student-Token": state.studentToken } : {};
}

function saveSession() {
  try {
    if (state.studentId) {
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
          role: "student",
          roomCode: state.roomCode,
          studentId: state.studentId,
          studentToken: state.studentToken,
        }),
      );
      return;
    }

    if (state.teacher && state.teacherSession) {
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
          role: "teacher",
          teacher: state.teacher,
          teacherSession: state.teacherSession,
          roomCode: state.roomCode || null,
          teacherToken: state.teacherToken || null,
        }),
      );
    }
  } catch {
    // Session persistence is a convenience; the live server state is authoritative.
  }
}

async function teacherLogin() {
  elements.teacherError.textContent = "";
  if (state.authEnabled) {
    if (!state.authUser) {
      beginMicrosoftSignIn("teacher");
      return;
    }

    if (state.authUser.role !== "teacher" || !state.authUser.teacher) {
      elements.teacherError.textContent = "This Microsoft account is classified as a student account.";
      return;
    }

    state.teacher = state.authUser.teacher;
    state.teacherSession = "microsoft-sso";
    renderTeacherIdentity();
    await loadTeacherClassrooms();
    return;
  }

  const restore = setBusy(elements.teacherLoginButton, "Signing in...");

  try {
    const teacherName = window.prompt("Teacher name");
    if (!teacherName) return;
    const payload = await apiRequest("/api/teachers/login", {
      method: "POST",
      body: JSON.stringify({
        teacherName: teacherName.trim(),
      }),
    });
    state.teacher = payload.teacher;
    state.teacherSession = payload.teacherSession;
    state.teacherToken = null;
    state.roomCode = null;
    state.studentId = null;
    state.studentToken = null;
    state.student = null;
    saveSession();
    renderTeacherIdentity();
    await loadTeacherClassrooms();
  } catch (error) {
    elements.teacherError.textContent = error.message;
  } finally {
    restore();
  }
}

function renderTeacherIdentity() {
  const label = state.authUser?.role === "teacher" ? `${state.authUser.name || state.authUser.email} · teacher` : state.teacher?.name;
  elements.teacherIdentity.textContent = label || "Signed out";
  elements.classroomPicker.classList.toggle("is-hidden", !state.teacher);
}

async function loadTeacherClassrooms() {
  if (!state.teacher || (!state.teacherSession && !state.authUser)) return;
  const payload = await apiRequest("/api/teachers/me/classrooms", { headers: teacherHeaders() });
  renderClassroomList(payload.classrooms || []);
}

function renderClassroomList(classrooms) {
  elements.classroomList.innerHTML = "";
  if (!classrooms.length) {
    const empty = document.createElement("p");
    empty.className = "form-note";
    empty.textContent = "No classrooms yet.";
    elements.classroomList.append(empty);
    return;
  }

  classrooms.forEach((room) => {
    const button = document.createElement("button");
    button.className = "classroom-button";
    button.type = "button";
    const accessLabel = room.activityClosed ? "activity closed" : room.joinLocked ? "joins locked" : "joins open";
    button.innerHTML = `<strong>${escapeHtml(room.title)}</strong><span>${escapeHtml(room.code)} · ${room.studentCount} students · ${accessLabel}</span>`;
    button.addEventListener("click", () => resumeTeacherRoom(room));
    elements.classroomList.append(button);
  });
}

async function resumeTeacherRoom(room) {
  if (state.roomCode !== room.code) state.openStudentCards.clear();
  state.roomCode = room.code;
  state.studentId = null;
  state.studentToken = null;
  state.student = null;
  await refreshActiveView();
  if (state.room) {
    saveSession();
    startPolling();
  }
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function resetTeacherSession() {
  stopPolling();
  state.authUser = null;
  state.teacher = null;
  state.teacherSession = null;
  state.teacherToken = null;
  state.roomCode = null;
  state.room = null;
  state.studentId = null;
  state.studentToken = null;
  state.student = null;
  state.monitorFilter = "all";
  state.openStudentCards.clear();
  clearSession();
  renderTeacherIdentity();
  elements.classroomList.innerHTML = "";
  elements.teacherError.textContent = "";
  showView("empty");
  setRole("teacher");
  renderAuthAccess();
}

function resetStudentSession() {
  stopPolling();
  state.roomCode = null;
  state.teacherToken = null;
  state.room = null;
  state.studentId = null;
  state.studentToken = null;
  state.student = null;
  clearSession();
  elements.joinError.textContent = "";
  showView("empty");
  setRole("student");
  renderAuthAccess();
}

async function signOut() {
  try {
    await apiRequest("/api/auth/logout", { method: "POST" });
  } catch {
    // Local cleanup still leaves the browser in a safe signed-out state for this app.
  }
  resetTeacherSession();
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

function parseLines(value) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseTestQuestions(value) {
  return parseLines(value).map((line, index) => {
    const parts = line.split("|").map((part) => part.trim());
    const prompt = parts[0] || "";
    const keywords = parts[1] || "";
    const rubric = parts.length > 3 ? parts[3] : parts[2] || "";
    return {
      id: `q-${index + 1}`,
      prompt,
      rubric,
      keywords: keywords
        .split(",")
        .map((keyword) => keyword.trim().toLowerCase())
        .filter(Boolean),
    };
  });
}

function serializeTestQuestions(questions) {
  return questions
    .map((question) => {
      const parts = [question.prompt, question.keywords.join(", ")];
      if (question.rubric) parts.push(question.rubric);
      return parts.join(" | ");
    })
    .join("\n");
}

function serializeAnswerKeys(questions) {
  return questions.map((question) => question.expectedAnswer || "").join("\n");
}

function scoreLatestTest(room, student) {
  if (!student.testAttempts.length) return null;
  const attempt = student.testAttempts[student.testAttempts.length - 1];
  const reviewed = attempt.results.filter((result) => result.review?.reveal).length;
  const correct = attempt.results.filter((result) => result.review?.reveal && result.correct).length;
  return {
    correct,
    total: room.testQuestions.length,
    reviewed,
    percent: room.testQuestions.length ? Math.round((correct / room.testQuestions.length) * 100) : 0,
  };
}

function latestMissingConcepts(student) {
  if (Array.isArray(student.missingConcepts)) return student.missingConcepts;
  const attempt = student.testAttempts.at(-1);
  if (!attempt) return [];

  return attempt.results
    .flatMap((result) => result.missingWords || [])
    .filter((word, index, words) => words.indexOf(word) === index);
}

function setRole(role) {
  state.role = role;
  elements.teacherTab.classList.toggle("is-active", role === "teacher");
  elements.studentTab.classList.toggle("is-active", role === "student");
  elements.teacherTab.setAttribute("aria-selected", role === "teacher");
  elements.studentTab.setAttribute("aria-selected", role === "student");
  elements.teacherForm.classList.toggle("is-hidden", role !== "teacher");
  elements.studentForm.classList.toggle("is-hidden", role !== "student");
  renderAuthAccess();
}

function showView(view) {
  elements.emptyState.classList.toggle("is-hidden", view !== "empty");
  elements.teacherView.classList.toggle("is-hidden", view !== "teacher");
  elements.studentView.classList.toggle("is-hidden", view !== "student");
}

function startPolling() {
  clearInterval(state.pollTimer);
  if (!state.roomCode) return;
  state.pollTimer = setInterval(refreshActiveView, 2500);
}

async function refreshActiveView() {
  if (!state.roomCode) return;

  try {
    if (state.studentId) {
      const payload = await apiRequest(
        `/api/classrooms/${encodeURIComponent(state.roomCode)}/students/${encodeURIComponent(state.studentId)}`,
        { headers: studentHeaders() },
      );
      state.room = payload.room;
      state.student = payload.student;
      renderStudent(state.room, state.student);
    } else {
      const payload = await apiRequest(`/api/classrooms/${encodeURIComponent(state.roomCode)}`, {
        headers: teacherHeaders(),
      });
      state.room = payload.room;
      state.teacherToken = payload.teacherToken || state.teacherToken;
      renderTeacher(state.room);
    }
  } catch (error) {
    stopPolling();
    clearSession();
    showView("empty");
    elements.joinError.textContent = error.message;
    elements.teacherError.textContent = error.message;
  }
}

function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function maybeUpdateConfigFields(room) {
  const focused = document.activeElement;
  const isEditingConfig =
    focused === elements.liveClassTitle ||
    focused === elements.liveSystemPrompt ||
    focused === elements.livePeerChallenge ||
    focused === elements.liveObjectives ||
    focused === elements.liveTestQuestions ||
    focused === elements.liveAnswerKeys;

  if (isEditingConfig) return;
  elements.liveClassTitle.value = room.title;
  elements.liveSystemPrompt.value = room.systemPrompt;
  elements.livePeerChallenge.value = room.peerChallenge || "balanced";
  elements.liveObjectives.value = room.objectives.join("\n");
  elements.liveTestQuestions.value = serializeTestQuestions(room.testQuestions);
  elements.liveAnswerKeys.value = serializeAnswerKeys(room.testQuestions);
}

function renderTeacher(room) {
  if (!room) {
    showView("empty");
    return;
  }

  showView("teacher");
  elements.roomCode.textContent = room.code;
  elements.teacherRoomTitle.textContent = room.title;
  elements.teacherProvider.textContent = providerLabel(room.peerProvider);
  elements.joinLockButton.textContent = room.joinLocked ? "Unlock joins" : "Lock joins";
  elements.joinLockButton.setAttribute("aria-pressed", String(Boolean(room.joinLocked)));
  elements.joinLockButton.classList.toggle("is-locked", Boolean(room.joinLocked));
  elements.activityToggleButton.textContent = room.activityClosed ? "Resume activity" : "Close activity";
  elements.activityToggleButton.setAttribute("aria-pressed", String(Boolean(room.activityClosed)));
  elements.activityToggleButton.classList.toggle("is-locked", Boolean(room.activityClosed));
  maybeUpdateConfigFields(room);

  const students = room.students || [];
  elements.studentCount.textContent = `${students.length} active`;
  renderClassSummary(room.analytics, students.length);
  renderMonitorFilters(students);
  elements.studentList.innerHTML = "";

  if (!students.length) {
    const empty = document.createElement("p");
    empty.className = "form-note";
    empty.textContent = "No students have joined yet. Share the classroom code to start monitoring progress.";
    elements.studentList.append(empty);
    return;
  }

  const filteredStudents = filterStudents(students);
  if (!filteredStudents.length) {
    const empty = document.createElement("p");
    empty.className = "form-note";
    empty.textContent = `No students match ${monitorFilterLabel(state.monitorFilter).toLowerCase()}.`;
    elements.studentList.append(empty);
    return;
  }

  filteredStudents.forEach((student) => {
    const latest = student.latestScore;
    const status = displayStatus(student.status);
    const card = document.createElement("details");
    card.className = "student-card student-monitor-card";
    card.dataset.studentId = student.id;
    card.open = state.openStudentCards.has(student.id);
    card.innerHTML = `
      <summary>
        <span class="student-card-main">
          <span class="student-card-header">
            <strong>${escapeHtml(student.name)}</strong>
            <span class="status-chip ${
              student.status === "Needs correction" ? "review" : student.status === "Arena ranked" || student.status === "Test ready" ? "ready" : ""
            }">${status}</span>
          </span>
          <span class="metric-row">
            <span class="metric"><strong>${student.teachingTurns + student.peerTurns}</strong><span>conversation rounds</span></span>
            <span class="metric"><strong>${student.objectiveCoverage}%</strong><span>coverage</span></span>
            <span class="metric"><strong>${latest ? `${latest.correct}/${latest.total}` : "0/0"}</strong><span>latest arena</span></span>
          </span>
          <span class="student-card-note">${
            latest ? `Arena attempt ${student.testAttempts}: ${latest.percent}%. ${latest.percent < 100 ? "Needs targeted coaching." : "Ready for extension."}` : "No arena submission yet."
          }</span>
          ${
            student.correctionTurns
              ? `<span class="correction-strip"><strong>${student.correctionTurns}</strong><span>coaching turns after arena</span></span>`
              : ""
          }
        </span>
      </summary>
      ${renderTeacherStudentDetails(student)}
    `;
    card.addEventListener("toggle", () => {
      if (card.open) {
        state.openStudentCards.add(student.id);
      } else {
        state.openStudentCards.delete(student.id);
      }
    });
    elements.studentList.append(card);
  });
}

function filterStudents(students, filter = state.monitorFilter) {
  return students.filter((student) => {
    if (filter === "all") return true;
    if (filter === "readiness-open") {
      return Boolean(student.latestReadiness?.missingObjectives?.length);
    }
    if (filter === "correction") {
      return student.status === "Needs correction" || student.status === "Correcting";
    }
    if (filter === "test-ready") {
      return student.status === "Arena ranked" || student.status === "Test ready";
    }
    return true;
  });
}

function renderMonitorFilters(students = []) {
  elements.monitorFilters.querySelectorAll("[data-filter]").forEach((button) => {
    const active = button.dataset.filter === state.monitorFilter;
    const filter = button.dataset.filter;
    const count = filterStudents(students, filter).length;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
    button.innerHTML = `${monitorFilterLabel(filter)} <span>${count}</span>`;
  });
}

function monitorFilterLabel(filter) {
  const labels = {
    all: "All students",
    "readiness-open": "Readiness open",
    correction: "Correction",
    "test-ready": "Ranked",
  };
  return labels[filter] || labels.all;
}

function renderClassSummary(analytics, studentCount) {
  const summary =
    analytics ||
    {
      totalStudents: studentCount,
      teaching: 0,
      needsCorrection: 0,
      testReady: 0,
      tested: 0,
      readinessChecked: 0,
      readinessReady: 0,
      readinessOpen: 0,
      averageCoverage: 0,
      averageScore: 0,
    };

  elements.classSummary.innerHTML = `
    <div class="summary-tile"><strong>${summary.totalStudents}</strong><span>students</span></div>
    <div class="summary-tile"><strong>${summary.averageCoverage}%</strong><span>avg coverage</span></div>
    <div class="summary-tile"><strong>${summary.tested ? `${summary.averageScore}%` : "-"}</strong><span>avg arena</span></div>
    <div class="summary-tile ready"><strong>${summary.readinessReady}</strong><span>ready check</span></div>
    <div class="summary-tile attention"><strong>${summary.readinessOpen}</strong><span>readiness open</span></div>
    <div class="summary-tile attention"><strong>${summary.needsCorrection}</strong><span>correcting</span></div>
    <div class="summary-tile ready"><strong>${summary.testReady}</strong><span>ranked</span></div>
  `;
  renderLeaderboard(elements.teacherLeaderboard, analytics?.leaderboard || []);
}

function renderTeacherStudentDetails(student) {
  const missing = latestMissingConcepts(student);
  const messages = student.messageHistory || student.recentMessages || [];
  const attempts = student.attemptHistory || [];
  const readinessChecks = student.readinessHistory || [];

  return `
    <div class="student-detail">
      ${renderObjectiveProgress(student.objectiveProgress || [])}
      ${
        missing.length
          ? `<div class="missing-list">${missing.map((word) => `<span>${escapeHtml(word)}</span>`).join("")}</div>`
          : `<p class="form-note">No missing concepts from the latest arena submission.</p>`
      }
      ${renderReadinessHistory(readinessChecks)}
      ${renderAttemptHistory(attempts)}
      ${renderMessageHistory(messages)}
    </div>
  `;
}

function renderReadinessHistory(checks) {
  if (!checks.length) {
    return `<p class="form-note">No readiness checks yet.</p>`;
  }

  return `
    <div class="readiness-history">
      ${checks
        .map(
          (check, index) => `
            <article class="readiness-record">
              <header>
                <strong>Readiness ${index + 1}</strong>
                <span>${(check.missingObjectives || []).length ? `${check.missingObjectives.length} open` : "ready"}</span>
              </header>
              <p>${escapeHtml(check.summary)}</p>
            </article>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderAttemptHistory(attempts) {
  if (!attempts.length) {
    return `<p class="form-note">No arena submissions yet.</p>`;
  }

  return `
    <div class="attempt-history">
      ${attempts
        .map((attempt, index) => {
          const correct = attempt.results.filter((result) => result.correct).length;
          return `
            <article class="attempt-record">
              <header>
                <strong>Arena ${index + 1}</strong>
                <span>${correct}/${attempt.results.length}</span>
              </header>
              <div class="attempt-results">
                ${attempt.results
                  .map(
                    (result, resultIndex) => `
                      <span class="${result.correct ? "ready" : "review"}">Q${resultIndex + 1}: ${
                        result.correct ? "correct" : `missing ${escapeHtml((result.missingWords || []).join(", ") || "evidence")}`
                      }</span>
                    `,
                  )
                  .join("")}
              </div>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderMessageHistory(messages) {
  if (!messages.length) return "";

  return `
    <div class="message-history">
      ${messages
        .map(
          (message) => `
            <p class="history-message ${message.sender}">
              <strong>${message.sender === "peer" ? "Peer" : message.sender === "student" ? "Student" : "System"}</strong>
              ${escapeHtml(message.text)}
            </p>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderStudent(room, student, options = {}) {
  if (!room || !student) {
    showView("empty");
    return;
  }

  showView("student");
  elements.studentRoomCode.textContent = `Classroom ${room.code}`;
  elements.studentRoomTitle.textContent = room.title;
  elements.studentProvider.textContent = providerLabel(room.peerProvider);
  const activityClosed = Boolean(room.activityClosed);
  elements.chatInput.disabled = activityClosed;
  elements.chatSubmitButton.disabled = activityClosed;
  elements.readinessCheckButton.disabled = activityClosed;
  elements.startTestButton.disabled = activityClosed;
  elements.chatInput.placeholder = "";
  elements.objectiveList.innerHTML = "";
  const progress = student.objectiveProgress || room.objectives.map((objective) => ({ text: objective, covered: false }));
  progress.forEach((objective) => {
    const item = document.createElement("li");
    item.className = objective.covered ? "objective-covered" : "";
    item.innerHTML = `
      <span>${escapeHtml(objective.text)}</span>
      <small>${objective.covered ? `Taught: ${escapeHtml((objective.matchedTerms || []).join(", "))}` : "Not evidenced yet"}</small>
    `;
    elements.objectiveList.append(item);
  });

  const latest = scoreLatestTest(room, student);
  elements.studentScore.textContent = latest
    ? latest.reviewed < latest.total
      ? `${latest.reviewed}/${latest.total} reviewed`
      : `${latest.correct}/${latest.total} arena`
    : "No score";
  elements.testState.textContent = displayStatus(student.status);
  renderLeaderboard(elements.studentLeaderboard, room.arenaLeaderboard || []);
  const restoreChatPosition = renderChat(student.messages, options);
  renderTest(room, student);
  renderMath(elements.studentView, restoreChatPosition);
}

function renderChat(messages, options = {}) {
  const scrollState = getChatScrollState(Boolean(options.forceChatScroll));
  elements.chatLog.innerHTML = "";
  messages.forEach((message) => {
    const bubble = document.createElement("div");
    bubble.className = `message ${message.sender}`;
    const label = message.sender === "peer" ? "Peer LLM" : message.sender === "student" ? "You" : "System";
    bubble.innerHTML = `<strong>${label}</strong>${escapeHtml(message.text)}`;
    elements.chatLog.append(bubble);
  });
  return restoreChatScroll(scrollState);
}

function getChatScrollState(forceScroll) {
  const { scrollTop, scrollHeight, clientHeight } = elements.chatLog;
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
  return {
    capturedAt: performance.now(),
    forceScroll,
    shouldStickToBottom: forceScroll || distanceFromBottom < 56,
    scrollTop,
    scrollHeight,
  };
}

function restoreChatScroll(scrollState) {
  let restoredOnce = false;
  const restore = () => {
    if (restoredOnce && state.chatScrollTouchedAt > scrollState.capturedAt) return;

    state.isRestoringChatScroll = true;
    if (scrollState.shouldStickToBottom) {
      elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
    } else {
      const heightDelta = elements.chatLog.scrollHeight - scrollState.scrollHeight;
      elements.chatLog.scrollTop = Math.max(0, scrollState.scrollTop + heightDelta);
    }

    restoredOnce = true;
    requestAnimationFrame(() => {
      state.isRestoringChatScroll = false;
    });
  };

  restore();
  return restore;
}

function renderMath(target, afterTypeset) {
  if (!window.MathJax?.typesetPromise) {
    afterTypeset?.();
    return;
  }
  window.MathJax.typesetClear?.([target]);
  window.MathJax
    .typesetPromise([target])
    .catch(() => {
      // If MathJax cannot parse one expression, leave the original text visible.
    })
    .finally(() => {
      afterTypeset?.();
    });
}

function renderTest(room, student) {
  elements.testResults.innerHTML = "";
  if (room.activityClosed) {
    const notice = document.createElement("div");
    notice.className = "correction-focus";
    notice.innerHTML = `
      <strong>Activity closed</strong>
      <p>Activity closed. Review only.</p>
    `;
    elements.testResults.append(notice);
  }

  renderReadinessCheck(student);

  if (!student.testAttempts.length) {
    const empty = document.createElement("p");
    empty.className = "form-note";
    empty.textContent = "No arena submissions yet.";
    elements.testResults.append(empty);
    return;
  }

  const attempt = student.testAttempts[student.testAttempts.length - 1];
  renderArenaSummary(room, attempt);

  const missingConcepts = latestMissingConcepts(student);
  if (missingConcepts.length) {
    const focus = document.createElement("div");
    focus.className = "correction-focus";
    focus.innerHTML = `
      <strong>Coach next</strong>
      <p>Missed: ${escapeHtml(missingConcepts.join(", "))}</p>
    `;
    elements.testResults.append(focus);
  }

  attempt.results.forEach((result, index) => {
    const question = room.testQuestions[index];
    const review = result.review || {};
    const reveal = Boolean(review.reveal);
    const selectedCorrect = review.verdict === "correct";
    const selectedWrong = review.verdict === "wrong";
    const card = document.createElement("article");
    card.className = `result-card ${reveal ? (result.correct ? "is-correct" : "needs-coaching") : "needs-review"}`;
    card.innerHTML = `
      <header>
        <strong>Problem ${index + 1}</strong>
        <span class="status-chip ${reveal && result.correct ? "ready" : reveal ? "review" : ""}">${
          reveal ? (result.correct ? "Correct" : "Needs coaching") : "Self-check"
        }</span>
      </header>
      <p>${escapeHtml(question.prompt)}</p>
      <strong class="answer-label">Peer solution</strong>
      <p class="answer">${escapeHtml(result.answer)}</p>
      <div class="self-check-actions" role="group" aria-label="Mark problem ${index + 1}">
        <button class="ghost-action self-check-button ${selectedCorrect ? "is-selected" : ""}" type="button" ${reveal ? "disabled" : ""} data-attempt-id="${escapeHtml(
          attempt.id,
        )}" data-result-index="${index}" data-verdict="correct">Correct</button>
        <button class="ghost-action self-check-button ${selectedWrong ? "is-selected" : ""}" type="button" ${reveal ? "disabled" : ""} data-attempt-id="${escapeHtml(
          attempt.id,
        )}" data-result-index="${index}" data-verdict="wrong">Wrong</button>
      </div>
      ${review.hint ? `<p class="fairy-hint">${escapeHtml(review.hint)}</p>` : ""}
      ${
        reveal && result.missingWords.length
          ? `<p class="missing">Teach again: ${escapeHtml(result.missingWords.join(", "))}</p>`
          : ""
      }
    `;
    elements.testResults.append(card);
  });
}

function renderArenaSummary(room, attempt) {
  const total = room.testQuestions.length;
  const reviewed = attempt.results.filter((result) => result.review?.reveal).length;
  const correct = attempt.results.filter((result) => result.review?.reveal && result.correct).length;
  const summary = document.createElement("article");
  summary.className = "arena-review";
  summary.innerHTML = `
    <header>
      <strong>Latest self-review</strong>
      <span>${reviewed}/${total}</span>
    </header>
    <ol>
      ${attempt.results
        .map((result, index) => {
          const reveal = Boolean(result.review?.reveal);
          return `
            <li class="${reveal ? (result.correct ? "is-correct" : "needs-coaching") : "needs-review"}">
              <span>Problem ${index + 1}</span>
              <strong>${reveal ? (result.correct ? "Correct" : "Needs coaching") : "Self-check"}</strong>
            </li>
          `;
        })
        .join("")}
    </ol>
  `;
  elements.testResults.append(summary);
}

function renderReadinessCheck(student) {
  const check = (student.readinessChecks || []).at(-1);
  if (!check) return;

  const card = document.createElement("article");
  card.className = "readiness-card";
  card.innerHTML = `
    <header>
      <strong>Readiness</strong>
      <span>${(check.missingObjectives || []).length ? `${check.missingObjectives.length} open` : "Ready"}</span>
    </header>
    <p>${escapeHtml(check.summary)}</p>
  `;
  elements.testResults.append(card);
}

function renderLeaderboard(target, leaderboard) {
  if (!target) return;
  if (!leaderboard.length) {
    target.innerHTML = `<div class="leaderboard-empty">No arena scores</div>`;
    return;
  }

  target.innerHTML = `
    <header><strong>Top 5 arena</strong></header>
    <ol>
      ${leaderboard
        .map(
          (entry) => `
            <li>
              <span>${entry.rank}</span>
              <strong>${escapeHtml(entry.name)}</strong>
              <em>${entry.percent}%</em>
            </li>
          `,
        )
        .join("")}
    </ol>
  `;
}

function displayStatus(status) {
  if (status === "Test ready" || status === "Arena ranked") return "Arena ranked";
  if (status === "Needs correction") return "Coaching";
  return status;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderObjectiveProgress(progress) {
  if (!progress.length) return "";
  return `
    <div class="objective-progress">
      ${progress
        .map(
          (objective) => `
            <div class="objective-pill ${objective.covered ? "covered" : ""}">
              <strong>${objective.covered ? "Covered" : "Open"}</strong>
              <span>${escapeHtml(objective.text)}</span>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function providerLabel(provider) {
  if (!provider) return "Peer: simulator";
  return provider.mode === "openrouter" ? `Peer: ${provider.model}` : "Peer: simulator";
}

function setBusy(button, busyText, options = {}) {
  const previousText = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  button.classList.add("is-busy");
  if (options.waiting) button.classList.add("is-waiting");
  return () => {
    button.disabled = false;
    button.classList.remove("is-busy", "is-waiting");
    if (button.textContent === busyText) button.textContent = previousText;
  };
}

elements.teacherTab.addEventListener("click", () => setRole("teacher"));
elements.studentTab.addEventListener("click", () => setRole("student"));

elements.teacherForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.teacherError.textContent = "";
  if (state.authEnabled) {
    if (!state.authUser) {
      beginMicrosoftSignIn("teacher");
      return;
    }
    if (state.authUser.role !== "teacher") {
      elements.teacherError.textContent = "This Microsoft account is classified as a student account.";
      return;
    }
  }
  const restore = setBusy(event.submitter, "Opening...");

  try {
    const payload = await apiRequest("/api/classrooms", {
      method: "POST",
      headers: teacherHeaders(),
      body: JSON.stringify({
        title: document.querySelector("#classTitle").value.trim(),
        systemPrompt: document.querySelector("#systemPrompt").value.trim(),
        peerChallenge: document.querySelector("#peerChallenge").value,
        objectives: parseLines(document.querySelector("#objectives").value),
        testQuestions: parseTestQuestions(document.querySelector("#testQuestions").value),
        answerKeys: parseLines(document.querySelector("#answerKeys").value),
      }),
    });
    state.room = payload.room;
    state.teacherToken = payload.teacherToken;
    state.roomCode = payload.room.code;
    state.studentId = null;
    state.studentToken = null;
    state.student = null;
    renderTeacher(state.room);
    saveSession();
    renderTeacherIdentity();
    await loadTeacherClassrooms();
    startPolling();
  } catch (error) {
    elements.teacherError.textContent = error.message;
  } finally {
    restore();
  }
});

elements.studentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.joinError.textContent = "";
  if (state.authEnabled) {
    if (!state.authUser) {
      beginMicrosoftSignIn("student");
      return;
    }
    if (state.authUser.role !== "student") {
      elements.joinError.textContent = "This Microsoft account is classified as a teacher account.";
      return;
    }
  }
  const restore = setBusy(event.submitter, "Joining...");

  try {
    const code = document.querySelector("#joinCode").value.trim().toUpperCase();
    const fallbackName = state.authEnabled ? state.authUser.name || state.authUser.email : window.prompt("Student name");
    if (!fallbackName) return;
    const payload = await apiRequest(`/api/classrooms/${encodeURIComponent(code)}/students`, {
      method: "POST",
      body: JSON.stringify({
        name: fallbackName,
      }),
    });
    state.room = payload.room;
    state.student = payload.student;
    state.roomCode = payload.room.code;
    state.teacherToken = null;
    state.studentId = payload.student.id;
    state.studentToken = payload.studentToken;
    renderStudent(state.room, state.student, { forceChatScroll: true });
    saveSession();
    startPolling();
  } catch (error) {
    elements.joinError.textContent = error.message;
  } finally {
    restore();
  }
});

elements.teacherLoginButton.addEventListener("click", teacherLogin);
elements.studentLoginButton.addEventListener("click", () => beginMicrosoftSignIn("student"));

elements.saveConfigButton.addEventListener("click", async () => {
  if (!state.roomCode) return;
  elements.teacherError.textContent = "";
  const restore = setBusy(elements.saveConfigButton, "Saving...");

  try {
    const payload = await apiRequest(`/api/classrooms/${encodeURIComponent(state.roomCode)}/config`, {
      method: "PATCH",
      headers: teacherHeaders(),
      body: JSON.stringify({
        title: elements.liveClassTitle.value.trim(),
        systemPrompt: elements.liveSystemPrompt.value.trim(),
        peerChallenge: elements.livePeerChallenge.value,
        objectives: parseLines(elements.liveObjectives.value),
        testQuestions: parseTestQuestions(elements.liveTestQuestions.value),
        answerKeys: parseLines(elements.liveAnswerKeys.value),
      }),
    });
    state.room = payload.room;
    renderTeacher(state.room);
    saveSession();
  } catch (error) {
    elements.teacherError.textContent = error.message;
  } finally {
    restore();
  }
});

elements.monitorFilters.addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  state.monitorFilter = button.dataset.filter;
  if (state.room) renderTeacher(state.room);
});

elements.joinLockButton.addEventListener("click", async () => {
  if (!state.roomCode || !state.room) return;
  elements.teacherError.textContent = "";
  const nextLocked = !state.room.joinLocked;
  const restore = setBusy(elements.joinLockButton, nextLocked ? "Locking..." : "Opening...");

  try {
    const payload = await apiRequest(`/api/classrooms/${encodeURIComponent(state.roomCode)}/access`, {
      method: "PATCH",
      headers: teacherHeaders(),
      body: JSON.stringify({ joinLocked: nextLocked }),
    });
    state.room = payload.room;
    renderTeacher(state.room);
    saveSession();
    await loadTeacherClassrooms();
  } catch (error) {
    elements.teacherError.textContent = error.message;
  } finally {
    restore();
  }
});

elements.activityToggleButton.addEventListener("click", async () => {
  if (!state.roomCode || !state.room) return;
  elements.teacherError.textContent = "";
  const nextClosed = !state.room.activityClosed;
  const restore = setBusy(elements.activityToggleButton, nextClosed ? "Closing..." : "Resuming...");

  try {
    const payload = await apiRequest(`/api/classrooms/${encodeURIComponent(state.roomCode)}/access`, {
      method: "PATCH",
      headers: teacherHeaders(),
      body: JSON.stringify({ activityClosed: nextClosed }),
    });
    state.room = payload.room;
    renderTeacher(state.room);
    saveSession();
    await loadTeacherClassrooms();
  } catch (error) {
    elements.teacherError.textContent = error.message;
  } finally {
    restore();
  }
});

elements.teacherSignOutButton.addEventListener("click", signOut);

elements.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = elements.chatInput.value.trim();
  if (!text || !state.roomCode || !state.studentId) return;
  const restore = setBusy(event.submitter, "Thinking...");

  try {
    const payload = await apiRequest(
      `/api/classrooms/${encodeURIComponent(state.roomCode)}/students/${encodeURIComponent(state.studentId)}/messages`,
      {
        method: "POST",
        headers: studentHeaders(),
        body: JSON.stringify({ text }),
      },
    );
    elements.chatInput.value = "";
    state.room = payload.room;
    state.student = payload.student;
    renderStudent(state.room, state.student, { forceChatScroll: true });
    saveSession();
  } catch (error) {
    renderSystemMessage(error.message);
  } finally {
    restore();
  }
});

elements.readinessCheckButton.addEventListener("click", async () => {
  if (!state.roomCode || !state.studentId) return;
  const restore = setBusy(elements.readinessCheckButton, "Checking...");

  try {
    const payload = await apiRequest(
      `/api/classrooms/${encodeURIComponent(state.roomCode)}/students/${encodeURIComponent(state.studentId)}/readiness-checks`,
      { method: "POST", headers: studentHeaders() },
    );
    state.room = payload.room;
    state.student = payload.student;
    renderStudent(state.room, state.student, { forceChatScroll: true });
    saveSession();
  } catch (error) {
    renderSystemMessage(error.message);
  } finally {
    restore();
  }
});

elements.startTestButton.addEventListener("click", async () => {
  if (!state.roomCode || !state.studentId) return;
  const restore = setBusy(elements.startTestButton, "Submitting...", { waiting: true });

  try {
    const payload = await apiRequest(
      `/api/classrooms/${encodeURIComponent(state.roomCode)}/students/${encodeURIComponent(state.studentId)}/test-attempts`,
      { method: "POST", headers: studentHeaders() },
    );
    state.room = payload.room;
    state.student = payload.student;
    renderStudent(state.room, state.student, { forceChatScroll: true });
    saveSession();
  } catch (error) {
    renderSystemMessage(error.message);
  } finally {
    restore();
  }
});

elements.testResults.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-verdict]");
  if (!button || !state.roomCode || !state.studentId) return;
  const { attemptId, resultIndex, verdict } = button.dataset;
  const restore = setBusy(button, "Checking...");

  try {
    const payload = await apiRequest(
      `/api/classrooms/${encodeURIComponent(state.roomCode)}/students/${encodeURIComponent(
        state.studentId,
      )}/test-attempts/${encodeURIComponent(attemptId)}/results/${encodeURIComponent(resultIndex)}/assessment`,
      {
        method: "POST",
        headers: studentHeaders(),
        body: JSON.stringify({ verdict }),
      },
    );
    state.room = payload.room;
    state.student = payload.student;
    renderStudent(state.room, state.student);
    saveSession();
  } catch (error) {
    renderSystemMessage(error.message);
  } finally {
    restore();
  }
});

elements.studentLeaveButton.addEventListener("click", resetStudentSession);

elements.chatLog.addEventListener("scroll", () => {
  if (state.isRestoringChatScroll) return;
  state.chatScrollTouchedAt = performance.now();
});

function renderSystemMessage(text) {
  const bubble = document.createElement("div");
  bubble.className = "message system";
  bubble.innerHTML = `<strong>System</strong>${escapeHtml(text)}`;
  elements.chatLog.append(bubble);
  renderMath(bubble);
  elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
}

setRole("teacher");
showView("empty");

async function restoreSession() {
  await loadAuthState();
  const authError = new URLSearchParams(window.location.search).get("authError");
  if (authError) {
    elements.teacherError.textContent = authError;
    elements.joinError.textContent = authError;
  }

  const session = loadSession();
  if (state.authEnabled && !state.authUser) {
    clearSession();
    return;
  }

  if (!session) {
    if (state.authUser?.role === "teacher" && state.teacher) {
      setRole("teacher");
      renderTeacherIdentity();
      await loadTeacherClassrooms();
    } else if (state.authUser?.role === "student") {
      setRole("student");
    }
    return;
  }

  state.roomCode = session.roomCode || null;
  state.teacher = state.authUser?.role === "teacher" ? state.authUser.teacher : session.teacher || null;
  state.teacherSession = state.authUser?.role === "teacher" ? "microsoft-sso" : session.teacherSession || null;
  state.teacherToken = session.teacherToken || null;
  state.studentId = session.studentId || null;
  state.studentToken = session.studentToken || null;

  if (session.role === "student" && state.studentId && state.studentToken && (!state.authEnabled || state.authUser?.role === "student")) {
    setRole("student");
  } else if (session.role === "teacher" && state.teacher && state.teacherSession && (!state.authEnabled || state.authUser?.role === "teacher")) {
    setRole("teacher");
    renderTeacherIdentity();
    await loadTeacherClassrooms();
  } else {
    clearSession();
    return;
  }

  if (state.roomCode) {
    await refreshActiveView();
    if (state.room) startPolling();
  }
}

restoreSession().catch((error) => {
  clearSession();
  elements.teacherError.textContent = error.message;
});
