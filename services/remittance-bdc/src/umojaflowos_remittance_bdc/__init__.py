"""UmojaFlowOS Remittance & BDC control-plane service.

Closes the audited product gap: the platform handled B2B trade archetypes
(importer/exporter/payroll) but had zero remittance or Bureau-de-Change domain
code — no remitter/beneficiary model, no purpose codes, no payout channels,
no BDC rate boards, tickets, or vault positions.

Control boundary (unchanged platform invariant): this service records and
validates *evidence* and *controlled preparation* only. It never executes a
payout, performs FX conversion, moves value, activates a provider, or submits
anything to a regulator. Those remain external activation gates owned by the
licensed IMTO / authorised dealer BDC.
"""

__version__ = "1.0.0"
