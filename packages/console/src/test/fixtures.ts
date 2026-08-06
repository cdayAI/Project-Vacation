import type {
  ApprovalView,
  AuditEntryView,
  AuditVerificationView,
  ContainmentView,
  DenialView,
  DiscoveryCandidateView,
  ExecutiveView,
  HealthView,
  ImprovementClusterView,
  ImprovementProposalView,
  RoleView,
  RunDetailView,
  SessionView,
  WorkflowInstanceView,
  WorkQueueItem,
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

export const auditor = {
  actorId: "act_04e6cc19",
  displayName: "Helen Braithwaite",
  roles: ["auditor"],
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

export const workQueueItems: readonly WorkQueueItem[] = [
  {
    runId: "run_01k3m9x2p7",
    kind: "rescission.package_check",
    title: "Rescission package check — contract CTR-2026-FL-0184423 (FL)",
    status: "awaiting_approval",
    mode: "supervised",
    createdAt: "2026-08-04T13:02:11.000Z",
    dueAt: "2026-08-05T13:02:11.000Z",
    slaBreached: true,
    assignedRole: "owner_services_supervisor",
    costUsd: 0.4821,
    waitingOn: "A supervisor to approve sending the corrected disclosure package.",
  },
  {
    runId: "run_01k3m9y8q1",
    kind: "rescission.clock_compute",
    title: "Rescission deadline recompute — contract CTR-2026-SC-0177015 (SC)",
    status: "running",
    mode: "shadow",
    createdAt: "2026-08-06T07:41:55.000Z",
    dueAt: "2026-08-06T19:41:55.000Z",
    slaBreached: false,
    costUsd: 0.0037,
    waitingOn: "The statutory rules corpus for South Carolina to finish loading.",
  },
  {
    runId: "run_01k3m8w4t9",
    kind: "association.board_pack",
    title: "Board pack assembly — Coral Bay Owners Association, Inc. (FL), Q3 2026",
    status: "awaiting_human",
    mode: "assisted",
    createdAt: "2026-08-03T16:20:00.000Z",
    dueAt: "2026-08-07T16:20:00.000Z",
    slaBreached: false,
    assignedRole: "association_manager",
    costUsd: 2.1408,
    waitingOn: "The reserve study extract for the 2026 fiscal year.",
  },
  {
    runId: "run_01k3m7r6v2",
    kind: "owner_services.response_draft",
    title: "Owner enquiry draft — points reinstatement, member 4471-889-02",
    status: "succeeded",
    mode: "assisted",
    createdAt: "2026-08-05T11:05:30.000Z",
    slaBreached: false,
    assignedRole: "owner_services_agent",
    costUsd: 0.0912,
  },
  {
    runId: "run_01k3m6h1c5",
    kind: "loan_file.evidence_pack",
    title: "Delinquency evidence pack — loan LN-2024-NV-0930881 (NV)",
    status: "denied",
    mode: "supervised",
    createdAt: "2026-08-02T09:15:44.000Z",
    dueAt: "2026-08-04T09:15:44.000Z",
    slaBreached: true,
    assignedRole: "consumer_finance_analyst",
    costUsd: 0.0,
    waitingOn: "Nothing — the platform refused this action and it will not proceed.",
  },
  {
    runId: "run_01k3m5d0b8",
    kind: "association.budget_variance",
    title: "Budget variance narrative — Palmetto Dunes Vacation Owners Association, Inc. (SC)",
    status: "pending",
    mode: "shadow",
    createdAt: "2026-08-06T06:00:00.000Z",
    slaBreached: false,
    costUsd: 0.0,
  },
  {
    runId: "run_01k3m4a7n3",
    kind: "rescission.package_check",
    title: "Rescission package check — contract CTR-2026-HI-0166204 (HI)",
    status: "failed",
    mode: "supervised",
    createdAt: "2026-08-01T22:48:03.000Z",
    dueAt: "2026-08-02T22:48:03.000Z",
    slaBreached: true,
    assignedRole: "owner_services_supervisor",
    costUsd: 0.3311,
    waitingOn: "Nothing — the run failed and has not been restarted.",
  },
];

export const approvalAwaitingDecision: ApprovalView = {
  approvalId: "apr_01k3n2f6r4",
  action: "documents.send_corrected_disclosure",
  actionDescription:
    "Send a corrected disclosure package to the purchaser on contract CTR-2026-FL-0184423",
  risk: "high_consequence",
  reversible: false,
  summary:
    "The original disclosure package for this Florida contract omitted the public offering statement receipt. Sending a corrected package restarts the statutory rescission period from the date of delivery, which moves the purchaser's cancellation deadline and the associated funding hold.",
  proposalDigest: "9c4f1ea77b0d38625af0c9b34e1d5a8206ff73c19ad48be05723c6d1f8904b7e",
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
    { label: "Statutory basis", value: "Fla. Stat. §721.10 (placeholder citation — unverified)" },
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
      note: "Rescission recompute checked against the FL rule as loaded. Note the rule is still marked unverified in the corpus.",
    },
  ],
  viewerMayDecide: true,
  requiresStepUp: true,
};

