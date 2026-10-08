import pytest


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path, monkeypatch):
    """Cada test usa su propia carpeta de datos (nunca ~/.rodillo)."""
    monkeypatch.setenv("RODILLO_HOME", str(tmp_path / "home"))
