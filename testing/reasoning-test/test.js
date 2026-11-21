const intro = document.getElementById("intro");
const question = document.getElementById("question");
const finished = document.getElementById("finished");
const progress = document.getElementById("progress");
const title = document.getElementById("question-title");
const body = document.getElementById("question-body");
const response = document.getElementById("response");
const submit = document.getElementById("submit-answer");
const stuck = document.getElementById("mark-stuck");
const stuckStatus = document.getElementById("stuck-status");

let startTime;
let index = 0;
let markedStuck = false;
const events = [];

function record(event, details = {}) {
  events.push({
    event,
    timestamp_utc: new Date().toISOString(),
    elapsed_ms: Math.round(performance.now() - startTime),
    ...details
  });
}

function textElement(tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

function displayTable({ headers, rows }) {
  const table = document.createElement("table");
  const headerRow = table.createTHead().insertRow();
  for (const label of headers) {
    const heading = textElement("th", label);
    heading.scope = "col";
    headerRow.append(heading);
  }
  const tableBody = table.createTBody();
  for (const values of rows) {
    const row = tableBody.insertRow();
    row.append(...values.map(value => textElement("td", value)));
  }
  return table;
}

function displayQuestion() {
  const current = QUESTIONS[index];
  progress.textContent = `Question ${index + 1} of ${QUESTIONS.length}`;
  title.textContent = current.title;
  body.replaceChildren(textElement("p", current.description));
  if (current.rules) {
    const rules = document.createElement("ul");
    rules.append(...current.rules.map(rule => textElement("li", rule)));
    body.append(rules);
  }
  if (current.table) body.append(displayTable(current.table));
  body.append(textElement("p", current.prompt));

  response.value = "";
  submit.disabled = true;
  markedStuck = false;
  stuck.setAttribute("aria-pressed", "false");
  stuckStatus.textContent = "";
  window.scrollTo(0, 0);
  title.focus({ preventScroll: true });
  record("question_shown", { question_id: current.id });
}

function displayFinish() {
  record("test_finished");
  question.hidden = true;
  finished.hidden = false;
  progress.textContent = "";
  const solutions = document.getElementById("solutions");
  for (const item of QUESTIONS) {
    const solution = document.createElement("li");
    solution.append(
      textElement("strong", item.title),
      textElement("p", item.answer),
      textElement("p", item.explanation)
    );
    solutions.append(solution);
  }
  window.scrollTo(0, 0);
  document.getElementById("finished-title").focus({ preventScroll: true });
}

function advance(event) {
  record(event, { question_id: QUESTIONS[index].id, response: response.value });
  index += 1;
  if (index < QUESTIONS.length) displayQuestion();
  else displayFinish();
}

document.getElementById("start").addEventListener("click", () => {
  startTime = performance.now();
  record("test_started");
  intro.hidden = true;
  question.hidden = false;
  displayQuestion();
});

response.addEventListener("input", () => {
  submit.disabled = response.value.trim() === "";
});

document.getElementById("answer-form").addEventListener("submit", event => {
  event.preventDefault();
  if (response.value.trim()) advance("answer_submitted");
});

stuck.addEventListener("click", () => {
  if (markedStuck) return;
  markedStuck = true;
  record("stuck_marked", { question_id: QUESTIONS[index].id });
  stuck.setAttribute("aria-pressed", "true");
  stuckStatus.textContent = "Stuck marker saved.";
});

document.getElementById("skip").addEventListener("click", () => advance("question_skipped"));

document.getElementById("download").addEventListener("click", () => {
  const session = {
    schema_version: 1,
    question_set: QUESTION_SET,
    events,
    answer_key: QUESTIONS.map(({ id, answer, explanation }) => ({ question_id: id, answer, explanation }))
  };
  const blob = new Blob([JSON.stringify(session, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const startedAt = events[0].timestamp_utc.replaceAll(":", "-");
  link.href = url;
  link.download = `reasoning-session-${startedAt}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
