"""Exporta una sesión a TCX (Garmin Connect, Strava, TrainingPeaks lo aceptan).

En modo Ruta cada muestra lleva lat/lon/altura virtuales, así que el TCX trae
`<Position>` y la plataforma dibuja el recorrido. Orden del xsd en cada
Trackpoint: Time, Position, AltitudeMeters, DistanceMeters, HeartRateBpm,
Cadence, Extensions. HeartRateBpm exige 1-255: sin banda no se emite.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from xml.sax.saxutils import escape

from rodillo.trainer.client import Sample

_TPX = "http://www.garmin.com/xmlschemas/ActivityExtension/v2"


def _iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:23] + "Z"


def trackpoint(start: datetime, s: Sample, t0: float, last_d: float) -> str:
    out = ["      <Trackpoint>", f"        <Time>{_iso(start + timedelta(seconds=s.timestamp_s - t0))}</Time>"]
    if s.lat is not None and s.lon is not None:
        out += ["        <Position>", f"          <LatitudeDegrees>{s.lat:.7f}</LatitudeDegrees>",
                f"          <LongitudeDegrees>{s.lon:.7f}</LongitudeDegrees>", "        </Position>"]
    if s.altitude_m is not None:
        out.append(f"        <AltitudeMeters>{s.altitude_m:.1f}</AltitudeMeters>")
    d = s.distance_m if s.distance_m is not None else last_d
    out.append(f"        <DistanceMeters>{d:.1f}</DistanceMeters>")
    if s.heart_rate_bpm and 0 < s.heart_rate_bpm < 256:
        out.append(f"        <HeartRateBpm><Value>{int(s.heart_rate_bpm)}</Value></HeartRateBpm>")
    if s.cadence_rpm is not None:
        out.append(f"        <Cadence>{int(min(254, s.cadence_rpm))}</Cadence>")
    if s.power_w is not None or s.speed_kmh is not None:
        out += ["        <Extensions>", f'          <TPX xmlns="{_TPX}">']
        if s.speed_kmh is not None:
            out.append(f"            <Speed>{max(0.0, s.speed_kmh) / 3.6:.3f}</Speed>")
        if s.power_w is not None:
            out.append(f"            <Watts>{int(max(0, s.power_w))}</Watts>")
        out += ["          </TPX>", "        </Extensions>"]
    out.append("      </Trackpoint>")
    return "\n".join(out)


def session_to_tcx(name: str, start: datetime, samples: list[Sample]) -> str:
    if not samples:
        raise ValueError("La sesión no tiene muestras")
    t0 = samples[0].timestamp_s
    dur = samples[-1].timestamp_s - t0
    dist = max((s.distance_m or 0) for s in samples)
    hrs = [s.heart_rate_bpm for s in samples if s.heart_rate_bpm]
    pw = [s.power_w for s in samples if s.power_w is not None]
    cals = int((sum(pw) / len(pw)) * dur / 4184 / 0.23) if pw else 0
    hr_lines = (f"        <AverageHeartRateBpm><Value>{round(sum(hrs) / len(hrs))}</Value></AverageHeartRateBpm>\n"
                f"        <MaximumHeartRateBpm><Value>{max(hrs)}</Value></MaximumHeartRateBpm>\n") if hrs else ""
    pts, last = [], 0.0
    for s in samples:
        if s.distance_m is not None:
            last = float(s.distance_m)
        pts.append(trackpoint(start, s, t0, last))
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Activities>
    <Activity Sport="Biking">
      <Id>{_iso(start)}</Id>
      <Lap StartTime="{_iso(start)}">
        <TotalTimeSeconds>{dur:.1f}</TotalTimeSeconds>
        <DistanceMeters>{dist:.1f}</DistanceMeters>
        <Calories>{cals}</Calories>
{hr_lines}        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>
{chr(10).join(pts)}
        </Track>
        <Notes>{escape(name)}</Notes>
      </Lap>
      <Creator xsi:type="Device_t"><Name>rodillo</Name><UnitId>0</UnitId><ProductID>0</ProductID>
        <Version><VersionMajor>0</VersionMajor><VersionMinor>1</VersionMinor></Version></Creator>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
"""
