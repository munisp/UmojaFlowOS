# 1 - UmojaFlowOS and the CBN VASP Sandbox

We are here today to examine how UmojaFlowOS supports the Central Bank of Nigeria Regulatory Sandbox Cohort 2 VASP Track. This briefing covers our architecture, controls, and readiness for responsible virtual-asset innovation. We operate as a governed operating layer for compliance, enforcement, and measurable policy learning. But remember, this is an architecture and readiness briefing, not a permanent licence or CBN endorsement. Let us walk through how our system translates regulatory requirements into verifiable evidence.

# 2 - What the CBN Sandbox Is Designed to Achieve

The CBN Sandbox is designed to foster innovation while protecting the broader financial ecosystem. Cohort 2 focuses on controlled testing under strict oversight, covering volumes, exposure, and duration. We know that innovation must not outpace inclusion or security. So what does this mean for VASP participants? You can test payment, settlement, and stablecoin propositions within approved boundaries. But you must demonstrate robust AML, consumer protection, and operational resilience. UmojaFlowOS provides the control and evidence fabric around these tests. We don't replace your licence or act as a bank; we give you the operational controls to prove compliance. Moving from these mission goals, let us examine how our system architecture enforces these boundaries from the ground up.

# 3 - Architecture: From Identity to Immutable Evidence

Architecture is not just about moving data; it is about establishing immutable truth. We built UmojaFlowOS to trace every action from identity to permanent evidence. First, we verify who may act through strict identity and authority controls. Then, policy workflows determine what is allowed before compliance checks execute. Financial facts land in our PostgreSQL and TigerBeetle layers, ensuring absolute ledger integrity. Finally, WORM storage locks down monitoring data so everything can be proved later. Regulators see traceable decisions, operators see a single workflow, and citizens see protection before value moves. Now let's map these architectural layers directly to specific CBN regulatory requirements.

# 4 - CBN Requirement to UmojaFlowOS Control Mapping

Compliance is only as good as its measurable evidence. We map every core CBN requirement directly to an operational UmojaFlowOS control and its required staging evidence. For AML, CFT, and sanctions, we use automated screening gates backed by provider contracts and analyst review logs. Consumer protection relies on hard-coded transaction limits and mandatory consent capture, verified through rejection logs. Operational resilience depends on a fail-closed architecture with SHA-bound recovery protocols. Financial integrity is enforced via a double-entry ledger reconciled against PostgreSQL projections. And for policy evidence, immutable WORM storage captures all material actions with cryptographic binding. This matrix proves that our controls are active and auditable. Let's look next at how these internal controls interact with external trust boundaries.

# 5 - External Integrations and Trust Boundaries

Security requires explicit trust boundaries across every external integration. We manage identity through Keycloak and OIDC-compliant cryptographic validation of session claims. Compliance checks rely on real-time screening providers verified via HMAC and strict network enforcement. Financial integrity rests on the absolute boundary between PostgreSQL control-state and TigerBeetle double-entry ledgers. Finally, our assurance boundary locks material evidence into WORM storage while Prometheus monitors system health continuously. Every external dependency is bounded, verified, and cryptographically secure. This integration architecture ensures that our cloud-agnostic platform maintains strict operational integrity at every handoff.

# 6 - Evidence and Independent Assurance

Trust cannot rely on promises alone. It requires machine-verifiable proof of control. Building on our external trust boundaries, we enforce this through a rigorous nine-part evidence set, spanning build provenance down to independent ledger reconciliation. Every single artifact is secured by SHA-256 hashing and bound directly to the release manifest. If a single file changes, the entire evidence set breaks. We store this in write-once-read-many storage to prevent tampering by any platform user. And to remove any conflict of interest, the final E-09 review requires an independent auditor who had no hand in running the tests. This immutable chain of custody protects every transaction. And that strong foundation delivers direct value across the entire ecosystem.

# 7 - Value to CBN, Government, Partners, and Citizens

A responsible sandbox must deliver clear value to every participant in the financial ecosystem. For the Central Bank, we provide real-time visibility into experimental flows and policy learning. For the government, cloud-agnostic infrastructure ensures total national data sovereignty. Financial partners gain a standardized control fabric that cuts compliance overhead through automated reconciliation. And citizens receive hard-coded protection, mandatory consent, and clear recourse. But achieving this value requires a strict dividing line between code capability and operational readiness.

# 8 - Readiness Boundary and Path to GO

We have built the technical foundation locally. The governance schemas, semantic validators, and seeding engines are fully operational in our Docker Compose staging stack. But code alone does not mean go. Transitioning from our current no-go status requires real-world evidence and organizational commitment. We need authorized Keycloak realms, authentic staging artifacts, and independent verification. Most importantly, we require four distinct operational sign-offs under our dual-control authority. This boundary ensures we cross into national-scale production with absolute confidence. And that brings us to our concluding path forward.

# 9 - A Responsible Path from Innovation to Trust

Innovation without accountability risks public trust. UmojaFlowOS bridges that gap by turning experimental digital finance into secure national infrastructure. Moving forward is straightforward. We mobilize governance by assigning our twelve distinct subjects. We provision the staging stack and connect real provider credentials. We execute our evidence suite and secure independent review. Finally, we submit our validated dossier to the Central Bank Sandbox Portal for final admission. Thank you for your partnership in building a trusted digital economy for Nigeria.
