import { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, Polygon, CircleMarker, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.heat";

function pointInPolygon(point: [number, number], polygon: [number, number][]) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateHotspots(opts: { polygon: [number, number][]; count: number; seed: number; ampRange?: [number, number]; spreadRange?: [number, number]; }) {
  const { polygon, count, seed, ampRange = [0.6, 1.0], spreadRange = [25, 80] } = opts;
  const rnd = mulberry32(seed);
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs);
  const miny = Math.min(...ys), maxy = Math.max(...ys);
  const hotspots: { lng: number; lat: number; amp: number; spread: number }[] = [];
  let tries = 0;
  while (hotspots.length < count && tries < 5000) {
    tries++;
    const lng = minx + rnd() * (maxx - minx);
    const lat = miny + rnd() * (maxy - miny);
    if (pointInPolygon([lng, lat], polygon)) {
      const amp = ampRange[0] + rnd() * (ampRange[1] - ampRange[0]);
      const spread = spreadRange[0] + rnd() * (spreadRange[1] - spreadRange[0]);
      hotspots.push({ lng, lat, amp, spread });
    }
  }
  return hotspots;
}

const metersToDegreesLat = (m: number) => m / 111320;
const metersToDegreesLng = (m: number, lat: number) => m / (111320 * Math.cos((lat * Math.PI) / 180));

function sampleHeatPoints(opts: { polygon: [number, number][]; hotspots: { lng: number; lat: number; amp: number; spread: number }[]; seed: number; samples: number; }) {
  const { polygon, hotspots, seed, samples } = opts;
  const rnd = mulberry32(seed ^ 0x9e3779b1);
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs);
  const miny = Math.min(...ys), maxy = Math.max(...ys);
  const points: [number, number, number][] = [];
  let generated = 0, guard = 0;
  while (generated < samples && guard < samples * 20) {
    guard++;
    const lng = minx + rnd() * (maxx - minx);
    const lat = miny + rnd() * (maxy - miny);
    if (!pointInPolygon([lng, lat], polygon)) continue;
    let w = 0;
    for (const h of hotspots) {
      const dx = metersToDegreesLng(h.spread, h.lat);
      const dy = metersToDegreesLat(h.spread);
      const nx = (lng - h.lng) / dx;
      const ny = (lat - h.lat) / dy;
      const d2 = nx * nx + ny * ny;
      w += Math.exp(-d2 / 2) * h.amp;
    }
    w = Math.max(0, Math.min(1, w));
    points.push([lat, lng, Number(w.toFixed(3))]);
    generated++;
  }
  return points;
}

function HeatLayer({ points, radius = 15, blur = 20, maxZoom = 19 }: { points: [number, number, number][]; radius?: number; blur?: number; maxZoom?: number; }) {
  const map = useMap();
  useEffect(() => {
    const layer = (L as any).heatLayer(points, { radius, blur, maxZoom, minOpacity: 0.25, maxOpacity: 0.95, gradient: { 0.0: "#22c55e", 0.35: "#eab308", 0.7: "#ef4444", 1.0: "#7f1d1d" } });
    layer.addTo(map);
    return () => { layer.remove(); };
  }, [map, points, radius, blur, maxZoom]);
  return null;
}

function FitView({ bounds }: { bounds: L.LatLngBounds }) {
  const map = useMap();
  useEffect(() => {
    map.fitBounds(bounds, { padding: [20, 20] });
  }, [map, bounds]);
  return null;
}

function Progress({ value }: { value: number }) {
  return (
    <div style={{ width: "100%", height: 8, borderRadius: 999, background: "#f1f5f9" }}>
      <div style={{ width: `${Math.max(0, Math.min(100, value))}%`, height: "100%", borderRadius: 999, background: "linear-gradient(90deg,#22c55e,#eab308,#ef4444)" }} />
    </div>
  );
}

function Sparkline({ data, stroke = "#0ea5e9" }: { data: number[]; stroke?: string }) {
  const w = 160, h = 40, p = 4;
  if (!data.length) return <svg width={w} height={h} />;
  const min = Math.min(...data), max = Math.max(...data);
  const scaleX = (i: number) => p + (i * (w - 2 * p)) / (data.length - 1 || 1);
  const scaleY = (v: number) => h - p - ((v - min) / Math.max(1e-6, max - min)) * (h - 2 * p);
  const d = data.map((v, i) => `${i === 0 ? "M" : "L"} ${scaleX(i)} ${scaleY(v)}`).join(" ");
  return (
    <svg width={w} height={h}>
      <path d={d} fill="none" stroke={stroke} strokeWidth="2" />
    </svg>
  );
}

