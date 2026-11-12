# PingOne MCP Inspector LAB: talk track

Generated from `web/src/data/stories/*.json` (generic vertical) by `npm run talk-track`. Do not edit by hand.

Before you start, say which mode you are in: the header toggle, the `Mode:` chip and the banner all show it. **Mock** is simulated (an in-process mock of the hosted server, an illustrative sample, not a recording). **Live** is owner-run, refused until the owner opts in, and acts on a real server. Both stories run in Mock.

Press P (or the Present button) for presenter mode: larger text, and the banner and the mode stay on screen. Esc leaves it. Reset (header) puts the demo back to its start: audit history, tokens, writes off, the mock's fake tenant, and the diagram boxes.

## S01. Why do I only see twelve tools?

Page: Tools.

- Goal: Lena at the company connects an assistant to PingOne's hosted MCP server and expects the full admin tool set. She sees a short list.
- Obstacle: The tool list is gated by the admin roles of the identity that connects. A short list looks like a broken server, so people debug the wrong thing.
- Control: Mark checks the roles on the connecting identity first. Role gating is the control: a viewer identity never sees write tools, whatever the client asks for.

### Step 1. Connect as a viewer

Do: In the mock demo connection pick the viewer role and press Test connection. The health card counts the tools and says in words that a short list usually means missing roles.

Say: "The server is fine. The identity is what the server is looking at."

Why it matters: Role gating is per identity, so the same server shows different tools to different callers (pingone-mcp skill).

### Step 2. Read the list

Do: Open Tools. Every tool the viewer sees carries a read badge. No write tool is listed, so none can be called.

Say: "No write tool in the list means no write path, not a hidden switch."

Why it matters: A tool that is not listed cannot be called: this app also refuses a call to a tool the identity does not see.

### Step 3. Switch to admin

Do: Switch the demo role to admin and test again. The count grows and write and destructive tools appear, each labelled with why it was classed that way.

Say: "Same server, same URL, a bigger list. Only the roles changed."

Why it matters: The fix for a short list is a role assignment in PingOne, not a retry loop.

### Step 4. Check the real numbers yourself

Do: On a real tenant the count depends on your roles. The skill says a fully privileged worker sees about 60 to 70 tools. That figure is not verified by this app.

Say: "I will quote a number only when I have measured it on our tenant."

Why it matters: Numbers from a document are a starting point; the owner checks listed in docs/live-checks.md settle it.

Proof (allowed path): The viewer list contains read tools only; the admin list contains write and destructive tools as well.

Proof (blocked path): As a viewer, a call to a write tool is refused because the tool is not in the list.

Closing line: "A short tool list is a roles question first, a server question last."

## S02. A write needs a second look

Page: a tool page and the Raw console.

- Goal: Mark wants to change one setting on a tenant that the company runs, through the hosted MCP server, without risking a wrong write.
- Obstacle: An admin-plane MCP tool can change or delete real tenant objects. A typed call that looks right can still carry the wrong argument.
- Control: Writes are off by default. When they are on, each call shows the exact arguments and a hash of them, and a destructive call also needs the tool name typed.

### Step 1. Writes are off

Do: Call a write tool with writes off. The call is refused before it leaves this app, and the refusal is in the audit log.

Say: "By default this tool can look and not touch."

Why it matters: A read-only default turns a wrong click into a harmless one.

If the write is blocked: The call is refused with a message that names the setting to change. Nothing was sent to the server. Say: "Blocked, logged, nothing sent."

### Step 2. Turn writes on for this connection

Do: Mark turns on allow writes for one connection. A red banner stays visible while it is on.

Say: "Writes are a decision for this connection, and the page says so."

Why it matters: The banner keeps the state visible for everyone who looks at the screen.

### Step 3. Review the exact arguments

Do: Press Call. A dialog shows the exact arguments and their hash. Changing an argument after review changes the hash and the call is refused.

Say: "What I approve is exactly what runs."

Why it matters: The hash binds the approval to the arguments, so a swapped argument cannot ride on an earlier approval.

If the write is blocked: If the arguments change after the review the hash no longer matches and the server of this app refuses the call. Say: "The approval does not carry over to different arguments."

### Step 4. Type the name for a destructive call

Do: A delete asks Mark to type the tool name. Only then does the confirm button work.

Say: "A delete costs a few extra keystrokes on purpose."

Why it matters: Typing the name forces a read of what is about to happen.

### Step 5. Read the audit

Do: Every call, allowed or blocked, is in the audit page with secrets redacted.

Say: "I can show exactly what was asked, by whom, and what happened."

Why it matters: A log of blocked calls is as useful as a log of allowed ones.

Proof (allowed path): The write ran once, after the review, and the audit shows the call with its hash.

Proof (blocked path): The write was refused (writes off, or changed arguments), and the audit shows the refusal.

Closing line: "Nothing writes until someone has looked at exactly what it will write."

## Caveats to say out loud

- Nothing here was run against a real PingOne tenant. Whether the hosted server accepts a worker (client_credentials) token, which endpoint shape a tenant answers on, and the scopes and consent of the interactive login are UNVERIFIED (docs/live-checks.md).
- The mock tool catalog is an illustrative sample, not a recording. The read, write and destructive classes are a heuristic (docs/classification.md); unknown is treated as a write.
- A clean scan of a tool list is not proof of safety.
