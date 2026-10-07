WHITE_QUIZXYZ 2.3 - Chat & Privacy Upgrade

WHAT WAS FIXED
- Mobile Chat now opens the conversation full-screen with a working Back button.
- Chat messages have Sent / Read receipts, unread counts, edit, and unsend.
- Desktop: use the 3-dot menu on a message or chat row.
- Mobile: long-press a message or chat row to open its actions.
- Individual conversations can be locked with a 6-digit PIN. PINs are stored as SHA-256 hashes, not plain text.
- Chat list entries can be pinned or deleted for the current account only.
- Receiver gets an in-app chat notification; browser notifications work when permission is granted and the app/page is active or hidden in the browser.
- First-login welcome message is shown in-app and a Firestore email queue document is created.

FIREBASE RULES
1. Paste FIREBASE-RTDB-RULES.txt into Realtime Database > Rules.
2. Paste FIRESTORE-RULES.txt into Firestore Database > Rules.

WELCOME EMAIL
The static website cannot directly authenticate to Gmail and send mail securely. To actually deliver the queued welcome email, install/configure the Firebase Trigger Email extension and point it to the /mail collection using your SMTP/Gmail relay. The app already creates the required /mail document only for the signed-in user's own email.

BROWSER CHAT NOTIFICATIONS
On first opening Chat, WHITE_QUIZXYZ requests browser notification permission. This is not a true background push service. For notifications when the app is fully closed, add Firebase Cloud Messaging/Web Push with a server-side sender.
