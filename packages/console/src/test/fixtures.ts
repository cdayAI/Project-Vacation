import type {
  ApprovalView,
  ApprovalDetailView,
  AuditEntryView,
  AuditVerificationView,
  ContainmentView,
  CorrectionView,
  DenialView,
  DiscoveryCandidateView,
  ExecutiveView,
  ExternalAgentDetailView,
  ExternalAgentHealthView,
  ExternalAgentView,
  HealthView,
  ImprovementClusterView,
  ImprovementProposalView,
  RoleView,
  RunDetailView,
  SessionView,
  WorkflowInstanceView,
  WorkQueueItem,
  WorkQueuePage,
} from "../api/contract";

/**
 * Fixture data for the console's tests.
 *
 * Shaped like the work this platform is aimed at — contract packages,
 * statutory rescission clocks, association board reporting, owner
 * correspondence — because a view tested against `{ title: "test" }` renders
 * fine and then falls apart the first time it meets a 64-character digest, an
 * association name with a comma in it, or a cost of four ten-thousandths of a
 * dollar.
 *
 * Every name here is invented. No association, resort, or brand named in these
 * fixtures is a real one, and nothing in this file uses a licensed mark.
 */

export const supervisor = {
  actorId: "act_7f3a91c2",
  displayName: "Dana Whitfield",
  roles: ["owner_services_supervisor"],
} as const;

export const complianceReviewer = {
  actorId: "act_2c88de40",
  displayName: "Marcus Oyelaran",
  roles: ["compliance_reviewer"],
} as const;

export const agentOperator = {
  actorId: "act_bb10f5a7",
  displayName: "Priya Raghunathan",
  roles: ["owner_services_agent"],
} as const;

export const associationManager = {
  actorId: "act_9d51ab73",
  displayName: "Yolanda Sarmiento",
  roles: ["association_manager"],
} as const;

export const platformAdmin = {
  actorId: "act_31f0b28c",
  displayName: "Ewan Castellanos",
  roles: ["platform_admin"],
} as const;

export const auditor = {
  actorId: "act_04e6cc19",
  displayName: "Helen Braithwaite",
  roles: ["auditor"],
} as const;

/** A vendor's agent running in MVW's CRM, not in this platform. */
export const externalAgentActor = {
  actorId: "xag_01k3p7c2m9",
  displayName: "sf-quotebot",
  roles: ["external_agent"],
} as const;

export const session: SessionView = {
  actor: supervisor,
  secondsSinceAuthentication: 412,
  capabilities: [
    "work.read",
    "approvals.read",
    "approvals.decide",
    "runs.read",
    "roles.read",
    "external_agents.read",
    "improvements.read",
    "audit.read",
    "containment.read",
    "containment.engage",
    "discovery.read",
    "executive.read",
    "health.read",
  ],
  readOnly: false,
};

export const auditorSession: SessionView = {
  actor: auditor,
  secondsSinceAuthentication: 90,
  capabilities: ["work.read", "runs.read", "audit.read"],
  readOnly: true,
};

export const healthyPlatform: HealthView = {
  status: "ok",
  environment: "staging",
  store: "postgres",
  sandboxMode: "container-isolated",
  sandboxIsContained: true,
  discoveryEnabled: false,
  modelProvider: "configured-inventory",
  auditHeadSeq: 41_882,
  lastAuditVerification: {
    intact: true,
    entriesChecked: 41_882,
    firstSeq: 1,
    lastSeq: 41_882,
    headHash: "5f2b8c1de4a70936bb1c4f8a2d0e77c3a9451bd6e8f302447cbb19de5a6027f18",
    verifiedAt: "2026-08-06T09:14:02.000Z",
    breaks: [],
  },
  containment: [],
  warnings: [],
};

export const alarmingPlatform: HealthView = {
  ...healthyPlatform,
  status: "degraded",
  sandboxMode: "in-process",
  sandboxIsContained: false,
  discoveryEnabled: true,
  lastAuditVerification: {
    intact: false,
    entriesChecked: 41_882,
    firstSeq: 1,
    lastSeq: 41_882,
    headHash: null,
    verifiedAt: "2026-08-06T09:14:02.000Z",
    breaks: [
      {
        kind: "hash_mismatch",
        seq: 18_204,
        detail: "Recomputed entry hash does not match the stored value.",
      },
    ],
  },
  warnings: ["Model inventory is using a development configuration file."],
};

/**
 * The work queue, in the seven columns §3.1 fixes.
 *
 * Deliberately mixed. Some rows carry an owner name and a case value because
 * a deployment with its systems of record connected has them; others carry
 * only the honest absence a deployment without them reports. A screen tested
 * against one of those states is a screen that falls over the first time it
 * meets the other, and the absent state is the one this repository ships in.
 */
export const workQueueItems: readonly WorkQueueItem[] = [
  {
    runId: "run_01k3m9x2p7",
    kind: "rescission.package_check",
    title: "Rescission package check — contract CTR-2026-FL-0184423",
    subtitle: "Public offering statement receipt missing from the delivered package · FL",
    status: "awaiting_approval",
    mode: "supervised",
    createdAt: "2026-08-04T13:02:11.000Z",
    slaStartedAt: "2026-08-04T13:02:11.000Z",
    dueAt: "2026-08-05T13:02:11.000Z",
    slaPolicy: "Rescission package check — one business day",
    slaBreached: true,
    owner: { accountRef: "CTR-2026-FL-0184423", name: "M. Delgado" },
    valueUsd: 28_400,
    assignment: "assigned",
    assignee: supervisor,
    assignedRole: "owner_services_supervisor",
    nextAction: "Approve or reject the parked action",
    nextActionApprovalId: "apr_01k3n2f6r4",
    costUsd: 0.4821,
    waitingOn: "A supervisor to approve sending the corrected disclosure package.",
  },
  {
    runId: "run_01k3m9y8q1",
    kind: "rescission.clock_compute",
    title: "Rescission deadline recompute — contract CTR-2026-SC-0177015",
    subtitle: "Shadow — nothing this run proposes will land · SC",
    status: "running",
    mode: "shadow",
    createdAt: "2026-08-06T07:41:55.000Z",
    slaStartedAt: "2026-08-06T07:41:55.000Z",
    dueAt: "2026-08-06T19:41:55.000Z",
    slaPolicy: "Statutory clock recompute — twelve hours",
    slaBreached: false,
    owner: { accountRef: "CTR-2026-SC-0177015", name: "R. Ashworth" },
    valueUsd: 19_950,
    assignment: "unassigned",
    nextAction: "Wait — the platform is working on it",
    costUsd: 0.0037,
    waitingOn: "The statutory rules corpus for South Carolina to finish loading.",
  },
  {
    runId: "run_01k3m8w4t9",
    kind: "association.board_pack",
    title: "Board pack assembly — Coral Bay Owners Association, Inc., Q3 2026",
    subtitle: "Reserve study extract outstanding · FL",
    status: "awaiting_human",
    mode: "assisted",
    createdAt: "2026-08-03T16:20:00.000Z",
    slaStartedAt: "2026-08-03T16:20:00.000Z",
    dueAt: "2026-08-07T16:20:00.000Z",
    slaPolicy: "Association board pack — four days before the meeting",
    slaBreached: false,
    owner: { accountRef: "ASN-FL-0031", name: "Coral Bay Owners Association, Inc." },
    valueUsd: 1_412_000,
    assignment: "assigned",
    assignee: associationManager,
    assignedRole: "association_manager",
    nextAction: "Complete the human task",
    costUsd: 2.1408,
    waitingOn: "The reserve study extract for the 2026 fiscal year.",
  },
  {
    runId: "run_01k3mc2f80",
    kind: "maintenance_fee.collection_review",
    title: "Maintenance-fee collection review — interest SUN-2019-AZ-0044120",
    subtitle: "62 days past due · AZ",
    status: "awaiting_approval",
    mode: "supervised",
    createdAt: "2026-08-05T08:00:00.000Z",
    slaStartedAt: "2026-08-05T08:00:00.000Z",
    dueAt: "2026-08-07T08:00:00.000Z",
    slaPolicy: "Maintenance-fee collection review — two days",
    slaBreached: false,
    owner: { accountRef: "SUN-2019-AZ-0044120", name: "T. Okonkwo" },
    valueUsd: 1_284,
    assignment: "assigned",
    assignee: complianceReviewer,
    assignedRole: "compliance_reviewer",
    nextAction: "Approve or reject the parked action",
    nextActionApprovalId: "apr_01k3n3z9w7",
    costUsd: 0.1147,
    waitingOn: "A compliance reviewer to approve the first arrears notice.",
  },
  {
    runId: "run_01k3m7r6v2",
    kind: "owner_services.response_draft",
    title: "Owner enquiry draft — points reinstatement, membership MBR-4471-889-02",
    subtitle: "A draft reply was produced and placed in the agent's queue.",
    status: "succeeded",
    mode: "assisted",
    createdAt: "2026-08-05T11:05:30.000Z",
    slaStartedAt: "2026-08-05T11:05:31.000Z",
    dueAt: "2026-08-05T15:05:31.000Z",
    slaPolicy: "Owner enquiry first response — four hours",
    slaBreached: false,
    // The state this repository ships in: opaque reference, no name, and a
    // sentence saying why rather than a blank cell.
    owner: {
      accountRef: "MBR-4471-889-02",
      nameUnknown:
        "The operating record holds an opaque account reference, never an owner's name. Connect the owner system of record to show one here.",
    },
    valueUnknown:
      "Case value comes from the contract and billing systems of record, which are not connected to this deployment.",
    assignment: "assigned",
    assignedRole: "owner_services_agent",
    nextAction: "Check the result and close the case",
    costUsd: 0.0912,
  },
  {
    runId: "run_01k3m6h1c5",
    kind: "loan_file.evidence_pack",
    title: "Delinquency evidence pack — loan LN-2024-NV-0930881",
    subtitle:
      "The platform refused to rank or sequence borrowers. It will assemble the evidence and a person decides the treatment. · NV",
    status: "denied",
    mode: "supervised",
    createdAt: "2026-08-02T09:15:44.000Z",
    slaStartedAt: "2026-08-02T09:15:45.000Z",
    dueAt: "2026-08-04T09:15:45.000Z",
    slaPolicy: "Delinquency evidence pack — two days",
    slaBreached: false,
    owner: { accountRef: "LN-2024-NV-0930881", name: "J. Mbeki" },
    valueUsd: 41_770,
    assignment: "assigned",
    assignedRole: "consumer_finance_analyst",
    nextAction: "Read the refusal and take it forward by hand",
    costUsd: 0.0,
    waitingOn: "nothing — the platform refused this and it will not proceed",
  },
  {
    runId: "run_01k3m5d0b8",
    kind: "association.budget_variance",
    title: "Budget variance narrative — Palmetto Dunes Vacation Owners Association, Inc.",
    subtitle: "Shadow — nothing this run proposes will land · SC",
    status: "pending",
    mode: "shadow",
    createdAt: "2026-08-06T06:00:00.000Z",
    slaStartedAt: "2026-08-06T06:00:00.000Z",
    dueAt: "2026-08-09T06:00:00.000Z",
    slaPolicy: "Budget variance narrative — three days",
    slaBreached: false,
    owner: { accountRef: "ASN-SC-0114", name: "Palmetto Dunes Vacation Owners Association, Inc." },
    valueUsd: 903_500,
    assignment: "unassigned",
    nextAction: "Start the run",
    costUsd: 0.0,
  },
  {
    runId: "run_01k3m4a7n3",
    kind: "rescission.package_check",
    title: "Rescission package check — contract CTR-2026-HI-0166204",
    subtitle: "The retrieval step failed three times against the contract records system. · HI",
    status: "failed",
    mode: "supervised",
    createdAt: "2026-08-01T22:48:03.000Z",
    slaStartedAt: "2026-08-01T22:48:03.000Z",
    dueAt: "2026-08-02T22:48:03.000Z",
    slaPolicy: "Rescission package check — one business day",
    slaBreached: false,
    owner: { accountRef: "CTR-2026-HI-0166204", name: "L. Kahananui" },
    valueUsd: 33_100,
    assignment: "assigned",
    assignedRole: "owner_services_supervisor",
    nextAction: "Review the failure and decide whether to retry",
    costUsd: 0.3311,
  },
  {
    // A kind nobody has agreed a service level for. The age column has no band
    // to draw, and the screen says so instead of inventing a deadline.
    runId: "run_01k3md0k41",
    kind: "inventory.recovery_forecast",
    title: "Inventory recovery forecast — Kaanapali phase 3",
    subtitle: "Shadow — nothing this run proposes will land · HI",
    status: "running",
    mode: "shadow",
    createdAt: "2026-08-06T05:12:00.000Z",
    slaStartedAt: "2026-08-06T05:12:00.000Z",
    slaTargetUnknown:
      'No service-level target is declared for "inventory.recovery_forecast", so this item has no age band.',
    slaBreached: false,
    ownerUnknown: "This run carries no account reference, so there is no owner to show.",
    valueUnknown:
      "Case value comes from the contract and billing systems of record, which are not connected to this deployment.",
    assignment: "not_tracked",
    nextAction: "Wait — the platform is working on it",
    costUsd: 0.6104,
  },
];

