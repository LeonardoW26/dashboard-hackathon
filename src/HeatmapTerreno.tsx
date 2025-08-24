import L from "leaflet";
import "leaflet.heat";
import "leaflet/dist/leaflet.css";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { CircleMarker, MapContainer, Pane, Polygon, TileLayer, useMap } from "react-leaflet";

type Passada = "pre" | "plantio" | "adubo";
type ClasseDeteccao = "erva" | "doenca";

type LatLng = [number, number];             
type LatLngLeaflet = [number, number];       
type PolygonLngLat = LatLng[];

interface Hotspot {
  lng: number;
  lat: number;
  amp: number;
  spread: number;
  passada: Passada;
}

interface Detection {
  id: string;
  lat: number;
  lng: number;
  ts: string;
  passada: Passada;
  classe: ClasseDeteccao;
  conf: number;
  img: string;
}

const ASSET = {
  ERVA: "https://ihara.com.br/wp-content/uploads/sites/54/2021/12/sementes-de-capim-amargoso-leon-levy-foundation-banner-530x398-1-aspect-ratio-530-398-1.jpg",
  DOENCA: "https://altadefensivos.com.br/wp-content/uploads/2025/05/Design-sem-nome-3-1024x576.jpg.webp",
} as const;

const UI = {
  CARD_RADIUS: 16,
  SHADOW: "0 18px 40px rgba(0,0,0,0.08)",
  BORDER: "1px solid #e5e7eb",
} as const;

const HEAT = {
  MAX_SAMPLES: 30000,
  THRESHOLD: 0.65,
  GRADIENT: { 0.0: "#22c55e", 0.35: "#eab308", 0.7: "#ef4444", 1.0: "#7f1d1d" } as Record<number, string>,
} as const;

const EX_POLYGON: PolygonLngLat = [
  [-52.7798284, -26.2730886],
  [-52.7678284, -26.2730886],
  [-52.7678284, -26.2820886],
  [-52.7798284, -26.2820886],
];

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function pointInPolygon(point: LatLng, polygon: PolygonLngLat) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function seededRand(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const metersToDegreesLat = (m: number) => m / 111320;
const metersToDegreesLng = (m: number, lat: number) => m / (111320 * Math.cos((lat * Math.PI) / 180));

const svgDataURI = (label: string, color: string) => {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='360' height='220'><defs><linearGradient id='g' x1='0' x2='1' y1='0' y2='1'><stop offset='0' stop-color='${color}' stop-opacity='0.15'/><stop offset='1' stop-color='${color}' stop-opacity='0.55'/></linearGradient></defs><rect width='100%' height='100%' fill='url(#g)'/><circle cx='60' cy='60' r='36' fill='${color}'/><text x='120' y='70' font-family='Arial, Helvetica, sans-serif' font-size='22' fill='#0f172a'>${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

function generateHotspots(params: {
  polygon: PolygonLngLat;
  count: number;
  seed: number;
  ampRange?: [number, number];
  spreadRange?: [number, number];
  passada?: Passada;
}): Hotspot[] {
  const { polygon, count, seed, ampRange = [0.6, 1.0], spreadRange = [25, 80], passada = "pre" } = params;
  const rnd = seededRand(seed);
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs);
  const miny = Math.min(...ys), maxy = Math.max(...ys);

  const out: Hotspot[] = [];
  let tries = 0;
  while (out.length < count && tries < 5000) {
    tries++;
    const lng = minx + rnd() * (maxx - minx);
    const lat = miny + rnd() * (maxy - miny);
    if (!pointInPolygon([lng, lat], polygon)) continue;
    const amp = ampRange[0] + rnd() * (ampRange[1] - ampRange[0]);
    const spread = spreadRange[0] + rnd() * (spreadRange[1] - spreadRange[0]);
    out.push({ lng, lat, amp, spread, passada });
  }
  return out;
}

function sampleHeatPoints(params: {
  polygon: PolygonLngLat;
  hotspots: Pick<Hotspot, "lng" | "lat" | "amp" | "spread">[];
  seed: number;
  samples: number;
}): [number, number, number][] {
  const { polygon, hotspots, seed, samples } = params;
  const rnd = seededRand(seed ^ 0x9e3779b1);
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs);
  const miny = Math.min(...ys), maxy = Math.max(...ys);

  const points: [number, number, number][] = [];
  const target = Math.min(samples, HEAT.MAX_SAMPLES);

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
    points.push([lat, lng, Number(clamp(w, 0, 1).toFixed(3))]);
    generated++;
  }
  return points;
}

