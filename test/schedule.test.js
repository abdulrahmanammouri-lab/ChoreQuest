const test = require("node:test");
const assert = require("node:assert/strict");
const cq = require("../schedule.js");

function household(now, extra = {}) {
  return cq.applyHousehold(
    cq.blankState(),
    {
      apartmentName: "Maple",
      roommates: [
        { id: "a", name: "Ari" },
        { id: "b", name: "Bea" },
        { id: "c", name: "Cole" },
      ],
      chores: [
        { id: "t", name: "Trash" },
        { id: "d", name: "Dishes" },
      ],
      ...extra,
    },
    now
  );
}

test("weeks start on Sunday and the countdown lands on the next one", () => {
  const tuesday = new Date(2026, 10, 24, 15, 30, 0);
  assert.equal(tuesday.getDay(), 2);
  assert.equal(cq.formatKey(cq.sundayOf(tuesday)), "2026-11-22");
  assert.equal(cq.weekKey(tuesday), "2026-11-22");

  const dates = [
    new Date(2026, 10, 22, 0, 0, 0),
    new Date(2026, 10, 24, 15, 30, 0),
    new Date(2026, 0, 1, 12, 0, 0),
    new Date(2026, 2, 29, 3, 30, 0),
    new Date(2026, 9, 25, 1, 30, 0),
    new Date(2026, 11, 31, 23, 0, 0),
  ];

  for (const date of dates) {
    const sunday = cq.sundayOf(date);
    assert.equal(sunday.getDay(), 0);
    assert.equal(sunday.getHours(), 0);
    assert.equal(cq.daysBetween(sunday, date), date.getDay());
    const reset = cq.nextReset(date);
    assert.equal(reset.getDay(), 0);
    assert.ok(reset.getTime() > date.getTime());
    assert.equal(cq.daysBetween(sunday, reset), 7);
    const left = cq.remaining(date);
    assert.ok(left.ms > 0);
    assert.ok(left.days >= 0 && left.days <= 7);
    const progress = cq.weekProgress(date);
    assert.ok(progress >= 0 && progress <= 1);
  }

  const exactSunday = new Date(2026, 10, 22, 0, 0, 0);
  assert.deepEqual(cq.remaining(exactSunday), {
    days: 7,
    hours: 0,
    minutes: 0,
    seconds: 0,
    ms: 7 * 86400000,
  });
  assert.equal(cq.weekProgress(exactSunday), 0);

  const midweek = cq.remaining(tuesday);
  assert.deepEqual(
    { days: midweek.days, hours: midweek.hours, minutes: midweek.minutes, seconds: midweek.seconds },
    { days: 4, hours: 8, minutes: 30, seconds: 0 }
  );
});

