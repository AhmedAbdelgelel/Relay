import type { Metadata } from "next";
import { RequestInspector } from "@/components/pages/requests/RequestInspector";

export const metadata: Metadata = {
  title: "Requests · Relay",
  description:
    "Inspect the last live request end to end: incoming body, canonical JSON, provider evidence and final response.",
};

export default function RequestsPage() {
  return <RequestInspector />;
}