function makeDetections(hotspots: Hotspot[], polygon: PolygonLngLat, seed: number): Detection[] {
  const rnd = seededRand(seed ^ 0x1b873593);
  const detections: Detection[] = [];

  for (const h of hotspots) {
    const cluster = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < cluster; i++) {
      const jitterM = h.spread * (0.35 + rnd() * 0.4);
      const dx = (rnd() - 0.5) * 2 * metersToDegreesLng(jitterM, h.lat);
      const dy = (rnd() - 0.5) * 2 * metersToDegreesLat(jitterM);
      let lng = h.lng + dx;
      let lat = h.lat + dy;
      if (!pointInPolygon([lng, lat], polygon)) {
        lng = h.lng; lat = h.lat;
      }
      const classe: ClasseDeteccao = rnd() < 0.75 ? "erva" : "doenca";
      const conf = Math.round((0.6 + rnd() * 0.38) * 100) / 100;
      const ts = new Date(Date.now() - Math.floor(rnd() * 72) * 3600 * 1000).toISOString();
      const img = classe === "erva" ? ASSET.ERVA : ASSET.DOENCA;

      detections.push({
        id: `${h.lng.toFixed(5)}_${h.lat.toFixed(5)}_${i}`,
        lat,
        lng,
        ts,
        passada: h.passada,
        classe,
        conf,
        img,
      });
    }
  }
  return detections;
}

const Progress = memo(function Progress({ value }: { value: number }) {
  return (
    <div style={{ width: "100%", height: 8, borderRadius: 999, background: "#f1f5f9" }}>
      <div
        style={{
          width: `${clamp(value, 0, 100)}%`,
          height: "100%",
          borderRadius: 999,
          background: "linear-gradient(90deg,#22c55e,#eab308,#ef4444)",
        }}
      />
    </div>
  );
});

const Sparkline = memo(function Sparkline({ data, stroke = "#0ea5e9" }: { data: number[]; stroke?: string }) {
  const w = 160, h = 40, p = 4;
  if (!data.length) return <svg width={w} height={h} />;
  const min = Math.min(...data), max = Math.max(...data);
  const scaleX = (i: number) => p + (i * (w - 2 * p)) / (data.length - 1 || 1);
  const scaleY = (v: number) => h - p - ((v - min) / Math.max(1e-6, max - min)) * (h - 2 * p);
  const d = data.map((v, i) => `${i === 0 ? "M" : "L"} ${scaleX(i)} ${scaleY(v)}`).join(" ");
  return <svg width={w} height={h}><path d={d} fill="none" stroke={stroke} strokeWidth={2} /></svg>;
});

const IndicatorCard = memo(function IndicatorCard({
  title, value, subtitle, accent = "#0ea5e9", footer,
}: { title: string; value: string; subtitle?: string; accent?: string; footer?: React.ReactNode }) {
  return (
    <div style={{ background: "#fff", borderRadius: UI.CARD_RADIUS, border: UI.BORDER, boxShadow: UI.SHADOW, padding: 16 }}>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>{title}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontSize: 28, fontWeight: 700, color: "#0f172a" }}>{value}</div>
        <div style={{ width: 8, height: 8, borderRadius: 4, background: accent }} />
      </div>
      {subtitle ? <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>{subtitle}</div> : null}
      {footer ? <div style={{ marginTop: 10 }}>{footer}</div> : null}
    </div>
  );
});

const Chip = memo(function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "8px 12px",
        borderRadius: 999,
        border: UI.BORDER,
        background: active ? "#0ea5e9" : "#ffffff",
        color: active ? "#ffffff" : "#0f172a",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
});

function HeatLayer({
  points, radius = 15, blur = 20, maxZoom = 19, pane,
}: { points: [number, number, number][]; radius?: number; blur?: number; maxZoom?: number; pane?: string; }) {
  const map = useMap();
  useEffect(() => {
    const layer = (L as any).heatLayer(points, {
      radius, blur, maxZoom, pane,
      minOpacity: 0.25, maxOpacity: 0.95,
      gradient: HEAT.GRADIENT,
    });
    layer.addTo(map);
    return () => layer.remove();
  }, [map, points, radius, blur, maxZoom, pane]);
  return null;
}

function FitView({ bounds }: { bounds: L.LatLngBounds }) {
  const map = useMap();
  useEffect(() => { map.fitBounds(bounds, { padding: [20, 20] }); }, [map, bounds]);
  return null;
}