export const approvalViewerMayNotDecide: ApprovalView = {
  ...approvalAwaitingDecision,
  approvalId: "apr_01k3n3z9w7",
  action: "contact.send_collections_letter",
  actionDescription:
    "Send a maintenance-fee arrears letter to the owner of interest SUN-2019-AZ-0044120",
  risk: "sensitive",
  reversible: false,
  summary:
    "A first-stage arrears notice for an owner 62 days past due on the 2026 maintenance fee at Sunridge Canyon Owners Association. The letter is generated from the approved template and carries no settlement offer.",
  proposalDigest: "1a7d0b9e5c34f8261099ab7de4c05f31872b6ad9e0c14f7358be2201d6a9c4f5",
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
    "You raised this proposal, and nobody may approve their own. A compliance reviewer has to decide it.",
  requiresStepUp: false,
};

export const runWithRefusedStep: RunDetailView = {
  runId: "run_01k3m6h1c5",
  kind: "loan_file.evidence_pack",
  title: "Delinquency evidence pack — loan LN-2024-NV-0930881 (NV)",
  status: "denied",
  mode: "supervised",
  requestedBy: agentOperator,
  createdAt: "2026-08-02T09:15:44.000Z",
  startedAt: "2026-08-02T09:15:45.000Z",
  endedAt: "2026-08-02T09:16:02.000Z",
  denialReason:
    "The platform refused to rank or sequence borrowers. It will assemble the evidence and a person decides the treatment.",
  steps: [
    {
      stepId: "stp_01k3m6h1c5_1",
      seq: 1,
      name: "Load loan file",
      kind: "integration.read",
      status: "succeeded",
      startedAt: "2026-08-02T09:15:45.000Z",
      endedAt: "2026-08-02T09:15:47.400Z",
      durationMs: 2400,
      costUsd: 0,
      attempt: 1,
      inputDigest: "44b1c07e9f2a5d8360cb14e7a09f5b2d3c81746ee0af9b25d3708c1a6e5f2093",
      outputDigest: "c0d9a3b7e14f8256bb037ae9152d4c6f8a91e0374bd25c68f1a94e307db6512c",
      detail: { loanId: "LN-2024-NV-0930881", state: "NV", daysPastDue: 121 },
    },
    {
      stepId: "stp_01k3m6h1c5_2",
      seq: 2,
      name: "Extract contract and policy terms",
      kind: "knowledge.retrieve",
      status: "succeeded",
      startedAt: "2026-08-02T09:15:47.400Z",
      endedAt: "2026-08-02T09:15:52.900Z",
      durationMs: 5500,
      costUsd: 0.0184,
      attempt: 2,
      inputDigest: "7e2f9c04a1b83d5f60cc21e4738a95b0df6172c8e93a04bd5271fc860a3e4197",
      outputDigest: "b31e7d0c9a5426f8017cb2e94d80af35162e7c9b04daf1836e25c07a9b41d5e6",
      detail: { corpus: "nv-consumer-finance", passages: 6 },
    },
    {
      stepId: "stp_01k3m6h1c5_3",
      seq: 3,
      name: "Rank borrowers by recovery likelihood",
      kind: "model.infer",
      status: "denied",
      startedAt: "2026-08-02T09:15:52.900Z",
      endedAt: "2026-08-02T09:16:02.000Z",
      durationMs: 9100,
      costUsd: 0,
      attempt: 1,
      inputDigest: "2d8b4f16c0e7a935bb51d8c204ef7361a09b5e2748cdf0136ba97e4c5d208f71",
      denialReason:
        "Ranking or sequencing consumers is not a registered action for this role. Where an outcome could be adverse to a consumer, the person decides and the platform gathers the evidence.",
      detail: { reasonCode: "authorization.action_not_permitted", riskTier: "prohibited" },
    },
  ],
  totalCostUsd: 0.0184,
  costByCategory: { "model.infer": 0.0, "knowledge.retrieve": 0.0184, "integration.read": 0.0 },
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

export const runSucceeded: RunDetailView = {
  runId: "run_01k3m7r6v2",
  kind: "owner_services.response_draft",
  title: "Owner enquiry draft — points reinstatement, member 4471-889-02",
  status: "succeeded",
  mode: "assisted",
  requestedBy: agentOperator,
  createdAt: "2026-08-05T11:05:30.000Z",
  startedAt: "2026-08-05T11:05:31.000Z",
  endedAt: "2026-08-05T11:05:39.200Z",
  outcome: "A draft reply was produced and placed in the agent's queue for editing and sending.",
  steps: [
    {
      stepId: "stp_01k3m7r6v2_1",
      seq: 1,
      name: "Screen inbound message",
      kind: "guard.screen",
      status: "succeeded",
      startedAt: "2026-08-05T11:05:31.000Z",
      endedAt: "2026-08-05T11:05:31.180Z",
      durationMs: 180,
      costUsd: 0,
      attempt: 1,
      outputDigest: "e1a5c93d7b0248f6013ca9e57d2b46081f37c0ae95d2b6431e08fa7c5d90b2e4",
      detail: { verdict: "clean" },
    },
    {
      stepId: "stp_01k3m7r6v2_2",
      seq: 2,
      name: "Draft reply",
      kind: "model.infer",
      status: "succeeded",
      startedAt: "2026-08-05T11:05:31.180Z",
      endedAt: "2026-08-05T11:05:39.200Z",
      durationMs: 8020,
      costUsd: 0.0912,
      attempt: 1,
      inputDigest: "3f7a1b0dc95e2846b0a1cd47f39b2e5081c6ad74e920f3b856d1470ac2e98b3d",
      outputDigest: "8b0e2c4a7d19f5360ca8b1e73d024f95617ae8c30b2d94f157ea6031cb8d472f",
      detail: { promptVersion: "owner-reply-v7", groundedPassages: 3 },
    },
  ],
  totalCostUsd: 0.0912,
  costByCategory: { "model.infer": 0.0912, "guard.screen": 0.0 },
  roleId: "role_owner_services_drafting",
  roleVersion: 11,
  citations: [
    {
      chunkId: "chk_pts_00214",
      documentTitle: "Points reinstatement policy",
      documentVersion: "2026.2",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      excerpt:
        "Points cancelled within the reinstatement window may be restored once per membership year on written request from the owner of record.",
      sourceUri: "https://example.invalid/corpus/points-policy/2026.2#00214",
      stale: false,
    },
  ],
};

export const emptyRun: RunDetailView = {
  runId: "run_01k3m5d0b8",
  kind: "association.budget_variance",
  title: "Budget variance narrative — Palmetto Dunes Vacation Owners Association, Inc. (SC)",
  status: "pending",
  mode: "shadow",
  requestedBy: supervisor,
  createdAt: "2026-08-06T06:00:00.000Z",
  steps: [],
  totalCostUsd: 0,
  costByCategory: {},
  citations: [],
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
      key: "interval_members",
      label: "Interval International members",
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
