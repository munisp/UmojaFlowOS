from __future__ import annotations

from enum import Enum
from typing import Protocol


class DRState(str, Enum):
    INDETERMINATE = "indeterminate"
    RESUMED = "resumed"


class ClusterHooks(Protocol):
    def freeze(self) -> None: ...
    def fence(self) -> None: ...
    def verify(self) -> bool: ...
    def promote(self) -> None: ...
    def reconcile(self) -> None: ...
    def resume(self) -> None: ...


class FailoverController:
    def __init__(self, cluster: ClusterHooks) -> None:
        self.cluster = cluster

    def run(self) -> DRState:
        try:
            self.cluster.freeze()
            self.cluster.fence()
            if not self.cluster.verify():
                return DRState.INDETERMINATE
            self.cluster.promote()
            self.cluster.reconcile()
            self.cluster.resume()
            return DRState.RESUMED
        except Exception:
            return DRState.INDETERMINATE