/** The queue as the endpoint returns it, filter state and all. */
export const workQueue: WorkQueuePage = {
  items: workQueueItems,
  total: workQueueItems.length,
  limit: 50,
  offset: 0,
  totalIsExact: true,
  view: "all_open",
  sort: "age_desc",
  highValueFloorUsd: 1000,
};

/**
 * A page whose count is not the whole truth.
 *
 * Reached when a filter the store cannot apply is resolved over a bounded
 * window. The console has to say so: a result count that quietly rounds down
 * is how a supervisor concludes the queue is shorter than it is.
 */
export const workQueueInexactCount: WorkQueuePage = {
  ...workQueue,
  items: workQueueItems.filter((item) => item.slaBreached),
  total: 1,
  totalIsExact: false,
  view: "breaching",
};

export const workQueueEmpty: WorkQueuePage = {
  ...workQueue,
  items: [],
  total: 0,
  view: "all_open",
};

/**
 * The approval an approver opens first: a corrected disclosure package that
 * moves a statutory cancellation deadline.
 *
 * Fully populated, because a deployment with its document store and its
 * corpus wired has all of this. The artifact re-digests to the proposal
 * digest, which is what makes the inline preview safe to read — a preview
 * that merely represented the proposal would let somebody read one letter and
 * sign another.
 */
export const approvalAwaitingDecision: ApprovalDetailView = {
  approvalId: "apr_01k3n2f6r4",
  action: "document.generate_owner_facing",
  actionDescription: "Generate a document that will be delivered to an owner.",
  ask: "Produce a document an owner will receive — CTR-2026-FL-0184423",
  risk: "high_consequence",
  reversible: false,
  summary:
    "The original disclosure package for this Florida contract omitted the public offering statement receipt. Sending a corrected package restarts the statutory rescission period from the date of delivery, which moves the purchaser's cancellation deadline and the associated funding hold.",
  proposalDigest: "sha256:9c4f1ea77b0d38625af0c9b34e1d5a8206ff73c19ad48be05723c6d1f8904b7e",
  provenance: {
    kind: "workflow",
    label: "Rescission package check",
    actor: agentOperator,
    origin: "rescission.package_check",
    runId: "run_01k3m9x2p7",
    basis: "Raised by a workflow step on a run in the operating record.",
  },
  effects: [
    "The corrected package is rendered from the approved template at revision 3 and stored against contract CTR-2026-FL-0184423.",
    "It becomes deliverable by certified mail with return receipt; the delivery step that follows does not ask again.",
    "The purchaser's cancellation deadline moves from 12 August to 20 August 2026, and the funding hold extends to 21 August.",
    "The rendered document's digest is bound to this approval, so a document altered afterwards cannot be delivered under it.",
  ],
  ifRejected:
    "No document is produced. The contract stays flagged for compliance review and the drafting step can be re-run with different inputs.",
  rule: {
    ruleId: "document.generate_owner_facing",
    name: "Generate owner facing (document)",
    threshold: "high consequence · 2 approvers · step-up re-authentication",
    risk: "high_consequence",
    humanInvolvement: "a human approves before the effect lands",
    approvalsRequired: 2,
    requiresStepUp: true,
    source: "action_registry",
    registered: true,
  },
  blastRadius: {
    ownersAffected: 1,
    moneyUsd: 28_400,
    reversal:
      "A document that has not yet been delivered can be superseded by a new version. Once it has left the platform it cannot be withdrawn.",
    jurisdictions: ["FL"],
  },
  proposal: [
    { label: "Contract", value: "CTR-2026-FL-0184423" },
    { label: "State", value: "FL" },
    { label: "Purchaser reference", value: "PUR-0184423-01" },
    { label: "Association", value: "Coral Bay Owners Association, Inc." },
    { label: "Document set", value: "Public offering statement receipt, revision 3" },
    { label: "Delivery method", value: "Certified mail with return receipt" },
    { label: "Current rescission deadline", value: "12 August 2026, 23:59 America/New_York" },
    { label: "Deadline if this is sent", value: "20 August 2026, 23:59 America/New_York" },
    { label: "Funding hold extended to", value: "21 August 2026" },
  ],
  artifact: {
    kind: "letter",
    title: "Corrected disclosure package — cover letter",
    mediaType: "text/plain",
    body: [
      "Coral Bay Owners Association, Inc.",
      "Re: Contract CTR-2026-FL-0184423",
      "",
      "Dear Purchaser,",
      "",
      "We are writing to correct the disclosure package delivered to you on 30 July 2026.",
      "That package did not include your signed receipt for the public offering statement.",
      "A complete package, including the receipt at revision 3, is enclosed.",
      "",
      "Because the corrected package is being delivered today, your right to cancel this",
      "purchase runs from the date you receive it. Your cancellation deadline is now",
      "20 August 2026 at 11:59 pm Eastern time. Nothing you have already signed shortens",
      "that period.",
      "",
      "To cancel, write to the address on the enclosed notice. You do not have to give a",
      "reason, and you will owe nothing.",
      "",
      "Owner Services",
    ].join("\n"),
    digest: "sha256:9c4f1ea77b0d38625af0c9b34e1d5a8206ff73c19ad48be05723c6d1f8904b7e",
    matchesProposalDigest: true,
  },
  evidence: [
    {
      citationId: "chk_fl_721_00412",
      source: "Florida timeshare disclosure and cancellation rules",
      version: "2026.2",
      effectiveFrom: "2026-01-01",
      jurisdiction: "FL",
      passage:
        "A purchaser may cancel a contract until midnight of the tenth calendar day after whichever is later: the date the purchaser signed the contract, or the date on which the purchaser received the last of all documents required to be provided.",
      sourceUri: "https://example.invalid/corpus/fl-timeshare/2026.2#00412",
      stale: false,
    },
    {
      citationId: "chk_fl_721_00418",
      source: "Florida timeshare disclosure and cancellation rules",
      version: "2026.2",
      effectiveFrom: "2026-01-01",
      jurisdiction: "FL",
      passage:
        "Where a required document is delivered after execution, the cancellation period runs from delivery of that document and any earlier expiry is of no effect.",
      sourceUri: "https://example.invalid/corpus/fl-timeshare/2026.2#00418",
      stale: false,
    },
    {
      citationId: "chk_int_disc_00087",
      source: "Internal disclosure package standard",
      version: "2024.3",
      effectiveFrom: "2024-06-01",
      effectiveTo: "2026-06-01",
      passage:
        "A disclosure package is complete only when the purchaser's signed receipt for the public offering statement is included at the current revision.",
      stale: true,
    },
  ],
  priorDecisions: [
    {
      approvalId: "apr_01k3jd8x02",
      ask: "Produce a document an owner will receive — CTR-2026-FL-0179886",
      decidedBy: complianceReviewer,
      decision: "granted",
      decidedAt: "2026-07-31T14:22:05.000Z",
      outcome: "completed",
      outcomeDetail: "The corrected package was delivered and the deadline moved as calculated.",
      runId: "run_01k3jd8wzz",
    },
    {
      approvalId: "apr_01k3j1v7m5",
      ask: "Produce a document an owner will receive — CTR-2026-FL-0178402",
      decidedBy: supervisor,
      decision: "rejected",
      decidedAt: "2026-07-29T09:47:31.000Z",
      outcome: "not_carried_out",
      outcomeDetail: "Rejected — the action never happened.",
    },
    {
      approvalId: "apr_01k3hp3q88",
      ask: "Produce a document an owner will receive — CTR-2026-SC-0177015",
      decidedBy: complianceReviewer,
      decision: "granted",
      decidedAt: "2026-07-27T16:03:12.000Z",
      outcome: "failed",
      outcomeDetail: "The document renderer could not resolve the association's registered address.",
      runId: "run_01k3hp3q7a",
    },
    {
      approvalId: "apr_01k3h4d1n0",
      ask: "Produce a document an owner will receive — CTR-2026-FL-0175330",
      decidedBy: supervisor,
      decision: "granted",
      decidedAt: "2026-07-24T11:15:40.000Z",
      outcome: "completed",
      outcomeDetail: "The corrected package was delivered.",
      runId: "run_01k3h4d1mp",
    },
    {
      approvalId: "apr_01k3g8b6t2",
      ask: "Produce a document an owner will receive — CTR-2026-HI-0166204",
      decidedBy: complianceReviewer,
      decision: "granted",
      decidedAt: "2026-07-21T08:55:19.000Z",
      outcome: "awaiting_execution",
      outcomeDetail: "Granted, and not yet spent. The action has not happened yet.",
    },
  ],
  requestedBy: agentOperator,
  requestedAt: "2026-08-06T08:11:00.000Z",
  expiresAt: "2026-08-06T20:11:00.000Z",
  approvalsRequired: 2,
  approvalsGranted: 1,
  eligibleRoles: ["owner_services_supervisor", "compliance_reviewer"],
  decisions: [
    {
      actor: complianceReviewer,
      decision: "granted",
      decidedAt: "2026-08-06T08:44:19.000Z",
      note: "Rescission recompute checked against the FL rule as loaded. Note the internal package standard is past its review date.",
    },
  ],
  viewerMayDecide: true,
  requiresStepUp: true,
  runId: "run_01k3m9x2p7",
};

/**
 * The same screen with the fields this deployment cannot source.
 *
 * The honest state, and the one this repository ships in: the record keeps a
 * digest of the proposal rather than its content, and nothing links an
 * approval to the passages behind it. Every gap carries a sentence. A screen
 * tested only against the populated fixture above is a screen that renders
 * four blank cells the first time it meets a real deployment.
 */
export const approvalWithUnknowns: ApprovalDetailView = {
  ...approvalAwaitingDecision,
  approvalId: "apr_01k3n5m2b8",
  action: "contact.send_owner_message",
  actionDescription:
    "Send a message to an owner. Passes the contact gate and requires approval; a sent message cannot be unsent.",
  ask: "Send a message to an owner — CTR-2026-FL-0184423",
  summary: "Notify the purchaser that their corrected package is on its way.",
  effects: [
    "The message leaves the platform through the messaging integration and reaches the owner.",
    "The contact compliance gate is consulted first: a suppressed destination or a quiet-hours window refuses the send even after this approval.",
    "The message, its template version, and this approval are written to the operating record as one linked event.",
  ],
  ifRejected:
    "Nothing is sent. The case returns to the owner-services queue with the rejection reason attached, and the reason is captured as improvement signal.",
  rule: {
    ruleId: "contact.send_owner_message",
    name: "Send owner message (contact)",
    threshold: "high consequence · 1 approver · step-up re-authentication",
    risk: "high_consequence",
    humanInvolvement: "a human approves before the effect lands",
    approvalsRequired: 1,
    requiresStepUp: true,
    source: "action_registry",
    registered: true,
  },
  blastRadius: {
    ownersAffectedUnknown:
      "The proposal does not state how many owners it reaches, and this platform cannot count them without the contract system of record.",
    moneyUnknown:
      "No monetary amount is stated on this proposal. Money moves in MVW's billing systems, which this deployment does not read.",
    reversal:
      "A sent message cannot be recalled. The only remedy is a second, corrective message, which is itself a new approval.",
    jurisdictions: ["FL"],
  },
  artifact: undefined,
  artifactUnknown:
    "This deployment holds a digest of the proposal, not its content, so there is nothing to preview inline. The digest below is what the decision binds to.",
  evidence: [],
  evidenceUnknown:
    "No corpus is connected to this deployment's approval path, so the passages behind this proposal cannot be shown here.",
  priorDecisions: [],
  approvalsRequired: 1,
  approvalsGranted: 0,
  decisions: [],
};

