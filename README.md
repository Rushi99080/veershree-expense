# Veershree Plot Expense Manager

Site expenses, machine hour logs, diesel, machine rent bills, vendors and the cash book for Veershree plot development sites.
Multi-user (admin, site manager, accountant, viewer), works offline on site, syncs through Firebase.

Live app: https://rushi99080.github.io/veershree-expense/

## Files

| File | What it is |
|---|---|
| `index.html` | The page |
| `app.js` | The app (all screens and calculations) |
| `cloud.js` | Login and sync with Firebase |
| `oldcalc.js` | Totals the way the first version counted them (used by the import check) |
| `styles.css` | Navy + gold look, light and dark |
| `firebase-config.js` | **Your Firebase keys go here** (the only file you edit) |
| `firestore.rules` | Security rules: paste into Firebase → Firestore → Rules |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline use and "Add to Home Screen" |

## Phases

1. Data migration, login, roles, offline sync ✅
2. Bill photos (Google Drive), approvals with notes, audit log, recycle bin
3. Final Account statement, PDF and Excel
4. Dashboard upgrade, alerts, WhatsApp sharing
