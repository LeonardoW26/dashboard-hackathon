import L from "leaflet";
import "leaflet.heat";
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useState } from "react";
import { CircleMarker, MapContainer, Pane, Polygon, TileLayer, useMap, Marker, Polyline } from "react-leaflet";

type Passada = "pre" | "plantio" | "adubo";
type Detection = { id: string; lat: number; lng: number; ts: string; passada: Passada; classe: "erva" | "doenca"; conf: number; img: string };

const IMG_ERVA = "https://ihara.com.br/wp-content/uploads/sites/54/2021/12/sementes-de-capim-amargoso-leon-levy-foundation-banner-530x398-1-aspect-ratio-530-398-1.jpg";
const IMG_DOENCA = "https://altadefensivos.com.br/wp-content/uploads/2025/05/Design-sem-nome-3-1024x576.jpg.webp";

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

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
  const hotspots: { lng: number; lat: number; amp: number; spread: number; passada: Passada }[] = [];
  let tries = 0;
  while (hotspots.length < count && tries < 5000) {
    tries++;
    const lng = minx + rnd() * (maxx - minx);
    const lat = miny + rnd() * (maxy - miny);
    if (pointInPolygon([lng, lat], polygon)) {
      const amp = ampRange[0] + rnd() * (ampRange[1] - ampRange[0]);
      const spread = spreadRange[0] + rnd() * (spreadRange[1] - spreadRange[0]);
      hotspots.push({ lng, lat, amp, spread, passada: "pre" });
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
  const target = Math.min(samples, 30000);
  let generated = 0, guard = 0;
  while (generated < target && guard < target * 20) {
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

function HeatLayer({
  points,
  radius = 15,
  blur = 20,
  maxZoom = 19,
  pane,
}: {
  points: [number, number, number][];
  radius?: number;
  blur?: number;
  maxZoom?: number;
  pane?: string;
}) {
  const map = useMap();
  useEffect(() => {
    const layer = (L as any).heatLayer(points, {
      radius,
      blur,
      maxZoom,
      pane,
      minOpacity: 0.25,
      maxOpacity: 0.95,
      gradient: { 0.0: "#22c55e", 0.35: "#eab308", 0.7: "#ef4444", 1.0: "#7f1d1d" },
    });
    layer.addTo(map);
    return () => {
      layer.remove();
    };
  }, [map, points, radius, blur, maxZoom, pane]);
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

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ padding: "8px 12px", borderRadius: 999, border: "1px solid #e5e7eb", background: active ? "#0ea5e9" : "#ffffff", color: active ? "#ffffff" : "#0f172a", cursor: "pointer" }}>
      {children}
    </button>
  );
}

function svgDataURI(label: string, color: string) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='360' height='220'><defs><linearGradient id='g' x1='0' x2='1' y1='0' y2='1'><stop offset='0' stop-color='${color}' stop-opacity='0.15'/><stop offset='1' stop-color='${color}' stop-opacity='0.55'/></linearGradient></defs><rect width='100%' height='100%' fill='url(#g)'/><circle cx='60' cy='60' r='36' fill='${color}'/><text x='120' y='70' font-family='Arial, Helvetica, sans-serif' font-size='22' fill='#0f172a'>${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function makeDetections(hotspots: { lng: number; lat: number; spread: number; passada: Passada }[], polygon: [number, number][], seed: number): Detection[] {
  const rnd = mulberry32(seed ^ 0x1b873593);
  const detections: Detection[] = [];
  for (const h of hotspots) {
    const k = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < k; i++) {
      const jitterM = h.spread * (0.35 + rnd() * 0.4);
      const dx = (rnd() - 0.5) * 2 * metersToDegreesLng(jitterM, h.lat);
      const dy = (rnd() - 0.5) * 2 * metersToDegreesLat(jitterM);
      let lng = h.lng + dx;
      let lat = h.lat + dy;
      if (!pointInPolygon([lng, lat], polygon)) { lng = h.lng; lat = h.lat; }
      const classe: "erva" | "doenca" = rnd() < 0.75 ? "erva" : "doenca";
      const conf = Math.round((0.6 + rnd() * 0.38) * 100) / 100;
      const ts = new Date(Date.now() - Math.floor(rnd() * 72) * 3600 * 1000).toISOString();
      const img = classe === "erva" ? IMG_ERVA : IMG_DOENCA;
      detections.push({ id: `${h.lng.toFixed(5)}_${h.lat.toFixed(5)}_${i}`, lat, lng, ts, passada: h.passada, classe, conf, img });
    }
  }
  return detections;
}

