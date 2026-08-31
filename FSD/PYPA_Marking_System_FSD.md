**PYPA MARKING SYSTEM**

Functional Specification Document

*Mobile-first competition registration, live judging and result computation platform*

| **Field**         | **Detail**                                                                       |
|-------------------|----------------------------------------------------------------------------------|
| Document title    | PYPA Marking System — Functional Specification Document (FSD)                    |
| Version           | 1.0 (Draft for review)                                                           |
| Status            | For stakeholder sign-off                                                         |
| Date              | August 2026                                                                      |
| Prepared for      | PYPA Organising / Programme Committee                                            |
| Audience          | Project sponsor, organising committee, solution architect, development team, QA  |
| Related documents | To follow: UI Mock Designs (Admin + Judge), Technical Design Document, Test Plan |

**Table of Contents**

**1. Document Control 4**

> 1.1 Purpose of this document 4
>
> 1.2 Intended audience 4
>
> 1.3 Version history 4
>
> 1.4 Glossary 4

**2. Introduction and Scope 6**

> 2.1 Background 6
>
> 2.2 Objectives 6
>
> 2.3 In scope 6
>
> 2.4 Out of scope 7
>
> 2.5 Assumptions 7

**3. System Overview 8**

> 3.1 Actors and roles 8
>
> 3.2 Role and permission matrix 8
>
> 3.3 Conceptual architecture 9
>
> 3.4 Recommended technology stack 9

**4. Core Concepts and Business Rules 11**

> 4.1 The Performance concept — why it matters 11
>
> 4.2 Identity and eligibility rules 11
>
> 4.3 Scoring rules 12
>
> 4.4 Aggregation rules 12
>
> 4.5 Ranking and tie-break rules 13
>
> 4.6 Shared positions 13
>
> 4.7 Points and championship rules 13
>
> 4.8 Result lifecycle 13

**5. Functional Requirements — Administrator Module 15**

> 5.1 Authentication and account management 15
>
> 5.2 Church management 15
>
> 5.3 Category management 16
>
> 5.4 Item (programme) management 16
>
> 5.5 Member management 16
>
> 5.6 Registration management 17
>
> 5.7 Judge management 17
>
> 5.8 Panel and session management 17
>
> 5.9 Live judging console 18
>
> 5.10 Score exception handling 18
>
> 5.11 Scoring configuration 19
>
> 5.12 Results and publication 19
>
> 5.13 Reports and exports 19
>
> 5.14 Audit log 20
>
> 5.15 System settings and data safety 20

**6. Functional Requirements — Judge Module 22**

> 6.1 Judge login 22
>
> 6.2 Home / Now on stage 22
>
> 6.3 Finding a participant by chest number 22
>
> 6.4 Selecting the item 23
>
> 6.5 Mark entry 23
>
> 6.6 Confirmation and submission 23
>
> 6.7 My submissions 24
>
> 6.8 Offline behaviour 24
>
> 6.9 What judges must never see 24

**7. Scoring and Result Computation Engine 25**

> 7.1 Performance state machine 25
>
> 7.2 Multi-judge concurrency — how simultaneous entry is managed 25
>
> 7.3 Aggregate computation 25
>
> 7.4 Item ranking algorithm 26
>
> 7.5 Worked example 26
>
> 7.6 Church championship computation 27
>
> 7.7 Recomputation 27

**8. Data Model 28**

> 8.1 Entity summary 28
>
> 8.2 Critical constraints 29
>
> 8.3 Key relationships 29

**9. API Specification (Indicative) 30**

> 9.1 Authentication 30
>
> 9.2 Administration 30
>
> 9.3 Judge endpoints 31
>
> 9.4 Standard error codes 31

**10. User Interface and Experience Requirements 32**

> 10.1 General principles 32
>
> 10.2 Judge navigation — bottom app bar 32
>
> 10.3 Admin navigation 32
>
> 10.4 Screen inventory 32

**11. Non-Functional Requirements 34**

> 11.1 Performance 34
>
> 11.2 Security 34
>
> 11.3 Usability and accessibility 34
>
> 11.4 Availability, resilience and venue fallback 35
>
> 11.5 Compatibility 35
>
> 11.6 Maintainability and scalability 35

**12. Edge Cases, Validation and Error Handling 36**

> 12.1 Scoring edge cases 36
>
> 12.2 Data management edge cases 36
>
> 12.3 Operational edge cases 37

**13. Event Setup Sequence 38**

**14. Constraints, Dependencies and Risks 38**

> 14.1 Constraints 38
>
> 14.2 Dependencies 38
>
> 14.3 Risks and mitigations 39

**15. Acceptance Criteria 40**

**16. Implementation Roadmap 40**

**17. Open Questions for the Committee 41**

**18. Appendices 42**

> 18.1 Status enumerations 42
>
> 18.2 Default configuration values 42
>
> 18.3 Next deliverables 42

**1. Document Control**

**1.1 Purpose of this document**

This Functional Specification Document (FSD) defines the complete functional behaviour of the PYPA Marking System. It describes every screen, every user role, every business rule, and every calculation the system must perform, in sufficient detail that a development team can build the application and a QA team can verify it without further clarification.

This document deliberately covers more than was originally requested. A competition marking system is a system of record: once the results are announced they are effectively irreversible in the eyes of the participants, and any defect becomes a dispute between churches. The additional scope in this document exists to make the result mathematically defensible and operationally recoverable.

**1.2 Intended audience**

| **Audience**                   | **What they should read**                                                              |
|--------------------------------|----------------------------------------------------------------------------------------|
| Organising committee / sponsor | Sections 2, 3, 4, 7, 15, 17 — scope, roles, rules, scoring, acceptance, open questions |
| Solution architect             | Entire document, with emphasis on 7, 8, 9, 11                                          |
| Developers                     | Sections 5, 6, 8, 9, 10, 12                                                            |
| QA / testers                   | Sections 5, 6, 7, 12, 15                                                               |
| Event-day operators            | Sections 4, 5.9, 5.10, 6, 12                                                           |

**1.3 Version history**

| **Version** | **Date**    | **Author** | **Summary of change**                                  |
|-------------|-------------|------------|--------------------------------------------------------|
| 0.1         | TBC         | Analyst    | Initial capture of requirements from stakeholder brief |
| 1.0         | August 2026 | Analyst    | Full functional specification issued for review        |

**1.4 Glossary**

These terms are used with precise meaning throughout the document. Where a word in this list appears in the specification, it carries the definition below and not its everyday meaning.

| **Term**        | **Definition**                                                                                                                                                                                              |
|-----------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Church          | A participating congregation. The unit that accumulates points and competes for the church championship.                                                                                                    |
| Member          | An individual participant belonging to exactly one church.                                                                                                                                                  |
| Chest number    | The unique number printed on the badge worn by a member. The primary identifier used by judges on stage. Also called badge number.                                                                          |
| Item            | A single competition event, e.g. "Solo Song — Junior Boys", "Bible Quiz — Senior". Referred to as "Program" in the original brief; "Item" is used here to avoid confusion with the overall event programme. |
| Category        | An age or eligibility grouping such as Sub-Junior, Junior, Senior, Super-Senior. Restricts which members may enter which items.                                                                             |
| Registration    | The link between a member and an item, created by admin, indicating the member is entered to compete in that item.                                                                                          |
| Performance     | A single act of competing: one registration presented once on stage. The atomic unit that judges score against. Central concept of the system.                                                              |
| Panel           | The named set of judges assigned to score a given item or session.                                                                                                                                          |
| Score           | One judge's mark for one performance, out of a configurable maximum (default 10).                                                                                                                           |
| Aggregate score | The single number derived from all panel judges' scores for one performance, using the configured aggregation method.                                                                                       |
| Position points | The points awarded to a church when one of its members places first, second, etc. in an item. Configurable.                                                                                                 |
| Grade           | An optional quality band (A / B / C) derived from the aggregate score percentage, independent of position.                                                                                                  |
| Locked          | A state in which a record can no longer be edited by the actor who created it.                                                                                                                              |
| Published       | A result state in which the result becomes visible outside the admin console.                                                                                                                               |

**2. Introduction and Scope**

**2.1 Background**

The PYPA competition brings together members from multiple churches to compete across a range of items. Historically, marking is done on paper: judges write marks on sheets, a coordinator collects them, and a small team manually totals scores to determine winners and the church championship. This process is slow, error-prone, and difficult to audit when a result is challenged.

The PYPA Marking System replaces that paper process with a mobile-first web application. Judges score directly on their phones during the event; the system computes positions, church points and the overall championship automatically and instantly, with a complete audit trail behind every number.

**2.2 Objectives**

1.  Eliminate manual score transcription and the arithmetic errors that come with it.

2.  Give each judge an independent, private, fast scoring interface usable one-handed on a phone in a poorly lit auditorium.

3.  Guarantee that every performance is scored by every judge on its panel, and make missing scores visible immediately rather than at the end of the day.

4.  Make scores immutable once submitted, so that no judge can revise a mark after seeing another performance.

5.  Produce item results, church point totals and the overall champion automatically, with published tie-break rules.

6.  Preserve a full audit trail so any result can be defended if challenged.

7.  Remain usable when the venue network is unreliable.

**2.3 In scope**

- Administrator console: church, category, item, member, registration, judge, panel and session management.

- Role-based authentication with separate credentials for every user; account creation restricted to administrators.

- Judge scoring application, optimised for mobile with an app-style bottom navigation bar.

- Chest-number based participant lookup and item selection during live judging.

- Immutable score submission with confirmation step.

- Live monitoring console showing scoring progress in real time.

- Configurable scoring rules: maximum mark, aggregation method, position points, tie-break order, grade thresholds.

- Automatic computation of item results, individual champion, church points and overall church champion.

- Result publication workflow with a provisional / published distinction.

- Reporting and export (PDF and Excel) for result sheets, church leaderboards and certificates.

- Audit logging of every state-changing action.

- Offline tolerance on the judge application with automatic synchronisation.

**2.4 Out of scope**

The following are explicitly excluded from this release. They are recorded here so that the boundary is unambiguous, and several are candidates for a later phase.

- Self-service registration by members or churches. All data entry is performed by administrators.

- Online payment or entry-fee collection.

- Native iOS or Android applications. The system is a responsive web application; a Progressive Web App install is supported but no app-store distribution is planned.

- Live public scoreboard or spectator-facing display screen (recommended for Phase 2, see Section 16).

- Automated stage call, timing or queue-management hardware integration.

- SMS or email notification to participants.

- Multi-event / multi-year historical comparison analytics beyond simple archival.

**2.5 Assumptions**

- Each member belongs to exactly one church for the duration of an event.

- Chest numbers are unique across the entire event and are assigned by the administrator before judging begins.

- All judges on a panel score the same performance at the same time from their own devices.

- Judges are supplied with, or use their own, smartphones with a modern browser.

- A wireless network is available at the venue, but may be intermittent.

- The number of judges per panel is configurable and is typically three, but the system must not assume three.

**3. System Overview**

**3.1 Actors and roles**