/**
 * A vendor's agent asking for something, badged as such.
 *
 * The rule is unregistered on purpose: `external.issue_refund` is a tool name
 * from somebody else's product, and this platform has deliberately not
 * classified what it does. Saying so is the point — an approver seeing "issue
 * a refund" needs to know it was asked for by a bot running in the CRM, not by
 * a colleague, because it changes what they check before saying yes.
 */
export const approvalFromExternalAgent: ApprovalDetailView = {
  approvalId: "apr_01k3p8h4d6",
  action: "external.issue_refund",
  actionDescription:
    'An external agent\'s operation. "external.issue_refund" is not a registered platform action, so this platform has not classified what it does.',
  ask: 'Let sf-quotebot run "issue_refund" — MBR-4471-889-02',
  risk: "high_consequence",
  reversible: false,
  summary:
    '[external agent] sf-quotebot on Salesforce Agentforce requests "issue_refund" — quotes and adjusts owner billing enquiries raised in the CRM',
  proposalDigest: "sha256:2b6e0c9145af73d0182ce4b975a3f60821dd7ec4f0b93a5162d80fae4c317b09",
  provenance: {
    kind: "external_agent",
    label: "sf-quotebot",
    actor: externalAgentActor,
    origin: "Salesforce Agentforce",
    accountable: "Marc Webb, Owner Services Technology",
    basis:
      "The approval's subject carries the external-agent marker written by the admission chain.",
  },
  effects: [
    "sf-quotebot performs \"issue_refund\" on Salesforce Agentforce.",
    "The effect happens in that system, not in this one. This platform records that it was authorised, at what risk rating, and what it cost.",
    "What the tool actually does is the vendor's declaration, not a capability this platform has classified.",
  ],
  ifRejected:
    "The action does not happen. The request is closed as rejected and the reason is captured as improvement signal.",
  rule: {
    ruleId: "external.issue_refund",
    name: "Admission threshold for external.issue_refund",
    threshold: "high consequence · 1 approver · step-up re-authentication",
    risk: "high_consequence",
    humanInvolvement: "a human approves before the effect lands",
    approvalsRequired: 1,
    requiresStepUp: true,
    source: "external_admission",
    registered: false,
  },
  blastRadius: {
    ownersAffected: 1,
    moneyUsd: 412.5,
    reversal:
      "No reversal procedure is declared, and this action is not marked reversible. Treat it as permanent.",
    jurisdictions: [],
  },
  proposal: [
    { label: "principal", value: "external" },
    { label: "agentName", value: "sf-quotebot" },
    { label: "hostPlatform", value: "Salesforce Agentforce" },
    { label: "owner", value: "Marc Webb, Owner Services Technology" },
    { label: "department", value: "Owner Services Technology" },
    { label: "tool", value: "issue_refund" },
    { label: "membershipId", value: "MBR-4471-889-02" },
    { label: "amountUsd", value: "412.50" },
    { label: "effectiveRisk", value: "high_consequence" },
  ],
  artifactUnknown:
    "This deployment holds a digest of the proposal, not its content, so there is nothing to preview inline. The digest below is what the decision binds to.",
  evidence: [],
  evidenceUnknown:
    "This proposal cites no passages. That is worth asking about before approving anything that turns on an authority.",
  priorDecisions: [
    {
      approvalId: "apr_01k3nz2p71",
      ask: 'Let sf-quotebot run "issue_refund" — MBR-3320-771-08',
      decidedBy: supervisor,
      decision: "rejected",
      decidedAt: "2026-08-05T13:09:44.000Z",
      outcome: "not_carried_out",
      outcomeDetail: "Rejected — the action never happened.",
    },
    {
      approvalId: "apr_01k3nm7v33",
      ask: 'Let sf-quotebot run "issue_refund" — MBR-1180-204-11',
      decidedBy: supervisor,
      decision: "rejected",
      decidedAt: "2026-08-04T10:31:02.000Z",
      outcome: "not_carried_out",
      outcomeDetail: "Rejected — the action never happened.",
    },
    {
      approvalId: "apr_01k3n9r0c7",
      ask: 'Let sf-quotebot run "issue_refund" — MBR-6640-119-03',
      decidedBy: complianceReviewer,
      decision: "granted",
      decidedAt: "2026-08-03T15:52:18.000Z",
      outcome: "refused",
      outcomeDetail:
        "The platform refused the action after it was approved: the agent's spend ceiling for the period was already reached.",
      runId: "run_01k3n9r0bt",
    },
  ],
  requestedBy: externalAgentActor,
  requestedAt: "2026-08-06T10:02:00.000Z",
  expiresAt: "2026-08-06T11:02:00.000Z",
  approvalsRequired: 1,
  approvalsGranted: 0,
  eligibleRoles: ["supervisor", "compliance_reviewer"],
  decisions: [],
  viewerMayDecide: true,
  requiresStepUp: true,
};

/** A change to what the platform itself will do next. The third badge. */
export const approvalSystemChange: ApprovalDetailView = {
  approvalId: "apr_01k3pb1r90",
  action: "improvement.apply",
  actionDescription:
    "Apply an improvement proposal. Changes the platform's behaviour; there is no configuration that removes this gate.",
  ask: "Change how the platform behaves — role_rescission_window",
  risk: "high_consequence",
  reversible: true,
  summary:
    "Bind the rescission-window task to prompt template rescission-extract v9, which adds the delivery-date branch the South Carolina cases needed.",
  proposalDigest: "sha256:74c0a1d9e2b58f3607ac41bd9e05f28316cd7a4b0e93f215d8a6c07b3e15942d",
  provenance: {
    kind: "system_change",
    label: platformAdmin.actorId,
    actor: platformAdmin,
    origin: "prompt_binding:rescission.extract",
    basis:
      '"improvement.apply" is declared in the action registry as changing what the platform itself will do next.',
  },
  effects: [
    "The proposed value replaces the current head of prompt_binding:rescission.extract, and every run reading it from that moment uses the new value.",
    "A snapshot of the value being replaced is taken first, so the change can be undone in one action.",
    "The change is watched afterwards against its pre-change baseline; a regression alerts and offers the revert rather than taking it.",
  ],
  ifRejected:
    "The artifact is untouched. The proposal is closed and the rejection is recorded against the failure cluster that produced it.",
  rule: {
    ruleId: "improvement.apply",
    name: "Apply (improvement)",
    threshold: "high consequence · 1 approver · step-up re-authentication",
    risk: "high_consequence",
    humanInvolvement: "a human approves before the effect lands",
    approvalsRequired: 1,
    requiresStepUp: true,
    source: "action_registry",
    registered: true,
  },
  blastRadius: {
    ownersAffectedUnknown:
      "The proposal does not state how many owners it reaches, and this platform cannot count them without the contract system of record.",
    moneyUnknown:
      "No monetary amount is stated on this proposal. Money moves in MVW's billing systems, which this deployment does not read.",
    reversal:
      "Revert to the snapshot taken at apply time, through `improvement.revert`, which needs no second approver.",
    jurisdictions: [],
  },
  proposal: [
    { label: "artifactId", value: "prompt_binding:rescission.extract" },
    { label: "roleId", value: "role_rescission_window" },
    { label: "fromVersion", value: "8" },
    { label: "toVersion", value: "9" },
    { label: "observations", value: "37" },
  ],
  artifact: {
    kind: "configuration",
    title: "prompt_binding:rescission.extract — version 9",
    mediaType: "application/json",
    body: JSON.stringify(
      {
        artifactId: "prompt_binding:rescission.extract",
        fromVersion: 8,
        observations: 37,
        roleId: "role_rescission_window",
        toVersion: 9,
      },
      null,
      2,
    ),
    digest: "sha256:74c0a1d9e2b58f3607ac41bd9e05f28316cd7a4b0e93f215d8a6c07b3e15942d",
    matchesProposalDigest: true,
  },
  evidence: [],
  evidenceUnknown:
    "This proposal cites no passages. That is worth asking about before approving anything that turns on an authority.",
  priorDecisions: [
    {
      approvalId: "apr_01k3k2w8f4",
      ask: "Change how the platform behaves — role_owner_services_drafting",
      decidedBy: supervisor,
      decision: "granted",
      decidedAt: "2026-08-01T09:12:00.000Z",
      outcome: "completed",
      outcomeDetail: "The change applied and has held against its baseline for five days.",
      runId: "run_01k3k2w8ex",
    },
  ],
  requestedBy: platformAdmin,
  requestedAt: "2026-08-06T09:40:00.000Z",
  expiresAt: "2026-08-07T09:40:00.000Z",
  approvalsRequired: 1,
  approvalsGranted: 0,
  eligibleRoles: ["supervisor", "compliance_reviewer", "platform_admin"],
  decisions: [],
  viewerMayDecide: true,
  requiresStepUp: true,
};

/**
 * An artifact preview the platform cannot vouch for.
 *
 * `matchesProposalDigest` is false: the body re-digests to something other
 * than what the approval binds to. The console must say so loudly rather than
 * letting the preview stand in for the thing being authorised — reading one
 * letter and signing another is exactly what digest binding exists to stop.
 */
export const approvalWithUnverifiedArtifact: ApprovalDetailView = {
  ...approvalAwaitingDecision,
  approvalId: "apr_01k3pd6y15",
  artifact: {
    ...(approvalAwaitingDecision.artifact ?? {
      kind: "letter" as const,
      title: "",
      mediaType: "text/plain",
      body: "",
      digest: "",
      matchesProposalDigest: false,
    }),
    digest: "sha256:0aa1e6c88b73f52d09417ea6c3b508d21fa9764e0c8b3157dae204936f1c8b7e",
    matchesProposalDigest: false,
  },
};

export const approvalViewerMayNotDecide: ApprovalDetailView = {
  ...approvalWithUnknowns,
  approvalId: "apr_01k3n3z9w7",
  action: "contact.send_owner_message",
  ask: "Send a message to an owner — SUN-2019-AZ-0044120",
  risk: "high_consequence",
  reversible: false,
  summary:
    "A first-stage arrears notice for an owner 62 days past due on the 2026 maintenance fee at Sunridge Canyon Owners Association. The letter is generated from the approved template and carries no settlement offer.",
  proposalDigest: "sha256:1a7d0b9e5c34f8261099ab7de4c05f31872b6ad9e0c14f7358be2201d6a9c4f5",
  provenance: {
    kind: "workflow",
    label: supervisor.actorId,
    actor: supervisor,
    origin: "maintenance_fee.collection_review",
    runId: "run_01k3mc2f80",
    basis: "Raised by a workflow step on a run in the operating record.",
  },
  blastRadius: {
    ownersAffected: 1,
    moneyUsd: 1_284,
    reversal:
      "A sent message cannot be recalled. The only remedy is a second, corrective message, which is itself a new approval.",
    jurisdictions: ["AZ"],
  },
  proposal: [
    { label: "Owner reference", value: "OWN-0044120" },
    { label: "Interest", value: "SUN-2019-AZ-0044120" },
    { label: "Association", value: "Sunridge Canyon Owners Association" },
    { label: "State", value: "AZ" },
    { label: "Amount outstanding", value: "US$1,284.00" },
    { label: "Days past due", value: "62" },
    { label: "Template", value: "arrears-first-notice v4" },
    { label: "Channel", value: "First-class mail" },
  ],
  requestedBy: supervisor,
  requestedAt: "2026-08-06T09:30:00.000Z",
  expiresAt: "2026-08-07T09:30:00.000Z",
  approvalsRequired: 1,
  approvalsGranted: 0,
  eligibleRoles: ["compliance_reviewer"],
  decisions: [],
  viewerMayDecide: false,
  viewerMayNotDecideReason:
    "You requested this action, so you cannot approve it.",
  requiresStepUp: false,
  runId: "run_01k3mc2f80",
};

/**
 * The approval queue's rows.
 *
 * A queue row is a strict subset of the detail view — no evidence, no artifact
 * preview, no prior-decision lookback — because those are per-approval reads
 * and running them for every row nobody has opened would make the queue slow
 * in exact proportion to how carefully the detail screen was built.
 */
export const approvalQueue: readonly ApprovalView[] = [
  approvalAwaitingDecision,
  approvalFromExternalAgent,
  approvalSystemChange,
  approvalViewerMayNotDecide,
];

/**
 * A run the platform refused partway through.
 *
 * The refusal is the interesting part: the model step that would have ranked
 * borrowers by recovery likelihood was denied, and nothing followed. Note that
 * the denied step is not `correctable` — a refusal produced nothing to
 * disagree with, and a "correction" filed against one would be a complaint
 * about the refusal, which belongs on the refusal.
 */
