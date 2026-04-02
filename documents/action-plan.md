# What to Do Right Now: The 90-Day Sprint

## An Honest Assessment First

Steve, I've seen a pattern across our conversations. You've explored a *lot* of business ideas — customer education consulting, DemoBuddy as a product, Elocute, 3D printing on Etsy, Django client projects, Bunk Logs, AI-powered SE tools, college essay tutoring (Helena's), a YouTube transcript tool, a learning objectives generator. You've had detailed launch plans written for at least three of these. Some have real progress (Elocute has a working app with a Chrome extension and analytics dashboard). Some are still ideas.

The risk isn't that you lack ambition or ideas. The risk is that you spread across too many things and none of them reach escape velocity.

**The next 90 days need to be about ruthless focus.**

---

## The One Decision That Matters Most

You need to pick ONE business identity and commit to it for 6 months. Based on everything I know about you, the highest-leverage choice is:

**"I help Sales Engineers and presales teams perform at a higher level using AI."**

Not customer education consulting. Not 3D printing. Not Django development. Not Bunk Logs. Those are all fine ideas, but none of them compound the way this one does. Here's why this is the one:

- It's the only business where your day job *is* your R&D lab. Every demo you run at Datadog gives you content, insights, and credibility.
- You already have two working products in this space (DemoBuddy and Elocute).
- The market (presales professionals) is a tight community where reputation spreads fast.
- Your Harvard + Datadog + learning science background is a genuine moat. Nobody else in the SE world has this combination.
- AI for presales is a hot topic right now. The window is open.

Everything else is a distraction until this is generating $5k/month.

---

## The 90-Day Plan: February 24 – May 25, 2026

### Week 1–2: Commit and Clean Up (Now – March 9)

**Day job (non-negotiable foundation):**
- Keep performing at Datadog. This is your income, your credibility, and your lab.
- Use DemoBuddy on every demo. Track your win rate. You need data.

**Business decision:**
- [ ] Pick a business name. "Elocute" works, or something broader. Decide in one evening, not one month.
- [ ] Register the LLC if you haven't yet ($500, one afternoon)
- [ ] Set up a simple business bank account

**Product decision:**
- [ ] Elocute and DemoBuddy are two sides of the same coin: **making SEs better with AI**. Stop treating them as separate projects. They're one platform with two modes: *practice* (Elocute) and *perform* (DemoBuddy).
- [ ] Decide on ONE you'll bring to other people first. My recommendation: **DemoBuddy.** It has a faster value loop — an SE can install it and get value on their next demo, today. Elocute requires ongoing practice habit formation, which is a harder sell initially.

**Kill list:**
- [ ] Stop working on 3D printing as a business. Keep it as a hobby.
- [ ] Stop exploring Django client projects. You don't have time.
- [ ] Bunk Logs is either a passive product that runs itself or it's dead weight. Decide.
- [ ] The learning objectives generator is a cool tool but not a business right now. Shelf it.

### Week 3–4: Build the Librarian Agent (March 10 – March 23)

**Why this first:** The Librarian (from your agent system) is the single highest-leverage thing you can build for your day job AND your business simultaneously.

**For your day job:** It closes your technical recall gap immediately. You stop fearing the "rattle off specs" moments.

**For your business:** A RAG-powered knowledge system for SEs is a genuinely valuable product. If you build it for yourself over Datadog docs and it works, the architecture generalizes to any company's product docs.

**Concrete steps:**
- [ ] Set up ChromaDB in a Podman container on your Mac
- [ ] Write a Python ingestion script that processes Datadog documentation into embeddings
- [ ] Build a simple query interface (CLI is fine for now — you can use it via terminal during calls)
- [ ] Add your personal feature learning notes and talk tracks
- [ ] Test it: can you ask "What's our retention policy for log archives?" and get an accurate answer in under 3 seconds?

**Time budget:** 10–12 hours over two weeks. Evenings after kids are in bed. This is a focused build, not an exploration.

### Week 5–6: Ship Your First LinkedIn Content (March 24 – April 6)

**You've been told to post on LinkedIn in at least three of our previous conversations. It's time to actually do it.**

This is not optional for Path A. Expert status requires visibility. Visibility requires content. Content requires publishing.

**Post #1:** "I built an AI tool to help me run better demos. Here's what happened."
- Tell the DemoBuddy story. What problem it solves. One specific example of how it changed a demo.
- Keep it under 200 words. Be real, not salesy.

**Post #2:** "The cognitive load problem nobody talks about in presales."
- Draw from your learning science background. Explain why SEs struggle to recall specs under pressure and what the research says about it.
- This positions you as the "thinking SE" — someone with a framework, not just opinions.

**Post #3:** "3 things I learned from building a certification program at Pantheon."
- Leverage your past. This is credibility content.

**Post #4:** Something about AI observability — tie it to your Datadog work without revealing anything proprietary.

**Rules:**
- [ ] Write all 4 posts in one sitting (2 hours max). Schedule them over 2 weeks.
- [ ] Do not spend more than 30 minutes per post. They don't need to be perfect.
- [ ] Do not build a website before you've posted 10 times on LinkedIn. LinkedIn IS your website right now.

### Week 7–8: Get 5 SEs to Use DemoBuddy (April 7 – April 20)

**This is your validation moment.** Not paying customers yet — just real users.

**Steps:**
- [ ] Identify 5 SEs outside Datadog (PreSales Collective, LinkedIn connections, former Pantheon colleagues who moved to SE roles)
- [ ] Offer DemoBuddy free for 30 days in exchange for honest feedback
- [ ] Set up a 15-minute onboarding call with each person
- [ ] Create a simple feedback form (Google Form, 5 questions)

**What you're testing:**
- Do they actually use it more than once?
- What feature do they ask for that you haven't built?
- Would they pay? How much?

**If 3 out of 5 use it actively for 2+ weeks, you have a product.**
**If 0 out of 5 stick with it, you have a learning opportunity, not a failure.**

### Week 9–10: Build the Chronicler Agent (April 21 – May 4)

**Why now:** By this point you've been using the Librarian daily for a month. You know what works. Now add the second agent — the one that saves you 3–5 hours per week on post-call documentation.

**Concrete steps:**
- [ ] Build a Python script that takes a call transcript (from Gong export or manual paste) and outputs: CRM summary, follow-up email draft, action items, technical requirements
- [ ] Use Claude API with a structured output prompt
- [ ] Store outputs in a local SQLite database so you can reference past calls

**The time you save here goes directly into business-building time.** That's the whole point.

### Week 11–12: First Revenue Attempt (May 5 – May 25)

**By now you should have:**
- A working Librarian you use daily
- A working Chronicler saving you hours
- DemoBuddy being tested by 5 external SEs
- 4+ LinkedIn posts published with some engagement
- Feedback data from your beta users

**Revenue move #1: Offer a paid workshop.**
- Title: "How to Use AI to Become a 10x Sales Engineer"
- Format: 90-minute live virtual workshop
- Price: $149/person
- Audience: SEs from PreSales Collective, LinkedIn followers
- Content: Walk through your personal AI agent system — how you use Librarian, Chronicler, DemoBuddy in your actual workflow
- Include: Templates they can use, your prompt library, your RAG setup guide

**Target: 10–20 attendees = $1,500–$3,000.** This isn't life-changing money. It's proof of concept. If 15 people pay $149 to hear you talk about this for 90 minutes, you have a business.

**Revenue move #2: DemoBuddy paid tier.**
- If beta users love it, launch a $20–30/month individual tier
- 5 paying users at $25/month = $125/month. Tiny, but real.

---

## What NOT to Do in the Next 90 Days

| Temptation | Why to Resist It |
|---|---|
| Build a full SaaS platform with auth, billing, teams | You're validating, not scaling. Premature infrastructure kills side projects. |
| Redesign Elocute's UX again | You've already done multiple redesign cycles. Ship what you have. |
| Explore a completely new business idea | You have too many ideas, not too few. Commit. |
| Spend 3 weeks on a website | LinkedIn is your distribution. A website with no traffic is a vanity project. |
| Wait until DemoBuddy is "ready" | It will never feel ready. Get it in front of real users with rough edges. |
| Compare yourself to SEs with CS degrees | Irrelevant. Your differentiation is the learning science angle. Own it. |

---

## Weekly Time Budget (Realistic)

You have a full-time job and a family. Here's what's actually sustainable:

| Day | Time | Activity |
|---|---|---|
| Monday–Friday | Full day | Datadog (use Librarian + DemoBuddy during work — this IS business R&D) |
| Tuesday & Thursday evenings | 8:30–10:30pm (2 hrs each) | Build: Agent system, product features |
| Saturday morning | 7:00–10:00am (3 hrs) | Content: LinkedIn posts, workshop prep, community engagement |
| Sunday | OFF | Family. Non-negotiable. |

**Total: 7 hours/week on the business.** Not 20. Not 15. Seven focused hours with clear deliverables. This is sustainable for a year without burning out or straining your marriage.

---

## The 90-Day Scoreboard

At the end of May 2026, check yourself against this:

| Metric | Target | Pass/Fail |
|---|---|---|
| Librarian agent built and used daily | Yes | |
| Chronicler agent saving 3+ hrs/week | Yes | |
| DemoBuddy in hands of 5+ external SEs | Yes | |
| LinkedIn posts published | 8+ | |
| LinkedIn connections in presales community | 50+ new | |
| Workshop delivered or scheduled | Yes | |
| First dollar of business revenue earned | Yes | |
| Datadog quota attainment | On track | |
| Family relationships intact | Yes | |

**If you hit 7 out of 9, you're on Path A.**
**If you hit 4 out of 9, you're drifting toward Path B.**
**If you hit fewer than 4, something needs to change.**

---

## The Uncomfortable Truth

You have had versions of this plan before. You've had detailed week-by-week launch plans for customer education consulting (November 2025), for the AI-powered SE toolkit (August 2025), for Bunk Logs (earlier). Some made progress. Some didn't.

The difference between Path A ($5–7M) and Path C ($1.5–1.8M) is not a better plan. It's execution consistency over 7 hours a week for 3 years.

That's it. That's the whole secret.

Start tonight.
