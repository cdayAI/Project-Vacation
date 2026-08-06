# Project Vacation — design specification

This is the design authority for the product. The program brief says *what the
platform does*; this says **what it looks like, how it behaves, and what "done"
means for a screen.** Where the two disagree, this document wins on anything
visual or interactive.

It makes decisions rather than stating preferences. Treat the values here as the
starting system, not suggestions — change them deliberately and update this file,
never locally in a component.

---

## 0. What we are making

**Thesis, one sentence, settles arguments:**

> *Show me what needs me, tell me what will happen if I say yes, and prove it
> afterwards.*

**Feeling:** an approver six items into a queue of forty is **confident and
quick**. Not anxious, not rushed, not suspicious of the machine. Hesitation is a
defect.

**Reference set:** Linear (speed, keyboard model, opinionated defaults), Stripe
(dense data made legible and beautiful), Superhuman (triage flow, never lost),
Figma (direct manipulation), Raycast (command palette as primary movement). If a
screen would look out of place beside those, it is not finished.

**Three hero surfaces** get disproportionate prototyping and iteration; everything
else is quiet and competent:

1. **The approval** — open to decided, with real understanding, in under ten
   seconds.
2. **The copilot that already knows where you are.**
3. **The evidence trail** — one click from a decision to the whole chain.

---

## 1. Foundations

### 1.1 Typography

**Family.** Inter (variable) for UI, or MVW's licensed brand face if they have
one for digital — ask. Fallback stack: `Inter, -apple-system, "Segoe UI",
system-ui, sans-serif`. Monospace for ids, hashes, and code: `"JetBrains Mono",
ui-monospace, SFMono-Regular, monospace`.

**Enable `font-variant-numeric: tabular-nums` on every numeric context** — tables,
metrics, currency, timers. Digits must not shift width as values update.

**Scale** (size / line-height / weight / tracking):

| Token | px | line | weight | use |
| --- | --- | --- | --- | --- |
| `display` | 32 / 40 | 600 | −0.02em | one per screen, executive headers |
| `title-lg` | 24 / 32 | 600 | −0.01em | page titles |
| `title` | 20 / 28 | 600 | −0.01em | section and card titles, the approval question |
| `body-lg` | 16 / 24 | 400 | 0 | reading passages, evidence text |
| `body` | 14 / 20 | 400 | 0 | default UI text |
| `body-strong` | 14 / 20 | 500 | 0 | emphasis inside body |
| `label` | 13 / 18 | 500 | 0 | form labels, table headers, chips |
| `caption` | 12 / 16 | 400 | 0.01em | metadata, timestamps, helper text |
| `micro` | 11 / 14 | 500 | 0.03em | uppercase eyebrows, badges |

Rules: no size outside the scale. Reading measure 60–80 characters (cap
paragraph containers at 720px). Never centre body text. Never use weight below
400 or above 600.

### 1.2 Spacing and layout

4px base. Scale: **4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 96**. Nothing between.

- Component internal padding: 8/12 (compact), 12/16 (default).
- Space between related elements: 8. Between groups: 24. Between sections: 40.
- Page gutters: 24 desktop, 16 tablet.

### 1.3 Radius, elevation, borders

- Radius: **6** controls (buttons, inputs, chips), **10** cards and panels,
  **16** sheets and modals, **999** pills and avatars.
- Border: hairline **1px**, `border-subtle` for structure, `border-strong` only
  for focus and selection.
- Elevation ladder — four levels, no others:
  - `e0` flat, no shadow — page background, table rows.
  - `e1` `0 1px 2px rgba(0,0,0,.06)` — cards at rest.
  - `e2` `0 4px 12px rgba(0,0,0,.08)` — popovers, dropdowns, hovered cards.
  - `e3` `0 16px 40px rgba(0,0,0,.16)` — modals, sheets, command palette.
  Dark theme multiplies shadow alpha ×2.5 and adds a 1px top inner highlight at
  `rgba(255,255,255,.06)`.