export const runWithRefusedStep: RunDetailView = {
  runId: "run_01k3m6h1c5",
  kind: "loan_file.evidence_pack",
  title: "Delinquency evidence pack — loan LN-2024-NV-0930881",
  status: "denied",
  mode: "supervised",
  requestedBy: agentOperator,
  createdAt: "2026-08-02T09:15:44.000Z",
  startedAt: "2026-08-02T09:15:45.000Z",
  endedAt: "2026-08-02T09:16:02.000Z",
  elapsedMs: 17_000,
  denialReason:
    "The platform refused to rank or sequence borrowers. It will assemble the evidence and a person decides the treatment.",
  steps: [
    {
      stepId: "stp_01k3m6h1c5_1",
      seq: 1,
      name: "Load loan file",
      kind: "integration_call",
      type: "action",
      status: "succeeded",
      startedAt: "2026-08-02T09:15:45.000Z",
      endedAt: "2026-08-02T09:15:47.400Z",
      durationMs: 2400,
      costUsd: 0,
      attempt: 1,
      inputDigest: "sha256:44b1c07e9f2a5d8360cb14e7a09f5b2d3c81746ee0af9b25d3708c1a6e5f2093",
      outputDigest: "sha256:c0d9a3b7e14f8256bb037ae9152d4c6f8a91e0374bd25c68f1a94e307db6512c",
      detail: { loanId: "LN-2024-NV-0930881", state: "NV", daysPastDue: 121 },
      citations: [],
      correctable: false,
    },
    {
      stepId: "stp_01k3m6h1c5_2",
      seq: 2,
      name: "Extract contract and policy terms",
      kind: "retrieval",
      type: "retrieval",
      status: "succeeded",
      startedAt: "2026-08-02T09:15:47.400Z",
      endedAt: "2026-08-02T09:15:52.900Z",
      durationMs: 5500,
      costUsd: 0.0184,
      attempt: 2,
      inputDigest: "sha256:7e2f9c04a1b83d5f60cc21e4738a95b0df6172c8e93a04bd5271fc860a3e4197",
      outputDigest: "sha256:b31e7d0c9a5426f8017cb2e94d80af35162e7c9b04daf1836e25c07a9b41d5e6",
      detail: { corpus: "nv-consumer-finance", passages: 6 },
      provenance: {
        retrieved: [
          {
            chunkId: "chk_nv_cf_00412",
            documentTitle: "Nevada consumer finance servicing policy",
            documentVersion: "2025.4",
            effectiveFrom: "2025-10-01T00:00:00.000Z",
            jurisdiction: "NV",
            excerpt:
              "A servicer shall provide written notice of default not less than thirty days before commencing any remedy affecting the borrower's interest.",
            sourceUri: "https://example.invalid/corpus/nv-consumer-finance/2025.4#00412",
            stale: false,
          },
          {
            chunkId: "chk_int_col_00097",
            documentTitle: "Internal collections treatment matrix",
            documentVersion: "2024.1",
            effectiveFrom: "2024-02-15T00:00:00.000Z",
            effectiveTo: "2026-02-15T00:00:00.000Z",
            excerpt:
              "Accounts between 90 and 150 days past due are referred for manual review before any treatment is selected.",
            stale: true,
          },
        ],
        asserted: [],
        computed: [],
        recorded: true,
        basis: "Recorded by the step itself.",
      },
      citations: [
        {
          chunkId: "chk_nv_cf_00412",
          documentTitle: "Nevada consumer finance servicing policy",
          documentVersion: "2025.4",
          effectiveFrom: "2025-10-01T00:00:00.000Z",
          jurisdiction: "NV",
          excerpt:
            "A servicer shall provide written notice of default not less than thirty days before commencing any remedy affecting the borrower's interest.",
          sourceUri: "https://example.invalid/corpus/nv-consumer-finance/2025.4#00412",
          stale: false,
        },
        {
          chunkId: "chk_int_col_00097",
          documentTitle: "Internal collections treatment matrix",
          documentVersion: "2024.1",
          effectiveFrom: "2024-02-15T00:00:00.000Z",
          effectiveTo: "2026-02-15T00:00:00.000Z",
          excerpt:
            "Accounts between 90 and 150 days past due are referred for manual review before any treatment is selected.",
          stale: true,
        },
      ],
      correctable: true,
    },
    {
      stepId: "stp_01k3m6h1c5_3",
      seq: 3,
      name: "Rank borrowers by recovery likelihood",
      kind: "model_call",
      type: "model",
      status: "denied",
      startedAt: "2026-08-02T09:15:52.900Z",
      endedAt: "2026-08-02T09:16:02.000Z",
      durationMs: 9100,
      costUsd: 0,
      attempt: 1,
      inputDigest: "sha256:2d8b4f16c0e7a935bb51d8c204ef7361a09b5e2748cdf0136ba97e4c5d208f71",
      denialReason:
        "Ranking or sequencing consumers is not a registered action for this role. Where an outcome could be adverse to a consumer, the person decides and the platform gathers the evidence.",
      detail: { reasonCode: "authorization.action_not_permitted", riskTier: "prohibited" },
      failure: {
        what: "Ranking or sequencing consumers is not a registered action for this role. Where an outcome could be adverse to a consumer, the person decides and the platform gathers the evidence.",
        attempt: 1,
        followedBy: "Nothing followed. The run stopped here.",
      },
      citations: [],
      correctable: false,
    },
  ],
  totalCostUsd: 0.0184,
  costByCategory: { model: 0.0, integration: 0.0184 },
  workflowInstanceId: "wfi_01k3m6h1bz",
  roleId: "role_consumer_finance_evidence",
  roleVersion: 3,
  citations: [
    {
      chunkId: "chk_nv_cf_00412",
      documentTitle: "Nevada consumer finance servicing policy",
      documentVersion: "2025.4",
      effectiveFrom: "2025-10-01T00:00:00.000Z",
      jurisdiction: "NV",
      excerpt:
        "A servicer shall provide written notice of default not less than thirty days before commencing any remedy affecting the borrower's interest.",
      sourceUri: "https://example.invalid/corpus/nv-consumer-finance/2025.4#00412",
      stale: false,
    },
    {
      chunkId: "chk_int_col_00097",
      documentTitle: "Internal collections treatment matrix",
      documentVersion: "2024.1",
      effectiveFrom: "2024-02-15T00:00:00.000Z",
      effectiveTo: "2026-02-15T00:00:00.000Z",
      excerpt:
        "Accounts between 90 and 150 days past due are referred for manual review before any treatment is selected.",
      stale: true,
    },
  ],
};

/**
 * The rescission run the approval screen's hero case came from.
 *
 * Every step type the timeline draws appears once — retrieval, model, action,
 * human, wait — and the model step carries all three kinds of provenance, so a
 * screen rendering this has to have solved the distinction rather than the
 * happy path of one of them.
 */
export const runWithFullProvenance: RunDetailView = {
  runId: "run_01k3m9x2p7",
  kind: "rescission.package_check",
  title: "Rescission package check — contract CTR-2026-FL-0184423",
  status: "awaiting_approval",
  mode: "supervised",
  requestedBy: agentOperator,
  createdAt: "2026-08-04T13:02:11.000Z",
  startedAt: "2026-08-04T13:02:12.000Z",
  elapsedMs: undefined,
  outcome: undefined,
  steps: [
    {
      stepId: "stp_01k3m9x2p7_1",
      seq: 1,
      name: "Retrieve the delivered disclosure package",
      kind: "retrieval",
      type: "retrieval",
      status: "succeeded",
      startedAt: "2026-08-04T13:02:12.000Z",
      endedAt: "2026-08-04T13:02:12.120Z",
      durationMs: 120,
      costUsd: 0,
      attempt: 1,
      outputDigest: "sha256:1d9f47c0b5e83a26107cd4e9b7f025a8361ce07d4b29fa5168e30c7a9d4b6152",
      detail: { corpus: "fl-timeshare", passages: 3, cited: 2 },
      provenance: {
        retrieved: [
          {
            chunkId: "chk_fl_721_00412",
            documentTitle: "Florida timeshare disclosure and cancellation rules",
            documentVersion: "2026.2",
            effectiveFrom: "2026-01-01T00:00:00.000Z",
            jurisdiction: "FL",
            excerpt:
              "A purchaser may cancel a contract until midnight of the tenth calendar day after whichever is later: the date the purchaser signed the contract, or the date on which the purchaser received the last of all documents required to be provided.",
            sourceUri: "https://example.invalid/corpus/fl-timeshare/2026.2#00412",
            stale: false,
          },
          {
            chunkId: "chk_fl_721_00418",
            documentTitle: "Florida timeshare disclosure and cancellation rules",
            documentVersion: "2026.2",
            effectiveFrom: "2026-01-01T00:00:00.000Z",
            jurisdiction: "FL",
            excerpt:
              "Where a required document is delivered after execution, the cancellation period runs from delivery of that document and any earlier expiry is of no effect.",
            sourceUri: "https://example.invalid/corpus/fl-timeshare/2026.2#00418",
            stale: false,
          },
        ],
        asserted: [],
        computed: [],
        recorded: true,
        basis: "Recorded by the step itself.",
      },
      citations: [],
      correctable: true,
    },
    {
      stepId: "stp_01k3m9x2p7_2",
      seq: 2,
      name: "Determine the rescission window",
      kind: "model_call",
      type: "model",
      status: "succeeded",
      startedAt: "2026-08-04T13:02:12.120Z",
      endedAt: "2026-08-04T13:02:13.540Z",
      durationMs: 1420,
      costUsd: 0.0113,
      attempt: 1,
      inputDigest: "sha256:5c81b0e7a4f92d3618ac07be5d4f193268ba0ce7f3d91a4562c80eb17a4d9036",
      outputDigest: "sha256:e7104ab35c9f8d2601bc7ae4d905f3128a6bd0e94f27c135ba806e2d5c91437f",
      detail: { promptVersion: "rescission-extract-v8", groundedPassages: 2 },
      provenance: {
        retrieved: [
          {
            chunkId: "chk_fl_721_00418",
            documentTitle: "Florida timeshare disclosure and cancellation rules",
            documentVersion: "2026.2",
            effectiveFrom: "2026-01-01T00:00:00.000Z",
            jurisdiction: "FL",
            excerpt:
              "Where a required document is delivered after execution, the cancellation period runs from delivery of that document and any earlier expiry is of no effect.",
            sourceUri: "https://example.invalid/corpus/fl-timeshare/2026.2#00418",
            stale: false,
          },
        ],
        asserted: [
          {
            text: "The purchaser has not taken occupancy, so no waiver of the cancellation period applies.",
            outputDigest:
              "sha256:e7104ab35c9f8d2601bc7ae4d905f3128a6bd0e94f27c135ba806e2d5c91437f",
          },
        ],
        computed: [
          {
            label: "rescissionDeadline",
            value: "2026-08-20T23:59:00-04:00",
            derivation:
              "Ten calendar days from delivery of the last required document (10 August 2026), inclusive of the delivery date, expiring at midnight America/New_York.",
          },
        ],
        recorded: true,
        basis: "Recorded by the step itself.",
      },
      citations: [
        {
          chunkId: "chk_fl_721_00418",
          documentTitle: "Florida timeshare disclosure and cancellation rules",
          documentVersion: "2026.2",
          effectiveFrom: "2026-01-01T00:00:00.000Z",
          jurisdiction: "FL",
          excerpt:
            "Where a required document is delivered after execution, the cancellation period runs from delivery of that document and any earlier expiry is of no effect.",
          sourceUri: "https://example.invalid/corpus/fl-timeshare/2026.2#00418",
          stale: false,
        },
      ],
      correctable: true,
    },
    {
      stepId: "stp_01k3m9x2p7_3",
      seq: 3,
      name: "Render the corrected disclosure package",
      kind: "document_generation",
      type: "action",
      status: "succeeded",
      startedAt: "2026-08-04T13:02:13.540Z",
      endedAt: "2026-08-04T13:02:14.980Z",
      durationMs: 1440,
      costUsd: 0.0009,
      attempt: 1,
      outputDigest: "sha256:9c4f1ea77b0d38625af0c9b34e1d5a8206ff73c19ad48be05723c6d1f8904b7e",
      detail: { template: "corrected-disclosure-cover", revision: 3 },
      citations: [],
      correctable: false,
    },
    {
      stepId: "stp_01k3m9x2p7_4",
      seq: 4,
      name: "Verify the public offering statement receipt",
      kind: "human_task",
      type: "human",
      status: "succeeded",
      startedAt: "2026-08-04T13:02:15.000Z",
      endedAt: "2026-08-04T13:22:41.000Z",
      durationMs: 1_226_000,
      costUsd: 0,
      attempt: 1,
      detail: { actorId: "act_2c88de40" },
      human: { actor: complianceReviewer, tookMs: 1_226_000 },
      citations: [],
      correctable: false,
    },
    {
      stepId: "stp_01k3m9x2p7_5",
      seq: 5,
      name: "Await approval to produce the owner-facing document",
      kind: "approval_gate",
      type: "wait",
      status: "waiting",
      startedAt: "2026-08-04T13:22:41.000Z",
      costUsd: 0,
      attempt: 1,
      detail: { approvalId: "apr_01k3n2f6r4", approvalsRequired: 2, approvalsGranted: 1 },
      citations: [],
      correctable: false,
    },
  ],
  totalCostUsd: 0.0122,
  costByCategory: { model: 0.0113, compute: 0.0009 },
  workflowInstanceId: "wfi_01k3m9x2p6",
  roleId: "role_rescission_window",
  roleVersion: 8,
  citations: [
    {
      chunkId: "chk_fl_721_00412",
      documentTitle: "Florida timeshare disclosure and cancellation rules",
      documentVersion: "2026.2",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      jurisdiction: "FL",
      excerpt:
        "A purchaser may cancel a contract until midnight of the tenth calendar day after whichever is later: the date the purchaser signed the contract, or the date on which the purchaser received the last of all documents required to be provided.",
      sourceUri: "https://example.invalid/corpus/fl-timeshare/2026.2#00412",
      stale: false,
    },
    {
      chunkId: "chk_fl_721_00418",
      documentTitle: "Florida timeshare disclosure and cancellation rules",
      documentVersion: "2026.2",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      jurisdiction: "FL",
      excerpt:
        "Where a required document is delivered after execution, the cancellation period runs from delivery of that document and any earlier expiry is of no effect.",
      sourceUri: "https://example.invalid/corpus/fl-timeshare/2026.2#00418",
      stale: false,
    },
  ],
};

