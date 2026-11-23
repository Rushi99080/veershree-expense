# Veershree Site Manager

The Site Manager app (machine hours, diesel, expenses, murum, vendor payments, machine rent bills, managers' cash book),
upgraded to work for a whole team: logins, roles, approvals and online sync through Firebase. Works offline on site.

Live app: https://rushi99080.github.io/veershree-expense/
Supervisor app: https://rushi99080.github.io/veershree-expense/supervisor/

## Files

| File | What it is |
|---|---|
| `index.html` | The Site Manager app — every screen and calculation, same as before |
| `sync.js` | The new layer: login screens, roles, approvals, users, import check, sync status |
| `cloud.js` | Talks to Firebase (login + database, with an offline copy on the phone) |
| `firebase-config.js` | Firebase keys of the `veershree-expense` project |
| `firestore.rules` | Security rules — paste into Firebase → Firestore Database → Rules → Publish |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline use and "Add to Home Screen" |
| `supervisor/` | The **Supervisor app** (separate link, own home-screen icon): machine readings and diesel on site |

## Roles

| Role | Can do |
|---|---|
| Admin | Everything. Only the admin adds users, assigns sites, deletes and approves |
| Site Manager | Only the sites given to him. Adds entries (they wait for approval). Sees only his own cash book. Cannot change approved entries |
| Accountant | Sees everything. Marks expense / diesel / murum bills paid, records payments |
| Viewer | Sees everything, changes nothing |
| Supervisor | Uses the Supervisor app only: machine in/out readings, diesel filled and diesel received on his sites. Entries wait for approval; sees no money figures |

The online database checks every change against these rules, so a role cannot be bypassed from another copy of the app.

## Phases

1. Login, roles, approvals, offline sync, import of the old backup with a check screen ✅
2. Bill photos (Google Drive), reject with a note, audit log, recycle bin
3. Final Account statement, PDF and Excel
4. Dashboard upgrade, alerts, WhatsApp sharing