The system defines four roles. Roles are fixed in code; the users holding them are managed by the administrator. Every user has their own username and password — credentials are never shared between judges, because score attribution is the foundation of the audit trail.

| **Role**                     | **Description**                                                                                                                                                                                                                 | **Created by**                               |
|------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------|
| Super Admin                  | Full system control including creation of other administrators, scoring configuration, result publication, and score revocation. Typically one or two people. Cannot be deleted while it is the only Super Admin account.       | System (seeded at install), then Super Admin |
| Admin                        | Day-to-day data management: churches, members, items, registrations, judges, panels and sessions. Can view live progress and provisional results. Cannot publish results or revoke a submitted score unless explicitly granted. | Super Admin                                  |
| Judge                        | Scoring only. Sees no other judge's marks, no totals, no results. Access limited to the sessions they are assigned to.                                                                                                          | Admin or Super Admin                         |
| Stage Coordinator (optional) | Marks a performance as "on stage" so all judges' devices focus on the same participant, and flags absentees. Recommended but can be omitted, in which case the admin performs this from the live console.                       | Admin or Super Admin                         |

**3.2 Role and permission matrix**

A dash indicates the capability is not available to that role. This matrix is the authoritative source for server-side authorisation checks; the user interface hides unavailable actions but the server must enforce them independently.

| **Capability**                              | **Super Admin** | **Admin**         | **Judge** | **Coordinator** |
|---------------------------------------------|-----------------|-------------------|-----------|-----------------|
| Create / edit / deactivate admin accounts   | Yes             | —                 | —         | —               |
| Create / edit / deactivate judge accounts   | Yes             | Yes               | —         | —               |
| Reset another user's password               | Yes             | Yes (judges only) | —         | —               |
| Manage churches                             | Yes             | Yes               | —         | —               |
| Manage categories                           | Yes             | Yes               | —         | —               |
| Manage items                                | Yes             | Yes               | —         | —               |
| Manage members and chest numbers            | Yes             | Yes               | —         | —               |
| Manage registrations                        | Yes             | Yes               | —         | —               |
| Create panels and assign judges             | Yes             | Yes               | —         | —               |
| Open / close a judging session              | Yes             | Yes               | —         | Yes             |
| Set the current performance on stage        | Yes             | Yes               | —         | Yes             |
| Mark a participant absent                   | Yes             | Yes               | —         | Yes             |
| Enter a score                               | —               | —                 | Yes       | —               |
| View own submitted scores                   | —               | —                 | Yes       | —               |
| View all scores for a performance           | Yes             | Yes               | —         | View count only |
| Revoke a submitted score (with reason)      | Yes             | Configurable      | —         | —               |
| Configure scoring rules and position points | Yes             | —                 | —         | —               |
| View provisional results                    | Yes             | Yes               | —         | —               |
| Publish results                             | Yes             | —                 | —         | —               |
| Export reports                              | Yes             | Yes               | —         | —               |
| View audit log                              | Yes             | Read-only         | —         | —               |
| Backup / restore                            | Yes             | —                 | —         | —               |

**3.3 Conceptual architecture**

The system is a single web application serving two distinct interfaces from a shared backend, with a relational database as the single source of truth.

> ┌────────────────────┐ ┌────────────────────┐
>
> │ Admin Console │ │ Judge App │
>
> │ (responsive web, │ │ (mobile-first, │
>
> │ desktop-leaning) │ │ bottom nav, PWA) │
>
> └─────────┬──────────┘ └─────────┬──────────┘
>
> │ HTTPS / JSON │
>
> └──────────────┬──────────────┘
>
> │
>
> ┌─────────▼──────────┐
>
> │ Application API │
>
> │ ─ Auth / RBAC │
>
> │ ─ Master data │
>
> │ ─ Scoring engine │
>
> │ ─ Result engine │
>
> │ ─ Audit service │
>
> └─────────┬──────────┘
>
> │
>
> ┌──────────────┼──────────────┐
>
> │ │ │
>
> ┌────────▼──────┐ ┌─────▼──────┐ ┌─────▼───────┐
>
> │ Relational │ │ Realtime │ │ File store │
>
> │ database │ │ channel │ │ (photos, │
>
> │ (PostgreSQL) │ │ (WebSocket│ │ exports) │
>
> └───────────────┘ │ or SSE) │ └─────────────┘
>
> └────────────┘