### 1.4 Color

Semantic roles only; components never reference a brand name or a raw hex.

| Role | Light | Dark |
| --- | --- | --- |
| `bg-base` | `#F7F8FA` | `#0E1013` |
| `bg-subtle` | `#EEF0F4` | `#15181D` |
| `surface` | `#FFFFFF` | `#1A1D23` |
| `surface-raised` | `#FFFFFF` | `#212530` |
| `border-subtle` | `rgba(16,20,28,.08)` | `rgba(255,255,255,.09)` |
| `border-strong` | `rgba(16,20,28,.18)` | `rgba(255,255,255,.20)` |
| `content-primary` | `#0F1319` | `#F2F4F7` |
| `content-secondary` | `#4A5262` | `#A6AEBD` |
| `content-tertiary` | `#727B8C` | `#7A8496` |
| `accent` | **from MVW brand** | derived, lightness-adjusted |
| `accent-contrast` | white or near-black, whichever passes 4.5:1 | same rule |

**Accent must come from MVW's brand guidelines — ask for the values, never
sample or guess.** MVW licenses Marriott, Sheraton, Westin, and Hyatt marks;
brand usage needs a named approver. Build the system so the accent is one token:
a brand decision must not require a refactor.

**Status palette** (identical semantics everywhere, always paired with an icon or
label — never color alone):

| Status | Light | Dark | Meaning |
| --- | --- | --- | --- |
| `success` | `#0E7C4A` | `#3DD68C` | done, within policy, healthy |
| `warning` | `#B25E02` | `#F5A524` | approaching a limit or deadline |
| `danger` | `#B4232B` | `#FF6B6B` | breached, failed, blocked |
| `info` | `#1F5FD0` | `#6BA6FF` | in progress, informational |
| `neutral` | `#5B6478` | `#8B94A6` | inert, archived, not applicable |

**Contrast:** body text ≥ 4.5:1, large text and icons ≥ 3:1, focus ring ≥ 3:1
against both the surface and the adjacent color, **in both themes**.

**Chart palette is separate from brand.** Categorical, in this order, chosen for
perceptual distinctness rather than prettiness — verify in greyscale:

`#3B7DD8 · #E08A2E · #2E9E7B · #B15FCB · #C9483F · #6E7CE0 · #7A8C3A · #9A6A4A`

Sequential: single-hue accent ramp, 5 steps. Diverging: `danger → neutral →
success`, 7 steps, centred on the meaningful zero.

### 1.5 Glass — the recipe

Glass is the product's signature. It goes on **chrome and overlays only**: the
left rail, the top bar, the right context panel, popovers, sheets, modals,
toasts, and summary cards. **Never behind a table, a chart, a form, or long-form
reading.**

```
/* light */
--glass-bg: rgba(255,255,255,.72);
--glass-blur: blur(20px) saturate(180%);
--glass-border: 1px solid rgba(16,20,28,.07);
--glass-highlight: inset 0 1px 0 rgba(255,255,255,.85);

/* dark */
--glass-bg: rgba(22,25,31,.64);
--glass-blur: blur(24px) saturate(140%);
--glass-border: 1px solid rgba(255,255,255,.08);
--glass-highlight: inset 0 1px 0 rgba(255,255,255,.07);
```

Hard rules:

1. **Text on glass sits on a scrim.** Either a solid child container at ≥ 92%
   opacity, or a local gradient scrim. **Measure contrast against the composite**
   — the most common way glass fails accessibility is checking the text token
   against the panel token and never against what shows through.
2. **Dark glass is not inverted light glass.** Separate tint, opacity, blur, and
   highlight values, as above.
3. **Cap concurrent blurred surfaces at three.** Never blur behind a scrolling
   virtualized list.
4. **`prefers-reduced-transparency` and an explicit in-app "Reduce transparency"
   preference** swap every glass surface for its solid equivalent
   (`surface-raised` + `border-subtle` + `e2`). Every screen must be fully usable
   and attractive in that mode — build it as a first-class variant and screenshot
   it in review.

