import { useState } from "react";
import { analyzeSite } from "@/api/analysis";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Activity,
  Compass,
  Droplets,
  MapPin,
  SunMedium,
  Thermometer,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  useMapEvents,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { jsPDF } from "jspdf";
import { cn, cleanMarkdownBold } from "@/lib/utils";

interface SiteMetrics {
  temperature: number;
  ph: number;
  radiation: number;
  salinity: number;
}

type ProteinLevel = "Low" | "Medium" | "High";

interface ProteinPrediction {
  level: ProteinLevel;
  score: number; // 0–100 confidence
}

interface GrowthPoint {
  day: number;
  doublingTime: number;
}

const IDEAL_METRICS: SiteMetrics = {
  temperature: 30,
  ph: 9.0,
  radiation: 16, // MJ/m²/day, aligned to biological standards
  salinity: 3,
};

const DEFAULT_GROWTH_SERIES: GrowthPoint[] = Array.from(
  { length: 14 },
  (_, idx) => ({
    day: idx + 1,
    doublingTime: 2.1 + Math.sin(idx / 2) * 0.25,
  }),
);

type Coordinates = { lat: number; lng: number };

const extractKeyPoints = (cleaned: string): string[] => {
  if (!cleaned) return [];

  const rawLines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const isBullet = (line: string) =>
    line.startsWith("*") || line.startsWith("-") || /^[0-9]+\./.test(line);

  // Prefer explicit bullets; strip markers and drop empty/very short items.
  const cleanedBullets = rawLines
    .filter(isBullet)
    .map((line) => line.replace(/^[\*\-\d\.\)\s]+/, "").trim())
    .filter((line) => line.length >= 5);

  const fallbackLines = rawLines
    .map((line) => line.replace(/^[\*\-\d\.\)\s]+/, "").trim())
    .filter((line) => line.length >= 5);

  const source = cleanedBullets.length > 0 ? cleanedBullets : fallbackLines;

  return source.slice(0, 6);
};

