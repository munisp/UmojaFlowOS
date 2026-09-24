"""UmojaFlowOS ML Intelligence.

Real PyTorch-based fraud, credit, GNN and anomaly models. Every artifact in
this package is trained by an executable loop in ``training/`` and shipped
with weights, metrics and provenance. All model outputs are advisory risk
evidence for human review: they never authorize, reject, or execute payments,
credit, or identity decisions by themselves (consistent with the platform's
evidence-only control boundary).
"""

__version__ = "1.0.0"