test("calendar day math ignores clock changes", () => {
  assert.equal(cq.daysBetween(new Date(2026, 9, 24, 23, 30), new Date(2026, 9, 25, 0, 30)), 1);
  assert.equal(cq.formatKey(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(cq.formatKey(cq.parseKey("2026-01-05")), "2026-01-05");
});

test("chores rotate one roommate forward every Sunday", () => {
  const now = new Date(2026, 10, 24, 15, 30, 0);
  const result = household(now);
  assert.equal(result.ok, true);
  assert.equal(result.state.anchorSunday, "2026-11-22");

  const current = result.state.weeks["2026-11-22"];
  assert.equal(current.frozen, false);
  assert.deepEqual(
    current.assignments.map((item) => [item.choreName, item.roommateName]),
    [
      ["Trash", "Ari"],
      ["Dishes", "Bea"],
    ]
  );
  assert.deepEqual(
    cq.restingRoommates(result.state, current.assignments).map((person) => person.name),
    ["Cole"]
  );

  const next = cq.assignmentsFor(result.state, new Date(2026, 10, 29, 9, 0, 0));
  assert.deepEqual(
    next.map((item) => [item.choreName, item.roommateName]),
    [
      ["Trash", "Bea"],
      ["Dishes", "Cole"],
    ]
  );

  const paired = cq.applyHousehold(cq.blankState(), {
    apartmentName: "Maple",
    roommates: [
      { id: "a", name: "Ari" },
      { id: "b", name: "Bea" },
    ],
    chores: [
      { id: "t", name: "Trash" },
      { id: "d", name: "Dishes" },
      { id: "v", name: "Vacuum" },
    ],
  }, now);
  assert.deepEqual(
    paired.state.weeks["2026-11-22"].assignments.map((item) => item.roommateName),
    ["Ari", "Bea", "Ari"]
  );
  assert.deepEqual(
    cq.assignmentsFor(paired.state, new Date(2026, 10, 29)).map((item) => item.roommateName),
    ["Bea", "Ari", "Bea"]
  );
});

test("history keeps weeks that overlap the last 30 days and drops the rest", () => {
  const now = new Date(2026, 10, 24, 12, 0, 0);
  const result = household(now);
  const state = result.state;
  const current = cq.weekKey(now);
  const oldestKept = cq.sundayOf(cq.addDays(cq.startOfDay(now), -30));
  state.anchorSunday = cq.formatKey(cq.addDays(oldestKept, -21));
  state.weeks = {};
  assert.equal(cq.refresh(state, now), true);
  assert.equal(cq.refresh(state, now), false);

  const minKey = cq.formatKey(oldestKept);
  assert.ok(state.weeks[minKey]);
  assert.equal(state.weeks[cq.formatKey(cq.addDays(oldestKept, -7))], undefined);
  assert.ok(state.weeks[current]);
  assert.equal(state.weeks[current].frozen, false);

  for (const entry of cq.historyEntries(state, now)) {
    assert.ok(entry.weekStart >= minKey);
    assert.ok(entry.weekStart < current);
    assert.equal(entry.frozen, true);
  }
  assert.equal(
    cq.historyEntries(state, now).some((entry) => entry.weekStart === current),
    false
  );
  assert.deepEqual(
    cq.historyEntries(state, now).map((entry) => entry.weekStart),
    Object.keys(state.weeks).filter((key) => key < current).sort((a, b) => b.localeCompare(a))
  );
});

test("check-offs survive a household edit and finished weeks stay frozen", () => {
  const now = new Date(2026, 10, 24, 12, 0, 0);
  let state = cq.applyHousehold(cq.blankState(), {
    apartmentName: "Maple",
    roommates: [
      { id: "a", name: "Ari" },
      { id: "b", name: "Bea" },
    ],
    chores: [
      { id: "t", name: "Trash" },
      { id: "d", name: "Dishes" },
    ],
  }, now).state;

  state.anchorSunday = "2026-11-08";
  state.weeks = {};
  cq.refresh(state, now);
  assert.equal(cq.toggleDone(state, "2026-11-22", "t"), true);
  assert.equal(state.weeks["2026-11-22"].assignments.find((item) => item.choreId === "t").roommateId, "a");
  const pastIds = state.weeks["2026-11-15"].assignments.map((item) => item.roommateId).join(",");

  const edited = cq.applyHousehold(state, {
    apartmentName: "Maple",
    roommates: [
      { id: "b", name: "Bea" },
      { id: "a", name: "Ari" },
    ],
    chores: [
      { id: "t", name: "Trash night" },
      { id: "d", name: "Dishes" },
      { id: "v", name: "Vacuum" },
    ],
  }, now);

  assert.equal(edited.ok, true);
  state = edited.state;
  const currentTrash = state.weeks["2026-11-22"].assignments.find((item) => item.choreId === "t");
  assert.equal(currentTrash.done, true);
  assert.equal(currentTrash.choreName, "Trash night");
  assert.equal(currentTrash.roommateId, "b");
  assert.equal(state.weeks["2026-11-22"].assignments.some((item) => item.choreId === "v"), true);
  assert.equal(state.weeks["2026-11-15"].frozen, true);
  assert.equal(state.weeks["2026-11-15"].assignments.map((item) => item.roommateId).join(","), pastIds);
  assert.equal(state.weeks["2026-11-15"].assignments.find((item) => item.choreId === "t").choreName, "Trash night");
  assert.equal(cq.toggleDone(state, "2026-11-22", "missing"), false);
});

test("blank chores are rejected and blank names get a number", () => {
  const now = new Date(2026, 10, 24, 12, 0, 0);
  const original = cq.blankState();
  const snapshot = JSON.stringify(original);
  const rejected = cq.applyHousehold(original, {
    apartmentName: "X",
    roommates: [{ id: "a", name: "Ari" }],
    chores: [{ id: "c", name: "   " }],
  }, now);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "Add at least one chore.");
  assert.equal(JSON.stringify(original), snapshot);

  const named = cq.applyHousehold(cq.blankState(), {
    apartmentName: "  ",
    roommates: [
      { id: "a", name: "  " },
      { id: "b", name: "Bea" },
    ],
    chores: [{ id: "c", name: " Sink " }],
  }, now);
  assert.equal(named.ok, true);
  assert.equal(named.state.apartmentName, "Our place");
  assert.deepEqual(named.state.roommates.map((person) => person.name), ["Roommate 1", "Bea"]);
  assert.equal(named.state.chores[0].name, "Sink");
});

test("household size is capped and saved weeks are copied", () => {
  const now = new Date(2026, 10, 24, 12, 0, 0);
  const chores = Array.from({ length: 30 }, (_, index) => ({ id: `c${index}`, name: `Chore ${index}` }));
  const roommates = Array.from({ length: 20 }, (_, index) => ({ id: `r${index}`, name: `R${index}` }));
  const first = cq.applyHousehold(cq.blankState(), { apartmentName: "Big", roommates, chores }, now);
  assert.equal(first.state.chores.length, cq.MAX_CHORES);
  assert.equal(first.state.roommates.length, cq.MAX_ROOMMATES);

  const key = cq.weekKey(now);
  first.state.weeks[key].assignments[0].done = true;
  const second = cq.applyHousehold(first.state, {
    apartmentName: "Big",
    roommates: first.state.roommates,
    chores: first.state.chores,
  }, now);
  second.state.weeks[key].assignments[0].done = false;
  assert.equal(first.state.weeks[key].assignments[0].done, true);
});

test("normalize drops broken records and keeps a usable household", () => {
  const state = cq.normalize({
    onboarded: true,
    apartmentName: "  Loft  ",
    roommates: [{ id: "a", name: "Ari" }],
    chores: [{ id: "c", name: "Sink" }, { id: "d", name: " " }],
    anchorSunday: "nope",
    weeks: { bad: { assignments: [] }, "2026-11-22": { frozen: true, assignments: [{ choreId: "c", roommateId: "a", done: 1 }] } },
  });
  assert.equal(state.onboarded, true);
  assert.equal(state.apartmentName, "Loft");
  assert.equal(state.chores.length, 1);
  assert.equal(cq.isValidKey(state.anchorSunday), true);
  assert.deepEqual(Object.keys(state.weeks), ["2026-11-22"]);
  assert.equal(state.weeks["2026-11-22"].assignments[0].done, true);
  assert.deepEqual(cq.normalize(null), cq.blankState());
});
