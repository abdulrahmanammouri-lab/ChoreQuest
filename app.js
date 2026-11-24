(function () {
  "use strict";

  const CQ = window.ChoreQuest;
  const mount = document.getElementById("app");
  if (!CQ || !mount) return;

  const HOUSEHOLD_KEY = "chorequest.household";
  const LEGACY_KEY = "chorequest.v1";
  const ID_LENGTH = 6;
  const POLL_MS = 5000;
  const OFFLINE = "Can't reach the ChoreQuest server. Make sure it is running, then try again.";
  const PALETTE = ["#1f4d3a", "#c4552a", "#2d5572", "#6d3b4f", "#8a5a22", "#1f6a62"];
  const CHORE_HINTS = ["Take out trash", "Dishes", "Vacuum", "Bathroom", "Recycling", "Mop the floors"];

  let state = CQ.blankState();
  let householdId = "";
  let phase = "loading";
  let draft = null;
  let view = "week";
  let formError = "";
  let joinCode = "";
  let joinError = "";
  let banner = "";
  let bannerTone = "info";
  let focusSelector = "";
  let lastWeekKey = "";
  let lastAnnouncedMinute = -1;
  let saving = false;
  let pending = 0;
  let polling = false;
  let syncVersion = 0;

  function esc(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function plural(count, word) {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
  }

  function colorFor(id) {
    let hash = 0;
    for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
    return PALETTE[hash % PALETTE.length];
  }

  function initial(name) {
    const trimmed = name.trim();
    return trimmed ? trimmed[0].toUpperCase() : "?";
  }

  function cleanId(value) {
    return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  function readLocal(key) {
    try {
      return localStorage.getItem(key) || "";
    } catch {
      return "";
    }
  }

  function writeLocal(key, value) {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {
      // The household still works for this visit; the browser just won't remember it.
    }
  }

  function legacyState() {
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      const saved = CQ.normalize(raw ? JSON.parse(raw) : null);
      return saved.onboarded ? saved : null;
    } catch {
      return null;
    }
  }

  function setBanner(text, tone = "info") {
    banner = text;
    bannerTone = tone;
  }

  function defaultDraft() {
    const source = state.onboarded ? state : householdId ? null : legacyState();
    if (source) {
      return {
        apartmentName: source.apartmentName,
        roommates: source.roommates.map((person) => ({ ...person })),
        chores: source.chores.map((chore) => ({ ...chore })),
      };
    }
    return {
      apartmentName: "",
      roommates: [
        { id: CQ.uid(), name: "" },
        { id: CQ.uid(), name: "" },
      ],
      chores: [
        { id: CQ.uid(), name: "" },
        { id: CQ.uid(), name: "" },
        { id: CQ.uid(), name: "" },
      ],
    };
  }

  async function api(method, url, body) {
    const response = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  }

  function adopt(data) {
    householdId = data.id;
    writeLocal(HOUSEHOLD_KEY, householdId);
    state = CQ.normalize(data.state);
    CQ.refresh(state, new Date());
    lastWeekKey = state.onboarded ? CQ.weekKey(new Date()) : "";
    syncVersion += 1;
  }

  function forget(message) {
    householdId = "";
    writeLocal(HOUSEHOLD_KEY, "");
    state = CQ.blankState();
    view = "week";
    formError = "";
    joinError = "";
    lastWeekKey = "";
    syncVersion += 1;
    draft = defaultDraft();
    setBanner(message || "");
  }

  function formatRange(sunday) {
    const end = CQ.addDays(sunday, 6);
    const showYear = sunday.getFullYear() !== new Date().getFullYear() || end.getFullYear() !== sunday.getFullYear();
    const options = { weekday: "short", month: "short", day: "numeric" };
    if (showYear) options.year = "numeric";
    return `${sunday.toLocaleDateString(undefined, options)} – ${end.toLocaleDateString(undefined, options)}`;
  }

  function formatReset(now) {
    return CQ.nextReset(now).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function logo() {
    return `<svg class="mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#e6b15c"/><path d="M8 15.2 16 8l8 7.2V24a1 1 0 0 1-1 1h-5v-6h-4v6H9a1 1 0 0 1-1-1v-8.8z" fill="#17382c"/></svg>`;
  }

  function checkSvg() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 12.5 9.2 17 19 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function bannerHtml() {
    if (!banner) return "";
    return bannerTone === "error"
      ? `<p class="alert" role="alert">${esc(banner)}</p>`
      : `<p class="banner" role="status">${esc(banner)}</p>`;
  }

  function digitBlocks() {
    return ["days", "hours", "minutes", "seconds"]
      .map((unit) => `<div class="digit-block"><strong data-unit="${unit}">00</strong><span>${unit}</span></div>`)
      .join("");
  }

  function roommateRow(person, index, total) {
    return `<div class="editable person">
      <span class="slot">${index + 1}</span>
      <input type="text" maxlength="40" data-field="roommate" data-index="${index}" value="${esc(person.name)}" placeholder="Roommate ${index + 1}" aria-label="Roommate ${index + 1} name" autocomplete="off">
      <div class="icon-btns">
        <button type="button" data-action="move-roommate" data-index="${index}" data-delta="-1" ${index === 0 ? "disabled" : ""} aria-label="Move roommate ${index + 1} up">↑</button>
        <button type="button" data-action="move-roommate" data-index="${index}" data-delta="1" ${index === total - 1 ? "disabled" : ""} aria-label="Move roommate ${index + 1} down">↓</button>
      </div>
    </div>`;
  }

  function choreRow(chore, index, total) {
    const hint = CHORE_HINTS[index % CHORE_HINTS.length];
    return `<div class="editable">
      <input type="text" maxlength="60" data-field="chore" data-index="${index}" value="${esc(chore.name)}" placeholder="${esc(hint)}" aria-label="Chore ${index + 1}" autocomplete="off">
      <div class="icon-btns">
        <button type="button" data-action="move-chore" data-index="${index}" data-delta="-1" ${index === 0 ? "disabled" : ""} aria-label="Move chore ${index + 1} up">↑</button>
        <button type="button" data-action="move-chore" data-index="${index}" data-delta="1" ${index === total - 1 ? "disabled" : ""} aria-label="Move chore ${index + 1} down">↓</button>
        <button type="button" data-action="remove-chore" data-index="${index}" aria-label="Remove chore ${index + 1}">✕</button>
      </div>
    </div>`;
  }

  function formMarkup(mode) {
    const count = draft.roommates.length;
    const heading = mode === "welcome" ? `<h2>Create a household</h2>` : "";
    const imported = mode === "welcome" && legacyState()
      ? `<p class="hint">This is filled in from the household saved in this browser. Its history comes along when you create it.</p>`
      : "";
    return `<form class="household-form" data-form="household" novalidate autocomplete="off">
      ${formError ? `<p class="alert" role="alert">${esc(formError)}</p>` : ""}
      ${heading}
      <p class="hint">Type the chores and how many roommates share the place. Order is the rotation: each Sunday, every chore moves to the next person.</p>
      ${imported}
      <div class="field">
        <label for="apartment-name">Apartment name</label>
        <input id="apartment-name" type="text" maxlength="48" data-field="apartment" value="${esc(draft.apartmentName)}" placeholder="Maple Street">
      </div>
      <fieldset>
        <legend>Roommates</legend>
        <label for="roommate-count">Number of roommates</label>
        <div class="stepper">
          <button type="button" data-action="count" data-delta="-1" ${count <= 1 ? "disabled" : ""} aria-label="Fewer roommates">−</button>
          <input id="roommate-count" data-field="count" type="number" min="1" max="${CQ.MAX_ROOMMATES}" inputmode="numeric" value="${count}" aria-label="Number of roommates">
          <button type="button" data-action="count" data-delta="1" ${count >= CQ.MAX_ROOMMATES ? "disabled" : ""} aria-label="More roommates">+</button>
        </div>
        <p class="hint">Leave a name blank and it becomes Roommate 1, Roommate 2, and so on.</p>
        <div id="roommate-fields">
          ${draft.roommates.map((person, index) => roommateRow(person, index, count)).join("")}
        </div>
      </fieldset>
      <fieldset>
        <legend>Chores</legend>
        <p class="hint">Every chore is on the board each week. Empty rows are ignored.</p>
        <div id="chore-fields">
          ${draft.chores.map((chore, index) => choreRow(chore, index, draft.chores.length)).join("")}
        </div>
        <button type="button" class="btn secondary" data-action="add-chore" ${draft.chores.length >= CQ.MAX_CHORES ? "disabled" : ""}>Add a chore</button>
      </fieldset>
      <div class="form-actions">
        <button class="btn" type="submit">${mode === "welcome" ? "Create household" : "Save household"}</button>
        ${state.onboarded ? `<button class="btn secondary" type="button" data-action="leave">Leave on this device</button>` : ""}
        ${state.onboarded ? `<button class="btn danger" type="button" data-action="reset">Delete household</button>` : ""}
      </div>
    </form>`;
  }

  function joinMarkup() {
    return `<form class="join-form" data-form="join" novalidate autocomplete="off">
      <label for="join-id">Already have a household? Enter ID</label>
      <div class="join-row">
        <input id="join-id" type="text" data-field="join" value="${esc(joinCode)}" placeholder="6 letters and numbers" autocapitalize="characters" spellcheck="false" aria-describedby="join-help">
        <button class="btn" type="submit">Join</button>
      </div>
      <p class="hint" id="join-help">Whoever created the household can find the ID on its dashboard.</p>
      ${joinError ? `<p class="alert" role="alert">${esc(joinError)}</p>` : ""}
    </form>
    <p class="divider"><span>or create a new one</span></p>`;
  }

  function welcome() {
    return `<div class="welcome">
      <section class="welcome-story">
        <div>
          ${logo()}
          <p class="eyebrow light">Shared apartment</p>
          <h1>ChoreQuest</h1>
          <p class="story-lede">A Sunday-to-Saturday chore board for the people you live with. Put in the roommates and the chores. The week rotates on its own.</p>
          <ol class="principles">
            <li><strong>Sunday start</strong><span>A new round begins at midnight, then runs through Saturday.</span></li>
            <li><strong>Rotation</strong><span>Every chore moves one roommate down the list.</span></li>
            <li><strong>One month</strong><span>Finished weeks stay on the dashboard for 30 days.</span></li>
          </ol>
        </div>
        <p class="story-foot">Shared through the household ID. No account.</p>
      </section>
      <section class="welcome-form">
        ${bannerHtml()}
        ${joinMarkup()}
        ${formMarkup("welcome")}
      </section>
    </div>`;
  }

  function statusScreen() {
    const offline = phase === "offline";
    return `<div class="status-screen">
      <div>
        ${logo()}
        <h1>ChoreQuest</h1>
        <p class="hint" ${offline ? 'role="alert"' : 'role="status"'}>${offline ? esc(OFFLINE) : "Loading your household…"}</p>
        ${offline ? `<div class="form-actions">
          <button class="btn" type="button" data-action="retry">Try again</button>
          <button class="btn secondary" type="button" data-action="leave">Use a different household</button>
        </div>` : ""}
      </div>
    </div>`;
  }

  function navButton(id, label, current) {
    return `<button type="button" data-action="nav" data-view="${id}" ${current ? 'aria-current="page"' : ""}>${label}</button>`;
  }

  function idCard() {
    return `<div class="side-id">
      <p>Household ID</p>
      <div class="id-row">
        <strong class="id-code">${esc(householdId)}</strong>
        <button type="button" class="copy-id" data-action="copy-id">Copy</button>
      </div>
      <p class="fine">Roommates enter this to join.</p>
    </div>`;
  }

  function sidebar() {
    const onBoard = view === "week" || view === "history";
    return `<aside class="sidebar">
      <div class="brand">${logo()}<span><strong>ChoreQuest</strong><em>Sunday cycle</em></span></div>
      <p class="apt">${esc(state.apartmentName)}</p>
      <nav class="nav" aria-label="Sections">
        ${navButton("week", "Board", onBoard)}
        ${navButton("household", "Household", view === "household")}
      </nav>
      ${idCard()}
      <div class="side-timer">
        <p>Resets Sunday</p>
        <p class="side-digits" aria-hidden="true"><span data-unit="days">00</span>d <span data-unit="hours">00</span>h <span data-unit="minutes">00</span>m <span data-unit="seconds">00</span>s</p>
        <div class="track" aria-hidden="true"><span data-week-progress></span></div>
        <p class="fine">Synced with your roommates</p>
      </div>
      <p class="sr-only" data-timer-live aria-live="polite"></p>
    </aside>`;
  }

  function hero() {
    const sunday = CQ.sundayOf(new Date());
    return `<header class="hero">
      <div>
        <p class="eyebrow">${esc(formatRange(sunday))}</p>
        <h1>${esc(state.apartmentName)}</h1>
        <p class="lede">${esc(plural(state.chores.length, "chore"))} across ${esc(plural(state.roommates.length, "roommate"))}. At midnight Sunday, each chore moves to the next person.</p>
      </div>
      <section class="timer-card" aria-label="Time until the Sunday reset">
        <p class="timer-kicker">Until Sunday reset</p>
        <div class="digits" aria-hidden="true">${digitBlocks()}</div>
        <div class="track" aria-hidden="true"><span data-week-progress></span></div>
        <p class="reset-when">Resets ${esc(formatReset(new Date()))}. Midnight follows this device's clock.</p>
      </section>
    </header>`;
  }

  function choreCard(weekKeyValue, assignment) {
    const label = assignment.done
      ? `Mark ${assignment.choreName} not done for ${assignment.roommateName}`
      : `Mark ${assignment.choreName} done for ${assignment.roommateName}`;
    return `<article class="chore${assignment.done ? " is-done" : ""}" style="--who:${colorFor(assignment.roommateId)}">
      <button type="button" class="check" data-action="toggle" data-week="${esc(weekKeyValue)}" data-chore="${esc(assignment.choreId)}" aria-pressed="${assignment.done ? "true" : "false"}" aria-label="${esc(label)}">${assignment.done ? checkSvg() : ""}</button>
      <div class="chore-copy">
        <h3>${esc(assignment.choreName)}</h3>
        <p class="who"><span class="avatar" aria-hidden="true">${esc(initial(assignment.roommateName))}</span>${esc(assignment.roommateName)}</p>
      </div>
      <span class="status">${assignment.done ? "Done" : "Open"}</span>
    </article>`;
  }

  function weekPanel() {
    const key = CQ.weekKey(new Date());
    const week = state.weeks[key];
    if (!week) {
      return `<section class="week-panel"><p class="hint">This week is not on the board yet. Save the household again.</p></section>`;
    }
    const done = week.assignments.filter((item) => item.done).length;
    const resting = CQ.restingRoommates(state, week.assignments);
    const upcoming = CQ.assignmentsFor(state, CQ.addDays(CQ.sundayOf(new Date()), 7));
    const note = state.roommates.length < 2
      ? "Add another roommate and chores will start rotating on Sunday."
      : "On Sunday, every chore shifts to the next roommate.";
    return `<section class="week-panel" data-week-key="${esc(key)}">
      <ul class="stats">
        <li><strong>${done}/${week.assignments.length}</strong><span>done this week</span></li>
        <li><strong>${state.roommates.length}</strong><span>${state.roommates.length === 1 ? "roommate" : "roommates"}</span></li>
        <li><strong>${CQ.HISTORY_DAYS}</strong><span>days of history</span></li>
      </ul>
      <div class="chore-list">
        ${week.assignments.map((item) => choreCard(key, item)).join("")}
      </div>
      ${resting.length ? `<p class="rest">Off this week: ${resting.map((person) => esc(person.name)).join(", ")}</p>` : ""}
      <section class="next-up">
        <div class="week-head">
          <h2>Next Sunday</h2>
          <p>${esc(note)}</p>
        </div>
        <ul>
          ${upcoming.map((item) => `<li><span>${esc(item.choreName)}</span><span>${esc(item.roommateName)}</span></li>`).join("")}
        </ul>
      </section>
    </section>`;
  }

  function historyPanel() {
    const entries = CQ.historyEntries(state, new Date());
    const tasks = entries.reduce((total, entry) => total + entry.assignments.length, 0);
    const done = entries.reduce((total, entry) => total + entry.assignments.filter((item) => item.done).length, 0);
    const body = entries.length
      ? entries.map((entry) => {
          const finished = entry.assignments.filter((item) => item.done).length;
          return `<section class="week-block">
            <div class="week-head">
              <h3>${esc(formatRange(CQ.parseKey(entry.weekStart)))}</h3>
              <p>${finished} of ${entry.assignments.length} done</p>
            </div>
            <div class="chore-list ledger">
              ${entry.assignments.map((item) => choreCard(entry.weekStart, item)).join("")}
            </div>
          </section>`;
        }).join("")
      : `<div class="empty"><h2>Nothing in the last 30 days yet</h2><p>When Sunday resets the board, this week’s tasks land here. Anything older than a month is removed.</p></div>`;
    return `<section class="history-panel" data-history-count="${tasks}">
      <div class="week-head">
        <h2>Last 30 days</h2>
        <p>${tasks ? `${done} of ${tasks} tasks marked done` : "Finished weeks only"}</p>
      </div>
      ${body}
    </section>`;
  }

  function dashboard() {
    const historyCount = CQ.historyEntries(state, new Date()).reduce((total, entry) => total + entry.assignments.length, 0);
    return `${hero()}
      <div class="tabs" role="tablist" aria-label="Dashboard">
        <button type="button" role="tab" data-action="nav" data-view="week" aria-selected="${view === "week" ? "true" : "false"}">This week</button>
        <button type="button" role="tab" data-action="nav" data-view="history" aria-selected="${view === "history" ? "true" : "false"}">History${historyCount ? ` · ${historyCount}` : ""}</button>
      </div>
      ${view === "history" ? historyPanel() : weekPanel()}`;
  }

  function householdView() {
    return `<section class="panel">
      <p class="timer-strip" aria-hidden="true">Sunday reset in <span data-unit="days">00</span>d <span data-unit="hours">00</span>h <span data-unit="minutes">00</span>m <span data-unit="seconds">00</span>s</p>
      <p class="eyebrow">Household · ID ${esc(householdId)}</p>
      <h1>Who lives here</h1>
      ${formMarkup("edit")}
    </section>`;
  }

  function shell() {
    const page = view === "household" ? householdView() : dashboard();
    return `<div class="app">
      ${sidebar()}
      <main class="main view-${view}">
        ${bannerHtml()}
        ${page}
      </main>
    </div>`;
  }

  function paintTimer() {
    const now = new Date();
    const left = CQ.remaining(now);
    for (const unit of ["days", "hours", "minutes", "seconds"]) {
      const text = String(left[unit]).padStart(2, "0");
      document.querySelectorAll(`[data-unit="${unit}"]`).forEach((node) => {
        node.textContent = text;
      });
    }
    const progress = String(CQ.weekProgress(now));
    document.querySelectorAll("[data-week-progress]").forEach((node) => {
      node.style.transform = `scaleX(${progress})`;
    });
    const minuteKey = left.days * 1440 + left.hours * 60 + left.minutes;
    const live = document.querySelector("[data-timer-live]");
    if (live && (live.textContent === "" || minuteKey !== lastAnnouncedMinute)) {
      lastAnnouncedMinute = minuteKey;
      live.textContent = `${left.days} days, ${left.hours} hours, ${left.minutes} minutes until Sunday`;
    }
  }

  function render(options = {}) {
    const scroll = options.scroll || "keep";
    const y = scroll === "keep" ? window.scrollY : 0;
    mount.innerHTML = phase !== "ready" ? statusScreen() : state.onboarded ? shell() : welcome();
    document.title = state.onboarded && state.apartmentName ? `${state.apartmentName} · ChoreQuest` : "ChoreQuest";
    paintTimer();
    window.scrollTo(0, y);
    if (focusSelector) {
      const target = document.querySelector(focusSelector);
      if (target) target.focus({ preventScroll: true });
      focusSelector = "";
    }
  }

  function repaint() {
    if (view !== "household" || !state.onboarded) render({ scroll: "keep" });
  }

  function markBusy(selector, label) {
    const button = document.querySelector(selector);
    if (!button) return;
    button.disabled = true;
    button.textContent = label;
  }

  function paintRoommateFields() {
    const host = document.getElementById("roommate-fields");
    const countInput = document.querySelector("[data-field='count']");
    if (countInput) countInput.value = String(draft.roommates.length);
    if (host) host.innerHTML = draft.roommates.map((person, index) => roommateRow(person, index, draft.roommates.length)).join("");
    const fewer = document.querySelector("[data-action='count'][data-delta='-1']");
    const more = document.querySelector("[data-action='count'][data-delta='1']");
    if (fewer) fewer.disabled = draft.roommates.length <= 1;
    if (more) more.disabled = draft.roommates.length >= CQ.MAX_ROOMMATES;
  }

  function paintChoreFields() {
    const host = document.getElementById("chore-fields");
    if (host) host.innerHTML = draft.chores.map((chore, index) => choreRow(chore, index, draft.chores.length)).join("");
    const add = document.querySelector("[data-action='add-chore']");
    if (add) add.disabled = draft.chores.length >= CQ.MAX_CHORES;
  }

  function resizeRoommates(count) {
    if (!Number.isInteger(count)) return;
    const next = Math.max(1, Math.min(CQ.MAX_ROOMMATES, count));
    if (next === draft.roommates.length) {
      paintRoommateFields();
      return;
    }
    while (draft.roommates.length < next) draft.roommates.push({ id: CQ.uid(), name: "" });
    draft.roommates.length = next;
    paintRoommateFields();
  }

  function addChore() {
    if (!draft || draft.chores.length >= CQ.MAX_CHORES) return;
    draft.chores.push({ id: CQ.uid(), name: "" });
    const selector = `[data-field="chore"][data-index="${draft.chores.length - 1}"]`;
    if (!document.getElementById("chore-fields")) {
      focusSelector = selector;
      render({ scroll: "keep" });
      return;
    }
    paintChoreFields();
    const input = document.querySelector(selector);
    if (input) input.focus();
  }

  function removeChore(index) {
    if (!draft || !draft.chores[index]) return;
    if (draft.chores.length === 1) draft.chores[0].name = "";
    else draft.chores.splice(index, 1);
    paintChoreFields();
  }

  function move(list, index, delta) {
    const next = index + delta;
    if (!list[index] || next < 0 || next >= list.length) return;
    const [item] = list.splice(index, 1);
    list.splice(next, 0, item);
  }

  function setView(next) {
    if (!state.onboarded) return;
    if (next !== "week" && next !== "history" && next !== "household") return;
    if (next === "household") {
      draft = defaultDraft();
      formError = "";
    }
    view = next;
    render({ scroll: "top" });
  }

  async function saveHousehold() {
    if (saving) return;
    const countInput = document.querySelector("[data-field='count']");
    if (countInput && countInput.value !== "") resizeRoommates(Number(countInput.value));
    const check = CQ.applyHousehold(state, draft, new Date());
    if (!check.ok) {
      formError = check.error;
      render({ scroll: "keep" });
      return;
    }

    const creating = !householdId;
    saving = true;
    markBusy(".household-form [type='submit']", creating ? "Creating…" : "Saving…");
    let result;
    try {
      result = creating
        ? await api("POST", "/api/households", { household: draft, legacy: legacyState() })
        : await api("PUT", `/api/households/${householdId}`, { household: draft });
    } catch {
      result = null;
    }
    saving = false;

    if (!result) {
      formError = OFFLINE;
      render({ scroll: "keep" });
      return;
    }
    if (!result.ok) {
      if (!creating && result.status === 404) {
        forget("A roommate deleted this household. Create a new one or enter another ID.");
        render({ scroll: "top" });
        return;
      }
      formError = result.data.error || "Could not save the household. Try again.";
      render({ scroll: "keep" });
      return;
    }

    adopt(result.data);
    if (creating) {
      writeLocal(LEGACY_KEY, "");
      setBanner(`Household created. Share the ID ${householdId} with your roommates so they can join.`);
    } else {
      setBanner("");
    }
    formError = "";
    view = "week";
    draft = defaultDraft();
    render({ scroll: "top" });
  }

  async function joinHousehold() {
    if (saving) return;
    const id = cleanId(joinCode);
    if (id.length !== ID_LENGTH) {
      joinError = "Household IDs are 6 letters and numbers.";
      focusSelector = "#join-id";
      render({ scroll: "keep" });
      return;
    }

    saving = true;
    markBusy(".join-form [type='submit']", "Joining…");
    try {
      const result = await api("GET", `/api/households/${id}`);
      if (result.ok) {
        adopt(result.data);
        joinCode = "";
        joinError = "";
        formError = "";
        setBanner("");
        view = "week";
        draft = defaultDraft();
      } else {
        joinError = result.data.error || "Could not open that household.";
        focusSelector = "#join-id";
      }
    } catch {
      joinError = OFFLINE;
    }
    saving = false;
    render({ scroll: state.onboarded ? "top" : "keep" });
  }

  async function deleteHousehold() {
    const confirmed = window.confirm(`Delete this household for everyone? Every roommate using ID ${householdId} loses the chores and the month of history.`);
    if (!confirmed) return;
    try {
      const result = await api("DELETE", `/api/households/${householdId}`);
      if (!result.ok && result.status !== 404) {
        setBanner(result.data.error || "Could not delete the household. Try again.", "error");
        render({ scroll: "top" });
        return;
      }
    } catch {
      setBanner(OFFLINE, "error");
      render({ scroll: "top" });
      return;
    }
    forget("");
    render({ scroll: "top" });
  }

  function leaveHousehold() {
    if (state.onboarded) {
      const confirmed = window.confirm(`Leave this household on this device? You can come back any time with the ID ${householdId}.`);
      if (!confirmed) return;
    }
    forget("");
    phase = "ready";
    render({ scroll: "top" });
  }

  async function toggle(weekKeyValue, choreId) {
    const week = state.weeks[weekKeyValue];
    const item = week && week.assignments.find((assignment) => assignment.choreId === choreId);
    if (!item) return;
    const done = !item.done;
    CQ.setDone(state, weekKeyValue, choreId, done);
    syncVersion += 1;
    render({ scroll: "keep" });

    pending += 1;
    try {
      const result = await api("POST", `/api/households/${householdId}/done`, { week: weekKeyValue, choreId, done });
      if (result.status === 404) {
        forget("A roommate deleted this household. Create a new one or enter another ID.");
      } else if (result.data.state) {
        adopt(result.data);
        setBanner(result.ok ? "" : result.data.error, result.ok ? "info" : "error");
      } else {
        CQ.setDone(state, weekKeyValue, choreId, !done);
        setBanner(result.data.error || "Could not save that check-off. Try again.", "error");
      }
    } catch {
      CQ.setDone(state, weekKeyValue, choreId, !done);
      setBanner(OFFLINE, "error");
    }
    pending -= 1;
    repaint();
  }

  async function copyId(button) {
    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(householdId);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      const area = document.createElement("textarea");
      area.value = householdId;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      }
      area.remove();
    }
    button.textContent = copied ? "Copied" : "Copy failed";
    window.setTimeout(() => {
      if (button.isConnected) button.textContent = "Copy";
    }, 1600);
  }

  async function poll() {
    if (!householdId || phase !== "ready" || pending || saving || polling) return;
    if (document.visibilityState !== "visible") return;
    const startedAt = syncVersion;
    polling = true;
    try {
      const result = await api("GET", `/api/households/${householdId}`);
      if (syncVersion !== startedAt) return;
      if (result.ok) {
        const before = JSON.stringify(state);
        const wasOffline = banner === OFFLINE;
        adopt(result.data);
        if (wasOffline) setBanner("");
        if (wasOffline || JSON.stringify(state) !== before) repaint();
      } else if (result.status === 404) {
        forget("A roommate deleted this household. Create a new one or enter another ID.");
        render({ scroll: "top" });
      }
    } catch {
      if (syncVersion === startedAt && banner !== OFFLINE) {
        setBanner(OFFLINE, "error");
        repaint();
      }
    } finally {
      polling = false;
    }
  }

  async function boot() {
    householdId = cleanId(readLocal(HOUSEHOLD_KEY));
    state = CQ.blankState();
    view = "week";
    if (!householdId) {
      phase = "ready";
      draft = defaultDraft();
      render({ scroll: "top" });
      return;
    }

    phase = "loading";
    render({ scroll: "top" });
    try {
      const result = await api("GET", `/api/households/${householdId}`);
      if (result.ok) adopt(result.data);
      else if (result.status === 404) forget("That household was deleted. Create a new one or enter another ID.");
      else throw new Error(result.data.error);
    } catch {
      phase = "offline";
      render({ scroll: "top" });
      return;
    }
    phase = "ready";
    draft = defaultDraft();
    render({ scroll: "top" });
  }

  function onClick(event) {
    const target = event.target instanceof Element ? event.target : event.target.parentElement;
    const button = target && target.closest("[data-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === "nav") setView(button.dataset.view);
    else if (action === "count") resizeRoommates(draft.roommates.length + Number(button.dataset.delta));
    else if (action === "add-chore") addChore();
    else if (action === "remove-chore") removeChore(Number(button.dataset.index));
    else if (action === "move-roommate") {
      move(draft.roommates, Number(button.dataset.index), Number(button.dataset.delta));
      paintRoommateFields();
    } else if (action === "move-chore") {
      move(draft.chores, Number(button.dataset.index), Number(button.dataset.delta));
      paintChoreFields();
    } else if (action === "toggle") toggle(button.dataset.week, button.dataset.chore);
    else if (action === "reset") deleteHousehold();
    else if (action === "leave") leaveHousehold();
    else if (action === "retry") boot();
    else if (action === "copy-id") copyId(button);
  }

  function onInput(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.dataset.field === "join") {
      joinCode = cleanId(input.value).slice(0, ID_LENGTH);
      if (input.value !== joinCode) input.value = joinCode;
      return;
    }
    if (!draft) return;
    const index = Number(input.dataset.index);
    if (input.dataset.field === "apartment") draft.apartmentName = input.value;
    if (input.dataset.field === "roommate" && draft.roommates[index]) draft.roommates[index].name = input.value;
    if (input.dataset.field === "chore" && draft.chores[index]) draft.chores[index].name = input.value;
  }

  function onChange(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.dataset.field !== "count") return;
    if (input.value === "") return;
    resizeRoommates(Number(input.value));
  }

  function onSubmit(event) {
    if (!(event.target instanceof HTMLFormElement)) return;
    event.preventDefault();
    if (event.target.dataset.form === "join") joinHousehold();
    else saveHousehold();
  }

  function onKeydown(event) {
    if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
    const input = event.target;
    if (!input.closest("form") || input.dataset.field === "join" || !draft) return;
    if (input.dataset.field === "count") {
      event.preventDefault();
      if (input.value !== "") resizeRoommates(Number(input.value));
      return;
    }
    if (input.dataset.field === "chore") {
      const index = Number(input.dataset.index);
      if (input.value.trim() && index === draft.chores.length - 1 && draft.chores.length < CQ.MAX_CHORES) {
        event.preventDefault();
        draft.chores[index].name = input.value;
        addChore();
        return;
      }
    }
    event.preventDefault();
  }

  function onStorage(event) {
    if (event.key !== HOUSEHOLD_KEY) return;
    if (cleanId(event.newValue) === householdId) return;
    boot();
  }

  function catchUp() {
    if (!state.onboarded) {
      paintTimer();
      return;
    }
    CQ.refresh(state, new Date());
    const key = CQ.weekKey(new Date());
    if (key !== lastWeekKey) {
      lastWeekKey = key;
      repaint();
      poll();
      return;
    }
    paintTimer();
  }

  function init() {
    document.addEventListener("click", onClick);
    document.addEventListener("input", onInput);
    document.addEventListener("change", onChange);
    document.addEventListener("submit", onSubmit);
    document.addEventListener("keydown", onKeydown);
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      catchUp();
      poll();
    });
    boot();
    window.setInterval(catchUp, 1000);
    window.setInterval(poll, POLL_MS);
  }

  init();
})();
