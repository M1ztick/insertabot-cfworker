# Privacy

What InsertaBot stores, where, for how long, and what it doesn't do. This describes the service as the code in this repository runs it; if the code changes what's collected, this page changes with it.

InsertaBot is run by Mistyk Media on Cloudflare's developer platform. Cloudflare processes the data below on Mistyk Media's behalf.

**Contact for privacy requests:** _add a contact address before publishing this page._

## The short version

- **No ads, no trackers, no analytics.** The web app and the Android app load no analytics or advertising code, and nothing is sold or shared with data brokers.
- **Your chats aren't used to train AI.** The model runs on Cloudflare Workers AI, which doesn't train on what you send it and doesn't keep it after answering ([Cloudflare: Workers AI privacy](https://developers.cloudflare.com/workers-ai/privacy/)).
- **Your history is stored so you can come back to it,** and you can delete one conversation or all of them at any time, from the app or the web.
- **The code is open,** so all of this can be checked.

## What is stored

### Your conversations (kept until you delete them)

Each conversation lives in its own Cloudflare Durable Object and holds:

- the messages, including any images you attach;
- notes the assistant saves for that conversation;
- the model setting (Auto / Research / Coding);
- the tools (MCP servers) you attached to it, including their addresses and the API keys you entered for them.

### Your conversation list (kept until you delete the conversation)

So the list can show on every device, a small index in Cloudflare D1 keeps, per conversation:

- its title (the first line of your first message, up to 80 characters) and a preview (the latest line, up to 140 characters);
- how many messages it has, and when it was created and last used;
- an owner key, which is a one-way hash of your sign-in identity, not your email address.

### Sign-in (Cloudflare Access)

You sign in with your email and a one-time code through Cloudflare Access. Cloudflare keeps an Access log of sign-ins (who, when, from where) for a limited time set by Cloudflare's plan, from 24 hours to 30 days ([Cloudflare: Zero Trust log retention](https://developers.cloudflare.com/cloudflare-one/insights/logs/)). InsertaBot itself does not store your email address.

### Service logs (up to 7 days, about 1 in 10 requests)

To keep the service running, the Worker logs a sample of requests: the method, the path (which includes a conversation's random ID), the status code, how long it took, and short error descriptions. Message text, images and API keys are kept out of these logs on purpose: tool addresses are logged without their query string, and errors are reduced to their type and message. Cloudflare keeps Workers logs for at most 7 days ([Cloudflare: Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)).

### Not stored

- **AI Gateway logs.** Model requests pass through Cloudflare AI Gateway with logging switched off for every request in code, so no prompt, reply or request details are recorded there.
- **Cloudflare's automatic request logs and traces** for the Worker are switched off, since they would record full request URLs.
- **Fonts from Google.** The web app serves its own fonts, so loading it doesn't contact Google.

## Who else sees your data

- **Cloudflare** hosts and runs everything above. Cloudflare is a US company; it acts as InsertaBot's processor and offers a data processing agreement for GDPR purposes.
- **Tools you add.** When the assistant uses a tool you attached (for example Tavily for web search or GitHub), it sends that tool what it needs for the task, such as a search query. That provider handles it under its own privacy policy. Tools are only used if you add them.

## Your controls

- **Delete a conversation:** from its menu in the app or on the web. This deletes its messages, notes and attached tools on every device.
- **Delete everything:** "Delete all my conversations" in the app's Settings, or at the bottom of the web app's conversation list. This removes every conversation you own and its stored data.
- **Sign out:** in the app's Settings. This removes your sign-in from the phone.

What's not built yet: exporting your data in a file, and automatic deletion of old conversations. Until then, you can ask for either through the contact above.