### 1.6 Motion

| Token | Duration | Easing | Use |
| --- | --- | --- | --- |
| `micro` | 120ms | `cubic-bezier(.2,0,0,1)` | hover, press, checkbox, toggle |
| `standard` | 180ms | `cubic-bezier(.2,0,0,1)` | popovers, dropdowns, toasts |
| `surface` | 240ms | `cubic-bezier(.2,0,0,1)` | side panel, sheet, modal |
| `page` | 280ms | `cubic-bezier(.2,0,0,1)` | route transitions |
| exit | ×0.7 of entry | `cubic-bezier(.4,0,1,1)` | all dismissals |

**Motion preserves identity.** A detail view opens *from* the row you selected
and collapses back *into* it. A card expanding into a panel keeps its title
anchored. This continuity is what makes an interface feel like a place instead of
a slideshow.

Never animate: text content changing, table sorting (re-render instantly), or
anything on the critical typing path. Under `prefers-reduced-motion`, all of the
above become opacity-only at 80ms.

---

## 2. The app shell

```
┌──────────────────────────────────────────────────────────────────────┐
│  top bar  56px  ·  glass                                             │
│  [breadcrumb ......]        [⌘K search]      [bell] [avatar]         │
├────────┬────────────────────────────────────────┬────────────────────┤
│        │                                        │                    │
│ rail   │  content                               │  context panel     │
│ 240px  │  gutters 24px                          │  380px · glass     │
│ glass  │  reading blocks capped 720px           │  resizable 320–520 │
│        │  tables full-bleed                     │  copilot lives here│
│        │                                        │                    │
└────────┴────────────────────────────────────────┴────────────────────┘
```

- **Rail**: 240px expanded, 64px icon-only collapsed (state persists per user).
  Four zones in fixed order — **Work · Oversight · Improve · Admin** — with only
  the zones this role can use. Active item marked with a 3px accent bar and
  `surface-raised`, never a full-bleed accent fill.
- **Top bar**: breadcrumb reflecting real hierarchy, centred command trigger
  showing `⌘K`, notifications bell with unread count, avatar menu (theme,
  density, reduce transparency, shortcuts, sign out).
- **Context panel**: right side, glass, collapsible and resizable. Holds the
  copilot and record context. Its state persists per route.
- **Breakpoints**: ≥1440 full; 1280 panel narrows to 320; 1024 rail collapses to
  icons; 900 panel becomes an overlay sheet; below 900 read-only layouts only —
  no data entry designed for phones unless the owner asks.

---

## 3. Screen specifications

### 3.1 Work queue — the default landing

**Layout:** filter bar (sticky, 56px) → table (virtualized, fills) → selection
action bar (appears on select, docked bottom).

**Filter bar:** saved views as pills on the left (`All open · Mine · Breaching ·
High value · Unassigned`), a filter builder button, a result count
(`1,240 cases`), and view density toggle on the right. **Every filter state
encodes into the URL** so a view can be pasted into a ticket.

**Columns** (default, user-configurable, order persists per user):

| Col | Width | Content |
| --- | --- | --- |
| status | 32 | 8px dot, status color, with tooltip |
| what | flex | Case title, `body-strong`; second line `caption` context |
| owner | 180 | Owner name + account id in `caption` |
| age | 100 | Relative ("2d 4h"), colored by SLA: neutral → warning at 80% → danger past |
| value | 120 | Currency, tabular, right-aligned, decimal-aligned |
| assignee | 140 | Avatar + name, or "Unassigned" in `content-tertiary` |
| next | 160 | The next action, as a verb phrase |

**Rows:** 40px compact / 52px comfortable. Hover raises to `bg-subtle` — no
shadow, no lift, no scale. Selected row gets a 2px left accent bar.

