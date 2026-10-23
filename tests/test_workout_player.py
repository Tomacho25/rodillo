"""WorkoutPlayer: pausar no debe comerse el bloque en curso."""

import asyncio

from rodillo.trainer.workout import Segment, Workout, WorkoutPlayer


class FakeTrainer:
    def __init__(self):
        self.targets: list[int] = []

    async def set_target_power(self, w):
        self.targets.append(w)

    async def set_grade(self, pct):
        pass


async def test_pause_longer_than_segment_does_not_skip_it():
    trainer = FakeTrainer()
    wk = Workout(name="t", segments=[
        Segment(duration_s=1.0, target_w=190, label="Z3"),
        Segment(duration_s=0.2, target_w=100, label="Cooldown"),
    ])
    player = WorkoutPlayer(trainer)
    player.load(wk)
    await player.start()
    await asyncio.sleep(0.2)
    await player.pause()
    await asyncio.sleep(1.3)                 # pausa más larga que el bloque
    await player.resume()
    await asyncio.sleep(0.4)                 # > tick del loop (0.25 s)
    # Tras reanudar seguimos en el bloque Z3 (quedaban ~0.8 s)
    assert player.progress()["segment_label"] == "Z3"
    assert trainer.targets[-1] == 190
    await asyncio.sleep(0.9)
    assert player.state == "finished"
    assert 100 in trainer.targets


class FlakyTrainer(FakeTrainer):
    """Rechaza los primeros writes como el Flux S quieto (GATT 0x80)."""

    def __init__(self, failures: int):
        super().__init__()
        self.failures = failures
        self.control_requests = 0

    async def request_control(self):
        self.control_requests += 1

    async def set_target_power(self, w):
        if self.failures > 0:
            self.failures -= 1
            raise RuntimeError("GATT Protocol Error: Application-specific Error 0x80")
        await super().set_target_power(w)


async def test_rejected_target_is_retried_within_segment(monkeypatch):
    import rodillo.trainer.workout as wmod
    monkeypatch.setattr(wmod, "TARGET_RETRY_S", 0.1)
    trainer = FlakyTrainer(failures=2)
    wk = Workout(name="t", segments=[Segment(duration_s=3.0, target_w=132, label="Cale")])
    player = WorkoutPlayer(trainer)
    player.load(wk)
    await player.start()
    await asyncio.sleep(1.4)                 # 2 rechazos → 2 reintentos (loop cada ≤0,5 s)
    # Antes el bloque entero quedaba sin target; ahora llega dentro del mismo bloque
    assert player.progress()["segment_label"] == "Cale"
    assert trainer.targets == [132]
    assert trainer.control_requests >= 1
    await player.stop()