function EconomicCard(props: {
  doseLHa: number; setDoseLHa: (v: number) => void;
  precoPorL: number; setPrecoPorL: (v: number) => void;
  perdaHa: number; setPerdaHa: (v: number) => void;
  eficacia: number; setEficacia: (v: number) => void;
  areaTratada: number; custo: number; beneficio: number; roi: number;
}) {
  const { doseLHa, setDoseLHa, precoPorL, setPrecoPorL, perdaHa, setPerdaHa, eficacia, setEficacia, areaTratada, custo, beneficio, roi } = props;
  return (
    <div style={{ background: "#fff", borderRadius: 16, border: "1px solid #e5e7eb", boxShadow: "0 18px 40px rgba(0,0,0,0.08)", padding: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <div style={{ fontSize: 12, color: "#6b7280" }}>Resumo econômico</div>
        <div style={{ fontSize: 28, fontWeight: 700, color: roi >= 0 ? "#16a34a" : "#ef4444" }}>{`${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%`}</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12, fontSize: 13, color: "#0f172a" }}>
        <div>
          <div style={{ fontSize: 12, color: "#64748b" }}>Área tratada</div>
          <div style={{ fontWeight: 700 }}>{areaTratada.toFixed(2)} ha</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: "#64748b" }}>Custo</div>
          <div style={{ fontWeight: 700 }}>{brl(custo)}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: "#64748b" }}>Benefício</div>
          <div style={{ fontWeight: 700 }}>{brl(beneficio)}</div>
        </div>
      </div>
      <div style={{ height: 1, background: "#e5e7eb", margin: "12px 0" }} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 12, color: "#334155" }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span>Dose (L/ha)</span>
          <input type="number" value={doseLHa} min={0} step={0.1} onChange={(e) => setDoseLHa(Number(e.target.value))} style={{ width: "100%", border: "1px solid #e5e7eb", borderRadius: 10, padding: "8px 10px" }} />
        </label>
        <label style={{ display: "grid", gap: 6 }}>
          <span>Preço (R$/L)</span>
          <input type="number" value={precoPorL} min={0} step={0.5} onChange={(e) => setPrecoPorL(Number(e.target.value))} style={{ width: "100%", border: "1px solid #e5e7eb", borderRadius: 10, padding: "8px 10px" }} />
        </label>
        <label style={{ display: "grid", gap: 6 }}>
          <span>Perda estimada (R$/ha)</span>
          <input type="number" value={perdaHa} min={0} step={50} onChange={(e) => setPerdaHa(Number(e.target.value))} style={{ width: "100%", border: "1px solid #e5e7eb", borderRadius: 10, padding: "8px 10px" }} />
        </label>
        <label style={{ display: "grid", gap: 6 }}>
          <span>Eficácia do controle</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="range" min={40} max={95} value={Math.round(eficacia * 100)} onChange={(e) => setEficacia(Number(e.target.value) / 100)} style={{ flex: 1 }} />
            <span style={{ width: 40, textAlign: "right" }}>{Math.round(eficacia * 100)}%</span>
          </div>
        </label>
      </div>
    </div>
  );
}

const EX_POLYGON: [number, number][] = [
  [-52.7798284, -26.2730886],
  [-52.7678284, -26.2730886],
  [-52.7678284, -26.2820886],
  [-52.7798284, -26.2820886],
];

