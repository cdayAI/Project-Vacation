import type {
  ApprovalView,
  DenialView,
  HealthView,
  RunDetailView,
  SessionView,
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
  capabilities: ["work.read", "approvals.read", "approvals.decide", "runs.read"],
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