/**
 * A run whose steps never declared their own provenance.
 *
 * The state this repository ships in, and the one the screen must render
 * without misleading anybody. The model step's provenance is `recorded: false`
 * and its single asserted line says the output is unsourced — which is the
 * honest reading, and considerably more useful than an empty block that would
 * read as "nothing was claimed".
 */
export const runWithDerivedProvenance: RunDetailView = {
  runId: "run_01k3m7r6v2",
  kind: "owner_services.response_draft",
  title: "Owner enquiry draft — points reinstatement, membership MBR-4471-889-02",
  status: "succeeded",
  mode: "assisted",
  requestedBy: agentOperator,
  createdAt: "2026-08-05T11:05:30.000Z",
  startedAt: "2026-08-05T11:05:31.000Z",
  endedAt: "2026-08-05T11:05:39.200Z",
  elapsedMs: 8200,
  outcome: "A draft reply was produced and placed in the agent's queue for editing and sending.",
  steps: [
    {
      stepId: "stp_01k3m7r6v2_1",
      seq: 1,
      name: "Screen inbound message",
      kind: "automated_action",
      type: "action",
      status: "succeeded",
      startedAt: "2026-08-05T11:05:31.000Z",
      endedAt: "2026-08-05T11:05:31.180Z",
      durationMs: 180,
      costUsd: 0,
      attempt: 1,
      outputDigest: "sha256:e1a5c93d7b0248f6013ca9e57d2b46081f37c0ae95d2b6431e08fa7c5d90b2e4",
      detail: { verdict: "clean" },
      citations: [],
      correctable: false,
    },
    {
      stepId: "stp_01k3m7r6v2_2",
      seq: 2,
      name: "Draft reply",
      kind: "model_call",
      type: "model",
      status: "succeeded",
      startedAt: "2026-08-05T11:05:31.180Z",
      endedAt: "2026-08-05T11:05:39.200Z",
      durationMs: 8020,
      costUsd: 0.0912,
      attempt: 1,
      inputDigest: "sha256:3f7a1b0dc95e2846b0a1cd47f39b2e5081c6ad74e920f3b856d1470ac2e98b3d",
      outputDigest: "sha256:8b0e2c4a7d19f5360ca8b1e73d024f95617ae8c30b2d94f157ea6031cb8d472f",
      detail: { promptVersion: "owner-reply-v7", groundedPassages: 3 },
      provenance: {
        retrieved: [],
        asserted: [
          {
            text: "This model step recorded 3 grounded passage(s) but no citation ids, so its statements cannot be checked against a source from here.",
            outputDigest:
              "sha256:8b0e2c4a7d19f5360ca8b1e73d024f95617ae8c30b2d94f157ea6031cb8d472f",
          },
        ],
        computed: [],
        recorded: false,
        basis:
          "Derived from the step's kind and the detail it recorded. The step did not declare its own provenance, so this is inference about the step rather than the step's own account of itself.",
      },
      citations: [],
      correctable: true,
    },
  ],
  totalCostUsd: 0.0912,
  costByCategory: { model: 0.0912 },
  roleId: "role_owner_services_drafting",
  roleVersion: 11,
  citations: [],
};

/** A run whose first attempt failed and was retried. */
export const runWithRetriedStep: RunDetailView = {
  runId: "run_01k3m4a7n3",
  kind: "rescission.package_check",
  title: "Rescission package check — contract CTR-2026-HI-0166204",
  status: "failed",
  mode: "supervised",
  requestedBy: agentOperator,
  createdAt: "2026-08-01T22:48:03.000Z",
  startedAt: "2026-08-01T22:48:04.000Z",
  endedAt: "2026-08-01T22:49:41.000Z",
  elapsedMs: 97_000,
  outcome: "The contract records system did not answer on any of three attempts.",
  steps: [
    {
      stepId: "stp_01k3m4a7n3_1",
      seq: 1,
      name: "Load contract",
      kind: "integration_call",
      type: "action",
      status: "failed",
      startedAt: "2026-08-01T22:48:04.000Z",
      endedAt: "2026-08-01T22:48:34.000Z",
      durationMs: 30_000,
      costUsd: 0,
      attempt: 1,
      error: "The contract records system did not answer within 30 seconds.",
      detail: { integration: "contract-records", timeoutMs: 30_000 },
      failure: {
        what: "The contract records system did not answer within 30 seconds.",
        attempt: 1,
        followedBy: "Retried as attempt 2.",
        followedByStepId: "stp_01k3m4a7n3_2",
      },
      citations: [],
      correctable: false,
    },
    {
      stepId: "stp_01k3m4a7n3_2",
      seq: 2,
      name: "Load contract",
      kind: "integration_call",
      type: "action",
      status: "failed",
      startedAt: "2026-08-01T22:48:34.000Z",
      endedAt: "2026-08-01T22:49:04.000Z",
      durationMs: 30_000,
      costUsd: 0,
      attempt: 2,
      error: "The contract records system did not answer within 30 seconds.",
      detail: { integration: "contract-records", timeoutMs: 30_000 },
      failure: {
        what: "The contract records system did not answer within 30 seconds.",
        attempt: 2,
        followedBy: 'Escalated to a person: "Load the contract by hand".',
        followedByStepId: "stp_01k3m4a7n3_3",
      },
      citations: [],
      correctable: false,
    },
    {
      stepId: "stp_01k3m4a7n3_3",
      seq: 3,
      name: "Load the contract by hand",
      kind: "human_task",
      type: "human",
      status: "waiting",
      startedAt: "2026-08-01T22:49:04.000Z",
      costUsd: 0,
      attempt: 1,
      detail: {},
      human: {
        actorUnknown:
          "This step did not record who did it. A human task whose owner is unknown cannot be chased.",
      },
      citations: [],
      correctable: false,
    },
  ],
  totalCostUsd: 0,
  costByCategory: {},
  roleId: "role_rescission_window",
  roleVersion: 8,
  citations: [],
};

/** Kept under its original name for tests that predate the timeline work. */
export const runSucceeded: RunDetailView = runWithDerivedProvenance;

export const emptyRun: RunDetailView = {
  runId: "run_01k3m5d0b8",
  kind: "association.budget_variance",
  title: "Budget variance narrative — Palmetto Dunes Vacation Owners Association, Inc.",
  status: "pending",
  mode: "shadow",
  requestedBy: supervisor,
  createdAt: "2026-08-06T06:00:00.000Z",
  steps: [],
  totalCostUsd: 0,
  costByCategory: {},
  citations: [],
};

/** A correction accepted, and the sentence saying it changes nothing. */
export const correctionRecorded: CorrectionView = {
  observationId: "obs_01k3pf9m28",
  recorded: true,
  signature: "deadline.wrong_jurisdiction",
  recordedAt: "2026-08-06T11:04:22.000Z",
  effect:
    "Recorded against this run as improvement signal. It changes nothing on its own: a change to how the platform behaves needs a proposal, a measured evaluation, and a human approval.",
};

/** The same correction submitted twice. Frequency must not be inflated. */
export const correctionDeduplicated: CorrectionView = {
  ...correctionRecorded,
  recorded: false,
  effect:
    "An identical correction was already recorded, so this one was not counted twice. Frequency decides which failure gets attention, and a retry must not inflate it.",
};

export const spendCeilingDenial: DenialView = {
  denied: true,
  reason: "ceiling.spend_exceeded",
  message:
    "This run would have taken the workflow past its configured spend ceiling for the day, so the platform stopped before the next step rather than after it.",
  detail: {
    workflow: "rescission.package_check",
    ceilingUsd: 25,
    spentUsd: 24.86,
    estimatedNextStepUsd: 0.42,
  },
};

export const selfApprovalDenial: DenialView = {
  denied: true,
  reason: "approval.self_approval",
  message: "You raised this proposal, so you may not approve it.",
  detail: { approvalId: "apr_01k3n3z9w7", actorId: "act_7f3a91c2" },
};

// ---------------------------------------------------------------------------
// Workflow instances
// ---------------------------------------------------------------------------

export const workflowInstanceStuck: WorkflowInstanceView = {
  instanceId: "wfi_01k3m9x2p5",
  definitionName: "Rescission package assurance",
  definitionVersion: 4,
  status: "awaiting_approval",
  startedAt: "2026-08-04T13:02:11.000Z",
  plainLanguageStatus:
    "This contract's corrected disclosure package is ready to send, and it is waiting for a supervisor to approve it. Nothing will be sent until someone approves. The purchaser's cancellation deadline is unchanged while it waits.",
  currentStepName: "Supervisor approval",
  waitingOn: "A supervisor to approve sending the corrected disclosure package.",
  totalCostUsd: 0.4821,
  steps: [
    {
      name: "Read the contract package",
      kind: "integration.read",
      status: "succeeded",
      startedAt: "2026-08-04T13:02:11.000Z",
      endedAt: "2026-08-04T13:02:14.100Z",
      slaBreached: false,
    },
    {
      name: "Work out the cancellation deadline",
      kind: "timeline.compute",
      status: "succeeded",
      startedAt: "2026-08-04T13:02:14.100Z",
      endedAt: "2026-08-04T13:02:14.640Z",
      slaBreached: false,
    },
    {
      name: "Check the package against the Florida rule",
      kind: "knowledge.retrieve",
      status: "succeeded",
      startedAt: "2026-08-04T13:02:14.640Z",
      endedAt: "2026-08-04T13:02:21.900Z",
      slaBreached: false,
    },
    {
      name: "Draft the corrected disclosure package",
      kind: "document.generate",
      status: "succeeded",
      startedAt: "2026-08-04T13:02:21.900Z",
      endedAt: "2026-08-04T13:02:44.300Z",
      slaBreached: false,
    },
    {
      name: "Supervisor approval",
      kind: "approval.request",
      status: "running",
      startedAt: "2026-08-04T13:02:44.300Z",
      dueAt: "2026-08-05T13:02:44.300Z",
      slaBreached: true,
    },
    {
      name: "Send the package by certified mail",
      kind: "contact.send",
      status: "pending",
      slaBreached: false,
    },
    {
      name: "Record the new deadline on the contract",
      kind: "integration.write",
      status: "pending",
      slaBreached: false,
    },
  ],
};

