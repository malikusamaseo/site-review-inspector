# Site Review Inspector

A Chrome extension + server for reviewing websites, set up as a **multi-tenant tool you can lease to agencies** on monthly or yearly plans.

Three roles:

- **Platform admin (you, the provider)** – a separate panel at `/super` to add agencies as subscribers, set each one's plan and expiry, renew, suspend, delete, and see usage. You can open any agency's panel for support — this access is **logged and shown to the agency** (not hidden).
- **Agency admin / owner (your subscriber)** – signs in to their own dashboard: sees every comment from their team, resolves/deletes, filters, searches, exports CSV, and adds/removes their own reviewers **and developers**. Each agency is fully isolated — one agency never sees another's data.
- **Developer (added by the admin)** – a sub-admin inside one agency. Sees all of the agency's comments, resolves/reopens them, exports CSV, and can **add reviewers**. A developer **cannot** edit, disable or remove any person, cannot add other developers, cannot delete anyone else's comment (only their own), and has no access to billing/plan. In their Team view they can see who the admin is, read-only.
- **Reviewer (added by an admin or developer)** – inspects websites with the extension, leaves comments, and sees their own "My comments" page with Pending/Resolved status.

**Extension** – floating review button (bottom-left), yellow inspect mode, hover highlight, click an element to open the comment box (name + description), with the element's selector, tag, id, classes, size, font and colours. Each comment is sent with the page URL, element details and a screenshot. Numbered pins show existing comments on the page.

```
site-review-tool/
├── extension/   ← load this folder in Chrome
└── server/      ← Node.js server, platform panel + agency dashboard
```

---

## 1. Run the server

Needs Node.js 18 or newer.

```bash
cd server
npm install
npm start
```

**First run — create your platform admin:** open **http://localhost:4000/super** and create the platform-admin account (one-time). This is you, the provider.

Then, still at `/super`, click **Add agency** to create a subscriber: the agency name, the owner's name/email/password, the plan (monthly/yearly), optional expiry date, grace period and reviewer limit. You get a ready-to-send invite with their sign-in details.

Agency owners and reviewers sign in at **http://localhost:4000** (and in the extension).

Settings (environment variables):

| Variable   | Default        | Purpose                                   |
|------------|----------------|-------------------------------------------|
| `PORT`     | `4000`         | Port to listen on                         |
| `DATA_DIR` | `server/data`  | Where `db.json` and screenshots are saved |

### Put it online (so reviewers outside your network can use it)

Reviewers need to reach the server, so deploy it to any Node host with HTTPS — e.g. a VPS behind Nginx/Caddy, Render, Railway or Fly.io. Use a persistent disk for `DATA_DIR` so comments survive restarts. A `Dockerfile` is included:

```bash
cd server
docker build -t site-review .
docker run -d -p 4000:4000 -v site-review-data:/data site-review
```

Back up `DATA_DIR` regularly — it holds all users, comments and screenshots.

---

## 2. Install the extension

1. Open `chrome://extensions` in Chrome (also works in Edge, Brave, Arc).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and choose the `extension` folder.
4. Pin the extension, click its icon, open **Server**, enter your server URL and sign in.

**Tip – save reviewers a step:** before you share the extension, change `DEFAULT_SERVER` at the top of `extension/background.js` to your live server URL. Reviewers then only type their email and password.

To share with reviewers, zip the `extension` folder and send it (they follow the same steps), or publish it to the Chrome Web Store as an unlisted item.

---

## 3. Using it

**Owner and reviewers (extension)**
1. Open any website. Click the round button at the bottom-left (or the extension icon → *Inspect this page*, or `Alt+Shift+C`).
2. The page gets a yellow tint; hovering highlights elements with their tag and size. Links and buttons won't fire while inspecting.
3. Click an element → the comment box opens. Enter your name and what should change, then **Submit comment** (`Ctrl/Cmd+Enter`).
4. Use **Parent element** to select the surrounding block, **Element details** to see properties, **Reselect** or click another element to change selection. `Esc` closes the box, `Esc` again leaves review mode.
5. Numbered pins mark open comments on the page — click one to read it.

