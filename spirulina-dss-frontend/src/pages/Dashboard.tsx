import { useState } from "react";
import { analyzeSite } from "@/api/analysis";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

interface AnalysisResult {
  status: string;
  location?: string;
  message?: string;
  analysis?: {
    summary: string;
    formatted_text: string[];
  };
}

const Dashboard = () => {
  const [location, setLocation] = useState("");
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);

  const handleAnalyze = async () => {
    try {
      setLoading(true);
      const res = await analyzeSite({
        location,
      });
      setAnalysis(res.data.analysis);
    } catch (error) {
      alert("Failed to analyze site");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 p-6">
      <h1 className="text-2xl font-bold mb-6">Spirulina DSS Dashboard</h1>

      {/* INPUT CARD */}
      <Card className="max-w-xl mb-6">
        <CardHeader>
          <CardTitle>Analyze Cultivation Site</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Location</Label>
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Mumbai, India"
            />
          </div>

          <Button
            onClick={handleAnalyze}
            disabled={loading || !location}
            className="w-full"
          >
            {loading ? "Analyzing..." : "Analyze Site"}
          </Button>
        </CardContent>
      </Card>

      {/* RESULT CARD */}
      {analysis && analysis.status === "success" && analysis.analysis && (
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>Analysis Result for {analysis.location}</CardTitle>
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="whitespace-pre-line">
              {analysis.analysis.summary}
            </div>
          </CardContent>
        </Card>
      )}

      {analysis && analysis.status === "error" && (
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p>{analysis.message}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default Dashboard;