export const workflowInstanceFinished: WorkflowInstanceView = {
  instanceId: "wfi_01k3m8w4t7",
  definitionName: "Association board pack assembly",
  definitionVersion: 2,
  status: "succeeded",
  startedAt: "2026-08-03T16:20:00.000Z",
  endedAt: "2026-08-03T16:41:12.000Z",
  plainLanguageStatus:
    "The Q3 board pack for Coral Bay Owners Association, Inc. was assembled and handed to the association manager for review. Nothing is outstanding.",
  totalCostUsd: 2.1408,
  steps: [
    {
      name: "Collect the association budget and reserve study",
      kind: "integration.read",
      status: "succeeded",
      startedAt: "2026-08-03T16:20:00.000Z",
      endedAt: "2026-08-03T16:22:39.000Z",
      slaBreached: false,
    },
    {
      name: "Write the budget variance narrative",
      kind: "model.infer",
      status: "succeeded",
      startedAt: "2026-08-03T16:22:39.000Z",
      endedAt: "2026-08-03T16:33:04.000Z",
      slaBreached: false,
    },
    {
      name: "Assemble the board pack",
      kind: "document.generate",
      status: "succeeded",
      startedAt: "2026-08-03T16:33:04.000Z",
      endedAt: "2026-08-03T16:41:12.000Z",
      slaBreached: false,
    },
  ],
};

// ---------------------------------------------------------------------------
// Agent roles
// ---------------------------------------------------------------------------

const rescissionEvaluation = {
  evaluationId: "evl_01k3p4a2c9",
  ranAt: "2026-08-05T02:10:00.000Z",
  goldenSetName: "Rescission package assurance — curated set 2026.3",
  caseCount: 240,
  passed: 231,
  accuracy: 0.9625,
  threshold: 0.95,
  meetsThreshold: true,
  modelId: "inventory/reasoning-standard",
  promptVersion: "rescission-check-v9",
} as const;

export const roles: readonly RoleView[] = [
  {
    roleId: "role_rescission_assurance",
    name: "Rescission package assurance",
    purpose:
      "Checks that a contract package contains every document the purchaser's state requires, and that the cancellation deadline on file matches the deadline the statute produces.",
    version: 9,
    status: "promoted",
    riskCeiling: "high_consequence",
    humanInvolvement: "A supervisor approves anything that changes a purchaser's deadline.",
    modelTask: "document_check",
    allowedActions: [
      "timeline.compute_deadline",
      "documents.check_package",
      "documents.draft_corrected_package",
      "approvals.request",
    ],
    dataScopes: ["contracts.metadata", "corpus.state_rescission_rules"],
    updatedAt: "2026-08-05T02:41:00.000Z",
    updatedBy: complianceReviewer,
    latestEvaluation: rescissionEvaluation,
    disabled: false,
  },
  {
    roleId: "role_association_reporting",
    name: "Association board reporting",
    purpose:
      "Assembles association board packs and budget variance narratives from the association's own budget, reserve study, and prior-period statements.",
    version: 4,
    status: "promoted",
    riskCeiling: "routine",
    humanInvolvement: "The association manager reviews every pack before it reaches a board.",
    modelTask: "document_drafting",
    allowedActions: ["documents.assemble_board_pack", "documents.draft_variance_narrative"],
    dataScopes: ["associations.financials", "associations.reserve_studies"],
    updatedAt: "2026-07-28T14:03:00.000Z",
    updatedBy: supervisor,
    latestEvaluation: {
      evaluationId: "evl_01k3p1b7d2",
      ranAt: "2026-07-28T13:20:00.000Z",
      goldenSetName: "Board pack assembly — curated set 2026.2",
      caseCount: 96,
      passed: 92,
      accuracy: 0.9583,
      threshold: 0.9,
      meetsThreshold: true,
      modelId: "inventory/drafting-standard",
      promptVersion: "board-pack-v6",
    },
    disabled: false,
  },
  {
    roleId: "role_owner_services_drafting",
    name: "Owner services reply drafting",
    purpose:
      "Drafts replies to owner enquiries from the governed knowledge corpus. An agent edits and sends; the platform never sends.",
    version: 11,
    status: "promoted",
    riskCeiling: "sensitive",
    humanInvolvement: "An owner services agent edits and sends every reply.",
    modelTask: "reply_drafting",
    allowedActions: ["knowledge.answer", "documents.draft_reply"],
    dataScopes: ["owners.enquiries", "corpus.owner_policies"],
    updatedAt: "2026-08-01T09:12:00.000Z",
    updatedBy: supervisor,
    latestEvaluation: {
      evaluationId: "evl_01k3p2c4e8",
      ranAt: "2026-08-01T08:40:00.000Z",
      goldenSetName: "Owner reply drafting — curated set 2026.4",
      caseCount: 180,
      passed: 154,
      accuracy: 0.8556,
      threshold: 0.9,
      meetsThreshold: false,
      modelId: "inventory/drafting-standard",
      promptVersion: "owner-reply-v7",
    },
    disabled: false,
  },
  {
    roleId: "role_consumer_finance_evidence",
    name: "Loan file evidence assembly",
    purpose:
      "Assembles a delinquency evidence pack — the loan file, the contract terms that apply, and the contact history — so that a person can choose the treatment.",
    version: 3,
    status: "disabled",
    riskCeiling: "sensitive",
    humanInvolvement:
      "A consumer finance analyst selects every treatment. The platform never ranks or sequences borrowers.",
    modelTask: "evidence_assembly",
    allowedActions: ["documents.assemble_evidence_pack", "knowledge.answer"],
    dataScopes: ["loans.files", "corpus.state_consumer_finance"],
    updatedAt: "2026-08-02T09:22:00.000Z",
    updatedBy: complianceReviewer,
    latestEvaluation: {
      evaluationId: "evl_01k3p0z1a4",
      ranAt: "2026-07-30T21:05:00.000Z",
      goldenSetName: "Loan evidence assembly — curated set 2026.1",
      caseCount: 64,
      passed: 61,
      accuracy: 0.9531,
      threshold: 0.95,
      meetsThreshold: true,
      modelId: "inventory/reasoning-standard",
      promptVersion: "loan-evidence-v3",
    },
    disabled: true,
  },
];

/** Every version of the rescission role, newest first. */
export const rescissionRoleVersions: readonly RoleView[] = [
  roles[0] as RoleView,
  {
    ...(roles[0] as RoleView),
    version: 8,
    status: "reverted",
    updatedAt: "2026-07-19T16:48:00.000Z",
    updatedBy: complianceReviewer,
    latestEvaluation: {
      evaluationId: "evl_01k3n8f2b1",
      ranAt: "2026-07-19T16:02:00.000Z",
      goldenSetName: "Rescission package assurance — curated set 2026.3",
      caseCount: 240,
      passed: 219,
      accuracy: 0.9125,
      threshold: 0.95,
      meetsThreshold: false,
      modelId: "inventory/reasoning-fast",
      promptVersion: "rescission-check-v8",
    },
  },
  {
    ...(roles[0] as RoleView),
    version: 7,
    status: "promoted",
    updatedAt: "2026-06-30T11:15:00.000Z",
    updatedBy: supervisor,
    latestEvaluation: {
      evaluationId: "evl_01k3k2d9c6",
      ranAt: "2026-06-30T10:40:00.000Z",
      goldenSetName: "Rescission package assurance — curated set 2026.2",
      caseCount: 210,
      passed: 201,
      accuracy: 0.9571,
      threshold: 0.95,
      meetsThreshold: true,
      modelId: "inventory/reasoning-standard",
      promptVersion: "rescission-check-v7",
    },
  },
];

export const disabledRoleVersions: readonly RoleView[] = [roles[3] as RoleView];

// ---------------------------------------------------------------------------
// The improvement loop
// ---------------------------------------------------------------------------

export const improvementClusters: readonly ImprovementClusterView[] = [
  {
    clusterId: "clu_01k3q7a1f2",
    summary:
      "South Carolina contracts are re-checked a second time because the first check runs before the statutory rules corpus has finished loading.",
    roleId: "role_rescission_assurance",
    occurrences: 412,
    ratePercent: 18.4,
    estimatedCostUsd: 186.42,
    exampleRunIds: ["run_01k3m9y8q1", "run_01k3m4a7n3", "run_01k3m9x2p7"],
  },
  {
    clusterId: "clu_01k3q7b5g8",
    summary:
      "Owner replies about points reinstatement are edited heavily before sending, most often to add the once-per-membership-year limit the policy states.",
    roleId: "role_owner_services_drafting",
    occurrences: 267,
    ratePercent: 31.2,
    estimatedCostUsd: 94.03,
    exampleRunIds: ["run_01k3m7r6v2"],
  },
  {
    clusterId: "clu_01k3q7c9h4",
    summary:
      "Board pack assembly stalls when an association's reserve study is older than the fiscal year being reported and no replacement has been supplied.",
    roleId: "role_association_reporting",
    occurrences: 58,
    ratePercent: 6.1,
    estimatedCostUsd: 121.77,
    exampleRunIds: ["run_01k3m8w4t9"],
  },
];

export const improvementProposal: ImprovementProposalView = {
  proposalId: "imp_01k3r2m8k5",
  kind: "prompt_revision",
  title: "Wait for the state rules corpus before checking a package",
  rationale:
    "412 South Carolina checks in the last thirty days ran before the state rules corpus finished loading, produced no grounded answer, and were re-run. Requiring the corpus to be in effect for the contract's state before the check begins removes the re-run and the wasted spend.",
  artifactKind: "prompt",
  artifactRef: "rescission-check/system",
  before:
    "Check the contract package against the rescission rule for the purchaser's state. If no rule is available, note that and continue.",
  after:
    "Check the contract package against the rescission rule for the purchaser's state, effective on the contract execution date. If no rule is in effect for that state and date, stop and refuse: do not continue without one.",
  evaluationBefore: {
    evaluationId: "evl_01k3p4a2c9",
    ranAt: "2026-08-05T02:10:00.000Z",
    goldenSetName: "Rescission package assurance — curated set 2026.3",
    caseCount: 240,
    passed: 231,
    accuracy: 0.9625,
    threshold: 0.95,
    meetsThreshold: true,
    modelId: "inventory/reasoning-standard",
    promptVersion: "rescission-check-v9",
  },
  evaluationAfter: {
    evaluationId: "evl_01k3r3n1p7",
    ranAt: "2026-08-06T04:22:00.000Z",
    goldenSetName: "Rescission package assurance — curated set 2026.3",
    caseCount: 240,
    passed: 238,
    accuracy: 0.9917,
    threshold: 0.95,
    meetsThreshold: true,
    modelId: "inventory/reasoning-standard",
    promptVersion: "rescission-check-v10",
  },
  evaluationDelta: 2.92,
  blastRadius: {
    roles: ["role_rescission_assurance"],
    workflows: ["Rescission package assurance"],
    runsInLastThirtyDays: 2238,
  },
  observationCount: 412,
  createdAt: "2026-08-06T04:25:00.000Z",
  status: "awaiting_approval",
};

export const improvementProposalRegression: ImprovementProposalView = {
  ...improvementProposal,
  proposalId: "imp_01k3r4p2q9",
  title: "Shorten the owner reply preamble",
  rationale:
    "Agents delete the opening paragraph from most drafts. Removing it from the prompt saves an edit on every reply.",
  artifactRef: "owner-reply/system",
  before:
    "Open with a short acknowledgement of the owner's enquiry, then answer it from the cited policy.",
  after: "Answer the owner's enquiry from the cited policy.",
  evaluationBefore: {
    evaluationId: "evl_01k3p2c4e8",
    ranAt: "2026-08-01T08:40:00.000Z",
    goldenSetName: "Owner reply drafting — curated set 2026.4",
    caseCount: 180,
    passed: 154,
    accuracy: 0.8556,
    threshold: 0.9,
    meetsThreshold: false,
    modelId: "inventory/drafting-standard",
    promptVersion: "owner-reply-v7",
  },
  evaluationAfter: {
    evaluationId: "evl_01k3r5r6s1",
    ranAt: "2026-08-06T05:02:00.000Z",
    goldenSetName: "Owner reply drafting — curated set 2026.4",
    caseCount: 180,
    passed: 141,
    accuracy: 0.7833,
    threshold: 0.9,
    meetsThreshold: false,
    modelId: "inventory/drafting-standard",
    promptVersion: "owner-reply-v8",
  },
  evaluationDelta: -7.23,
  blastRadius: {
    roles: ["role_owner_services_drafting"],
    workflows: ["Owner enquiry drafting"],
    runsInLastThirtyDays: 8914,
  },
  observationCount: 267,
  createdAt: "2026-08-06T05:05:00.000Z",
  status: "awaiting_approval",
};

