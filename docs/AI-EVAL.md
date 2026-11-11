# AI extraction check

Run: 2026-11-11 09:59 UTC · Groq / `openai/gpt-oss-120b` · build `local`

**16/16 chats fully correct · 18/18 line items carry a quote from the chat · median 2.5 s per draft.**

16 synthetic client chats (English, Russian, Spanish, Kazakh). A chat counts as correct only if every check passes: total, currency, number of items, client email (or none when it is absent), due date, and a warning where one is required.
These are hand-written examples, not real customer data, so they show behaviour on known edge cases, not general accuracy.

| Case | Language | Result | Time |
|---|---|---|---|
| cancelled items | English | ✅ | 4.4 s |
| unapproved quote | English | ✅ | 2.1 s |
| unknown delivery date | English | ✅ | 1.7 s |
| missing contact | English | ✅ | 1.6 s |
| price changed later | English | ✅ | 1.9 s |
| k notation and hourly rate | English | ✅ | 3.5 s |
| deposit already paid | English | ✅ | 1.9 s |
| explicit due date | English | ✅ | 1.5 s |
| email in signature | English | ✅ | 2.7 s |
| zero-decimal currency | English | ✅ | 2.4 s |
| discount mentioned | English | ✅ | 2.8 s |
| Russian chat, euros | Russian | ✅ | 2.7 s |
| Russian chat, cancelled part | Russian | ✅ | 2.5 s |
| Spanish chat | Spanish | ✅ | 6.8 s |
| Spanish chat, no email | Spanish | ✅ | 2.4 s |
| Kazakh chat | Kazakh | ✅ | 2.9 s |

Reproduce: `npm start` with `GROQ_API_KEY` set, then `npm run evaluate-ai` (writes this file).