The realtime channel pushes two things: the current performance on stage (so every judge's device follows the coordinator automatically), and live scoring progress to the admin console. If the realtime channel is unavailable the application degrades to polling; it is a convenience layer, never a correctness dependency.

**3.4 Recommended technology stack**

This is a recommendation, not a requirement of the specification. Any stack that satisfies Section 11 is acceptable.

| **Layer** | **Recommendation**                                                                | **Rationale**                                                                            |
|-----------|-----------------------------------------------------------------------------------|------------------------------------------------------------------------------------------|
| Frontend  | React or Vue with a component library; PWA manifest and service worker            | Mature offline tooling; installable on judge phones                                      |
| Backend   | Node.js (NestJS/Express) or Laravel or Django REST                                | Team familiarity should decide; all satisfy the requirements                             |
| Database  | PostgreSQL 14+                                                                    | Transactional integrity and strong constraint support are essential to the scoring rules |
| Realtime  | WebSocket (Socket.IO) or Server-Sent Events                                       | Push current performance and progress                                                    |
| Auth      | JWT access token (short-lived) plus refresh token, bcrypt/argon2 password hashing | Stateless API with revocable sessions                                                    |
| Hosting   | Cloud VPS or managed platform, plus an on-site fallback (see 11.4)                | Venue connectivity cannot be assumed reliable                                            |
| Exports   | Server-side PDF and XLSX generation                                               | Result sheets must be printable and signable                                             |

**4. Core Concepts and Business Rules**

This section is the conceptual heart of the specification. The rules here drive the data model in Section 8 and the algorithms in Section 7. Getting this section agreed before development starts is the single most valuable thing the committee can do.

**4.1 The Performance concept — why it matters**

The original brief describes the flow as: a judge finds a member by chest number, sees the items that member is entered in, picks the one currently being performed, and enters a mark. That flow is correct, but implementing it naively — storing a score against "member and item" — creates several problems that only become visible on event day.

Instead, the system introduces an explicit entity called a Performance. A Performance is one registration presented once on stage. It is created the moment a participant is called to the stage, and it is the object that judges actually score.

**Everything a judge does resolves to a single Performance, and every score row points at one. This single design decision solves the following problems:**

| **Problem**                                                                                                                                                    | **How the Performance entity solves it**                                                                                                                                                                      |
|----------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Three judges must all score the same participant at the same moment. If they each independently search, one may lag behind and score the previous participant. | The coordinator sets one Performance as "on stage". Every judge device follows it. Judges may still search manually, but the system warns loudly if a judge scores a Performance that is not the current one. |
| How does the system know when scoring is complete for a participant?                                                                                           | A Performance knows its panel size. When the number of submitted scores equals the panel size, the Performance is automatically COMPLETE. Progress is countable in real time.                                 |
| A participant performs, the sound system fails, and they are asked to perform again.                                                                           | The first Performance is voided with a reason; a second Performance is created. Both are retained in the audit trail. No score is silently overwritten.                                                       |
| A participant does not turn up.                                                                                                                                | The Performance is set to ABSENT. It is excluded from ranking but is visibly accounted for, so the item cannot be closed with an unexplained gap.                                                             |
| Team or group items where several members perform together.                                                                                                    | One Performance can be linked to multiple members (a team), while still receiving one set of judge scores.                                                                                                    |
| A judge submits a mark for the wrong item.                                                                                                                     | Because the Performance carries the item, and the item on stage is known, the mismatch is detectable and blockable at submission time.                                                                        |

**4.2 Identity and eligibility rules**

1.  A member belongs to exactly one church. Church is selected from a dropdown of registered churches; free text is not permitted.

2.  A chest number is unique across the whole event and cannot be reused, even after a member is deleted. Deletion is soft; the number remains reserved.

3.  A member's category is derived automatically from their date of birth against the category age bands, using a configurable cut-off date. The administrator may override the derived category, but the override is recorded in the audit log with a reason.

4.  A member may register for multiple items. Item selection is a multi-select dropdown.

5.  A member may not register twice for the same item.

6.  A member may only register for items whose category matches the member's category, unless the item is marked "open to all categories".

7.  The system enforces a configurable maximum number of items per member (default: unlimited, but the committee will typically set a cap).

8.  An item may enforce a maximum number of entries per church (default: unlimited; commonly set to one or two).

**4.3 Scoring rules**

1.  Each judge awards a single mark per performance, from 0 to the configured maximum (default 10). Decimal marks are permitted to a configurable number of places (default 1, e.g. 8.5).

2.  A judge may score a performance exactly once. There is no second submission.

3.  A submitted score is immutable. A judge cannot edit or delete it. This is enforced at the database level, not only in the interface.

4.  A judge cannot see any other judge's mark at any time, before or after submission. This prevents anchoring.

5.  A judge cannot see running totals, rankings or results.

6.  Before submission the judge is shown a confirmation screen restating the chest number, member name, item and mark. Submission requires an explicit second action.

7.  A performance is COMPLETE only when every judge on its panel has submitted. Partial scoring never contributes to a result.

8.  Only a Super Admin (or an Admin with the delegated permission) may revoke a submitted score, and only with a mandatory typed reason. A revoked score is never deleted; it is marked revoked and excluded from calculation, and the judge is prompted to re-enter.

9.  Optional: an item may require judges to score against multiple criteria (for example Voice, Timing, Presentation) that sum to the maximum. Where enabled, all criteria must be filled before submission, and the judge's mark is the sum.

**4.4 Aggregation rules**

The aggregation method converts several judges' marks into one number for the performance. The method is configured once, before the event, and cannot be changed after the first result is published.

| **Method**        | **Definition**                                         | **Notes**                                                                            |
|-------------------|--------------------------------------------------------|--------------------------------------------------------------------------------------|
| Average (default) | Arithmetic mean of all valid judge scores              | Panel-size independent, so it remains comparable if one judge is absent for one item |
| Sum               | Total of all valid judge scores                        | Simple, but only comparable when every performance has the same panel size           |
| Trimmed mean      | Discard the highest and lowest score, average the rest | Requires at least four judges; guards against one outlier judge                      |
| Weighted average  | Each judge carries a configured weight                 | For panels with a chief judge; use with caution as it invites disputes               |

*Recommendation: use Average with a fixed panel of three, and configure trimmed mean only if panels of five or more are used.*

**4.5 Ranking and tie-break rules**

Within an item, performances are ranked by aggregate score, highest first. Ties are extremely common when marking out of 10 with three judges, so the tie-break sequence must be decided before the event and published to participants.

The system applies the following tie-break criteria in configurable order until the tie is broken:

1.  Higher number of judges who awarded their single highest mark of that item to this performance.

2.  Higher individual maximum mark received from any single judge.

3.  Lower spread (difference between the highest and lowest judge mark), indicating stronger consensus.

4.  Chief judge's mark, where a chief judge is designated on the panel.

5.  Unresolved — flagged to the administrator for a manual decision, which must be recorded with a reason.

**If a tie remains after all automated criteria, the system does not guess. It raises the item to the administrator with a clear "tie requires decision" flag, presents all judge marks side by side, and requires the administrator to either declare a shared position or break the tie manually with a recorded justification. Silent tie-breaking is prohibited.**

**4.6 Shared positions**

The administrator configures whether shared positions are permitted. Two behaviours are supported:

- Shared allowed: two participants tied for first are both awarded first place, both receive the full first-place points, and no second place is awarded (the next participant is third).

- Shared not allowed: the tie-break sequence in 4.5 must resolve the tie, escalating to the administrator if it cannot.

**4.7 Points and championship rules**

1.  Position points are configured per position (default suggestion: first = 5, second = 3, third = 1) and may be overridden per item so that group items can be worth more than solo items.

2.  Items may carry a weight multiplier (default 1.0). A group item weighted 2.0 awards double points.

3.  Optional grade points may be awarded independently of position, based on the aggregate score percentage (for example A grade = 5, B = 3, C = 1). Grade points are disabled by default.

4.  A church's total is the sum of all points earned by its members across all published items.

5.  The overall church champion is the church with the highest total points. Church-champion ties are broken by: greater number of first places, then greater number of second places, then higher aggregate score total across all items.

6.  The individual champion is the member with the highest total personal points across the items they entered. Ties are broken by number of first places, then by higher total aggregate score.

7.  Optional category champions (best Junior, best Senior, etc.) are computed on the same basis, restricted to members in that category.

8.  A minimum-participation rule may be configured, requiring a member to have competed in at least N items to be eligible for individual champion.

**4.8 Result lifecycle**

Results move through defined states. This prevents the common failure mode of a number being announced and then quietly changing.

| **State**   | **Meaning**                                                                         | **Who can see it**                                           |
|-------------|-------------------------------------------------------------------------------------|--------------------------------------------------------------|
| In progress | Some performances in the item are not yet COMPLETE                                  | Admin only, as a progress view                               |
| Ready       | Every performance is COMPLETE, ABSENT or VOID. Result computed but not yet reviewed | Admin only                                                   |
| Provisional | Admin has reviewed and resolved any ties; awaiting sign-off                         | Admin only                                                   |
| Published   | Signed off by Super Admin. Contributes to church points and championship            | Admin, reports, exports, and any public view                 |
| Withheld    | Result frozen pending a dispute or investigation                                    | Admin only; item excluded from totals with a visible warning |

Once an item is Published, it can only be changed by a Super Admin performing an explicit "unpublish and correct" action, which is recorded in the audit log and forces recomputation of all downstream totals.

**5. Functional Requirements — Administrator Module**

Requirement identifiers use the form ADM-nn-nn and are referenced by the acceptance criteria in Section 15.

**5.1 Authentication and account management**

**5.1.1 Login**

- ADM-01-01 — All users, regardless of role, log in through a single login screen using username (or email) and password.

- ADM-01-02 — On successful login the user is routed by role: administrators to the admin dashboard, judges to the judge home screen. Judges cannot reach admin routes by URL manipulation; the server rejects such requests with 403.

- ADM-01-03 — Passwords are stored only as salted hashes (bcrypt cost 12 or argon2id). Plain text passwords are never stored, logged or emailed.

- ADM-01-04 — Five consecutive failed attempts lock the account for 15 minutes. The lock and its expiry are recorded in the audit log.

- ADM-01-05 — On first login a user must change the password issued to them. The system enforces minimum length 8 with at least one letter and one number.

- ADM-01-06 — "Forgot password" is not self-service. An administrator resets the password and communicates it out of band. This is deliberate: it keeps account control with the committee on event day.

- ADM-01-07 — Sessions expire after a configurable idle period (default: 12 hours for judges, so a device does not log out mid-event; 2 hours for admins).

- ADM-01-08 — Optional: judge accounts can be pinned to a single device. A second login from a different device is blocked until an admin releases the pin. Recommended to prevent credential sharing.

**5.1.2 User management**

- ADM-01-10 — Only Super Admin and Admin can create user accounts. There is no public registration route anywhere in the application.

- ADM-01-11 — Creating a user captures: full name, username, temporary password, role, mobile number (optional), and active flag.

- ADM-01-12 — Users are deactivated, never hard-deleted, so that historical scores remain attributable.

- ADM-01-13 — Deactivating a judge who has open unsubmitted assignments raises a warning listing the affected sessions.

- ADM-01-14 — The user list supports search by name, filter by role and filter by active status.

**5.2 Church management**

- ADM-02-01 — Create, edit, deactivate and list churches.

- ADM-02-02 — Fields: church name (mandatory, unique), short code (mandatory, unique, 3–6 characters, used on result sheets and badges), zone or district (optional), pastor or contact person name, contact mobile, contact email, logo image (optional), active flag.

- ADM-02-03 — A church cannot be deleted if it has members. It can be deactivated, which hides it from new-member dropdowns but preserves existing data.

- ADM-02-04 — The list view shows member count and registration count per church so the administrator can spot a church that has not yet submitted its entries.

- ADM-02-05 — Bulk import of churches from CSV, with a validation preview showing accepted and rejected rows before anything is written.

**5.3 Category management**

- ADM-03-01 — Create, edit and list categories (for example Sub-Junior, Junior, Senior, Super-Senior).

- ADM-03-02 — Fields: category name, minimum age, maximum age, gender restriction (Any / Male / Female), display order, active flag.

- ADM-03-03 — A single event-wide age cut-off date is configured in system settings. Age is computed as at that date, not as at today, so a participant's category does not change mid-event.

- ADM-03-04 — The system warns if configured age bands overlap or leave gaps.

**5.4 Item (programme) management**

- ADM-04-01 — Create, edit, deactivate and list items.

- ADM-04-02 — Fields: item name, item code (unique, used by judges as a short reference), category, type (Individual / Group), gender restriction, maximum mark override (defaults to system maximum), stage or venue, scheduled date and time, maximum entries per church, minimum and maximum team size for group items, points multiplier, scoring criteria set (optional), display order, active flag.

- ADM-04-03 — Items are grouped in the list by category and by stage, with counts of registered participants and current scoring status.

- ADM-04-04 — An item with registrations cannot have its category changed without an explicit confirmation that lists every registration that would become ineligible.

- ADM-04-05 — An item cannot be deleted once any performance exists against it; it may only be cancelled, which excludes it from results with a recorded reason.

- ADM-04-06 — Optional scoring criteria: for each item the administrator may define named criteria with individual maximum marks that sum to the item maximum. When defined, judges score each criterion rather than entering a single figure.

**5.5 Member management**

- ADM-05-01 — Create, edit, deactivate and list members.

- ADM-05-02 — Fields: chest number (unique, mandatory; may be auto-generated by a configurable rule such as church code plus sequence), full name, date of birth, gender, church (dropdown, mandatory), category (auto-derived, override permitted with reason), photograph (optional but recommended — it lets a judge visually confirm the person in front of them), contact mobile (optional), notes, active flag.

- ADM-05-03 — Items the member participates in are selected via a multi-select dropdown with type-ahead search. Selecting items here creates registrations (see 5.6).

- ADM-05-04 — The multi-select only offers items the member is eligible for, based on category and gender, unless the administrator switches on "show ineligible items", in which case selecting one requires a recorded override reason.

- ADM-05-05 — Duplicate detection: on save, the system warns if a member with the same name and date of birth already exists in the same church.

- ADM-05-06 — The member list supports search by chest number, name or church, filter by category, item and active status, and sorting by chest number or name.

- ADM-05-07 — Bulk import of members from CSV or Excel including their item registrations, with a validation preview. The preview must report, per row: invalid church, duplicate chest number, ineligible item, malformed date of birth.

- ADM-05-08 — Badge printing: generate printable badges containing chest number, name, church name and optionally a QR or barcode encoding the chest number.

- ADM-05-09 — A member cannot be deleted once they have any submitted score. Deactivation is used instead.

**5.6 Registration management**

Registrations can be maintained from the member record (one member, many items) or from the item record (one item, many members). Both views operate on the same underlying data.

- ADM-06-01 — From an item, the administrator can add participants by searching chest number or name, and can see the current entry list with church names.

- ADM-06-02 — The system rejects a duplicate registration of the same member in the same item.

- ADM-06-03 — The system enforces the per-church entry cap and the per-member item cap, showing a clear message naming the rule that was breached.

- ADM-06-04 — For group items, a registration represents a team: it has a team name, an owning church, and a list of member chest numbers within the configured size range. All team members must belong to the owning church.

- ADM-06-05 — A registration can be withdrawn before scoring begins. Withdrawal is a state change, not a deletion.

- ADM-06-06 — A registration cannot be removed once a score exists against its performance.

- ADM-06-07 — Chest-number call list: for each item the administrator can generate and print the ordered list of participants for the stage announcer, optionally in randomised performance order.

**5.7 Judge management**

- ADM-07-01 — Create judge accounts with name, username, temporary password, mobile number, and optional specialisation notes.

- ADM-07-02 — Assign judges to panels (5.8). A judge may serve on several panels across the event.

- ADM-07-03 — Conflict-of-interest flag: a judge may be linked to a church, and the system then warns when that judge is assigned to a panel scoring members of that church. The warning can be overridden with a recorded reason.

- ADM-07-04 — The judge list shows, per judge, the number of scores submitted and any performances still awaiting their mark. This is the fastest way to identify the judge holding up an item.

- ADM-07-05 — Force logout: an administrator can terminate a judge's session, for example when a device is lost or handed to a different person.

**5.8 Panel and session management**

A panel is a named set of judges. A session binds a panel to one or more items at a stage for a period of time. This is what makes multi-judge scoring deterministic.

- ADM-08-01 — Create a panel with a name, a list of judges, and optionally a designated chief judge.

- ADM-08-02 — Panel size is not fixed. Any number of judges from one upwards is supported; the system uses the actual assigned count as the completion target.

- ADM-08-03 — Create a session with: session name, stage or venue, panel, list of items to be judged, scheduled start and end.

- ADM-08-04 — Open a session. Only when a session is open can its judges enter marks. Judges see only their open sessions.

- ADM-08-05 — Close a session. Closing is blocked, with an explicit list of exceptions, if any performance in the session is not COMPLETE, ABSENT or VOID. The administrator may force-close, which requires a reason and is prominently flagged in the audit log and on the result sheet.

- ADM-08-06 — Mid-session panel change: if a judge must be replaced, the administrator removes them and adds a replacement. Performances already COMPLETE are unaffected; the completion target for pending performances is recalculated. The change is recorded with a timestamp so it is clear which performances were judged by which panel composition.

- ADM-08-07 — The system warns if the same judge is assigned to two sessions that overlap in time.

**5.9 Live judging console**

This is the administrator's event-day screen and the operational centre of the system. It answers one question continuously: is anything stuck?

- ADM-09-01 — Select an open session and see the item currently being judged, the participant list, and their performance states.

- ADM-09-02 — Set the current performance on stage. This pushes to every judge device on the panel, which then opens directly on that participant.

- ADM-09-03 — For the current performance, display a live tile per judge showing Submitted or Waiting. Marks themselves are never displayed here until the performance is COMPLETE, so that a coordinator cannot relay one judge's mark to another.

- ADM-09-04 — Once COMPLETE, the individual marks and the aggregate become visible to the administrator.

- ADM-09-05 — Advance to the next participant with a single action, which closes the current performance and opens the next in call order.

- ADM-09-06 — Mark a participant ABSENT, with an optional note.

- ADM-09-07 — Void a performance with a mandatory reason (for example equipment failure) and create a re-performance. Both records are retained.

- ADM-09-08 — A persistent "outstanding marks" panel lists every performance in the session that is not COMPLETE, naming the judges who have not submitted. This is the single most important operational feature in the system.

- ADM-09-09 — Session progress indicator: participants scored versus total, per item.

**5.10 Score exception handling**

Judges cannot edit scores. Genuine mistakes still happen, so there must be exactly one controlled route to correct one.

- ADM-10-01 — A Super Admin can revoke an individual submitted score. A mandatory free-text reason of at least 15 characters is required.

- ADM-10-02 — Revocation does not delete the original row. The score is flagged revoked, retains its original value and timestamp, and is excluded from all calculations.

- ADM-10-03 — The affected performance returns to PARTIAL, and the judge's device shows the performance as awaiting their mark again, with a notice that their previous mark was revoked.

- ADM-10-04 — Every revocation appears in a dedicated exceptions report, which is printed alongside the final results so the committee can see exactly what was corrected and why.

- ADM-10-05 — If an item is already Published, revoking a score within it requires unpublishing first, and the system warns that church totals and the championship will be recalculated.

**5.11 Scoring configuration**

- ADM-11-01 — Configure the default maximum mark per judge (default 10) and the number of decimal places allowed (default 1).

- ADM-11-02 — Configure the aggregation method (Section 4.4).

- ADM-11-03 — Configure position points. The interface accepts any number of positions; the default is first, second and third.

- ADM-11-04 — Configure per-item point overrides and item weight multipliers.

- ADM-11-05 — Configure whether shared positions are permitted.

- ADM-11-06 — Configure the tie-break criteria and their order by drag and drop.

- ADM-11-07 — Configure grade thresholds and whether grade points apply.

- ADM-11-08 — Configure championship rules: minimum items for individual champion eligibility, and whether category champions are computed.

- ADM-11-09 — Scoring configuration is locked once the first result is published. Changing it afterwards requires a Super Admin action that unpublishes every result and forces full recomputation, with a confirmation dialog that states exactly this.

**5.12 Results and publication**

- ADM-12-01 — Item result view: ranked list showing position, chest number, member name, church name, each judge's individual mark, the aggregate, the grade, and the points awarded.

- ADM-12-02 — Any item containing an unresolved tie is clearly flagged and cannot progress to Provisional until resolved.

- ADM-12-03 — Publish an item result. Only Super Admin. Publication timestamps the result and locks it.

- ADM-12-04 — Bulk publish all Ready items, with a summary confirmation listing what will be published.

- ADM-12-05 — Unpublish with a mandatory reason, which triggers recomputation of church totals.

- ADM-12-06 — Church leaderboard: total points, first-place count, second-place count, participant count, ranked, with the champion highlighted.

- ADM-12-07 — Individual champion view, and category champions where enabled.

- ADM-12-08 — "What-if" preview: the administrator can see provisional standings including unpublished Ready items, clearly watermarked as provisional, to prepare for the announcement.

- ADM-12-09 — Every result screen shows the count of items still unpublished, so nobody announces a champion while items remain outstanding.

**5.13 Reports and exports**

| **Report**                      | **Contents**                                                                                                                                   | **Formats** |
|---------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------|-------------|
| Item result sheet               | Per item: full ranking, individual judge marks, aggregate, church, points. Includes a signature block for the panel                            | PDF, Excel  |
| Consolidated results            | All published items in category and item order                                                                                                 | PDF, Excel  |
| Church leaderboard              | Points, positions won, rank, champion highlighted                                                                                              | PDF, Excel  |
| Church detail sheet             | One church: every member, every item entered, position and points earned                                                                       | PDF, Excel  |
| Individual champion sheet       | Ranked members by personal points                                                                                                              | PDF, Excel  |
| Participation list / call sheet | Per item, ordered participant list with chest numbers for the announcer                                                                        | PDF         |
| Judge activity report           | Per judge: scores submitted, timestamps, average mark awarded, deviation from panel mean                                                       | PDF, Excel  |
| Exceptions report               | Voided performances, absentees, revoked scores, forced session closures, manual tie decisions, category overrides — each with reason and actor | PDF         |
| Certificates                    | Merge-printed certificates for first, second and third with member name, church and item                                                       | PDF         |
| Badge sheet                     | Printable badges with chest number, name, church, optional barcode                                                                             | PDF         |
| Audit log export                | Filtered audit trail                                                                                                                           | Excel, CSV  |

*The judge activity report deserves particular attention. Deviation from panel mean is a quiet but powerful quality signal: a judge who consistently marks two points above the rest of the panel is not necessarily wrong, but the committee should know before the results are announced rather than after.*

**5.14 Audit log**

- ADM-14-01 — Every state-changing action is logged with: timestamp, acting user, role, IP address, action type, entity type, entity identifier, previous value, new value, and reason where one was required.

- ADM-14-02 — Score submissions are logged with the device and session identifier in addition to the above.

- ADM-14-03 — The audit log is append-only. No user interface exists to edit or delete an entry, and the database user used by the application has no DELETE or UPDATE grant on the audit table.

- ADM-14-04 — The log is searchable by date range, user, action type and entity.

- ADM-14-05 — Retention is for the full event plus a configurable archival period (default 24 months).

**5.15 System settings and data safety**

- ADM-15-01 — Event settings: event name, edition or year, logo, start and end dates, age cut-off date, timezone.

- ADM-15-02 — Automatic database backup on a configurable schedule (recommended: every 15 minutes during event days).

- ADM-15-03 — Manual "snapshot now" action, intended for use immediately before any bulk or destructive operation.

- ADM-15-04 — Full data export in a restorable format.

- ADM-15-05 — Restore from snapshot, restricted to Super Admin, with a hard confirmation.

- ADM-15-06 — Event archive and reset, which closes the current event and starts a new one while retaining churches and judges as reusable master data.

- ADM-15-07 — A read-only "freeze" mode that blocks all data changes once results are final, preventing accidental edits after the event.

**6. Functional Requirements — Judge Module**

The judge application is the part of the system that must work flawlessly under pressure. It is used standing up, on a phone, often in low light, with a participant already on stage. Every design decision below favours speed and certainty over feature richness.

**Design principle: a judge should be able to complete a full scoring cycle — identify participant, choose item, enter mark, confirm, submit — in under fifteen seconds and no more than four taps.**

**6.1 Judge login**

- JDG-01-01 — Judges log in with their own credentials at the shared login screen.

- JDG-01-02 — After login the judge lands on the Home screen showing their assigned open sessions. If exactly one session is open, the judge is taken straight into it.

- JDG-01-03 — If the judge has no open session, the screen states clearly "No active judging session assigned" and shows their upcoming sessions with scheduled times. No scoring controls are shown.

- JDG-01-04 — The judge's name and the active session name are visible at all times in the header, so a judge can immediately confirm they are in the right place.

- JDG-01-05 — Judges remain logged in for the configured session duration (default 12 hours) so a device lock does not force a re-login mid-item.

**6.2 Home / Now on stage**

- JDG-02-01 — The Home screen shows the performance currently set as on stage by the coordinator: chest number in large type, member name, church name, item name, and the member photograph where available.

- JDG-02-02 — When the coordinator advances to the next participant, the judge screen updates automatically without any action by the judge.

- JDG-02-03 — If the judge has already submitted for the current performance, the screen shows a clear submitted confirmation with their own mark, and the scoring control is replaced by a disabled state. The judge can always see what they gave; they can never change it.

- JDG-02-04 — A progress strip shows position in the item, for example "Participant 7 of 21".

- JDG-02-05 — If no performance is currently on stage, the judge is shown the manual search option instead.

**6.3 Finding a participant by chest number**

This is the flow described in the original brief and it remains available at all times, both as the primary route where no coordinator is present and as a fallback where one is.

- JDG-03-01 — A numeric-first input accepts the chest number. The device numeric keypad opens automatically.

- JDG-03-02 — Results filter as the judge types, after a minimum of two characters.

- JDG-03-03 — Search also accepts a partial name, for cases where a badge is obscured.

- JDG-03-04 — Optional barcode or QR scan of the badge using the device camera, which resolves directly to the member.

- JDG-03-05 — Search is restricted to members registered in items within the judge's current open session. A judge cannot browse the full event roster.

- JDG-03-06 — If the chest number does not exist, the message is explicit: "No participant found with chest number 214 in this session." Silent empty results are not acceptable.

- JDG-03-07 — On selecting a member the judge sees the member card: chest number, name, church, category and photograph.

**6.4 Selecting the item**

- JDG-04-01 — Below the member card, the system lists every item that member is registered in which falls within the judge's current session.

- JDG-04-02 — Each item row shows its status for this judge: Not yet scored, Already scored by you, or Awaiting other judges.

- JDG-04-03 — Items outside the judge's session are either hidden or shown greyed with the reason, according to a configuration flag. The default is to show them greyed, because it helps the judge confirm they have the right person.

- JDG-04-04 — If the selected item is not the one currently on stage, a prominent warning appears: "The item on stage is X. You are about to score Y." The judge must acknowledge before continuing. This single guard prevents the most common and most damaging data-entry error.

- JDG-04-05 — Selecting an item opens the mark entry screen.

**6.5 Mark entry**

- JDG-05-01 — The mark entry screen restates chest number, member name, church, item and the maximum mark, so the judge cannot lose context.

- JDG-05-02 — Mark input is optimised for thumb use. The recommended control is a large stepper with increment and decrement, combined with a direct numeric entry field. A slider alone is not acceptable because precision matters.

- JDG-05-03 — Input is constrained to the range 0 to the item maximum and to the configured decimal precision. Out-of-range values cannot be entered rather than being rejected after the fact.

- JDG-05-04 — Where an item defines scoring criteria, one control is shown per criterion with its own maximum, and a live running total is displayed. All criteria must be completed before submission is enabled.

- JDG-05-05 — An optional remarks field (free text, up to 250 characters) is available for the judge to record an observation. Remarks are visible to administrators only and never affect the calculation.

- JDG-05-06 — The submit control is disabled until a valid mark is entered.

**6.6 Confirmation and submission**

Because submission is irreversible, the confirmation step is mandatory and cannot be configured away.

- JDG-06-01 — Tapping Submit opens a confirmation sheet restating: chest number, member name, church, item, and the mark, with the mark shown in the largest type on the screen.

- JDG-06-02 — The sheet states explicitly: "Once submitted this mark cannot be changed."

- JDG-06-03 — The judge must tap Confirm. Cancel returns to mark entry with the value preserved.

- JDG-06-04 — On confirmation the mark is written with the judge identity, performance identity, timestamp, device identifier and a client-generated idempotency key.

- JDG-06-05 — The idempotency key guarantees that a retried request caused by a flaky network cannot create a second score row. The server returns the original result for a repeated key rather than an error.

- JDG-06-06 — A success state is shown with clear visual and haptic feedback, then the app returns to Home after a short delay or immediately on tap.

- JDG-06-07 — If the server reports that this judge has already scored this performance, the app shows the existing mark and treats the action as complete rather than showing a failure.

- JDG-06-08 — After submission the judge sees no indication of how many other judges have submitted or what they awarded.

**6.7 My submissions**

- JDG-07-01 — A read-only list of every mark this judge has submitted in the current session: chest number, name, item, mark, timestamp.

- JDG-07-02 — Searchable and filterable by item.

- JDG-07-03 — No edit or delete control exists anywhere on this screen.

- JDG-07-04 — If a mark has been revoked by an administrator, it appears struck through with the label "Revoked — please re-enter", and tapping it opens mark entry for that performance again.

**6.8 Offline behaviour**

Venue wireless networks fail. The judge application must degrade gracefully rather than block scoring.

- JDG-08-01 — On entering a session the app caches the participant and item data for that session locally.

- JDG-08-02 — If connectivity is lost, a persistent amber banner reads "Offline — marks will be saved and sent automatically."

- JDG-08-03 — Scoring continues offline. Submissions are queued locally with their idempotency keys and timestamps.

- JDG-08-04 — The queue depth is visible to the judge, for example "3 marks waiting to send".

- JDG-08-05 — On reconnection the queue is transmitted automatically in order. Successful items disappear from the queue; failures are retried with backoff and surfaced after three failures.

- JDG-08-06 — The recorded time of a score is the client submission time carried in the payload, not the server receipt time, so that an offline queue does not distort the audit trail.

- JDG-08-07 — The administrator console shows a judge with a pending offline queue distinctly from a judge who simply has not scored, so that the coordinator does not chase a judge who has in fact already marked.

- JDG-08-08 — Offline scoring is limited to the cached current session. A judge cannot begin an entirely new session while offline.

**6.9 What judges must never see**

This list is a requirement, not a note. Each item is a potential integrity failure.

- Any other judge's mark, at any time.

- Aggregate or average scores for any performance.

- Any ranking, position or leaderboard.

- Church point totals or championship standings.

- Members or items outside their assigned session.

- Any administrative function or navigation route.

**7. Scoring and Result Computation Engine**

**7.1 Performance state machine**

Every performance occupies exactly one state at any time. Transitions are the only way state changes, and each is triggered by a defined action.

| **State**   | **Entered when**                                            | **Leaves to**                                       |
|-------------|-------------------------------------------------------------|-----------------------------------------------------|
| SCHEDULED   | The registration exists and the item is not yet in progress | ON_STAGE, ABSENT, WITHDRAWN                         |
| ON_STAGE    | Coordinator or admin sets it as current                     | IN_PROGRESS, ABSENT, VOID                           |
| IN_PROGRESS | The first judge submits a mark                              | COMPLETE, VOID                                      |
| COMPLETE    | Submitted score count equals panel size                     | IN_PROGRESS (only if a score is revoked), VOID      |
| ABSENT      | Admin or coordinator marks the participant absent           | SCHEDULED (only if reinstated by admin)             |
| VOID        | Admin voids the performance with a reason                   | Terminal. A new performance is created for a re-run |
| WITHDRAWN   | Registration withdrawn before judging                       | Terminal                                            |

Only performances in COMPLETE state are included in ranking. ABSENT, VOID and WITHDRAWN performances appear on the result sheet with their status but receive no position and no points.

**7.2 Multi-judge concurrency — how simultaneous entry is managed**

The stakeholder question "three judges all enter a mark for the same member — how do we manage this without error?" is answered by four mechanisms working together.

1.  Shared target. All judges score the same Performance record, identified by a single primary key. There is no matching or reconciliation step, because there is nothing to match: every judge writes a row that points at the same parent.

2.  Database-level uniqueness. A unique constraint on (performance_id, judge_id) makes a duplicate score physically impossible. Two simultaneous requests from the same judge cannot both succeed; the second is rejected by the database, not by application logic that might have a race condition.

3.  Independent rows, not a shared record. Each judge writes their own row. Judges never update a common row, so there is no lost-update problem and no need for locking. Three judges submitting in the same millisecond is a completely normal, safe operation.

4.  Server-side completion check. After each insert, and within the same transaction, the system counts valid scores for the performance and compares against the panel size recorded on the performance. When the count matches, the performance is set COMPLETE and the aggregate is computed and stored.

*The panel size is copied onto the performance at the moment it is created, rather than being read live from the panel. This is deliberate: if a judge is swapped mid-session, performances already in progress keep the target they started with, and the result sheet remains explainable.*

**7.3 Aggregate computation**

> on score submitted (performance P, judge J, mark M):
>
> BEGIN TRANSACTION
>
> INSERT score (P, J, M, submitted_at, device, idempotency_key)
>
> -- unique (performance_id, judge_id) enforces single entry
>
> valid := SELECT count(\*) FROM scores
>
> WHERE performance_id = P AND revoked = false
>
> IF valid = P.panel_size THEN
>
> P.aggregate := aggregate(scores, config.method)
>
> P.status := COMPLETE
>
> P.completed_at := now()
>
> ELSE
>
> P.status := IN_PROGRESS
>
> END IF
>
> COMMIT
>
> publish realtime event: progress(P, valid, P.panel_size)

Aggregate values are stored, not computed on demand, so that a later configuration change cannot silently alter a historical result. Recomputation is always an explicit, audited action.

**7.4 Item ranking algorithm**

> rank_item(item I):
>
> performances := all P in I where P.status = COMPLETE
>
> IF any P in I is not in (COMPLETE, ABSENT, VOID, WITHDRAWN):
>
> return NOT_READY
>
> sort performances by aggregate DESC
>
> group into tie-groups of equal aggregate
>
> for each tie-group of size \> 1:
>
> for each criterion in config.tiebreak_order:
>
> apply criterion; if group fully separated, stop
>
> if still tied:
>
> if config.allow_shared_positions:
>
> assign the same position to all; skip the next position(s)
>
> else:
>
> flag item TIE_UNRESOLVED for admin decision
>
> assign positions 1..n
>
> for each positioned performance:
>
> points := position_points\[position\]
>
> \* item.weight_multiplier
>
> grade := grade_for(aggregate / item.max_mark \* 100)
>
> if config.grade_points_enabled:
>
> points := points + grade_points\[grade\]
>
> record item_result row

**7.5 Worked example**

Item: Solo Song — Junior Girls. Panel of three judges. Maximum mark 10. Aggregation: average. Position points: 1st = 5, 2nd = 3, 3rd = 1. Shared positions not permitted.

| **Chest** | **Member**     | **Church** | **J1** | **J2** | **J3** | **Total** | **Average** |
|-----------|----------------|------------|--------|--------|--------|-----------|-------------|
| 118       | Sarah John     | Zion       | 9.0    | 8.0    | 9.0    | 26.0      | 8.67        |
| 104       | Anna Mathew    | Bethel     | 8.5    | 9.0    | 8.5    | 26.0      | 8.67        |
| 132       | Rebecca Thomas | Calvary    | 7.5    | 8.0    | 7.0    | 22.5      | 7.50        |
| 145       | Grace Varghese | Bethel     | 6.5    | 7.0    | 6.5    | 20.0      | 6.67        |

Chest 118 and chest 104 are tied on 8.67. The first tie-break criterion is applied: how many judges gave their own highest mark of this item to this performance?

- Judge 1's highest mark in the item is 9.0, awarded to chest 118.

- Judge 2's highest mark in the item is 9.0, awarded to chest 104.

- Judge 3's highest mark in the item is 9.0, awarded to chest 118.

Chest 118 received two such marks against chest 104's one. The tie is broken at the first criterion and the final result is:

| **Position** | **Chest** | **Member**     | **Church** | **Aggregate** | **Grade** | **Points** |
|--------------|-----------|----------------|------------|---------------|-----------|------------|
| 1            | 118       | Sarah John     | Zion       | 8.67          | A         | 5          |
| 2            | 104       | Anna Mathew    | Bethel     | 8.67          | A         | 3          |
| 3            | 132       | Rebecca Thomas | Calvary    | 7.50          | B         | 1          |
| —            | 145       | Grace Varghese | Bethel     | 6.67          | B         | 0          |

Church points arising from this item alone: Zion 5, Bethel 3, Calvary 1. These are added to each church's running total across all published items to produce the leaderboard.

**7.6 Church championship computation**

> church_total(church C):
>
> points := sum of item_result.points
>
> for all results where result.item is PUBLISHED
>
> and result.member.church = C
>
> rank churches by points DESC
>
> tie-break in order:
>
> 1\. greater count of 1st positions
>
> 2\. greater count of 2nd positions
>
> 3\. higher sum of aggregate scores across all items
>
> 4\. flag for manual committee decision

The same pattern computes the individual champion, restricted to a single member instead of a church, and category champions, restricted to members within a category.

**7.7 Recomputation**

- Any change that could affect a result — a revoked score, a re-entered mark, a voided performance, an unpublished item, a configuration change — triggers recomputation of the affected item, then of all church and championship totals.

- Recomputation is idempotent and can be re-run safely at any time.

- A manual "recalculate everything" action is available to Super Admin and is logged.

- After any recomputation the system reports what changed, listing every position that moved, so that the committee is never surprised.

**8. Data Model**

The following logical model supports every rule in this document. Field lists are indicative rather than exhaustive; all tables additionally carry created_at, updated_at, created_by and updated_by.

**8.1 Entity summary**

| **Entity**            | **Purpose**                                          | **Key fields and constraints**                                                                                                                                                                       |
|-----------------------|------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| users                 | All system logins                                    | id, username (unique), password_hash, full_name, role, mobile, is_active, must_change_password, failed_attempts, locked_until, device_pin                                                            |
| churches              | Participating congregations                          | id, name (unique), short_code (unique), zone, contact_person, contact_mobile, logo, is_active                                                                                                        |
| categories            | Age / eligibility bands                              | id, name, min_age, max_age, gender_restriction, display_order, is_active                                                                                                                             |
| items                 | Competition events                                   | id, name, code (unique), category_id, type (INDIVIDUAL/GROUP), gender_restriction, max_mark, stage, scheduled_at, max_per_church, min_team_size, max_team_size, weight_multiplier, status, is_active |
| item_criteria         | Optional sub-criteria per item                       | id, item_id, name, max_mark, display_order                                                                                                                                                           |
| members               | Participants                                         | id, chest_number (unique), full_name, date_of_birth, gender, church_id, category_id, category_override_reason, photo, mobile, is_active                                                              |
| registrations         | Member (or team) entered in an item                  | id, item_id, member_id (nullable for teams), team_name, church_id, status, UNIQUE(item_id, member_id)                                                                                                |
| registration_members  | Members within a team registration                   | id, registration_id, member_id, UNIQUE(registration_id, member_id)                                                                                                                                   |
| panels                | Named judging panels                                 | id, name, chief_judge_id, is_active                                                                                                                                                                  |
| panel_judges          | Judges on a panel                                    | id, panel_id, user_id, weight, UNIQUE(panel_id, user_id)                                                                                                                                             |
| sessions              | Panel bound to items at a stage                      | id, name, stage, panel_id, scheduled_start, scheduled_end, status (DRAFT/OPEN/CLOSED), force_closed_reason                                                                                           |
| session_items         | Items judged in a session                            | id, session_id, item_id, UNIQUE(session_id, item_id)                                                                                                                                                 |
| performances          | One registration presented once — the scoring target | id, registration_id, item_id, session_id, attempt_no, panel_size, status, aggregate_score, is_current, completed_at, void_reason, UNIQUE(registration_id, attempt_no)                                |
| scores                | One judge's mark for one performance                 | id, performance_id, judge_id, mark, remarks, submitted_at, device_id, idempotency_key, revoked, revoked_by, revoked_reason, UNIQUE(performance_id, judge_id), UNIQUE(idempotency_key)                |
| score_criteria_values | Per-criterion marks where used                       | id, score_id, item_criteria_id, mark, UNIQUE(score_id, item_criteria_id)                                                                                                                             |
| item_results          | Computed ranking rows                                | id, item_id, performance_id, position, aggregate_score, grade, points, is_shared_position, tie_break_applied, computed_at                                                                            |
| item_publications     | Result lifecycle per item                            | id, item_id, state, published_by, published_at, unpublish_reason                                                                                                                                     |
| scoring_config        | Event-wide scoring rules                             | id, max_mark, decimal_places, aggregation_method, allow_shared_positions, tiebreak_order (ordered list), grade_points_enabled, min_items_for_champion, locked                                        |
| position_points       | Points per position                                  | id, position, points, item_id (null = global default)                                                                                                                                                |
| grade_bands           | Grade thresholds                                     | id, grade, min_percentage, points                                                                                                                                                                    |
| event_settings        | Event-wide settings                                  | id, event_name, edition, logo, start_date, end_date, age_cutoff_date, timezone, freeze_mode                                                                                                          |
| audit_logs            | Append-only trail                                    | id, occurred_at, user_id, role, ip_address, action, entity_type, entity_id, old_value, new_value, reason                                                                                             |

**8.2 Critical constraints**

These four constraints carry most of the system's integrity. They must exist in the database schema, not only in application code.

| **Constraint**                               | **Prevents**                                                                              |
|----------------------------------------------|-------------------------------------------------------------------------------------------|
| UNIQUE (performance_id, judge_id) on scores  | A judge scoring the same performance twice, including via a double tap or a network retry |
| UNIQUE (idempotency_key) on scores           | A queued offline submission being written twice on reconnection                           |
| UNIQUE (item_id, member_id) on registrations | A member being entered twice in the same item                                             |
| UNIQUE (chest_number) on members             | Two participants sharing a badge number, which would make judge lookup ambiguous          |

**In addition, the application database user must hold no UPDATE or DELETE grant on the scores table beyond the specific revoke operation, and no UPDATE or DELETE grant at all on audit_logs. Immutability enforced only in application code is not immutability.**

**8.3 Key relationships**

> churches 1 ──\< members \>── 1 categories
>
> members 1 ──\< registrations \>── 1 items
>
> registrations 1 ──\< performances 1 ──\< scores \>── 1 users(judge)
>
> panels 1 ──\< panel_judges \>── 1 users(judge)
>
> panels 1 ──\< sessions 1 ──\< session_items \>── 1 items
>
> sessions 1 ──\< performances
>
> items 1 ──\< item_results \>── 1 performances
>
> items 1 ── 1 item_publications

**9. API Specification (Indicative)**

All endpoints are authenticated except login. All responses use a consistent envelope carrying success, data, and an error object with a machine-readable code and a human-readable message. All state-changing endpoints accept an idempotency key.

**9.1 Authentication**

| **Method** | **Endpoint**              | **Purpose**                                    | **Roles** |
|------------|---------------------------|------------------------------------------------|-----------|
| POST       | /api/auth/login           | Authenticate, return access and refresh tokens | All       |
| POST       | /api/auth/refresh         | Exchange refresh token                         | All       |
| POST       | /api/auth/logout          | Invalidate session                             | All       |
| POST       | /api/auth/change-password | Change own password                            | All       |

**9.2 Administration**

| **Method** | **Endpoint**                        | **Purpose**                              |
|------------|-------------------------------------|------------------------------------------|
| GET / POST | /api/users                          | List / create users                      |
| PATCH      | /api/users/{id}                     | Update, deactivate, reset password       |
| GET / POST | /api/churches                       | List / create churches                   |
| POST       | /api/churches/import                | Bulk CSV import with validation preview  |
| GET / POST | /api/categories                     | List / create categories                 |
| GET / POST | /api/items                          | List / create items                      |
| GET / POST | /api/items/{id}/criteria            | Manage scoring criteria                  |
| GET / POST | /api/members                        | List / create members                    |
| GET        | /api/members/by-chest/{number}      | Chest number lookup                      |
| POST       | /api/members/import                 | Bulk import with preview                 |
| GET / POST | /api/registrations                  | List / create registrations              |
| DELETE     | /api/registrations/{id}             | Withdraw a registration                  |
| GET / POST | /api/panels                         | List / create panels                     |
| GET / POST | /api/sessions                       | List / create sessions                   |
| POST       | /api/sessions/{id}/open             | Open a session for scoring               |
| POST       | /api/sessions/{id}/close            | Close a session (validates completeness) |
| POST       | /api/performances                   | Create a performance                     |
| POST       | /api/performances/{id}/set-current  | Push to judge devices as on stage        |
| POST       | /api/performances/{id}/absent       | Mark absent                              |
| POST       | /api/performances/{id}/void         | Void with reason                         |
| GET        | /api/sessions/{id}/progress         | Live scoring progress                    |
| POST       | /api/scores/{id}/revoke             | Revoke a submitted score with reason     |
| GET        | /api/results/items/{id}             | Item result with judge breakdown         |
| POST       | /api/results/items/{id}/publish     | Publish item result                      |
| POST       | /api/results/items/{id}/unpublish   | Unpublish with reason                    |
| POST       | /api/results/items/{id}/resolve-tie | Record a manual tie decision             |
| GET        | /api/results/churches               | Church leaderboard                       |
| GET        | /api/results/champions              | Individual and category champions        |
| GET / PUT  | /api/config/scoring                 | Read / update scoring configuration      |
| GET        | /api/reports/{type}                 | Generate report as PDF or Excel          |
| GET        | /api/audit                          | Search audit log                         |

**9.3 Judge endpoints**

| **Method** | **Endpoint**                    | **Purpose**                                            |
|------------|---------------------------------|--------------------------------------------------------|
| GET        | /api/judge/sessions             | Open sessions assigned to this judge                   |
| GET        | /api/judge/sessions/{id}/bundle | Cacheable offline bundle: members, items, performances |
| GET        | /api/judge/current              | Performance currently on stage                         |
| GET        | /api/judge/search?q=            | Search within session by chest number or name          |
| GET        | /api/judge/members/{id}/items   | Items this member is registered in, within session     |
| POST       | /api/judge/scores               | Submit a mark (idempotent, immutable)                  |
| GET        | /api/judge/my-scores            | Own submitted marks, read-only                         |

*There is deliberately no PUT or DELETE endpoint for scores in the judge namespace. The absence is part of the specification.*

**9.4 Standard error codes**

| **Code**               | **HTTP** | **Meaning**                                          |
|------------------------|----------|------------------------------------------------------|
| ALREADY_SCORED         | 409      | This judge has already scored this performance       |
| SESSION_NOT_OPEN       | 403      | Scoring attempted outside an open session            |
| NOT_ON_PANEL           | 403      | Judge is not assigned to this performance's panel    |
| PERFORMANCE_LOCKED     | 409      | Performance is COMPLETE, VOID or ABSENT              |
| MARK_OUT_OF_RANGE      | 422      | Mark below zero or above the item maximum            |
| DUPLICATE_CHEST_NUMBER | 422      | Chest number already in use                          |
| INELIGIBLE_ITEM        | 422      | Member category or gender does not match the item    |
| ENTRY_LIMIT_EXCEEDED   | 422      | Per-church or per-member entry cap breached          |
| RESULT_PUBLISHED       | 409      | Change attempted against a published result          |
| CONFIG_LOCKED          | 409      | Scoring configuration locked after first publication |
| TIE_UNRESOLVED         | 409      | Item cannot be published until the tie is decided    |

**10. User Interface and Experience Requirements**

**10.1 General principles**

- Mobile-first. Layouts are designed at 360 px width first and scale up. Desktop is a progressive enhancement, not the baseline.

- The primary action on any screen is reachable within the bottom third of the display, in comfortable thumb range.

- Minimum touch target of 44 by 44 pixels throughout.

- High contrast is mandatory. Judges work in auditoriums with variable lighting; a dark theme option is required.

- Chest numbers, marks and member names use significantly larger type than surrounding content.

- Every destructive or irreversible action requires explicit confirmation naming what will happen.

- Loading, empty, error and offline states are designed explicitly for every screen. A blank screen is a defect.

**10.2 Judge navigation — bottom app bar**

The judge application uses a fixed bottom navigation bar of four items, matching native app conventions as requested.

| **Tab**  | **Icon**     | **Purpose**                                                       |
|----------|--------------|-------------------------------------------------------------------|
| Now      | Stage / play | The performance currently on stage. Default landing tab.          |
| Search   | Magnifier    | Chest number and name lookup.                                     |
| My Marks | Checklist    | Read-only list of marks this judge has submitted.                 |
| Profile  | Person       | Judge name, active session, change password, dark mode, sign out. |

The bar shows a badge on My Marks when offline submissions are queued, and an amber tint across the bar when the device is offline.

**10.3 Admin navigation**

On desktop the admin console uses a left sidebar. On mobile it collapses to a bottom bar of five items with the less frequent sections behind More.

| **Section** | **Contains**                                                          |
|-------------|-----------------------------------------------------------------------|
| Dashboard   | Counts, session status, outstanding marks, quick actions              |
| Live        | Live judging console, current performance control, progress           |
| Data        | Churches, categories, items, members, registrations                   |
| Results     | Item results, publication, leaderboards, champions                    |
| More        | Judges, panels, sessions, configuration, reports, audit log, settings |

**10.4 Screen inventory**

**10.4.1 Judge screens**

| **\#** | **Screen**        | **Key elements**                                                                     |
|--------|-------------------|--------------------------------------------------------------------------------------|
| J1     | Login             | Username, password, show/hide toggle, event branding                                 |
| J2     | Session selection | Open sessions; auto-skip when only one                                               |
| J3     | Now on stage      | Large chest number, photo, name, church, item, Score button, progress strip          |
| J4     | Search            | Numeric-first field, live results, optional barcode scan                             |
| J5     | Member items      | Member card and registered items with per-judge status                               |
| J6     | Mark entry        | Context header, large stepper plus numeric field, optional criteria, remarks, Submit |
| J7     | Confirm sheet     | Restated details, mark in largest type, immutability warning, Confirm / Cancel       |
| J8     | Success           | Confirmation, mark shown, auto-return                                                |
| J9     | My marks          | Read-only submitted list, revoked items highlighted                                  |
| J10    | Profile           | Name, session, password change, theme, sign out                                      |

**10.4.2 Administrator screens**

| **\#** | **Screen**            | **Key elements**                                                                      |
|--------|-----------------------|---------------------------------------------------------------------------------------|
| A1     | Dashboard             | Churches, members, items, sessions; outstanding marks; unpublished item count         |
| A2     | Church list / form    | Search, member counts, create and edit, CSV import                                    |
| A3     | Category list / form  | Age bands, gender restriction, overlap warnings                                       |
| A4     | Item list / form      | Grouped by category and stage; criteria editor; entry caps                            |
| A5     | Member list           | Chest, name, church, category, item count; filters; badge print                       |
| A6     | Member form           | All fields; church dropdown; item multi-select with eligibility filtering; photo      |
| A7     | Member import         | Upload, validation preview with per-row errors, commit                                |
| A8     | Item entries          | Entry list for an item, add by chest number, call-sheet generation                    |
| A9     | Judge list / form     | Accounts, panel assignments, submission counts, force logout                          |
| A10    | Panel builder         | Name, judge selection, chief judge, conflict warnings                                 |
| A11    | Session list / form   | Stage, panel, items, schedule, open and close controls                                |
| A12    | Live console          | Current performance, judge submission tiles, advance, absent, void, outstanding panel |
| A13    | Scoring configuration | Max mark, aggregation, position points, tie-break order, grades                       |
| A14    | Item result           | Ranked table with judge breakdown, tie flags, publish control                         |
| A15    | Church leaderboard    | Points, positions, rank, champion highlight                                           |
| A16    | Champions             | Individual and category champions with qualifying detail                              |
| A17    | Reports               | Report selection, filters, PDF and Excel export                                       |
| A18    | Audit log             | Filterable append-only trail                                                          |
| A19    | Settings              | Event details, cut-off date, backup, freeze mode                                      |

**11. Non-Functional Requirements**

**11.1 Performance**

| **Requirement**                  | **Target**                                  |
|----------------------------------|---------------------------------------------|
| Chest number lookup response     | Under 300 ms at the 95th percentile         |
| Score submission round trip      | Under 500 ms at the 95th percentile         |
| Judge app initial load on 4G     | Under 3 seconds                             |
| Subsequent screen transitions    | Under 200 ms                                |
| Concurrent judges supported      | At least 50 without degradation             |
| Concurrent admin users           | At least 10                                 |
| Members supported per event      | At least 5,000                              |
| Result recomputation, full event | Under 10 seconds                            |
| Report generation                | Under 5 seconds for a standard result sheet |

**11.2 Security**

- HTTPS enforced on all traffic; HTTP redirected.

- Passwords hashed with bcrypt (cost 12 or higher) or argon2id. Never logged, never emailed, never returned by any API.

- Role-based authorisation enforced server-side on every endpoint. Interface-level hiding is a convenience, never a control.

- Judges are authorised per session and per panel; a judge cannot score a performance outside their assignment even with a valid token and a crafted request.

- Rate limiting on login (10 attempts per minute per IP) and on score submission (60 per minute per user).

- All input validated and sanitised server-side; parameterised queries only.

- CSRF protection on cookie-based flows; strict CORS policy.

- Security headers: HSTS, X-Content-Type-Options, X-Frame-Options, a restrictive Content-Security-Policy.

- Uploaded files validated by type and size; images re-encoded on upload to strip embedded payloads.

- Personal data of members (date of birth, contact details, photographs) is visible only to administrators and, in reduced form, to judges within their session.

- Database backups encrypted at rest.

**11.3 Usability and accessibility**

- WCAG 2.1 AA colour contrast as a minimum.

- All interactive elements keyboard reachable and screen-reader labelled.

- No information conveyed by colour alone; status is always accompanied by text or an icon.

- Interface language English, with the text layer structured for future localisation into Malayalam or other regional languages.

- Error messages state what went wrong and what to do next, in plain language.

**11.4 Availability, resilience and venue fallback**

- Target availability of 99.9 percent during event days.

- The judge application functions offline for the duration of a cached session, as specified in 6.8.

- Automated backup every 15 minutes during event days, retained for at least 30 days.

- An on-site fallback is strongly recommended: a local server or laptop on the venue network running the same application, so that a loss of internet connectivity does not stop the event. If adopted, one instance must be authoritative and the fallback used read-only or by explicit switchover, never concurrently.

- A documented paper contingency: printed blank mark sheets per item, so that a total systems failure degrades to the existing manual process rather than halting the competition. Marks captured on paper are entered afterwards by an administrator through a dedicated back-entry screen that records who entered them and why.

- Graceful degradation: if the realtime channel fails, the application polls. If reporting fails, scoring continues.

**11.5 Compatibility**

- Browsers: Chrome, Safari, Edge and Firefox, current version and one prior major version.

- Mobile operating systems: Android 9 and above, iOS 14 and above.

- Screen widths from 320 px upwards.

- Installable as a Progressive Web App on both Android and iOS.

**11.6 Maintainability and scalability**

- Configuration driven rather than hard-coded: panel size, maximum mark, position points, categories, tie-break order and grade bands are all data.

- The system supports multiple events over time, with churches and judges reusable as master data across events.

- API versioned from the first release.

- Structured application logging with correlation identifiers.

- Automated test coverage required on the scoring and result engine specifically; this is the component where a defect is most expensive.

**12. Edge Cases, Validation and Error Handling**

This section exists because competition days generate exactly these situations, and a system that has no defined answer for them will produce a dispute. Each row is a testable requirement.

**12.1 Scoring edge cases**

| **Situation**                                                               | **System behaviour**                                                                                                                                                                                                    |
|-----------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| A judge submits twice, for example by double tapping                        | The unique constraint rejects the second write. The idempotency key causes the original result to be returned. The judge sees success, not an error.                                                                    |
| A judge scores the wrong participant                                        | The mark stands and cannot be edited by the judge. The judge notifies the administrator, who revokes it with a reason. The judge is then prompted to re-enter.                                                          |
| A judge is absent or their device fails mid-item                            | The administrator removes them from the panel. The panel size on pending performances is recalculated. Performances already COMPLETE are unaffected and the change is recorded so the result sheet remains explainable. |
| Only two of three judges submit and the item is finished                    | The performance stays IN_PROGRESS. The item cannot reach Ready. The outstanding-marks panel names the missing judge. Session close is blocked unless force-closed with a reason.                                        |
| A judge scores an item that is not the one on stage                         | A blocking warning is shown naming both items. Proceeding is allowed but the score is flagged out-of-sequence in the audit log for review.                                                                              |
| Two judges submit in the same instant                                       | Both succeed. They write separate rows. The completion check runs inside each transaction and only one can observe the final count.                                                                                     |
| A judge submits offline and the network returns after the item is published | The submission is rejected with RESULT_PUBLISHED and escalated to the administrator, who must unpublish, accept the mark, and republish. The judge is told clearly what happened.                                       |
| A participant performs twice due to a technical fault                       | The first performance is voided with a reason and a second is created. Both are retained. Only the second is ranked.                                                                                                    |
| A participant is absent                                                     | Marked ABSENT. Excluded from ranking, shown on the result sheet with status, counted as resolved for session closure.                                                                                                   |
| A judge enters 11 out of 10                                                 | The control does not permit it. If submitted via API, MARK_OUT_OF_RANGE is returned.                                                                                                                                    |
| All participants in an item score identically                               | The tie-break sequence runs. If unresolved, the item is flagged for an administrator decision and cannot be published until resolved.                                                                                   |
| An item has only one participant                                            | The participant is ranked first if a minimum-score threshold is met, or awarded no position if the administrator has configured a walkover rule requiring a minimum aggregate.                                          |
| An item has no participants                                                 | The item is auto-marked cancelled at result computation, contributes no points, and appears in the exceptions report.                                                                                                   |

**12.2 Data management edge cases**

| **Situation**                                                  | **System behaviour**                                                                                                                        |
|----------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------|
| Duplicate chest number entered                                 | Rejected at save with the name of the existing holder shown, so the administrator can see the clash immediately.                            |
| A member changes church after registration                     | Permitted only before any score exists. Afterwards it is blocked, because points already earned are attributed to the original church.      |
| A member's date of birth is corrected, changing their category | The system lists every registration that becomes ineligible and requires the administrator to resolve each one before saving.               |
| An item's category is changed after registrations exist        | Blocked unless the administrator confirms a list of registrations that will become ineligible.                                              |
| A church is deactivated with active members                    | Deactivation succeeds but the church is hidden from new-member dropdowns; existing members and their results are untouched.                 |
| A CSV import contains a mixture of valid and invalid rows      | Nothing is written until the administrator reviews the preview. Valid rows may be committed while invalid rows are exported for correction. |
| A registration is added after the item has started             | Permitted only while the session is open, and flagged as a late entry in the audit log and on the result sheet.                             |
| A team item registration has fewer members than the minimum    | Save is blocked with an explicit message naming the configured range.                                                                       |
| A member is deleted                                            | Hard deletion is unavailable once any score exists. The member is deactivated and the chest number remains permanently reserved.            |

**12.3 Operational edge cases**

| **Situation**                                                         | **System behaviour**                                                                                                                                                                                                          |
|-----------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Two sessions run simultaneously on different stages                   | Fully supported. Sessions are independent; a judge assigned to both is warned of the overlap at assignment time.                                                                                                              |
| The same judge is on two panels                                       | Supported. The judge selects the active session; only one session is active on their device at a time.                                                                                                                        |
| The administrator force-closes a session with incomplete performances | Permitted with a mandatory reason. Affected items are flagged on every result sheet and appear in the exceptions report.                                                                                                      |
| Results are published and an error is discovered                      | Super Admin unpublishes with a reason, corrects, recomputes and republishes. Every step is audited and a change report is produced showing which positions moved.                                                             |
| The venue loses internet connectivity entirely                        | Judges continue offline against cached session data. Administrators may switch to the on-site fallback or the paper contingency described in 11.4.                                                                            |
| A judge's phone battery dies mid-session                              | They log in on another device. Submitted marks are on the server. Any marks queued offline on the dead device are lost and must be re-entered — which is why the queue depth indicator in 6.8 is a requirement, not a nicety. |
| Scoring configuration is changed after publication                    | Blocked by CONFIG_LOCKED unless a Super Admin explicitly unpublishes all results first, with a confirmation stating that every result will be recomputed.                                                                     |

**13. Event Setup Sequence**

The order below is enforced by dependency: each step requires the previous one. The system surfaces this as a setup checklist on the administrator dashboard, showing what remains before judging can begin.

| **Step** | **Action**                                                      | **Blocks**                           |
|----------|-----------------------------------------------------------------|--------------------------------------|
| 1        | Configure event settings including the age cut-off date         | Category derivation                  |
| 2        | Create categories with age bands                                | Item creation, member categorisation |
| 3        | Create churches                                                 | Member creation                      |
| 4        | Create items and assign categories, caps and criteria           | Registration                         |
| 5        | Configure scoring rules, position points, tie-breaks and grades | Result computation                   |
| 6        | Create members with chest numbers and church allocation         | Registration                         |
| 7        | Register members to items, individually or by bulk import       | Performance creation                 |
| 8        | Create judge accounts and issue credentials                     | Panel creation                       |
| 9        | Build panels and designate chief judges where used              | Session creation                     |
| 10       | Create sessions binding panels to items and stages              | Opening a session                    |
| 11       | Print badges and call sheets                                    | Event day operations                 |
| 12       | Take a pre-event snapshot                                       | Recovery position                    |
| 13       | Open sessions and begin judging                                 | —                                    |

**A pre-event readiness report is generated on demand and lists: members without registrations, items without participants, items without a session, sessions without a panel, judges without an assignment, and any member whose derived category conflicts with an item they are entered in. This report should be run and cleared the day before the event.**

**14. Constraints, Dependencies and Risks**

**14.1 Constraints**

- The system must operate on judge-owned or committee-supplied smartphones without installation from an app store.

- Data entry capacity before the event is limited to the administrator team, so bulk import quality directly determines readiness.

- Event dates are fixed; the system must be complete and rehearsed before them, not merely deployed.

**14.2 Dependencies**

- Confirmed list of categories with exact age bands and the cut-off date.

- Confirmed item list with types, categories and entry caps.

- Confirmed position points and whether grade points apply.

- Confirmed tie-break policy, agreed and published to churches in advance.

- Reliable venue wireless coverage on every stage, or an accepted offline-first operating plan.

- Committee decision on the number of judges per panel and whether panel size varies by item.

**14.3 Risks and mitigations**

| **Risk**                                          | **Impact** | **Mitigation**                                                                                                                  |
|---------------------------------------------------|------------|---------------------------------------------------------------------------------------------------------------------------------|
| Venue network failure during judging              | High       | Offline-capable judge app; on-site fallback server; printed paper mark sheets as last resort                                    |
| Judge unfamiliar with the application             | High       | Mandatory rehearsal session with dummy data before the event; single-screen printed quick guide; deliberately minimal interface |
| Tie-break policy disputed after results announced | High       | Policy configured, published to churches in advance, and printed on every result sheet                                          |
| Incorrect master data, especially chest numbers   | High       | Import validation preview; duplicate detection; pre-event readiness report                                                      |
| Judge credentials shared between people           | Medium     | Individual accounts; optional device pinning; judge activity report reveals anomalies                                           |
| Result changed after announcement                 | Medium     | Publication lifecycle with lock; unpublish requires Super Admin and a reason; change report lists every moved position          |
| Data loss                                         | High       | Automated 15-minute backups; manual snapshot before bulk operations; append-only audit log                                      |
| Scope growth during build                         | Medium     | This document as the agreed baseline; Phase 2 list in Section 16 as the destination for new ideas                               |

**15. Acceptance Criteria**

The system is accepted when all of the following are demonstrated on a populated test event.

| **\#** | **Criterion**                                                                                                                                             |
|--------|-----------------------------------------------------------------------------------------------------------------------------------------------------------|
| AC-01  | An administrator can complete the full setup sequence in Section 13 and the readiness report returns clean.                                               |
| AC-02  | Only administrators can create users. No self-registration route exists anywhere in the application or API.                                               |
| AC-03  | Three judges log in on three separate devices and each score the same participant; all three marks are recorded and correctly attributed.                 |
| AC-04  | A judge cannot submit a second mark for the same performance by any means, including a double tap, a browser back action, or a replayed API request.      |
| AC-05  | A judge has no interface or API route to edit or delete a submitted mark.                                                                                 |
| AC-06  | A judge cannot see any other judge's mark, any aggregate, or any ranking at any point.                                                                    |
| AC-07  | A performance becomes COMPLETE only when all panel judges have submitted, and the count is visible live to the administrator.                             |
| AC-08  | The administrator can identify, within one screen, every performance with a missing mark and the judge responsible.                                       |
| AC-09  | An item result correctly ranks participants and applies the configured tie-break sequence; the worked example in Section 7.5 reproduces exactly.          |
| AC-10  | An unresolvable tie blocks publication and is escalated to the administrator rather than resolved silently.                                               |
| AC-11  | Church points are correctly totalled from published items only, and the leaderboard identifies the champion church.                                       |
| AC-12  | Individual champion and, where enabled, category champions are computed correctly.                                                                        |
| AC-13  | Position points and item weights are configurable and a change is reflected on recomputation.                                                             |
| AC-14  | Revoking a score returns the performance to IN_PROGRESS, prompts the judge to re-enter, and appears in the exceptions report.                             |
| AC-15  | Result sheets show position, chest number, member name, church name, individual judge marks, aggregate and points, and export correctly to PDF and Excel. |
| AC-16  | The judge application functions with the network disabled and synchronises correctly on reconnection without creating duplicate marks.                    |
| AC-17  | Every state-changing action appears in the audit log with actor, timestamp and reason where required, and the log cannot be edited.                       |
| AC-18  | The judge interface is fully usable one-handed on a 360 px display, with the bottom navigation bar present on every screen.                               |
| AC-19  | A full scoring cycle is completed in under fifteen seconds by a judge who has been trained for five minutes.                                              |
| AC-20  | All edge cases listed in Section 12 behave as specified.                                                                                                  |

**16. Implementation Roadmap**

| **Phase**        | **Scope**                                                                                                                                | **Outcome**                           |
|------------------|------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------|
| 1 — Foundation   | Authentication, roles, users, churches, categories, items, members, registrations, audit log                                             | Master data can be fully prepared     |
| 2 — Judging core | Panels, sessions, performances, judge app, mark entry, immutable submission, live console                                                | An event can be judged end to end     |
| 3 — Results      | Aggregation, ranking, tie-breaks, position points, publication lifecycle, leaderboards, champions                                        | Results can be computed and announced |
| 4 — Operations   | Reports, exports, badges, certificates, bulk import, backup and restore, exceptions report                                               | The event can be run and documented   |
| 5 — Resilience   | Offline mode, realtime push, device pinning, performance tuning, rehearsal and load testing                                              | Production readiness                  |
| Future           | Public live scoreboard, spectator display, SMS notification, self-service church entry portal, multi-year analytics, native applications | Deferred by agreement                 |

**Phases 1 to 3 constitute the minimum viable system. Phase 5 is not optional for a live event; a marking system that has not been rehearsed under realistic conditions has not been tested.**

**17. Open Questions for the Committee**

These decisions are required before development of the affected areas begins. Each has been given a recommended default so that work is not blocked, but each should be explicitly confirmed.

| **\#** | **Question**                                                                           | **Recommended default**                                        |
|--------|----------------------------------------------------------------------------------------|----------------------------------------------------------------|
| Q1     | What are the exact categories and age bands, and what is the age cut-off date?         | To be supplied by the committee — no default possible          |
| Q2     | Is panel size always three, or does it vary by item?                                   | Configurable per panel; default three                          |
| Q3     | Aggregation method: average or sum?                                                    | Average                                                        |
| Q4     | Points for first, second and third?                                                    | 5, 3, 1                                                        |
| Q5     | Are third-place points awarded at all?                                                 | Yes                                                            |
| Q6     | Are shared positions permitted?                                                        | No — resolve by tie-break, escalate if unresolved              |
| Q7     | Confirmed tie-break order?                                                             | As listed in Section 4.5                                       |
| Q8     | Are grades (A/B/C) used, and do they carry points?                                     | Grades displayed; grade points disabled                        |
| Q9     | Do group items carry a weight multiplier?                                              | Yes, default 2.0 for group items                               |
| Q10    | Is there a cap on items per member?                                                    | Yes, recommended maximum of four                               |
| Q11    | Is there a cap on entries per church per item?                                         | Yes, recommended one                                           |
| Q12    | Is a Stage Coordinator role staffed, or does the administrator drive the live console? | Coordinator role enabled; falls back to administrator          |
| Q13    | Do judges score a single mark or multiple criteria?                                    | Single mark out of 10; criteria available per item if required |
| Q14    | Is a minimum number of items required for individual champion eligibility?             | Yes, two                                                       |
| Q15    | Should results be publicly visible during the event or only at the announcement?       | Only at the announcement                                       |
| Q16    | Is an on-site fallback server available at the venue?                                  | Strongly recommended                                           |
| Q17    | Who holds Super Admin credentials, and how many people?                                | Two named individuals                                          |

**18. Appendices**

**18.1 Status enumerations**

| **Entity**          | **Values**                                                          |
|---------------------|---------------------------------------------------------------------|
| User role           | SUPER_ADMIN, ADMIN, JUDGE, COORDINATOR                              |
| Registration status | REGISTERED, WITHDRAWN                                               |
| Performance status  | SCHEDULED, ON_STAGE, IN_PROGRESS, COMPLETE, ABSENT, VOID, WITHDRAWN |
| Session status      | DRAFT, OPEN, CLOSED, FORCE_CLOSED                                   |
| Item result state   | IN_PROGRESS, READY, PROVISIONAL, PUBLISHED, WITHHELD                |
| Item status         | ACTIVE, CANCELLED                                                   |
| Aggregation method  | AVERAGE, SUM, TRIMMED_MEAN, WEIGHTED_AVERAGE                        |

**18.2 Default configuration values**

| **Setting**                           | **Default**               |
|---------------------------------------|---------------------------|
| Maximum mark per judge                | 10                        |
| Decimal places allowed                | 1                         |
| Aggregation method                    | AVERAGE                   |
| Position points                       | 1st = 5, 2nd = 3, 3rd = 1 |
| Grade bands                           | A ≥ 80%, B ≥ 60%, C ≥ 40% |
| Grade points                          | Disabled                  |
| Shared positions                      | Not permitted             |
| Group item weight multiplier          | 2.0                       |
| Judge session timeout                 | 12 hours                  |
| Admin session timeout                 | 2 hours                   |
| Failed login lockout                  | 5 attempts, 15 minutes    |
| Backup interval on event days         | 15 minutes                |
| Minimum items for individual champion | 2                         |

**18.3 Next deliverables**

On approval of this document, the following are produced in order:

1.  UI mock designs for the judge application — all ten screens, mobile, including the bottom navigation bar, in both light and dark themes.

2.  UI mock designs for the administrator console — priority screens A1, A5, A6, A12, A14 and A15, at mobile and desktop widths.

3.  Technical design document covering the database schema, API contracts and deployment architecture.

4.  Test plan mapped to the acceptance criteria in Section 15 and the edge cases in Section 12.

5.  Event-day operations runbook for administrators and coordinators.

*End of Functional Specification Document — Version 1.0*