Reviewers see only their own comments; the owner sees everyone's.

**Reviewers (dashboard)**
- Click the extension icon → **My comments** (or open the server address and sign in). This opens the reviewer dashboard, already signed in.
- It lists every comment they submitted with its status: **Pending** (waiting for the owner) or **Resolved**, with when it was resolved, the screenshot and element details. Filter by status or website, or search.
- When the owner resolves or reopens a comment, the reviewer's dashboard updates by itself (every 20 seconds and whenever the tab is opened again), marks the comment **Updated** and shows a short notice.
- The extension popup also shows the reviewer's Pending and Resolved counts.

**Admin / owner (dashboard)**
- **Comments** – filter by status, website or reviewer, search, open a comment to see the screenshot with the highlighted element, copy its selector, open the page, mark resolved/reopen, delete, or export everything to CSV.
- **Team** – add a **reviewer or a developer** (pick the role, use *Generate* for a password, then *Copy invite* to send them their sign-in details), restrict them to certain websites, reset their password, disable or remove them. Disabling or removing someone signs them out of the extension immediately; their past comments are kept.
- **Account & plan** (in the top-right menu) – shows their plan, renewal date, reviewer limit, and the log of every time you (the provider) opened their panel.

**Developer (dashboard)**
- Same **Comments** view as the admin — sees every comment in the agency, can resolve/reopen and export, and can delete only their own comments.
- **Team** – can add reviewers only, and sees the rest of the team (including who the admin is) read-only. Cannot edit, disable or remove anyone, add developers, or see billing.

**Platform admin (you) — `/super`**
- **Overview** – total agencies, active, expiring within 7 days, expired/suspended, plus reviewer and comment totals.
- **Agencies** – each row shows plan, status (Active / In grace / Expired / Suspended), renewal date, reviewer and comment counts.
  - **Open panel** – opens that agency's dashboard in a new tab, signed in as the owner, for setup or support. A purple banner shows you're in support view, and the access is written to the agency's access log (they can see it). Click **Exit support view** to return.
  - **Renew** – extend by a month or year (early renewals add to the remaining time, not replace it). Also reactivates a suspended agency.
  - **Edit** – change the agency/owner name, owner email, reset the owner's password, change plan, expiry date, grace days, reviewer limit, or suspend the agency (blocks their logins).
  - **Access log** – every support access to that agency.
  - **Delete** – permanently removes the agency, its users and all their comments.

### Subscriptions

- **Plans:** Monthly (30 days) or Yearly (365 days). New agencies get a full period from today unless you set a custom expiry.
- **Reviewer limit:** optional per agency; blank = unlimited. Owners can't exceed it.
- **On expiry:** owners and reviewers keep working during a **grace period** (default 7 days, set per agency) with a renewal warning; after grace, their logins are blocked with a "please renew" message until you renew. You can set grace to 0 to block immediately.
- **Billing is record-keeping only** — you set plans and renewals by hand and invoice agencies yourself. Online payment (e.g. Stripe auto-renewal) isn't included but can be added later.

---

## Notes

- Passwords are hashed (scrypt); sessions last 30 days; repeated wrong passwords are rate-limited.
- Each agency's users and comments are scoped by agency, so tenants are isolated at the API level.
- Super-admin support access is **logged and visible to the agency**, and while in support view you can't change the owner's own email or password. This keeps you compliant with the trust and data-protection expectations of paying business customers.
- The session token stays in the extension's background worker — websites you review can't read it.
- Chrome blocks extensions on `chrome://` pages and the Chrome Web Store, so those pages can't be inspected.
- **Upgrading from the earlier single-owner version:** on first start, your existing owner and comments are automatically moved into a default agency called "My Agency". Create your platform admin at `/super` and you'll see it listed.
- Storage is a JSON file, which suits a modest number of agencies. For large scale, swap it for a database (all storage code is at the top of `server/server.js`).
