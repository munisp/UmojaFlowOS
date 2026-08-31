from dataclasses import dataclass
from enum import Enum
from threading import Lock
from typing import Protocol

class Status(str, Enum):
    SUBMITTED='submitted'; PENDING='pending'; SETTLED='settled'; FAILED='failed'; HELD='held'; UNKNOWN='unknown'
@dataclass(frozen=True)
class Intent: id:str; idempotency_key:str
@dataclass(frozen=True)
class Submission: status:Status; reference:str|None=None; safe_to_retry:bool=False
class Rail(Protocol):
    name:str
    def submit(self, intent:Intent)->Submission: ...
    def query(self, intent:Intent)->Submission: ...
class UnknownOutcome(Exception): pass
class Coordinator:
    def __init__(self): self._lock=Lock(); self._records:dict[str,tuple[str,Submission]]={}
    def execute(self,intent:Intent,primary:Rail,secondary:Rail)->tuple[str,Submission]:
        if not intent.id or not intent.idempotency_key: raise ValueError('intent and idempotency key required')
        with self._lock:
            if intent.idempotency_key in self._records:return self._records[intent.idempotency_key]
        try: first=primary.submit(intent)
        except TimeoutError:
            try: first=primary.query(intent)
            except Exception as exc: raise UnknownOutcome('primary outcome unknown') from exc
        if first.status in {Status.SUBMITTED,Status.PENDING,Status.SETTLED}: return self._record(intent,primary.name,first)
        if not (first.safe_to_retry and first.status in {Status.FAILED,Status.HELD}): raise UnknownOutcome('primary outcome unknown; fallback prohibited')
        second=secondary.submit(intent)
        if second.status not in {Status.SUBMITTED,Status.PENDING,Status.SETTLED}: raise UnknownOutcome('secondary outcome not accepted')
        return self._record(intent,secondary.name,second)
    def _record(self,i:Intent,name:str,s:Submission):
        with self._lock:
            return self._records.setdefault(i.idempotency_key,(name,s))