export const improvementProposals: readonly ImprovementProposalView[] = [
  improvementProposal,
  improvementProposalRegression,
];

// ---------------------------------------------------------------------------
// Audit and evidence
// ---------------------------------------------------------------------------

export const auditEntries: readonly AuditEntryView[] = [
  {
    entryId: "aud_01k3s1a4b7",
    seq: 41_882,
    eventType: "approval.requested",
    recordedAt: "2026-08-06T08:11:00.000Z",
    actor: agentOperator,
    runId: "run_01k3m9x2p7",
    subject: { contractId: "CTR-2026-FL-0184423", state: "FL" },
    decision: { approvalId: "apr_01k3n2f6r4", approvalsRequired: 2, risk: "high_consequence" },
    inputDigests: {
      proposal: "9c4f1ea77b0d38625af0c9b34e1d5a8206ff73c19ad48be05723c6d1f8904b7e",
    },
    entryHash: "5f2b8c1de4a70936bb1c4f8a2d0e77c3a9451bd6e8f302447cbb19de5a6027f18",
    previousHash: "c71d0a6f4e938b25a0cb17d4e8092f36b5a41c7de0928f4b163ac05d7e921fb4",
  },
  {
    entryId: "aud_01k3s0z8c2",
    seq: 41_881,
    eventType: "authorization.denied",
    recordedAt: "2026-08-02T09:16:02.000Z",
    actor: agentOperator,
    runId: "run_01k3m6h1c5",
    subject: { loanId: "LN-2024-NV-0930881", state: "NV" },
    decision: {
      reason: "authorization.action_not_permitted",
      action: "loans.rank_borrowers",
      riskTier: "prohibited",
    },
    inputDigests: {
      request: "2d8b4f16c0e7a935bb51d8c204ef7361a09b5e2748cdf0136ba97e4c5d208f71",
    },
    entryHash: "c71d0a6f4e938b25a0cb17d4e8092f36b5a41c7de0928f4b163ac05d7e921fb4",
    previousHash: "a03e5c8b19d7f462c0ba38e15d9074f26c81b3ae740df9251b6ec03a8f24d517",
  },
  {
    entryId: "aud_01k3rzy2d5",
    seq: 41_880,
    eventType: "role.promoted",
    recordedAt: "2026-08-05T02:41:00.000Z",
    actor: complianceReviewer,
    subject: { roleId: "role_rescission_assurance", version: "9" },
    decision: { evaluationId: "evl_01k3p4a2c9", accuracy: 0.9625, threshold: 0.95 },
    inputDigests: {
      roleDefinition: "4d90c1ba7e26f38a05c7be914d203f8a6c15e07b39d4128ae6f05c31b7a2e648",
    },
    entryHash: "a03e5c8b19d7f462c0ba38e15d9074f26c81b3ae740df9251b6ec03a8f24d517",
    previousHash: "7b2f0e91c4a86d305b1ce78f2a940d6318ce5b07a2df4916e830bc1d5f04a729",
  },
  {
    entryId: "aud_01k3rzx0e9",
    seq: 41_879,
    eventType: "containment.engaged",
    recordedAt: "2026-08-04T22:07:41.000Z",
    actor: supervisor,
    subject: { scope: "integration", target: "titling-system" },
    decision: {
      engaged: true,
      reason: "Titling system returned malformed deed references for Hawaii contracts.",
    },
    inputDigests: {},
    entryHash: "7b2f0e91c4a86d305b1ce78f2a940d6318ce5b07a2df4916e830bc1d5f04a729",
    previousHash: "1e6d3a70b58c9f214a0bd67e35c9018f4b2e7d0a96c15f38b0ae42d7c691350b",
  },
];

export const auditVerificationIntact: AuditVerificationView = {
  intact: true,
  entriesChecked: 41_882,
  firstSeq: 1,
  lastSeq: 41_882,
  headHash: "5f2b8c1de4a70936bb1c4f8a2d0e77c3a9451bd6e8f302447cbb19de5a6027f18",
  verifiedAt: "2026-08-06T09:14:02.000Z",
  breaks: [],
};

export const auditVerificationBroken: AuditVerificationView = {
  intact: false,
  entriesChecked: 41_882,
  firstSeq: 1,
  lastSeq: 41_882,
  headHash: null,
  verifiedAt: "2026-08-06T09:14:02.000Z",
  breaks: [
    {
      kind: "hash_mismatch",
      seq: 18_204,
      detail: "Recomputed entry hash does not match the stored value.",
    },
    {
      kind: "sequence_gap",
      seq: 18_206,
      detail: "Entry 18205 is missing; the record jumps from 18204 to 18206.",
    },
    {
      kind: "previous_hash_mismatch",
      seq: 18_207,
      detail: "This entry does not point at the entry before it.",
    },
  ],
};

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

export const containmentClear: readonly ContainmentView[] = [
  { scope: "global", target: "", engaged: false },
  {
    scope: "integration",
    target: "titling-system",
    engaged: false,
    engagedBy: "act_7f3a91c2",
    engagedAt: "2026-08-05T07:30:12.000Z",
    reason: "Vendor confirmed the deed reference format was corrected.",
  },
];

export const containmentGlobalPaused: readonly ContainmentView[] = [
  {
    scope: "global",
    target: "",
    engaged: true,
    engagedBy: "act_7f3a91c2",
    engagedAt: "2026-08-06T09:41:00.000Z",
    reason: "Statutory rules corpus republished mid-quarter; stopping until it is re-verified.",
  },
  {
    scope: "workflow",
    target: "Rescission package assurance",
    engaged: true,
    engagedBy: "act_2c88de40",
    engagedAt: "2026-08-06T09:38:00.000Z",
    reason: "Florida rule under review after a purchaser complaint.",
  },
  {
    scope: "role",
    target: "role_consumer_finance_evidence",
    engaged: true,
    engagedBy: "act_2c88de40",
    engagedAt: "2026-08-02T09:22:00.000Z",
    reason: "Bias testing not complete; role is not to run against live loan files.",
  },
  { scope: "integration", target: "titling-system", engaged: false },
];

// ---------------------------------------------------------------------------
// Work discovery
// ---------------------------------------------------------------------------

export const discoveryCandidates: readonly DiscoveryCandidateView[] = [
  {
    candidateId: "dsc_01k3t1a9m2",
    summary:
      "Copying maintenance-fee arrears totals from the association ledger into the monthly collections summary.",
    occurrences: 148,
    estimatedMinutesPerOccurrence: 7,
    applications: ["association-ledger", "spreadsheet"],
    draftOnly: true,
  },
  {
    candidateId: "dsc_01k3t1b4n8",
    summary:
      "Re-keying contract execution dates from the contract package into the deadline tracker.",
    occurrences: 96,
    estimatedMinutesPerOccurrence: 4,
    applications: ["contract-viewer", "deadline-tracker"],
    draftOnly: true,
  },
];

// ---------------------------------------------------------------------------
// Executive view
//
// Business figures are transcribed from MVW's Q2 2026 earnings release (Form
// 8-K filed 6 August 2026, Exhibit 99.1) as read in docs/context/mvw-priorities.md.
// Platform figures are invented, because this fixture describes a console under
// test rather than a deployment that has run.
// ---------------------------------------------------------------------------

const MVW_SOURCE =
  "MVW Q2 2026 earnings release (Form 8-K, Exhibit 99.1, 6 August 2026). Reported by MVW; not measured by this platform.";
const PLATFORM_SOURCE = "Measured by this platform from its own operating record.";

export const executiveSnapshot: ExecutiveView = {
  asOf: "2026-08-06T09:00:00.000Z",
  businessMetrics: [
    {
      key: "contract_sales",
      label: "Contract sales, Q2 2026",
      value: "$545M",
      comparison: "Up 22% from $445M in Q2 2025",
      direction: "up",
      increaseIsGood: true,
      sourceNote: MVW_SOURCE,
    },
    {
      key: "vpg",
      label: "Volume per guest (VPG), Q2 2026",
      value: "$4,477",
      comparison: "Up 23% from $3,631 in Q2 2025",
      direction: "up",
      increaseIsGood: true,
      sourceNote: MVW_SOURCE,
    },
    {
      key: "tours",
      label: "Tours, Q2 2026",
      value: "112,721",
      comparison: "Down 1% from 114,402 in Q2 2025",
      direction: "down",
      increaseIsGood: true,
      sourceNote: `${MVW_SOURCE} MVW attributes the decline to deliberate action in the Asia-Pacific region.`,
    },
    {
      key: "financing_margin",
      label: "Financing profit margin, Q2 2026",
      value: "54.3%",
      comparison: "Down 450 basis points from 58.8% in Q2 2025",
      direction: "down",
      increaseIsGood: true,
      sourceNote: MVW_SOURCE,
    },
    {
      key: "receivable_reserve",
      label: "Notes and contracts receivable reserve, six months",
      value: "$122M",
      comparison: "Up from $108M in the prior-year six months",
      direction: "up",
      increaseIsGood: false,
      sourceNote: MVW_SOURCE,
    },
    {
      key: "exchange_members",
      // Named by segment rather than by the brand it trades under: the console
      // ships with no mark of any kind in it, fixtures included.
      label: "Exchange network members",
      value: "1,475K",
      comparison: "Down 2% from 1,507K",
      direction: "down",
      increaseIsGood: true,
      sourceNote: MVW_SOURCE,
    },
  ],
  platformMetrics: [
    {
      key: "runs_completed",
      label: "Runs completed in the last thirty days",
      value: "11,284",
      comparison: "Up from 9,902 in the previous thirty days",
      direction: "up",
      increaseIsGood: true,
      sourceNote: PLATFORM_SOURCE,
    },
    {
      key: "refusals",
      label: "Actions the platform refused",
      value: "318",
      comparison: "2.8% of attempted actions",
      direction: "flat",
      sourceNote: `${PLATFORM_SOURCE} A refusal is the platform working, not a failure.`,
    },
    {
      key: "packages_checked",
      label: "Contract packages checked against a state rule",
      value: "2,238",
      comparison: "Across 6 states",
      direction: "up",
      increaseIsGood: true,
      sourceNote: PLATFORM_SOURCE,
    },
    {
      key: "sla_breaches",
      label: "Items that passed their service level",
      value: "41",
      comparison: "Down from 66 in the previous thirty days",
      direction: "down",
      increaseIsGood: false,
      sourceNote: PLATFORM_SOURCE,
    },
  ],
  costPerCaseUsd: 0.3142,
  runsCompleted: 11_284,
  humanHoursSaved: 486,
  measurementCaveat:
    "Hours saved is an estimate, not a measurement. It multiplies a per-case time saving supplied by MVW operations by the number of cases this platform completed. Nobody has run a controlled before-and-after study, and no headcount or cost reduction has been observed. Treat it as an indication of scale, not as a benefit realised.",
};

export const executiveWithoutSavings: ExecutiveView = {
  ...executiveSnapshot,
  costPerCaseUsd: undefined,
  humanHoursSaved: undefined,
};

// ---------------------------------------------------------------------------
// External agents
//
// Four agents on four host platforms, because the roster's whole job is to show
// an estate this platform did not build. One is healthy, one is contained after
// misbehaving, one is over its ceiling and still running, and one is revoked —
// which is the set of states an operator has to be able to tell apart at a
// glance.
// ---------------------------------------------------------------------------

export const externalAgentHealthy: ExternalAgentView = {
  agentId: "eag_01k4a2m7p3",
  name: "crm-owner-reply",
  owner: "priya.raghunathan@example.invalid",
  department: "Owner Services",
  hostPlatform: "vendor-crm",
  purpose:
    "Drafts replies to owner enquiries inside the CRM and asks this platform before it sends anything or touches a contract.",
  status: "active",
  riskCeiling: "sensitive",
  budgetPeriod: "monthly",
  periodKey: "2026-08",
  spentUsd: 41.8829,
  spendCeilingUsd: 250,
  overBudget: false,
  allowedTools: ["crm.read_contract", "crm.draft_reply"],
  dataScopes: ["owners.enquiries", "contracts.metadata"],
  credentialKinds: ["hmac"],
  expiresAt: "2026-12-31T23:59:59.000Z",
  expired: false,
  lastSeenAt: "2026-08-06T09:41:12.000Z",
};

