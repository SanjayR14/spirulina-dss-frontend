import api from "@/lib/axios";

export interface AnalysisPayload {
  location: string;
}

export const analyzeSite = (data: AnalysisPayload) =>
  api.post("/analysis/analyze-site", data);
