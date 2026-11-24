# ChoreQuest

Weekly chore schedule for roommates in a shared apartment.

The week starts on Sunday and runs through Saturday. You type the chores and the number of roommates. Every chore is assigned each week, and at midnight Sunday each one moves to the next roommate. A countdown shows the time left until that reset. The dashboard keeps every finished week from the last 30 days and drops anything older.

The household is stored in this browser only (`localStorage`). There is no account and no server.

## Open it

Open `index.html` in a browser, or serve the folder with any static file server.

## How the rotation works

Roommate order and chore order are the rotation order. On the anchor Sunday, the first chore goes to the first roommate, the second chore to the second roommate, and so on. Each new Sunday shifts every chore one person down the list. If there are more chores than people, some roommates get more than one. If there are more people than chores, someone is off that week.

Check-offs are kept when you rename the household. Weeks that have already ended stay as they were, except names update when the same person or chore is still on the list.

## Tests

```bash
node --test
```