export const externalAgentContained: ExternalAgentView = {
  agentId: "eag_01k4a3c9r8",
  name: "titling-deed-checker",
  owner: "marcus.oyelaran@example.invalid",
  department: "Title and Closing",
  hostPlatform: "titling-vendor-cloud",
  purpose:
    "Reads deed references out of the titling system and flags contracts whose recorded deed does not match the package.",
  status: "contained",
  statusReason:
    "misbehaviour — the agent is doing something it is not supposed to do: five refused writes to the titling system in four minutes",
  statusChangedAt: "2026-08-06T08:02:44.000Z",
  statusChangedBy: "act_7f3a91c2",
  riskCeiling: "routine",
  budgetPeriod: "monthly",
  periodKey: "2026-08",
  spentUsd: 3.2104,
  spendCeilingUsd: 100,
  overBudget: false,
  allowedTools: ["titling.read_deed"],
  dataScopes: ["contracts.metadata"],
  credentialKinds: ["bearer"],
  expiresAt: "2026-10-15T00:00:00.000Z",
  expired: false,
  lastSeenAt: "2026-08-06T08:02:41.000Z",
};

export const externalAgentOverBudget: ExternalAgentView = {
  agentId: "eag_01k4a4f1t2",
  name: "board-pack-assembler",
  owner: "dana.whitfield@example.invalid",
  department: "Association Management",
  hostPlatform: "cloud-agent-service",
  purpose:
    "Assembles association board packs from the association's own budget and reserve study, on the association manager's request.",
  status: "active",
  riskCeiling: "routine",
  budgetPeriod: "monthly",
  periodKey: "2026-08",
  spentUsd: 512.44,
  spendCeilingUsd: 400,
  overBudget: true,
  allowedTools: ["docs.read_budget", "docs.read_reserve_study", "docs.assemble_pack"],
  dataScopes: ["associations.financials", "associations.reserve_studies"],
  credentialKinds: ["jwt", "envelope"],
  expiresAt: "2026-09-01T00:00:00.000Z",
  expired: false,
  lastSeenAt: "2026-08-06T09:58:03.000Z",
};

export const externalAgentRevoked: ExternalAgentView = {
  agentId: "eag_01k4a5h6w9",
  name: "legacy-collections-bot",
  owner: "helen.braithwaite@example.invalid",
  department: "Consumer Finance",
  hostPlatform: "purchased-product",
  purpose:
    "Assembled delinquency evidence packs inside a purchased collections product. Replaced by a governed workflow.",
  status: "revoked",
  statusReason: "superseded — another enrollment replaces this one",
  statusChangedAt: "2026-07-30T15:20:00.000Z",
  statusChangedBy: "act_2c88de40",
  riskCeiling: "sensitive",
  budgetPeriod: "lifetime",
  periodKey: "lifetime",
  spentUsd: 1284.09,
  spendCeilingUsd: 2000,
  overBudget: false,
  allowedTools: ["loans.read_file"],
  dataScopes: ["loans.files"],
  credentialKinds: [],
  expiresAt: "2026-09-30T00:00:00.000Z",
  expired: false,
  lastSeenAt: "2026-07-30T15:11:52.000Z",
};

export const externalAgents: readonly ExternalAgentView[] = [
  externalAgentHealthy,
  externalAgentContained,
  externalAgentOverBudget,
  externalAgentRevoked,
];

export const externalAgentDetail: ExternalAgentDetailView = {
  agent: externalAgentContained,
  credentials: [
    {
      credentialId: "crd_01k4b1a2c3",
      kind: "bearer",
      label: "titling vendor production",
      strong: false,
      createdAt: "2026-06-01T09:00:00.000Z",
      createdBy: "act_7f3a91c2",
      expiresAt: "2026-08-12T09:00:00.000Z",
      lastUsedAt: "2026-08-06T08:02:41.000Z",
    },
    {
      credentialId: "crd_01k4b1b7d4",
      kind: "bearer",
      label: "titling vendor staging",
      strong: false,
      createdAt: "2026-05-04T11:30:00.000Z",
      createdBy: "act_7f3a91c2",
      revokedAt: "2026-06-01T09:02:00.000Z",
      revokedBy: "act_7f3a91c2",
      revokedReason: "rotated — a replacement has been minted and is in use",
      lastUsedAt: "2026-05-31T22:14:07.000Z",
    },
  ],
  runs: [
    {
      externalRunId: "xrn_01k4c1a4b7",
      runId: "run_01k4c1a4b6",
      goal: "Check recorded deed references for contracts closing this week",
      status: "stopped",
      startedAt: "2026-08-06T07:58:00.000Z",
      endedAt: "2026-08-06T08:02:44.000Z",
      outcome:
        "stopped: agent contained: misbehaviour — the agent is doing something it is not supposed to do",
      costUsd: 0.3312,
    },
    {
      externalRunId: "xrn_01k4c0z8c2",
      runId: "run_01k4c0z8c1",
      goal: "Check recorded deed references for contracts closing this week",
      status: "finished",
      startedAt: "2026-08-05T07:58:00.000Z",
      endedAt: "2026-08-05T08:11:20.000Z",
      outcome: "42 contracts checked, 2 mismatches flagged for a person to read",
      costUsd: 0.9041,
    },
    {
      externalRunId: "xrn_01k4bzy2d5",
      runId: "run_01k4bzy2d4",
      goal: "Backfill deed references for the Hawaii portfolio",
      status: "reclaimed",
      startedAt: "2026-08-04T22:00:00.000Z",
      endedAt: "2026-08-04T22:31:00.000Z",
      outcome: "reclaimed: no heartbeat since 2026-08-04T22:29:00.000Z",
      costUsd: 1.4408,
    },
  ],
  runsTotal: 118,
  denials: [
    {
      entryId: "aud_01k4d1a4b7",
      recordedAt: "2026-08-06T08:02:41.000Z",
      reason: "authorization.action_not_permitted",
      message: 'titling-deed-checker is not permitted to use "titling.write_deed".',
      tool: "titling.write_deed",
      operation: "execute.write",
      runId: "run_01k4c1a4b6",
      countedTowardContainment: true,
    },
    {
      entryId: "aud_01k4d1a2b5",
      recordedAt: "2026-08-06T08:01:12.000Z",
      reason: "role.ceiling_exceeded",
      message:
        '"titling.write_deed" is high_consequence (raised from the declared routine by the operator\'s rating), above titling-deed-checker\'s ceiling of routine.',
      tool: "titling.write_deed",
      operation: "screen",
      countedTowardContainment: true,
    },
    {
      entryId: "aud_01k4d0z9a1",
      recordedAt: "2026-08-05T14:33:08.000Z",
      reason: "screen.unavailable",
      message: "The boundary screen could not be reached, so the request was refused.",
      tool: "titling.read_deed",
      operation: "report",
      countedTowardContainment: false,
    },
    {
      entryId: "aud_01k4czy1x8",
      recordedAt: "2026-08-03T11:02:55.000Z",
      reason: "ceiling.rate_exceeded",
      message: "Rate ceiling reached for screen: 61 requests in the window.",
      tool: "titling.read_deed",
      operation: "screen",
      countedTowardContainment: true,
    },
  ],
  containmentHistory: [
    {
      at: "2026-08-06T08:02:44.000Z",
      change: "contained",
      by: "act_7f3a91c2",
      automatic: false,
      reason:
        "misbehaviour — the agent is doing something it is not supposed to do: five refused writes to the titling system in four minutes",
      previousStatus: "active",
    },
    {
      at: "2026-08-03T11:05:00.000Z",
      change: "released",
      by: "act_2c88de40",
      automatic: false,
      reason: "investigated_and_clear — it was looked into and nothing was wrong",
      previousStatus: "contained",
    },
    {
      at: "2026-08-03T11:03:00.000Z",
      change: "contained",
      by: "system:rate-limiter",
      automatic: true,
      reason: "5 refused requests inside the denial window",
      previousStatus: "active",
    },
  ],
  parkedActions: [
    {
      parkedActionId: "pac_01k4e1a4b7",
      integration: "titling",
      operation: "correct_deed_reference",
      status: "pending",
      createdAt: "2026-08-06T08:00:10.000Z",
      expiresAt: "2026-08-07T08:00:10.000Z",
      approvalId: "apr_01k4e1a4b8",
    },
    {
      parkedActionId: "pac_01k4e0z2c9",
      integration: "titling",
      operation: "correct_deed_reference",
      status: "indeterminate",
      createdAt: "2026-08-04T16:12:00.000Z",
      expiresAt: "2026-08-05T16:12:00.000Z",
    },
  ],
  spendMeters: [
    { periodKey: "2026-07", spentUsd: 88.5102, updatedAt: "2026-07-31T23:58:00.000Z" },
    { periodKey: "2026-08", spentUsd: 3.2104, updatedAt: "2026-08-06T08:02:44.000Z" },
  ],
};

export const externalAgentDetailHealthy: ExternalAgentDetailView = {
  agent: externalAgentHealthy,
  credentials: [
    {
      credentialId: "crd_01k4b2m8k5",
      kind: "hmac",
      label: "crm production, signed requests",
      strong: true,
      createdAt: "2026-04-18T10:00:00.000Z",
      createdBy: "act_7f3a91c2",
      lastUsedAt: "2026-08-06T09:41:12.000Z",
    },
  ],
  runs: [
    {
      externalRunId: "xrn_01k4c2m8k5",
      runId: "run_01k4c2m8k4",
      goal: "Draft a reply about points reinstatement for member 4471-889-02",
      status: "finished",
      startedAt: "2026-08-06T09:40:00.000Z",
      endedAt: "2026-08-06T09:41:12.000Z",
      outcome: "A draft was produced and placed in the agent's queue for editing and sending.",
      costUsd: 0.0912,
    },
  ],
  runsTotal: 1,
  denials: [],
  containmentHistory: [],
  parkedActions: [],
  spendMeters: [{ periodKey: "2026-08", spentUsd: 41.8829, updatedAt: "2026-08-06T09:41:12.000Z" }],
};

export const externalPlaneHealthy: ExternalAgentHealthView = {
  planeEnabled: true,
  enrolledCount: 4,
  activeCount: 2,
  enabledWithNothingEnrolled: false,
  contained: [],
  overBudget: [],
  credentialsNearingExpiry: [],
  expiryHorizonDays: 14,
};

export const externalPlaneAlarming: ExternalAgentHealthView = {
  planeEnabled: true,
  enrolledCount: 4,
  activeCount: 2,
  enabledWithNothingEnrolled: false,
  contained: [
    {
      agentId: "eag_01k4a3c9r8",
      name: "titling-deed-checker",
      owner: "marcus.oyelaran@example.invalid",
      department: "Title and Closing",
      hostPlatform: "titling-vendor-cloud",
      reason:
        "misbehaviour — the agent is doing something it is not supposed to do: five refused writes to the titling system in four minutes",
      since: "2026-08-06T08:02:44.000Z",
      by: "act_7f3a91c2",
    },
  ],
  overBudget: [
    {
      agentId: "eag_01k4a4f1t2",
      name: "board-pack-assembler",
      owner: "dana.whitfield@example.invalid",
      department: "Association Management",
      periodKey: "2026-08",
      budgetPeriod: "monthly",
      spentUsd: 512.44,
      ceilingUsd: 400,
      overByUsd: 112.44,
    },
  ],
  credentialsNearingExpiry: [
    {
      credentialId: "crd_01k4b1a2c3",
      agentId: "eag_01k4a3c9r8",
      agentName: "titling-deed-checker",
      kind: "bearer",
      label: "titling vendor production",
      expiresAt: "2026-08-12T09:00:00.000Z",
      expired: false,
    },
  ],
  expiryHorizonDays: 14,
};

export const externalPlaneEmpty: ExternalAgentHealthView = {
  planeEnabled: true,
  enrolledCount: 0,
  activeCount: 0,
  enabledWithNothingEnrolled: true,
  contained: [],
  overBudget: [],
  credentialsNearingExpiry: [],
  expiryHorizonDays: 14,
};

export const externalPlaneDisabled: ExternalAgentHealthView = {
  planeEnabled: false,
  enrolledCount: 0,
  activeCount: 0,
  enabledWithNothingEnrolled: false,
  contained: [],
  overBudget: [],
  credentialsNearingExpiry: [],
  expiryHorizonDays: 14,
};
