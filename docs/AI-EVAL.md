# AI extraction check

Run: 2026-11-11 10:56 UTC · Groq / `openai/gpt-oss-120b` · build `local`

**16/16 chats fully correct · 18/18 line items carry a quote from the chat · median 1.9 s per draft.**

16 synthetic client chats (English, Russian, Spanish, Kazakh). A chat counts as correct only if every check passes: total, currency, number of items, client email (or none when it is absent), due date, and a warning where one is required.
These are hand-written examples, not real customer data, so they show behaviour on known edge cases, not general accuracy.

| Case | Language | Result | Time |
|---|---|---|---|
| cancelled items | English | ✅ | 1.6 s |
| unapproved quote | English | ✅ | 1.5 s |
| unknown delivery date | English | ✅ | 1.8 s |
| missing contact | English | ✅ | 1.1 s |
| price changed later | English | ✅ | 1.8 s |
| k notation and hourly rate | English | ✅ | 2.8 s |
| deposit already paid | English | ✅ | 1.7 s |
| explicit due date | English | ✅ | 2.1 s |
| email in signature | English | ✅ | 1.8 s |
| zero-decimal currency | English | ✅ | 2.2 s |
| discount mentioned | English | ✅ | 3.6 s |
| Russian chat, euros | Russian | ✅ | 2.3 s |
| Russian chat, cancelled part | Russian | ✅ | 1.6 s |
| Spanish chat | Spanish | ✅ | 2.2 s |
| Spanish chat, no email | Spanish | ✅ | 1.9 s |
| Kazakh chat | Kazakh | ✅ | 2.3 s |

Reproduce: `npm start` with `GROQ_API_KEY` set, then `npm run evaluate-ai` (writes this file).
