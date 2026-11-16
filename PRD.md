# Personifinn: product requirements

Version 1.0, 2026-11-17. Source: the landing page (`public/index.html`), which was the only material when this was written. Decisions marked **Assumption** were made without the owner's input and can be changed.

## 1. Problem

People keep money in several places: bank accounts, e-wallets, PayPal, an RDN account, cash. No single place shows the total, where it went, or whether a purchase is affordable. Spreadsheets do this but nobody keeps them up to date.

## 2. Product

Personifinn is a web app that shows every wallet in one dashboard, records and categorises transactions, tracks budgets and savings goals, issues invoices with a shareable link and QR code, and answers questions about the user's money through an AI auditor called Finny.

## 3. Users

- **Individual with several wallets** (primary). Wants one net-worth number and to know where the money goes.
- **Freelancer.** Also bills clients and wants incoming payments to land in the right wallet.

**Assumption:** the first market is Indonesia (the landing page mentions QRIS and RDN), so the default currency is IDR and the category rules know Indonesian merchants. The interface is in English, like the landing page.

## 4. Scope of version 1

Each landing-page promise, and what version 1 delivers for it.

| Landing-page promise | Version 1 | Not in version 1, and why |
|:---|:---|:---|
| Universal dashboard: connect banks, e-wallets, PayPal, RDN | Wallets of any type, added by hand, with opening balance. Net worth, monthly income and spending, six-month chart, spending by category. CSV statement import. | Live bank and e-wallet connections. They need a licensed aggregator contract (for example Brick or Finantier) and per-bank consent flows. |
| Zero-admin payments: pay by transfer, card or QRIS from any wallet | Transfers between wallets are recorded in the ledger. | Moving real money. That needs a payment licence or a licensed partner (for example Xendit or Midtrans) and KYC. |
| Smart receive and invoice: dynamic QR, reminders by WhatsApp or email | Invoices with line items, a public page per invoice, a QR code that opens it, one-tap sharing through WhatsApp or email from the user's own apps, payment instructions, "mark as paid" that records the income. | A QRIS code that settles automatically (needs an acquirer). Automatic reminders (need a WhatsApp Business API account and an email service). |
| Automated tracking from bank syncs and email receipts | Automatic categorisation by keyword rules and by what the user chose before. CSV import with duplicate detection. | Bank sync (see above) and reading the user's mailbox (needs Gmail or Outlook OAuth approval). |
| AI financial auditor | Finny chat. Uses Claude when an API key is configured and a built-in rule engine otherwise. Alerts for unusual spending, budgets near the limit and overdue invoices. Recurring-charge detection. | Finny carrying out actions (it only advises). |
| Offline-first, iOS, Android, web, single sign-on | Installable web app (PWA). Works offline with the last synced data; transactions added offline sync on reconnect. Email and password sign-in. | Native store apps. Google or Apple sign-in (needs OAuth credentials). |
| Bank-grade encryption | HTTPS in transit (from the hosting proxy), hashed passwords, per-user data isolation, data export and account deletion. | Encryption of the database file at rest. The landing page's "256-bit AES end-to-end" claim is **not** true of version 1 and should be reworded before public launch. |

## 5. Functional requirements

### Accounts
- FR-1 Register with name, email, password (8 characters or more) and currency. A "Cash" wallet is created.
- FR-2 Sign in, sign out. Sessions last 30 days.
- FR-3 Change name and currency. Changing currency relabels amounts and does not convert them.
- FR-4 Export all data as JSON. Delete the account and all its data after re-entering the password.

### Wallets and transactions
- FR-5 Create, edit and delete wallets (bank, e-wallet, cash, PayPal, RDN, card, other). A wallet with transactions or invoices cannot be deleted.
- FR-6 Record income, expense and transfer transactions with amount, date and note. Edit and delete them.
- FR-7 When no category is chosen, pick one: first the category the user last used for the same note, then keyword rules, else "Other".
- FR-8 Import a CSV statement into a wallet. Importing the same file twice adds nothing.
- FR-9 Search transactions by note or category and filter by wallet.

### Planning
- FR-10 Set a monthly limit per spending category and show progress.
- FR-11 Create savings goals with target, optional date, and contributions.

### Invoices
- FR-12 Create an invoice with client, contact, due date, items, receiving wallet and payment instructions. Numbering is per user (INV-0001).
- FR-13 Each invoice has a public page reachable only through an unguessable link, and a QR code for that link.
- FR-14 Share the link through WhatsApp or email. Mark an invoice paid once; this records income in the receiving wallet.

### Finny
- FR-15 Answer questions in natural language from the user's own data: spending by category and period, affordability, recurring charges, budgets, goals, overview.
- FR-16 Show alerts on the dashboard: category spending 50% above the recent monthly average, budgets at 90% or more, overdue invoices.

### Offline
- FR-17 The app opens without a connection and shows the last synced data.
- FR-18 Transactions added offline are stored on the device and sent on reconnect, without duplicates.

### Landing page
- FR-19 The landing page stays at `/`, links to the app, and stores waitlist emails in the app's database as well as sending them through FormSubmit.

## 6. Non-functional requirements

- NFR-1 One container, one SQLite file, no external services required to run.
- NFR-2 A user can never read or change another user's data (covered by the automated test).
- NFR-3 Money is stored as integers, never floating point.
- NFR-4 Usable on a 360 px wide phone and on desktop. Keyboard focus is visible; form fields have labels.
- NFR-5 Sign-in, registration, waitlist and chat are rate limited.

## 7. Success measures

**Assumption**, for the private beta:
- A new user records a first transaction within two minutes of registering.
- Half of weekly active users open Finny at least once a week.
- Waitlist to registered-user conversion.

## 8. Roadmap after version 1

1. Bank and e-wallet sync through an aggregator.
2. Real payments and auto-settling QRIS through a licensed payment partner.
3. Automatic invoice reminders (WhatsApp Business API, email service).
4. Google sign-in.
5. Receipt capture: photo or forwarded email parsed by Claude.
6. Finny actions with confirmation (create a budget, record a transfer).

## 9. Open questions for the owner

1. Is Indonesia-first with IDR default correct?
2. Which Claude model should Finny use? It is set to Claude Opus 5.5; a smaller model costs less per chat.
3. Reword the "256-bit AES" and "Private Beta Commencing Soon" copy on the landing page?
4. Should registration be open, or limited to waitlist emails?