**Behavior:** `J`/`K` move, `Space` previews in the context panel without
navigating, `Enter` opens, `X` toggles selection, `Shift+J/K` range-select.
Sorting is instant, no animation. Infinite scroll with a sticky header and a
persistent row count.

**Bulk bar:** appears docked at the bottom on selection: `47 selected` + allowed
actions + `Preview changes`. Bulk actions state their scope in words and require
a preview step for anything consequential.

**Empty state:** an illustration-free, calm block —
> **Nothing needs you right now.**
> New cases arrive as owners contact us or as workflows escalate. You will see
> them here, and a digest lands at 9:00 each morning.
> `[ Change my digest ]  [ See all cases ]`

### 3.2 The approval — the hero screen

Two columns, **60 / 40**, with a sticky decision bar. **The decision must be
possible without scrolling** at 1440×900 in default density.

**Left column, in this exact order:**

1. **The ask**, `title` (20/28), plain language, no serialized payload:
   *"Send a rescission confirmation to 3 owners in Florida."*
2. **Provenance row** of chips: who or what asked · a **type badge** —
   `Workflow` / `External agent` / `System change` in distinct colors ·
   requested time · risk level.
3. **"If you approve"** — a bordered callout, `border-strong`, the concrete
   effect as up to 4 bullets, plus the **exact artifact** (letter, record write,
   message) with an inline preview toggle. Never a paraphrase of the effect.
4. **"If you reject"** — one line, same visual weight, no callout.
5. **Why this needs you** — the named rule and its threshold, linked to the rule
   in the config: *"State rescission notice · high risk · policy R-14."*
6. **Blast radius strip** — four cells, `caption` labels over `body-strong`
   values: **Owners affected · Money · Reversible? · How to reverse**.
7. **Evidence** — each item is source · version · effective date, expandable
   inline to the exact passage. Never navigate away to check a citation.
8. **Prior similar decisions** — last five: what, who decided, outcome. This is
   how an approver calibrates in seconds.

**Right column:** the record in context — owner, contract, account, timeline —
collapsible sections, and the copilot below it.

**Decision bar** (sticky, bottom, glass, 72px):

- `Reject` and `Approve` are **the same size and the same visual weight**.
  Approve carries the accent; Reject carries `border-strong` on `surface`.
  Neither is styled as the easy path.
- Rejecting expands an inline reason selector (never a modal): a short list of
  reasons plus free text. The reason is captured as improvement signal.
- Keyboard: `A` approve, `R` reject, `E` evidence focus, `J`/`K` previous/next
  approval, `Esc` back to queue. After deciding, advance to the next item
  automatically with a 2-second undo toast.

**Bulk approval** is offered only when the system can prove the items share a
shape, and it shows exactly what is common and what differs.

### 3.3 Case / run detail

**Header** (sticky, 64px): title · status chip · owner · elapsed · cost ·
overflow menu.

**Body:** a vertical timeline as the spine — one row per step:

```
● 09:41:02   Retrieved owner contract          120ms    $0.00
│            3 documents · 2 cited
● 09:41:03   Determined rescission window      1.4s     $0.011
│            Model · cited FL §721.10 (rev 2025-07-01)
│            [ show reasoning ]  [ correct this ]
◆ 09:41:05   PARKED — awaiting approval #4182  —        —
```

- Each step: icon by type (retrieval, model, action, human, wait), what, when,
  duration, cost. Expandable to inputs and outputs.
- **Model steps** additionally show the sources cited, a visual distinction
  between *retrieved*, *asserted*, and *computed*, and a **Correct this** control
  that captures the correction as signal.
- Human steps show who and how long they took.
- Failed steps show what happened and the retry or escalation that followed.

**Right panel:** record context + copilot.

### 3.4 Evidence and audit browser