function numIcon(n: number) {
  return L.divIcon({
    className: "",
    html: `<div style="width:28px;height:28px;border-radius:14px;background:#0ea5e9;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;border:2px solid #0c779f;box-shadow:0 2px 6px rgba(0,0,0,.25)">${n}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function haversine(a: [number, number], b: [number, number]) {
  const R = 6371000;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const A =
    s1 * s1 +
    Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(A)));
}

export default function MapaCalorPropriedade() {
  const [seed] = useState(1234567);
  const [samples] = useState(1000000);
  const [radius] = useState(15);
  const [blur] = useState(20);
  const [hotspotCount] = useState(8);
  const [polygon] = useState<[number, number][]>(EX_POLYGON);
  const [selected, setSelected] = useState<Set<Passada>>(new Set<Passada>(["pre", "plantio", "adubo"]));
  const [detShown, setDetShown] = useState<Detection | null>(null);

  const [doseLHa, setDoseLHa] = useState(2);
  const [precoPorL, setPrecoPorL] = useState(45);
  const [perdaHa, setPerdaHa] = useState(600);
  const [eficacia, setEficacia] = useState(0.7);

  const [gridSize, setGridSize] = useState(40);
  const [topN, setTopN] = useState(8);

  const hotspotsPre = useMemo(() => generateHotspots({ polygon, count: hotspotCount, seed: seed + 11 }).map(h => ({ ...h, passada: "pre" as Passada })), [polygon, hotspotCount, seed]);
  const hotspotsPlantio = useMemo(() => generateHotspots({ polygon, count: hotspotCount, seed: seed + 22 }).map(h => ({ ...h, passada: "plantio" as Passada })), [polygon, hotspotCount, seed]);
  const hotspotsAdubo = useMemo(() => generateHotspots({ polygon, count: hotspotCount, seed: seed + 33 }).map(h => ({ ...h, passada: "adubo" as Passada })), [polygon, hotspotCount, seed]);

  const hotspotsAll = useMemo(() => [...hotspotsPre, ...hotspotsPlantio, ...hotspotsAdubo], [hotspotsPre, hotspotsPlantio, hotspotsAdubo]);
  const activeHotspots = useMemo(() => hotspotsAll.filter(h => selected.has(h.passada)), [hotspotsAll, selected]);

  const detectionsAll = useMemo(() => makeDetections(hotspotsAll, polygon, seed + 99), [hotspotsAll, polygon, seed]);
  const activeDetections = useMemo(() => detectionsAll.filter(d => selected.has(d.passada)), [detectionsAll, selected]);
  const visibleDetections = useMemo(() => activeDetections.slice(0, 120), [activeDetections]);

  const effectiveSamples = useMemo(() => Math.min(samples, 30000), [samples]);
  const heatPoints = useMemo(
    () => sampleHeatPoints({ polygon, hotspots: activeHotspots, seed, samples: effectiveSamples }),
    [polygon, activeHotspots, seed, effectiveSamples]
  );

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

  const areaTratada = useMemo(() => Number(((coverage / 100) * areaHa).toFixed(2)), [coverage, areaHa]);
  const custo = useMemo(() => Number((areaTratada * doseLHa * precoPorL).toFixed(2)), [areaTratada, doseLHa, precoPorL]);
  const beneficio = useMemo(() => Number((areaTratada * perdaHa * eficacia).toFixed(2)), [areaTratada, perdaHa, eficacia]);
  const roi = useMemo(() => (custo > 0 ? Number((((beneficio - custo) / custo) * 100).toFixed(1)) : 0), [beneficio, custo]);

  const spreadPotential = useMemo(() => {
    if (!activeHotspots.length) return 0;
    const meanAmp = activeHotspots.reduce((a, h) => a + h.amp, 0) / activeHotspots.length;
    const meanSpread = activeHotspots.reduce((a, h) => a + h.spread, 0) / activeHotspots.length;
    return meanAmp * meanSpread;
  }, [activeHotspots]);

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

  function EvidencePanel({ det, onClose }: { det: Detection; onClose: () => void }) {
    const date = new Date(det.ts);
    const tagBg = det.classe === "erva" ? "#16a34a" : "#ef4444";
    const tagFg = "#fff";
    return (
      <div style={{ position: "absolute", right: 16, bottom: 16, zIndex: 2000, width: 420, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 16, boxShadow: "0 24px 60px rgba(0,0,0,0.18)", overflow: "hidden" }}>
        <div style={{ position: "relative" }}>
          <img
            src={det.img}
            alt="evidência"
            onError={(e) => { e.currentTarget.src = svgDataURI(det.classe === "erva" ? "Erva daninha" : "Doença", det.classe === "erva" ? "#16a34a" : "#ef4444"); }}
            style={{ width: "100%", height: 220, objectFit: "cover", display: "block" }}
          />
          <div style={{ position: "absolute", left: 12, bottom: 12, display: "flex", gap: 8 }}>
            <span style={{ padding: "6px 10px", borderRadius: 999, background: tagBg, color: tagFg, fontSize: 12, fontWeight: 700 }}>
              {det.classe === "erva" ? "Erva daninha" : "Doença"}
            </span>
            <span style={{ padding: "6px 10px", borderRadius: 999, background: "rgba(15,23,42,0.85)", color: "#fff", fontSize: 12, fontWeight: 700 }}>
              {det.passada.toUpperCase()}
            </span>
            <span style={{ padding: "6px 10px", borderRadius: 999, background: "rgba(15,23,42,0.65)", color: "#fff", fontSize: 12 }}>
              Confiança {(det.conf * 100).toFixed(0)}%
            </span>
          </div>
          <button onClick={onClose} style={{ position: "absolute", top: 8, right: 8, width: 32, height: 32, borderRadius: 16, background: "rgba(15,23,42,0.85)", color: "#fff", border: "none", cursor: "pointer", fontSize: 18, lineHeight: "32px" }}>×</button>
        </div>
        <div style={{ padding: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 13, color: "#334155" }}>
            <div>
              <div style={{ fontSize: 12, color: "#64748b" }}>Data e hora</div>
              <div style={{ fontWeight: 600 }}>{date.toLocaleString("pt-BR")}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#64748b" }}>Passada</div>
              <div style={{ fontWeight: 600 }}>{det.passada}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#64748b" }}>Latitude</div>
              <div style={{ fontWeight: 600 }}>{det.lat.toFixed(5)}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#64748b" }}>Longitude</div>
              <div style={{ fontWeight: 600 }}>{det.lng.toFixed(5)}</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const routeData = useMemo(() => {
    if (!heatPoints.length) return { cells: [], selected: [], path: [] as [number, number][], geojson: null as any, kml: "" };

    const lngs = polygon.map((p) => p[0]);
    const lats = polygon.map((p) => p[1]);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const latCenter = (minLat + maxLat) / 2;

    const dLng = metersToDegreesLng(gridSize, latCenter);
    const dLat = metersToDegreesLat(gridSize);

    const nx = Math.max(1, Math.ceil((maxLng - minLng) / dLng));
    const ny = Math.max(1, Math.ceil((maxLat - minLat) / dLat));

    const acc: Record<string, { wSum: number; wCount: number; det: number }> = {};

    for (const [lat, lng, w] of heatPoints) {
      const ix = Math.floor((lng - minLng) / dLng);
      const iy = Math.floor((lat - minLat) / dLat);
      if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) continue;
      const key = `${ix},${iy}`;
      if (!acc[key]) acc[key] = { wSum: 0, wCount: 0, det: 0 };
      acc[key].wSum += w;
      acc[key].wCount += 1;
    }

    for (const d of activeDetections) {
      const ix = Math.floor((d.lng - minLng) / dLng);
      const iy = Math.floor((d.lat - minLat) / dLat);
      if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) continue;
      const key = `${ix},${iy}`;
      if (!acc[key]) acc[key] = { wSum: 0, wCount: 0, det: 0 };
      acc[key].det += 1;
    }

    const cells: {
      ix: number; iy: number;
      lat: number; lng: number;
      wAvg: number; det: number; score: number;
      bbox: [number, number, number, number];
    }[] = [];

    let maxDet = 0;
    for (const k in acc) maxDet = Math.max(maxDet, acc[k].det);

    for (const k in acc) {
      const [ixStr, iyStr] = k.split(",");
      const ix = Number(ixStr), iy = Number(iyStr);
      const minx = minLng + ix * dLng;
      const miny = minLat + iy * dLat;
      const maxx = minx + dLng;
      const maxy = miny + dLat;
      const cx = (minx + maxx) / 2;
      const cy = (miny + maxy) / 2;
      if (!pointInPolygon([cx, cy], polygon)) continue;
      const a = acc[k];
      const wAvg = a.wCount ? a.wSum / a.wCount : 0;
      const detN = maxDet > 0 ? a.det / maxDet : 0;
      const score = 0.7 * wAvg + 0.3 * detN;
      cells.push({ ix, iy, lat: cy, lng: cx, wAvg, det: a.det, score, bbox: [minx, miny, maxx, maxy] });
    }

    cells.sort((a, b) => b.score - a.score);
    const selected = cells.slice(0, Math.min(topN, cells.length));

    if (!selected.length) return { cells, selected, path: [] as [number, number][], geojson: null as any, kml: "" };

    const remaining = [...selected];
    const path: { lat: number; lng: number }[] = [];
    let current = remaining.shift()!;
    path.push({ lat: current.lat, lng: current.lng });
    while (remaining.length) {
      let bestIdx = 0;
      let bestD = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = haversine([current.lat, current.lng], [remaining[i].lat, remaining[i].lng]);
        if (d < bestD) { bestD = d; bestIdx = i; }
      }
      current = remaining.splice(bestIdx, 1)[0];
      path.push({ lat: current.lat, lng: current.lng });
    }

    const features = selected.map((c, i) => {
      const [minx, miny, maxx, maxy] = c.bbox;
      const poly = [[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy], [minx, miny]].map(([x, y]) => [x, y]);
      return {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [poly.map(([lng, lat]) => [lng, lat])] },
        properties: { rank: i + 1, score: Number(c.score.toFixed(3)), wAvg: Number(c.wAvg.toFixed(3)), det: c.det, centroid: [c.lng, c.lat], gridSize },
      };
    });

    const line = {
      type: "Feature",
      geometry: { type: "LineString", coordinates: path.map(p => [p.lng, p.lat]) },
      properties: { name: "Roteiro de pulverização" }
    };

    const geojson = { type: "FeatureCollection", features: [...features, line] };

    const kmlHead = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>`;
    const kmlCells = selected.map((c, i) => {
      const [minx, miny, maxx, maxy] = c.bbox;
      const coords = `${minx},${miny},0 ${maxx},${miny},0 ${maxx},${maxy},0 ${minx},${maxy},0 ${minx},${miny},0`;
      return `<Placemark><name>${i + 1}</name><ExtendedData><Data name="score"><value>${c.score.toFixed(3)}</value></Data><Data name="wAvg"><value>${c.wAvg.toFixed(3)}</value></Data><Data name="det"><value>${c.det}</value></Data></ExtendedData><Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;
    }).join("");
    const kmlRoute = `<Placemark><name>Roteiro</name><Style><LineStyle><color>ff9f7f0c</color><width>3</width></LineStyle></Style><LineString><coordinates>${path.map(p => `${p.lng},${p.lat},0`).join(" ")}</coordinates></LineString></Placemark>`;
    const kml = `${kmlHead}${kmlCells}${kmlRoute}</Document></kml>`;

    return { cells, selected, path: path.map(p => [p.lat, p.lng] as [number, number]), geojson, kml };
  }, [heatPoints, activeDetections, polygon, gridSize, topN]);

  function download(name: string, content: string, mime: string) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ minHeight: "100dvh", background: "#f5f7fb", padding: 24 }}>
      <div style={{ width: "100%", margin: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(300px, 420px) 1fr", gap: 20 }}>
          <div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <Chip active={selected.has("pre")} onClick={() => setSelected(s => { const n = new Set(s); n.has("pre") ? n.delete("pre") : n.add("pre"); return n; })}>Pré</Chip>
              <Chip active={selected.has("plantio")} onClick={() => setSelected(s => { const n = new Set(s); n.has("plantio") ? n.delete("plantio") : n.add("plantio"); return n; })}>Plantio</Chip>
              <Chip active={selected.has("adubo")} onClick={() => setSelected(s => { const n = new Set(s); n.has("adubo") ? n.delete("adubo") : n.add("adubo"); return n; })}>Adubo</Chip>
            </div>
            <div style={{ display: "grid", gap: 16 }}>
              <EconomicCard
                doseLHa={doseLHa} setDoseLHa={setDoseLHa}
                precoPorL={precoPorL} setPrecoPorL={setPrecoPorL}
                perdaHa={perdaHa} setPerdaHa={setPerdaHa}
                eficacia={eficacia} setEficacia={setEficacia}
                areaTratada={areaTratada}
                custo={custo}
                beneficio={beneficio}
                roi={roi}
              />
              <IndicatorCard title="Tempo para espalhar (50% do talhão)" value={daysTo50} subtitle="Estimativa baseada na intensidade e dispersão atuais" accent="#0ea5e9" footer={<Progress value={coverage} />} />
              <IndicatorCard title="Área crítica (≥ limiar)" value={`${criticalHa} ha`} subtitle={`de ${areaHa} ha • ${coverage}% afetada`} accent="#ef4444" footer={<Progress value={coverage} />} />
              <IndicatorCard title="Focos ativos" value={`${activeHotspots.length}`} subtitle={`Densidade: ${Number((activeHotspots.length / Math.max(0.001, areaHa)).toFixed(2))} focos/ha • Risco ${riskLabel.label}`} accent={riskLabel.color} />
              <IndicatorCard title="Tendência (7 dias)" value={`${projection7d[projection7d.length - 1] || 0}%`} subtitle={`${projDelta7d >= 0 ? "+" : ""}${projDelta7d} pp vs hoje`} accent="#0ea5e9" footer={<Sparkline data={projection7d} stroke="#0ea5e9" />} />
              <IndicatorCard title="Severidade média" value={`${meanIntensity}%`} subtitle={`p95: ${p95Intensity}%`} accent="#8b5cf6" footer={<Progress value={meanIntensity} />} />
            </div>
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <div style={{ fontWeight: 700, color: "#0f172a" }}>Roteiro de pulverização</div>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#334155" }}>
                  Malha
                  <input type="number" min={20} step={10} value={gridSize} onChange={(e) => setGridSize(Math.max(10, Number(e.target.value)))} style={{ width: 72, border: "1px solid #e5e7eb", borderRadius: 8, padding: "6px 8px" }} />
                  m
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#334155" }}>
                  Top N
                  <input type="number" min={1} max={20} value={topN} onChange={(e) => setTopN(Math.max(1, Math.min(20, Number(e.target.value))))} style={{ width: 56, border: "1px solid #e5e7eb", borderRadius: 8, padding: "6px 8px" }} />
                </label>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => {
                    if (!routeData.geojson) return;
                    download("roteiro.geojson", JSON.stringify(routeData.geojson, null, 2), "application/geo+json");
                  }}
                  style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #e5e7eb", background: "#fff", cursor: "pointer" }}
                >
                  Exportar GeoJSON
                </button>
                <button
                  onClick={() => {
                    if (!routeData.kml) return;
                    download("roteiro.kml", routeData.kml, "application/vnd.google-earth.kml+xml");
                  }}
                  style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #e5e7eb", background: "#fff", cursor: "pointer" }}
                >
                  Exportar KML
                </button>
              </div>
            </div>

            <div style={{ position: "relative" }}>
              <div style={{ borderRadius: 18, overflow: "hidden", border: "1px solid #e5e7eb", boxShadow: "0 12px 28px rgba(0,0,0,0.08)" }}>
                <MapContainer
                  bounds={bounds}
                  center={center}
                  style={{ width: "100%", height: "76dvh", background: "#e5e7eb" }}
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
                  <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                  <FitView bounds={bounds} />
                  <Polygon positions={polygon.map((p) => [p[1], p[0]] as [number, number])} pathOptions={{ color: "#0ea5e9", weight: 2, fillColor: "#0ea5e9", fillOpacity: 0.07 }} />
                  <Pane name="heat" style={{ zIndex: 350, pointerEvents: "none" }} />
                  <HeatLayer points={heatPoints} radius={radius} blur={blur} pane="heat" />

                  {routeData.selected.map((c, i) => {
                    const [minx, miny, maxx, maxy] = c.bbox;
                    const rect = [
                      [miny, minx],
                      [miny, maxx],
                      [maxy, maxx],
                      [maxy, minx],
                    ] as [number, number][];
                    return (
                      <div key={`cell-${c.ix}-${c.iy}`}>
                        <Polygon positions={rect} pathOptions={{ color: "#0ea5e9", weight: 1, fillColor: "#0ea5e9", fillOpacity: 0.08 }} />
                        <Marker position={[c.lat, c.lng]} icon={numIcon(i + 1)} />
                      </div>
                    );
                  })}

                  {routeData.path.length > 1 && (
                    <Polyline positions={routeData.path} pathOptions={{ color: "#0ea5e9", weight: 3, opacity: 0.8 }} />
                  )}

                  {visibleDetections.map((d) => (
                    <CircleMarker
                      key={d.id}
                      center={[d.lat, d.lng]}
                      radius={7}
                      pane="markerPane"
                      pathOptions={{ color: "#111827", weight: 1, fillColor: d.classe === "erva" ? "#16a34a" : "#ef4444", fillOpacity: 0.95 }}
                      eventHandlers={{ click: () => setDetShown(d) }}
                    />
                  ))}
                </MapContainer>
              </div>

              <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8, fontSize: 12, color: "#6b7280" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 999, background: "#16a34a", display: "inline-block" }} />
                  Verde = erva daninha
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 999, background: "#ef4444", display: "inline-block" }} />
                  Vermelho = doença
                </span>
                <span style={{ marginLeft: "auto", fontSize: 12, color: "#334155" }}>
                  Top {topN} células priorizadas • malha {gridSize} m
                </span>
              </div>

              {detShown && (
                <>
                  <div onClick={() => setDetShown(null)} style={{ position: "absolute", inset: 0, background: "rgba(15,23,42,0.3)", zIndex: 1500 }} />
                  <EvidencePanel det={detShown} onClose={() => setDetShown(null)} />
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div >
  );
}
