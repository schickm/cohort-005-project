# Postmark and email law for non-transactional notification email

Answers wayfinder ticket #6 (map #2). Researched 2026-11-12 from primary sources. Not legal advice.

Location note: the repo has no existing research-notes convention, so this lives in `docs/research/`.

## Short answer

- Postmark separates streams by purpose: **Transactional** (one-off, user-triggered, no unsubscribe required) vs **Broadcast** (bulk; unsubscribe link mandatory, Postmark injects it). Unsubscribes are per stream.
- A notification email ("someone replied to you", "your course has a new lesson") is not on the CAN-SPAM transactional list and is not a PECR "service message" unless it is purely administrative. Treat it as needing an opt-out.
- Practical rule: only the narrow transactional/relationship/service categories can be sent with no opt-out. Everything else needs a working unsubscribe (footer link plus one-click headers) and a per-recipient preference that is honored.
- Adding any promotion to a transactional message can reclassify it as marketing.

## 1. Postmark

| Topic | Rule | Source |
|---|---|---|
| Transactional stream | "for messages that are usually unique and triggered by a user action" (welcome, password reset, receipts); single recipient, high priority | [Postmark manual](https://postmarkapp.com/manual) ch. 1, 4 |
| Broadcast stream | "for bulk messages that are sent to multiple recipients at once"; examples include promotional offers | [Postmark manual](https://postmarkapp.com/manual) ch. 1, 4 |
| Unsubscribe, transactional | "Transactional messages do not require an unsubscribe link"; headers "not required for your one-off messages sent through Transactional Message Streams"; if you add them Postmark includes them | [manual](https://postmarkapp.com/manual) ch. 5; [List-Unsubscribe header article](https://postmarkapp.com/support/article/1299-how-to-include-a-list-unsubscribe-header) |
| Unsubscribe, broadcast | "Every message sent through a Broadcast Message Stream ... requires an unsubscribe link which Postmark will automatically include"; added at the end if missing | [Why Broadcasts require an unsubscribe link](https://postmarkapp.com/support/article/1217-why-broadcasts-require-an-unsubscribe-link) |
| One-click headers | Postmark-managed unsubscribes add link and headers and suppress for you ("recommended"); headers cannot be edited in that mode. Custom mode: you add a visible link, headers, and list cleanup yourself | [article 1299](https://postmarkapp.com/support/article/1299-how-to-include-a-list-unsubscribe-header) |
| Scope | Unsubscribes apply "only [to] the message stream from which the message was sent"; suppressions are per stream | [manual](https://postmarkapp.com/manual) ch. 5; [article 1217](https://postmarkapp.com/support/article/1217-why-broadcasts-require-an-unsubscribe-link) |
| Separation | Manual recommends separating transactional and bulk sending, using a subdomain for marketing/bulk | [manual](https://postmarkapp.com/manual) ch. 4 step 3 |

Gaps: the Postmark pages I could read do not state a rule on promotional content in transactional streams, and only the first 100k of 127k characters of the manual were read. Postmark's account-approval and acceptable-use pages were not located (guideline URLs tried returned 404), so account-level rules for broadcast use are unverified. Whether notification email may stay on the existing "outbound" (transactional) stream is a Postmark policy judgement these sources do not settle; the conservative reading is that digest or bulk-style notification email belongs on a Broadcast stream.

Also: `app/lib/mailer.server.ts` was not present in the worktree this was researched in, so nothing here was checked against that code.

## 2. CAN-SPAM (US)

Source: [FTC CAN-SPAM Compliance Guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business).

- Commercial message: primary purpose is "the commercial advertisement or promotion of a commercial product or service". Must meet all eight requirements: accurate headers, honest subject, ad identification, physical postal address, clear opt-out, honor opt-out within **10 business days**, opt-out mechanism working at least 30 days after sending, responsibility for agents.
- Transactional or relationship message: content "consists only of" one of five categories: (1) facilitates/completes/confirms an agreed transaction; (2) warranty, recall, safety or security information; (3) change in terms or features of a membership, subscription, account, loan etc.; (4) employment relationship or benefits; (5) delivers goods/services agreed in a transaction. The law "views these categories narrowly".
- These are "otherwise exempt from most provisions"; only the rule against false or misleading routing information applies. No opt-out link required.
- Mixed messages: primary purpose is commercial if the subject line suggests a commercial message, or transactional content does not appear mainly at the beginning.
- Penalty: up to $53,088 per violating email.
- Implication: receipts, refund decisions and account-change emails fit the exemption. A "new reply" or "new lesson" notification fits none of the five categories. It is also not clearly "commercial", so CAN-SPAM likely does not bite, but the guide does not address purely informational mail; PECR/GDPR and mailbox-provider rules below are the tighter constraints.

## 3. UK PECR and UK GDPR (ICO)

- PECR reg. 22: no electronic marketing to individuals without specific consent (e.g. ticking an opt-in box). Soft opt-in for existing customers: similar products, bought or negotiated a sale before, and a simple opt-out at collection and in every message. Does not apply to prospects. Source: [ICO, electronic mail marketing](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/electronic-and-telephone-marketing/electronic-mail-marketing/).
- Direct marketing: "communication (by whatever means) of advertising or marketing material which is directed to particular individuals". Source: [ICO, identify direct marketing](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/direct-marketing-guidance/identify-direct-marketing/).
- Service messages are "not promotional but ... for administrative or customer services purposes" (contact details, appointment confirmation, updated terms) and fall outside PECR marketing rules. If a service message has direct-marketing elements, "even if that is not the main purpose", it counts as direct marketing. General branding or logos alone do not. Same page.
- If a message is not direct marketing, PECR marketing rules do not apply but UK GDPR still does (fairness, transparency, right to object), per ICO guidance on the same topic.
- Right to object: "an absolute right to object ... for direct marketing purposes ... no exemptions". On objection, stop processing for that purpose; keep a suppression list. Source: [ICO, right to object](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-object/).
- Not verified here: EU ePrivacy Directive art. 13 / EUR-Lex text, and the lawful basis (contract vs legitimate interests) for activity notifications. The ICO pages read do not say whether activity notifications are "service messages"; their examples suggest only administrative ones are.

## 4. Gmail and Yahoo bulk-sender rules

Gmail, [Email sender guidelines](https://support.google.com/a/answer/81126):
- All senders: SPF or DKIM; spam rate in Postmaster Tools below 0.3%; DKIM keys 1024 bits or longer for personal Gmail.
- Bulk senders (commonly 5,000+/day; that figure was not in the extracted text, so confirm): SPF, DKIM and DMARC (policy may be `none`), From aligned with SPF or DKIM domain, and "Marketing messages and subscribed messages must support one-click unsubscribe".
- The page does not explicitly exempt transactional mail; it scopes the requirement to "marketing messages and subscribed messages".

Yahoo, [Sender best practices](https://senders.yahooinc.com/best-practices/):
- All: SPF or DKIM. Bulk: both, plus DMARC at least `p=none` passing.
- Bulk: "functioning list-unsubscribe header, which supports one-click unsubscribe for marketing and subscribed messages"; POST method "highly recommended" (RFC 8058); mailto acceptable. Honor unsubscribes within **2 days**. Spam rate below 0.3%. No numeric bulk threshold defined. Advises separating bulk from "user mail, transactional mail, alerts" (by IP).
- No explicit transactional exemption; "subscribed messages" is the operative phrase. A notification the user opted into is arguably a subscribed message, so give it one-click unsubscribe.

## 5. RFC 8058 (one-click unsubscribe)

Source: [RFC 8058](https://www.rfc-editor.org/rfc/rfc8058).
- Send `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (the only permitted value, s3.1/s5).
- `List-Unsubscribe` "MUST contain one HTTPS URI" (may also contain mailto).
- Message "MUST have a valid DKIM signature" covering both headers (`h=`); otherwise receivers should not offer one-click (s3.1, s4).
- Receiver POSTs to the URI with no cookies or auth, so the URI must identify recipient and list itself, with an opaque, hard-to-forge component; do not redirect the POST (s3.1, s3.2).
- You must host an endpoint that handles the POST.

## 6. Kinds of email sendable with no opt-out

Supported by the sources above:
- CAN-SPAM transactional/relationship categories (confirm a transaction, security/recall, account-term changes, employment, delivery). Maps to Purchase and Refund Request decided emails.
- PECR "service messages": purely administrative or customer-service content with no promotion (e.g. payment failure, appointment confirmation, terms update).
- Postmark transactional stream: one-off, user-triggered messages need no unsubscribe link technically.

Not covered by an exemption: activity or engagement notifications, digests, come-back reminders, and anything with promotion. These should carry a preference-backed opt-out. Security and legally required account notices should stay mandatory.

## Open points for #8

- Whether notification email goes on a Broadcast stream (Postmark auto-unsubscribe and suppression) or stays on Transactional with an app-managed preference and custom RFC 8058 headers.
- Unsubscribe state must live in the app (per Notification kind and Channel); Postmark suppression is per stream only.
- Honor unsubscribes within 2 days (Yahoo) and 10 business days (CAN-SPAM).