Filter rail (left, 240px): date range, owner, action type, actor, outcome,
workflow, verification status. Results as a dense table. Selecting a row opens a
**full-height sheet** with the complete chain: inputs and their fingerprints,
sources with versions, decisions, approvals with approver identity, and the chain
verification badge (`Verified` in `success`, or a loud `danger` state naming
exactly what failed). Export as CSV and as a print-ready PDF with a cover sheet
— regulator requests are a real workflow.

### 3.5 Performance and executive views

- **One question per chart, written as the title.** *"Collections recovery by
  cohort, last 6 months."*
- Every metric tile: value (`display`, tabular) · trend arrow with % change ·
  the comparison basis in `caption` (*"vs. prior 30 days"*) · a sparkline. **A
  tile without a comparison is not shipped.**
- **Always show the denominator**: "94.2% first-pass · of 1,240 cases."
- Chart rules: max 6 series; direct labels at line ends instead of legends where
  space allows; one subtle horizontal gridline set, no vertical; bars start at
  zero; annotate interventions ("shadow → assisted, 12 Jun") as vertical markers.
- Executive view uses the metric names management used in the earnings release,
  not internal names.

### 3.6 The copilot

**Placement:** the context panel, on every route. `C` focuses it, `Esc` returns
focus to content. It never steals focus and never opens a blocking modal.

**Composition:** a context chip row at the top showing what it can see right now
(*"Case 41823 · Owner M. Delgado · Collections queue"*), the conversation, and a
composer with suggested actions relevant to the current route.

**Answers** carry inline citations with the same retrieved/asserted/computed
distinction as everywhere else, plus a footer line with cost and elapsed in
`caption`. "I don't know" is a designed, first-class response that offers to
route to a human.

**Proposed actions** render as a **card inside the conversation** with the same
anatomy as the approval callout — what will happen, blast radius, and Approve /
Reject. Consequential actions park in the real approval queue; the card then
shows the pending state and links to it.

Streaming: text streams, but **any action card renders only when complete**.
Never animate a half-formed action a user might click.

### 3.7 Low-code configuration screens

Every configuration surface follows one pattern: **Current → Draft → Diff →
Impact → Publish.**

- The editor shows the live value beside the draft.
- A **Diff** tab is mandatory before publish.
- For anything model-facing, an **Impact** tab runs the golden set and shows the
  evaluation delta — pass rate before and after, and which cases changed.
- Publish is a governed action: attributed, versioned, approved where
  consequential, and revertible from the version list in one click.
- A **Test run** button executes against a sandbox case before publish.

---

## 4. Components

Build in this order. Each needs every state: default, hover, focus-visible,
active, disabled, loading, error, empty, read-only.

**Primitives:** Button (primary / secondary / ghost / danger; 28 / 32 / 40 px),
Input, Select, Combobox, Checkbox, Radio, Switch, Textarea, DatePicker,
DateRange, Chip, Badge, Avatar, Tooltip, Spinner, Skeleton.

**Composites:** Table (virtualized, sortable, resizable, configurable columns),
Card, Panel, Sheet, Modal, Popover, Dropdown, Tabs, Timeline, Callout, Toast,
CommandPalette, FilterBar, MetricTile, Chart wrappers (Line, Bar, StackedBar,
Area, Sparkline), EmptyState, ErrorState, DiffView, EvidenceItem, ApprovalCard,
CopilotMessage.

**Read-only is a designed state, not a greyed-out accident** — auditors live in
it. Same layout, reduced affordance: no borders on inputs, values in
`content-primary`, a single "Read-only" chip in the header.

Ship a **component gallery** at `/design` in the app itself, showing every
component in every state, in both themes, with and without transparency. It is
the review surface and the regression check.

---

## 5. Keyboard model

Consistent verbs, everywhere:

| Key | Action |
| --- | --- |
| `⌘K` / `Ctrl K` | Command palette — actions, records, views, recent |
| `/` | Focus search in the current context |
| `G` then `Q` `A` `E` `S` | Go to Queue / Approvals / Evidence / Settings |
| `J` / `K` | Next / previous item |
| `Enter` | Open focused item |
| `Space` | Preview focused item in the panel |
| `X` | Toggle selection |
| `A` / `R` | Approve / Reject (approval context only) |
| `C` | Focus copilot |
| `⌘Enter` | Submit the primary action in a form |
| `Esc` | Close, cancel, or step back one level |
| `?` | Shortcut reference |

The **command palette is primary navigation**, not a bonus: it searches actions,
records, and saved views in one list, shows each item's shortcut, and learns
frequency. Every action reachable by mouse is reachable here.

---

## 6. Copy

Write like a competent colleague. Short sentences, active voice, plain words,
no unexpanded acronyms, no exclamation marks, no jokes.

**Errors** name what happened, what it means, and what to do, with a reference:

> **We could not reach the loan servicing system.**
> Your work is saved. You can retry now, or continue and we will sync when it is
> back. Reference `8f2a41`.
> `[ Retry ]  [ Continue offline ]`

**Permission denied** names a human who can help:

> **You do not have access to collections cases.**
> A supervisor can grant it — Dana Ruiz or Marc Webb administer this queue.

**Destructive confirmation** states the consequence and whether it is reversible:

> **Revoke credentials for `sf-quotebot`?**
> It stops working immediately, including three runs in flight. You can issue new
> credentials at any time, but the current ones cannot be restored.

**Never:** "Oops!", "Something went wrong", "Invalid input", a raw stack trace,
or a message that blames the user.

---

## 7. Performance budgets

Enforced in CI on the queue, approval, and detail routes, measured on a
mid-range laptop over throttled network:

- **Route change from cache: ≤ 100ms to first paint.** Prefetch on hover, focus,
  and keyboard selection.
- **Interaction to next paint: < 200ms** at the 95th percentile.
- **Cumulative layout shift: 0** on the hot paths. Reserve space for everything
  that will load.
- **Skeletons only past 300ms**; below that show nothing rather than a flash.
- Typing is never blocked, filtered, or debounced past 120ms.
- Table renders 10,000 rows without jank via virtualization.

---

## 8. Definition of done for a screen

A screen is done when all of this is true. Capture screenshots in **light, dark,
and reduced-transparency** at each phase gate and review against it.

**Correct**
1. Purpose obvious in five seconds; primary action obvious without hunting.
2. Every number carries a comparison or trend; every chart's title is a question;
   denominators shown.
3. Empty, loading, error, permission-denied, and read-only states designed.
4. Legible and correct in both themes and with transparency off.
5. Fully keyboard operable; focus visible and designed; shortcuts documented.
6. WCAG 2.2 AA verified — automated in CI plus a manual keyboard and
   screen-reader pass.
7. Meets the performance budgets in §7.
8. An operator can change what governs it without an engineer.

**Good** — the part that separates levels. Ask these out loud:
9. **Does it feel instant?** Not "within budget" — instant.
10. **Would you screenshot it and show someone?**
11. **Would a designer whose work you admire nod, or wince?**
12. **Is there one thing here no comparable product does?**
13. **After an hour, would a skeptical MVW supervisor resent going back to their
    old tool?**

If 1–8 pass and 9–13 do not, the screen is **correct, not finished** — report it
that way rather than calling it done, and say what you would change with another
pass.

---

## 9. How to work

1. **Tokens and the component gallery first.** No screen before the system.
2. **Prototype the approval screen and the case detail before the data model is
   final** — those two screens will tell you what the record must store, and
   doing it the other way around guarantees a migration.
3. **Three passes minimum on each hero surface.** First pass satisfies §8.1–8.
   Second pass is subtraction: remove everything that does not serve the thesis.
   Third pass is craft: alignment, rhythm, motion continuity, copy.
4. **Review screens as screens**, side by side in both themes, at every phase
   gate — not as a list of tickets.
5. **Watch a real MVW user complete a real task in silence.** Every hesitation is
   a defect with an owner and a fix. The silence is the test.
