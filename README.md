# ChoreQuest

Weekly chore schedule for roommates in a shared apartment.

The week starts on Sunday and runs through Saturday. You type the chores and the number of roommates. Every chore is assigned each week, and at midnight Sunday each one moves to the next roommate. A countdown shows the time left until that reset. The dashboard keeps every finished week from the last 30 days and drops anything older.

## Households and IDs

The first screen has two choices:

- **Create a household** with the apartment name, roommates, and chores. After you create it, the dashboard shows a 6-character household ID (letters and numbers, for example `5NAHAD`).
- **Already have a household? Enter ID** opens a household someone else created.

Everyone who enters the same ID sees the same board. Check-offs and household edits show up for the others within a few seconds. Each browser remembers the last household it opened, so roommates only enter the ID once. **Leave on this device** forgets it in that browser only. **Delete household** removes it for everyone.

There are no accounts. Anyone who has the ID can open and edit the household.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer. There is nothing to install.

```bash
npm start
```

The server prints the addresses it is listening on:

- `http://localhost:3000` on the computer running it.
- `http://192.168.x.x:3000` for phones and laptops on the same Wi-Fi. Windows may ask whether Node.js can use the network the first time. Allow it on private networks.

The site has to be opened through the server. Opening `index.html` directly no longer works.

Households are saved in `data/households.json`. Keep that file to keep your households. It is not committed to git.

Settings, all optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Address to listen on |
| `DATA_FILE` | `data/households.json` | Where households are saved |

To let roommates in when they are not on your Wi-Fi, host it on a Node.js service that keeps a disk between restarts and point `DATA_FILE` at that disk.

## How the rotation works

Roommate order and chore order are the rotation order. On the anchor Sunday, the first chore goes to the first roommate, the second chore to the second roommate, and so on. Each new Sunday shifts every chore one person down the list. If there are more chores than people, some roommates get more than one. If there are more people than chores, someone is off that week.

The server's clock decides when Sunday starts for the saved data, so run it in the same time zone as the household.

Check-offs are kept when you rename the household. Weeks that have already ended stay as they were, except names update when the same person or chore is still on the list.

## Tests

```bash
npm test
```
