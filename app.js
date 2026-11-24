(function () {
  "use strict";

  const CQ = window.ChoreQuest;
  const mount = document.getElementById("app");
  if (!CQ || !mount) return;

  const STORAGE_KEY = "chorequest.v1";
  const PALETTE = ["#1f4d3a", "#c4552a", "#2d5572", "#6d3b4f", "#8a5a22", "#1f6a62"];
  const CHORE_HINTS = ["Take out trash", "Dishes", "Vacuum", "Bathroom", "Recycling", "Mop the floors"];

  let state = CQ.blankState();
  let draft = null;
  let view = "week";
  let formError = "";
  let banner = "";
  let focusSelector = "";
  let lastWeekKey = "";
  let lastAnnouncedMinute = -1;

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

  function defaultDraft() {
    if (state.onboarded) {
      return {
        apartmentName: state.apartmentName,
        roommates: state.roommates.map((person) => ({ ...person })),
        chores: state.chores.map((chore) => ({ ...chore })),
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

  function load() {
    let next = CQ.blankState();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      next = CQ.normalize(raw ? JSON.parse(raw) : null);
    } catch {
      return CQ.blankState();
    }
    try {
      if (next.onboarded && CQ.refresh(next, new Date())) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      }
    } catch {
      // Keep the household in memory even if this browser refuses another write.
    }
    return next;
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch {
      banner = "Could not save on this device. Free some browser storage and try again.";
      return false;
    }
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
    return banner ? `<p class="banner" role="status">${esc(banner)}</p>` : "";
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
    const heading = mode === "welcome" ? `<h2>Set up the household</h2>` : "";
    return `<form class="household-form" novalidate autocomplete="off">
      ${formError ? `<p class="alert" role="alert">${esc(formError)}</p>` : ""}
      ${heading}
      <p class="hint">Type the chores and how many roommates share the place. Order is the rotation: each Sunday, every chore moves to the next person.</p>
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
        <button class="btn" type="submit">${mode === "welcome" ? "Start the week" : "Save household"}</button>
        ${state.onboarded ? `<button class="btn danger" type="button" data-action="reset">Clear household</button>` : ""}
      </div>
    </form>`;
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
        <p class="story-foot">Saved in this browser. No account.</p>
      </section>
      <section class="welcome-form">
        ${bannerHtml()}
        ${formMarkup("welcome")}
      </section>
    </div>`;
  }

  function navButton(id, label, current) {
    return `<button type="button" data-action="nav" data-view="${id}" ${current ? 'aria-current="page"' : ""}>${label}</button>`;
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
      <div class="side-timer">
        <p>Resets Sunday</p>
        <p class="side-digits" aria-hidden="true"><span data-unit="days">00</span>d <span data-unit="hours">00</span>h <span data-unit="minutes">00</span>m <span data-unit="seconds">00</span>s</p>
        <div class="track" aria-hidden="true"><span data-week-progress></span></div>
        <p class="fine">Saved on this device</p>
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
      <p class="eyebrow">Household</p>
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
    mount.innerHTML = state.onboarded ? shell() : welcome();
    document.title = state.onboarded && state.apartmentName ? `${state.apartmentName} · ChoreQuest` : "ChoreQuest";
    paintTimer();
    window.scrollTo(0, y);
    if (focusSelector) {
      const target = document.querySelector(focusSelector);
      if (target) target.focus({ preventScroll: true });
      focusSelector = "";
    }
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

  function saveHousehold() {
    const countInput = document.querySelector("[data-field='count']");
    if (countInput && countInput.value !== "") resizeRoommates(Number(countInput.value));
    const result = CQ.applyHousehold(state, draft, new Date());
    if (!result.ok) {
      formError = result.error;
      render({ scroll: "keep" });
      return;
    }
    state = result.state;
    formError = "";
    banner = "";
    view = "week";
    draft = defaultDraft();
    lastWeekKey = CQ.weekKey(new Date());
    persist();
    render({ scroll: "top" });
  }

  function resetHousehold() {
    const confirmed = window.confirm("Clear every roommate, chore, and the saved month of history on this device?");
    if (!confirmed) return;
    state = CQ.blankState();
    draft = defaultDraft();
    view = "week";
    formError = "";
    banner = "";
    lastWeekKey = "";
    persist();
    render({ scroll: "top" });
  }

  function toggle(weekKeyValue, choreId) {
    if (!CQ.toggleDone(state, weekKeyValue, choreId)) return;
    persist();
    render({ scroll: "keep" });
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
    else if (action === "reset") resetHousehold();
  }

  function onInput(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !draft) return;
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
    saveHousehold();
  }

  function onKeydown(event) {
    if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
    const input = event.target;
    if (!input.closest("form") || !draft) return;
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
    if (event.key !== STORAGE_KEY) return;
    state = load();
    if (!state.onboarded || view === "household") draft = defaultDraft();
    if (!state.onboarded) view = "week";
    lastWeekKey = state.onboarded ? CQ.weekKey(new Date()) : "";
    render({ scroll: "keep" });
  }

  function catchUp() {
    if (!state.onboarded) {
      paintTimer();
      return;
    }
    const changed = CQ.refresh(state, new Date());
    const key = CQ.weekKey(new Date());
    if (changed) persist();
    if (key !== lastWeekKey) {
      lastWeekKey = key;
      render({ scroll: "keep" });
      return;
    }
    paintTimer();
  }

  function init() {
    state = load();
    draft = defaultDraft();
    lastWeekKey = state.onboarded ? CQ.weekKey(new Date()) : "";
    document.addEventListener("click", onClick);
    document.addEventListener("input", onInput);
    document.addEventListener("change", onChange);
    document.addEventListener("submit", onSubmit);
    document.addEventListener("keydown", onKeydown);
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") catchUp();
    });
    render({ scroll: "top" });
    window.setInterval(catchUp, 1000);
  }

  init();
})();