const MapClickHandler: React.FC<{
  onSelect: (coords: Coordinates) => void;
}> = ({ onSelect }) => {
  useMapEvents({
    click(e) {
      onSelect({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
};

const Dashboard = () => {
  const [locationText, setLocationText] = useState("");
  const [coordinates, setCoordinates] = useState<Coordinates | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [siteMetrics, setSiteMetrics] = useState<SiteMetrics | null>(null);
  const [proteinPrediction, setProteinPrediction] =
    useState<ProteinPrediction | null>(null);
  const [growthSeries, setGrowthSeries] =
    useState<GrowthPoint[]>(DEFAULT_GROWTH_SERIES);

  const [reportLocationLabel, setReportLocationLabel] = useState("");
  const [phdReport, setPhdReport] = useState("");

  const [hasRunAnalysis, setHasRunAnalysis] = useState(false);

  const hasCoordinates = Boolean(coordinates);

  const extractSiteMetrics = (analysisRoot: any): SiteMetrics | null => {
    const inner = analysisRoot?.analysis ?? analysisRoot ?? {};
    const climate = inner.climate ?? {};
    const water = inner.water_profile ?? {};

    const temperature = Number(
      climate.temperature ?? climate.avg_temperature ?? climate.T2M,
    );
    const radiation = Number(
      climate.solar_radiation ?? climate.radiation ?? climate.ALLSKY_SFC_SW_DWN,
    );
    const ph = Number(
      water.initial_pH ?? water.ph ?? water.pH,
    );
    const salinity = Number(
      water.salinity ?? water.SALINITY,
    );

    if (
      !Number.isFinite(temperature) ||
      !Number.isFinite(radiation) ||
      !Number.isFinite(ph) ||
      !Number.isFinite(salinity)
    ) {
      return null;
    }

    return {
      temperature,
      ph,
      radiation,
      salinity,
    };
  };

  const extractProteinPrediction = (analysisRoot: any): ProteinPrediction | null => {
    const inner = analysisRoot?.analysis ?? analysisRoot ?? {};
    const biomass = inner.biomass_prediction ?? {};

    // 1) Try using explicit class probabilities from the ML model
    const confidence = biomass.confidence;
    if (Array.isArray(confidence) && confidence.length >= 3) {
      const bands: ProteinLevel[] = ["Low", "Medium", "High"];
      let maxIdx = 0;
      let maxVal = Number(confidence[0]) || 0;

      confidence.forEach((v: any, idx: number) => {
        const num = Number(v);
        if (Number.isFinite(num) && num > maxVal) {
          maxVal = num;
          maxIdx = idx;
        }
      });

      const score = Number.isFinite(maxVal) ? maxVal * 100 : 0;
      return {
        level: bands[Math.min(maxIdx, bands.length - 1)],
        score: Number(score.toFixed(1)),
      };
    }

    // 2) Fallback: map numeric biomass_prediction into bands
    const raw = Number(biomass.biomass_prediction);
    if (Number.isFinite(raw)) {
      let level: ProteinLevel;
      if (raw < 30) level = "Low";
      else if (raw < 70) level = "Medium";
      else level = "High";

      return {
        level,
        score: 70,
      };
    }

    // 3) Final fallback: use cultivation_status as a proxy
    const status = inner.cultivation_status;
    if (status === "INVALID") {
      return { level: "Low", score: 60 };
    }
    if (status === "MARGINAL") {
      return { level: "Medium", score: 65 };
    }
    if (status === "VALID") {
      return { level: "High", score: 80 };
    }

    return null;
  };

  const generateGrowthSeriesFromMetrics = (
    metrics: SiteMetrics | null,
  ): GrowthPoint[] => {
    if (!metrics) {
      return DEFAULT_GROWTH_SERIES;
    }

    const tempScore = metrics.temperature;
    const radiationScore = metrics.radiation;

    // Simple, interpretable heuristic: closer to ideal ⇒ faster doubling
    const tempDelta = Math.abs(tempScore - IDEAL_METRICS.temperature);
    const radDelta = Math.abs(radiationScore - IDEAL_METRICS.radiation);

    const penalty = (tempDelta * 0.03 + radDelta * 0.02);
    const baseDoubling = Math.max(1.2, Math.min(3.5, 1.8 + penalty));

    return Array.from({ length: 14 }, (_, idx) => {
      const day = idx + 1;
      const seasonal = Math.sin(day / 2.5) * 0.1;
      const value = Number((baseDoubling + seasonal).toFixed(2));

      return {
        day,
        doublingTime: value,
      };
    });
  };

  const getProteinUseCase = (level: ProteinLevel | undefined): string | null => {
    if (!level) return null;
    if (level === "Low") {
      return "Primarily suitable for animal / cow feed applications.";
    }
    if (level === "Medium") {
      return "Well-suited for human food and nutraceutical products.";
    }
    return "Suitable for high-value medicinal or pharmaceutical-grade formulations.";
  };

  const getProteinVisual = (
    level: ProteinLevel | undefined,
  ): { label: string; description: string; toneClass: string } | null => {
    if (!level) return null;

    if (level === "Low") {
      return {
        label: "Animal / Cow Feed Grade",
        description:
          "Best channelled into cattle, poultry and aquaculture feed formulations.",
        toneClass: "from-amber-50 via-orange-50 to-emerald-50 border-amber-200",
      };
    }

    if (level === "Medium") {
      return {
        label: "Food · Smoothies · Snacks",
        description:
          "Balanced protein profile for spirulina biscuits, smoothies and daily nutrition foods.",
        toneClass: "from-sky-50 via-emerald-50 to-lime-50 border-sky-200",
      };
    }

    return {
      label: "Medicinal / Pharma Grade",
      description:
        "High potency biomass suitable for capsules, extracts and clinical-grade products.",
      toneClass: "from-emerald-50 via-teal-50 to-slate-50 border-emerald-300",
    };
  };

  const handleDownloadReport = () => {
    if (!cleanedReport && !phdReport) return;

    const locationLabel =
      reportLocationLabel || locationText || "Spirulina cultivation site";

    const doc = new jsPDF();
    let y = 16;

    doc.setFontSize(14);
    doc.text("Spirulina Site Analysis Report", 14, y);
    y += 8;

    doc.setFontSize(11);
    doc.text(`Location: ${locationLabel}`, 14, y);
    y += 8;

    if (siteMetrics) {
      doc.setFont(undefined, "bold");
      doc.text("Environmental snapshot", 14, y);
      doc.setFont(undefined, "normal");
      y += 6;

      const envLines = [
        `Average temperature: ${siteMetrics.temperature.toFixed(2)} °C`,
        `Solar radiation: ${siteMetrics.radiation.toFixed(
          2,
        )} MJ/m²/day (ALLSKY_SFC_SW_DWN)`,
        `Alkalinity / pH: ${siteMetrics.ph.toFixed(2)}`,
        `Salinity: ${siteMetrics.salinity.toFixed(2)} %`,
      ];
      envLines.forEach((line) => {
        const wrapped = doc.splitTextToSize(line, 180);
        doc.text(wrapped, 16, y);
        y += wrapped.length * 5;
      });
      y += 2;
    }

    if (proteinPrediction) {
      const useCase = getProteinUseCase(proteinPrediction.level);
      doc.setFont(undefined, "bold");
      doc.text("Protein content band", 14, y);
      doc.setFont(undefined, "normal");
      y += 6;

      const lines = [
        `Band: ${proteinPrediction.level}`,
        `Band strength: ${proteinPrediction.score.toFixed(1)}%`,
        useCase ? `Primary application: ${useCase}` : null,
      ].filter(Boolean) as string[];

      lines.forEach((line) => {
        const wrapped = doc.splitTextToSize(line, 180);
        doc.text(wrapped, 16, y);
        y += wrapped.length * 5;
      });
      y += 2;
    }

    const keyPoints = extractKeyPoints(cleanedReport || phdReport);
    if (keyPoints.length) {
      doc.setFont(undefined, "bold");
      doc.text("Key technical recommendations", 14, y);
      doc.setFont(undefined, "normal");
      y += 6;

      keyPoints.forEach((pt) => {
        const wrapped = doc.splitTextToSize(`• ${pt}`, 180);
        doc.text(wrapped, 16, y);
        y += wrapped.length * 5;
      });
    }

    const safeName = locationLabel.replace(/[^\w\-]+/g, "_");
    doc.save(`spirulina_site_report_${safeName || "site"}.pdf`);
  };

  const handleAnalyze = async () => {
    const hasLocationInput = locationText.trim().length > 0;

    if (!hasLocationInput && !coordinates) {
      setError("Please provide a location name or select a point on the map.");
      return;
    }

    const synthesizedLocation = coordinates
      ? `${locationText || "Selected Site"} (${coordinates.lat.toFixed(
          3,
        )}, ${coordinates.lng.toFixed(3)})`
      : locationText.trim();

    try {
      setIsLoading(true);
      setError(null);

      const response = await analyzeSite({
        location: synthesizedLocation,
      });

      const payload: any = response.data ?? {};

      const mlWrapper = payload.analysis ?? payload.data ?? payload;
      const analysisBlock = mlWrapper?.analysis ?? mlWrapper ?? {};

      const rawSummary: string =
        analysisBlock?.formatted_text?.join("\n\n") ??
        analysisBlock?.summary ??
        "";

      setPhdReport(rawSummary);
      setReportLocationLabel(mlWrapper?.location ?? synthesizedLocation);

      const extractedMetrics = extractSiteMetrics(mlWrapper);
      const extractedProtein = extractProteinPrediction(mlWrapper);

      setSiteMetrics(extractedMetrics);
      setProteinPrediction(extractedProtein);
      setGrowthSeries(generateGrowthSeriesFromMetrics(extractedMetrics));
      setHasRunAnalysis(true);
    } catch (err) {
      setError("Unable to analyze this site at the moment. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const radarData = (() => {
    const current = siteMetrics ?? IDEAL_METRICS;

    return [
      {
        metric: "Temperature (°C)",
        site: current.temperature,
        ideal: IDEAL_METRICS.temperature,
      },
      {
        metric: "pH",
        site: current.ph,
        ideal: IDEAL_METRICS.ph,
      },
      {
        metric: "Radiation (W/m²)",
        site: current.radiation,
        ideal: IDEAL_METRICS.radiation,
      },
      {
        metric: "Salinity (PSU)",
        site: current.salinity,
        ideal: IDEAL_METRICS.salinity,
      },
    ];
  })();

  const proteinNumericLevel =
    proteinPrediction?.level === "Low"
      ? 1
      : proteinPrediction?.level === "Medium"
        ? 2
        : proteinPrediction?.level === "High"
          ? 3
          : 0;

  const proteinData = [
    {
      name: "Protein Content Index",
      value: proteinNumericLevel,
    },
  ];

  const cleanedReport = cleanMarkdownBold(phdReport);
  const keyPoints = extractKeyPoints(cleanedReport);

  return (
    <div className="min-h-screen bg-gradient-to-b from-emerald-50 via-slate-50 to-slate-100 px-4 py-6 md:px-8">
      <header className="mx-auto flex max-w-6xl flex-col gap-3 border-b border-emerald-100 pb-4 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500 text-white shadow-sm">
              <Activity className="h-4 w-4" />
            </span>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
              Spirulina Agro-Tech
            </p>
          </div>
          <h1 className="mt-3 text-balance text-2xl font-semibold tracking-tight text-slate-900 md:text-3xl">
            Spirulina Cultivation Intelligence Dashboard
          </h1>
          <p className="mt-1 text-sm text-slate-600 md:text-base">
            NASA-powered environmental data, ML-driven protein prediction, and
            expert site suitability insights in one clean, responsive view.
          </p>
        </div>
        <div className="mt-3 flex items-center gap-3 md:mt-0">
          <Badge className="bg-emerald-100 text-xs font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200">
            Real-time suitability
          </Badge>
          <Badge
            variant="outline"
            className="border-emerald-200 bg-white/60 text-xs text-slate-700"
          >
            AI Analysis Mode
          </Badge>
        </div>
      </header>

      <main className="mx-auto mt-6 flex max-w-6xl flex-col gap-6">
        {/* LOCATION & MAP */}
        <section className="grid gap-6 xl:grid-cols-3">
          <Card className="xl:col-span-2 border-emerald-100/70 bg-white/80 shadow-sm backdrop-blur">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center justify-between text-base font-semibold text-slate-900 md:text-lg">
                <span>Site Selection</span>
                <span className="flex items-center gap-2 text-xs font-medium text-emerald-700">
                  <Compass className="h-4 w-4" />
                  Dual-location input
                </span>
              </CardTitle>
              <CardDescription className="text-xs md:text-sm">
                Search by address or click anywhere on the agro-climatic map.
                Both inputs are kept perfectly in sync.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-col gap-3 md:flex-row">
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="location-text" className="text-xs md:text-sm">
                    Location search
                  </Label>
                  <Input
                    id="location-text"
                    value={locationText}
                    onChange={(e) => setLocationText(e.target.value)}
                    placeholder="e.g. Nashik, Maharashtra · Inland raceway ponds"
                    className="h-10 border-emerald-100 bg-white/80 text-sm placeholder:text-slate-400 focus-visible:ring-emerald-500/70"
                  />
                  <p className="text-[11px] text-slate-500">
                    Supports city, coordinates, or descriptive site labels.
                  </p>
                </div>

                <div className="flex w-full flex-col justify-end gap-2 md:w-40">
                  <Label className="text-xs md:text-sm">Coordinates</Label>
                  <div className="flex items-center justify-between rounded-md border border-emerald-100 bg-emerald-50/70 px-3 py-2 text-[11px] font-medium text-emerald-800 shadow-sm">
                    <div className="flex flex-col">
                      <span>
                        Lat:{" "}
                        {hasCoordinates
                          ? coordinates?.lat.toFixed(3)
                          : "— — —"}
                      </span>
                      <span>
                        Lng:{" "}
                        {hasCoordinates
                          ? coordinates?.lng.toFixed(3)
                          : "— — —"}
                      </span>
                    </div>
                    <MapPin className="h-4 w-4 text-emerald-700" />
                  </div>
                </div>
              </div>

              <div className="mt-2 overflow-hidden rounded-xl border border-emerald-200 bg-slate-50 shadow-inner">
                <MapContainer
                  center={[20.5937, 78.9629]}
                  zoom={4}
                  className="h-56 w-full"
                  style={{ backgroundColor: "#ecfdf5" }}
                  scrollWheelZoom={true}
                >
                  <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />

                  {coordinates && (
                    <CircleMarker
                      center={[coordinates.lat, coordinates.lng]}
                      radius={8}
                      pathOptions={{
                        color: "#10b981",
                        fillColor: "#10b981",
                        fillOpacity: 0.9,
                      }}
                    />
                  )}

                  <MapClickHandler
                    onSelect={(coords) => {
                      setCoordinates(coords);
                      if (!locationText) {
                        setLocationText(
                          `Lat ${coords.lat.toFixed(3)}, Lng ${coords.lng.toFixed(
                            3,
                          )}`,
                        );
                      }
                    }}
                  />
                </MapContainer>
              </div>

              <div className="flex flex-col items-start justify-between gap-3 pt-2 md:flex-row md:items-center">
                <p className="text-xs text-slate-500">
                  The analysis combines climatic norms, expected radiation load,
                  and cultivation system suitability for Spirulina raceway
                  ponds.
                </p>
                <Button
                  onClick={handleAnalyze}
                  disabled={isLoading || (!locationText && !coordinates)}
                  className="inline-flex items-center gap-2 bg-emerald-600 px-5 text-sm font-medium text-emerald-50 shadow-md hover:bg-emerald-700"
                >
                  {isLoading ? (
                    <>
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-100 border-t-emerald-700" />
                      Fetching NASA & LLM insights…
                    </>
                  ) : (
                    <>
                      <Activity className="h-4 w-4" />
                      Run Site Suitability
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="border-emerald-100/70 bg-slate-950/90 bg-[radial-gradient(circle_at_10%_20%,rgba(16,185,129,0.45),transparent_55%),radial-gradient(circle_at_80%_80%,rgba(15,23,42,0.9),transparent_60%)] text-slate-50 shadow-lg">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-sm font-semibold md:text-base">
                <span>Real-time Site Snapshot</span>
                <Badge className="bg-emerald-500/90 text-[11px] font-medium text-emerald-50 shadow-sm">
                  Live model
                </Badge>
              </CardTitle>
              <CardDescription className="text-[11px] text-emerald-100/80">
                Key climate and water variables aligned to the Spirulina growth
                envelope.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {isLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-4 w-1/2 bg-emerald-200/40" />
                  <div className="grid grid-cols-3 gap-3">
                    <Skeleton className="h-16 rounded-xl bg-emerald-200/30" />
                    <Skeleton className="h-16 rounded-xl bg-emerald-200/30" />
                    <Skeleton className="h-16 rounded-xl bg-emerald-200/30" />
                  </div>
                  <Skeleton className="h-10 w-full rounded-xl bg-emerald-200/25" />
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between text-xs text-emerald-100/90">
                    <span className="flex items-center gap-1.5">
                      <MapPin className="h-3.5 w-3.5 text-emerald-200" />
                      {reportLocationLabel || "Awaiting a site selection"}
                    </span>
                    {proteinPrediction && (
                      <span className="flex items-center gap-1 rounded-full bg-emerald-400/20 px-2 py-0.5 text-[11px] font-medium">
                        ML Protein:{" "}
                        <span className="font-semibold">
                          {proteinPrediction.level}
                        </span>
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div className="flex flex-col gap-1 rounded-xl bg-white/5 px-3 py-2">
                      <div className="flex items-center justify-between text-[11px] text-emerald-100">
                        <span className="flex items-center gap-1">
                          <Thermometer className="h-3.5 w-3.5 text-amber-300" />
                          Temp
                        </span>
                        <span className="text-[10px] text-emerald-200/80">
                          {IDEAL_METRICS.temperature}° ideal
                        </span>
                      </div>
                      <p className="text-sm font-semibold text-emerald-50">
                        {siteMetrics
                          ? `${siteMetrics.temperature.toFixed(1)}° C`
                          : "— — —"}
                      </p>
                    </div>

                    <div className="flex flex-col gap-1 rounded-xl bg-white/5 px-3 py-2">
                      <div className="flex items-center justify-between text-[11px] text-emerald-100">
                        <span className="flex items-center gap-1">
                          <Droplets className="h-3.5 w-3.5 text-sky-300" />
                          Alkalinity
                        </span>
                        <span className="text-[10px] text-emerald-200/80">
                          pH {IDEAL_METRICS.ph.toFixed(1)} ideal
                        </span>
                      </div>
                      <p className="text-sm font-semibold text-emerald-50">
                        {siteMetrics ? `pH ${siteMetrics.ph.toFixed(1)}` : "— — —"}
                      </p>
                    </div>

                    <div className="flex flex-col gap-1 rounded-xl bg-white/5 px-3 py-2">
                      <div className="flex items-center justify-between text-[11px] text-emerald-100">
                        <span className="flex items-center gap-1">
                          <SunMedium className="h-3.5 w-3.5 text-yellow-300" />
                          Irradiance
                        </span>
                        <span className="text-[10px] text-emerald-200/80">
                          {IDEAL_METRICS.radiation} MJ/m²/day ideal
                        </span>
                      </div>
                      <p className="text-sm font-semibold text-emerald-50">
                        {siteMetrics
                          ? `${siteMetrics.radiation.toFixed(2)} MJ/m²/day`
                          : "— — —"}
                      </p>
                    </div>
                  </div>

                  <div className="rounded-xl bg-emerald-500/15 px-3 py-2 text-[11px] text-emerald-100">
                    {proteinPrediction ? (
                      <>
                        <span className="font-semibold">
                          Protein band:
                        </span>{" "}
                        {proteinPrediction.level} (
                        {proteinPrediction.score.toFixed(1)}% band strength).{" "}
                        {getProteinUseCase(proteinPrediction.level)}
                      </>
                    ) : (
                      <>
                        ML and NASA data will populate this tile once you run a
                        site analysis for a selected location.
                      </>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </section>

        {/* SITE SUITABILITY CHARTS */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-700">
                Site Suitability Analytics
              </h2>
              <p className="text-xs text-slate-500">
                Compare the current micro-climate to Spirulina&apos;s ideal
                envelope and modelled protein yield trajectory.
              </p>
            </div>
          </div>

          <div className="grid gap-6 xl:grid-cols-3">
            {/* Radar Chart */}
            <Card className="border-emerald-100/70 bg-white/90 shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-sm font-semibold text-slate-900">
                  <span>Environmental Fit Radar</span>
                  <Badge
                    variant="outline"
                    className="border-emerald-200 bg-emerald-50/60 text-[11px] text-emerald-700"
                  >
                    Temperature · pH · Radiation · Salinity
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="h-64 pt-0">
                {isLoading ? (
                  <Skeleton className="h-full w-full rounded-xl bg-slate-200/80" />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <RadarChart data={radarData}>
                      <PolarGrid radialLines={false} stroke="#e2e8f0" />
                      <PolarAngleAxis
                        dataKey="metric"
                        tick={{ fontSize: 10, fill: "#475569" }}
                      />
                      <PolarRadiusAxis
                        angle={30}
                        tick={false}
                        axisLine={false}
                      />
                      <Radar
                        name="Site"
                        dataKey="site"
                        stroke="#10b981"
                        fill="#10b981"
                        fillOpacity={0.35}
                      />
                      <Radar
                        name="Ideal"
                        dataKey="ideal"
                        stroke="#0f172a"
                        fill="#0f172a"
                        fillOpacity={0.12}
                      />
                      <Tooltip
                        contentStyle={{
                          borderRadius: 12,
                          borderColor: "#d1fae5",
                          fontSize: 11,
                        }}
                      />
                    </RadarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            {/* Protein Gauge / Bar */}
            <Card className="border-emerald-100/70 bg-white/90 shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-sm font-semibold text-slate-900">
                  <span>Predicted Protein Content</span>
                  <Badge
                    variant="outline"
                    className="border-emerald-200 bg-gradient-to-r from-red-100 via-yellow-100 to-emerald-100 text-[11px] text-emerald-800"
                  >
                    Low → High gradient
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs text-slate-500">
                  ML classifier output mapped onto a 3-band protein index.
                </CardDescription>
              </CardHeader>
              <CardContent className="h-64 pt-0">
                {isLoading ? (
                  <Skeleton className="h-full w-full rounded-xl bg-slate-200/80" />
                ) : (
                  <div className="flex h-full flex-col gap-4">
                    {proteinPrediction && (
                      <div
                        className={cn(
                          "rounded-xl border px-3 py-2.5 text-xs",
                          getProteinVisual(proteinPrediction.level)?.toneClass ??
                            "from-slate-50 to-slate-100 border-slate-200",
                          "bg-gradient-to-r",
                        )}
                      >
                        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-700">
                          Recommended product line
                        </p>
                        <p className="mt-1 text-sm font-semibold text-slate-900">
                          {getProteinVisual(proteinPrediction.level)?.label}
                        </p>
                        <p className="mt-0.5 text-[11px] leading-snug text-slate-600">
                          {getProteinVisual(proteinPrediction.level)?.description}
                        </p>
                      </div>
                    )}
                    <div className="flex items-center justify-between text-xs text-slate-600">
                      <span className="flex items-center gap-1">
                        <Activity className="h-3.5 w-3.5 text-emerald-600" />
                        Protein band:
                        <span className="font-semibold text-slate-900">
                          {proteinPrediction?.level ?? "Awaiting run"}
                        </span>
                      </span>
                      {proteinPrediction && (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-800">
                          Band strength:{" "}
                          {proteinPrediction.score.toFixed(1)}
                          %
                        </span>
                      )}
                    </div>
                    <div className="flex-1">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={proteinData}
                          layout="vertical"
                          margin={{ top: 8, right: 20, left: 20, bottom: 8 }}
                        >
                          <defs>
                            <linearGradient
                              id="proteinGradient"
                              x1="0"
                              y1="0"
                              x2="1"
                              y2="0"
                            >
                              <stop offset="0%" stopColor="#ef4444" />
                              <stop offset="50%" stopColor="#facc15" />
                              <stop offset="100%" stopColor="#10b981" />
                            </linearGradient>
                          </defs>
                          <CartesianGrid
                            strokeDasharray="3 3"
                            horizontal={false}
                            vertical
                            stroke="#e2e8f0"
                          />
                          <XAxis
                            type="number"
                            domain={[0, 3]}
                            ticks={[1, 2, 3]}
                            tickFormatter={(value) =>
                              value === 1
                                ? "Low"
                                : value === 2
                                  ? "Medium"
                                  : value === 3
                                    ? "High"
                                    : ""
                            }
                            tick={{ fontSize: 10, fill: "#64748b" }}
                            axisLine={false}
                          />
                          <YAxis
                            type="category"
                            dataKey="name"
                            tick={false}
                            axisLine={false}
                          />
                          <Tooltip
                            contentStyle={{
                              borderRadius: 12,
                              borderColor: "#bbf7d0",
                              fontSize: 11,
                            }}
                            formatter={(value: number) => {
                              const label =
                                value === 1
                                  ? "Low"
                                  : value === 2
                                    ? "Medium"
                                    : "High";
                          const useCase = getProteinUseCase(
                            label as ProteinLevel,
                          );
                          return [
                            useCase
                              ? `${label} protein band – ${useCase}`
                              : `${label} protein band`,
                            "Predicted use case",
                          ];
                            }}
                          />
                          <Bar
                            dataKey="value"
                            fill="url(#proteinGradient)"
                            radius={[12, 12, 12, 12]}
                            maxBarSize={26}
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-slate-500">
                      <span>
                        Banding based on predicted protein content and biomass
                        model output.
                      </span>
                      <span className="flex gap-2">
                        <span className="flex items-center gap-1">
                          <span className="h-1.5 w-4 rounded-full bg-red-500" />
                          Low
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="h-1.5 w-4 rounded-full bg-yellow-400" />
                          Medium
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="h-1.5 w-4 rounded-full bg-emerald-500" />
                          High
                        </span>
                      </span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Growth Time Series */}
            <Card className="border-emerald-100/70 bg-white/90 shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-sm font-semibold text-slate-900">
                  <span>Predicted Growth Doubling Time</span>
                  <Badge
                    variant="outline"
                    className="border-emerald-200 bg-slate-50 text-[11px] text-slate-700"
                  >
                    14-day simulation window
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs text-slate-500">
                  Lower values indicate faster Spirulina biomass accumulation
                  (under recommended operating conditions).
                </CardDescription>
              </CardHeader>
              <CardContent className="h-64 pt-0">
                {isLoading ? (
                  <Skeleton className="h-full w-full rounded-xl bg-slate-200/80" />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={growthSeries}
                      margin={{ top: 12, right: 12, left: 0, bottom: 8 }}
                    >
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="#e2e8f0"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="day"
                        tickLine={false}
                        axisLine={false}
                        tick={{ fontSize: 10, fill: "#64748b" }}
                        tickFormatter={(value) => `D${value}`}
                      />
                      <YAxis
                        tickLine={false}
                        axisLine={false}
                        tick={{ fontSize: 10, fill: "#64748b" }}
                        tickFormatter={(value) => `${value.toFixed(1)} d`}
                      />
                      <Tooltip
                        contentStyle={{
                          borderRadius: 12,
                          borderColor: "#bae6fd",
                          fontSize: 11,
                        }}
                        formatter={(value: number) => [
                          `${value.toFixed(2)} days`,
                          "Doubling time",
                        ]}
                        labelFormatter={(value: number) => `Day ${value}`}
                      />
                      <Line
                        type="monotone"
                        dataKey="doublingTime"
                        stroke="#0ea5e9"
                        strokeWidth={2.2}
                        dot={false}
                        activeDot={{
                          r: 4,
                          fill: "#0ea5e9",
                          strokeWidth: 0,
                        }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>
        </section>

        {/* ANALYSIS REPORT */}
        <section>
          <Card className="border-emerald-100/70 bg-white/90 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-base font-semibold text-slate-900">
                <span>Spirulina Site Analysis Report</span>
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className="border-emerald-200 bg-emerald-50/60 text-[11px] text-emerald-800"
                  >
                    Cleaned · Markdown-normalized
                  </Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!cleanedReport && !phdReport}
                    onClick={handleDownloadReport}
                    className="h-8 px-3 text-[11px]"
                  >
                    Download report
                  </Button>
                </div>
              </CardTitle>
              <CardDescription className="text-xs text-slate-500">
                Expert narrative summarizing suitability, risks, and operational
                recommendations for the selected Spirulina cultivation site.
              </CardDescription>
            </CardHeader>
            <CardContent className="max-h-[420px] space-y-3 overflow-y-auto pr-1 text-sm leading-relaxed text-slate-700">
              {isLoading && (
                <div className="space-y-3">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-11/12" />
                  <Skeleton className="h-4 w-10/12" />
                  <Skeleton className="h-4 w-9/12" />
                </div>
              )}

              {!isLoading && cleanedReport && (
                <div className="space-y-2">
                  {keyPoints.length > 0 ? (
                    <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed">
                      {keyPoints.map((pt, index) => (
                        <li key={index}>{pt}</li>
                      ))}
                    </ul>
                  ) : (
                    cleanedReport
                      .split(/\n{2,}/)
                      .map((paragraph, index) => (
                        <p key={index} className="text-sm leading-relaxed">
                          {paragraph.trim().replace(/^[\*\-\d\.\)\s]+/, "")}
                        </p>
                      ))
                  )}
                </div>
              )}

              {!isLoading && !cleanedReport && !error && (
                <p className="text-sm text-slate-500">
                  Run an analysis for a location to view the full narrative,
                  including climate justification, system design notes, and
                  operational guidance.
                </p>
              )}

              {error && !isLoading && (
                <div className="rounded-md border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {error}
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      </main>
    </div>
  );
};

export default Dashboard;
