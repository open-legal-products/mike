# Google integrations: screenshot walkthrough

**Historical layout:** the separate Google accounts section and preconnection dialogs shown below have been superseded. [See the current Discover layout and direct OAuth flow](google-discover-2026-09-24.md). The inline Assistant and earlier live-read captures remain useful evidence for their recorded states.

The connector cards now use the official Google Drive, Gmail, and Google Calendar product logos, served locally. The Google sign-in button keeps the Google identity logo. Emails and permissions now occupy separate lines without ellipsis; long addresses wrap and cards grow as needed. These content-fitting rules are saved in AGENTS.md and the design-system guide.

**Screenshots 1–14 are actual screenshots of the rebuilt application with synthetic API fixtures.** They demonstrate the user interface, including inline approvals and resulting states. No email was sent and no event was created by these fixture captures. They do not establish live Google write acceptance.

**Screenshots 15–17 are the earlier real Google read-flow captures** from MikeOSS in `soy-oarlock-503613-m7`, with synthetic source data. They are not newly repeated tests. Gmail positive message reads and live approved writes remain outstanding. Google-owned account chooser/consent screens are not represented by the fixture screenshots. Drive remains read-only.

Validation for the logo change: 35 connector/Settings component tests; 11 browser tests covering account selection/write upgrade/approval and normal/long addresses at 390/768/1280px in light/dark layouts; changed-file lint; production Webpack build and TypeScript. All passed. The local Turbopack attempt stalled after a sandbox port-binding error; CI retains the standard build command.

## 1. Connectors before opting in

![Connectors before opting in](google-integrations-2026-09-23/product-logo-walkthrough/01-connectors-not-connected.png)

## 2. Drive setup

![Drive setup](google-integrations-2026-09-23/product-logo-walkthrough/02-drive-setup.png)

## 3. Gmail setup

![Gmail setup](google-integrations-2026-09-23/product-logo-walkthrough/03-gmail-setup.png)

## 4. Calendar setup

![Calendar setup](google-integrations-2026-09-23/product-logo-walkthrough/04-calendar-setup.png)

## 5. Connected services with their product logos

![Connected services with their product logos](google-integrations-2026-09-23/product-logo-walkthrough/05-connectors-read-only.png)

## 6. Drive connected read-only

![Drive connected read-only](google-integrations-2026-09-23/product-logo-walkthrough/06-drive-read-only.png)

## 7. Gmail connected read-only and optional write upgrade

![Gmail connected read-only and optional write upgrade](google-integrations-2026-09-23/product-logo-walkthrough/07-gmail-read-only.png)

## 8. Calendar connected read-only and optional write upgrade

![Calendar connected read-only and optional write upgrade](google-integrations-2026-09-23/product-logo-walkthrough/08-calendar-read-only.png)

## 9. Gmail after optional write consent

![Gmail after optional write consent](google-integrations-2026-09-23/product-logo-walkthrough/09-gmail-write-enabled.png)

## 10. Calendar after optional write consent

![Calendar after optional write consent](google-integrations-2026-09-23/product-logo-walkthrough/10-calendar-write-enabled.png)

## 11. Review an email action inside Assistant

![Review an email action inside Assistant](google-integrations-2026-09-23/product-logo-walkthrough/11-assistant-email-approval.png)

## 12. Email action completion inside Assistant

![Email action completion inside Assistant](google-integrations-2026-09-23/product-logo-walkthrough/12-assistant-email-completed.png)

## 13. Review a calendar action inside Assistant

![Review a calendar action inside Assistant](google-integrations-2026-09-23/product-logo-walkthrough/13-assistant-calendar-approval.png)

## 14. Rejected calendar action inside Assistant

![Rejected calendar action inside Assistant](google-integrations-2026-09-23/product-logo-walkthrough/14-assistant-calendar-rejected.png)

## 15. Previously captured live Drive document read

![Previously captured live Drive document read](google-integrations-2026-09-23/product-logo-walkthrough/15-live-drive-read.png)

## 16. Previously captured live Calendar event read

![Previously captured live Calendar event read](google-integrations-2026-09-23/product-logo-walkthrough/16-live-calendar-read.png)

## 17. Previously captured live Gmail/Calendar read-only boundary

![Previously captured live Gmail/Calendar read-only boundary](google-integrations-2026-09-23/product-logo-walkthrough/17-live-readonly-boundary.png)