function IndicatorCard({ title, value, subtitle, accent = "#0ea5e9", footer }: { title: string; value: string; subtitle?: string; accent?: string; footer?: React.ReactNode }) {
  return (
    <div style={{ background: "#fff", borderRadius: 16, border: "1px solid #e5e7eb", boxShadow: "0 18px 40px rgba(0,0,0,0.08)", padding: 16 }}>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>{title}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontSize: 28, fontWeight: 700, color: "#0f172a" }}>{value}</div>
        <div style={{ width: 8, height: 8, borderRadius: 4, background: accent }} />
      </div>
      {subtitle ? <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>{subtitle}</div> : null}
      {footer ? <div style={{ marginTop: 10 }}>{footer}</div> : null}
    </div>
  );
}

const EX_POLYGON: [number, number][] = [
  [-52.7798284, -26.2730886],
  [-52.7678284, -26.2730886],
  [-52.7678284, -26.2820886],
  [-52.7798284, -26.2820886],
];

export default function MapaCalorPropriedade() {
  const [seed] = useState(1234567);
  const [samples] = useState(6000);
  const [radius] = useState(15);
  const [blur] = useState(20);
  const [hotspotCount] = useState(8);
  const [polygon] = useState<[number, number][]>(EX_POLYGON);

  const hotspots = useMemo(() => generateHotspots({ polygon, count: hotspotCount, seed }), [polygon, hotspotCount, seed]);
  const heatPoints = useMemo(() => sampleHeatPoints({ polygon, hotspots, seed, samples }), [polygon, hotspots, seed, samples]);
  const topHotspots = useMemo(() => hotspots.slice(0, Math.min(5, hotspots.length)), [hotspots]);

  const center = useMemo(() => {
    const lat = polygon.reduce((s, p) => s + p[1], 0) / polygon.length;
    const lng = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
    return [lat, lng] as [number, number];
  }, [polygon]);

  const bounds = useMemo(() => L.latLngBounds(polygon.map((p) => [p[1], p[0]] as [number, number])), [polygon]);

  const threshold = 0.65;

  const coverage = useMemo(() => {
    if (!heatPoints.length) return 0;
    const c = heatPoints.filter((p) => p[2] >= threshold).length / heatPoints.length;
    return Number((c * 100).toFixed(1));
  }, [heatPoints]);

  const areaHa = useMemo(() => {
    const lngs = polygon.map((p) => p[0]);
    const lats = polygon.map((p) => p[1]);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const latCenter = (minLat + maxLat) / 2;
    const widthM = (maxLng - minLng) * 111320 * Math.cos((latCenter * Math.PI) / 180);
    const heightM = (maxLat - minLat) * 111320;
    const areaM2 = Math.abs(widthM * heightM);
    return Number((areaM2 / 10000).toFixed(2));
  }, [polygon]);

  const criticalHa = useMemo(() => Number(((coverage / 100) * areaHa).toFixed(2)), [coverage, areaHa]);

  const spreadPotential = useMemo(() => {
    if (!hotspots.length) return 0;
    const meanAmp = hotspots.reduce((a, h) => a + h.amp, 0) / hotspots.length;
    const meanSpread = hotspots.reduce((a, h) => a + h.spread, 0) / hotspots.length;
    return meanAmp * meanSpread;
  }, [hotspots]);

  const daysTo50 = useMemo(() => {
    const current = coverage / 100;
    const deficit = Math.max(0, 0.5 - current);
    if (deficit === 0) return "1–2 dias";
    const rate = Math.max(0.01, spreadPotential / 120);
    const days = Math.round(Math.min(21, Math.max(2, (deficit / 0.12) * (8 / rate))));
    return `${days} dias`;
  }, [coverage, spreadPotential]);

  const meanIntensity = useMemo(() => {
    if (!heatPoints.length) return 0;
    const sum = heatPoints.reduce((a, p) => a + p[2], 0);
    return Number(((sum / heatPoints.length) * 100).toFixed(1));
  }, [heatPoints]);

  const p95Intensity = useMemo(() => {
    if (!heatPoints.length) return 0;
    const arr = heatPoints.map((p) => p[2]).slice().sort((a, b) => a - b);
    const idx = Math.floor(0.95 * (arr.length - 1));
    return Number((arr[idx] * 100).toFixed(1));
  }, [heatPoints]);

  const focosPorHa = useMemo(() => {
    if (!areaHa) return 0;
    return Number((hotspots.length / areaHa).toFixed(2));
  }, [hotspots.length, areaHa]);

  const projection7d = useMemo(() => {
    const start = coverage / 100;
    const rate = Math.max(0.01, spreadPotential / 120);
    const days = 7;
    const serie: number[] = [];
    let v = start;
    for (let d = 0; d < days; d++) {
      v = Math.min(1, v + 0.04 * rate);
      serie.push(v);
    }
    return serie.map((x) => Number((x * 100).toFixed(1)));
  }, [coverage, spreadPotential]);

  const projDelta7d = useMemo(() => {
    if (!projection7d.length) return 0;
    return Number((projection7d[projection7d.length - 1] - projection7d[0]).toFixed(1));
  }, [projection7d]);

  const riskLabel = useMemo(() => {
    if (coverage >= 60) return { label: "Alto", color: "#ef4444" };
    if (coverage >= 30) return { label: "Médio", color: "#eab308" };
    return { label: "Baixo", color: "#22c55e" };
  }, [coverage]);

  return (
    <div style={{ minHeight: "100dvh", background: "#f5f7fb", padding: 24 }}>
      <div style={{ width: "100%", margin: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(300px, 420px) 1fr", gap: 20 }}>
          <div>
            <div style={{ display: "grid", gap: 16 }}>
              <IndicatorCard
                title="Tempo para espalhar (50% do talhão)"
                value={daysTo50}
                subtitle="Estimativa baseada na intensidade e dispersão atuais"
                accent="#0ea5e9"
                footer={<Progress value={coverage} />}
              />
              <IndicatorCard
                title="Área crítica (≥ limiar)"
                value={`${criticalHa} ha`}
                subtitle={`de ${areaHa} ha • ${coverage}% afetada`}
                accent="#ef4444"
                footer={<Progress value={coverage} />}
              />
              <IndicatorCard
                title="Focos ativos"
                value={`${hotspots.length}`}
                subtitle={`Densidade: ${focosPorHa} focos/ha • Risco ${riskLabel.label}`}
                accent={riskLabel.color}
              />
              <IndicatorCard
                title="Tendência (7 dias)"
                value={`${projection7d[projection7d.length - 1] || 0}%`}
                subtitle={`${projDelta7d >= 0 ? "+" : ""}${projDelta7d} pp vs hoje`}
                accent="#0ea5e9"
                footer={<Sparkline data={projection7d} stroke="#0ea5e9" />}
              />
              <IndicatorCard
                title="Severidade média"
                value={`${meanIntensity}%`}
                subtitle={`p95: ${p95Intensity}%`}
                accent="#8b5cf6"
                footer={<Progress value={meanIntensity} />}
              />
            </div>
          </div>

          <div>
            <div style={{ background: "#fff", borderRadius: 20, boxShadow: "0 20px 60px rgba(0,0,0,0.12)", border: "1px solid #e5e7eb", padding: 16 }}>
              <div style={{ borderRadius: 18, overflow: "hidden", border: "1px solid #e5e7eb", boxShadow: "0 12px 28px rgba(0,0,0,0.08)" }}>
                <MapContainer
                  bounds={bounds}
                  center={center}
                  style={{ width: "100%", height: "80dvh", background: "#e5e7eb" }}
                  dragging={false}
                  scrollWheelZoom={false}
                  doubleClickZoom={false}
                  touchZoom={false}
                  boxZoom={false}
                  keyboard={false}
                  zoomControl={false}
                  maxBounds={bounds}
                  maxBoundsViscosity={1.0}
                >
                  <TileLayer
                    attribution="&copy; OpenStreetMap contributors"
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />
                  <FitView bounds={bounds} />
                  <Polygon positions={polygon.map((p) => [p[1], p[0]] as [number, number])} pathOptions={{ color: "#0ea5e9", weight: 2, fillColor: "#0ea5e9", fillOpacity: 0.07 }} />
                  <HeatLayer points={heatPoints} radius={radius} blur={blur} />
                  {topHotspots.map((h, idx) => (
                    <CircleMarker key={idx} center={[h.lat, h.lng]} radius={10} pathOptions={{ color: "#111827", weight: 1, fillColor: "#ef4444", fillOpacity: 0.95 }} />
                  ))}
                </MapContainer>
              </div>
              <div style={{ fontSize: 12, color: "#6b7280", marginTop: 8 }}>
                Vermelho indica maior indício de problemas.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
