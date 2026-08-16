from __future__ import annotations
import copy, threading, time, uuid
from dataclasses import dataclass
from .errors import OrganizerError

@dataclass
class StoredRun:
    full_result: dict
    evaluation: dict
    expires_at_epoch: float

class RunStore:
    def __init__(self, ttl_seconds: int, max_runs: int):
        self.ttl_seconds=ttl_seconds; self.max_runs=max_runs; self._items={}; self._lock=threading.Lock()
    def _cleanup(self):
        now=time.time()
        for key in [k for k,v in self._items.items() if v.expires_at_epoch <= now]: self._items.pop(key,None)
    def put(self, full_result: dict, evaluation: dict) -> str:
        with self._lock:
            self._cleanup()
            if len(self._items) >= self.max_runs:
                oldest=min(self._items, key=lambda k:self._items[k].expires_at_epoch); self._items.pop(oldest,None)
            run_id="run_"+uuid.uuid4().hex[:12]
            self._items[run_id]=StoredRun(copy.deepcopy(full_result),copy.deepcopy(evaluation),time.time()+self.ttl_seconds)
            return run_id
    def get(self, run_id: str) -> StoredRun:
        with self._lock:
            self._cleanup(); item=self._items.get(run_id)
            if item is None: raise OrganizerError("RUN_NOT_FOUND_OR_EXPIRED","The clustering run does not exist or has expired. Evaluate clustering again.")
            return copy.deepcopy(item)
    def discard(self, run_id: str) -> bool:
        with self._lock: return self._items.pop(run_id,None) is not None
