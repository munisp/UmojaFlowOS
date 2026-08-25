from __future__ import annotations

from dataclasses import dataclass, field

from scripts.infra.tigerbeetle_dr_state import DRState, FailoverController


@dataclass
class FakeCluster:
    events: list[str] = field(default_factory=list)
    quorum: bool = False
    fenced: bool = False
    reconciled: bool = False
    resumed: bool = False

    def freeze(self) -> None:
        self.events.append("freeze")

    def fence(self) -> None:
        self.fenced = True
        self.events.append("fence")

    def verify(self) -> bool:
        self.events.append("verify")
        return self.quorum and self.fenced

    def promote(self) -> None:
        self.events.append("promote")

    def reconcile(self) -> None:
        self.reconciled = True
        self.events.append("reconcile")

    def resume(self) -> None:
        assert self.reconciled
        self.resumed = True
        self.events.append("resume")


def test_consensus_loss_fails_closed_until_quorum_and_reconciliation() -> None:
    cluster = FakeCluster(quorum=False)
    controller = FailoverController(cluster)

    first = controller.run()

    assert first == DRState.INDETERMINATE
    assert cluster.resumed is False
    assert cluster.events == ["freeze", "fence", "verify"]

    cluster.quorum = True
    second = controller.run()

    assert second == DRState.RESUMED
    assert cluster.events == [
        "freeze", "fence", "verify",
        "freeze", "fence", "verify", "promote", "reconcile", "resume",
    ]


def test_no_resume_after_reconciliation_failure() -> None:
    class FailingReconcile(FakeCluster):
        def reconcile(self) -> None:
            self.events.append("reconcile")
            raise RuntimeError("projection mismatch")

    cluster = FailingReconcile(quorum=True)
    controller = FailoverController(cluster)

    assert controller.run() == DRState.INDETERMINATE
    assert cluster.events == ["freeze", "fence", "verify", "promote", "reconcile"]
    assert cluster.resumed is False


def test_split_brain_is_rejected_when_two_writable_primaries_are_detected() -> None:
    class SplitBrainCluster(FakeCluster):
        writable_primaries = 2

        def verify(self) -> bool:
            self.events.append("verify")
            return self.fenced and self.writable_primaries == 1 and self.quorum

    cluster = SplitBrainCluster(quorum=True)
    controller = FailoverController(cluster)

    assert controller.run() == DRState.INDETERMINATE
    assert cluster.events == ["freeze", "fence", "verify"]
    assert cluster.resumed is False


def test_network_partition_does_not_resume_on_stale_primary_visibility() -> None:
    class PartitionedCluster(FakeCluster):
        def verify(self) -> bool:
            self.events.append("verify")
            # The replica can see a local node but cannot prove authoritative quorum.
            return False

    cluster = PartitionedCluster(quorum=True)
    controller = FailoverController(cluster)

    assert controller.run() == DRState.INDETERMINATE
    assert "promote" not in cluster.events
    assert "resume" not in cluster.events
