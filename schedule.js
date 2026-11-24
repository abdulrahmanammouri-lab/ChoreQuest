(function (factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports && typeof window === "undefined") {
    module.exports = api;
  } else {
    window.ChoreQuest = api;
  }
})(function () {
  "use strict";

  const MAX_ROOMMATES = 16;
  const MAX_CHORES = 24;
  const HISTORY_DAYS = 30;

  function uid() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  function startOfDay(date) {
    const copy = new Date(date.getTime());
    copy.setHours(0, 0, 0, 0);
    return copy;
  }

  function addDays(date, amount) {
    const copy = startOfDay(date);
    copy.setDate(copy.getDate() + amount);
    return copy;
  }

  function sundayOf(date) {
    const copy = startOfDay(date);
    copy.setDate(copy.getDate() - copy.getDay());
    return copy;
  }

  function formatKey(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function parseKey(key) {
    const [year, month, day] = String(key).split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  function isValidKey(key) {
    return typeof key === "string" && formatKey(parseKey(key)) === key;
  }

  function daysBetween(start, end) {
    const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
    const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
    return Math.round((endUtc - startUtc) / 86400000);
  }

  function weekKey(now = new Date()) {
    return formatKey(sundayOf(now));
  }

  function nextReset(now) {
    return addDays(sundayOf(now), 7);
  }

  function remaining(now) {
    let ms = nextReset(now).getTime() - now.getTime();
    if (ms < 0) ms = 0;
    const totalSeconds = Math.floor(ms / 1000);
    return {
      days: Math.floor(totalSeconds / 86400),
      hours: Math.floor((totalSeconds % 86400) / 3600),
      minutes: Math.floor((totalSeconds % 3600) / 60),
      seconds: totalSeconds % 60,
      ms,
    };
  }

  function weekProgress(now) {
    const start = sundayOf(now).getTime();
    const end = addDays(sundayOf(now), 7).getTime();
    if (end <= start) return 0;
    return Math.min(1, Math.max(0, (now.getTime() - start) / (end - start)));
  }

  function blankState() {
    return {
      version: 1,
      apartmentName: "",
      roommates: [],
      chores: [],
      anchorSunday: null,
      weeks: {},
      onboarded: false,
    };
  }

  function cleanLabel(value, max) {
    return String(value || "").trim().slice(0, max);
  }

  function uniqueId(id, seen) {
    let next = cleanLabel(id, 40) || uid();
    while (seen.has(next)) next = uid();
    seen.add(next);
    return next;
  }

  function cloneWeeks(weeks) {
    const copy = {};
    if (!weeks || typeof weeks !== "object") return copy;
    for (const [key, week] of Object.entries(weeks)) {
      if (!isValidKey(key) || !week || !Array.isArray(week.assignments)) continue;
      copy[key] = {
        frozen: Boolean(week.frozen),
        assignments: week.assignments
          .filter((item) => item && item.choreId && item.roommateId)
          .map((item) => ({
            choreId: String(item.choreId),
            choreName: String(item.choreName || ""),
            roommateId: String(item.roommateId),
            roommateName: String(item.roommateName || ""),
            done: Boolean(item.done),
          })),
      };
    }
    return copy;
  }

  function normalize(raw) {
    const state = blankState();
    if (!raw || typeof raw !== "object") return state;

    const seenRoommates = new Set();
    const seenChores = new Set();
    state.apartmentName = cleanLabel(raw.apartmentName, 48);
    state.roommates = Array.isArray(raw.roommates)
      ? raw.roommates.slice(0, MAX_ROOMMATES).map((person, index) => ({
          id: uniqueId(person && person.id, seenRoommates),
          name: cleanLabel(person && person.name, 40) || `Roommate ${index + 1}`,
        }))
      : [];
    state.chores = Array.isArray(raw.chores)
      ? raw.chores
          .map((chore) => ({
            id: chore && chore.id,
            name: cleanLabel(chore && chore.name, 60),
          }))
          .filter((chore) => chore.name)
          .slice(0, MAX_CHORES)
          .map((chore) => ({
            id: uniqueId(chore.id, seenChores),
            name: chore.name,
          }))
      : [];
    state.weeks = cloneWeeks(raw.weeks);
    state.anchorSunday = isValidKey(raw.anchorSunday) ? formatKey(sundayOf(parseKey(raw.anchorSunday))) : null;
    state.onboarded = Boolean(raw.onboarded) && state.roommates.length > 0 && state.chores.length > 0;
    if (state.onboarded && !state.anchorSunday) state.anchorSunday = weekKey(new Date());
    return state;
  }

  function assignmentsFor(state, weekStartDate) {
    const count = state.roommates.length;
    if (!count || !state.chores.length || !isValidKey(state.anchorSunday)) return [];
    const offset = Math.round(daysBetween(sundayOf(parseKey(state.anchorSunday)), sundayOf(weekStartDate)) / 7);
    return state.chores.map((chore, index) => {
      const roommateIndex = ((index + offset) % count + count) % count;
      const roommate = state.roommates[roommateIndex];
      return {
        choreId: chore.id,
        choreName: chore.name,
        roommateId: roommate.id,
        roommateName: roommate.name,
        done: false,
      };
    });
  }

  function makeWeek(state, weekStart, existing, isCurrent) {
    const doneByChore = new Map();
    if (existing) {
      for (const item of existing.assignments) doneByChore.set(item.choreId, Boolean(item.done));
    }
    return {
      frozen: !isCurrent,
      assignments: assignmentsFor(state, weekStart).map((item) => ({
        ...item,
        done: Boolean(doneByChore.get(item.choreId)),
      })),
    };
  }

  function weeksEqual(left, right) {
    if (!left || !right || left.frozen !== right.frozen) return false;
    if (left.assignments.length !== right.assignments.length) return false;
    return left.assignments.every((item, index) => {
      const other = right.assignments[index];
      return (
        item.choreId === other.choreId &&
        item.choreName === other.choreName &&
        item.roommateId === other.roommateId &&
        item.roommateName === other.roommateName &&
        item.done === other.done
      );
    });
  }

  function syncFrozenNames(state, now) {
    const current = weekKey(now);
    const roommates = new Map(state.roommates.map((person) => [person.id, person.name]));
    const chores = new Map(state.chores.map((chore) => [chore.id, chore.name]));
    let changed = false;

    for (const [key, week] of Object.entries(state.weeks)) {
      if (key === current) continue;
      for (const item of week.assignments) {
        if (roommates.has(item.roommateId) && item.roommateName !== roommates.get(item.roommateId)) {
          item.roommateName = roommates.get(item.roommateId);
          changed = true;
        }
        if (chores.has(item.choreId) && item.choreName !== chores.get(item.choreId)) {
          item.choreName = chores.get(item.choreId);
          changed = true;
        }
      }
    }
    return changed;
  }

  function ensureWeeks(state, now = new Date()) {
    if (!state.onboarded || !isValidKey(state.anchorSunday) || !state.roommates.length || !state.chores.length) {
      return false;
    }

    let changed = false;
    const anchor = sundayOf(parseKey(state.anchorSunday));
    const anchorKey = formatKey(anchor);
    if (state.anchorSunday !== anchorKey) {
      state.anchorSunday = anchorKey;
      changed = true;
    }

    const thisSunday = sundayOf(now);
    const thisKey = formatKey(thisSunday);
    const cutoff = addDays(startOfDay(now), -HISTORY_DAYS);
    let cursor = sundayOf(cutoff);
    if (cursor.getTime() < anchor.getTime()) cursor = new Date(anchor.getTime());

    const keep = new Set();
    for (let guard = 0; guard < 12 && cursor.getTime() <= thisSunday.getTime(); guard += 1) {
      const key = formatKey(cursor);
      const saturday = addDays(cursor, 6);
      const isCurrent = key === thisKey;
      if (saturday.getTime() >= cutoff.getTime() || isCurrent) {
        keep.add(key);
        const existing = state.weeks[key];
        if (!existing) {
          state.weeks[key] = makeWeek(state, cursor, null, isCurrent);
          changed = true;
        } else if (isCurrent) {
          const rebuilt = makeWeek(state, cursor, existing, true);
          if (!weeksEqual(existing, rebuilt)) {
            state.weeks[key] = rebuilt;
            changed = true;
          }
        } else if (!existing.frozen) {
          existing.frozen = true;
          changed = true;
        }
      }
      const next = addDays(cursor, 7);
      if (next.getTime() <= cursor.getTime()) break;
      cursor = next;
    }

    for (const key of Object.keys(state.weeks)) {
      if (!keep.has(key)) {
        delete state.weeks[key];
        changed = true;
      }
    }
    return changed;
  }

  function refresh(state, now = new Date()) {
    const namesChanged = syncFrozenNames(state, now);
    const weeksChanged = ensureWeeks(state, now);
    return namesChanged || weeksChanged;
  }

  function applyHousehold(state, draft, now = new Date()) {
    const seenRoommates = new Set();
    const seenChores = new Set();
    const roommates = (draft.roommates || []).slice(0, MAX_ROOMMATES).map((person, index) => ({
      id: uniqueId(person && person.id, seenRoommates),
      name: cleanLabel(person && person.name, 40) || `Roommate ${index + 1}`,
    }));
    const chores = (draft.chores || [])
      .map((chore) => ({
        id: chore && chore.id,
        name: cleanLabel(chore && chore.name, 60),
      }))
      .filter((chore) => chore.name)
      .slice(0, MAX_CHORES)
      .map((chore) => ({
        id: uniqueId(chore.id, seenChores),
        name: chore.name,
      }));

    if (!roommates.length) return { ok: false, error: "Add at least one roommate." };
    if (!chores.length) return { ok: false, error: "Add at least one chore." };

    const next = blankState();
    next.apartmentName = cleanLabel(draft.apartmentName, 48) || "Our place";
    next.roommates = roommates;
    next.chores = chores;
    next.onboarded = true;
    next.anchorSunday = isValidKey(state.anchorSunday)
      ? formatKey(sundayOf(parseKey(state.anchorSunday)))
      : weekKey(now);
    next.weeks = cloneWeeks(state.weeks);
    refresh(next, now);
    return { ok: true, state: next };
  }

  function toggleDone(state, weekKeyValue, choreId) {
    const week = state.weeks[weekKeyValue];
    if (!week) return false;
    const item = week.assignments.find((assignment) => assignment.choreId === choreId);
    if (!item) return false;
    item.done = !item.done;
    return true;
  }

  function setDone(state, weekKeyValue, choreId, done) {
    const week = Object.prototype.hasOwnProperty.call(state.weeks, weekKeyValue) ? state.weeks[weekKeyValue] : null;
    if (!week) return false;
    const item = week.assignments.find((assignment) => assignment.choreId === choreId);
    if (!item) return false;
    item.done = Boolean(done);
    return true;
  }

  function historyEntries(state, now = new Date()) {
    const current = weekKey(now);
    return Object.keys(state.weeks)
      .filter((key) => key < current)
      .sort((a, b) => b.localeCompare(a))
      .map((key) => ({
        weekStart: key,
        frozen: Boolean(state.weeks[key].frozen),
        assignments: state.weeks[key].assignments,
      }));
  }

  function restingRoommates(state, assignments) {
    const busy = new Set(assignments.map((item) => item.roommateId));
    return state.roommates.filter((person) => !busy.has(person.id));
  }

  return {
    HISTORY_DAYS,
    MAX_CHORES,
    MAX_ROOMMATES,
    addDays,
    applyHousehold,
    assignmentsFor,
    blankState,
    daysBetween,
    ensureWeeks,
    formatKey,
    historyEntries,
    isValidKey,
    nextReset,
    normalize,
    parseKey,
    refresh,
    remaining,
    restingRoommates,
    setDone,
    startOfDay,
    sundayOf,
    toggleDone,
    uid,
    weekKey,
    weekProgress,
  };
});