const EvidencePanel = memo(function EvidencePanel({ det, onClose }: { det: Detection; onClose: () => void }) {
  const date = new Date(det.ts);
  const tagBg = det.classe === "erva" ? "#16a34a" : "#ef4444";
  return (
    <div style={{ position: "absolute", right: 16, bottom: 16, zIndex: 2000, width: 420, background: "#fff", border: UI.BORDER, borderRadius: UI.CARD_RADIUS, boxShadow: "0 24px 60px rgba(0,0,0,0.18)", overflow: "hidden" }}>
      <div style={{ position: "relative" }}>
        <img
          src={det.img}
          alt="evidência"
          onError={(e) => { e.currentTarget.src = svgDataURI(det.classe === "erva" ? "Erva daninha" : "Doença", tagBg); }}
          style={{ width: "100%", height: 220, objectFit: "cover", display: "block" }}
        />
        <div style={{ position: "absolute", left: 12, bottom: 12, display: "flex", gap: 8 }}>
          <span style={{ padding: "6px 10px", borderRadius: 999, background: tagBg, color: "#fff", fontSize: 12, fontWeight: 700 }}>
            {det.classe === "erva" ? "Erva daninha" : "Doença"}
          </span>
          <span style={{ padding: "6px 10px", borderRadius: 999, background: "rgba(15,23,42,0.85)", color: "#fff", fontSize: 12, fontWeight: 700 }}>
            {det.passada.toUpperCase()}
          </span>
          <span style={{ padding: "6px 10px", borderRadius: 999, background: "rgba(15,23,42,0.65)", color: "#fff", fontSize: 12 }}>
            Confiança {(det.conf * 100).toFixed(0)}%
          </span>
        </div>
        <button
          onClick={onClose}
          aria-label="Fechar painel de evidência"
          style={{ position: "absolute", top: 8, right: 8, width: 32, height: 32, borderRadius: 16, background: "rgba(15,23,42,0.85)", color: "#fff", border: "none", cursor: "pointer", fontSize: 18, lineHeight: "32px" }}
        >
          ×
        </button>
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
});

const EconomicCard = memo(function EconomicCard(props: {
  doseLHa: number; setDoseLHa: (v: number) => void;
  precoPorL: number; setPrecoPorL: (v: number) => void;
  perdaHa: number; setPerdaHa: (v: number) => void;
  eficacia: number; setEficacia: (v: number) => void;
  areaTratada: number; custo: number; beneficio: number; roi: number;
}) {
  const { doseLHa, setDoseLHa, precoPorL, setPrecoPorL, perdaHa, setPerdaHa, areaTratada, custo, beneficio, roi } = props;

  return (
    <div style={{ background: "#fff", borderRadius: UI.CARD_RADIUS, border: UI.BORDER, boxShadow: UI.SHADOW, padding: 16 }}>
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
          <input type="number" value={doseLHa} min={0} step={0.1} onChange={(e) => setDoseLHa(Number(e.target.value))} style={{ width: "100%", border: UI.BORDER, borderRadius: 10, padding: "8px 10px" }} />
        </label>
        <label style={{ display: "grid", gap: 6 }}>
          <span>Preço (R$/L)</span>
          <input type="number" value={precoPorL} min={0} step={0.5} onChange={(e) => setPrecoPorL(Number(e.target.value))} style={{ width: "100%", border: UI.BORDER, borderRadius: 10, padding: "8px 10px" }} />
        </label>
        <label style={{ display: "grid", gap: 6 }}>
          <span>Perda estimada (R$/ha)</span>
          <input type="number" value={perdaHa} min={0} step={50} onChange={(e) => setPerdaHa(Number(e.target.value))} style={{ width: "100%", border: UI.BORDER, borderRadius: 10, padding: "8px 10px" }} />
        </label>
      </div>
    </div>
  );
});

export default function MapaCalorPropriedade() {
  const [seed] = useState(12345678);
  const [samples] = useState(10_000_000);
  const [radius] = useState(10);
  const [blur] = useState(40);
  const [hotspotCount] = useState(5);
  const [polygon] = useState<PolygonLngLat>(EX_POLYGON);

  const [selected, setSelected] = useState<Set<Passada>>(new Set<Passada>(["pre", "plantio", "adubo"]));
  const [detShown, setDetShown] = useState<Detection | null>(null);

  const [doseLHa, setDoseLHa] = useState(2);
  const [precoPorL, setPrecoPorL] = useState(45);
  const [perdaHa, setPerdaHa] = useState(600);
  const [eficacia, setEficacia] = useState(0.7);

  const togglePassada = useCallback((p: Passada) => {
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });
  }, []);

  const hotspotsPre = useMemo(() => generateHotspots({ polygon, count: hotspotCount, seed: seed + 11, passada: "pre" }), [polygon, hotspotCount, seed]);
  const hotspotsPlantio = useMemo(() => generateHotspots({ polygon, count: hotspotCount, seed: seed + 22, passada: "plantio" }), [polygon, hotspotCount, seed]);
  const hotspotsAdubo = useMemo(() => generateHotspots({ polygon, count: hotspotCount, seed: seed + 33, passada: "adubo" }), [polygon, hotspotCount, seed]);

  const hotspotsAll = useMemo<Hotspot[]>(() => [...hotspotsPre, ...hotspotsPlantio, ...hotspotsAdubo], [hotspotsPre, hotspotsPlantio, hotspotsAdubo]);
  const activeHotspots = useMemo<Hotspot[]>(() => hotspotsAll.filter((h) => selected.has(h.passada)), [hotspotsAll, selected]);

  const detectionsAll = useMemo(() => makeDetections(hotspotsAll, polygon, seed + 99), [hotspotsAll, polygon, seed]);
  const activeDetections = useMemo(() => detectionsAll.filter((d) => selected.has(d.passada)), [detectionsAll, selected]);
  const visibleDetections = useMemo(() => activeDetections.slice(0, 120), [activeDetections]);

  const effectiveSamples = useMemo(() => Math.min(samples, HEAT.MAX_SAMPLES), [samples]);
  const heatPoints = useMemo(
    () => sampleHeatPoints({ polygon, hotspots: activeHotspots, seed, samples: effectiveSamples }),
    [polygon, activeHotspots, seed, effectiveSamples]
  );

  const bounds = useMemo(() => L.latLngBounds(polygon.map((p) => [p[1], p[0]] as LatLngLeaflet)), [polygon]);
  const center = useMemo<LatLngLeaflet>(() => {
    const lat = polygon.reduce((s, p) => s + p[1], 0) / polygon.length;
    const lng = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
    return [lat, lng];
  }, [polygon]);

  const areaHa = useMemo(() => {
    const lngs = polygon.map((p) => p[0]);
    const lats = polygon.map((p) => p[1]);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const latCenter = (minLat + maxLat) / 2;
    const widthM = (maxLng - minLng) * 111320 * Math.cos((latCenter * Math.PI) / 180);
    const heightM = (maxLat - minLat) * 111320;
    return Number(((Math.abs(widthM * heightM)) / 10000).toFixed(2));
  }, [polygon]);

  const coverage = useMemo(() => {
    if (!heatPoints.length) return 0;
    const c = heatPoints.filter((p) => p[2] >= HEAT.THRESHOLD).length / heatPoints.length;
    return Number((c * 100).toFixed(1));
  }, [heatPoints]);

  const meanIntensity = useMemo(() => {
    if (!heatPoints.length) return 0;
    const sum = heatPoints.reduce((a, p) => a + p[2], 0);
    return Number(((sum / heatPoints.length) * 100).toFixed(1));
  }, [heatPoints]);

  const p95Intensity = useMemo(() => {
    if (!heatPoints.length) return 0;
    const arr = heatPoints.map((p) => p[2]).sort((a, b) => a - b);
    const idx = Math.floor(0.95 * (arr.length - 1));
    return Number((arr[idx] * 100).toFixed(1));
  }, [heatPoints]);

  const spreadPotential = useMemo(() => {
    if (!activeHotspots.length) return 0;
    const meanAmp = activeHotspots.reduce((a, h) => a + h.amp, 0) / activeHotspots.length;
    const meanSpread = activeHotspots.reduce((a, h) => a + h.spread, 0) / activeHotspots.length;
    return meanAmp * meanSpread;
  }, [activeHotspots]);

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

  const projDelta7d = useMemo(() => projection7d.length ? Number((projection7d.at(-1)! - projection7d[0]).toFixed(1)) : 0, [projection7d]);
  const growthPerDay = useMemo(() => Number((projDelta7d / 7).toFixed(2)), [projDelta7d]);
  const growthLabel = useMemo(() => `${growthPerDay >= 0 ? "+" : ""}${growthPerDay} pp/dia`, [growthPerDay]);

  const riskLabel = useMemo(() => {
    if (coverage >= 60) return { label: "Alto", color: "#ef4444" };
    if (coverage >= 30) return { label: "Médio", color: "#eab308" };
    return { label: "Baixo", color: "#22c55e" };
  }, [coverage]);

  const riskScore = useMemo(() => {
    const score = clamp(0.65 * coverage + 2.5 * Math.max(0, growthPerDay), 0, 100);
    let label = "Baixo", color = "#22c55e";
    if (score >= 70) { label = "Alto"; color = "#ef4444"; }
    else if (score >= 40) { label = "Médio"; color = "#eab308"; }
    return { score: Number(score.toFixed(0)), label, color };
  }, [coverage, growthPerDay]);

  const areaTratada = useMemo(() => Number(((coverage / 100) * areaHa).toFixed(2)), [coverage, areaHa]);
  const custo = useMemo(() => Number((areaTratada * doseLHa * precoPorL).toFixed(2)), [areaTratada, doseLHa, precoPorL]);
  const beneficio = useMemo(() => Number((areaTratada * perdaHa * eficacia).toFixed(2)), [areaTratada, perdaHa, eficacia]);
  const roi = useMemo(() => (custo > 0 ? Number((((beneficio - custo) / custo) * 100).toFixed(1)) : 0), [beneficio, custo]);

  const areaSeveraEq = useMemo(() => Number(((meanIntensity / 100) * areaHa).toFixed(2)), [meanIntensity, areaHa]);

  return (
    <div style={{ minHeight: "100dvh", background: "#f5f7fb", padding: 24 }}>
      <div style={{ width: "100%", margin: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(300px, 420px) 1fr", gap: 20 }}>
          <div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <Chip active={selected.has("pre")} onClick={() => togglePassada("pre")}>Pré</Chip>
              <Chip active={selected.has("plantio")} onClick={() => togglePassada("plantio")}>Plantio</Chip>
              <Chip active={selected.has("adubo")} onClick={() => togglePassada("adubo")}>Adubo</Chip>
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
              <IndicatorCard
                title="Severidade média"
                value={`${meanIntensity}%`}
                subtitle={`p95: ${p95Intensity}% • área severa eq.: ${areaSeveraEq} ha`}
                accent="#8b5cf6"
                footer={<Progress value={meanIntensity} />}
              />
              <IndicatorCard title="Área do talhão" value={`${areaHa} ha`} subtitle="polígono atual" accent="#0ea5e9" />
            </div>
          </div>

          <div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(180px, 1fr))", gap: 12, margin: "0 0 12px" }}>
              <IndicatorCard
                title="Crescimento estimado"
                value={growthLabel}
                subtitle={`Projeção 7d: ${projDelta7d >= 0 ? "+" : ""}${projDelta7d} pp`}
                accent="#0ea5e9"
                footer={<Sparkline data={projection7d} stroke="#0ea5e9" />}
              />
              <IndicatorCard
                title="Área crítica (≥ limiar)"
                value={`${areaTratada} ha`}
                subtitle={`${coverage}% da área`}
                accent="#ef4444"
                footer={<Progress value={coverage} />}
              />
              <IndicatorCard
                title="Focos ativos"
                value={`${activeHotspots.length}`}
                subtitle={`Densidade: ${Number((activeHotspots.length / Math.max(0.001, areaHa)).toFixed(2))} focos/ha • Risco ${riskLabel.label}`}
                accent={riskLabel.color}
              />
              <IndicatorCard
                title="Risco composto"
                value={riskScore.label}
                subtitle={`score ${riskScore.score}/100`}
                accent={riskScore.color}
                footer={<Progress value={riskScore.score} />}
              />
            </div>

            <div style={{ position: "relative" }}>
              <div style={{ borderRadius: 18, overflow: "hidden", border: UI.BORDER, boxShadow: "0 12px 28px rgba(0,0,0,0.08)" }}>
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
                  <Polygon positions={polygon.map((p) => [p[1], p[0]] as LatLngLeaflet)} pathOptions={{ color: "#0ea5e9", weight: 2, fillColor: "#0ea5e9", fillOpacity: 0.07 }} />
                  <Pane name="heat" style={{ zIndex: 350, pointerEvents: "none" }} />
                  <HeatLayer points={heatPoints} radius={radius} blur={blur} pane="heat" />

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
    </div>
  );
}
