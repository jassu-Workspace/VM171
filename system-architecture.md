🏢 System Architecture: Zero-Trust AI Web Agent

Architecture Type: Distributed Edge-Cloud Hybrid (Zero-Trust)

Core Philosophy: "The Cloud does the thinking; The Edge does the acting."

---

## ⚠️ What Is Actually Built vs. What Is Aspirational

This document is the original pitch framing and is kept as the record of intent.
Read it as a vision, not as a description. Concretely:

| This document says | Reality |
|---|---|
| "Hosted on Railway/Render" | **Local only.** The server binds to loopback and *refuses* a non-loopback `HOST` at boot. Cloud deployment is blocked by design, not by oversight. |
| "The Database (The Vault)" storing user accounts and subscriptions | **No database exists.** There is no user account system, no multi-tenancy, and no server-side identity store. |
| "Telemetry & Billing Engine" tracking tokens per user to charge $10/month | **No billing.** Telemetry is per-session local statistics. |
| "verifies the user's API key/subscription" | There are no users and no subscription. Auth is a signed bearer token obtained by exchanging a one-time pairing code. |
| "LLM Router … routes to a premium model" | Two fixed providers in priority order: Gemini, then 9router. No per-task cost routing. |
| "Client Redaction + Server VLM" | Redaction is real. There is no server-side VLM — vision is local ONNX, and the model call is a text LLM. |

The three-layer redaction path, the split-brain execution model, and the
"bouncer at the edge" idea **are** built and are described accurately above.

**Trust boundary worth stating explicitly:** the server is not trusted with
respect to page content. Untrusted page text is delimited and neutralised so it
cannot become an instruction — including an instruction to end the agent's run.
A page claiming the task is finished produces an *observation* with a strength
and a source, marked unverified; whether the agent may stop is decided
server-side. See `README.md` § Security & Privacy Model for the full list.

1\. The Three Pillars of Your Startup

Pillar A: The Edge Client (The Browser Extension)

This is the software your users install. It is the "Body" and the "Bouncer."

The UI Layer (The Dashboard): Built with React. This is the pop-up window where users type commands, view task history, and manage their subscription.

The Privacy Engine (The Bouncer): A lightweight JavaScript module that runs locally. It uses Regex (Shape Matching) to scan the webpage's hidden text (DOM) and instantly redact emails, credit cards, and passwords into \[MASKED] tags.

The Execution Engine (The Operative): A "Content Script" injected into the active tab. It receives coordinates (Selectors) from the server and uses the browser's native API to create "Ghost Mouse" clicks and lightning-fast typing.

The State Manager: Keeps track of the current loop (e.g., "Step 2 of 4: Waiting for page to load after clicking 'Checkout'").

Pillar B: The Orchestration Server (Hosted on Railway/Render)

This is your startup's backend. It is the "Brain" and the "Manager."

The API Gateway: The secure front door. It receives the masked "Stunt Double" text from the user's extension and verifies the user's API key/subscription.

The Agentic Router (The Brain): This is where the magic happens. It takes the masked text, wraps it in a smart prompt, and sends it to the AI. It manages the "Loop" (Action -> Observation -> Next Action).

The Telemetry \& Billing Engine: Tracks exactly how many "tokens" (AI words) each user consumes. This is how you will charge your customers money (e.g., $10/month for 5,000 actions).

The Database (The Vault): Stores user accounts, subscription statuses, and anonymized task logs. Crucially: It never stores the raw webpage data.

Pillar C: The Intelligence Layer (External Cloud AI)

This is the raw brainpower you rent.

LLM Router: Instead of hardcoding just one AI, your Server uses a router. If a task is simple (like "click the home button"), it sends it to a cheap, fast AI. If the task is complex (like "figure out this multi-step tax form"), it routes it to a premium, genius AI (like Claude or GPT-4). This saves your startup massive amounts of money on server bills.

