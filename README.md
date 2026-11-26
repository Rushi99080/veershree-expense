# Veershree Site Manager

The Site Manager app (machine hours, diesel, expenses, murum, vendor payments, machine rent bills, managers' cash book),
upgraded to work for a whole team: logins, roles, approvals and online sync through Firebase. Works offline on site.

Live app: https://rushi99080.github.io/veershree-expense/
Supervisor app: https://rushi99080.github.io/veershree-expense/supervisor/
Manager app: https://rushi99080.github.io/veershree-expense/manager/

## Files

| File | What it is |
|---|---|
| `index.html` | The Site Manager app — every screen and calculation, same as before |
| `sync.js` | The new layer: login screens, roles, approvals, users, import check, sync status |
| `cloud.js` | Talks to Firebase (login + database, with an offline copy on the phone) |
| `firebase-config.js` | Firebase keys of the `veershree-expense` project |
| `firestore.rules` | Security rules — paste into Firebase → Firestore Database → Rules → Publish |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline use and "Add to Home Screen" |
| `ai.js` | Photo reading: hour meter, log-book page or bill → numbers (Google Gemini, free key set in Menu → Photo reading) |
| `supervisor/` | The **Supervisor app** (separate link, own home-screen icon): machine readings and diesel on site |
| `manager/` | The **Manager app** (separate link, own home-screen icon): a manager's expenses (site-wise) and money received |

## Roles

| Role | Can do |
|---|---|
| Admin | Everything. Only the admin adds users, assigns sites, deletes and approves |
| Site Manager | Only the sites given to him. Adds entries (they wait for approval). Sees only his own cash book. Cannot change approved entries. Can use the Manager app, and remove his own entry there until it is approved |
| Accountant | Sees everything. Marks expense / diesel / murum bills paid, records payments |
| Viewer | Sees everything, changes nothing |
| Supervisor | Uses the Supervisor app only: machine in/out readings, diesel filled and diesel received on his sites. Entries wait for approval; sees no money figures |

The online database checks every change against these rules, so a role cannot be bypassed from another copy of the app.

## Person-wise

A tab of its own (Menu → Person-wise): what each person spent and received, **all sites together** or one site at a
time (chips at the top), for all time, this month, last month or this financial year. Names typed with different capitals
("Suhas Sir" / "Suhas sir") count as one person. Open a person for site-wise and head-wise totals, money received, every
entry (tap to open it, from any site) and a WhatsApp statement. "Paid — name not marked" lists paid entries with no
Paid by. In hand = received − spent, for managers and people given advances.

## Manager app

`manager/` — the manager signs in with his Site Manager login (Users → Site Manager, with his **cash book** name and sites).
He sees his money in hand, adds **expenses** (site, date, head, amount, what for; bill photo reading) and **money received**,
and shares a statement on WhatsApp. Expenses go to that site's Expense log with Paid by = his name; money received goes to
his cash book (Managers tab). Everything waits for the admin's approval; he can change or remove it until then. Works offline.
The admin can open it too and fill any manager's book (saved as approved).

## Photo reading

Machine → Daily log → pick a machine → **Scan … log**: a photo of the log-book page or the hour meter is read and
shown row by row to check. Rows already in the log are skipped; saved entries with blanks (e.g. only the In reading)
are filled in, never overwritten without a tick. The New machine / diesel / expense forms and the Supervisor app
have **Read … photo** buttons that fill the form. Turn it on once in Menu → Photo reading with a free key from
aistudio.google.com/apikey.

## Supervisor reminders

Menu → Supervisor reminders (admin): set the time (e.g. 7:00 PM to 10:00 PM). After that time, a supervisor whose
working machines are not all filled — and who has not tapped **Done for today** in the Supervisor app — gets a phone
notification every 10 minutes; the admin gets one. The checks run on GitHub (`.github/workflows/remind.yml`,
`.github/remind/remind.mjs`) every 10 minutes and need the `REMINDER_SECRET` made by "Set up the reminder robot".
Phones turn notifications on in the app (iPhone: from the Home Screen app).

## Phases

1. Login, roles, approvals, offline sync, import of the old backup with a check screen ✅
2. Bill photos (Google Drive), reject with a note, audit log, recycle bin
3. Final Account statement, PDF and Excel
4. Dashboard upgrade, alerts, WhatsApp sharing
